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
import type { BrokerSlotProvenance } from "../host/broker-slots.ts";
import type { OmpHostLauncher, RestoreOutcome, RestoreReport, SessionIndex } from "../host/session-index.ts";
import type { SessionHostRuntime, SessionTransitionFacts } from "../host/native-session.ts";
import type { StopOperations } from "./local-stop.ts";
import type {
	BeginTransitionRequest, OpenRequest, ReadTransitionFactsRequest, ReattachRequest, ReplaceWriterRequest, ReplaceWriterResult, RestorePassRequest, RuntimeHolder,
	RuntimeSnapshot, SessionRuntime, StopRecordedOutcome, StopRecordedRequest, StopRequest, StopResult, TransitionRetention, TransitionToken,
} from "./session-runtime.ts";
import type { LocalHostControl } from "./local-control.ts";
import type { LocalExitOperations } from "./local-exit.ts";
import type { LocalIdentity } from "./local-identity.ts";
import type { LocalKill } from "./local-kill.ts";
import type { KillSelection } from "../host/session-kill.ts";
import type { LocalNativeWatch } from "./local-native-watch.ts";
import type { RecordedStopOperations } from "./local-recorded-stop.ts";
import type { LocalWriterVerifier } from "./local-writer.ts";
import type { LocalTransitions } from "./local-transition.ts";
import { LocalConversations } from "./local-conversations.ts";
import type { ChatRuntime } from "../host/chat-runtime.ts";
import type { RuntimeRecord, RuntimeRecords } from "./runtime-record.ts";

export interface LocalSessionRuntimeDeps {
	readonly index: SessionIndex;
	/** The runtime's record of each conversation; the window files one when an editor first shows it. */
	readonly records: RuntimeRecords;
	/** The chat runtime this runtime owns: the window constructs it with its hooks and hands it over. */
	readonly chat: ChatRuntime;
	readonly reconciler: () => OwnerReconciler;
	readonly launcher: () => OmpHostLauncher;
	readonly stop: StopOperations;
	readonly control: LocalHostControl;
	readonly identity: LocalIdentity;
	readonly nativeWatch: LocalNativeWatch;
	readonly exit: LocalExitOperations;
	readonly kill: LocalKill;
	readonly recorded: RecordedStopOperations;
	readonly transitions: LocalTransitions;
	readonly writer: Pick<LocalWriterVerifier, "pid">;
	/** The row's durable broker slot, read losslessly at call time. */
	readonly brokerProvenance: (conversation: string) => BrokerSlotProvenance;
}

export class LocalSessionRuntime implements SessionRuntime {
	readonly #deps: LocalSessionRuntimeDeps;
	readonly #conversations: LocalConversations;

	constructor(deps: LocalSessionRuntimeDeps) {
		this.#deps = deps;
		this.#conversations = new LocalConversations(deps.chat);
	}

	/** The records of this window's conversations: in-process only, never part of the port. */
	get records(): RuntimeRecords {
		return this.#deps.records;
	}

	get holder(): RuntimeHolder {
		const holder = this.#deps.index.claimHolder;
		return { id: holder.id, pid: holder.pid, creationTime: holder.processCreationTime ?? null };
	}

	/** The conversation surface (cut 6): the window's view of its conversations over the chat runtime this runtime owns. */
	get conversations(): LocalConversations {
		return this.#conversations;
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

	kill(selection: KillSelection): Promise<void> {
		return this.#deps.kill.kill(selection);
	}

	stopRecorded(request: StopRecordedRequest): Promise<StopRecordedOutcome> {
		return this.#deps.recorded.stopRecorded(request);
	}

	verifiedWriterPid(conversation: string, options?: { readonly display?: boolean }): Promise<number | null> {
		return this.#deps.writer.pid(conversation, options);
	}

	brokerProvenance(conversation: string): BrokerSlotProvenance {
		return this.#deps.brokerProvenance(conversation);
	}

	/** The incarnation number of a live runtime the caller holds. `LocalSessionRuntime` only: the port names incarnations through `snapshot`. */
	attachmentOf(runtime: SessionHostRuntime): number {
		return this.#deps.transitions.attachmentOf(runtime);
	}

	snapshot(conversation: string): RuntimeSnapshot | null {
		return this.#deps.transitions.snapshot(conversation);
	}

	setControlFailure(conversation: string, detail: string | null): void {
		this.#deps.transitions.setControlFailure(conversation, detail);
	}

	beginTransition(request: BeginTransitionRequest): TransitionToken {
		return this.#deps.transitions.beginTransition(request);
	}

	endTransition(token: TransitionToken, retention: TransitionRetention): void {
		this.#deps.transitions.endTransition(token, retention);
	}

	/** Under the conversation's gate: see {@link LocalTransitions.readTransitionFacts}. */
	readTransitionFacts(request: ReadTransitionFactsRequest): Promise<SessionTransitionFacts | null> {
		return this.#deps.transitions.readTransitionFacts(request);
	}

	stop(request: StopRequest): Promise<StopResult> {
		return this.#deps.transitions.stop(request);
	}

	replaceWriter(request: ReplaceWriterRequest): Promise<ReplaceWriterResult> {
		return this.#deps.transitions.replaceWriter(request);
	}

	/**
	 * End the runtime of a session whose recorded OMP root is already gone, as its exit would have
	 * ended it. Ungated: the exit handlers take the tab's gate themselves, so call it outside the
	 * gate. `target` is the incarnation the caller captured (`RuntimeSnapshot.attachment`); another one is left alone.
	 */
	async endEnded(conversation: string, target: number): Promise<boolean> {
		const record = this.#deps.records.get(conversation);
		const runtime = record?.runtime ?? null;
		if (record === undefined || runtime === null || this.#deps.transitions.attachmentOf(runtime) !== target) return false;
		return await this.#deps.exit.endEnded(record, runtime);
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
}
