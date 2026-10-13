/**
 * The in-process `SessionRuntime`: one window's session index, its ownership reconciler and its
 * host launcher behind the port (ADR-0066).
 *
 * The index, reconciler and launcher are injected as they are today; the reconciler and launcher
 * are read at call time because the window rebuilds them (the reconciler is created after the
 * index, and a test replaces either). Until the compound flows that hold a lifecycle lease are
 * moved behind single gated operations, this class also has the lease-bound forms of
 * `docs/designs/2026-10-13-session-runtime-port.md` §2.5; `SessionRuntime` itself exposes no lease.
 */
import type { OwnerReconciler } from "../host/session-availability.ts";
import type { OmpHostLauncher, RestoreOutcome, RestoreReport, SessionIndex } from "../host/session-index.ts";
import type { SessionViewMode } from "../host/session-model.ts";
import type { TabLifecycleLease } from "../host/tab-lifecycle.ts";
import type { OpenRequest, ReattachRequest, RestorePassRequest, RuntimeHolder, SessionRuntime } from "./session-runtime.ts";

export interface LocalSessionRuntimeDeps {
	readonly index: SessionIndex;
	readonly reconciler: () => OwnerReconciler;
	readonly launcher: () => OmpHostLauncher;
}

/**
 * Replace the settled writer of a conversation inside the lease the caller already holds
 * (`switchSessionMode`, `restartChat`). Removed when those flows call one gated `replaceWriter`.
 */
export interface ReplaceWriterHeldRequest {
	readonly conversation: string;
	readonly confirmedStopped: boolean;
	readonly expectedPid: number;
	readonly expectedCreationTime: string;
	readonly mode: SessionViewMode;
	readonly slot: string;
	readonly emptyFile: string | null;
}

export class LocalSessionRuntime implements SessionRuntime {
	readonly #deps: LocalSessionRuntimeDeps;

	constructor(deps: LocalSessionRuntimeDeps) {
		this.#deps = deps;
	}

	get holder(): RuntimeHolder {
		const holder = this.#deps.index.claimHolder;
		return { id: holder.id, pid: holder.pid, creationTime: holder.processCreationTime ?? null };
	}

	open(request: OpenRequest): Promise<RestoreOutcome> {
		return this.#deps.index.restore(request.conversation, {
			reconciler: this.#deps.reconciler(),
			launcher: this.#deps.launcher(),
			mode: request.mode,
			editorSlotId: request.editorBinding?.slot,
			allowStoppedResume: request.allowStoppedResume,
		});
	}

	restore(request: RestorePassRequest, options?: { readonly signal?: AbortSignal }): Promise<RestoreReport> {
		return this.#deps.index.restoreAll({
			reconciler: this.#deps.reconciler(),
			launcher: this.#deps.launcher(),
			only: request.cohort,
			signal: options?.signal,
		});
	}

	async reattach(request: ReattachRequest): Promise<RestoreOutcome> {
		const { index } = this.#deps;
		const tabId = request.conversation;
		const entry = index.get(tabId);
		if (entry?.host?.transport !== "native") return { status: "skipped", tabId, detail: "The conversation has no native writer to reattach." };
		const reconciler = this.#deps.reconciler();
		const observation = await index.observeOwnership(tabId);
		const verdict = await reconciler.reconcile({
			entry, sessionFile: entry.sessionFile, draftIdentity: entry.ownership?.draftIdentity ?? null,
			ownerGeneration: entry.ownership?.ownerGeneration ?? "", claim: observation.ok ? observation.claim : null, host: entry.host,
		});
		if (verdict.kind !== "attachable") return { status: "skipped", tabId, detail: "The native writer is not attachable." };
		const launcher = this.#deps.launcher();
		return await index.restore(tabId, {
			reconciler, allowStoppedResume: false, mode: "terminal",
			launcher: {
				launch: async () => ({ state: "not-started", reason: "A lifecycle action only reattaches an existing native writer." }),
				attach: attachRequest => launcher.attach(attachRequest),
			},
		});
	}

	/** Under a lease the caller holds; see {@link ReplaceWriterHeldRequest}. */
	replaceWriterHeld(request: ReplaceWriterHeldRequest, lease: TabLifecycleLease): Promise<RestoreOutcome> {
		return this.#deps.index.replaceHost(request.conversation, {
			confirmedStopped: request.confirmedStopped,
			expectedPid: request.expectedPid,
			expectedCreationTime: request.expectedCreationTime,
			mode: request.mode,
			slotId: request.slot,
			emptyFile: request.emptyFile,
			launcher: this.#deps.launcher(),
		}, lease);
	}
}
