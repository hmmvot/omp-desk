/**
 * `/btw` side questions (docs/designs/2026-10-19-chat-btw-side-questions.md): the command token, the bounded record view that
 * crosses the host/page wire, the reducers both sides fold it with, and the fixed sentences.
 *
 * A side question is **not** a conversation entry: OMP answers it from the session's context without adding to the journal,
 * and keeps it in a sidecar history that the terminal UI reads too. Nothing here touches `ChatModel`.
 *
 * Pure: no host code, no `vscode`, no DOM. Imported by the host (`host/rpc/btw.ts`), the page (`webview/lib/btw-client.ts`)
 * and the protocol parsers.
 */
import { isRecord } from "../shared/guards.ts";

/** The lifecycle of one turn of a topic, as OMP's history stores it. */
export type BtwStatus = "running" | "complete" | "cancelled" | "error" | "interrupted";

const STATUSES: Readonly<Record<string, true>> = { running: true, complete: true, cancelled: true, error: true, interrupted: true };

/** One question and its answer. */
export interface BtwTurnView {
	readonly question: string;
	readonly answer: string;
	readonly status: BtwStatus;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly error?: string;
	/** The answer was cut to {@link MAX_BTW_ANSWER_CHARS}; no later delta is carried. */
	readonly clipped?: true;
}

/** One topic: its first turn and its follow-ups, oldest first. `omitted` counts the older turns left out of `turns`. */
export interface BtwRecordView {
	readonly id: string;
	readonly turns: readonly BtwTurnView[];
	readonly omitted?: number;
}

/** Records one list carries (the newest). */
export const MAX_BTW_RECORDS = 50;
/** Turns one record carries (the newest). */
export const MAX_BTW_TURNS = 20;
export const MAX_BTW_ANSWER_CHARS = 64_000;
export const MAX_BTW_QUESTION_CHARS = 8_000;
export const MAX_BTW_ERROR_CHARS = 500;
/** Wire bytes ({@link btwWireBytes}) one `replace` message may carry; records past it are counted as omitted. Under the bridge's 256 KiB frame ceiling. */
export const BTW_LIST_BUDGET_BYTES = 192 * 1024;
/** OMP's topic id grammar (`session/btw-history.ts`). */
const RECORD_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;

export function isBtwRecordId(value: unknown): value is string {
	return typeof value === "string" && RECORD_ID.test(value);
}

// The command

/**
 * `/btw` typed into Chat: only a **leading** token counts (after the whitespace the send trims; any case; the token rule of
 * `deskSessionCommand`, so `/btw-it` and `explain /btw` are text). The question is the rest, trimmed; empty means "show the history".
 */
export function btwCommand(text: string): { question: string } | null {
	const match = /^\s*\/btw(?=\s|$)(.*)$/is.exec(text);
	return match === null ? null : { question: match[1]!.trim() };
}

// Bounds

function clip(text: string, max: number): { text: string; clipped: boolean } {
	if (text.length <= max) return { text, clipped: false };
	let end = max;
	// Never end on half of a surrogate pair.
	const last = text.charCodeAt(end - 1);
	if (last >= 0xd800 && last <= 0xdbff) end -= 1;
	return { text: text.slice(0, end), clipped: true };
}

function isTime(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function turnFrom(value: unknown): BtwTurnView | null {
	if (!isRecord(value)) return null;
	const { question, answer, status, createdAt, updatedAt, error } = value;
	if (typeof question !== "string" || typeof answer !== "string" || typeof status !== "string" || !Object.hasOwn(STATUSES, status) || !isTime(createdAt) || !isTime(updatedAt)) return null;
	const shown = clip(answer, MAX_BTW_ANSWER_CHARS);
	return {
		question: clip(question, MAX_BTW_QUESTION_CHARS).text,
		answer: shown.text,
		status: status as BtwStatus,
		createdAt,
		updatedAt,
		...(typeof error === "string" && error.length > 0 ? { error: clip(error, MAX_BTW_ERROR_CHARS).text } : {}),
		...(shown.clipped || value.clipped === true ? { clipped: true as const } : {}),
	};
}

function newestTurns(turns: readonly BtwTurnView[], already = 0): { turns: BtwTurnView[]; omitted: number } {
	const cut = Math.max(0, turns.length - MAX_BTW_TURNS);
	return { turns: turns.slice(cut), omitted: already + cut };
}

function recordOf(id: unknown, turns: readonly BtwTurnView[], omittedBefore: number): BtwRecordView | null {
	if (!isBtwRecordId(id) || turns.length === 0) return null;
	const { turns: kept, omitted } = newestTurns(turns, omittedBefore);
	return { id, turns: kept, ...(omitted > 0 ? { omitted } : {}) };
}

/** A record as OMP's `btw_record` frame and `get_btw_history` carry it (the record is its own first turn, `followUps` the rest), or `null`. */
export function btwRecordFromOmp(value: unknown): BtwRecordView | null {
	if (!isRecord(value)) return null;
	const first = turnFrom(value);
	if (first === null) return null;
	const turns = [first];
	if (value.followUps !== undefined) {
		if (!Array.isArray(value.followUps)) return null;
		for (const follow of value.followUps) {
			const turn = turnFrom(follow);
			if (turn === null) return null;
			turns.push(turn);
		}
	}
	return recordOf(value.id, turns, 0);
}

/** A record as it crosses the host/page wire, validated again by the page, or `null`. */
export function parseBtwRecordView(value: unknown): BtwRecordView | null {
	if (!isRecord(value) || !Array.isArray(value.turns) || value.turns.length > MAX_BTW_TURNS) return null;
	const turns: BtwTurnView[] = [];
	for (const raw of value.turns) {
		const turn = turnFrom(raw);
		if (turn === null) return null;
		turns.push(turn);
	}
	const omitted = value.omitted;
	if (omitted !== undefined && (typeof omitted !== "number" || !Number.isSafeInteger(omitted) || omitted < 0)) return null;
	return recordOf(value.id, turns, omitted ?? 0);
}

/** The records of a list, newest first, from a `get_btw_history` answer. Records that do not parse are skipped; `null` when it is not a list. */
export function btwRecordsFromOmp(value: unknown): BtwRecordView[] | null {
	if (!Array.isArray(value)) return null;
	const records: BtwRecordView[] = [];
	for (const raw of value) {
		const record = btwRecordFromOmp(raw);
		if (record !== null) records.push(record);
	}
	return sortBtwRecords(records);
}

// Reading a record

export function btwLatestTurn(record: BtwRecordView): BtwTurnView {
	return record.turns[record.turns.length - 1]!;
}

/** Whether the record's latest turn is still answering. */
export function btwRunning(record: BtwRecordView): boolean {
	return btwLatestTurn(record).status === "running";
}

export function btwTurnCount(record: BtwRecordView): number {
	return record.turns.length + (record.omitted ?? 0);
}

/** The most recent non-blank answer, whitespace untouched (OMP's `getBtwCopyText`), or `undefined`. */
export function btwCopyText(record: BtwRecordView): string | undefined {
	for (let index = record.turns.length - 1; index >= 0; index--) {
		const answer = record.turns[index]!.answer;
		if (answer.trim().length > 0) return answer;
	}
	return undefined;
}

/**
 * The status to show for a turn. A turn that is `running` while nothing can still answer it (the child is gone) is shown as
 * `interrupted`, the state OMP's own history gives such a turn on the next read.
 */
export function btwShownStatus(turn: BtwTurnView, answering: boolean): BtwStatus {
	return turn.status === "running" && !answering ? "interrupted" : turn.status;
}

// Folding records. The list is newest first by the first turn's time, then by id, as OMP sorts it.

export function sortBtwRecords(records: readonly BtwRecordView[]): BtwRecordView[] {
	return [...records].sort((a, b) => b.turns[0]!.createdAt - a.turns[0]!.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).slice(0, MAX_BTW_RECORDS);
}

/** The list with `record` in it: the record of the same id replaced, else added. */
export function upsertBtwRecord(records: readonly BtwRecordView[], record: BtwRecordView): readonly BtwRecordView[] {
	const at = records.findIndex(known => known.id === record.id);
	if (at < 0) return sortBtwRecords([record, ...records]);
	const next = [...records];
	next[at] = record;
	return sortBtwRecords(next);
}

export interface BtwDeltaResult {
	readonly records: readonly BtwRecordView[];
	/** The text was appended (the record is known, the length matched, the clip was not reached). */
	readonly applied: boolean;
}

/**
 * Append `delta` to the latest turn of `recordId`, but only when that turn is still `running` and its answer is exactly `at` characters
 * long: a lost or reordered delta is then ignored instead of corrupting the text (a cancelled or failed turn keeps an empty answer, so
 * length alone cannot tell it from a follow-up whose first record was lost), and the terminal record (which carries the whole answer) repairs it.
 * A turn that reaches {@link MAX_BTW_ANSWER_CHARS} is clipped and takes no more text.
 */
export function appendBtwDelta(records: readonly BtwRecordView[], recordId: string, at: number, delta: string): BtwDeltaResult {
	const index = records.findIndex(record => record.id === recordId);
	if (index < 0) return { records, applied: false };
	const record = records[index]!;
	const latest = btwLatestTurn(record);
	if (latest.status !== "running" || latest.clipped === true || latest.answer.length !== at || delta.length === 0) return { records, applied: false };
	const joined = clip(latest.answer + delta, MAX_BTW_ANSWER_CHARS);
	const turn: BtwTurnView = { ...latest, answer: joined.text, ...(joined.clipped ? { clipped: true as const } : {}) };
	const next = [...records];
	next[index] = { ...record, turns: [...record.turns.slice(0, -1), turn] };
	return { records: next, applied: true };
}

/**
 * The bytes `value` costs on the bridge, which measures `JSON.stringify` after every non-ASCII UTF-16 unit became a six-byte `\uXXXX`
 * escape (`asciiJsonText`): counted here without building that text.
 */
export function btwWireBytes(value: unknown): number {
	const json = JSON.stringify(value);
	let bytes = 0;
	for (let i = 0; i < json.length; i++) bytes += json.charCodeAt(i) < 0x80 ? 1 : 6;
	return bytes;
}

/** Answer lengths a record that does not fit one message is cut to, longest first. */
const ANSWER_LIMITS: readonly number[] = [16_000, 4_000, 1_000, 200];

/**
 * `record` as one wire message may carry it: unchanged when it fits `budget`, else with every answer cut (and flagged `clipped`) to the
 * longest of {@link ANSWER_LIMITS} that fits. Pages see the cut copy; the host's own cache keeps the whole answer.
 */
export function fitBtwRecord(record: BtwRecordView, budget = BTW_LIST_BUDGET_BYTES): BtwRecordView {
	let fitted = record;
	for (const limit of ANSWER_LIMITS) {
		if (btwWireBytes(fitted) <= budget) return fitted;
		fitted = {
			...record,
			turns: record.turns.map(turn => {
				const cut = clip(turn.answer, limit);
				return cut.clipped ? { ...turn, answer: cut.text, clipped: true as const } : turn;
			}),
		};
	}
	return fitted;
}

/**
 * The records one `replace` message carries: newest first until `budget` wire bytes ({@link btwWireBytes}, default
 * {@link BTW_LIST_BUDGET_BYTES}), at least the newest (cut to fit when it alone is too large); the rest is counted in `omitted`.
 */
export function fitBtwList(records: readonly BtwRecordView[], budget = BTW_LIST_BUDGET_BYTES): { records: BtwRecordView[]; omitted: number } {
	const kept: BtwRecordView[] = [];
	let used = 0;
	for (const record of records.slice(0, MAX_BTW_RECORDS)) {
		const size = btwWireBytes(record);
		if (kept.length > 0 && used + size > budget) break;
		kept.push(kept.length === 0 ? fitBtwRecord(record, budget) : record);
		used += size;
	}
	return { records: kept, omitted: records.length - kept.length };
}

// The page's view: the records plus which of them the panel shows

export type BtwPanel = { readonly kind: "record"; readonly id: string } | { readonly kind: "history" } | null;

export interface BtwState {
	readonly records: readonly BtwRecordView[];
	/** Records OMP holds that this list does not carry. */
	readonly omitted: number;
	readonly panel: BtwPanel;
}

export const BTW_INITIAL: BtwState = { records: [], omitted: 0, panel: null };

export type BtwEvent =
	| { readonly type: "records"; readonly records: readonly BtwRecordView[]; readonly replace: boolean; readonly omitted?: number; readonly show?: "history" }
	| { readonly type: "delta"; readonly recordId: string; readonly at: number; readonly delta: string }
	| { readonly type: "show"; readonly recordId: string }
	| { readonly type: "history" }
	| { readonly type: "close" }
	| { readonly type: "reset" };

/**
 * The page's rule for what the panel shows: a record whose latest turn **just started** (a new id, or one more turn than known) opens
 * on its own, because somebody just asked; a list that replaces everything returns to the running record (a reloaded page goes back to the
 * answering question) or to the history when asked to; an old finished topic never opens by itself; a shown record that is gone closes.
 */
export function reduceBtw(state: BtwState, event: BtwEvent): BtwState {
	switch (event.type) {
		case "reset":
			return BTW_INITIAL;
		case "close":
			return state.panel === null ? state : { ...state, panel: null };
		case "history":
			return { ...state, panel: { kind: "history" } };
		case "show":
			return state.records.some(record => record.id === event.recordId) ? { ...state, panel: { kind: "record", id: event.recordId } } : state;
		case "delta": {
			const result = appendBtwDelta(state.records, event.recordId, event.at, event.delta);
			return result.applied ? { ...state, records: result.records } : state;
		}
		case "records": {
			if (event.replace) {
				const records = sortBtwRecords(event.records);
				const running = records.find(btwRunning);
				const shown = state.panel?.kind === "record" ? state.panel.id : null;
				const panel: BtwPanel = event.show === "history"
					? { kind: "history" }
					: running !== undefined
						? { kind: "record", id: running.id }
						: state.panel?.kind === "history" || (shown !== null && records.some(record => record.id === shown)) ? state.panel : null;
				return { records, omitted: event.omitted ?? 0, panel };
			}
			let records = state.records;
			let panel = state.panel;
			for (const record of event.records) {
				const known = records.find(item => item.id === record.id);
				records = upsertBtwRecord(records, record);
				if (btwRunning(record) && (known === undefined || btwTurnCount(record) > btwTurnCount(known))) panel = { kind: "record", id: record.id };
			}
			return { ...state, records, panel };
		}
	}
}

// Fixed sentences

/** Why a side question could not start. */
export type BtwRefusal = "busy" | "no-model" | "unknown-topic" | "storage" | "cancelled" | "unsupported" | "unconfirmed" | "failed" | "not-live" | "images" | "too-long";

export const BTW_REFUSALS: Readonly<Record<BtwRefusal, string>> = {
	busy: "A side question is still answering. Cancel it first.",
	"no-model": "OMP has no active model for a side question.",
	"unknown-topic": "That side conversation no longer exists. Type /btw to see the current list.",
	storage: "OMP could not save the side-question history, so it did not start the question.",
	cancelled: "The side question was cancelled before it started.",
	unsupported: "This OMP version has no /btw over RPC. Update OMP, or use Terminal mode.",
	unconfirmed: "OMP has not confirmed the side question. If it started, its answer appears in the panel; it was not resent.",
	failed: "OMP could not start the side question.",
	"not-live": "This conversation is not accepting input right now.",
	images: "A side question takes text only. Remove the attached images and send it again.",
	"too-long": "A side question is limited to 8,000 characters. Shorten it and send it again.",
};

export function isBtwRefusal(value: unknown): value is BtwRefusal {
	return typeof value === "string" && Object.hasOwn(BTW_REFUSALS, value);
}

/**
 * The reason behind a failed `btw` response, chosen by OMP 18.11.1's own wording (`modes/rpc/rpc-btw.ts`, `rpc-mode.ts`). The wording is
 * matched, never shown: a later OMP that words one differently lands in `failed`, which is true and safe.
 */
export function btwRefusalFromOmpError(error: string | undefined): BtwRefusal {
	if (error === undefined) return "failed";
	if (error.startsWith("A /btw question is still running")) return "busy";
	if (error.startsWith("Unknown /btw topic")) return "unknown-topic";
	if (error.startsWith("No active model available for /btw")) return "no-model";
	if (error.startsWith("Could not save /btw history")) return "storage";
	if (error.startsWith("The /btw question was cancelled before it started")) return "cancelled";
	if (error === "Unknown command: btw") return "unsupported";
	return "failed";
}
