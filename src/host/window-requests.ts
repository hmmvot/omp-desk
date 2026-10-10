/**
 * OMP Desk — asking another window to select a session's tab (ADR-0056).
 *
 * VS Code gives an extension no way to message another window, so a window that wants a
 * session another window holds writes a **request** into shared global storage, addressed
 * to the claim holder id of the owner:
 *
 *   `window-requests/<holder id>.<request id>.request`   → `{ version, id, to, from, tabId, incarnation, binding, createdAt }`
 *   `window-requests/<holder id>.<request id>.response`  → `{ version, id, ok, focused }`
 *
 * Only the holder a request names acts on it, and only to **select** the tab: `serve` is a
 * selection-only operation that shows an editor this window already has for that session,
 * while this window still holds the session under the run incarnation the request names, and
 * never launches, stops, acquires a claim, changes a mode or forwards a request. The owner
 * writes the response and deletes the request; the requester reads the response (and deletes
 * it). A request is dropped once it is older than {@link REQUEST_TTL_MS}, and `serve` can ask
 * whether the request is still wanted at the moment it acts, so a request its requester
 * already withdrew is never acted on late. Any local process can write these files, so a
 * forged request can at most make a window show a tab it already has open (and so mark it
 * looked at); a forged response proves nothing about focus or ownership, and one that is not
 * correlated to the request (version, id, shape) is not an answer at all.
 *
 * Bringing the owner's window to the front is not done here: it is `vscode.openFolder` on
 * the owner's saved workspace or single-folder URI, planned by {@link planWindowSwitch}.
 */

import { randomUUID } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { errorCode, readBoundedFile, replaceFileAtomic } from "./atomic-file.ts";
import { watchDirectory } from "./directory-watch.ts";
import type { OpenWindow } from "./window-registry.ts";

export const WINDOW_REQUEST_DIRECTORY = "window-requests";
/**
 * A request older than this is ignored and deleted. The requester gives up after
 * {@link REQUEST_ANSWER_TIMEOUT_MS}, counted from posting, and withdraws its own request on a
 * timer armed when it posts, so this only bounds what a crashed requester leaves behind: the
 * requester's wait plus a second for the clocks and the file system.
 */
export const REQUEST_TTL_MS = 6_000;
/** Request and response files this old are garbage whatever their addressee. */
export const REQUEST_SWEEP_MS = 120_000;
/** How long a requester waits for the owner's answer, from the moment it posts. */
export const REQUEST_ANSWER_TIMEOUT_MS = 5_000;

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
const BINDING_RE = /^[A-Za-z0-9._-]{1,200}$/;
const isBinding = (value: unknown): value is string => typeof value === "string" && BINDING_RE.test(value);
/** Requests being served at once by one window, whatever the number of scans or watch events. */
const MAX_ACTIVE_REQUESTS = 4;
/** Requests waiting for a turn; more are left on disk for the next scan (they expire within the TTL). */
const MAX_QUEUED_REQUESTS = 64;

/** One request to select a session's tab in the window that holds it. */
export interface SwitchRequest {
	readonly version: 1;
	readonly id: string;
	/** The claim holder id of the window that must act; no other window does. */
	readonly to: string;
	readonly from: string;
	readonly tabId: string;
	/** The run incarnation of the session the requester saw held; the owner serves only the run it still holds. */
	readonly incarnation: string;
	/** `<editor slot>.<generation>` of the owner's editor binding the requester saw published for that run; `null` when it saw none. The owner refuses a request for another binding. */
	readonly binding: string | null;
	readonly createdAt: string;
}

/** What the owner did with a request: whether it selected the tab, and whether its window is in front. */
export interface ServeOutcome {
	readonly ok: boolean;
	/** This window has the focus after the selection (always `false` for a refusal). */
	readonly focused: boolean;
}

/** What `serve` may ask while it works. */
export interface ServeContext {
	/** `false` once the request was withdrawn or expired: the requester no longer wants the tab selected. */
	stillWanted(): Promise<boolean>;
}

/** How the requester's wait ended. */
export type SwitchAnswer = "served" | "unfocused" | "refused" | "timeout";

function directoryOf(storageDir: string): string {
	return path.join(path.resolve(storageDir), WINDOW_REQUEST_DIRECTORY);
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function parseRequest(text: string, fileTo: string, fileId: string): SwitchRequest | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	// Every field is checked one by one below; nothing of this shape is trusted before that.
	const { version, id, to, from, tabId, incarnation, binding, createdAt } = parsed as Record<string, unknown>;
	if (version !== VERSION || id !== fileId || to !== fileTo) return null;
	if (typeof from !== "string" || !ID_RE.test(from)) return null;
	if (typeof tabId !== "string" || tabId.length === 0 || tabId.length > MAX_TAB_ID) return null;
	if (typeof incarnation !== "string" || !INCARNATION_RE.test(incarnation)) return null;
	if (binding !== null && !isBinding(binding)) return null;
	if (typeof createdAt !== "string" || createdAt.length > 40 || !Number.isFinite(Date.parse(createdAt))) return null;
	return { version: VERSION, id, to, from, tabId, incarnation, binding, createdAt };
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
	return { ok: record.ok, focused: record.focused };
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
	const directory = directoryOf(storageDir);
	const id = randomUUID();
	const record: SwitchRequest = {
		version: VERSION,
		id,
		to: request.to,
		from: request.from,
		tabId: request.tabId,
		incarnation: request.incarnation,
		binding: request.binding ?? null,
		createdAt: new Date(now()).toISOString(),
	};
	await sweepRequests(directory, now());
	await replaceFileAtomic(path.join(directory, `${request.to}.${id}${REQUEST_SUFFIX}`), `${JSON.stringify(record)}\n`);
	return id;
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
export async function awaitSwitchAnswer(
	storageDir: string,
	to: string,
	id: string,
	options: { readonly timeoutMs?: number; readonly pollMs?: number } = {},
): Promise<SwitchAnswer> {
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
			if (outcome !== null) return !outcome.ok ? "refused" : outcome.focused ? "served" : "unfocused";
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
 * Delete a request nobody is waiting for any more, so its owner does not act on it late. The
 * requester arms this at the moment it posts, independently of any focus change it also asks
 * VS Code for, so the wait cannot outlast {@link REQUEST_ANSWER_TIMEOUT_MS} however long that
 * takes.
 */
export async function withdrawSwitchRequest(storageDir: string, to: string, id: string): Promise<void> {
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
 * {@link REQUEST_TTL_MS} is never served, and a request is served at most once for as long as
 * it could still be acted on, even when its cleanup fails. At most four requests are served
 * at once and sixty-four wait; the rest stay on disk for a later scan.
 * Never throws; failures go to `options.onError`.
 */
export function startRequestWatch(
	storageDir: string,
	holderId: string,
	serve: (request: SwitchRequest, context: ServeContext) => Promise<ServeOutcome>,
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
		for (const [done, when] of completed) if (at - when > REQUEST_TTL_MS + FUTURE_SKEW_MS) completed.delete(done);
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
			if (request === null || age > REQUEST_TTL_MS || age < -FUTURE_SKEW_MS) {
				await fsp.rm(file, { force: true });
				return;
			}
			const stillWanted = async (): Promise<boolean> => {
				if (disposed || now() - Date.parse(request.createdAt) > REQUEST_TTL_MS) return false;
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
				`${JSON.stringify({ version: VERSION, id: request.id, ok: outcome.ok, focused: outcome.ok && outcome.focused })}\n`,
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
	const record = input.windows.find(window => window.holderId === holderId);
	const uri = record === undefined ? input.claim?.windowUri ?? null : record.windowUri;
	const identity = uri === null ? null : windowUriIdentity(uri);
	if (uri === null || identity === null) return { kind: "manual", holderId, incarnation, reason: "no-uri" };
	if (input.windows.some(window => window.holderId !== holderId && window.windowUri !== null && windowUriIdentity(window.windowUri) === identity)) {
		return { kind: "manual", holderId, incarnation, reason: "ambiguous" };
	}
	return { kind: "switch", holderId, incarnation, uri };
}
