/**
 * The two OMP frames that only report a failure of the transport or of an extension, shown as transcript notices:
 * `extension_error` (the terminal UI prints `Extension "<path>" error: <text>`) and `rpc_frame_error` (OMP dropped an
 * event that could not fit the transport limit). Both carry text chosen outside this extension, so it is stripped of
 * control sequences and bounded here, and the page shows it as text, never as markup.
 */
import { stripAnsi } from "../chat/ansi.ts";
import { CLEAR_ERROR_PATH } from "../chat/clear.ts";
import { DROPPED_FRAME_NOTICE_SOURCE, EXTENSION_ERROR_NOTICE_SOURCE } from "../chat/events.ts";
import { NAVIGATE_ERROR_PATH } from "../chat/rewind.ts";

const MAX_PATH_CHARS = 200;
const MAX_ERROR_CHARS = 1_000;
const MAX_TYPE_CHARS = 64;

/** A notice frame as `toChatEventFrame` returns it. */
export interface FrameNotice {
	type: "notice";
	level: "warning" | "error";
	message: string;
	source: string;
}

function clamp(value: unknown, max: number): string {
	if (typeof value !== "string") return "";
	const clean = stripAnsi(value, max * 4).trim();
	return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

/**
 * `Extension "<path>" error: <text>`, or `null` for a failure of Desk's own `/rewind` or `/clear` command: those
 * are answered to the caller as coded refusals (`session.ts`) and their text never belongs in the transcript.
 */
export function extensionErrorNotice(frame: Record<string, unknown>): FrameNotice | null {
	if (frame.extensionPath === NAVIGATE_ERROR_PATH || frame.extensionPath === CLEAR_ERROR_PATH) return null;
	const path = clamp(frame.extensionPath, MAX_PATH_CHARS);
	const error = clamp(frame.error, MAX_ERROR_CHARS);
	if (path.length === 0 && error.length === 0) return null;
	const event = clamp(frame.event, MAX_TYPE_CHARS);
	const where = path.length === 0 ? "Extension" : `Extension "${path}"`;
	const during = event.length === 0 ? "" : ` (${event})`;
	return { type: "notice", level: "error", message: `${where} error${during}: ${error.length === 0 ? "no details reported" : error}`, source: EXTENSION_ERROR_NOTICE_SOURCE };
}

/** The dropped frame's type, or `null` when OMP did not name it. */
export function droppedFrameType(frame: Record<string, unknown>): string | null {
	const type = clamp(frame.originalType, MAX_TYPE_CHARS);
	return type.length === 0 ? null : type;
}

/**
 * The frame types whose loss leaves the model behind the session: the host reads the file again when OMP reports
 * one dropped. A lost `message_update` is replaced by the next one and needs nothing; `agent_end` is never dropped
 * (OMP sends a shortened one instead) but is listed so that a future change on OMP's side cannot strand a turn.
 */
const STATE_FRAMES: Record<string, true> = {
	agent_start: true, agent_end: true, turn_start: true, turn_end: true, message_start: true, message_end: true,
	tool_execution_start: true, tool_execution_end: true, auto_compaction_end: true, queue_update: true,
};

export function droppedFrameAffectsState(type: string | null): boolean {
	return type !== null && Object.hasOwn(STATE_FRAMES, type);
}

/** `OMP dropped a "<type>" event: it was too large for the connection.` plus what Desk does about it. */
export function droppedFrameNotice(frame: Record<string, unknown>): FrameNotice {
	const type = droppedFrameType(frame);
	const name = type === null ? "an event" : `a "${type}" event`;
	const reason = clamp(frame.error, MAX_ERROR_CHARS);
	const recovery = droppedFrameAffectsState(type) ? " Chat reads the session file again to catch up." : "";
	return { type: "notice", level: "warning", message: `OMP dropped ${name}${reason.length === 0 ? "" : `: ${reason}`}.${recovery}`, source: DROPPED_FRAME_NOTICE_SOURCE };
}
