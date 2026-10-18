/**
 * The `/btw` side-question messages of the `omp:chat-*` wire (docs/designs/2026-10-19-chat-btw-side-questions.md).
 *
 * Host → page (epoch-tagged; the page drops another epoch's):
 *
 * | message | content |
 * | --- | --- |
 * | `omp:chat-btw` | records of the side-question history: `replace` swaps the whole list, otherwise each is upserted by id; `show` asks the panel to open the list |
 * | `omp:chat-btw-delta` | text appended to the latest turn of one record, valid only at the answer length `at` |
 * | `omp:chat-btw-result` | the answer to one panel request: accepted, or refused with a reason from the fixed vocabulary |
 *
 * Page → host: `omp:chat-btw-request` (`ask`, `cancel`, `history`), a mutation with a page-minted `requestId` like the others.
 *
 * `chat-messages.ts` owns the epoch grammar and calls the parsers here with the epoch (and, for a request, the request id) already
 * checked, so this module imports nothing from it. Nothing here carries a credential or free-form OMP text except the question, the answer
 * and a failed turn's bounded error.
 */
import {
	MAX_BTW_QUESTION_CHARS,
	MAX_BTW_RECORDS,
	isBtwRecordId,
	isBtwRefusal,
	parseBtwRecordView,
	type BtwRecordView,
	type BtwRefusal,
} from "../chat/btw.ts";
import type { ChatEpoch } from "../chat/model.ts";

export interface ChatBtwMessage {
	type: "omp:chat-btw";
	epoch: ChatEpoch;
	records: BtwRecordView[];
	replace: boolean;
	/** Records OMP holds that a `replace` list does not carry. */
	omitted?: number;
	show?: "history";
}

export interface ChatBtwDeltaMessage {
	type: "omp:chat-btw-delta";
	epoch: ChatEpoch;
	recordId: string;
	at: number;
	delta: string;
}

export interface ChatBtwResultMessage {
	type: "omp:chat-btw-result";
	epoch: ChatEpoch;
	requestId: string;
	status: "accepted" | "refused";
	reason?: BtwRefusal;
}

export type ChatBtwHostMessage = ChatBtwMessage | ChatBtwDeltaMessage | ChatBtwResultMessage;

export interface ChatBtwRequestMessage {
	type: "omp:chat-btw-request";
	requestId: string;
	epoch: ChatEpoch;
	op: "ask" | "cancel" | "history";
	/** `ask`: the question (never blank). */
	question?: string;
	/** `ask`: the topic to continue; `cancel`: only that topic. */
	recordId?: string;
}

/** Longest delta one message carries (a model's text delta is a few tokens; this bounds a malformed one). */
const MAX_DELTA_CHARS = 64_000;
/** A page-minted request id: 128 random bits as lowercase hex (the grammar of `isChatRequestId`). */
const REQUEST_ID = /^[0-9a-f]{32}$/;

function isCount(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** One host → page message of this family whose epoch the caller already validated, or `null`. */
export function parseBtwHostMessage(value: Record<string, unknown>, epoch: ChatEpoch): ChatBtwHostMessage | null {
	switch (value.type) {
		case "omp:chat-btw": {
			if (!Array.isArray(value.records) || value.records.length > MAX_BTW_RECORDS || typeof value.replace !== "boolean") return null;
			const records: BtwRecordView[] = [];
			for (const raw of value.records) {
				const record = parseBtwRecordView(raw);
				if (record === null) return null;
				records.push(record);
			}
			if (value.omitted !== undefined && !isCount(value.omitted)) return null;
			if (value.show !== undefined && value.show !== "history") return null;
			return {
				type: "omp:chat-btw",
				epoch,
				records,
				replace: value.replace,
				...(value.omitted === undefined || value.omitted === 0 ? {} : { omitted: value.omitted }),
				...(value.show === undefined ? {} : { show: "history" as const }),
			};
		}
		case "omp:chat-btw-delta":
			if (!isBtwRecordId(value.recordId) || !isCount(value.at) || typeof value.delta !== "string" || value.delta.length === 0 || value.delta.length > MAX_DELTA_CHARS) return null;
			return { type: "omp:chat-btw-delta", epoch, recordId: value.recordId, at: value.at, delta: value.delta };
		case "omp:chat-btw-result": {
			if (typeof value.requestId !== "string" || !REQUEST_ID.test(value.requestId) || (value.status !== "accepted" && value.status !== "refused")) return null;
			if (value.status === "accepted") return { type: "omp:chat-btw-result", epoch, requestId: value.requestId, status: "accepted" };
			return isBtwRefusal(value.reason) ? { type: "omp:chat-btw-result", epoch, requestId: value.requestId, status: "refused", reason: value.reason } : null;
		}
		default:
			return null;
	}
}

/** The page's request, whose `requestId` and `epoch` the caller already validated, or `null`. */
export function parseBtwRequest(value: Record<string, unknown>, requestId: string, epoch: ChatEpoch): ChatBtwRequestMessage | null {
	const { op, question, recordId } = value;
	if (recordId !== undefined && !isBtwRecordId(recordId)) return null;
	switch (op) {
		case "ask":
			if (typeof question !== "string" || question.trim().length === 0 || question.length > MAX_BTW_QUESTION_CHARS) return null;
			return { type: "omp:chat-btw-request", requestId, epoch, op, question, ...(recordId === undefined ? {} : { recordId }) };
		case "cancel":
			if (question !== undefined) return null;
			return { type: "omp:chat-btw-request", requestId, epoch, op, ...(recordId === undefined ? {} : { recordId }) };
		case "history":
			if (question !== undefined || recordId !== undefined) return null;
			return { type: "omp:chat-btw-request", requestId, epoch, op };
		default:
			return null;
	}
}
