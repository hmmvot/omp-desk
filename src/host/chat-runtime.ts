/**
 * The host-owned chat runtime: one conversation per tab, attached whether or not an editor
 * is open ([ADR-0038](../../docs/decisions/0038-host-chat-over-rpc-ui-on-a-broker-pipe-child.md)).
 *
 * A conversation is one of three things:
 *
 * - **live** — a host-owned `RpcSession` over the conversation's broker channel. Its frames
 *   are folded into the shared chat model by the session itself; this module fans every
 *   output out to the pages showing the conversation and reports activity, identity and
 *   `open_url` to the extension;
 * - **view-only** — a stopped session's history read from its JSONL file, composer disabled.
 *   Nothing here claims, launches or writes for it, so it never appends `session_exit`;
 * - **legacy** — a row an earlier build's Collab host owns: a host-built page with a banner
 *   and nothing else. No transport exists.
 *
 * Pages are a separate axis: a page is one route (an editor's `postMessage` channel or its
 * authenticated bridge) that receives the conversation's `omp:chat-*` messages. Pages come
 * and go without touching the conversation, and survive a conversation being replaced
 * (view-only to live on Resume, a relaunch after Reload) — every replacement uses a fresh
 * epoch nonce, so the page accepts the new snapshot instead of discarding it as stale.
 *
 * Nothing here imports `vscode`.
 */
import { randomBytes } from "node:crypto";
import type {
	ChatEpoch,
	ChatEventFrame,
	ChatModel,
	ChatOlderPayload,
	ChatSnapshotPayload,
	ChatStatePayload,
} from "../chat/model.ts";
import { createChatModel, sameEpoch, setChatPhase, snapshotOf } from "../chat/model.ts";
import { MAX_CHAT_TEXT_LENGTH, splitChatSnapshot } from "../webview/chat-messages.ts";
import type { ChatHostMessage, ChatWebviewMessage, ChatSubagentRequestMessage, ChatDisplayPreferences, ChatQueueRemoveMessage, ChatQueueResultEntry, ChatAbortResultMessage, ChatNavigateResultMessage } from "../webview/chat-messages.ts";
import { SUBAGENT_CHUNK_CHARS, type SubagentTranscriptPage } from "../chat/subagent-transcript.ts";
import type { HistoryReader } from "./rpc/history-reader.ts";
import { SLASH_DENIED_SENTENCE, classifySlashInput } from "./rpc/protocol.ts";
import type { RpcChannel } from "./rpc/protocol.ts";
import { RpcSession, readViewOnlySnapshot } from "./rpc/session.ts";
import type { NavigateOutcome, NavigateRequest, RestoredQueue, RpcRecoveryReason, RpcSessionOptions, RpcSessionOutput, SendOutcome } from "./rpc/session.ts";
import { nativeSettingsCommand, type SettingsKind } from "../chat/settings-command.ts";
import { tuiCommandGuidance, tuiOnlyCommand, type BuiltinSlashEntry, type DeskSlashAction } from "./slash-registry.ts";

/** One route that shows a conversation. */
export interface ChatPage {
	/** Identity of the route, for detaching it. */
	readonly id: string;
	/**
	 * Deliver one host→page message. `too-large` means the route refused the message's size
	 * (the bridge's plaintext frame ceiling); the runtime then re-sends an authoritative snapshot
	 * in chunks that fit. `dropped` means the route is gone or not ready.
	 */
	post(message: ChatHostMessage): "sent" | "too-large" | "dropped";
	/** A bridge streams snapshots with backpressure rather than admitting a synchronous burst. */
	postSnapshot?(messages: Iterable<ChatHostMessage>): "sent" | "dropped";
	/** Largest JSON size of one snapshot chunk this route carries; the default suits `postMessage`. */
	readonly maxChunkBytes?: number;
	/**
	 * Why this route may not write, or `null` when it may. Read on every delivery and command, so a
	 * role change takes effect on the next message; the reason is shown as the page's `readOnlyReason`.
	 */
	readonly readOnlyReason?: () => string | null;
}

/** What the extension is told about a conversation. */
export type ChatRuntimeEvent =
	/** The live model changed. `baseline` marks attach/resync hydration, never an ordinary live history reconcile. */
	| { readonly type: "model"; readonly model: ChatModel; readonly baseline: boolean }
	/** The phase, code, identity or bounded autonomous child-exit diagnostic changed. */
	| { readonly type: "state"; readonly payload: ChatStatePayload }
	/** The identity the process serves: learned for a new session, verified for a resumed one. */
	| { readonly type: "identity"; readonly sessionFile: string; readonly sessionId: string }
	/** `open_url`: the extension shows an extension-owned confirm naming the URL. */
	| { readonly type: "open-url"; readonly url: string; readonly launchUrl?: string; readonly instructions?: string }
	/** The page asked to resume a view-only conversation. */
	| { readonly type: "resume-requested" }
	| { readonly type: "restart-requested"; readonly nativeNonce: string }
	| { readonly type: "turn-ended" }
	/** The live command catalogue changed, independently of token/model updates. */
	| { readonly type: "catalogue" }
	/** The session healed its own connection (or the page asked it to); a bounded reason for the diagnostics log. */
	| { readonly type: "recovery"; readonly reason: RpcRecoveryReason }
	/** An OMP extension reported an error (`notify` with `notifyType: "error"`); bounded, untrusted text. */
	| { readonly type: "extension-error"; readonly message: string };

/** What the caller supplies to attach a live conversation. */
export interface LiveConversationInput {
	readonly channel: RpcChannel;
	/** The exact file the process must serve; `null` for a new conversation. */
	readonly sessionFile: string | null;
	readonly cwd: string;
	readonly title: string | null;
	/** Last broker line seq already folded (0 after a host restart). */
	readonly initialSeq?: number;
}

export interface ChatRuntimeOptions {
	/** Identifies this extension-host instance in every epoch. */
	readonly hostNonce: string;
	readonly onEvent: (tabId: string, event: ChatRuntimeEvent) => void;
	/** Test seam: builds the session; defaults to {@link RpcSession}. */
	readonly createSession?: (options: RpcSessionOptions) => RpcSession;
	/** Test seam: reads the view-only snapshot; defaults to {@link readViewOnlySnapshot}. */
	readonly readViewOnly?: typeof readViewOnlySnapshot;
	/** Mints a snapshot id; defaults to 8 random bytes. */
	readonly newSnapshotId?: () => string;
	readonly readDisplayPreferences?: () => ChatDisplayPreferences;
	readonly writeToolCallDetail?: (value: ChatDisplayPreferences["toolCallDetail"]) => Promise<void>;
	/** Opens native profile settings, not an OMP prompt or a hosted dashboard. */
	readonly openSettings?: (kind: SettingsKind, tabId: string) => Promise<void>;
	/** Opens the host's native Tools output picker; resolves `undefined` when it is dismissed or the conversation is no longer current. */
	readonly pickToolCallDetail?: (
		current: ChatDisplayPreferences["toolCallDetail"],
		stillCurrent: () => boolean,
		tabId: string,
	) => Promise<ChatDisplayPreferences["toolCallDetail"] | undefined>;
	/** The installed OMP's builtin slash registry, or `null` while it is unknown (nothing is refused as TUI-only then). */
	readonly slashRegistry?: () => readonly BuiltinSlashEntry[] | null;
	/** Runs the Desk equivalent of a terminal-UI slash command. */
	readonly runDeskAction?: (action: DeskSlashAction, tabId: string) => Promise<void>;
}

/**
 * The outcome of one page command, for a route that answers its own request ledger. `explained` is a refusal
 * the asking route was already told about in one line, so it shows no second, generic refusal.
 */
export type ChatCommandOutcome = "accepted" | "refused" | "explained" | "unconfirmed" | "ignored";

/** Bounded sentences the page is told when the host refuses or cannot confirm a command. */
export const CHAT_NOT_LIVE_SENTENCE = "This conversation is not accepting input right now.";
export const CHAT_ALREADY_RUNNING_SENTENCE = "This session is already running or starting; there is nothing to resume.";
export const CHAT_BUSY_SENTENCE = "OMP is busy with another request; try again in a moment.";
export const CHAT_REJECTED_SENTENCE = "OMP did not accept that.";
export const CHAT_UNCONFIRMED_SENTENCE =
	"The message may not have been delivered; check the transcript before sending it again.";
export const CHAT_CHOICE_FAILED_SENTENCE = "Your model or thinking change could not be applied, so the message was not sent. Check the footer, then send it again.";
export const CHAT_PROMPT_LOST_SENTENCE = "The last message was not delivered — send it again manually.";

interface Conversation {
	readonly tabId: string;
	readonly nonce: string;
	readonly kind: "live" | "view-only" | "legacy";
	readonly session: RpcSession | null;
	unsubscribe: (() => void) | null;
	/** The static conversation's own epoch counter and snapshot. */
	counter: number;
	snapshot: ChatSnapshotPayload | null;
	state: ChatStatePayload | null;
	reader: HistoryReader | null;
	/** Attach/resync requested a silent notification baseline; the next model consumes it. */
	baselinePending: boolean;
	readonly cwd: string;
	title: string | null;
	disposed: boolean;
}

export class ChatRuntime {
	readonly #options: ChatRuntimeOptions;
	readonly #conversations = new Map<string, Conversation>();
	readonly #pages = new Map<string, Map<string, ChatPage>>();
	#generation = 0;
	readonly #settingsRequests = new Map<string, Promise<ChatCommandOutcome>>();

	constructor(options: ChatRuntimeOptions) {
		this.#options = options;
	}

	/** Whether a conversation of any kind exists for the tab. */
	has(tabId: string): boolean {
		return this.#conversations.has(tabId);
	}

	kindOf(tabId: string): "live" | "view-only" | "legacy" | null {
		return this.#conversations.get(tabId)?.kind ?? null;
	}

	/** The live session of a tab, or `null` for a view-only, legacy or unknown conversation. */
	sessionOf(tabId: string): RpcSession | null {
		return this.#conversations.get(tabId)?.session ?? null;
	}

	/** The live chat model of a tab, or `null` when it has no live session. */
	modelOf(tabId: string): ChatModel | null {
		return this.#conversations.get(tabId)?.session?.model ?? null;
	}

	/** The current state payload of a conversation (any kind), or `null` when none exists. */
	stateOf(tabId: string): ChatStatePayload | null {
		const conversation = this.#conversations.get(tabId);
		if (conversation === undefined) return null;
		return conversation.session === null ? conversation.state : statePayloadOf(conversation.session);
	}

	/**
	 * Attach a live conversation over one broker channel.
	 *
	 * Any previous conversation of the tab is dropped first (its process is untouched); the
	 * pages showing the tab stay attached and receive the new conversation's epoch.
	 */
	startLive(tabId: string, input: LiveConversationInput): RpcSession {
		this.#drop(tabId);
		const nonce = this.#nextNonce();
		const create = this.#options.createSession ?? ((options: RpcSessionOptions) => new RpcSession(options));
		const session = create({
			channel: input.channel,
			sessionFile: input.sessionFile,
			cwd: input.cwd,
			hostNonce: nonce,
			...(input.initialSeq === undefined ? {} : { initialSeq: input.initialSeq }),
		});
		const conversation: Conversation = {
			tabId,
			nonce,
			kind: "live",
			session,
			unsubscribe: null,
			counter: 0,
			snapshot: null,
			state: null,
			reader: null,
			baselinePending: false,
			cwd: input.cwd,
			title: input.title,
			disposed: false,
		};
		conversation.unsubscribe = session.subscribe(output => this.#onOutput(conversation, output));
		this.#conversations.set(tabId, conversation);
		void session.start();
		return session;
	}

	/**
	 * Show a stopped session's history read-only. Never claims, launches or writes.
	 *
	 * A history that cannot be read is a visible failed state, never a shortened transcript.
	 */
	async showViewOnly(
		tabId: string,
		input: { readonly file: string | null; readonly cwd: string; readonly title: string | null; readonly reason: string; readonly phase?: "view-only" | "blocked" | "resyncing" },
	): Promise<void> {
		this.#drop(tabId);
		const nonce = this.#nextNonce();
		const epoch: ChatEpoch = { nonce, counter: 1 };
		const conversation = this.#staticConversation(tabId, "view-only", nonce, input.cwd, input.title);
		this.#conversations.set(tabId, conversation);
		if (input.file === null) {
			this.#setStaticModel(conversation, epoch, setChatPhase(createChatModel(), input.phase ?? "view-only", null, input.reason));
			this.#broadcastStatic(conversation);
			return;
		}
		const read = this.#options.readViewOnly ?? readViewOnlySnapshot;
		try {
			const { snapshot, reader } = await read(input.file, epoch, input.reason);
			if (conversation.disposed) return;
			conversation.reader = reader;
			const phase = input.phase ?? "view-only";
			conversation.snapshot = { ...snapshot, phase };
			conversation.state = {
				epoch,
				phase,
				code: null,
				sessionId: snapshot.header?.id ?? null,
				cwd: snapshot.header?.cwd ?? input.cwd,
				title: input.title ?? snapshot.header?.title ?? null,
				readOnlyReason: input.reason,
			};
		} catch {
			if (conversation.disposed) return;
			this.#setStaticModel(conversation, epoch, setChatPhase(createChatModel(), "failed", "history-unreadable", "history-unreadable"));
		}
		this.#broadcastStatic(conversation);
	}

	/** Show the banner-only page of a row an earlier build's host owns. */
	showLegacy(tabId: string, input: { readonly cwd: string; readonly title: string | null; readonly reason: string }): void {
		this.#drop(tabId);
		const nonce = this.#nextNonce();
		const epoch: ChatEpoch = { nonce, counter: 1 };
		const conversation = this.#staticConversation(tabId, "legacy", nonce, input.cwd, input.title);
		this.#conversations.set(tabId, conversation);
		this.#setStaticModel(conversation, epoch, setChatPhase(createChatModel(), "legacy", null, input.reason));
		this.#broadcastStatic(conversation);
	}

	/**
	 * Drop a tab's conversation: the session stops reading and its connection closes. The child
	 * process is untouched. Pages stay attached and show nothing until the next conversation.
	 */
	release(tabId: string): void {
		this.#drop(tabId);
	}

	dispose(): void {
		for (const tabId of [...this.#conversations.keys()]) this.#drop(tabId);
		this.#pages.clear();
	}

	/**
	 * Attach one route to a tab's conversation and send it the current state and snapshot.
	 * Attaching the same route id again replaces it and re-sends (a reloaded document).
	 */
	attachPage(tabId: string, attached: ChatPage): () => void {
		let pages = this.#pages.get(tabId);
		if (pages === undefined) {
			pages = new Map();
			this.#pages.set(tabId, pages);
		}
		const page = withReadOnlyOverlay(attached);
		pages.set(page.id, page);
		this.resend(tabId, page.id);
		return () => {
			const current = this.#pages.get(tabId);
			if (current?.get(page.id) === page) current.delete(page.id);
			if (current !== undefined && current.size === 0) this.#pages.delete(tabId);
		};
	}

	/** Whether any route is attached to a tab. */
	hasPage(tabId: string): boolean {
		return (this.#pages.get(tabId)?.size ?? 0) > 0;
	}

	/** Re-send the state and an authoritative snapshot to one route (`omp:ready`, a route ack, a rebind). */
	resend(tabId: string, pageId: string): void {
		const page = this.#pages.get(tabId)?.get(pageId);
		const conversation = this.#conversations.get(tabId);
		if (page === undefined || conversation === undefined) return;
		const state = this.stateOf(tabId);
		if (state !== null) page.post({ type: "omp:chat-state", ...state });
		const snapshot = conversation.session === null ? conversation.snapshot : conversation.session.snapshot();
		if (snapshot !== null) this.#sendSnapshot(conversation, page, snapshot);
		if (snapshot === null && state !== null) page.post({ type: "omp:chat-display-preferences", epoch: state.epoch, ...this.#displayPreferences() });
	}

	#displayPreferences(): ChatDisplayPreferences {
		return this.#options.readDisplayPreferences?.() ?? { toolCallDetail: "overview", accessibilitySupport: false };
	}

	/** Global configuration changes update every attached route, without replacing chat data. */
	refreshDisplayPreferences(): void {
		const preferences = this.#displayPreferences();
		for (const [tabId, pages] of this.#pages) {
			const state = this.stateOf(tabId);
			if (state !== null) for (const page of pages.values()) page.post({ type: "omp:chat-display-preferences", epoch: state.epoch, ...preferences });
		}
	}

	/**
	 * Run one page command against the tab's conversation.
	 *
	 * Idempotence is the session's: every mutation carries the page's `requestId` (the rpc
	 * command id is `vsc:<requestId>`), and a repeat returns the first outcome without a second
	 * write on either route. `origin` is the route that asked, which alone is told of a refusal.
	 * Read-only routes may page history or explicitly request admission to Open a view-only
	 * conversation; they may never write to a running session.
	 */
	async handleMessage(tabId: string, message: ChatWebviewMessage, origin: ChatPage | null): Promise<ChatCommandOutcome> {
		const conversation = this.#conversations.get(tabId);
		if (conversation === undefined) {
			// A stopped session whose conversation was released still shows its Resume button; the
			// request is the extension's to admit (claim checks, one writer), and it reports the outcome.
			if (message.type === "omp:chat-resume") {
				this.#options.onEvent(tabId, { type: "resume-requested" });
				return "accepted";
			}
			return "ignored";
		}
		if (message.type === "omp:chat-prompt" || message.type === "omp:chat-steer" || message.type === "omp:chat-follow-up") {
			const kind = nativeSettingsCommand(message.text);
			if (kind !== null) {
				const key = `${tabId}:${message.requestId}`;
				const previous = this.#settingsRequests.get(key);
				if (previous) return previous;
				const operation = (async (): Promise<ChatCommandOutcome> => {
					if (!this.#options.openSettings) { this.#tell(conversation, origin, "Native OMP settings are unavailable in this host."); return "refused"; }
					try { await this.#options.openSettings(kind, tabId); return "accepted"; }
					catch { this.#tell(conversation, origin, "Could not open native OMP settings."); return "refused"; }
				})();
				this.#settingsRequests.set(key, operation);
				if (this.#settingsRequests.size > 128) this.#settingsRequests.delete(this.#settingsRequests.keys().next().value!);
				return operation;
			}
		}
		if (message.type === "omp:chat-tool-detail") {
			if (origin === null || !sameEpoch(this.stateOf(tabId)?.epoch ?? null, message.epoch)) return "ignored";
			const { pickToolCallDetail, writeToolCallDetail } = this.#options;
			if (!pickToolCallDetail || !writeToolCallDetail) return "refused";
			// The host owns the choice end to end: the page only asked, and the setting is written from the host's own pick.
			// Closing the picker or leaving the conversation while it is open changes nothing.
			const stillCurrent = (): boolean => this.#conversations.get(tabId) === conversation && sameEpoch(this.stateOf(tabId)?.epoch ?? null, message.epoch);
			let picked: ChatDisplayPreferences["toolCallDetail"] | undefined;
			try { picked = await pickToolCallDetail(this.#displayPreferences().toolCallDetail, stillCurrent, tabId); }
			catch { this.#tell(conversation, origin, "Could not open the Tools output picker."); return "refused"; }
			if (picked === undefined) return "ignored";
			try { await writeToolCallDetail(picked); }
			catch { this.#tell(conversation, origin, "Could not save the Tools display preference."); return "refused"; }
			this.refreshDisplayPreferences();
			return "accepted";
		}
		// A session that is not running — a view-only history or one whose process stopped — has an
		// explicit Resume that requests the extension's claim-and-launch admission. It grants no
		// authority over a running session, so it is not gated on the route being writable.
		const phase = this.stateOf(tabId)?.phase ?? null;
		const resuming = message.type === "omp:chat-resume" && (phase === "view-only" || phase === "stopped");
		const readOnly = origin?.readOnlyReason?.() ?? null;
		if (readOnly !== null && message.type !== "omp:chat-load-older" && message.type !== "omp:chat-subagent-read" && !resuming) {
			if (message.type === "omp:chat-queue-remove") this.#failQueueRemove(message, origin);
			if (message.type === "omp:chat-navigate") this.#answerNavigate(origin, message.requestId, { status: "refused", reason: "not-live" });
			this.#tell(conversation, origin, readOnly);
			return "refused";
		}
		if (message.type === "omp:chat-resume") {
			if (!resuming) {
				// Never silent: a request that cannot resume says why.
				this.#tell(conversation, origin, phase === "live" || phase === "starting" || phase === "attaching" || phase === "resyncing"
					? CHAT_ALREADY_RUNNING_SENTENCE
					: this.stateOf(tabId)?.readOnlyReason ?? CHAT_NOT_LIVE_SENTENCE);
				return "refused";
			}
			this.#options.onEvent(tabId, { type: "resume-requested" });
			return "accepted";
		}
		if (message.type === "omp:chat-load-older") {
			await this.#serveLoadOlder(conversation, message.beforeId, origin);
			return "accepted";
		}
		if (message.type === "omp:chat-subagent-read") {
			await this.#serveSubagent(conversation, message, origin);
			return "accepted";
		}
		const session = conversation.session;
		if (message.type === "omp:chat-restart") {
			if (session === null || !session.nativeStateUnanswered || session.epoch.nonce !== message.epoch.nonce) {
				this.#tell(conversation, origin, "Restart is unavailable: this native session has not been shown to leave state requests unanswered.");
				return "refused";
			}
			this.#options.onEvent(tabId, { type: "restart-requested", nativeNonce: message.epoch.nonce });
			return "accepted";
		}
		if (session === null) {
			if (message.type === "omp:chat-queue-remove") this.#failQueueRemove(message, origin);
			if (message.type === "omp:chat-navigate") this.#answerNavigate(origin, message.requestId, { status: "refused", reason: "not-live" });
			this.#tell(conversation, origin, CHAT_NOT_LIVE_SENTENCE);
			return "refused";
		}
		if (message.type === "omp:chat-prompt" || message.type === "omp:chat-steer" || message.type === "omp:chat-follow-up") {
			// An identity-changing builtin keeps its own refusal (the session's); every other TUI-only builtin is answered here.
			const command = classifySlashInput(message.text, session.model.commands).denied ? null : tuiOnlyCommand(message.text, this.#options.slashRegistry?.() ?? null, session.model.commands);
			if (command !== null) return this.#serveTuiCommand(conversation, origin, `${tabId}:${message.requestId}`, command);
		}
		switch (message.type) {
			case "omp:chat-prompt":
				return this.#settle(conversation, origin, await session.prompt({ requestId: message.requestId, text: message.text, ...(message.images === undefined ? {} : { images: message.images }) }));
			case "omp:chat-steer":
				return this.#settle(conversation, origin, await session.steer({ requestId: message.requestId, text: message.text, ...(message.images === undefined ? {} : { images: message.images }) }));
			case "omp:chat-follow-up":
				return this.#settle(conversation, origin, await session.followUp({ requestId: message.requestId, text: message.text, ...(message.images === undefined ? {} : { images: message.images }) }));
			case "omp:chat-abort": {
				const epoch = session.epoch;
				const outcome = await session.abortAndRestore(message.requestId);
				if (conversation.disposed) return "ignored";
				this.#answerAbort(origin, epoch, message.requestId, outcome.status === "accepted" ? outcome.restored : outcome.status);
				return this.#settle(conversation, origin, outcome.status === "accepted" ? { status: "accepted", agentInvoked: null } : outcome);
			}
			case "omp:chat-queue-remove":
				return await this.#serveQueueRemove(conversation, session, message, origin);
			case "omp:chat-ui-response":
				return (await session.respondUi(message.response)) ? "accepted" : "refused";
			case "omp:chat-reconnect":
				if (session.reconnect() === "refused") {
					this.#tell(conversation, origin, CHAT_NOT_LIVE_SENTENCE);
					return "refused";
				}
				return "accepted";
			case "omp:chat-navigate": {
				const outcome = await this.navigate(tabId, { requestId: message.requestId, kind: message.kind, targetId: message.targetId, expectedLeafId: message.expectedLeafId, summarize: message.summarize }, origin);
				return outcome.status === "done" ? "accepted" : outcome.status;
			}
		}
	}

	#nextNonce(): string {
		this.#generation += 1;
		return `${this.#options.hostNonce}-${this.#generation}`;
	}

	#staticConversation(
		tabId: string,
		kind: "view-only" | "legacy",
		nonce: string,
		cwd: string,
		title: string | null,
	): Conversation {
		return {
			tabId,
			nonce,
			kind,
			session: null,
			unsubscribe: null,
			counter: 1,
			snapshot: null,
			state: null,
			reader: null,
			baselinePending: false,
			cwd,
			title,
			disposed: false,
		};
	}

	#setStaticModel(conversation: Conversation, epoch: ChatEpoch, model: ChatModel): void {
		conversation.snapshot = snapshotOf(model, epoch);
		conversation.state = {
			epoch,
			phase: model.phase,
			code: model.code,
			sessionId: null,
			cwd: conversation.cwd,
			title: conversation.title,
			readOnlyReason: model.readOnlyReason,
		};
	}

	#broadcastStatic(conversation: Conversation): void {
		const pages = this.#pages.get(conversation.tabId);
		if (pages === undefined) return;
		for (const page of [...pages.values()]) this.resend(conversation.tabId, page.id);
		if (conversation.state !== null) this.#options.onEvent(conversation.tabId, { type: "state", payload: conversation.state });
	}

	#drop(tabId: string): void {
		const existing = this.#conversations.get(tabId);
		if (existing === undefined) return;
		existing.disposed = true;
		existing.unsubscribe?.();
		existing.session?.dispose();
		this.#conversations.delete(tabId);
	}

	#onOutput(conversation: Conversation, output: RpcSessionOutput): void {
		if (conversation.disposed) return;
		const tabId = conversation.tabId;
		switch (output.type) {
			case "state":
				this.#broadcast(conversation, { type: "omp:chat-state", ...output.payload });
				this.#broadcast(conversation, { type: "omp:chat-display-preferences", epoch: output.payload.epoch, ...this.#displayPreferences() });
				this.#options.onEvent(tabId, { type: "state", payload: output.payload });
				return;
			case "snapshot":
				if (output.baseline) conversation.baselinePending = true;
				for (const page of this.#pageList(tabId)) this.#sendSnapshot(conversation, page, output.payload);
				return;
			case "event":
				this.#broadcastEvent(conversation, { type: "omp:chat-event", epoch: output.epoch, frame: output.frame });
				if (output.frame.type === "agent_end") this.#options.onEvent(tabId, { type: "turn-ended" });
				if (output.frame.type === "available_commands_update") this.#options.onEvent(tabId, { type: "catalogue" });
				return;
			case "entries":
				this.#broadcast(conversation, { type: "omp:chat-entries", ...output.payload });
				return;
			case "ui-request":
				this.#broadcast(conversation, { type: "omp:chat-ui-request", epoch: output.epoch, request: output.request });
				return;
			case "ui-cancel":
				this.#broadcast(conversation, { type: "omp:chat-ui-cancel", epoch: output.epoch, targetId: output.targetId });
				return;
			case "open-url":
				this.#options.onEvent(tabId, {
					type: "open-url",
					url: output.url,
					...(output.launchUrl === undefined ? {} : { launchUrl: output.launchUrl }),
					...(output.instructions === undefined ? {} : { instructions: output.instructions }),
				});
				return;
			case "identity":
				this.#options.onEvent(tabId, { type: "identity", sessionFile: output.sessionFile, sessionId: output.sessionId });
				return;
			case "prompt-lost":
				this.#tellAll(conversation, CHAT_PROMPT_LOST_SENTENCE);
				return;
			case "late-response":
				return;
			case "prompt-result":
				return;
			case "recovery":
				this.#options.onEvent(tabId, { type: "recovery", reason: output.reason });
				return;
			case "extension-error":
				this.#options.onEvent(tabId, { type: "extension-error", message: output.message });
				return;
			case "model": {
				const baseline = conversation.baselinePending;
				conversation.baselinePending = false;
				this.#options.onEvent(tabId, { type: "model", model: output.model, baseline });
				return;
			}
		}
	}

	#pageList(tabId: string): ChatPage[] {
		return [...(this.#pages.get(tabId)?.values() ?? [])];
	}

	#broadcast(conversation: Conversation, message: ChatHostMessage): void {
		for (const page of this.#pageList(conversation.tabId)) this.#deliver(conversation, page, message);
	}

	#broadcastEvent(conversation: Conversation, message: ChatHostMessage): void {
		this.#broadcast(conversation, message);
	}

	#deliver(conversation: Conversation, page: ChatPage, message: ChatHostMessage): void {
		const result = page.post(message);
		if (result !== "too-large") return;
		// A message the route cannot carry is replaced by an authoritative snapshot in chunks
		// that fit: the page never misses the state the message would have changed.
		const snapshot = conversation.session === null ? conversation.snapshot : conversation.session.snapshot();
		if (snapshot !== null) this.#sendSnapshot(conversation, page, snapshot);
	}

	#sendSnapshot(conversation: Conversation, page: ChatPage, payload: ChatSnapshotPayload): void {
		const snapshotId = (this.#options.newSnapshotId ?? defaultSnapshotId)();
		const split =
			page.maxChunkBytes === undefined
				? splitChatSnapshot(payload, snapshotId)
				: splitChatSnapshot(payload, snapshotId, page.maxChunkBytes);
		if (page.postSnapshot !== undefined) {
			const preferences = this.#displayPreferences();
			page.postSnapshot((function* () {
				yield split.snapshot;
				yield* split.chunks;
				yield { type: "omp:chat-display-preferences", epoch: payload.epoch, ...preferences };
			})());
			return;
		}
		if (page.post(split.snapshot) !== "sent") return;
		for (const chunk of split.chunks) {
			if (page.post(chunk) !== "sent") return;
		}
		page.post({ type: "omp:chat-display-preferences", epoch: payload.epoch, ...this.#displayPreferences() });
		void conversation;
	}

	async #serveLoadOlder(conversation: Conversation, beforeId: string, origin: ChatPage | null): Promise<void> {
		let older: ChatOlderPayload | null = null;
		if (conversation.session !== null) {
			older = await conversation.session.loadOlder(beforeId);
		} else if (conversation.reader !== null && conversation.snapshot !== null) {
			try {
				const result = await conversation.reader.loadOlder(beforeId);
				older = {
					epoch: conversation.snapshot.epoch,
					entries: result.entries,
					olderCount: result.olderCount,
				};
			} catch {
				older = null;
			}
		}
		if (conversation.disposed || origin === null) return;
		if (older !== null) {
			this.#deliver(conversation, origin, { type: "omp:chat-older", ...older });
			return;
		}
		// The rows above could not be served: the page's window is out of step with the
		// file, so it is reset to an authoritative snapshot instead of left stuck.
		const snapshot = conversation.session === null ? conversation.snapshot : conversation.session.snapshot();
		if (snapshot !== null) this.#sendSnapshot(conversation, origin, snapshot);
	}

	async #serveSubagent(conversation: Conversation, request: ChatSubagentRequestMessage, origin: ChatPage | null): Promise<void> {
		if (origin === null) return;
		const session = conversation.session;
		const epoch = session?.epoch ?? conversation.snapshot?.epoch ?? null;
		let page: SubagentTranscriptPage = { status: "unavailable", reason: "not-live" };
		if (!sameEpoch(epoch, request.epoch)) page = { status: "unavailable", reason: "changed" };
		else if (session !== null) page = await session.subagentMessages(request.subagentId, request.fromByte, request.beforeId);
		if (conversation.disposed) return;
		const chars = Math.max(1, Math.min(SUBAGENT_CHUNK_CHARS, Math.floor(((origin.maxChunkBytes ?? 256 * 1024) - 2048) / 6)));
		let text = JSON.stringify(page);
		if (Math.ceil(text.length / chars) > 1024) text = JSON.stringify({ status: "unavailable", reason: "read-failed" });
		const chunks = Math.max(1, Math.ceil(text.length / chars));
		for (let index = 0; index < chunks; index += 1) {
			if (origin.post({ type: "omp:chat-subagent-chunk", epoch: request.epoch, requestId: request.requestId, subagentId: request.subagentId, index, chunks, text: text.slice(index * chars, (index + 1) * chars) }) !== "sent") return;
		}
	}

	/**
	 * Take queued messages out of OMP's queues for the page that asked and answer that page — only it — with one
	 * entry per item, by request index (the result repeats no message text, so it stays small on every route).
	 * The answer carries the request's own epoch and the page matches it by request id: an epoch that moved
	 * while the command ran (any reconcile does that) never makes the page discard a removal OMP confirmed.
	 * An oversized answer is resent without its images, flagged; when the asking route cannot take it at all
	 * the command is reported `unconfirmed` (logged by the extension), never `accepted`.
	 */
	async #serveQueueRemove(conversation: Conversation, session: RpcSession, message: ChatQueueRemoveMessage, origin: ChatPage | null): Promise<ChatCommandOutcome> {
		if (!sameEpoch(session.epoch, message.epoch)) {
			this.#failQueueRemove(message, origin);
			return "ignored";
		}
		const outcome = message.purpose === "promote" ? await session.promoteQueued(message.requestId, message.items) : await session.removeQueued(message.requestId, message.items);
		if (conversation.disposed) return "ignored";
		if (outcome.status === "refused") {
			const settled = this.#settle(conversation, origin, { status: "refused", reason: outcome.reason });
			this.#failQueueRemove(message, origin);
			return settled;
		}
		const results = outcome.removals.map((removal): ChatQueueResultEntry => {
			if (removal.status !== "removed") return { status: removal.status };
			if (message.purpose !== "edit") return { status: "removed" };
			return {
				status: "removed",
				...(removal.images.length > 0 ? { images: removal.images.map(image => ({ type: image.type, mimeType: image.mimeType, data: image.data })) } : {}),
				...(removal.imagesDropped ? { imagesDropped: true as const } : {}),
			};
		});
		const delivered = this.#answerQueueRemove(message, origin, results);
		if (!delivered || results.some(result => result.status === "unknown")) return "unconfirmed";
		return "accepted";
	}

	/** Every item of a removal that never reached OMP: still queued, said so to the page that asked. */
	#failQueueRemove(message: ChatQueueRemoveMessage, origin: ChatPage | null): void {
		this.#answerQueueRemove(message, origin, message.items.map((): ChatQueueResultEntry => ({ status: "failed" })));
	}

	#answerQueueRemove(message: ChatQueueRemoveMessage, origin: ChatPage | null, results: ChatQueueResultEntry[]): boolean {
		if (origin === null) return false;
		const answer = (list: ChatQueueResultEntry[]): ChatHostMessage => ({ type: "omp:chat-queue-result", epoch: message.epoch, requestId: message.requestId, purpose: message.purpose, results: list });
		let sent = origin.post(answer(results));
		if (sent === "too-large") {
			const stripped = results.map((result): ChatQueueResultEntry => (result.status === "removed" && result.images !== undefined ? { status: "removed", imagesDropped: true } : result));
			sent = origin.post(answer(stripped));
		}
		return sent === "sent";
	}

	/**
	 * Run one in-place navigation (ADR-0051) for a page or the command palette. The answer goes to the page that
	 * asked. A navigation without a page (the command palette) needs a writable route showing the tab — the same gate
	 * a page's own request passes in `handleMessage` — and is told to every writable route, so the controlling
	 * editor's composer receives a rewound prompt; read-only routes see the result in the transcript only.
	 */
	async navigate(tabId: string, request: NavigateRequest, origin: ChatPage | null): Promise<NavigateOutcome> {
		const conversation = this.#conversations.get(tabId);
		const session = conversation?.kind === "live" ? conversation.session : null;
		const routes = origin === null ? this.#pageList(tabId).filter(page => (page.readOnlyReason?.() ?? null) === null) : [origin];
		const outcome: NavigateOutcome = session === null || conversation === undefined
			? { status: "refused", reason: "not-live" }
			: routes.length === 0 ? { status: "refused", reason: "not-owner" } : await session.navigate(request);
		if (conversation === undefined || conversation.disposed) return outcome;
		for (const page of routes) this.#answerNavigate(page, request.requestId, outcome);
		return outcome;
	}

	/** The outcome for one route; a draft the route cannot carry is resent without its images, flagged. */
	#answerNavigate(origin: ChatPage | null, requestId: string, outcome: NavigateOutcome): void {
		if (origin === null) return;
		if (outcome.status !== "done") {
			origin.post({ type: "omp:chat-navigate-result", requestId, status: outcome.status, ...(outcome.status === "refused" ? { reason: outcome.reason } : {}) });
			return;
		}
		const base: ChatNavigateResultMessage = { type: "omp:chat-navigate-result", requestId, status: "done", kind: outcome.kind, summarized: outcome.summarized, ...(outcome.raced ? { raced: true as const } : {}) };
		const draft = outcome.draft;
		if (draft === null) { origin.post(base); return; }
		const text = draft.text.slice(0, MAX_CHAT_TEXT_LENGTH);
		const full: ChatNavigateResultMessage = { ...base, draft: { text, images: draft.images.slice(0, 8).map(image => ({ type: image.type, mimeType: image.mimeType, data: image.data })), unavailableImages: draft.unavailableImages + Math.max(0, draft.images.length - 8) } };
		if (origin.post(full) !== "too-large") return;
		origin.post({ ...base, draft: { text, images: [], unavailableImages: draft.unavailableImages + draft.images.length } });
	}

	/**
	 * Tell the route that stopped the turn what `abort_and_restore_queue` handed back, so its composer can put the
	 * withdrawn messages into the draft. An answer the route cannot carry is resent without images, then with an
	 * oldest-first prefix of the texts, flagged either way: withdrawn text is never dropped silently.
	 */
	#answerAbort(origin: ChatPage | null, epoch: ChatEpoch, requestId: string, restored: RestoredQueue | "refused" | "unconfirmed"): void {
		if (origin === null) return;
		const base = { type: "omp:chat-abort-result" as const, epoch, requestId };
		if (typeof restored === "string") { origin.post({ ...base, status: restored, entries: [] }); return; }
		const answer = (entries: ChatAbortResultMessage["entries"], imagesDropped: boolean, truncated: boolean): ChatAbortResultMessage =>
			({ ...base, status: "accepted", entries, ...(imagesDropped ? { imagesDropped: true as const } : {}), ...(truncated ? { truncated: true as const } : {}) });
		const clipped = restored.entries.some(entry => entry.text.length > MAX_CHAT_TEXT_LENGTH);
		const full = restored.entries.map(entry => ({ text: entry.text.slice(0, MAX_CHAT_TEXT_LENGTH), ...(entry.images.length > 0 ? { images: entry.images.map(image => ({ type: image.type, mimeType: image.mimeType, data: image.data })) } : {}) }));
		if (origin.post(answer(full, restored.imagesDropped, restored.truncated || clipped)) !== "too-large") return;
		const texts = full.map(entry => ({ text: entry.text }));
		const imagesDropped = restored.imagesDropped || restored.entries.some(entry => entry.images.length > 0);
		for (let count = texts.length; count >= 0; count = count === 0 ? -1 : Math.floor(count / 2)) {
			if (origin.post(answer(texts.slice(0, count), imagesDropped, restored.truncated || clipped || count < texts.length)) !== "too-large") return;
		}
	}

	/** A terminal-UI builtin typed into Chat: never sent to OMP. Its Desk equivalent runs when there is one. Once per request. */
	#serveTuiCommand(conversation: Conversation, origin: ChatPage | null, key: string, command: string): Promise<ChatCommandOutcome> {
		const previous = this.#settingsRequests.get(key);
		if (previous) return previous;
		const guidance = tuiCommandGuidance(command);
		const operation = (async (): Promise<ChatCommandOutcome> => {
			const run = this.#options.runDeskAction;
			if (guidance.action === undefined || run === undefined) {
				this.#tell(conversation, origin, guidance.action === undefined ? guidance.line : `/${guidance.command} works only in OMP's terminal UI and was not sent.`);
				return "explained";
			}
			try { await run(guidance.action, conversation.tabId); }
			catch {
				this.#tell(conversation, origin, `/${guidance.command} was not sent, and its Desk equivalent could not be opened.`);
				return "explained";
			}
			this.#tell(conversation, origin, guidance.line);
			return "explained";
		})();
		this.#settingsRequests.set(key, operation);
		if (this.#settingsRequests.size > 128) this.#settingsRequests.delete(this.#settingsRequests.keys().next().value!);
		return operation;
	}

	#settle(conversation: Conversation, origin: ChatPage | null, outcome: SendOutcome): ChatCommandOutcome {
		if (outcome.status === "accepted") return "accepted";
		if (outcome.status === "unconfirmed") {
			this.#tell(conversation, origin, CHAT_UNCONFIRMED_SENTENCE);
			return "unconfirmed";
		}
		switch (outcome.reason) {
			case "slash-denied":
				this.#tell(conversation, origin, SLASH_DENIED_SENTENCE);
				break;
			case "not-live":
			case "not-owner":
				this.#tell(conversation, origin, CHAT_NOT_LIVE_SENTENCE);
				break;
			case "busy":
				this.#tell(conversation, origin, CHAT_BUSY_SENTENCE);
				break;
			case "choice-failed":
				this.#tell(conversation, origin, CHAT_CHOICE_FAILED_SENTENCE);
				break;
			case "bad-request-id":
				break;
			default:
				this.#tell(conversation, origin, CHAT_REJECTED_SENTENCE);
		}
		return "refused";
	}

	#epochOf(conversation: Conversation): ChatEpoch | null {
		if (conversation.session !== null) return conversation.session.epoch;
		return conversation.snapshot?.epoch ?? null;
	}

	#feedbackMessage(conversation: Conversation, text: string): ChatHostMessage | null {
		const epoch = this.#epochOf(conversation);
		if (epoch === null) return null;
		const frame: ChatEventFrame = { type: "command_feedback", message: text };
		return { type: "omp:chat-event", epoch, frame };
	}

	/** A fixed sentence for the route that asked. */
	#tell(conversation: Conversation, origin: ChatPage | null, text: string): void {
		if (origin === null) return;
		const message = this.#feedbackMessage(conversation, text);
		if (message !== null) origin.post(message);
	}

	/**
	 * Tell every route showing a tab's conversation one sentence in its footer feedback. Returns
	 * whether there was a conversation to tell: the extension reports the outcome of an action the
	 * page asked for (Resume) this way, so a refusal is never silent.
	 */
	notify(tabId: string, text: string): boolean {
		const conversation = this.#conversations.get(tabId);
		if (conversation === undefined) return false;
		const message = this.#feedbackMessage(conversation, text);
		if (message === null) return false;
		this.#broadcast(conversation, message);
		return true;
	}

	/** A fixed sentence for every route showing the conversation. */
	#tellAll(conversation: Conversation, text: string): void {
		const message = this.#feedbackMessage(conversation, text);
		if (message !== null) this.#broadcast(conversation, message);
	}
}

function statePayloadOf(session: RpcSession): ChatStatePayload {
	const model = session.model;
	return {
		epoch: session.epoch,
		phase: model.phase,
		code: model.code,
		sessionId: session.sessionId,
		cwd: model.header?.cwd ?? null,
		title: model.state?.sessionName ?? model.header?.title ?? null,
		readOnlyReason: model.readOnlyReason,
	};
}

function defaultSnapshotId(): string {
	return randomBytes(8).toString("hex");
}

/**
 * A route the extension may mark read-only shows the conversation's state and snapshot with the
 * route's own reason as `readOnlyReason`, so its composer is disabled and says why, while the
 * conversation itself (and every other route showing it) is unchanged.
 */
function withReadOnlyOverlay(page: ChatPage): ChatPage {
	const reasonOf = page.readOnlyReason;
	if (reasonOf === undefined) return page;
	return {
		...page,
		...(page.postSnapshot === undefined ? {} : {
			postSnapshot: (messages: Iterable<ChatHostMessage>) => page.postSnapshot!((function* () {
				for (const message of messages) {
					const reason = reasonOf();
					yield reason !== null && message.type === "omp:chat-snapshot"
						? { ...message, head: { ...message.head, readOnlyReason: reason } }
						: message;
				}
			})()),
		}),
		post: message => {
			const reason = reasonOf();
			if (reason !== null && message.type === "omp:chat-state") return page.post({ ...message, readOnlyReason: reason });
			if (reason !== null && message.type === "omp:chat-snapshot") {
				return page.post({ ...message, head: { ...message.head, readOnlyReason: reason } });
			}
			return page.post(message);
		},
	};
}
