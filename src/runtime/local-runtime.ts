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
import type { SessionHostRuntime, SessionTransitionFacts } from "../host/native-session.ts";
import type { NativeStopVerdict } from "../host/rpc-reconcile.ts";
import type { StopOperations, StopRecord } from "./local-stop.ts";
import type { OpenRequest, ReattachRequest, RestorePassRequest, RuntimeHolder, SessionRuntime } from "./session-runtime.ts";
import type { LocalHostControl } from "./local-control.ts";
import type { LocalExitOperations } from "./local-exit.ts";
import type { LocalIdentity } from "./local-identity.ts";
import type { LocalNativeWatch } from "./local-native-watch.ts";
import { LocalConversations } from "./local-conversations.ts";
import type { ChatRuntime } from "../host/chat-runtime.ts";
import type { RpcSession } from "../host/rpc/session.ts";
import type { RuntimeRecord } from "./runtime-record.ts";

export interface LocalSessionRuntimeDeps {
	readonly index: SessionIndex;
	/** The chat runtime this runtime owns: the window constructs it with its hooks and hands it over. */
	readonly chat: ChatRuntime;
	readonly reconciler: () => OwnerReconciler;
	readonly launcher: () => OmpHostLauncher;
	readonly stop: StopOperations;
	readonly control: LocalHostControl;
	readonly identity: LocalIdentity;
	readonly nativeWatch: LocalNativeWatch;
	readonly exit: LocalExitOperations;
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
	readonly #conversations: LocalConversations;

	constructor(deps: LocalSessionRuntimeDeps) {
		this.#deps = deps;
		this.#conversations = new LocalConversations(deps.chat);
	}

	get holder(): RuntimeHolder {
		const holder = this.#deps.index.claimHolder;
		return { id: holder.id, pid: holder.pid, creationTime: holder.processCreationTime ?? null };
	}

	/**
	 * The chat runtime itself. Transitional (`LocalSessionRuntime` only): the launcher starts a live conversation on it
	 * (`startLive`, which hands back the `RpcSession`) and the window's lifecycle tests drive it directly.
	 */
	get chat(): ChatRuntime {
		return this.#deps.chat;
	}

	/** The conversation surface (cut 6): the window's view of its conversations over the chat runtime this runtime owns. */
	get conversations(): LocalConversations {
		return this.#conversations;
	}

	/**
	 * The live `RpcSession` of a conversation, or `null`. Transitional (`LocalSessionRuntime` only): the window's
	 * footer, settings, control-picker and stop flows still drive the session itself; each moves behind
	 * `ConversationPort` as it gets a value-typed operation.
	 */
	sessionOf(conversation: string): RpcSession | null {
		return this.#deps.chat.sessionOf(conversation);
	}

	// The runtime's own services of cut 5. They are injected whole because each one is built over the window's hooks.

	/** Host control: the verified channel to the exact process and its credentials. */
	get control(): LocalHostControl {
		return this.#deps.control;
	}

	/** Conversation identity binding. */
	get identity(): LocalIdentity {
		return this.#deps.identity;
	}

	/** The native terminal's watch and handover. */
	get nativeWatch(): LocalNativeWatch {
		return this.#deps.nativeWatch;
	}

	/** The end of a process: exit handlers, broker retirement and broker loss. */
	get exit(): LocalExitOperations {
		return this.#deps.exit;
	}

	/**
	 * End the runtime of a session whose recorded OMP root is already gone, as its exit would have
	 * ended it. Ungated: the exit handlers take the tab's gate themselves, so call it outside the
	 * gate. `LocalSessionRuntime` only, because its callers capture the live `runtime`.
	 */
	endEnded(state: RuntimeRecord, runtime: SessionHostRuntime): Promise<boolean> {
		return this.#deps.exit.endEnded(state, runtime);
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

	// Verdict-only stop operations (cut 4). They take no gate: every caller holds the tab's lease and
	// records the outcome under it. Cut 7 folds them into the gated `stop` and `replaceWriter`.

	/** Ask the exact process of `state` to stop, or recognise that it already ended; records nothing. */
	requestStop(state: StopRecord, runtime: SessionHostRuntime, mode: "graceful" | "force", consent: boolean, expected?: SessionTransitionFacts | null): Promise<NativeStopVerdict> {
		return this.#deps.stop.requestStop(state, runtime, mode, consent, expected);
	}

	/** A verdict for a runtime whose recorded OMP root is already gone, or `null` when that cannot be shown. */
	confirmEnded(runtime: SessionHostRuntime): Promise<NativeStopVerdict | null> {
		return this.#deps.stop.confirmEnded(runtime);
	}

	/** Wait, bounded, for a chat session to settle on the very facts a stop was confirmed against. */
	awaitSettled(state: StopRecord, runtime: SessionHostRuntime, expected: SessionTransitionFacts): Promise<SessionTransitionFacts | null> {
		return this.#deps.stop.awaitSettled(state, runtime, expected);
	}

	/** The facts a stop or replacement is confirmed against; `null` when the record no longer holds this runtime. */
	readTransitionFacts(state: StopRecord, runtime: SessionHostRuntime): Promise<SessionTransitionFacts | null> {
		return this.#deps.stop.readTransitionFacts(state, runtime);
	}
}
