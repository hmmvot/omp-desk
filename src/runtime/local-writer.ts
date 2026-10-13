/**
 * The positively verified writer of a conversation (ADR-0066, cut 7): the pid of a process the
 * extension owns and that serves it right now, never a recorded pid by itself. It is what a stop
 * that must not end a different writer than the one its caller verified checks under the gate
 * (`stopRecorded`, `stop`), and what an open, a reload, a rename and a deletion ask first.
 */
import type { ObservedClaim } from "../host/session-claim.ts";
import type { OwnerReconciler } from "../host/session-availability.ts";
import type { SessionIndex } from "../host/session-index.ts";

/** What the verification reads of the window. */
export interface WriterWindow {
	/** The pid of the runtime this window drives for the conversation, or `null`. */
	runtimePid(conversation: string): number | null;
	/** Whether a rival claim's holder may still be alive; `display` is the weaker read a row's label asks. */
	holderMayBeAlive(claim: ObservedClaim, display: boolean): Promise<boolean>;
}

export interface LocalWriterDeps {
	readonly index: SessionIndex;
	readonly reconciler: () => OwnerReconciler;
	readonly window: WriterWindow;
}

export class LocalWriterVerifier {
	readonly #deps: LocalWriterDeps;

	constructor(deps: LocalWriterDeps) {
		this.#deps = deps;
	}

	/** A current owned-writer witness, never a recorded pid by itself. */
	async pid(conversation: string, options: { readonly display?: boolean } = {}): Promise<number | null> {
		const { index, window } = this.#deps;
		const driven = window.runtimePid(conversation);
		if (driven !== null) return driven;
		const entry = index.get(conversation);
		if (entry === null) return null;
		const observed = await index.observeOwnership(conversation);
		if (observed.ok && observed.claim !== null && observed.claim.holderId !== index.claimHolder.id &&
			await window.holderMayBeAlive(observed.claim, options.display === true)) return null;
		const verdict = await this.#deps.reconciler().reconcile({
			entry, sessionFile: entry.sessionFile, draftIdentity: entry.ownership?.draftIdentity ?? null,
			ownerGeneration: entry.ownership?.ownerGeneration ?? "", claim: observed.ok ? observed.claim : null, host: entry.host,
		}).catch(() => ({ kind: "free" as const, evidence: [] }));
		return verdict.kind === "attachable" ? verdict.host.pid : verdict.kind === "live" ? verdict.pid ?? entry.host?.pid ?? null : null;
	}
}
