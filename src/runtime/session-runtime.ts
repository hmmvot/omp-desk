/**
 * The port through which a window opens, restores and reattaches sessions (ADR-0066).
 *
 * This module is data and one interface: its imports are statement-level `import type` from an
 * allow-list that `scripts/check-imports.mjs` enforces, so a live object (the index, a handle, a
 * client) cannot become part of the contract by a type import. It names conversations, never
 * editors: a window decides which editor a conversation belongs to and tells the runtime only the
 * facts a runtime transaction needs.
 *
 * Expected outcomes are values (`RestoreOutcome`, `RestoreReport`); a thrown error is an invariant
 * violation or an I/O failure, and the window shows it as it always did.
 */
import type { RestoreOutcome, RestoreReport } from "../host/session-index.ts";
import type { SessionViewMode } from "../host/session-model.ts";
import type { ChatCommandOutcome, ChatPage, ConversationActivity, RewindRead } from "../host/chat-runtime.ts";
import type {
	ChoiceOutcome, CommandResult, CycleModelResult, CycleThinkingResult, MaintenanceRequest, ModelsResult, NavigateOutcome, NavigateRequest, PromptRequest,
	RpcSessionOutput, SendOutcome, ThinkingLevelsResult,
} from "../host/rpc/session.ts";
import type { ContextRead, ContextReportRead } from "../host/context/context-parse.ts";
import type { ChatEpoch, ChatLiteState, ChatPendingControl, ChatPhase, ChatSlashCommand, ChatStatePayload } from "../chat/model.ts";
import type { MaintenanceState } from "../chat/events.ts";
import type { RpcToolDescriptor } from "../protocol/rpc.ts";
import type { ChatWebviewMessage } from "../protocol/chat-messages.ts";
import type { KillSelection } from "../host/session-kill.ts";
import type { BrokerSlotProvenance } from "../host/broker-slots.ts";
import type { StopRecordedHostResult } from "../host/session-availability.ts";
import type { SessionTransitionFacts } from "../host/native-session.ts";

/** Who acts. Fixed when the runtime is constructed; never a per-call argument. */
export interface RuntimeHolder {
	readonly id: string;
	readonly pid: number;
	/** The holder's process start time, once it has been read. */
	readonly creationTime: string | null;
}

/**
 * Open one row, reconcile its ownership, take its claim, then launch or attach.
 *
 * `allowStoppedResume` is the admission decision and stays an explicit field because the callers
 * differ: Resume and Start lift a durable `stopped` intent (`true`); an explicit Open does so only when a
 * legacy writer was just stopped for it; an editor VS Code restored never does (`false`).
 */
export interface OpenRequest {
	readonly conversation: string;
	readonly mode: SessionViewMode;
	readonly allowStoppedResume: boolean;
	/** The editor slot this conversation is shown in, kept as a precondition of the transaction, not an identity. */
	readonly editorBinding?: { readonly slot: string };
}

/**
 * The startup pass over a cohort the caller captured before it began, so a row created meanwhile
 * belongs to the action that created it. The pass is always automatic: it relaunches only with
 * recorded-writer absence evidence and never starts a draft or lifts a stopped intent.
 */
export interface RestorePassRequest {
	readonly cohort: ReadonlySet<string>;
}

/** Re-adopt the existing native writer of one conversation; never launches. */
export interface ReattachRequest {
	readonly conversation: string;
}

/**
 * Stop the recorded host of a conversation this window does not drive (a survivor of an earlier extension host, an
 * owned writer the window never adopted). The target is named by what the caller's confirmation was shown: the slot
 * and, when it was shown one, the broker, and the attempt the row records; the index refuses when any of them
 * changed. `expectedWriter` is the pid the caller verified: the operation checks it under the gate and ends nothing
 * else.
 */
export interface StopRecordedRequest {
	readonly conversation: string;
	readonly slot: string;
	readonly broker: { readonly brokerId: string; readonly brokerGeneration: string } | null;
	readonly expect: { readonly attemptStartedAt: string; readonly pid: number | null };
	readonly expectedWriter?: { readonly pid: number };
}

/** `writer-gone`: nothing owned serves the conversation any more, which is the state the caller wanted. `writer-changed`: another writer does; nothing was stopped. */
export type StopRecordedOutcome =
	| { readonly kind: "result"; readonly result: StopRecordedHostResult }
	| { readonly kind: "writer-gone" }
	| { readonly kind: "writer-changed" };

/**
 * The runtime of a conversation as values. `attachment` names the incarnation: it increases at every launch or attach,
 * so a re-attach of the same process is a new one, and a request that names it never reaches a different writer.
 */
export interface RuntimeSnapshot {
	readonly conversation: string;
	readonly attachment: number;
	readonly kind: "chat" | "terminal";
	readonly pid: number;
	readonly cwd: string;
	readonly slot: string;
	readonly brokerId: string;
	readonly brokerGeneration: string;
	readonly childCreationTime: string | null;
	/** A native shutdown was accepted and the process has not ended. */
	readonly stopping: boolean;
	/** The admission fence is up. */
	readonly transitioning: boolean;
	readonly controlFailure: string | null;
	/** Whether a verified host-control channel is established. */
	readonly control: "verified" | "unavailable";
}

/** Which gate-time checks only the window can make a flow asks of it; see `TransitionWindow`. */
export type TransitionPhase = "gate" | "attached" | "stopped";

/** One raised fence. Opaque to the window beyond naming its conversation. */
export interface TransitionToken {
	readonly conversation: string;
	readonly serial: number;
}

export interface BeginTransitionRequest {
	readonly conversation: string;
	readonly target: number | null;
}

/**
 * When a flow that ends keeps the fence up on purpose: `native-stopping` while a native shutdown it (or an earlier
 * flow) asked for is accepted and its process has not ended; `dispatched-stop` while the stop it dispatched did not
 * end the writer it captured; `none` never.
 */
export type TransitionRetention = "none" | "native-stopping" | "dispatched-stop";

export interface ReadTransitionFactsRequest {
	readonly conversation: string;
	readonly target: number;
	/** Gate-time checks of the flow that holds this fence run under the gate before the read. */
	readonly token?: TransitionToken;
	/** Bound the wait for the gate and the read (`withSessionReadDeadline`). */
	readonly bounded?: boolean;
}

interface StopRequestBase {
	readonly conversation: string;
	readonly token: TransitionToken;
	readonly target: number;
	readonly mode: "graceful" | "force";
	/** The user confirmed aborting a busy turn. */
	readonly consent: boolean;
	/** The facts the confirmation was shown: absent when none were captured, `null` when none could be read. */
	readonly expected?: SessionTransitionFacts | null;
	/** Refuse unless the session is idle now and still the one `expected` named. */
	readonly idleOnly?: boolean;
}

/** A stop of the session: the stopped intent is recorded and the claim released. */
export interface StopSessionRequest extends StopRequestBase {
	readonly scope: "session";
	/** Record the stopped intent before the stop is dispatched, so a crash in between never relaunches. */
	readonly recordIntentFirst?: boolean;
	/** The pid the caller verified; checked under the gate before anything is stopped. */
	readonly expectedWriter?: { readonly pid: number };
}

/** A passive editor's copy of the session: only this window's runtime is ended, the owning window keeps the session. */
export interface StopLocalCopyRequest extends StopRequestBase {
	readonly scope: "local-copy";
}

export type StopRequest = StopSessionRequest | StopLocalCopyRequest;

/**
 * `refused` stopped nothing: `target-changed` (another incarnation, or the flow's own gate-time check failed),
 * `not-idle` and `facts-changed` (the session is busy or is no longer the one the facts named). `writer-gone` and
 * `writer-changed` report the caller's `expectedWriter`.
 */
export type StopResult =
	| { readonly status: "stopped"; readonly detail: string }
	| { readonly status: "unconfirmed"; readonly detail: string }
	| { readonly status: "refused"; readonly code: "target-changed" | "not-idle" | "facts-changed" }
	| { readonly status: "writer-gone" }
	| { readonly status: "writer-changed" };

/** How the writer to replace is stopped. */
export type ReplaceStop =
	| { readonly kind: "graceful"; readonly consent: boolean; readonly captured: SessionTransitionFacts }
	| { readonly kind: "force"; readonly file: string; readonly durableSessionId: string };

export interface ReplaceWriterRequest {
	readonly conversation: string;
	readonly token: TransitionToken;
	readonly target: number;
	/** The view the successor opens in. */
	readonly mode: SessionViewMode;
	/** The editor binding the replacement is made for; its generation must still be the one the flow saw. */
	readonly binding: { readonly slot: string; readonly generation: number };
	readonly stop: ReplaceStop;
	/** Bound the wait for the gate: a caller that gave up is never served late, and the result is `failed`. */
	readonly bounded?: boolean;
}

/**
 * `replaced`: the successor was started (or refused) by the index and `outcome` says which. `refused` stopped
 * nothing and replaced nothing, `unconfirmed` stopped nothing it can prove, `closed` ended the writer and recorded
 * the session stopped without a successor (the durable file is gone), `failed` threw. `stopDispatched` and
 * `writerGone` are total on every result.
 */
export type ReplaceWriterResult =
	| { readonly status: "replaced"; readonly outcome: RestoreOutcome; readonly stopDispatched: true; readonly writerGone: true }
	| { readonly status: "refused"; readonly code: ReplaceRefusal; readonly detail?: string; readonly stopDispatched: boolean; readonly writerGone: boolean }
	| { readonly status: "unconfirmed"; readonly detail: string; readonly stopDispatched: true; readonly writerGone: false }
	| { readonly status: "closed"; readonly code: "file-missing"; readonly stopDispatched: true; readonly writerGone: true }
	| { readonly status: "failed"; readonly detail: string; readonly stopDispatched: boolean; readonly writerGone: boolean };

/**
 * Why a replacement was refused: `target-changed` (another incarnation, a changed binding, or the flow's own check),
 * `facts-changed` (the facts or the busy state differ from what was confirmed), `not-durable`, `no-broker`,
 * `no-control` (a Terminal without a verified host-control channel or a native target), `native-refused` (OMP did not
 * accept the native shutdown), `abort-unconfirmed`, `settle-failed`, `checked-after-stop` (the flow's check failed after
 * the process was stopped; the dead writer stays current).
 */
export type ReplaceRefusal =
	| "target-changed" | "facts-changed" | "not-durable" | "no-broker" | "no-control" | "native-refused"
	| "abort-unconfirmed" | "settle-failed" | "checked-after-stop";

export interface SessionRuntime {
	readonly conversations: ConversationPort;
	readonly holder: RuntimeHolder;
	open(request: OpenRequest): Promise<RestoreOutcome>;
	/**
	 * `signal` is honoured before each row and after each claim acquisition; a row it skips is
	 * `skipped`. Once a row's gate is held the row completes.
	 */
	restore(request: RestorePassRequest, options?: { readonly signal?: AbortSignal }): Promise<RestoreReport>;
	/** The outcome is never `restored`; a conversation that is not an attachable native writer is `skipped`. */
	reattach(request: ReattachRequest): Promise<RestoreOutcome>;
	/**
	 * Kill (ADR-0060): end the process tree of the selected session or process row at once and, for a session whose
	 * recorded process was proven gone, record it as stopped. Reports through the window's notices; never throws.
	 */
	kill(selection: KillSelection): Promise<void>;
	/**
	 * Stop a recorded host this window does not drive, under the conversation's gate; a stop that happened also
	 * retires the slot and the recorded owner's credentials and drops the window's remembered outcome.
	 */
	stopRecorded(request: StopRecordedRequest): Promise<StopRecordedOutcome>;
	/**
	 * The pid of the writer this window can positively verify for a conversation (its own runtime, or an owned
	 * process the reconciler proves), or `null`. A recorded pid is never evidence by itself. `display` is the weaker
	 * liveness read a row's label uses for a rival claim.
	 */
	verifiedWriterPid(conversation: string, options?: { readonly display?: boolean }): Promise<number | null>;
	/** Where the durable broker slot of a conversation is recorded; an unreadable table is uncertainty, never `none`. */
	brokerProvenance(conversation: string): BrokerSlotProvenance;
	/** The runtime a conversation holds, as values; `null` when it holds none. */
	snapshot(conversation: string): RuntimeSnapshot | null;
	/**
	 * Raise the admission fence of a conversation for one flow (raised before any dialog, kept across the port calls
	 * and the dialogs between them). `target` is the incarnation the flow captured, or `null` when it holds none.
	 */
	beginTransition(request: BeginTransitionRequest): TransitionToken;
	/** End the flow's fence; `retention` says when the fence is kept up on purpose. See {@link TransitionRetention}. */
	endTransition(token: TransitionToken, retention: TransitionRetention): void;
	/** The facts a stop or replacement is confirmed against, read under the gate; `null` when unreadable or the target changed. */
	readTransitionFacts(request: ReadTransitionFactsRequest): Promise<SessionTransitionFacts | null>;
	/** Stop the writer of a conversation this window drives and record the stop, under the conversation's gate. */
	stop(request: StopRequest): Promise<StopResult>;
	/** Stop the writer and open its successor on the same conversation under one hold of the gate. */
	replaceWriter(request: ReplaceWriterRequest): Promise<ReplaceWriterResult>;
}

/** Show a stopped, blocked or resyncing session's history read-only. Never claims, launches or writes. */
export interface ViewOnlyRequest {
	readonly file: string | null;
	readonly cwd: string;
	readonly title: string | null;
	readonly reason: string;
	readonly phase?: "view-only" | "blocked" | "resyncing";
}

/** Show the banner-only page of a row an earlier build's host owns. */
export interface LegacyViewRequest {
	readonly cwd: string;
	readonly title: string | null;
	readonly reason: string;
}


/**
 * The live Chat session of a conversation, as values read at one instant. `incarnation` names the session: the
 * number is assigned the first time a session is asked about, increases, and is never reused, so a request that
 * names it never reaches a different session of the same conversation. Read again for fresh values; a snapshot
 * never updates.
 */
export interface LiveConversation {
	readonly incarnation: number;
	readonly phase: ChatPhase;
	readonly epoch: ChatEpoch;
	/** The footer state OMP last reported: the chosen model, the thinking level, the context usage. */
	readonly state: ChatLiteState | null;
	readonly working: boolean;
	readonly asyncPaused: boolean;
	readonly maintenance: MaintenanceState | null;
	/** Model and thinking choices OMP has not been told about yet. */
	readonly pendingControl: ChatPendingControl | null;
	readonly commands: readonly ChatSlashCommand[];
	/** The exact file the process serves: the binding, or the path learned for a new conversation. */
	readonly sessionFile: string | null;
	readonly sessionId: string | null;
	/** The session id of the journal header the conversation shows, or `null` before one is read. */
	readonly headerId: string | null;
	/** An unanswered or divergent process is offered the confirmed Restart. */
	readonly restartOffered: boolean;
	readonly nativeStateUnanswered: boolean;
}

/** The answer of an operation that names an incarnation the conversation no longer has; nothing was sent. */
export interface StaleIncarnation {
	readonly status: "stale";
}

/** `joined` once the session finished initializing (or had nothing to wait for). */
export type JoinResult = StaleIncarnation | { readonly status: "joined" };

/** The model (and thinking level) a settings editor asks the launching Chat to take. `efforts` are the levels the model supports, when known. */
export interface ModelDefault {
	readonly provider: string;
	readonly id: string;
	readonly thinking?: string;
	readonly efforts?: readonly string[];
}

/**
 * What a window can ask of a conversation: show it, route its messages and read what it says. Inputs and outputs
 * are values; the page sink and the runtime's own events are callbacks that carry values, never the model or the
 * session. A conversation is the session row's id.
 */
export interface ConversationPort {
	/** Whether a conversation of any kind exists. */
	has(conversation: string): boolean;
	kindOf(conversation: string): "live" | "view-only" | "legacy" | null;
	/** The current state of a conversation of any kind, or `null` when none exists. */
	stateOf(conversation: string): ChatStatePayload | null;
	/** What the live model says (turn activity, chosen model), or `null` without a live session. */
	activityOf(conversation: string): ConversationActivity | null;
	/** The prompts the live conversation has loaded, oldest first. */
	promptsOf(conversation: string): string[];
	/** The prompts Rewind can go back to, newest first, or the sentence that says why none can. */
	rewindOf(conversation: string): RewindRead;
	/** How the conversation's live Chat session knows a subagent: `roster` (its Agents roster holds it), `reference` (only a held task result names it) or `null` (neither, or no live session). */
	subagentKnownOf(conversation: string, subagentId: string): "roster" | "reference" | null;
	showViewOnly(conversation: string, request: ViewOnlyRequest): Promise<void>;
	showLegacy(conversation: string, request: LegacyViewRequest): void;
	/** Drop the conversation: its session stops reading and its connection closes; the process is untouched. Pages stay attached. */
	release(conversation: string): void;
	/** Attach one route; returns the detach. Attaching the same page id again replaces it and re-sends. */
	attachPage(conversation: string, page: ChatPage): () => void;
	hasPage(conversation: string): boolean;
	/** Re-send the state and an authoritative snapshot to one route. */
	resend(conversation: string, pageId: string): void;
	/** One page command, answered for the asking route's own request ledger. */
	command(conversation: string, message: ChatWebviewMessage, origin: ChatPage | null): Promise<ChatCommandOutcome>;
	navigate(conversation: string, request: NavigateRequest, origin: ChatPage | null): Promise<NavigateOutcome>;
	/** Say a fixed sentence to the routes showing the conversation; `false` when there is no route to say it to. */
	notify(conversation: string, text: string): boolean;
	refreshDisplayPreferences(): void;
	refreshCodeThemes(): void;
	dispose(): void;

	// The live Chat session of a conversation, by value. Every operation below names the incarnation the caller read
	// (`incarnationOf` or `liveOf`) and answers `stale` (or `null` for a plain read) without sending anything when the
	// conversation no longer holds that session, so a flow that awaited a dialog never reaches its successor.

	/** The incarnation of the conversation's live Chat session, or `null` when it has none. */
	incarnationOf(conversation: string): number | null;
	/** The live Chat session's facts as values, or `null` when the conversation has none. */
	liveOf(conversation: string): LiveConversation | null;
	/** Wait for the session's initialization (the pending start of a starting, attaching or resyncing session). */
	join(conversation: string, incarnation: number): Promise<JoinResult>;
	/** Observe the session's outputs; returns the unsubscribe, or `null` when the incarnation is gone. */
	observe(conversation: string, incarnation: number, listener: (output: RpcSessionOutput) => void): (() => void) | null;
	readAvailableModels(conversation: string, incarnation: number): Promise<ModelsResult | StaleIncarnation>;
	readAvailableThinkingLevels(conversation: string, incarnation: number): Promise<ThinkingLevelsResult | StaleIncarnation>;
	/** The session's cost, or `null` when unknown or the incarnation is gone. */
	readSessionCost(conversation: string, incarnation: number): Promise<number | null>;
	/** The provider-facing tool inventory, or `null` when unavailable or the incarnation is gone. */
	readToolDescriptors(conversation: string, incarnation: number): Promise<readonly RpcToolDescriptor[] | null>;
	/** The Context view's structured read, or `null` when unavailable or the incarnation is gone. */
	readContext(conversation: string, incarnation: number): Promise<ContextRead | null>;
	/** OMP's `/context` report, on the user's explicit request. */
	requestContextReport(conversation: string, incarnation: number): Promise<CommandResult<ContextReportRead> | StaleIncarnation>;
	chooseModel(conversation: string, incarnation: number, provider: string, modelId: string, name?: string): Promise<ChoiceOutcome | StaleIncarnation>;
	chooseThinkingLevel(conversation: string, incarnation: number, level: string): Promise<ChoiceOutcome | StaleIncarnation>;
	cycleModel(conversation: string, incarnation: number): Promise<CycleModelResult | StaleIncarnation>;
	cycleThinkingLevel(conversation: string, incarnation: number): Promise<CycleThinkingResult | StaleIncarnation>;
	maintain(conversation: string, incarnation: number, request: MaintenanceRequest): Promise<CommandResult<string> | StaleIncarnation>;
	exportHtml(conversation: string, incarnation: number, outputPath: string): Promise<CommandResult<string> | StaleIncarnation>;
	/** Send one prompt to the session (the Share action's `/share`). */
	prompt(conversation: string, incarnation: number, request: PromptRequest): Promise<SendOutcome | StaleIncarnation>;
	setSessionName(conversation: string, incarnation: number, name: string): Promise<SendOutcome | StaleIncarnation>;
	/**
	 * Raise (a reason) or lower (`null`) the mutation fence of the session the conversation holds now, if any. Not
	 * keyed by an incarnation: a fence is the conversation's admission state, and a session attached later takes it up.
	 */
	setFence(conversation: string, reason: string | null): void;
	/**
	 * Apply a settings editor's effective default to the launching Chat when it is live and idle, confirmed by readback;
	 * the answer is the sentence the editor shows. `stillCurrent` is the window's own check, asked before and after each step.
	 */
	applyModelDefault(conversation: string, incarnation: number, model: ModelDefault, stillCurrent: () => boolean): Promise<string | StaleIncarnation>;
}
