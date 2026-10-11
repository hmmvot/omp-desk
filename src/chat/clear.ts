/**
 * Vocabulary of Chat's in-place `/clear` (ADR-0059), shared by the OMP-side command, the host and the page.
 *
 * The -e command writes OMP's own boundary and publicly reloads it. Desk then runs the supported /fresh
 * builtin, verifies provider identity rotation, and asks the command to append the final marker.
 * The codec, marker and fixed refusal vocabulary are shared; remaining native-clear differences are in the ADR.
 */
import { isRecord } from "../guards.ts";

/** The extension command the host-control module registers in RPC mode. */
export const CLEAR_COMMAND = "omp-desk-clear";
/** `customType` of the final post-reload, post-fresh confirmation entry. */
export const CLEAR_MARKER_TYPE = "omp-desk/clear";
/** Every refusal the command throws starts with this, then one {@link ClearRefusalCode}. */
export const CLEAR_ERROR_PREFIX = `${CLEAR_COMMAND}:`;
/** `extension_error.extensionPath` of a refusal or failure thrown by the command handler. */
export const CLEAR_ERROR_PATH = `command:${CLEAR_COMMAND}`;

/** Fixed child-error vocabulary. Failures after a write do not establish which live context remains. */
export type ClearRefusalCode = "bad-request" | "mode" | "unsupported" | "work-unavailable" | "busy" | "jobs" | "session" | "reload-failed" | "failed";
const CODES: Record<string, true> = { "bad-request": true, mode: true, unsupported: true, "work-unavailable": true, busy: true, jobs: true, session: true, "reload-failed": true, failed: true };

const REQUEST_ID = /^[0-9a-f]{32}$/;
const MAX_ID_LENGTH = 256;
const entryId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH;

/** The request the host sends and the handler re-checks. */
export interface ClearArgs {
	v: 1;
	requestId: string;
	sessionId: string;
	/** Confirmation is sent only after the supported /fresh builtin and provider-id readback succeed. */
	phase?: "confirm";
}

/** The prompt text that runs the command. */
export function encodeClearCommand(args: ClearArgs): string {
	return `/${CLEAR_COMMAND} ${JSON.stringify(args)}`;
}

/** Parse the command's argument string (everything after the name). `null` for anything malformed. */
export function parseClearArgs(text: string): ClearArgs | null {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return null;
	}
	if (!isRecord(value) || value.v !== 1) return null;
	const { requestId, sessionId } = value;
	if (typeof requestId !== "string" || !REQUEST_ID.test(requestId) || !entryId(sessionId)) return null;
	if (value.phase !== undefined && value.phase !== "confirm") return null;
	return { v: 1, requestId, sessionId, ...(value.phase === "confirm" ? { phase: "confirm" as const } : {}) };
}

/** The error message a refusal throws. */
export function clearError(code: ClearRefusalCode): Error {
	return new Error(`${CLEAR_ERROR_PREFIX}${code}`);
}

/** The refusal code in an `extension_error` text; any other text from the command is a plain `failed`. */
export function clearErrorCode(message: unknown): ClearRefusalCode {
	if (typeof message !== "string" || !message.startsWith(CLEAR_ERROR_PREFIX)) return "failed";
	const code = message.slice(CLEAR_ERROR_PREFIX.length).trim();
	return CODES[code] === true ? code as ClearRefusalCode : "failed";
}

/** The data of the marker entry. */
export interface ClearMarkerData {
	v: 1;
	requestId: string;
	/** The id of OMP's `reset_boundary` entry the command wrote. */
	boundaryId: string;
}

export interface ClearMarker extends ClearMarkerData {
	/** The marker entry's own id. */
	id: string;
}

/** The marker an entry is, or `null`. Accepts a parsed chat entry or a raw `get_entries` record. */
export function clearMarker(entry: object): ClearMarker | null {
	if (!("type" in entry) || entry.type !== "custom" || !("customType" in entry) || entry.customType !== CLEAR_MARKER_TYPE) return null;
	if (!("id" in entry) || !entryId(entry.id)) return null;
	const data = "data" in entry ? entry.data : undefined;
	if (!isRecord(data) || data.v !== 1 || typeof data.requestId !== "string" || !REQUEST_ID.test(data.requestId) || !entryId(data.boundaryId)) return null;
	return { id: entry.id, v: 1, requestId: data.requestId, boundaryId: data.boundaryId };
}

/**
 * Why a clear did not happen, decided by the host before writing or reported back by the OMP-side guard
 * (`RpcSession.clear`). `unconfirmed` is not a refusal and has its own sentence.
 */
export type ClearRefusal = "not-live" | "not-owner" | "busy" | "jobs" | "work-unavailable" | "unsupported" | "restart-needed" | "session" | "reload-failed" | "bad-request-id" | "failed";

/** OMP's own sentence for a clear refused while a response streams; the page shows it unchanged. */
export const CLEAR_BUSY_SENTENCE = "Wait for the current response to finish or abort it before resetting the context.";

/** One fixed sentence per refusal; nothing from the child is ever shown. */
export const CLEAR_REFUSAL_SENTENCES: Readonly<Record<ClearRefusal | "unconfirmed" | "arguments", string>> = {
	"not-live": "/clear needs a running session. Resume it first.",
	"not-owner": "Another window controls this session.",
	busy: CLEAR_BUSY_SENTENCE,
	jobs: "OMP still has background jobs running for this session. Wait for them to finish or cancel them, then use /clear.",
	unsupported: "/clear is not supported by this OMP version.",
	"restart-needed": "This chat's OMP process was started by an earlier OMP Desk build. Restart the session to use /clear.",
	session: "The session changed under this chat. Nothing was cleared.",
	"reload-failed": "Context clear did not finish; the next message may still include earlier history. Retry /clear.",
	"bad-request-id": "OMP did not clear the context.",
	failed: "OMP did not clear the context.",
	unconfirmed: "Context clear did not finish; the next message may still include earlier history. Retry /clear.",
	"work-unavailable": "OMP could not establish that background work is idle. Nothing was cleared.",
	arguments: "/clear takes no arguments.",
};

/** The line shown once the reset is confirmed. */
export const CLEAR_DONE_SENTENCE = "Context cleared. The session, its file and its title are unchanged.";
