/**
 * The host's side of `/btw` (docs/designs/2026-10-19-chat-btw-side-questions.md): the `btw`, `btw_cancel` and `get_btw_history`
 * commands and the `btw_record` / `btw_delta` frames of one OMP session.
 *
 * A side question is not part of the conversation, so none of this reaches the chat model, the transcript or the turn state. The
 * channel keeps a bounded cache of OMP's side-question history, which OMP's own sidecar file stays the authority of: the cache is
 * replaced by every history read and repaired by the terminal record of a turn.
 *
 * It owns no timers and no listeners; it lives and dies with its `RpcSession`, which injects the command line and the output sink.
 * Nothing here imports `vscode`.
 */
import {
	appendBtwDelta,
	btwLatestTurn,
	btwRecordFromOmp,
	btwRecordsFromOmp,
	btwRefusalFromOmpError,
	btwRunning,
	btwTurnCount,
	fitBtwList,
	fitBtwRecord,
	sortBtwRecords,
	upsertBtwRecord,
	type BtwRecordView,
	type BtwRefusal,
} from "../../chat/btw.ts";
import { isRecord } from "../../shared/guards.ts";

/** What one command came back with, or why it did not. */
export type BtwReply =
	| { readonly status: "response"; readonly success: boolean; readonly data?: unknown; readonly error?: string }
	| { readonly status: "unconfirmed" }
	| { readonly status: "not-live" }
	| { readonly status: "failed" };

/** What the channel hands the session to deliver to the pages. */
export type BtwOutput =
	| { readonly kind: "records"; readonly records: readonly BtwRecordView[]; readonly replace: boolean; readonly omitted: number; readonly show?: "history" }
	| { readonly kind: "delta"; readonly recordId: string; readonly at: number; readonly delta: string };

export type BtwAsk = { readonly status: "started" } | { readonly status: "refused"; readonly reason: BtwRefusal };
export type BtwHistory = { readonly status: "loaded" } | { readonly status: "refused"; readonly reason: BtwRefusal };

export interface BtwChannelDeps {
	/** Write one command and wait for its response. */
	send(command: { type: "btw"; question: string; recordId?: string } | { type: "btw_cancel"; recordId?: string } | { type: "get_btw_history" }): Promise<BtwReply>;
	emit(output: BtwOutput): void;
}

export class BtwChannel {
	readonly #deps: BtwChannelDeps;
	#records: readonly BtwRecordView[] = [];
	#loaded = false;

	constructor(deps: BtwChannelDeps) {
		this.#deps = deps;
	}

	/** Whether a side question is answering right now, as far as the frames showed. */
	get running(): boolean {
		return this.#records.some(btwRunning);
	}

	/**
	 * Whether OMP's history was read once. Before that the cache is only what frames delivered, so a page is not sent it as the whole list:
	 * a recreated session (an extension-host restart reattaches the child with a new `RpcSession`) would otherwise tell the page that
	 * a question still answering in OMP is gone.
	 */
	get loaded(): boolean {
		return this.#loaded;
	}

	/** The cache as one `replace` message carries it, for a page that attaches or gets a new snapshot. */
	snapshot(): { readonly records: readonly BtwRecordView[]; readonly omitted: number } {
		return fitBtwList(this.#records);
	}

	/**
	 * A `btw_record` or `btw_delta` frame, or the `notice` OMP raises when a side-question checkpoint could not be saved (`source:
	 * "btw-history"`): frames of this kind never reach the chat model, so a storage failure of an aside is not a transcript row. Returns
	 * `true` for every frame of the family. A record is parsed and bounded or dropped; a delta for a record the cache does not know is
	 * dropped (OMP sends the record first), and one the cache cannot place is not forwarded.
	 */
	onFrame(frame: Record<string, unknown>): boolean {
		if (frame.type === "notice") return frame.source === "btw-history";
		if (frame.type === "btw_record") {
			const record = btwRecordFromOmp(frame.record);
			if (record !== null) this.#upsert(record);
			return true;
		}
		if (frame.type !== "btw_delta") return false;
		if (typeof frame.recordId !== "string" || typeof frame.delta !== "string") return true;
		const known = this.#records.find(record => record.id === frame.recordId);
		if (known === undefined) return true;
		const at = btwLatestTurn(known).answer.length;
		const result = appendBtwDelta(this.#records, frame.recordId, at, frame.delta);
		if (!result.applied) return true;
		this.#records = result.records;
		this.#deps.emit({ kind: "delta", recordId: frame.recordId, at, delta: frame.delta });
		return true;
	}

	/** Start a side question, or a follow-up in topic `recordId`. */
	async ask(question: string, recordId?: string): Promise<BtwAsk> {
		const reply = await this.#deps.send({ type: "btw", question, ...(recordId === undefined ? {} : { recordId }) });
		const refusal = refusalOf(reply);
		if (refusal !== null) return { status: "refused", reason: refusal };
		// The record frame precedes the response; a response whose record the cache does not hold yet (a missed frame) supplies it.
		const data = dataOf(reply);
		const record = data === null ? null : btwRecordFromOmp(data.record);
		const known = record === null ? undefined : this.#records.find(item => item.id === record.id);
		if (record !== null && (known === undefined || btwTurnCount(record) > btwTurnCount(known))) this.#upsert(record);
		return { status: "started" };
	}

	/** Cancel the running side question (only topic `recordId` when given). `false`: none matched. The terminal record does the visible work. */
	async cancel(recordId?: string): Promise<boolean> {
		return dataOf(await this.#deps.send({ type: "btw_cancel", ...(recordId === undefined ? {} : { recordId }) }))?.cancelled === true;
	}

	/** Read OMP's history and replace the cache with it; every page is sent the list, asked to open it when `show`. */
	async history(show = false): Promise<BtwHistory> {
		const reply = await this.#deps.send({ type: "get_btw_history" });
		const refusal = refusalOf(reply);
		if (refusal !== null) return { status: "refused", reason: refusal };
		const data = dataOf(reply);
		const records = data === null ? null : btwRecordsFromOmp(data.records);
		if (records === null) return { status: "refused", reason: "failed" };
		const cached = new Map(this.#records.map(record => [record.id, record]));
		this.#records = sortBtwRecords(records.map(record => {
			const mine = cached.get(record.id);
			return mine !== undefined && fresher(mine, record) ? mine : record;
		}));
		this.#loaded = true;
		const { records: carried, omitted } = fitBtwList(this.#records);
		this.#deps.emit({ kind: "records", records: carried, replace: true, omitted, ...(show ? { show: "history" as const } : {}) });
		return { status: "loaded" };
	}

	#upsert(record: BtwRecordView): void {
		this.#records = upsertBtwRecord(this.#records, record);
		this.#deps.emit({ kind: "records", records: [fitBtwRecord(record)], replace: false, omitted: 0 });
	}
}

/** The reason a reply is not a success, or `null` for one. */
function refusalOf(reply: BtwReply): BtwRefusal | null {
	switch (reply.status) {
		case "response":
			return reply.success ? null : btwRefusalFromOmpError(reply.error);
		case "unconfirmed":
			return "unconfirmed";
		case "not-live":
			return "not-live";
		case "failed":
			return "failed";
	}
}

/** The answer's data object of a successful response, or `null`. */
function dataOf(reply: BtwReply): Record<string, unknown> | null {
	return reply.status === "response" && reply.success && isRecord(reply.data) ? reply.data : null;
}

/**
 * Whether the cached copy `mine` is at least as new as OMP's `theirs`: more turns; or the same turns and, while both still run, at least as
 * much text; a finished copy beats a running one and a running one never beats a finished one; two finished copies by `updatedAt`. The
 * cache wins a tie.
 */
function fresher(mine: BtwRecordView, theirs: BtwRecordView): boolean {
	const turns = btwTurnCount(mine) - btwTurnCount(theirs);
	if (turns !== 0) return turns > 0;
	const a = btwLatestTurn(mine);
	const b = btwLatestTurn(theirs);
	if (a.status === "running" && b.status === "running") return a.answer.length >= b.answer.length;
	if (a.status === "running") return false;
	if (b.status === "running") return true;
	return a.updatedAt >= b.updatedAt;
}
