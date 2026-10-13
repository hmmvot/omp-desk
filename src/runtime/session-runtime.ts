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
import type { NavigateOutcome, NavigateRequest } from "../host/rpc/session.ts";
import type { ChatStatePayload } from "../chat/model.ts";
import type { ChatWebviewMessage } from "../protocol/chat-messages.ts";
import type { KillSelection } from "../host/session-kill.ts";
import type { BrokerSlotProvenance } from "../host/broker-slots.ts";
import type { StopRecordedHostResult } from "../host/session-availability.ts";

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
	dispose(): void;
}
