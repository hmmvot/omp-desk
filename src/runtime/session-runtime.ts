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

export interface SessionRuntime {
	readonly holder: RuntimeHolder;
	open(request: OpenRequest): Promise<RestoreOutcome>;
	/**
	 * `signal` is honoured before each row and after each claim acquisition; a row it skips is
	 * `skipped`. Once a row's gate is held the row completes.
	 */
	restore(request: RestorePassRequest, options?: { readonly signal?: AbortSignal }): Promise<RestoreReport>;
	/** The outcome is never `restored`; a conversation that is not an attachable native writer is `skipped`. */
	reattach(request: ReattachRequest): Promise<RestoreOutcome>;
}
