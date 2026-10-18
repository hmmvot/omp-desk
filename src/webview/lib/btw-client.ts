/**
 * The page's side-question store (docs/designs/2026-10-19-chat-btw-side-questions.md): a thin, DOM-free wrapper around the shared
 * `reduceBtw` that `ChatClient` owns beside the chat model, so a side question is never part of the transcript's model, snapshot or rows.
 *
 * Rules kept here because they are page-side facts the host cannot enforce for the page:
 *
 * - **Epochs.** Every host message names the conversation epoch the page has adopted; another epoch's message is dropped, as every other
 *   host message is. A new epoch starts the store empty (`reset`); the host sends the current records right after every snapshot.
 * - **A request is answered once.** The panel's own requests (`ask`, `cancel`, `history`) are correlated by a page-minted id; a repeat or
 *   a stale `omp:chat-btw-result` settles nothing, and an answer that never comes ends as `unconfirmed` after a deadline that is never
 *   followed by a resend.
 * - **Writing needs a live, unlocked session**, as for every other mutation; reading what is shown never does.
 */
import type { ChatEpoch } from "../../chat/model.ts";
import { sameEpoch } from "../../chat/model.ts";
import { BTW_INITIAL, BTW_REFUSALS, reduceBtw, type BtwEvent, type BtwState } from "../../chat/btw.ts";
import type { ChatBtwHostMessage, ChatBtwRequestMessage, ChatBtwResultMessage } from "../../protocol/btw-messages.ts";

/** What the panel renders from. */
export interface BtwView extends BtwState {
	/** A request of this page is waiting for the host's answer. */
	readonly pending: boolean;
	/** The fixed sentence of the last refusal, until it is dismissed or the next request. */
	readonly notice: string | null;
}

export type BtwSendResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export interface BtwClientDeps {
	/** `false` when the message provably went nowhere. */
	post(message: ChatBtwRequestMessage): boolean | void;
	/** The epoch the page's chat model has adopted. */
	epoch(): ChatEpoch | null;
	/** The conversation accepts mutations from this page. */
	writable(): boolean;
	newRequestId(): string;
	/** Fixed sentence when the route cannot reach the host. */
	unreachable: string;
}

/** Past the host's own deadline for a command (30 s), so the host's `unconfirmed` arrives first. */
const RESULT_TIMEOUT_MS = 45_000;

interface Pending {
	readonly resolve: (result: BtwSendResult) => void;
	/** A timer handle: a number in the page, an object under the node test runner. */
	readonly timer: unknown;
}

export class BtwClient {
	readonly #deps: BtwClientDeps;
	readonly #listeners = new Set<() => void>();
	readonly #pending = new Map<string, Pending>();
	#state: BtwView = { ...BTW_INITIAL, pending: false, notice: null };

	constructor(deps: BtwClientDeps) {
		this.#deps = deps;
	}

	subscribe = (listener: () => void): (() => void) => {
		this.#listeners.add(listener);
		return () => { this.#listeners.delete(listener); };
	};

	getSnapshot = (): BtwView => this.#state;

	#commit(next: BtwView): void {
		if (next === this.#state) return;
		this.#state = next;
		for (const listener of [...this.#listeners]) listener();
	}

	#fold(event: BtwEvent): void {
		const next = reduceBtw(this.#state, event);
		if (next !== this.#state) this.#commit({ ...next, pending: this.#state.pending, notice: this.#state.notice });
	}

	/** A host message of the `/btw` family; always consumed, applied only when it names the epoch the page has adopted. */
	handle(message: ChatBtwHostMessage): void {
		if (!sameEpoch(message.epoch, this.#deps.epoch())) return;
		switch (message.type) {
			case "omp:chat-btw":
				this.#fold({ type: "records", records: message.records, replace: message.replace, ...(message.omitted === undefined ? {} : { omitted: message.omitted }), ...(message.show === undefined ? {} : { show: "history" as const }) });
				return;
			case "omp:chat-btw-delta":
				this.#fold({ type: "delta", recordId: message.recordId, at: message.at, delta: message.delta });
				return;
			case "omp:chat-btw-result":
				this.#settle(message);
				return;
		}
	}

	/** The page adopted another epoch (a snapshot of a new host or conversation): nothing of the old one is kept. */
	reset(): void {
		for (const requestId of [...this.#pending.keys()]) this.#finish(requestId, { ok: false, reason: BTW_REFUSALS.unconfirmed });
		this.#commit({ ...BTW_INITIAL, pending: false, notice: null });
	}

	/** Start a side question, or a follow-up in topic `recordId`. */
	ask(question: string, recordId?: string): Promise<BtwSendResult> {
		return this.#request({ op: "ask", question, ...(recordId === undefined ? {} : { recordId }) });
	}

	/** Cancel the running side question (only topic `recordId` when given). */
	cancel(recordId?: string): Promise<BtwSendResult> {
		return this.#request({ op: "cancel", ...(recordId === undefined ? {} : { recordId }) });
	}

	/** Read the history again from OMP; the list arrives as an `omp:chat-btw` replacement. */
	refresh(): Promise<BtwSendResult> {
		return this.#request({ op: "history" });
	}

	show(recordId: string): void {
		this.#fold({ type: "show", recordId });
	}

	showHistory(): void {
		this.#fold({ type: "history" });
	}

	close(): void {
		this.#fold({ type: "close" });
	}

	dismissNotice(): void {
		if (this.#state.notice !== null) this.#commit({ ...this.#state, notice: null });
	}

	#request(body: Pick<ChatBtwRequestMessage, "op" | "question" | "recordId">): Promise<BtwSendResult> {
		const epoch = this.#deps.epoch();
		if (!this.#deps.writable() || epoch === null) {
			const reason = BTW_REFUSALS["not-live"];
			this.#commit({ ...this.#state, notice: reason });
			return Promise.resolve({ ok: false, reason });
		}
		const requestId = this.#deps.newRequestId();
		const { promise, resolve } = Promise.withResolvers<BtwSendResult>();
		const timer = setTimeout(() => this.#finish(requestId, { ok: false, reason: BTW_REFUSALS.unconfirmed }), RESULT_TIMEOUT_MS);
		this.#pending.set(requestId, { resolve, timer });
		this.#commit({ ...this.#state, pending: true, notice: null });
		let posted: boolean | void = false;
		try {
			posted = this.#deps.post({ type: "omp:chat-btw-request", requestId, epoch, ...body });
		} catch {
			// A throwing transport does not prove nothing was delivered: wait for the answer or the deadline.
			posted = undefined;
		}
		if (posted === false) this.#finish(requestId, { ok: false, reason: this.#deps.unreachable });
		return promise;
	}

	#settle(message: ChatBtwResultMessage): void {
		this.#finish(message.requestId, message.status === "accepted" ? { ok: true } : { ok: false, reason: BTW_REFUSALS[message.reason ?? "failed"] });
	}

	#finish(requestId: string, result: BtwSendResult): void {
		const pending = this.#pending.get(requestId);
		if (pending === undefined) return;
		this.#pending.delete(requestId);
		clearTimeout(pending.timer as number);
		pending.resolve(result);
		this.#commit({ ...this.#state, pending: this.#pending.size > 0, notice: result.ok ? null : result.reason });
	}
}
