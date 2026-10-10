/**
 * OMP Desk — asking another window to act (ADR-0056, ADR-0057).
 *
 * VS Code gives an extension no way to message another window, so a window that wants
 * another window to act writes a **request** into shared global storage, addressed to that
 * window's claim holder id:
 *
 *   `window-requests/<holder id>.<request id>.request`   → `{ version, id, kind, to, from, createdAt, ... }`
 *   `window-requests/<holder id>.<request id>.response`  → `{ version, id, ok, focused }`
 *
 * There are two kinds. A **select** request names a session another window holds
 * (`tabId`, `incarnation`, `binding`): the holder acts only to select the tab, a
 * selection-only operation that shows an editor this window already has for that session,
 * while this window still holds the session under the run incarnation the request names, and
 * never launches, stops, acquires a claim, changes a mode or forwards a request. A **launch**
 * request names a folder the receiver has open (or a session of such a folder) and what to
 * start there; the receiver starts it through its own ordinary launch path and admission, and
 * only for a folder or session it still has itself.
 *
 * The receiver writes the response and deletes the request; the requester reads the response
 * (and deletes it). A request is dropped once it is older than its kind's lifetime
 * ({@link requestTtlMs}), and `serve` can ask whether the request is still wanted at the
 * moment it acts, so a request its requester already withdrew is never acted on late. Any
 * local process can write these files, so a forged request can at most make a window show a
 * tab it already has open (and so mark it looked at) or start an idle session in a folder it
 * has open, which the same user could start directly; a forged response proves nothing about
 * focus or ownership, and one that is not correlated to the request (version, id, shape) is
 * not an answer at all.
 *
 * Bringing the owner's window to the front is not done here: it is `vscode.openFolder` on
 * the owner's saved workspace or single-folder URI, planned by {@link planWindowSwitch}.
 */

import { createHash, randomUUID } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { errorCode, readBoundedFile, replaceFileAtomic } from "./atomic-file.ts";
import { watchDirectory } from "./directory-watch.ts";
import type { OpenWindow } from "./window-registry.ts";

export const WINDOW_REQUEST_DIRECTORY = "window-requests";
/**
 * A select request older than this is ignored and deleted. The requester gives up after
 * {@link REQUEST_ANSWER_TIMEOUT_MS}, counted from posting, and withdraws its own request on a
 * timer armed when it posts, so this only bounds what a crashed requester leaves behind: the
 * requester's wait plus a second for the clocks and the file system.
 */
export const REQUEST_TTL_MS = 6_000;
/** The same for a launch request, whose receiver may be a window that is busy loading its workspace. */
export const LAUNCH_REQUEST_TTL_MS = 11_000;
/** Request and response files this old are garbage whatever their addressee. */
export const REQUEST_SWEEP_MS = 120_000;
/** How long a requester waits for the owner's answer to a select request, from the moment it posts. */
export const REQUEST_ANSWER_TIMEOUT_MS = 5_000;
/**
 * How long a requester waits for a window to accept a launch, from the moment it posts. The
 * receiver answers on admission (it has validated the request and begun the launch), not when
 * OMP is ready, so a normal answer takes a few hundred milliseconds; a window that is still
 * loading may take seconds.
 */
export const LAUNCH_ANSWER_TIMEOUT_MS = 10_000;

const REQUEST_SUFFIX = ".request";
const RESPONSE_SUFFIX = ".response";
const VERSION = 1;
const ID_RE = /^[A-Za-z0-9-]{1,100}$/;
const INCARNATION_RE = /^[A-Za-z0-9._:-]{1,300}$/;
const FILE_RE = /^([A-Za-z0-9-]{1,100})\.([A-Za-z0-9-]{1,100})\.(request|response)$/;
/** A request stamped further ahead than this is not trusted. */
const FUTURE_SKEW_MS = 5_000;
const MAX_REQUEST_BYTES = 8 * 1024;
const MAX_RESPONSE_BYTES = 1024;
const MAX_TAB_ID = 200;
const MAX_WORKSPACE_PATH = 4096;
const FOLDER_ID_RE = /^folder:[A-Za-z0-9._-]{1,100}$/;
const BINDING_RE = /^[A-Za-z0-9._-]{1,200}$/;
const isBinding = (value: unknown): value is string => typeof value === "string" && BINDING_RE.test(value);
/** Requests being served at once by one window, whatever the number of scans or watch events. */
const MAX_ACTIVE_REQUESTS = 4;
/** Requests waiting for a turn; more are left on disk for the next scan (they expire within the TTL). */
const MAX_QUEUED_REQUESTS = 64;

/** Fields every request has. */
interface RequestBase {
	readonly version: 1;
	readonly id: string;
	/** The claim holder id of the window that must act; no other window does. */
	readonly to: string;
	readonly from: string;
	readonly createdAt: string;
}

/** One request to select a session's tab in the window that holds it. */
export interface SwitchRequest extends RequestBase {
	readonly kind: "select";
	readonly tabId: string;
	/** The run incarnation of the session the requester saw held; the owner serves only the run it still holds. */
	readonly incarnation: string;
	/** `<editor slot>.<generation>` of the owner's editor binding the requester saw published for that run; `null` when it saw none. The owner refuses a request for another binding. */
	readonly binding: string | null;
}

/** What a launch request asks the receiving window to start; every kind is the receiver's own ordinary launch. */
export type LaunchAction =
	/** A new session in the folder (its Sessions folder id), as New Session does. */
	| { readonly kind: "new-session"; readonly folderId: string }
	/** Resume a session from the folder's history, scan and picker included, as Resume Session does. */
	| { readonly kind: "resume-folder"; readonly folderId: string }
	/** Open a session the shared catalog lists: a click or Open on a stopped or draft row, optionally in an explicit view. */
	| { readonly kind: "open-session"; readonly tabId: string; readonly verb: "opened" | "resumed"; readonly mode: "chat" | "terminal" | null };

/**
 * The folder the receiving window must have open to start a launch. `folder`: the window shows
 * it as a folder of Sessions (it has it open, or a folder it stands for as an agent root);
 * `root`: it is exactly one of the window's own workspace folders, which a Unity project needs
 * (the Unity extensions work from the workspace root), whatever agent root the window shows.
 */
export interface LaunchWorkspace {
	readonly path: string;
	readonly match: "folder" | "root";
}

/** One request to start a launch in a window that has `workspace` open. */
export interface LaunchRequest extends RequestBase {
	readonly kind: "launch";
	readonly workspace: LaunchWorkspace;
	readonly launch: LaunchAction;
}

/** A request as a window receives it. */
export type WindowRequest = SwitchRequest | LaunchRequest;

/** How long a request stays actionable. */
export function requestTtlMs(request: Pick<WindowRequest, "kind">): number {
	return request.kind === "launch" ? LAUNCH_REQUEST_TTL_MS : REQUEST_TTL_MS;
}

/** What the owner did with a request: whether it selected the tab, and whether its window is in front. */
export interface ServeOutcome {
	readonly ok: boolean;
	/** This window has the focus after the selection (always `false` for a refusal). */
	readonly focused: boolean;
	/**
	 * Why a refusal is definite: the receiver decided before it began anything, so nothing was
	 * started there. `stale-build`: the window runs an older OMP Desk than the one installed and
	 * cannot build a view. Only a refusal can carry it.
	 */
	readonly refusal?: RefusalReason;
}

/** The reasons a refusal names; a refusal without one is the ordinary "could not do it". */
export type RefusalReason = "stale-build";

/** What `serve` may ask while it works. */
export interface ServeContext {
	/** `false` once the request was withdrawn or expired: the requester no longer wants the tab selected. */
	stillWanted(): Promise<boolean>;
}

/** How the requester's wait ended. */
export type RequestAnswer = "served" | "unfocused" | "refused" | "stale-build" | "timeout";

function directoryOf(storageDir: string): string {
	return path.join(path.resolve(storageDir), WINDOW_REQUEST_DIRECTORY);
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function parseLaunch(value: unknown): LaunchAction | null {
	if (typeof value !== "object" || value === null) return null;
	const { kind, folderId, tabId, verb, mode } = value as Record<string, unknown>;
	if (kind === "new-session" || kind === "resume-folder") return typeof folderId === "string" && FOLDER_ID_RE.test(folderId) ? { kind, folderId } : null;
	if (kind !== "open-session") return null;
	if (typeof tabId !== "string" || tabId.length === 0 || tabId.length > MAX_TAB_ID) return null;
	if (verb !== "opened" && verb !== "resumed") return null;
	if (mode !== null && mode !== "chat" && mode !== "terminal") return null;
	return { kind, tabId, verb, mode };
}

function parseWorkspace(value: unknown): LaunchWorkspace | null {
	if (typeof value !== "object" || value === null) return null;
	const { path: workspacePath, match } = value as Record<string, unknown>;
	if (typeof workspacePath !== "string" || workspacePath.length === 0 || workspacePath.length > MAX_WORKSPACE_PATH) return null;
	if (match !== "folder" && match !== "root") return null;
	return { path: workspacePath, match };
}

function parseRequest(text: string, fileTo: string, fileId: string): WindowRequest | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	// Every field is checked one by one below; nothing of this shape is trusted before that.
	const { version, kind, id, to, from, tabId, incarnation, binding, createdAt, launch, workspace } = parsed as Record<string, unknown>;
	if (version !== VERSION || id !== fileId || to !== fileTo) return null;
	if (typeof from !== "string" || !ID_RE.test(from)) return null;
	if (typeof createdAt !== "string" || createdAt.length > 40 || !Number.isFinite(Date.parse(createdAt))) return null;
	if (kind === "launch") {
		const action = parseLaunch(launch);
		const target = parseWorkspace(workspace);
		return action === null || target === null ? null : { kind, version: VERSION, id, to, from, createdAt, workspace: target, launch: action };
	}
	if (kind !== "select") return null;
	if (typeof tabId !== "string" || tabId.length === 0 || tabId.length > MAX_TAB_ID) return null;
	if (typeof incarnation !== "string" || !INCARNATION_RE.test(incarnation)) return null;
	if (binding !== null && !isBinding(binding)) return null;
	return { kind, version: VERSION, id, to, from, tabId, incarnation, binding, createdAt };
}

/** The outcome in `text`, or `null` unless it is a well-formed answer to request `id`. */
function parseResponse(text: string, id: string): ServeOutcome | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	const record = parsed as Record<string, unknown>;
	if (record.version !== VERSION || record.id !== id || typeof record.ok !== "boolean" || typeof record.focused !== "boolean") return null;
	// An answer of a build that predates a refusal reason has none; one with a reason this build does not know is no answer.
	if (record.refusal !== undefined && (record.ok || record.refusal !== "stale-build")) return null;
	return { ok: record.ok, focused: record.focused, ...(record.refusal === undefined ? {} : { refusal: record.refusal }) };
}

/** The text of the response file for `outcome`: what the requester reads back with {@link parseResponse}. */
function responseText(id: string, outcome: ServeOutcome): string {
	const refusal = !outcome.ok && outcome.refusal !== undefined ? { refusal: outcome.refusal } : {};
	return `${JSON.stringify({ version: VERSION, id, ok: outcome.ok, focused: outcome.ok && outcome.focused, ...refusal })}\n`;
}

/**
 * Ask `to` to select `tabId`. Resolves with the request id once the file is in place.
 * Also sweeps request and response files that nobody answered for {@link REQUEST_SWEEP_MS}.
 */
export async function postSwitchRequest(
	storageDir: string,
	request: { readonly to: string; readonly from: string; readonly tabId: string; readonly incarnation: string; readonly binding?: string | null },
	now: () => number = Date.now,
): Promise<string> {
	if (!ID_RE.test(request.to) || !ID_RE.test(request.from)) throw new TypeError("a window request needs holder ids of letters, digits and dashes");
	if (!INCARNATION_RE.test(request.incarnation)) throw new TypeError("a window request needs the session's run incarnation");
	if (request.binding != null && !isBinding(request.binding)) throw new TypeError("a window request names a binding as letters, digits, dots and dashes");
	if (request.tabId.length === 0 || request.tabId.length > MAX_TAB_ID) throw new TypeError("a window request needs a tab id of at most 200 characters");
	const id = randomUUID();
	const record: SwitchRequest = {
		kind: "select",
		version: VERSION,
		id,
		to: request.to,
		from: request.from,
		tabId: request.tabId,
		incarnation: request.incarnation,
		binding: request.binding ?? null,
		createdAt: new Date(now()).toISOString(),
	};
	await writeRequest(storageDir, record, now);
	return id;
}

/**
 * Ask `to` to start `launch`, a folder it has open. Resolves with the request id once the file
 * is in place.
 */
export async function postLaunchRequest(
	storageDir: string,
	request: { readonly to: string; readonly from: string; readonly workspace: LaunchWorkspace; readonly launch: LaunchAction },
	now: () => number = Date.now,
): Promise<string> {
	if (!ID_RE.test(request.to) || !ID_RE.test(request.from)) throw new TypeError("a window request needs holder ids of letters, digits and dashes");
	if (parseLaunch(request.launch) === null) throw new TypeError("a launch request needs a folder id or a tab id and a known verb");
	if (parseWorkspace(request.workspace) === null) throw new TypeError("a launch request needs the folder the receiving window must have open");
	const id = randomUUID();
	const record: LaunchRequest = {
		kind: "launch",
		version: VERSION,
		id,
		to: request.to,
		from: request.from,
		createdAt: new Date(now()).toISOString(),
		workspace: request.workspace,
		launch: request.launch,
	};
	await writeRequest(storageDir, record, now);
	return id;
}

async function writeRequest(storageDir: string, record: WindowRequest, now: () => number): Promise<void> {
	const directory = directoryOf(storageDir);
	await sweepRequests(directory, now());
	await replaceFileAtomic(path.join(directory, `${record.to}.${record.id}${REQUEST_SUFFIX}`), `${JSON.stringify(record)}\n`);
}

async function sweepRequests(directory: string, now: number): Promise<void> {
	let names: string[];
	try {
		names = await fsp.readdir(directory);
	} catch {
		return;
	}
	for (const name of names) {
		const file = path.join(directory, name);
		try {
			const stat = await fsp.stat(file);
			if (now - stat.mtimeMs > REQUEST_SWEEP_MS) await fsp.rm(file, { force: true });
		} catch {
			// Another window swept or served it first.
		}
	}
}

/**
 * Wait for the owner's answer to request `id`, reading its response file through a bounded
 * handle and deleting it. A response that is not a well-formed answer to this very request
 * is deleted and ignored: the wait goes on. On a timeout the unanswered request is deleted
 * too, so a window that wakes later does not select a tab nobody is waiting for any more.
 */
export async function awaitRequestAnswer(
	storageDir: string,
	to: string,
	id: string,
	options: { readonly timeoutMs?: number; readonly pollMs?: number } = {},
): Promise<RequestAnswer> {
	const directory = directoryOf(storageDir);
	const response = path.join(directory, `${to}.${id}${RESPONSE_SUFFIX}`);
	const timeoutMs = options.timeoutMs ?? REQUEST_ANSWER_TIMEOUT_MS;
	const pollMs = options.pollMs ?? 100;
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const read = await readBoundedFile(response, MAX_RESPONSE_BYTES);
		if (read.kind !== "missing") {
			await fsp.rm(response, { force: true });
			const outcome = read.kind === "text" ? parseResponse(read.text, id) : null;
			if (outcome !== null) return !outcome.ok ? outcome.refusal ?? "refused" : outcome.focused ? "served" : "unfocused";
		}
		if (Date.now() >= deadline) {
			await fsp.rm(path.join(directory, `${to}.${id}${REQUEST_SUFFIX}`), { force: true });
			return "timeout";
		}
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, pollMs).unref?.();
		await promise;
	}
}

/**
 * Delete a request nobody is waiting for any more, so its receiver does not act on it late. The
 * requester arms this at the moment it posts, independently of any focus change it also asks
 * VS Code for, so the wait cannot outlast {@link REQUEST_ANSWER_TIMEOUT_MS} however long that
 * takes.
 */
export async function withdrawRequest(storageDir: string, to: string, id: string): Promise<void> {
	await fsp.rm(path.join(directoryOf(storageDir), `${to}.${id}${REQUEST_SUFFIX}`), { force: true });
}

export interface RequestWatchOptions {
	readonly debounceMs?: number;
	readonly now?: () => number;
	readonly onError?: (detail: string) => void;
}

/** A running request server. */
export interface RequestWatch {
	/** Look at the directory again now: the recovery for a watch event the platform dropped. */
	rescan(): void;
	/** Stop; idempotent. */
	dispose(): void;
}

/**
 * Serve the requests addressed to `holderId`: the ones already waiting when this starts, every
 * one that arrives, and every one a {@link RequestWatch.rescan} finds. `serve` returns what the
 * window did; the answer is written as the response before the request file is deleted. A
 * request that is unreadable, oversized, addressed to someone else or older than
 * its lifetime ({@link requestTtlMs}) is never served, and a request is served at most once for as long as
 * it could still be acted on, even when its cleanup fails. At most four requests are served
 * at once and sixty-four wait; the rest stay on disk for a later scan.
 * Never throws; failures go to `options.onError`.
 */
export function startRequestWatch(
	storageDir: string,
	holderId: string,
	serve: (request: WindowRequest, context: ServeContext) => Promise<ServeOutcome>,
	options: RequestWatchOptions = {},
): RequestWatch {
	const directory = directoryOf(storageDir);
	const now = options.now ?? Date.now;
	const report = (detail: string): void => {
		try {
			options.onError?.(detail);
		} catch {
			// An error sink that throws must not take the watcher down.
		}
	};
	let disposed = false;
	const inFlight = new Set<string>();
	/** Completed request names with the time they finished: kept for as long as the request could still be acted on. */
	const completed = new Map<string, number>();
	const remember = (name: string): void => {
		const at = now();
		for (const [done, when] of completed) if (at - when > LAUNCH_REQUEST_TTL_MS + FUTURE_SKEW_MS) completed.delete(done);
		completed.set(name, at);
	};
	const isMine = (name: string): RegExpExecArray | null => {
		const match = FILE_RE.exec(name);
		return match !== null && match[3] === "request" && match[1] === holderId ? match : null;
	};

	const handle = async (name: string): Promise<void> => {
		const match = isMine(name);
		if (match === null) return;
		const file = path.join(directory, name);
		if (completed.has(name)) {
			await fsp.rm(file, { force: true }).catch(() => {});
			return;
		}
		inFlight.add(name);
		try {
			const read = await readBoundedFile(file, MAX_REQUEST_BYTES);
			if (read.kind === "missing") return;
			const request = read.kind === "text" ? parseRequest(read.text, match[1]!, match[2]!) : null;
			const age = request === null ? Infinity : now() - Date.parse(request.createdAt);
			if (request === null || age > requestTtlMs(request) || age < -FUTURE_SKEW_MS) {
				await fsp.rm(file, { force: true });
				return;
			}
			const stillWanted = async (): Promise<boolean> => {
				if (disposed || now() - Date.parse(request.createdAt) > requestTtlMs(request)) return false;
				try {
					return (await fsp.stat(file)).isFile();
				} catch {
					return false;
				}
			};
			let outcome: ServeOutcome = { ok: false, focused: false };
			try {
				outcome = await serve(request, { stillWanted });
			} catch (error) {
				report(`a window request could not be served: ${messageOf(error)}`);
			}
			remember(name);
			if (disposed) return;
			await replaceFileAtomic(
				path.join(directory, `${request.to}.${request.id}${RESPONSE_SUFFIX}`),
				responseText(request.id, outcome),
			);
			await fsp.rm(file, { force: true });
		} catch (error) {
			report(`a window request could not be answered: ${messageOf(error)}`);
		} finally {
			inFlight.delete(name);
		}
	};

	/** One draining queue for every scan and watch event: at most {@link MAX_ACTIVE_REQUESTS} run at once. */
	const queued: string[] = [];
	let active = 0;
	const pump = (): void => {
		while (!disposed && active < MAX_ACTIVE_REQUESTS && queued.length > 0) {
			const name = queued.shift()!;
			active++;
			void handle(name).finally(() => {
				active--;
				pump();
			});
		}
	};
	const enqueue = (name: string): void => {
		if (isMine(name) === null || inFlight.has(name) || queued.includes(name) || queued.length >= MAX_QUEUED_REQUESTS) return;
		queued.push(name);
		pump();
	};

	const scan = async (): Promise<void> => {
		if (disposed) return;
		let names: string[];
		try {
			names = await fsp.readdir(directory);
		} catch (error) {
			if (errorCode(error) !== "ENOENT") report(`the window requests could not be listed: ${messageOf(error)}`);
			return;
		}
		for (const name of names) enqueue(name);
	};

	const stopWatch = watchDirectory(directory, names => {
		if (disposed) return;
		if (names.size === 0) void scan();
		else for (const name of names) enqueue(name);
	}, {
		suffix: REQUEST_SUFFIX,
		description: "the window requests directory",
		onError: report,
		...(options.debounceMs === undefined ? {} : { debounceMs: options.debounceMs }),
	});
	void scan();
	return {
		rescan: () => { void scan(); },
		dispose: () => {
			disposed = true;
			stopWatch();
		},
	};
}

/** The decision a click on a row another window holds leads to. */
export type WindowSwitchPlan =
	/** The claim no longer names another live window; nothing to switch to. */
	| { readonly kind: "stale" }
	/** Post the request, then focus `uri`. */
	| { readonly kind: "switch"; readonly holderId: string; readonly incarnation: string; readonly uri: string }
	/**
	 * Post the request but do not focus: the owner has no URI a reopen could focus (an unsaved
	 * multi-root window), or another window shows the same URI so `openFolder` could not tell
	 * which one holds the session.
	 */
	| { readonly kind: "manual"; readonly holderId: string; readonly incarnation: string; readonly reason: "no-uri" | "ambiguous" };

/**
 * What VS Code's window routing would call the same place: a `file` URI by decoded path, host
 * and case (Windows paths are case-insensitive), without a trailing slash. `null` for anything
 * that is not a local file URI, which is never dispatched to `openFolder`.
 */
export function windowUriIdentity(uri: string): string | null {
	try {
		const parsed = new URL(uri);
		if (parsed.protocol !== "file:") return null;
		const decoded = decodeURIComponent(parsed.pathname).replace(/\\/g, "/").replace(/\/+$/, "");
		return `file://${parsed.host.toLowerCase()}${decoded.toLowerCase()}`;
	} catch {
		return null;
	}
}

/** How to bring a known window to the front. */
export type WindowFocusPlan =
	| { readonly kind: "switch"; readonly uri: string }
	| { readonly kind: "manual"; readonly reason: "no-uri" | "ambiguous" };

/**
 * How to bring the window of `holderId` to the front: `vscode.openFolder` on its saved
 * workspace or single-folder URI, which focuses the window that already has it. The target
 * URI is the holder's registry record's (which is authoritative, `null` included) and falls
 * back to `fallbackUri` (the claim's own) only when the holder has no usable record. A window
 * with no `file` URI, or whose URI another live window shows too, cannot be addressed by
 * `openFolder`, so the plan is manual.
 */
export function planWindowFocus(holderId: string, fallbackUri: string | null | undefined, windows: readonly OpenWindow[]): WindowFocusPlan {
	const record = windows.find(window => window.holderId === holderId);
	const uri = record === undefined ? fallbackUri ?? null : record.windowUri;
	const identity = uri === null ? null : windowUriIdentity(uri);
	if (uri === null || identity === null) return { kind: "manual", reason: "no-uri" };
	if (windows.some(window => window.holderId !== holderId && window.windowUri !== null && windowUriIdentity(window.windowUri) === identity)) {
		return { kind: "manual", reason: "ambiguous" };
	}
	return { kind: "switch", uri };
}

/**
 * Decide how to reach the holder of a claim. `claim` is the fresh claim read and `incarnation`
 * the run incarnation of the session as this window's catalog records it; the holder must be
 * another window whose process may still be alive. The target URI is the holder's registry
 * record's (which is authoritative, `null` included) and falls back to the claim's own URI only
 * when the holder has no usable record.
 */
export function planWindowSwitch(input: {
	readonly claim: { readonly holderId: string | null; readonly windowUri?: string | null } | null;
	readonly incarnation: string | null;
	readonly claimHolderAlive: boolean;
	readonly ownHolderId: string;
	readonly windows: readonly OpenWindow[];
}): WindowSwitchPlan {
	const holderId = input.claim?.holderId ?? null;
	const incarnation = input.incarnation;
	if (holderId === null || incarnation === null || !input.claimHolderAlive || holderId === input.ownHolderId) return { kind: "stale" };
	const focus = planWindowFocus(holderId, input.claim?.windowUri, input.windows);
	return focus.kind === "manual" ? { kind: "manual", holderId, incarnation, reason: focus.reason } : { kind: "switch", holderId, incarnation, uri: focus.uri };
}

/** A live window that has a folder open, as {@link planFolderLaunch} ranks it. */
export interface FolderWindow {
	readonly holderId: string;
	/** This is the window asking. */
	readonly here: boolean;
	readonly startedAt: string;
	readonly focusedAt: string | null;
	/** The window runs an older OMP Desk than the one installed: it is never chosen for a launch. */
	readonly stale?: boolean;
}

/** Where a launch for a folder starts. */
export type FolderLaunchPlan =
	/**
	 * In the asking window: it has the folder open, or no live window does, or every window that
	 * has it runs an older build (`staleHolders` names them; a new window on the folder would only
	 * focus one of them).
	 */
	| { readonly kind: "here"; readonly staleHolders?: readonly string[] }
	/** In the window of `holderId`, the folder's most recently focused window. */
	| { readonly kind: "window"; readonly holderId: string }
	/** In a new window on the folder: no live window has it and the caller asked for one then. */
	| { readonly kind: "new-window" };

/**
 * The most suitable window for a launch in a folder, given every live window that has that
 * folder open (after agent-root substitution, `here` included): the asking window when it has
 * the folder, otherwise the most recently focused of the others (a window that published no
 * focus time ranks last; ties go to the earlier started, then the lower holder id, so the
 * answer does not depend on input order), and the asking window again when no window has it
 * (a folder that is only pinned or kept by a live session), or, when the caller says a new window
 * is wanted then, a new window. A window on an older build ({@link FolderWindow.stale}) is never
 * chosen; when every window that has the folder is one, the launch starts here.
 */
export function planFolderLaunch(allOpening: readonly FolderWindow[], whenNone: "here" | "new-window" = "here"): FolderLaunchPlan {
	if (allOpening.some(window => window.here)) return { kind: "here" };
	if (allOpening.length === 0) return whenNone === "here" ? { kind: "here" } : { kind: "new-window" };
	// A window on an older build is never chosen: it refuses to build the view the launch needs. When it is the only
	// kind of window the folder has, the launch starts here, and a new window would only focus one of them.
	const opening = allOpening.filter(window => window.stale !== true);
	if (opening.length === 0) return { kind: "here", staleHolders: allOpening.map(window => window.holderId) };
	const focusOf = (window: FolderWindow): number => {
		const at = window.focusedAt === null ? Number.NaN : Date.parse(window.focusedAt);
		return Number.isFinite(at) ? at : Number.NEGATIVE_INFINITY;
	};
	const [best] = [...opening].sort((left, right) => {
		const byFocus = focusOf(right) - focusOf(left);
		if (byFocus !== 0 && !Number.isNaN(byFocus)) return byFocus;
		const byStart = Date.parse(left.startedAt) - Date.parse(right.startedAt);
		if (byStart !== 0 && !Number.isNaN(byStart)) return byStart;
		return left.holderId < right.holderId ? -1 : left.holderId > right.holderId ? 1 : 0;
	});
	return { kind: "window", holderId: best!.holderId };
}

// Pending launches: a launch for a folder no window has open yet (ADR-0057).
//
// A Unity project's session must run in a window that has the project folder open. When no
// live window does, the requester opens a new window on it and leaves the launch in a file
// keyed by the folder's identity; the new window, which nobody can address by holder id yet,
// claims it once it runs. The claim is the exclusive creation of a marker file, which only one window can win, so a launch is
// never started twice; the answer goes to `window-requests/pending.<id>.response`, which the
// requester awaits like any other.

export const PENDING_LAUNCH_DIRECTORY = "pending-launches";
/** A pending launch older than this is dropped: a cold window start is far inside it. */
export const PENDING_LAUNCH_TTL_MS = 65_000;
/** How long the requester waits for the new window to start the launch, from posting. */
export const PENDING_ANSWER_TIMEOUT_MS = 60_000;
const PENDING_SUFFIX = ".pending";
const CLAIMED_SUFFIX = ".claimed";
const PENDING_FILE_RE = /^([0-9a-f]{32})\.([A-Za-z0-9-]{1,100})\.(pending|claimed)$/;
const PENDING_RESPONSE_HOLDER = "pending";
const MAX_PENDING_BYTES = 8 * 1024;
/** Pending launches waiting for a turn in one window; more stay on disk for a later scan (they expire within the lifetime). */
const MAX_QUEUED_PENDING = 16;
/** Pending and claimed files older than this are garbage whoever they were for. */
const PENDING_SWEEP_MS = 600_000;

/** The file key of a folder identity: windows and requesters derive it from the same identity string. */
export function pendingKeyOf(identityKey: string): string {
	return createHash("sha256").update(identityKey, "utf8").digest("hex").slice(0, 32);
}

function pendingDirectoryOf(storageDir: string): string {
	return path.join(path.resolve(storageDir), PENDING_LAUNCH_DIRECTORY);
}

/**
 * Leave a launch for the window that will have `key`'s folder open. Resolves with the request
 * id the requester awaits ({@link awaitPendingLaunchAnswer}) and may withdraw
 * ({@link withdrawPendingLaunch}).
 */
export async function postPendingLaunch(
	storageDir: string,
	request: { readonly from: string; readonly key: string; readonly workspace: LaunchWorkspace; readonly launch: LaunchAction },
	now: () => number = Date.now,
): Promise<string> {
	if (!ID_RE.test(request.from)) throw new TypeError("a pending launch needs a holder id of letters, digits and dashes");
	if (!/^[0-9a-f]{32}$/.test(request.key)) throw new TypeError("a pending launch needs a folder key");
	if (parseLaunch(request.launch) === null || parseWorkspace(request.workspace) === null) throw new TypeError("a pending launch needs a valid launch and workspace");
	const id = randomUUID();
	const record = { version: VERSION, kind: "launch", id, to: PENDING_RESPONSE_HOLDER, from: request.from, createdAt: new Date(now()).toISOString(), workspace: request.workspace, launch: request.launch };
	const directory = pendingDirectoryOf(storageDir);
	await sweepPending(directory, now());
	await replaceFileAtomic(path.join(directory, `${request.key}.${id}${PENDING_SUFFIX}`), `${JSON.stringify(record)}\n`);
	return id;
}

async function sweepPending(directory: string, now: number): Promise<void> {
	let names: string[];
	try {
		names = await fsp.readdir(directory);
	} catch {
		return;
	}
	for (const name of names) {
		const file = path.join(directory, name);
		try {
			if (now - (await fsp.stat(file)).mtimeMs > PENDING_SWEEP_MS) await fsp.rm(file, { force: true });
		} catch {
			// Another window swept or claimed it first.
		}
	}
}

/** Take back a launch no window claimed; one a window already claimed stays that window's, and nothing is undone. */
export async function withdrawPendingLaunch(storageDir: string, key: string, id: string): Promise<void> {
	await fsp.rm(path.join(pendingDirectoryOf(storageDir), `${key}.${id}${PENDING_SUFFIX}`), { force: true });
}

/** The answer of the window that claimed pending launch `id`, as {@link awaitRequestAnswer} reports any answer. */
export async function awaitPendingLaunchAnswer(
	storageDir: string,
	id: string,
	options: { readonly timeoutMs?: number; readonly pollMs?: number } = {},
): Promise<RequestAnswer> {
	return await awaitRequestAnswer(storageDir, PENDING_RESPONSE_HOLDER, id, { timeoutMs: options.timeoutMs ?? PENDING_ANSWER_TIMEOUT_MS, ...(options.pollMs === undefined ? {} : { pollMs: options.pollMs }) });
}

export interface PendingLaunchWatchOptions {
	readonly debounceMs?: number;
	readonly now?: () => number;
	readonly onError?: (detail: string) => void;
	/** Deletes a pending file; replaceable so a test can make the deletion fail. */
	readonly removeFile?: (file: string) => Promise<void>;
}

/**
 * Claim and serve the pending launches for the folders this window has open. `keys()` is
 * read at every scan (the keys of this window's own folders, which a folder change alters).
 * A launch is claimed by creating its marker file exclusively, which exactly one window can do, then served as a
 * request addressed to this window (`serve` sees an ordinary {@link LaunchRequest}); the
 * response is written for the requester, and the pending file and the marker are deleted, once
 * the launch is admitted or refused (the marker stays when the pending file could not be deleted, so
 * a launch already served is never claimed again). Until then the pending file stays and the requester can
 * withdraw it: `stillWanted` is false once it is gone, so a window that claimed it a moment before
 * the requester gave up does not start it late. One that is older than
 * {@link PENDING_LAUNCH_TTL_MS}, unreadable or malformed is dropped without being served.
 * Never throws; failures go to `options.onError`.
 */
export function startPendingLaunchWatch(
	storageDir: string,
	holderId: string,
	keys: () => readonly string[],
	serve: (request: LaunchRequest, context: ServeContext) => Promise<ServeOutcome>,
	options: PendingLaunchWatchOptions = {},
): RequestWatch {
	const directory = pendingDirectoryOf(storageDir);
	const responses = directoryOf(storageDir);
	const now = options.now ?? Date.now;
	const report = (detail: string): void => {
		try {
			options.onError?.(detail);
		} catch {
			// An error sink that throws must not take the watcher down.
		}
	};
	const removeFile = options.removeFile ?? (async (file: string): Promise<void> => { await fsp.rm(file, { force: true }); });
	let disposed = false;

	const handle = async (name: string): Promise<void> => {
		const match = PENDING_FILE_RE.exec(name);
		if (match === null || match[3] !== "pending" || !keys().includes(match[1]!)) return;
		// The claim is the exclusive creation of a marker file, which exactly one window can do (a
		// rename could not decide it: on Windows two windows can both rename one open file). The
		// marker and the pending file go away together, the pending file first, when the launch
		// has been admitted or refused: until then the requester can still withdraw it.
		const claimed = path.join(directory, `${match[1]}.${match[2]}${CLAIMED_SUFFIX}`);
		try {
			await (await fsp.open(claimed, "wx")).close();
		} catch {
			return; // Another window claimed it first.
		}
		const pendingFile = path.join(directory, name);
		try {
			const read = await readBoundedFile(pendingFile, MAX_PENDING_BYTES);
			const parsed = read.kind === "text" ? parseRequest(read.text, PENDING_RESPONSE_HOLDER, match[2]!) : null;
			const age = parsed === null ? Infinity : now() - Date.parse(parsed.createdAt);
			if (parsed === null || parsed.kind !== "launch" || age > PENDING_LAUNCH_TTL_MS || age < -FUTURE_SKEW_MS) return;
			const request: LaunchRequest = { ...parsed, to: holderId };
			/** Still wanted while the file is there: a requester that gave up deleted it. */
			const stillWanted = async (): Promise<boolean> => {
				if (disposed || now() - Date.parse(request.createdAt) > PENDING_LAUNCH_TTL_MS) return false;
				try {
					return (await fsp.stat(pendingFile)).isFile();
				} catch {
					return false;
				}
			};
			let outcome: ServeOutcome = { ok: false, focused: false };
			try {
				outcome = await serve(request, { stillWanted });
			} catch (error) {
				report(`a pending launch could not be served: ${messageOf(error)}`);
			}
			await replaceFileAtomic(
				path.join(responses, `${PENDING_RESPONSE_HOLDER}.${request.id}${RESPONSE_SUFFIX}`),
				responseText(request.id, outcome),
			);
		} catch (error) {
			report(`a pending launch could not be answered: ${messageOf(error)}`);
		} finally {
			// The marker is what keeps a served launch from being claimed again, so it goes only when
			// the pending file is positively gone; otherwise it stays until the sweep.
			let gone = true;
			try {
				await removeFile(pendingFile);
			} catch (error) {
				gone = false;
				report(`a served pending launch could not be deleted: ${messageOf(error)}`);
			}
			if (gone) await fsp.rm(claimed, { force: true }).catch(() => {});
		}
	};

	/** One draining queue for every scan and watch event, deduplicated by name: a held launch cannot make the work pile up. */
	const queued: string[] = [];
	const known = new Set<string>();
	let draining = false;
	const drain = async (): Promise<void> => {
		if (draining) return;
		draining = true;
		try {
			while (!disposed && queued.length > 0) {
				const name = queued.shift()!;
				try {
					await handle(name);
				} finally {
					known.delete(name);
				}
			}
		} finally {
			draining = false;
		}
	};
	const enqueue = (name: string): void => {
		const match = PENDING_FILE_RE.exec(name);
		if (match === null || match[3] !== "pending" || !keys().includes(match[1]!) || known.has(name) || queued.length >= MAX_QUEUED_PENDING) return;
		known.add(name);
		queued.push(name);
		void drain();
	};

	const scan = async (): Promise<void> => {
		if (disposed) return;
		await sweepPending(directory, now());
		if (disposed || keys().length === 0) return;
		let names: string[];
		try {
			names = await fsp.readdir(directory);
		} catch (error) {
			if (errorCode(error) !== "ENOENT") report(`the pending launches could not be listed: ${messageOf(error)}`);
			return;
		}
		for (const name of names) enqueue(name);
	};

	const stopWatch = watchDirectory(directory, () => { void scan(); }, {
		suffix: PENDING_SUFFIX,
		description: "the pending launches directory",
		onError: report,
		...(options.debounceMs === undefined ? {} : { debounceMs: options.debounceMs }),
	});
	void scan();
	return {
		rescan: () => { void scan(); },
		dispose: () => {
			disposed = true;
			stopWatch();
		},
	};
}
