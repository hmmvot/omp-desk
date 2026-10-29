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
 * There are four kinds. A **select** request names a session another window holds
 * (`tabId`, `incarnation`, `binding`): the holder acts only to select the tab, a
 * selection-only operation that shows an editor this window already has for that session,
 * while this window still holds the session under the run incarnation the request names, and
 * never launches, stops, acquires a claim, changes a mode or forwards a request. A **launch**
 * request names a folder the receiver has open (or a session of such a folder) and what to
 * start there; the receiver starts it through its own ordinary launch path and admission, and
 * only for a folder or session it still has itself. A **stop** request (Kill All) names rows
 * by exact broker identity (`slot`, `brokerId`, `generation`, type and conversation) that the
 * requester was shown; the receiver re-reads its own processes and stops, through its own stop
 * lifecycle, only a row that still equals one named identity and that it provably runs, and it
 * answers per row. It never stops a row by anything but that identity, and a stop request never
 * names a process id. A **reload** request (Reload All Windows) carries no argument: the receiver
 * reloads its own window, so a newly installed build takes effect in every window at once.
 *
 * Every kind but `models` is *taken up* before it is answered (the receiver renames the request file to
 * `<holder id>.<request id>.accepted`; a stop, a select and a launch rewrite that file with their progress), because the
 * requester must tell a window that never saw the request (a stop may then go through the broker; a select or launch is
 * withdrawn and reported as unanswered) from one that took it and is working (a stop must not go through the broker; a
 * select or launch is waited for by its progress, not by a fixed short bound, since a busy window may stall for seconds
 * between two steps, ADR-0056 amendment of 2026-10-21). A reload is taken up so that a window that reloads cannot read the
 * same request again once its extension host is back. A request taken up cannot be withdrawn, so a select or launch says
 * when its requester stops waiting (`answerBy`) and the receiver does not act after that:
 *
 *   `window-requests/<holder id>.<request id>.accepted` → `{ version, id, done }`
 *   `window-requests/<holder id>.<request id>.response` → `{ version, id, ok, focused, rows: [{ state, reason }] }`
 *
 * An older build does not take a select or a launch up: it serves the request file in place and deletes it after answering,
 * which a requester of this build reads as an answer (or withdraws the request at the accept bound, exactly as an older
 * requester did); an older requester withdraws at its own, shorter bound, which a receiver of this build counts from
 * `createdAt` when the request names no `answerBy`.
 *
 * The receiver writes the response and deletes the request; the requester reads the response
 * (and deletes it). A request is dropped once it is older than its kind's lifetime
 * ({@link requestTtlMs}), and `serve` can ask whether the request is still wanted at the
 * moment it acts, so a request its requester already withdrew is never acted on late. Any
 * local process can write these files, so a forged request can at most make a window show a
 * tab it already has open (and so mark it looked at) or start an idle session in a folder it
 * has open, or reload its own window, which the same user could do directly; a forged response proves nothing about
 * focus or ownership, and one that is not correlated to the request (version, id, shape) is
 * not an answer at all.
 *
 * A **handover** request (Move to This Window, ADR-0080) names a session this window holds the claim of (`tabId`,
 * `incarnation`, `binding`): the holder drops its view of the live session and releases its claim without stopping the
 * process. It is taken up like a stop and answered with a refusal reason when the holder decides not to move the session.
 *
 * Bringing the owner's window to the front is not done here: it is `vscode.openFolder` on
 * the owner's saved workspace or single-folder URI, planned by {@link planWindowSwitch}.
 */

import { createHash, randomUUID } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { errorCode, readBoundedFile, replaceFileAtomic } from "../wire/atomic-file.ts";
import { watchDirectory } from "./directory-watch.ts";
import type { OpenWindow } from "./window-registry.ts";
import type { RowIdentity } from "./broker-processes.ts";
import type { PtyKind } from "../wire/pty-protocol.ts";

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
/**
 * How long a requester waits for the owner to take a select request up, from the moment it posts. A request nobody took up by
 * then is withdrawn (ADR-0056, amendment of 2026-10-21). Once taken up, the owner is working and the wait follows its progress
 * ({@link SELECT_PROGRESS_TIMEOUT_MS}, {@link SELECT_TOTAL_TIMEOUT_MS}). It is also the bound an older requester, which has no take-up
 * and no `answerBy`, waits for the answer in all.
 */
export const REQUEST_ANSWER_TIMEOUT_MS = 5_000;
/**
 * How long a requester waits for a window to take a launch up, from the moment it posts. The receiver takes it up as soon as its
 * request watch sees it and answers on admission (it has validated the request and begun the launch), not when OMP is ready, so a
 * normal answer takes a few hundred milliseconds; a window that is still loading may take seconds. It is also the bound an older
 * requester waits for the answer in all.
 */
export const LAUNCH_ANSWER_TIMEOUT_MS = 10_000;
/** How long a requester waits, after a window took a select request up, for it to show progress or answer; each change of its progress file restarts the count. */
export const SELECT_PROGRESS_TIMEOUT_MS = 15_000;
/** The longest a requester waits for one select answer in all, from the post, however steadily the owner shows progress. */
export const SELECT_TOTAL_TIMEOUT_MS = 30_000;
/** The launch counterparts of {@link SELECT_PROGRESS_TIMEOUT_MS} and {@link SELECT_TOTAL_TIMEOUT_MS}: a window that took a launch up may still be waiting for its own catalog and folders. */
export const LAUNCH_PROGRESS_TIMEOUT_MS = 30_000;
export const LAUNCH_TOTAL_TIMEOUT_MS = 60_000;
/**
 * A stop request nobody took up this long after it was posted is dropped by its receiver. The
 * requester gives up on acceptance after {@link STOP_ACCEPT_TIMEOUT_MS} and withdraws it, so this only
 * bounds what a crashed requester leaves behind.
 */
export const STOP_REQUEST_TTL_MS = 9_000;
/**
 * A reload request nobody took up this long after it was posted is dropped by its receiver. The requester gives up on
 * it after {@link RELOAD_ACCEPT_TIMEOUT_MS} and withdraws it, so this only bounds what a crashed requester leaves behind:
 * a window that wakes later must not reload for a request nobody waits for.
 */
export const RELOAD_REQUEST_TTL_MS = 6_000;
/** How long a requester waits for a window to take up a reload request before it reloads itself regardless. */
export const RELOAD_ACCEPT_TIMEOUT_MS = 2_000;
/** How long a requester waits for a window to take up a stop request. A window that has not taken it by then is treated as not answering. */
export const STOP_ACCEPT_TIMEOUT_MS = 8_000;
/**
 * How long a requester waits for a window that took up a stop request to show progress (a finished row) or to answer.
 * One row can take a graceful stop and a shutdown wait (about 25 s) before the next report.
 */
export const STOP_PROGRESS_TIMEOUT_MS = 45_000;
/** The longest a requester waits for one stop request in all, however steadily it shows progress. */
export const STOP_TOTAL_TIMEOUT_MS = 600_000;
/**
 * After {@link STOP_ACCEPT_TIMEOUT_MS} a requester tries to withdraw a request nobody took up. When the delete keeps
 * failing for this much longer the wait ends as uncertain: the window may still act on the request.
 */
export const STOP_WITHDRAW_TIMEOUT_MS = 10_000;
/**
 * A requester that was not running for this long between two looks (its host was suspended or starved) can no longer
 * tell "the window never took the request up" from "the window took it up, finished and its files were swept".
 */
export const STOP_STALL_GAP_MS = 5_000;

/** A handover request nobody took up this long after it was posted is dropped by its receiver; the requester withdraws it at {@link HANDOVER_ACCEPT_TIMEOUT_MS}. */
export const HANDOVER_REQUEST_TTL_MS = 12_000;
/** How long a requester waits for the holder to take up a handover request before it withdraws it. */
export const HANDOVER_ACCEPT_TIMEOUT_MS = 8_000;
/** The handover counterparts of {@link STOP_WITHDRAW_TIMEOUT_MS} and {@link STOP_STALL_GAP_MS}. */
export const HANDOVER_WITHDRAW_TIMEOUT_MS = STOP_WITHDRAW_TIMEOUT_MS;
export const HANDOVER_STALL_GAP_MS = STOP_STALL_GAP_MS;
/** The longest a requester waits for one handover answer, from the post. The holder's own work is not bounded by it. */
export const HANDOVER_TOTAL_TIMEOUT_MS = 30_000;
/** An `.accepted` file is take-up evidence for as long as a request can be active (the requester's total wait, with a margin); the ordinary {@link REQUEST_SWEEP_MS} must not erase it. */
export const STOP_ACCEPTED_SWEEP_MS = STOP_TOTAL_TIMEOUT_MS + 300_000;
/** Rows one stop request may name; a requester splits a longer list into several requests. */
export const MAX_STOP_ROWS = 32;

const REQUEST_SUFFIX = ".request";
const RESPONSE_SUFFIX = ".response";
const VERSION = 1;
const ID_RE = /^[A-Za-z0-9-]{1,100}$/;
const INCARNATION_RE = /^[A-Za-z0-9._:-]{1,300}$/;
const FILE_RE = /^([A-Za-z0-9-]{1,100})\.([A-Za-z0-9-]{1,100})\.(request|response)$/;
/** A request stamped further ahead than this is not trusted. */
const FUTURE_SKEW_MS = 5_000;
const MAX_REQUEST_BYTES = 32 * 1024;
const MAX_RESPONSE_BYTES = 1024;
const MAX_STOP_RESPONSE_BYTES = 16 * 1024;
const MAX_PROGRESS_BYTES = 512;
const MAX_STOP_REASON = 240;
const ACCEPTED_SUFFIX = ".accepted";
const SLOT_RE = /^[A-Za-z0-9:._/\\-]{1,256}$/;
const BROKER_FIELD_RE = /^[A-Za-z0-9._:/-]{1,128}$/;
const PTY_KINDS: readonly PtyKind[] = ["managed-rpc", "managed-omp", "folder-shell", "stats-dashboard"];
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
	/**
	 * Select and launch requests only (ADR-0056, amendment of 2026-10-21): the moment this requester stops waiting for the answer, so a
	 * receiver that took the request up does not act for a requester that is gone. A request of an older requester has none; the receiver
	 * then counts the older, shorter wait from `createdAt` ({@link REQUEST_ANSWER_TIMEOUT_MS}, {@link LAUNCH_ANSWER_TIMEOUT_MS}).
	 */
	readonly answerBy?: string;
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
 * it as a folder of Sessions (it has it open, or a folder it stands for as the folder sessions run in);
 * `root`: it is exactly one of the window's own workspace folders, which a Unity project needs
 * (the Unity extensions work from the workspace root), whatever session folder the window shows.
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

/** One request to stop the rows it names that the receiving window runs itself. */
export interface StopRequest extends RequestBase {
	readonly kind: "stop";
	/** What the requester was shown, at most {@link MAX_STOP_ROWS}, without repeats. */
	readonly rows: readonly RowIdentity[];
}

/** One request to reload the receiving window (Reload All Windows). It carries nothing else: the receiver reloads itself. */
export interface ReloadRequest extends RequestBase {
	readonly kind: "reload";
}

/**
 * One request to re-read model availability (a provider login or logout finished in the sending window and may have
 * changed a credential every window of the profile reads). It carries nothing else; the receiver re-reads its own.
 */
export interface ModelsRequest extends RequestBase {
	readonly kind: "models";
}

/**
 * One request to hand a live session over: the claim holder drops its view of the session and releases its claim without
 * stopping the process, so the requester can open it (ADR-0080). The fields fence the exact run the requester saw, as a
 * select request's do; the holder acts only while it still holds that run, and the request is taken up before it acts.
 */
export interface HandoverRequest extends RequestBase {
	readonly kind: "handover";
	readonly tabId: string;
	/** The run incarnation of the session the requester saw held. */
	readonly incarnation: string;
	/** `<editor slot>.<generation>` of the holder's editor binding the requester saw published for that run; `null` when it saw none. */
	readonly binding: string | null;
}

/** What a receiver answers for one named row. */
export type StopRowState =
	/** The receiver's own flow stopped it and its broker is gone. */
	| "stopped"
	/** The receiver runs it and tried; it is not confirmed stopped (a failed or unconfirmed stop, a stop that left its broker open). */
	| "unconfirmed"
	/** The receiver does not provably run it (or the row cannot be stopped by this build): nothing was done, and another route may be taken. */
	| "refused"
	/** The row is gone or no longer equals the identity named, or changed while it was being prepared: nothing was stopped, and nobody else may stop it on the strength of this request. */
	| "changed";

export interface StopRowAnswer {
	readonly state: StopRowState;
	/** Bounded text for the report; may be empty. */
	readonly reason: string;
}

/** A request as a window receives it. */
export type WindowRequest = SwitchRequest | LaunchRequest | StopRequest | ReloadRequest | ModelsRequest | HandoverRequest;

/** How long a request stays actionable. */
export function requestTtlMs(request: Pick<WindowRequest, "kind">): number {
	return request.kind === "launch" ? LAUNCH_REQUEST_TTL_MS
		: request.kind === "stop" ? STOP_REQUEST_TTL_MS
		: request.kind === "reload" ? RELOAD_REQUEST_TTL_MS
		: request.kind === "handover" ? HANDOVER_REQUEST_TTL_MS
		: REQUEST_TTL_MS;
}

/** What the owner did with a request: whether it selected the tab, and whether its window is in front. */
export interface ServeOutcome {
	readonly ok: boolean;
	/** This window has the focus after the selection (always `false` for a refusal). */
	readonly focused: boolean;
	/**
	 * Why a refusal is definite: the receiver decided before it began anything, so nothing was
	 * started there. `stale-build`: the window runs an older OMP Desk than the one installed and
	 * cannot build a view. A handover's `not-holder`, `busy` and `terminal` say the same of the
	 * session. `unfinished` is the one that is not: the holder began a handover and could not
	 * finish it. Only a refusal can carry a reason.
	 */
	readonly refusal?: RefusalReason;
	/** For a select refusal, the holder's check that failed (see {@link SelectCheck}); only a refusal carries one. */
	readonly check?: SelectCheck;
	/** A stop request's per-row answers, in the order of the request's rows; only a successful outcome carries them. */
	readonly rows?: readonly StopRowAnswer[];
	/**
	 * Run once the answer is written and the request file is gone, never sent to the requester. A reload runs here, so
	 * the window that reloads cannot read the same request again, nor reload before it answered.
	 */
	readonly afterAnswer?: () => void;
}

/** The reasons a refusal names; a refusal without one is the ordinary "could not do it". */
export type RefusalReason = "stale-build" | "not-holder" | "busy" | "terminal" | "unfinished";

const REFUSAL_REASONS: readonly RefusalReason[] = ["stale-build", "not-holder", "busy", "terminal", "unfinished"];
const isRefusalReason = (value: unknown): value is RefusalReason => REFUSAL_REASONS.includes(value as RefusalReason);

/**
 * Which check of a holder's select failed. It travels beside the refusal, never as its reason: a build that does not know
 * a value would discard an answer whose `refusal` it cannot read and time out, while it reads a refusal with an extra field.
 */
export type SelectCheck = "no-editor" | "run-mismatch" | "binding-mismatch";

const SELECT_CHECKS: readonly SelectCheck[] = ["no-editor", "run-mismatch", "binding-mismatch"];
export const isSelectCheck = (value: unknown): value is SelectCheck => SELECT_CHECKS.includes(value as SelectCheck);

/** What `serve` may ask while it works. */
export interface ServeContext {
	/**
	 * `false` once the requester no longer wants the work: the request was withdrawn or expired (a request that is not taken up), or, for a select
	 * or launch that was taken up, the moment the requester said it stops waiting (`answerBy`) has passed. A stop, a reload and a handover that were
	 * taken up cannot be withdrawn: `false` only once this window shuts down.
	 */
	stillWanted(): Promise<boolean>;
	/** A taken-up request's progress: a stop's `done` rows, a select's or launch's steps finished. The requester measures silence from the last change. Nothing for any other kind. */
	progress(done: number): Promise<void>;
}

/**
 * How the requester's wait ended. `timeout`: the window never took the request up (it was withdrawn here, or it vanished unanswered): nothing was done
 * there. `silent`: the window took the request up and did not answer in time, or it is not known whether it did: it may still act.
 */
export type RequestAnswer = "served" | "unfocused" | "refused" | "stale-build" | "timeout" | "silent";

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

function parseRowIdentity(value: unknown): RowIdentity | null {
	if (typeof value !== "object" || value === null) return null;
	const { slot, brokerId, generation, ptyKind, tabId } = value as Record<string, unknown>;
	if (typeof slot !== "string" || !SLOT_RE.test(slot)) return null;
	if (typeof brokerId !== "string" || !BROKER_FIELD_RE.test(brokerId)) return null;
	if (typeof generation !== "string" || !BROKER_FIELD_RE.test(generation)) return null;
	if (typeof ptyKind !== "string" || !PTY_KINDS.includes(ptyKind as PtyKind)) return null;
	if (tabId !== null && (typeof tabId !== "string" || tabId.length === 0 || tabId.length > MAX_TAB_ID)) return null;
	return { slot, brokerId, generation, ptyKind: ptyKind as PtyKind, tabId };
}

/** The identities of a stop request: one to {@link MAX_STOP_ROWS}, each well-formed, none repeated. */
function parseStopRows(value: unknown): readonly RowIdentity[] | null {
	if (!Array.isArray(value) || value.length === 0 || value.length > MAX_STOP_ROWS) return null;
	const rows: RowIdentity[] = [];
	const seen = new Set<string>();
	for (const item of value) {
		const row = parseRowIdentity(item);
		if (row === null) return null;
		const key = JSON.stringify([row.slot, row.brokerId, row.generation]);
		if (seen.has(key)) return null;
		seen.add(key);
		rows.push(row);
	}
	return rows;
}

/** The `answerBy` of a select or launch request, or nothing when the request has none or it is not a plausible moment (the older, shorter wait then applies). */
function parseAnswerBy(value: unknown, createdAt: string): { readonly answerBy: string } | Record<string, never> {
	if (typeof value !== "string" || value.length > 40) return {};
	const at = Date.parse(value);
	const created = Date.parse(createdAt);
	return Number.isFinite(at) && at >= created && at - created <= LAUNCH_TOTAL_TIMEOUT_MS + FUTURE_SKEW_MS ? { answerBy: value } : {};
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
	const { version, kind, id, to, from, tabId, incarnation, binding, createdAt, launch, workspace, rows, answerBy } = parsed as Record<string, unknown>;
	if (version !== VERSION || id !== fileId || to !== fileTo) return null;
	if (typeof from !== "string" || !ID_RE.test(from)) return null;
	if (typeof createdAt !== "string" || createdAt.length > 40 || !Number.isFinite(Date.parse(createdAt))) return null;
	if (kind === "launch") {
		const action = parseLaunch(launch);
		const target = parseWorkspace(workspace);
		return action === null || target === null ? null : { kind, version: VERSION, id, to, from, createdAt, ...parseAnswerBy(answerBy, createdAt), workspace: target, launch: action };
	}
	if (kind === "reload" || kind === "models") return { kind, version: VERSION, id, to, from, createdAt };
	if (kind === "stop") {
		const identities = parseStopRows(rows);
		return identities === null ? null : { kind, version: VERSION, id, to, from, createdAt, rows: identities };
	}
	if (kind !== "select" && kind !== "handover") return null;
	if (typeof tabId !== "string" || tabId.length === 0 || tabId.length > MAX_TAB_ID) return null;
	if (typeof incarnation !== "string" || !INCARNATION_RE.test(incarnation)) return null;
	if (binding !== null && !isBinding(binding)) return null;
	return { kind, version: VERSION, id, to, from, tabId, incarnation, binding, createdAt, ...(kind === "select" ? parseAnswerBy(answerBy, createdAt) : {}) };
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
	// An answer of a build that predates a refusal reason has none; one with a reason this build does not know, or a reason on a success, is no answer.
	if (record.refusal !== undefined && (record.ok || !isRefusalReason(record.refusal))) return null;
	// The failed check is only an explanation: one this build does not know, or one on a success, is ignored and the answer still reads.
	const check = !record.ok && isSelectCheck(record.check) ? { check: record.check } : {};
	return { ok: record.ok, focused: record.focused, ...(record.refusal === undefined ? {} : { refusal: record.refusal }), ...check };
}

/** The text of the response file for `outcome`: what the requester reads back with {@link parseResponse}. */
function responseText(id: string, outcome: ServeOutcome): string {
	const refusal = !outcome.ok && outcome.refusal !== undefined ? { refusal: outcome.refusal } : {};
	const check = !outcome.ok && outcome.check !== undefined ? { check: outcome.check } : {};
	const rows = outcome.ok && outcome.rows !== undefined
		? { rows: outcome.rows.map(row => ({ state: row.state, reason: row.reason.slice(0, MAX_STOP_REASON) })) }
		: {};
	return `${JSON.stringify({ version: VERSION, id, ok: outcome.ok, focused: outcome.ok && outcome.focused, ...refusal, ...check, ...rows })}\n`;
}

/**
 * The outcome in `text` for stop request `id` of `count` rows: the per-row answers of a successful answer, `"failed"` for a
 * well-formed answer that says the receiver could not serve (it may have stopped some rows first), or `null` for anything
 * that is not a well-formed answer to this very request.
 */
function parseStopResponse(text: string, id: string, count: number): readonly StopRowAnswer[] | "failed" | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	const record = parsed as Record<string, unknown>;
	if (record.version === VERSION && record.id === id && record.ok === false) return "failed";
	if (record.version !== VERSION || record.id !== id || record.ok !== true || !Array.isArray(record.rows) || record.rows.length !== count) return null;
	const answers: StopRowAnswer[] = [];
	for (const item of record.rows) {
		if (typeof item !== "object" || item === null) return null;
		const { state, reason } = item as Record<string, unknown>;
		if (state !== "stopped" && state !== "unconfirmed" && state !== "refused" && state !== "changed") return null;
		if (typeof reason !== "string" || reason.length > MAX_STOP_REASON) return null;
		answers.push({ state, reason });
	}
	return answers;
}

/**
 * Ask `to` to select `tabId`. Resolves with the request id once the file is in place.
 * Also sweeps request and response files that nobody answered for {@link REQUEST_SWEEP_MS}.
 */
export async function postSwitchRequest(
	storageDir: string,
	request: { readonly to: string; readonly from: string; readonly tabId: string; readonly incarnation: string; readonly binding?: string | null; readonly waitMs?: number },
	now: () => number = Date.now,
): Promise<string> {
	if (!ID_RE.test(request.to) || !ID_RE.test(request.from)) throw new TypeError("a window request needs holder ids of letters, digits and dashes");
	if (!INCARNATION_RE.test(request.incarnation)) throw new TypeError("a window request needs the session's run incarnation");
	if (request.binding != null && !isBinding(request.binding)) throw new TypeError("a window request names a binding as letters, digits, dots and dashes");
	if (request.tabId.length === 0 || request.tabId.length > MAX_TAB_ID) throw new TypeError("a window request needs a tab id of at most 200 characters");
	const id = randomUUID();
	const postedAt = now();
	const record: SwitchRequest = {
		kind: "select",
		version: VERSION,
		id,
		to: request.to,
		from: request.from,
		tabId: request.tabId,
		incarnation: request.incarnation,
		binding: request.binding ?? null,
		createdAt: new Date(postedAt).toISOString(),
		answerBy: new Date(postedAt + (request.waitMs ?? SELECT_TOTAL_TIMEOUT_MS)).toISOString(),
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
	request: { readonly to: string; readonly from: string; readonly workspace: LaunchWorkspace; readonly launch: LaunchAction; readonly waitMs?: number },
	now: () => number = Date.now,
): Promise<string> {
	if (!ID_RE.test(request.to) || !ID_RE.test(request.from)) throw new TypeError("a window request needs holder ids of letters, digits and dashes");
	if (parseLaunch(request.launch) === null) throw new TypeError("a launch request needs a folder id or a tab id and a known verb");
	if (parseWorkspace(request.workspace) === null) throw new TypeError("a launch request needs the folder the receiving window must have open");
	const id = randomUUID();
	const postedAt = now();
	const record: LaunchRequest = {
		kind: "launch",
		version: VERSION,
		id,
		to: request.to,
		from: request.from,
		createdAt: new Date(postedAt).toISOString(),
		answerBy: new Date(postedAt + (request.waitMs ?? LAUNCH_TOTAL_TIMEOUT_MS)).toISOString(),
		workspace: request.workspace,
		launch: request.launch,
	};
	await writeRequest(storageDir, record, now);
	return id;
}

/**
 * Ask `to` to stop the rows it runs among `rows` (at most {@link MAX_STOP_ROWS}). Resolves with the
 * request id once the file is in place; the requester then waits with {@link awaitStopAnswer}.
 */
export async function postStopRequest(
	storageDir: string,
	request: { readonly to: string; readonly from: string; readonly rows: readonly RowIdentity[] },
	now: () => number = Date.now,
): Promise<string> {
	if (!ID_RE.test(request.to) || !ID_RE.test(request.from)) throw new TypeError("a window request needs holder ids of letters, digits and dashes");
	if (parseStopRows(request.rows) === null) throw new TypeError(`a stop request needs one to ${MAX_STOP_ROWS} distinct, well-formed row identities`);
	const id = randomUUID();
	const record: StopRequest = {
		kind: "stop",
		version: VERSION,
		id,
		to: request.to,
		from: request.from,
		createdAt: new Date(now()).toISOString(),
		rows: request.rows,
	};
	await writeRequest(storageDir, record, now);
	return id;
}

/**
 * Ask `to`, the claim holder of `tabId`, to give the live session up without stopping it. Resolves with the request id once the
 * file is in place; the requester then waits with {@link awaitHandoverAnswer}. A window of a build that does not know the kind
 * deletes the request and does nothing.
 */
export async function postHandoverRequest(
	storageDir: string,
	request: { readonly to: string; readonly from: string; readonly tabId: string; readonly incarnation: string; readonly binding: string | null },
	now: () => number = Date.now,
): Promise<string> {
	if (!ID_RE.test(request.to) || !ID_RE.test(request.from)) throw new TypeError("a window request needs holder ids of letters, digits and dashes");
	if (!INCARNATION_RE.test(request.incarnation)) throw new TypeError("a window request needs the session's run incarnation");
	if (request.binding !== null && !isBinding(request.binding)) throw new TypeError("a window request names a binding as letters, digits, dots and dashes");
	if (request.tabId.length === 0 || request.tabId.length > MAX_TAB_ID) throw new TypeError("a window request needs a tab id of at most 200 characters");
	const id = randomUUID();
	const record: HandoverRequest = {
		kind: "handover",
		version: VERSION,
		id,
		to: request.to,
		from: request.from,
		tabId: request.tabId,
		incarnation: request.incarnation,
		binding: request.binding,
		createdAt: new Date(now()).toISOString(),
	};
	await writeRequest(storageDir, record, now);
	return id;
}

/**
 * Ask `to` to reload its window. Resolves with the request id once the file is in place; the requester then waits with
 * {@link awaitReloadTakenUp}. A window of a build that does not know the kind deletes the request and does nothing.
 */
export async function postReloadRequest(
	storageDir: string,
	request: { readonly to: string; readonly from: string },
	now: () => number = Date.now,
): Promise<string> {
	if (!ID_RE.test(request.to) || !ID_RE.test(request.from)) throw new TypeError("a window request needs holder ids of letters, digits and dashes");
	const id = randomUUID();
	const record: ReloadRequest = {
		kind: "reload",
		version: VERSION,
		id,
		to: request.to,
		from: request.from,
		createdAt: new Date(now()).toISOString(),
	};
	await writeRequest(storageDir, record, now);
	return id;
}

/**
 * Ask `to` to re-read its model availability. Resolves with the request id once the file is in place; the requester then
 * waits with {@link awaitRequestAnswer}, which also removes the answer. A window of a build that does not know the kind
 * deletes the request and does nothing.
 */
export async function postModelsRequest(
	storageDir: string,
	request: { readonly to: string; readonly from: string },
	now: () => number = Date.now,
): Promise<string> {
	if (!ID_RE.test(request.to) || !ID_RE.test(request.from)) throw new TypeError("a window request needs holder ids of letters, digits and dashes");
	const id = randomUUID();
	const record: ModelsRequest = { kind: "models", version: VERSION, id, to: request.to, from: request.from, createdAt: new Date(now()).toISOString() };
	await writeRequest(storageDir, record, now);
	return id;
}

/**
 * How a requester's wait for a reload request ended. `taken-up`: the window renamed the request and answers it, so it
 * reloads itself. `unanswered`: the request vanished with no trace of a take-up, which is what a window of an older
 * build that does not know the kind does (it deletes it); that window does not reload. `timeout`: nobody took it up
 * within the bound and it was withdrawn here, so a window that wakes later does not reload for it.
 */
export type ReloadAnswer = "taken-up" | "unanswered" | "timeout";

async function fileExists(file: string): Promise<boolean> {
	return await fsp.stat(file).then(() => true, () => false);
}

/**
 * Wait until reload request `id` addressed to `to` is taken up, or gone, or `timeoutMs` (default
 * {@link RELOAD_ACCEPT_TIMEOUT_MS}) passed, whichever comes first; on a timeout the request is withdrawn. Take-up is
 * read from the `.accepted` file the receiver renames the request to, or its `.response` once that is gone (the
 * receiver writes the response before it deletes the accepted file, so one of the two always shows); the response is
 * deleted here. Never throws.
 */
export async function awaitReloadTakenUp(
	storageDir: string,
	to: string,
	id: string,
	options: { readonly timeoutMs?: number; readonly pollMs?: number } = {},
): Promise<ReloadAnswer> {
	const directory = directoryOf(storageDir);
	const requestFile = path.join(directory, `${to}.${id}${REQUEST_SUFFIX}`);
	const acceptedFile = path.join(directory, `${to}.${id}${ACCEPTED_SUFFIX}`);
	const responseFile = path.join(directory, `${to}.${id}${RESPONSE_SUFFIX}`);
	const deadline = Date.now() + (options.timeoutMs ?? RELOAD_ACCEPT_TIMEOUT_MS);
	const pollMs = options.pollMs ?? 50;
	const classify = async (): Promise<ReloadAnswer> => {
		if (await fileExists(acceptedFile)) return "taken-up";
		if (await fileExists(responseFile)) {
			await fsp.rm(responseFile, { force: true }).catch(() => {});
			return "taken-up";
		}
		return "unanswered";
	};
	for (;;) {
		if (!(await fileExists(requestFile))) return await classify();
		if (Date.now() >= deadline) {
			// Withdraw it. A window that renamed it first wins that race: its take-up shows below, and the delete finds nothing.
			await withdrawRequest(storageDir, to, id).catch(() => {});
			const answer = await classify();
			return answer === "unanswered" ? "timeout" : answer;
		}
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, pollMs).unref?.();
		await promise;
	}
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
			if (now - stat.mtimeMs > (name.endsWith(ACCEPTED_SUFFIX) ? STOP_ACCEPTED_SWEEP_MS : REQUEST_SWEEP_MS)) await fsp.rm(file, { force: true });
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
	options: {
		readonly timeoutMs?: number;
		readonly pollMs?: number;
		/** Told the reason and failed check a refusing answer carried (either may be absent), before the wait returns `"refused"` (or `"stale-build"`). */
		readonly onRefusal?: (reason: RefusalReason | undefined, check: SelectCheck | undefined) => void;
	} = {},
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
			if (outcome !== null) {
				if (!outcome.ok) options.onRefusal?.(outcome.refusal, outcome.check);
				return !outcome.ok ? (outcome.refusal === "stale-build" ? "stale-build" : "refused") : outcome.focused ? "served" : "unfocused";
			}
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

/** How a requester's wait for a stop request ended. */
export type StopAnswer =
	/** The window took the request up and answered every row. */
	| { readonly kind: "answered"; readonly rows: readonly StopRowAnswer[] }
	/**
	 * The window never took the request up: it was withdrawn here after {@link STOP_ACCEPT_TIMEOUT_MS} (the delete
	 * succeeded), or it vanished unanswered (a window of an older build deletes a kind it does not know) while this
	 * requester kept watching. Nothing was stopped there.
	 */
	| { readonly kind: "not-accepted" }
	/**
	 * It is not known whether the window acted: it took the request up and went silent or answered with no usable
	 * report (some rows may have stopped), or the request could not be withdrawn or the evidence of its take-up may be
	 * gone (the requester was suspended). The request may still be served, so nothing may be stopped for these rows
	 * behind the window's back while it is alive. `reason` says which.
	 */
	| { readonly kind: "silent"; readonly reason: string };

type ProbedRead = { readonly kind: "missing" | "invalid" | "busy" } | { readonly kind: "text"; readonly text: string };

/** One bounded read of a file another window rewrites; a sharing conflict while it is replaced reads as `busy`, never an exception. */
async function probeFile(file: string, maxBytes: number): Promise<ProbedRead> {
	try {
		return await readBoundedFile(file, maxBytes);
	} catch {
		return { kind: "busy" };
	}
}

/** What bounds {@link awaitStopAnswer}; every field defaults to the module's constant and exists for tests. */
export interface StopWaitOptions {
	readonly acceptTimeoutMs?: number;
	readonly withdrawTimeoutMs?: number;
	readonly progressTimeoutMs?: number;
	readonly totalTimeoutMs?: number;
	readonly stallGapMs?: number;
	readonly pollMs?: number;
	readonly now?: () => number;
}

/** The bounds of one taken-up wait: the module constants of the request kind that is waited for. */
interface TakenUpBounds {
	readonly acceptMs: number;
	readonly withdrawMs: number;
	readonly progressMs: number;
	readonly totalMs: number;
	readonly stallMs: number;
}

/** A wait that ended without an answer: the request was never taken up (`withdrawn`: this requester deleted it; otherwise it vanished unanswered), or whether the window acted is not known. */
type TakenUpWait<R> = R | { readonly kind: "not-accepted"; readonly withdrawn: boolean } | { readonly kind: "silent"; readonly reason: string };

/**
 * The state machine behind every taken-up request (a stop, a handover): `parse` turns the text of a response file into
 * the answer (`null` for anything that is not a well-formed answer to this very request, which is deleted and ignored).
 * See {@link awaitStopAnswer} for the rules; they are the same for every kind.
 */
async function awaitTakenUpAnswer<R extends { readonly kind: string }>(
	storageDir: string,
	to: string,
	id: string,
	bounds: TakenUpBounds,
	options: { readonly pollMs?: number; readonly now?: () => number },
	maxResponseBytes: number,
	parse: (text: string) => R | null,
): Promise<TakenUpWait<R>> {
	const directory = directoryOf(storageDir);
	const requestFile = path.join(directory, `${to}.${id}${REQUEST_SUFFIX}`);
	const acceptedFile = path.join(directory, `${to}.${id}${ACCEPTED_SUFFIX}`);
	const responseFile = path.join(directory, `${to}.${id}${RESPONSE_SUFFIX}`);
	const { acceptMs, withdrawMs, progressMs, totalMs, stallMs } = bounds;
	const pollMs = options.pollMs ?? 100;
	const clock = options.now ?? Date.now;
	const startedAt = clock();
	/** Whether a file is there; a file that cannot be examined counts as there, never as proof of absence. */
	const exists = async (file: string): Promise<boolean> => {
		try {
			await fsp.stat(file);
			return true;
		} catch (error) {
			return errorCode(error) !== "ENOENT";
		}
	};
	/** `null`: no response file. `"unusable"`: a response file was there and is no answer to this request (it is deleted). */
	const takeResponse = async (): Promise<R | "unusable" | null> => {
		const read = await probeFile(responseFile, maxResponseBytes);
		if (read.kind === "missing" || read.kind === "busy") return null;
		await fsp.rm(responseFile, { force: true }).catch(() => {});
		const outcome = read.kind === "text" ? parse(read.text) : null;
		return outcome === null ? "unusable" : outcome;
	};
	let accepted = false;
	let lastProgress = "";
	let lastProgressAt = startedAt;
	let lastLookAt = startedAt;
	/** This requester was not running between two looks: files may have been removed unseen. */
	let stalled = false;
	const look = (): number => {
		const at = clock();
		if (at - lastLookAt > stallMs) stalled = true;
		lastLookAt = at;
		return at;
	};
	let sawUnusable = false;
	for (;;) {
		const now = look();
		const taken = await takeResponse();
		if (taken === "unusable") sawUnusable = true;
		else if (taken !== null) return taken;
		if (now - startedAt >= totalMs) {
			return { kind: "silent", reason: accepted ? "it took the request up and did not finish in time" : "it did not take the request up in time, and the request is still there" };
		}
		if (!accepted) {
			if (!(await exists(requestFile))) {
				// The file is gone: renamed to the accepted file (one atomic step), or deleted by a window that does not know the kind.
				if (!(await exists(acceptedFile))) {
					const late = await takeResponse();
					if (late !== null && late !== "unusable") return late;
					// A response file that was no answer still proves a window acted on the request.
					if (late === "unusable" || sawUnusable) return { kind: "silent", reason: "it answered with a report that could not be used" };
					// With no evidence left, "never taken up" is only proven by a requester that kept watching.
					look();
					return stalled
						? { kind: "silent", reason: "it is not known whether it took the request up: this window was not running while it could have" }
						: { kind: "not-accepted", withdrawn: false };
				}
				accepted = true;
				lastProgressAt = now;
			} else if (now - startedAt >= acceptMs) {
				try {
					await fsp.unlink(requestFile);
					return { kind: "not-accepted", withdrawn: true };
				} catch (error) {
					// Either the window took the request up in this very instant (the next round finds the accepted file) or
					// the delete is blocked for now; the next round decides, and only a successful delete ever ends the wait as
					// "not taken up". A delete that stays blocked leaves the request servable: that is uncertainty.
					if (errorCode(error) !== "ENOENT" && now - startedAt >= acceptMs + withdrawMs) {
						return { kind: "silent", reason: `the request could not be withdrawn (${messageOf(error)}), so it may still be served` };
					}
				}
			}
		}
		if (accepted) {
			const progress = await probeFile(acceptedFile, MAX_PROGRESS_BYTES);
			if (progress.kind === "missing") {
				// The receiver removes the accepted file after it wrote the response.
				const late = await takeResponse();
				return late === null || late === "unusable" ? { kind: "silent", reason: "it took the request up and did not report back" } : late;
			}
			const text = progress.kind === "text" ? progress.text : "";
			if (progress.kind !== "busy" && text !== lastProgress) {
				lastProgress = text;
				lastProgressAt = now;
			}
			if (now - lastProgressAt >= progressMs) return { kind: "silent", reason: "it took the request up and did not report back" };
		}
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, pollMs).unref?.();
		await promise;
	}
}

/**
 * Wait for the answer to stop request `id`, which names `rowCount` rows.
 *
 * Before the window takes the request up, the requester owns it: at {@link STOP_ACCEPT_TIMEOUT_MS} it
 * deletes the request file, and only a successful delete proves the window never acted (the receiver
 * takes a request up by renaming the file, and exactly one of the two can win). Once the request is
 * taken up the window is working: the wait ends with its answer, or as `silent` once its progress file
 * has not changed for {@link STOP_PROGRESS_TIMEOUT_MS}.
 *
 * The whole wait, before and after take-up, ends by {@link STOP_TOTAL_TIMEOUT_MS}. A request that could not be
 * withdrawn (the delete keeps failing for {@link STOP_WITHDRAW_TIMEOUT_MS}) and a request whose take-up evidence may
 * be gone because this requester was not running for {@link STOP_STALL_GAP_MS} between two looks end as `silent`,
 * never as `not-accepted`: the window may still act, so nothing may be stopped behind its back.
 * Responses that are not a well-formed answer to this request are deleted and ignored.
 */
export async function awaitStopAnswer(
	storageDir: string,
	to: string,
	id: string,
	rowCount: number,
	options: StopWaitOptions = {},
): Promise<StopAnswer> {
	const answer = await awaitTakenUpAnswer<StopAnswer>(storageDir, to, id, {
		acceptMs: options.acceptTimeoutMs ?? STOP_ACCEPT_TIMEOUT_MS,
		withdrawMs: options.withdrawTimeoutMs ?? STOP_WITHDRAW_TIMEOUT_MS,
		progressMs: options.progressTimeoutMs ?? STOP_PROGRESS_TIMEOUT_MS,
		totalMs: options.totalTimeoutMs ?? STOP_TOTAL_TIMEOUT_MS,
		stallMs: options.stallGapMs ?? STOP_STALL_GAP_MS,
	}, options, MAX_STOP_RESPONSE_BYTES, text => {
		const outcome = parseStopResponse(text, id, rowCount);
		if (outcome === null) return null;
		return outcome === "failed" ? { kind: "silent", reason: "it answered with a report that could not be used" } : { kind: "answered", rows: outcome };
	});
	return answer.kind === "not-accepted" ? { kind: "not-accepted" } : answer;
}

/**
 * How a requester's wait for a handover request ended.
 * `moved`: the holder released the session. `refused`: it decided before moving anything (`unfinished`: it began, dropped its
 * connection and could not release the claim, so the session is still running and still held there).
 * `failed`: it answered `ok: false` with no reason, which only says it could not do it. `older-build`: the request vanished
 * without take-up while this requester watched (a window of a build that does not know the kind deletes it): nothing moved.
 * `unresponsive`: it never took the request up within the wait and this requester withdrew it cleanly: nothing moved.
 * `uncertain`: a blocked withdrawal, a requester that was not running, or a request taken up and not answered in time: the move
 * may have happened or may still happen.
 */
export type HandoverOutcome =
	| { readonly kind: "moved" }
	| { readonly kind: "refused"; readonly reason: RefusalReason }
	| { readonly kind: "failed" }
	| { readonly kind: "older-build" }
	| { readonly kind: "unresponsive" }
	| { readonly kind: "uncertain" };

/** What bounds {@link awaitHandoverAnswer}; every field defaults to the module's handover constant and exists for tests. */
export interface HandoverWaitOptions {
	readonly acceptTimeoutMs?: number;
	readonly withdrawTimeoutMs?: number;
	readonly totalTimeoutMs?: number;
	readonly stallGapMs?: number;
	readonly pollMs?: number;
	readonly now?: () => number;
}

/**
 * Wait for the answer to handover request `id`. This is the stop waiter's state machine with the handover bounds: the
 * requester owns the request until the holder takes it up (withdrawing it at {@link HANDOVER_ACCEPT_TIMEOUT_MS}), and the
 * whole wait ends by {@link HANDOVER_TOTAL_TIMEOUT_MS}. A taken-up handover writes no progress, so only the total bounds it.
 * A response that is not a well-formed answer (a reason that is not one of {@link RefusalReason}, a reason on `ok: true`) is
 * deleted and ignored; one that was seen and could not be used ends the wait as `uncertain`, never as "nothing moved".
 */
export async function awaitHandoverAnswer(
	storageDir: string,
	to: string,
	id: string,
	options: HandoverWaitOptions = {},
): Promise<HandoverOutcome> {
	const totalMs = options.totalTimeoutMs ?? HANDOVER_TOTAL_TIMEOUT_MS;
	const answer = await awaitTakenUpAnswer<HandoverOutcome>(storageDir, to, id, {
		acceptMs: options.acceptTimeoutMs ?? HANDOVER_ACCEPT_TIMEOUT_MS,
		withdrawMs: options.withdrawTimeoutMs ?? HANDOVER_WITHDRAW_TIMEOUT_MS,
		progressMs: totalMs,
		totalMs,
		stallMs: options.stallGapMs ?? HANDOVER_STALL_GAP_MS,
	}, options, MAX_RESPONSE_BYTES, text => {
		const outcome = parseResponse(text, id);
		if (outcome === null) return null;
		if (outcome.ok) return { kind: "moved" };
		return outcome.refusal === undefined ? { kind: "failed" } : { kind: "refused", reason: outcome.refusal };
	});
	switch (answer.kind) {
		case "not-accepted": return answer.withdrawn ? { kind: "unresponsive" } : { kind: "older-build" };
		case "silent": return { kind: "uncertain" };
		default: return answer;
	}
}

/** What bounds {@link awaitSelectAnswer} and {@link awaitLaunchAnswer}; every field defaults to the module's constant of the kind and exists for tests. */
export interface ServedWaitOptions {
	readonly acceptTimeoutMs?: number;
	readonly withdrawTimeoutMs?: number;
	readonly progressTimeoutMs?: number;
	readonly totalTimeoutMs?: number;
	readonly stallGapMs?: number;
	readonly pollMs?: number;
	readonly now?: () => number;
	/** Told the reason and failed check a refusing answer carried (either may be absent), before the wait returns `"refused"` (or `"stale-build"`). */
	readonly onRefusal?: (reason: RefusalReason | undefined, check: SelectCheck | undefined) => void;
}

/** A select or launch answer as the taken-up wait reads it from the response file. */
type ServedAnswer =
	| { readonly kind: "served"; readonly focused: boolean }
	| { readonly kind: "refused"; readonly refusal: RefusalReason | undefined; readonly check: SelectCheck | undefined };

/**
 * The wait for a select or launch answer (ADR-0056, amendment of 2026-10-21): the taken-up state machine of {@link awaitTakenUpAnswer} with
 * the answer vocabulary of {@link RequestAnswer}. Before the receiver takes the request up the requester owns it and withdraws it at the
 * accept bound (`timeout`: nothing was done there). Once it is taken up the receiver is working, and the wait ends with its answer, or as
 * `silent` once its progress file has not changed for the progress bound, or the total bound has passed. A response that is not a well-formed
 * answer is deleted and ignored; one that was seen and could not be used ends the wait as `silent`, never as "nothing was done".
 */
async function awaitServedAnswer(
	storageDir: string,
	to: string,
	id: string,
	defaults: { readonly acceptMs: number; readonly progressMs: number; readonly totalMs: number },
	options: ServedWaitOptions,
): Promise<RequestAnswer> {
	const answer = await awaitTakenUpAnswer<ServedAnswer>(storageDir, to, id, {
		acceptMs: options.acceptTimeoutMs ?? defaults.acceptMs,
		withdrawMs: options.withdrawTimeoutMs ?? STOP_WITHDRAW_TIMEOUT_MS,
		progressMs: options.progressTimeoutMs ?? defaults.progressMs,
		totalMs: options.totalTimeoutMs ?? defaults.totalMs,
		stallMs: options.stallGapMs ?? STOP_STALL_GAP_MS,
	}, options, MAX_RESPONSE_BYTES, text => {
		const outcome = parseResponse(text, id);
		if (outcome === null) return null;
		return outcome.ok ? { kind: "served", focused: outcome.focused } : { kind: "refused", refusal: outcome.refusal, check: outcome.check };
	});
	switch (answer.kind) {
		case "not-accepted": return "timeout";
		case "silent": return "silent";
		case "served": return answer.focused ? "served" : "unfocused";
		case "refused":
			options.onRefusal?.(answer.refusal, answer.check);
			return answer.refusal === "stale-build" ? "stale-build" : "refused";
	}
}

/** Wait for the answer to select request `id`: see {@link awaitServedAnswer}. Never throws except on an unreadable directory. */
export async function awaitSelectAnswer(storageDir: string, to: string, id: string, options: ServedWaitOptions = {}): Promise<RequestAnswer> {
	return await awaitServedAnswer(storageDir, to, id, { acceptMs: REQUEST_ANSWER_TIMEOUT_MS, progressMs: SELECT_PROGRESS_TIMEOUT_MS, totalMs: SELECT_TOTAL_TIMEOUT_MS }, options);
}

/** Wait for the answer to launch request `id`: see {@link awaitServedAnswer}. */
export async function awaitLaunchAnswer(storageDir: string, to: string, id: string, options: ServedWaitOptions = {}): Promise<RequestAnswer> {
	return await awaitServedAnswer(storageDir, to, id, { acceptMs: LAUNCH_ANSWER_TIMEOUT_MS, progressMs: LAUNCH_PROGRESS_TIMEOUT_MS, totalMs: LAUNCH_TOTAL_TIMEOUT_MS }, options);
}

/**
 * What one window answered for one row of {@link askWindowToStop}: a receiver's answer, or why there is none.
 * `not-accepted`: the window never took the request up (nothing was done there). `silent`: it is not known whether
 * the window acted: it took the request up and went silent, or answered with no usable report (some rows may have
 * stopped there), or the request could not be withdrawn, or the evidence of its take-up may be gone.
 */
export type PeerRowAnswer = StopRowAnswer | { readonly state: "not-accepted" | "silent"; readonly reason: string };

/**
 * Ask `request.to` to stop the rows it runs among `request.rows`, in as many requests as {@link MAX_STOP_ROWS}
 * needs, one after another, and answer for every row in order. Once a request is not taken up or goes silent the
 * rows not asked yet are answered the same way and no further request is posted to that window. Never throws.
 */
export async function askWindowToStop(
	storageDir: string,
	request: { readonly to: string; readonly from: string; readonly rows: readonly RowIdentity[] },
	options: StopWaitOptions = {},
): Promise<readonly PeerRowAnswer[]> {
	const answers: PeerRowAnswer[] = [];
	let blocked: PeerRowAnswer | null = null;
	for (let start = 0; start < request.rows.length; start += MAX_STOP_ROWS) {
		const chunk = request.rows.slice(start, start + MAX_STOP_ROWS);
		if (blocked !== null) {
			answers.push(...chunk.map(() => blocked!));
			continue;
		}
		let id: string;
		try {
			id = await postStopRequest(storageDir, { to: request.to, from: request.from, rows: chunk });
		} catch (error) {
			blocked = { state: "not-accepted", reason: `the request could not be posted: ${messageOf(error)}` };
			answers.push(...chunk.map(() => blocked!));
			continue;
		}
		const answer = await awaitStopAnswer(storageDir, request.to, id, chunk.length, options);
		if (answer.kind === "answered") {
			answers.push(...answer.rows);
			continue;
		}
		blocked = answer.kind === "silent"
			? { state: "silent", reason: answer.reason }
			: { state: "not-accepted", reason: "" };
		answers.push(...chunk.map(() => blocked!));
	}
	return answers;
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
			const acceptedFile = path.join(directory, `${request.to}.${request.id}${ACCEPTED_SUFFIX}`);
			const takenUp = request.kind !== "models";
			if (takenUp) {
				// Take the request up: one atomic rename, so the requester's delete and this claim cannot both win. A request
				// the requester already withdrew is gone, and nothing is done for it.
				try {
					await fsp.rename(file, acceptedFile);
				} catch (error) {
					if (errorCode(error) !== "ENOENT") report(`a ${request.kind} request could not be taken up: ${messageOf(error)}`);
					return;
				}
			}
			const stillWanted = async (): Promise<boolean> => {
				if (disposed) return false;
				// A stop, a reload and a handover that were taken up cannot be withdrawn (the user already confirmed the stop; the reload and the
				// handover are the very act asked for).
				if (takenUp && request.kind !== "select" && request.kind !== "launch") return true;
				// A select or launch that was taken up cannot be withdrawn either, so the requester says when it stops waiting (`answerBy`); a
				// request of an older requester, which withdraws its file at its older, shorter bound, is counted from `createdAt`.
				if (request.kind === "select" || request.kind === "launch") {
					const until = request.answerBy !== undefined
						? Date.parse(request.answerBy)
						: Date.parse(request.createdAt) + (request.kind === "select" ? REQUEST_ANSWER_TIMEOUT_MS : LAUNCH_ANSWER_TIMEOUT_MS);
					return now() <= until;
				}
				if (now() - Date.parse(request.createdAt) > requestTtlMs(request)) return false;
				try {
					return (await fsp.stat(file)).isFile();
				} catch {
					return false;
				}
			};
			const progress = async (done: number): Promise<void> => {
				if (!takenUp || request.kind === "reload" || request.kind === "handover" || disposed) return;
				await replaceFileAtomic(acceptedFile, `${JSON.stringify({ version: VERSION, id: request.id, done })}\n`).catch(() => {});
			};
			let outcome: ServeOutcome = { ok: false, focused: false };
			try {
				outcome = await serve(request, { stillWanted, progress });
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
			if (takenUp) await fsp.rm(acceptedFile, { force: true });
			// Only now is the request gone for good: a window that reloads here does not read it again.
			outcome.afterAnswer?.();
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
 * folder open (after session-folder substitution, `here` included): the asking window when it has
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
				outcome = await serve(request, { stillWanted, progress: async () => {} });
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
