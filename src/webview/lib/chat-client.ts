/**
 * The chat page's store: a thin, DOM-free wrapper around the shared chat model.
 *
 * The extension host owns the conversation. This client folds the host's `omp:chat-*`
 * messages into the same reducer the host runs (`src/chat/model.ts`) and posts the page's
 * commands back; it holds no session credential and decides nothing the host would not
 * re-check. It exposes an immutable {@link ChatSnapshot} through a
 * `useSyncExternalStore`-compatible subscribe/getSnapshot pair: the model object gets a
 * new reference per applied message, and the reducer shares untouched fields, so
 * reference equality is enough for React change detection.
 *
 * Rules kept here, because they are page-side facts the host cannot enforce for the page:
 *
 * - **Epochs.** Every host message names an epoch `(hostNonce, counter)`. A snapshot resets
 *   the model unconditionally and adopts its epoch (a restarted host's counter may be below
 *   the page's retained one, so ordering by counter alone would drop the new host); every
 *   later message of another epoch is dropped.
 * - **A snapshot is atomic.** Rows arrive chunked; the page applies the reset only once every
 *   announced chunk is in ({@link ChatSnapshotAssembler}), so it never renders half a transcript.
 * - **A dialog is answered at most once.** The answer is sent for the dialog on screen only,
 *   its id is remembered, and the model pops it immediately so the next queued dialog appears;
 *   a repeat click, a stale card or a re-delivered request cannot produce a second answer.
 *   The memory is dropped at the next snapshot: the host guarantees a snapshot holds only
 *   dialogs still unanswered, and it settles each dialog id exactly once on its side.
 * - **Writing needs a live, unlocked session.** A view-only, stopped, legacy, failed or
 *   still-starting conversation refuses every mutation here, in addition to the host's checks.
 */
// Explicit `.ts` specifiers: this module is imported by the node:test runner.
import type { ImageContent } from "@oh-my-pi/pi-wire";
import type { ChatModel, ChatEpoch, ChatSnapshotPayload, ChatUiResponse } from "../../chat/model.ts";
import {
	applyChatEntries,
	applyChatEvent,
	applyChatOlder,
	applyChatSnapshot,
	applyChatState,
	applyChatUiCancel,
	applyChatUiRequest,
	createChatModel,
	sameEpoch,
} from "../../chat/model.ts";
import { classifySlashInput, slashDeniedSentence } from "../../host/rpc/protocol.ts";
import type { GuestHostMessage, GuestWebviewMessage } from "../messages.ts";
import { ChatSnapshotAssembler } from "../chat-messages.ts";
import type { ChatAbortResultMessage, ChatDisplayPreferences, ChatNavigateResultMessage, ChatQueuePurpose, ChatQueueResultEntry, ChatQueueResultItem, ChatQueuedRef } from "../chat-messages.ts";
import type { NavigationKind } from "../../chat/rewind.ts";
import { parseSubagentPage, type SubagentTranscriptPage } from "../../chat/subagent-transcript.ts";

/** What every surface renders from. */
export type ChatSnapshot = ChatModel;

/** The one place a message leaves this page. */
export interface ChatTransport {
	/** `false` when the message provably went nowhere; anything else means it was handed to a route. */
	post(message: GuestWebviewMessage): boolean | void;
}

/** A source of validated host messages (`guestTransport` in the page). */
export interface ChatMessageSource {
	subscribe(listener: (message: GuestHostMessage) => void): () => void;
}

export interface ChatClientOptions {
	/** Clock for reducer timestamps; injectable for tests. */
	now?: () => number;
	/** Mutation id minter; injectable for tests. */
	newRequestId?: () => string;
}

/**
 * The outcome of a send; a refusal names why, in a fixed sentence the composer shows. `explained` means the host
 * answered a terminal-UI command itself instead of sending it: nothing reached OMP, and no turn starts.
 */
export type ChatSendResult = { ok: true; explained?: true } | { ok: false; reason: string; unconfirmed?: boolean };

/** What a Stop withdrew from OMP's queues, delivered to the page that pressed it (see {@link ChatClient.sendAbort}). */
export type ChatAbortAnswer = Omit<ChatAbortResultMessage, "type" | "epoch" | "requestId">;

/** Stops awaiting their queue hand-back; bounded so a host that never answers cannot grow it. */
const MAX_PENDING_ABORTS = 16;

/** The outcome of one in-place navigation (see {@link ChatClient.navigate}). */
export type ChatNavigateAnswer = Omit<ChatNavigateResultMessage, "type">;
/** Past the host's worst case: a summarizing rewind may wait 180 s for OMP, then re-reads the session. */
const NAVIGATE_RESULT_TIMEOUT_MS = 240_000;

/** Dialog answers remembered across one epoch; bounded so a long session cannot grow it. */
const MAX_ANSWERED = 256;

const REFUSAL_NOT_LIVE = "the session is not running, so it cannot take a message";
const REFUSAL_UNREACHABLE =
	"this editor cannot reach its session host right now, so the message was not sent; wait for the connection to return and send it again";

const REFUSAL_NOT_ACCEPTED = "OMP did not accept this message. Your draft was kept.";
const REFUSAL_UNCONFIRMED = "OMP has not confirmed this message. Your draft was kept; sending it again could deliver it twice.";
/** Past the host's admission deadline, covering a lost result without ever resending input. */
const SEND_RESULT_TIMEOUT_MS = 45_000;
/** 128 random bits as lowercase hex: the mutation id grammar of `omp:chat-*`. */
export function newChatRequestId(): string {
	const bytes = new Uint8Array(16);
	globalThis.crypto.getRandomValues(bytes);
	let out = "";
	for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
	return out;
}

/** Whether a model's conversation accepts mutations from this page. */
export function chatWritable(model: ChatModel): boolean {
	return model.phase === "live" && model.readOnlyReason === null;
}

/** The outcome of {@link ChatClient.removeQueued}: the host's per-item results, or why nothing could be asked. */
export type ChatQueueRemoveResult = { ok: true; results: readonly ChatQueueResultItem[] } | { ok: false; reason: string };

/** How long a removal waits for the host before every item is reported `unknown`: past the host's own worst case (it stops at its first unconfirmed command, one 30 s command timeout). */
const QUEUE_REMOVAL_TIMEOUT_MS = 90_000;
const REFUSAL_UNREACHABLE_QUEUE =
	"this editor cannot reach its session host right now, so the queued messages were not changed; wait for the connection to return and try again";

interface PendingSubagentRead {
	epoch: ChatEpoch;
	subagentId: string;
	resolve(page: SubagentTranscriptPage): void;
	timer: unknown;
	chunks: number | null;
	parts: Map<number, string>;
}

interface PendingQueueRemoval {
	epoch: ChatEpoch;
	purpose: ChatQueuePurpose;
	items: ChatQueuedRef[];
	resolve(result: ChatQueueRemoveResult): void;
	timer: unknown;
}

export class ChatClient {
	readonly #transport: ChatTransport;
	readonly #now: () => number;
	readonly #newRequestId: () => string;
	readonly #listeners = new Set<() => void>();
	readonly #assembler = new ChatSnapshotAssembler();
	readonly #answered = new Set<string>();
	readonly #childReads = new Map<string, PendingSubagentRead>();
	readonly #queueRemovals = new Map<string, PendingQueueRemoval>();
	readonly #textSends = new Map<string, { resolve(result: ChatSendResult): void; timer: unknown }>();
	readonly #aborts = new Map<string, (answer: ChatAbortAnswer) => void>();
	readonly #navigations = new Map<string, { resolve(answer: ChatNavigateAnswer): void; timer: unknown }>();
	readonly #navigationListeners = new Set<(answer: ChatNavigateAnswer) => void>();
	#model: ChatModel = createChatModel();
	#displayPreferences: ChatDisplayPreferences = { toolCallDetail: "overview", accessibilitySupport: false };
	#draftHandoffLocked = false;

	/** A queue Edit already admitted must finish before its removed text can be captured. */
	get draftHandoffPending(): boolean { return this.#queueRemovals.size > 0; }
	setDraftHandoffLocked(locked: boolean): void { this.#draftHandoffLocked = locked; }

	constructor(transport: ChatTransport, options: ChatClientOptions = {}) {
		this.#transport = transport;
		this.#now = options.now ?? Date.now;
		this.#newRequestId = options.newRequestId ?? newChatRequestId;
	}

	getSnapshot = (): ChatSnapshot => this.#model;
	getDisplayPreferences = (): ChatDisplayPreferences => this.#displayPreferences;

	/** Ask the host to open the native Tools output picker. Presentation only: no OMP/session mutation authority, even on read-only chats. */
	chooseToolCallDetail(): boolean {
		const epoch = this.#model.epoch;
		if (epoch === null) return false;
		return this.#transport.post({ type: "omp:chat-tool-detail", epoch, requestId: this.#newRequestId() }) !== false;
	}

	subscribe = (listener: () => void): (() => void) => {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	};

	/** Follow `source` until the returned function is called. */
	attach(source: ChatMessageSource): () => void {
		return source.subscribe(message => this.handle(message));
	}

	/** Whether this page may currently write to the conversation. */
	get writable(): boolean {
		return chatWritable(this.#model);
	}

	#commit(next: ChatModel): void {
		if (next === this.#model) return;
		this.#model = next;
		for (const listener of [...this.#listeners]) listener();
	}

	/**
	 * Fold one host message. Returns `true` when it was a chat message (applied or
	 * deliberately dropped as another epoch's), `false` when it is not this client's.
	 */
	handle(message: GuestHostMessage): boolean {
		const clock = { now: this.#now() };
		const model = this.#model;
		switch (message.type) {
			case "omp:chat-send-result": {
				// Admission has already run: correlate by id even if reconciliation changed the epoch.
				this.#finishTextSend(message.requestId, message.status);
				return true;
			}
			case "omp:chat-abort-result": {
				// Correlated by request id alone: OMP already withdrew these messages, whatever the epoch did since.
				const answer = this.#aborts.get(message.requestId);
				if (answer === undefined) return true;
				this.#aborts.delete(message.requestId);
				answer({ status: message.status, entries: message.entries, ...(message.imagesDropped ? { imagesDropped: true } : {}), ...(message.truncated ? { truncated: true } : {}) });
				return true;
			}
			case "omp:chat-navigate-result": {
				// Correlated by request id alone; a palette Rewind (no page asked) still reaches every listener.
				const { type: _type, ...answer } = message;
				const pending = this.#navigations.get(message.requestId);
				if (pending !== undefined) {
					this.#navigations.delete(message.requestId);
					clearTimeout(pending.timer as number);
					pending.resolve(answer);
				}
				for (const listener of [...this.#navigationListeners]) listener(answer);
				return true;
			}
			case "omp:chat-display-preferences":
				if (!sameEpoch(model.epoch, message.epoch)) return true;
				if (this.#displayPreferences.toolCallDetail !== message.toolCallDetail || this.#displayPreferences.accessibilitySupport !== message.accessibilitySupport ||
					this.#displayPreferences.thinkingExpanded !== message.thinkingExpanded || this.#displayPreferences.toolsExpanded !== message.toolsExpanded) {
					const { type: _type, epoch: _epoch, ...preferences } = message;
					this.#displayPreferences = preferences;
					for (const listener of this.#listeners) listener();
				}
				return true;
			case "omp:chat-queue-result": {
				// Correlated by request id alone: the removal already ran in OMP, so an epoch that moved since the request
				// (any reconcile does that) must not make the page discard a confirmed removal.
				const pending = this.#queueRemovals.get(message.requestId);
				if (pending === undefined || pending.purpose !== message.purpose || message.results.length !== pending.items.length) return true;
				this.#finishQueueRemoval(message.requestId, message.results);
				return true;
			}
			case "omp:chat-subagent-chunk": {
				const pending = this.#childReads.get(message.requestId);
				if (pending === undefined || pending.subagentId !== message.subagentId || !sameEpoch(pending.epoch, message.epoch) || !sameEpoch(model.epoch, message.epoch)) return true;
				if (pending.chunks !== null && pending.chunks !== message.chunks) return true;
				pending.chunks = message.chunks;
				if (!pending.parts.has(message.index)) pending.parts.set(message.index, message.text);
				if (pending.parts.size !== message.chunks) return true;
				const parts: string[] = [];
				for (let index = 0; index < message.chunks; index += 1) parts.push(pending.parts.get(index)!);
				let page: SubagentTranscriptPage | null = null;
				try { page = parseSubagentPage(JSON.parse(parts.join(""))); } catch { /* Bounded fixed failure below. */ }
				this.#finishChildRead(message.requestId, page ?? { status: "unavailable", reason: "read-failed" });
				return true;
			}
			case "omp:chat-state":
				this.#commit(applyChatState(model, message));
				return true;
			case "omp:chat-snapshot": {
				const payload = this.#assembler.begin(message);
				if (payload !== null) this.#adopt(payload);
				return true;
			}
			case "omp:chat-snapshot-chunk": {
				const payload = this.#assembler.add(message);
				if (payload !== null) this.#adopt(payload);
				return true;
			}
			case "omp:chat-event":
				this.#commit(applyChatEvent(model, message.epoch, message.frame, clock));
				return true;
			case "omp:chat-entries":
				if (sameEpoch(model.epoch, message.epoch)) this.#commit(applyChatEntries(model, message.entries, message.leafId, clock));
				return true;
			case "omp:chat-older":
				if (sameEpoch(model.epoch, message.epoch)) this.#commit(applyChatOlder(model, message.entries, message.olderCount, clock));
				return true;
			case "omp:chat-ui-request":
				// A request the page already answered (re-delivered by a replay) stays answered.
				if (sameEpoch(model.epoch, message.epoch) && !this.#answered.has(message.request.id)) {
					this.#commit(applyChatUiRequest(model, message.request));
				}
				return true;
			case "omp:chat-ui-cancel":
				if (sameEpoch(model.epoch, message.epoch)) this.#commit(applyChatUiCancel(model, message.targetId));
				return true;
			default:
				return false;
		}
	}

	/** The reset: a new generation forgets which dialogs this page answered. */
	#adopt(payload: ChatSnapshotPayload): void {
		for (const [requestId, pending] of this.#childReads) if (!sameEpoch(pending.epoch, payload.epoch)) this.#finishChildRead(requestId, { status: "unavailable", reason: "changed" });
		// A pending queue removal is not settled here: the host answers it by request id whatever the epoch did meanwhile.
		this.#answered.clear();
		this.#commit(applyChatSnapshot(this.#model, payload, { now: this.#now() }));
	}

	#refusal(): string | null {
		return chatWritable(this.#model) ? null : REFUSAL_NOT_LIVE;
	}

	#send(message: GuestWebviewMessage): ChatSendResult {
		if (this.#transport.post(message) === false) return { ok: false, reason: REFUSAL_UNREACHABLE };
		return { ok: true };
	}

	/**
	 * Send one message. A draft that would run a builtin changing the session's identity,
	 * file or process is refused here with the fixed sentence; anything else passes through
	 * as OMP itself would treat it (an unknown `/foo` is ordinary text).
	 */
	#sendText(type: "omp:chat-prompt" | "omp:chat-steer" | "omp:chat-follow-up", text: string, images?: readonly ImageContent[]): Promise<ChatSendResult> {
		if (this.#draftHandoffLocked) return Promise.resolve({ ok: false, reason: "Your input is held while this editor is being replaced." });
		const refusal = this.#refusal();
		if (refusal !== null) return Promise.resolve({ ok: false, reason: refusal });
		const verdict = classifySlashInput(text, this.#model.commands);
		if (verdict.denied) return Promise.resolve({ ok: false, reason: slashDeniedSentence(verdict.command) });
		const wire = images === undefined || images.length === 0 ? undefined : images.map(image => ({ type: "image" as const, mimeType: image.mimeType, data: image.data }));
		const requestId = this.#newRequestId();
		const base = { type, requestId, text };
		const { promise, resolve } = Promise.withResolvers<ChatSendResult>();
		const timer = setTimeout(() => this.#finishTextSend(requestId, "unconfirmed"), SEND_RESULT_TIMEOUT_MS);
		this.#textSends.set(requestId, { resolve, timer });
		try {
			if (this.#transport.post(wire === undefined ? base : { ...base, images: wire }) === false) {
				clearTimeout(timer);
				this.#textSends.delete(requestId);
				resolve({ ok: false, reason: REFUSAL_UNREACHABLE });
			}
		} catch {
			this.#finishTextSend(requestId, "unconfirmed");
		}
		return promise;
	}

	#finishTextSend(requestId: string, status: "accepted" | "refused" | "unconfirmed" | "explained"): void {
		const pending = this.#textSends.get(requestId);
		if (pending === undefined) return;
		this.#textSends.delete(requestId);
		clearTimeout(pending.timer as number);
		pending.resolve(status === "accepted" ? { ok: true } : status === "explained" ? { ok: true, explained: true } : {
			ok: false,
			reason: status === "refused" ? REFUSAL_NOT_ACCEPTED : REFUSAL_UNCONFIRMED,
			...(status === "unconfirmed" ? { unconfirmed: true } : {}),
		});
	}

	/** Start a turn (the conversation is idle). */
	sendPrompt(text: string, images?: readonly ImageContent[]): Promise<ChatSendResult> {
		return this.#sendText("omp:chat-prompt", text, images);
	}

	/** Inject a message into the running turn. */
	sendSteer(text: string, images?: readonly ImageContent[]): Promise<ChatSendResult> {
		return this.#sendText("omp:chat-steer", text, images);
	}

	/** Queue a message for after the running turn. */
	sendFollowUp(text: string, images?: readonly ImageContent[]): Promise<ChatSendResult> {
		return this.#sendText("omp:chat-follow-up", text, images);
	}

	/**
	 * Stop the running turn; the session continues. Like the TUI's Escape, the host withdraws the user's queued
	 * messages first (`abort_and_restore_queue`) so they neither run after the stop nor vanish: `onAnswer` gets them
	 * back, oldest first, whenever the host answers — the composer puts them into the draft.
	 */
	sendAbort(onAnswer?: (answer: ChatAbortAnswer) => void): ChatSendResult {
		const refusal = this.#refusal();
		if (refusal !== null) return { ok: false, reason: refusal };
		const requestId = this.#newRequestId();
		if (onAnswer !== undefined) {
			this.#aborts.set(requestId, onAnswer);
			if (this.#aborts.size > MAX_PENDING_ABORTS) this.#aborts.delete(this.#aborts.keys().next().value!);
		}
		const result = this.#send({ type: "omp:chat-abort", requestId });
		if (!result.ok) this.#aborts.delete(requestId);
		return result;
	}

	/**
	 * Rewind, Undo or switch branches in place (ADR-0051). `expectedLeafId` is the leaf the page decided on; the host
	 * and OMP both refuse a navigation made against another one. Never retried; an answer that never comes is
	 * `unconfirmed` and the next snapshot shows what happened.
	 */
	navigate(request: { kind: NavigationKind; targetId: string; expectedLeafId: string | null; summarize: boolean }): Promise<ChatNavigateAnswer> {
		const refusal = this.#refusal();
		if (refusal !== null || this.#draftHandoffLocked) return Promise.resolve({ requestId: "", status: "refused", reason: "not-live" });
		const requestId = this.#newRequestId();
		const { promise, resolve } = Promise.withResolvers<ChatNavigateAnswer>();
		const timer = setTimeout(() => {
			if (this.#navigations.delete(requestId)) resolve({ requestId, status: "unconfirmed" });
		}, NAVIGATE_RESULT_TIMEOUT_MS);
		this.#navigations.set(requestId, { resolve, timer });
		let posted: boolean | void = false;
		try {
			posted = this.#transport.post({ type: "omp:chat-navigate", requestId, ...request });
		} catch {
			posted = undefined;
		}
		if (posted === false) {
			clearTimeout(timer);
			this.#navigations.delete(requestId);
			resolve({ requestId, status: "refused", reason: "not-live" });
		}
		return promise;
	}

	/** Every navigation answer this page receives, its own or a command-palette one; the composer takes rewound prompts here. */
	subscribeNavigations(listener: (answer: ChatNavigateAnswer) => void): () => void {
		this.#navigationListeners.add(listener);
		return () => { this.#navigationListeners.delete(listener); };
	}

	/**
	 * Answer the dialog on screen, once.
	 *
	 * Only the head of the queue can be answered: a card for a dialog that has since been
	 * withdrawn or answered is stale, and answering it would settle nothing (or the wrong
	 * thing). The model pops the dialog at once, so the next queued one shows, and the id is
	 * remembered so a repeat can never reach the host.
	 */
	answerUi(response: ChatUiResponse): ChatSendResult {
		if (this.#draftHandoffLocked) return { ok: false, reason: "Your input is held while this editor is being replaced." };
		const refusal = this.#refusal();
		if (refusal !== null) return { ok: false, reason: refusal };
		const shown = this.#model.uiRequest;
		if (shown === null || shown.id !== response.id || this.#answered.has(response.id)) {
			return { ok: false, reason: "that request is no longer waiting for an answer" };
		}
		this.#answered.add(response.id);
		if (this.#answered.size > MAX_ANSWERED) {
			const oldest = this.#answered.values().next();
			if (!oldest.done) this.#answered.delete(oldest.value);
		}
		const result = this.#send({ type: "omp:chat-ui-response", requestId: this.#newRequestId(), response });
		this.#commit(applyChatUiCancel(this.#model, response.id));
		return result;
	}

	/**
	 * Ask the host for the rows above the oldest one held. Reading needs no live process,
	 * so a view-only page can page back through its history.
	 */
	loadOlder(): boolean {
		const model = this.#model;
		if (model.olderCount === 0) return false;
		const oldest = model.entries[0];
		if (oldest === undefined) return false;
		this.#transport.post({ type: "omp:chat-load-older", requestId: this.#newRequestId(), beforeId: oldest.id });
		return true;
	}

	/** Independent lazy historical read; it never changes the root transcript, composer or dialogs. */
	readSubagent(subagentId: string, options: { fromByte?: number; beforeId?: string } = {}): Promise<SubagentTranscriptPage> {
		const epoch = this.#model.epoch;
		if (epoch === null) return Promise.resolve({ status: "unavailable", reason: "not-live" });
		if (this.#childReads.size >= 16) return Promise.resolve({ status: "unavailable", reason: "read-failed" });
		const requestId = this.#newRequestId();
		const { promise, resolve } = Promise.withResolvers<SubagentTranscriptPage>();
		const timer = setTimeout(() => this.#finishChildRead(requestId, { status: "unavailable", reason: "read-failed" }), 15_000);
		this.#childReads.set(requestId, { epoch, subagentId, resolve, timer, chunks: null, parts: new Map() });
		const sent = this.#transport.post({ type: "omp:chat-subagent-read", requestId, epoch, subagentId, fromByte: options.fromByte ?? 0, ...(options.beforeId === undefined ? {} : { beforeId: options.beforeId }) });
		if (sent === false) this.#finishChildRead(requestId, { status: "unavailable", reason: "read-failed" });
		return promise;
	}

	#finishChildRead(requestId: string, page: SubagentTranscriptPage): void {
		const pending = this.#childReads.get(requestId);
		if (pending === undefined) return;
		this.#childReads.delete(requestId);
		clearTimeout(pending.timer as number);
		pending.resolve(page);
	}

	/**
	 * Act on pending messages in OMP's queue. `cancel` discards them; `edit` returns what was removed for the
	 * caller to put back in the composer; `promote` moves queued follow-ups to steering (removed = promoted).
	 * Resolves with one result per item once the host answered — a message OMP had already delivered is `gone`,
	 * a lost answer is `unknown` — and never resolves a removal as done without the host's word.
	 */
	removeQueued(purpose: ChatQueuePurpose, items: readonly ChatQueuedRef[]): Promise<ChatQueueRemoveResult> {
		if (this.#draftHandoffLocked) return Promise.resolve({ ok: false, reason: "Your input is held while this editor is being replaced." });
		const refusal = this.#refusal();
		if (refusal !== null) return Promise.resolve({ ok: false, reason: refusal });
		const epoch = this.#model.epoch;
		if (epoch === null || items.length === 0) return Promise.resolve({ ok: false, reason: REFUSAL_NOT_LIVE });
		const requestId = this.#newRequestId();
		const { promise, resolve } = Promise.withResolvers<ChatQueueRemoveResult>();
		const timer = setTimeout(() => this.#finishQueueRemoval(requestId, "unknown"), QUEUE_REMOVAL_TIMEOUT_MS);
		this.#queueRemovals.set(requestId, { epoch, purpose, items: [...items], resolve, timer });
		if (this.#transport.post({ type: "omp:chat-queue-remove", requestId, epoch, purpose, items: items.map(item => ({ queue: item.queue, text: item.text })) }) === false) {
			this.#finishQueueRemoval(requestId, "failed");
		}
		return promise;
	}

	/** Settle a removal with the host's entries (paired with the items they answer by index), or one status for every item. */
	#finishQueueRemoval(requestId: string, outcome: readonly ChatQueueResultEntry[] | "unknown" | "failed"): void {
		const pending = this.#queueRemovals.get(requestId);
		if (pending === undefined) return;
		this.#queueRemovals.delete(requestId);
		clearTimeout(pending.timer as number);
		if (outcome === "failed") {
			pending.resolve({ ok: false, reason: REFUSAL_UNREACHABLE_QUEUE });
			return;
		}
		const results = pending.items.map((item, index): ChatQueueResultItem => ({ ...item, ...(outcome === "unknown" ? { status: "unknown" as const } : (outcome[index] ?? { status: "unknown" as const })) }));
		pending.resolve({ ok: true, results });
	}

	/** The view-only tab's explicit Resume; the host runs the exact-file resume path. */
	resume(): boolean {
		if (this.#draftHandoffLocked) return false;
		if (this.#model.phase !== "view-only" && this.#model.phase !== "stopped") return false;
		this.#transport.post({ type: "omp:chat-resume", requestId: this.#newRequestId() });
		return true;
	}

	/** The failed tab's explicit Reconnect; the host re-attaches the same session in place. `false` when nothing was sent. */
	reconnect(): boolean {
		if (this.#model.phase !== "failed") return false;
		return this.#transport.post({ type: "omp:chat-reconnect", requestId: this.#newRequestId() }) !== false;
	}

	/** The host checks unanswered native state, ownership and exact saved identity before offering consent. */
	restart(): boolean {
		const epoch = this.#model.epoch;
		if (this.#draftHandoffLocked || epoch === null) return false;
		return this.#transport.post({ type: "omp:chat-restart", requestId: this.#newRequestId(), epoch }) !== false;
	}
}
