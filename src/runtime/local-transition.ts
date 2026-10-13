/**
 * The gated transitions of the in-process runtime (ADR-0066, cut 7): the admission fence one flow holds
 * across its dialogs, the read of the facts a stop is confirmed against, the stop of a writer this window
 * drives and the replacement of a writer by its successor.
 *
 * Each operation takes the conversation's lifecycle gate itself and holds it from its first recheck to its
 * last recording: a stop followed by a replacement is one hold, because a gate released between them would
 * let another open win it. Dialogs never hold the gate; the window asks before it calls and may call again
 * after (graceful, then force) under the same fence.
 *
 * What only the window can check under the gate (the editor's role, the last view request, the identity of
 * its panel and document) it supplies as `TransitionWindow.check`, keyed by the flow's token; what the
 * runtime can check it checks as data (the incarnation, the editor binding's generation, the facts, the
 * durable file). A hook never waits for the user and never takes the gate.
 */
import { isOpenControlClient } from "../host/control-attempt.ts";
import type { ChatRuntime } from "../host/chat-runtime.ts";
import { waitForManagedRootExit } from "../host/native-session.ts";
import type { SessionHostRuntime, SessionTransitionFacts } from "../host/native-session.ts";
import type { PtyBrokerClient } from "../host/pty-client.ts";
import type { NativeStopVerdict } from "../host/rpc-reconcile.ts";
import { stopRpcHost } from "../host/rpc-launch.ts";
import { readSessionFileHeader } from "../host/session-files.ts";
import type { OmpHostLauncher, RestoreOutcome, SessionIndex } from "../host/session-index.ts";
import type { TabLifecycleLease } from "../host/tab-lifecycle.ts";
import { controlOwnerFor } from "./local-control.ts";
import type { LocalHostControl } from "./local-control.ts";
import type { LocalExitOperations } from "./local-exit.ts";
import { withSessionReadDeadline } from "./local-stop.ts";
import type { StopOperations } from "./local-stop.ts";
import type { RuntimeRecord, RuntimeRecords } from "./runtime-record.ts";
import type {
	BeginTransitionRequest, ReadTransitionFactsRequest, ReplaceWriterRequest, ReplaceWriterResult, RuntimeSnapshot, StopRequest, StopResult,
	TransitionPhase, TransitionRetention, TransitionToken,
} from "./session-runtime.ts";

/** The sentence the chat session's mutation fence carries while a transition is pending. */
export const TRANSITION_FENCE_REASON = "Session lifecycle transition.";

/** What the transitions ask of the window; in-process only (design §2.5). Hooks never wait for the user and never take a gate. */
export interface TransitionWindow {
	/** The fence of a conversation changed: refresh what the editors show of it. Runs after the record and the chat session were updated. */
	fenced(conversation: string, on: boolean): void;
	/** The flow's own gate-time checks that only the window can make. `false` refuses the operation. */
	check(token: TransitionToken, phase: TransitionPhase): boolean | Promise<boolean>;
	/** Between a replacement's teardown and its successor's launch: refresh the editor's document. Runs under the gate. */
	prepare(token: TransitionToken): Promise<void>;
	/** Drop the record's terminal frontend; the broker keeps running. */
	endTerminal(record: RuntimeRecord): void;
	/** A stop was recorded: drop what the window remembers of a conversation that is stopped. */
	stopped(conversation: string, scope: "session" | "local-copy"): void;
}

export interface LocalTransitionDeps {
	readonly index: SessionIndex;
	readonly window: TransitionWindow;
	readonly records: RuntimeRecords;
	readonly chat: Pick<ChatRuntime, "sessionOf" | "release">;
	readonly stop: StopOperations;
	readonly control: Pick<LocalHostControl, "release" | "dispose">;
	readonly exit: Pick<LocalExitOperations, "retireBroker">;
	readonly writer: { pid(conversation: string): Promise<number | null> };
	readonly attachBrokerClient: () => Promise<PtyBrokerClient | null>;
	readonly launcher: () => OmpHostLauncher;
	readonly log: (message: string) => void;
}

/** What the runtime keeps of one flow's fence between its calls. */
interface FenceState {
	readonly conversation: string;
	readonly target: number | null;
	/** A native shutdown was already pending when the flow began: its graceful attempt only confirms. */
	readonly pendingNative: boolean;
	/** Set by `replaceWriter` when it ends: the fence stays up for a stop it dispatched. */
	keep: boolean;
}

const STOP_INTENT_DETAIL = "Stop requested before continuing the user's action.";

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class LocalTransitions {
	readonly #deps: LocalTransitionDeps;
	readonly #fences = new Map<number, FenceState>();
	readonly #attachments = new WeakMap<SessionHostRuntime, number>();
	#serial = 0;
	#attachmentSerial = 0;

	constructor(deps: LocalTransitionDeps) {
		this.#deps = deps;
	}

	/** The incarnation number of a runtime: assigned the first time it is asked, increasing, never reused. */
	attachmentOf(runtime: SessionHostRuntime): number {
		let attachment = this.#attachments.get(runtime);
		if (attachment === undefined) {
			attachment = ++this.#attachmentSerial;
			this.#attachments.set(runtime, attachment);
		}
		return attachment;
	}

	snapshot(conversation: string): RuntimeSnapshot | null {
		const record = this.#deps.records.get(conversation);
		const runtime = record?.runtime ?? null;
		if (record === undefined || runtime === null) return null;
		return {
			conversation,
			attachment: this.attachmentOf(runtime),
			kind: runtime.kind === "terminal" ? "terminal" : "chat",
			pid: runtime.pid,
			cwd: runtime.cwd,
			slot: runtime.identity.slot,
			brokerId: runtime.identity.brokerId,
			brokerGeneration: runtime.identity.brokerGeneration,
			childCreationTime: runtime.identity.childCreationTime,
			stopping: runtime.kind === "terminal" && runtime.stopping,
			transitioning: record.transitioning,
			controlFailure: record.controlFailure,
			control: record.control === null ? "unavailable" : "verified",
		};
	}

	/** Why host control is unavailable for a conversation, shown rather than hidden; `null` clears it. */
	setControlFailure(conversation: string, detail: string | null): void {
		const record = this.#deps.records.get(conversation);
		if (record !== undefined) record.controlFailure = detail;
	}

	/** Raise the fence for one flow: the admission flag, the chat session's mutation fence, then the window's projection. */
	beginTransition(request: BeginTransitionRequest): TransitionToken {
		const { window } = this.#deps;
		const record = this.#deps.records.get(request.conversation);
		const runtime = record?.runtime ?? null;
		const token: TransitionToken = { conversation: request.conversation, serial: ++this.#serial };
		this.#fences.set(token.serial, {
			conversation: request.conversation,
			target: request.target,
			pendingNative: runtime?.kind === "terminal" && runtime.stopping,
			keep: false,
		});
		try {
			this.#raise(request.conversation, true);
		} catch (error) {
			// A projection that threw leaves no half-raised fence behind: the flow never received its token.
			this.#fences.delete(token.serial);
			try { this.#raise(request.conversation, false); } catch { /* The first failure is the one reported. */ }
			throw error;
		}
		return token;
	}

	endTransition(token: TransitionToken, retention: TransitionRetention): void {
		const fence = this.#fences.get(token.serial);
		this.#fences.delete(token.serial);
		const record = this.#deps.records.get(token.conversation);
		const runtime = record?.runtime ?? null;
		const current = runtime !== null && fence?.target !== null && fence !== undefined && this.attachmentOf(runtime) === fence.target;
		const keep = current && (
			(retention === "native-stopping" && runtime.kind === "terminal" && runtime.stopping) ||
			(retention === "dispatched-stop" && fence.keep)
		);
		if (keep) this.#deps.window.fenced(token.conversation, true);
		else this.#raise(token.conversation, false);
	}

	async readTransitionFacts(request: ReadTransitionFactsRequest): Promise<SessionTransitionFacts | null> {
		const { index, window, stop } = this.#deps;
		const read = index.lifecycle.run(request.conversation, async () => {
			const record = this.#deps.records.get(request.conversation);
			const runtime = record?.runtime ?? null;
			if (record === undefined || runtime === null || this.attachmentOf(runtime) !== request.target) return null;
			if (request.token !== undefined && !(await window.check(request.token, "gate"))) return null;
			return await stop.readTransitionFacts(record, runtime);
		});
		return request.bounded === true ? await withSessionReadDeadline(read) : await read;
	}

	/**
	 * Stop the writer of a conversation this window drives, then record what that proves: the runtime is cleared, the
	 * credentials released and the broker retired; for the session itself the stopped intent is written and the claim
	 * released, and what the window remembered of the conversation is dropped.
	 */
	async stop(request: StopRequest): Promise<StopResult> {
		const { index, window, chat, control, exit, writer, log } = this.#deps;
		const tabId = request.conversation;
		const fence = this.#fences.get(request.token.serial);
		return await index.lifecycle.run(tabId, async (lease): Promise<StopResult> => {
			if (request.scope === "session" && request.expectedWriter !== undefined) {
				const current = await writer.pid(tabId);
				if (current === null) return { status: "writer-gone" };
				if (current !== request.expectedWriter.pid) return { status: "writer-changed" };
			}
			const record = this.#deps.records.get(tabId);
			const runtime = record?.runtime ?? null;
			if (record === undefined || runtime === null || record.tabId !== tabId || this.attachmentOf(runtime) !== request.target ||
				!(await window.check(request.token, "gate"))) return { status: "refused", code: "target-changed" };
			if (request.idleOnly === true) {
				const fresh = await this.#deps.stop.readTransitionFacts(record, runtime);
				const captured = request.expected ?? null;
				if (fresh?.settled !== true || (captured !== null && (fresh.epoch !== captured.epoch || fresh.file !== captured.file || fresh.sessionId !== captured.sessionId))) {
					return { status: "refused", code: "not-idle" };
				}
			}
			if (request.mode === "force" && request.expected !== undefined && request.expected !== null) {
				const fresh = await this.#deps.stop.readTransitionFacts(record, runtime);
				if (fresh !== null && (fresh.epoch !== request.expected.epoch || fresh.file !== request.expected.file || fresh.sessionId !== request.expected.sessionId)) {
					return { status: "refused", code: "facts-changed" };
				}
			}
			if (request.scope === "session" && request.recordIntentFirst === true) await index.setRunIntent(tabId, "stopped", STOP_INTENT_DETAIL);
			const verdict = fence?.pendingNative === true && request.mode === "graceful"
				? await this.#deps.stop.confirmEnded(runtime) ?? { writerGone: false, treeEmpty: false, detail: "Native shutdown is already pending; no new shutdown is sent." }
				: await this.#deps.stop.requestStop(record, runtime, request.mode, request.consent, request.expected);
			log(`session stop ${tabId}: ${verdict.diagnosticDetail ?? verdict.detail}`);
			if (!verdict.writerGone) return { status: "unconfirmed", detail: verdict.detail };
			const ownerGeneration = index.get(tabId)?.ownership?.ownerGeneration ?? "";
			this.#end(record);
			control.dispose(record);
			await control.release(tabId, controlOwnerFor(runtime, ownerGeneration));
			await exit.retireBroker(tabId, runtime);
			if (request.scope === "session") {
				await index.setRunIntent(tabId, "stopped", verdict.detail);
				await index.closeSession(tabId, { confirmedStopped: true, detail: verdict.detail }, lease);
				chat.release(tabId);
			}
			window.stopped(tabId, request.scope);
			record.controlFailure = null;
			return { status: "stopped", detail: verdict.detail };
		});
	}

	/**
	 * Stop the writer and open its successor in the editor that shows the conversation, under one hold of the gate:
	 * recheck, the verdict that the old process is gone, teardown, the durable file, the window's document refresh and
	 * the index's replacement. Nothing throws once a stop was dispatched: the result says how far it got.
	 */
	async replaceWriter(request: ReplaceWriterRequest): Promise<ReplaceWriterResult> {
		const { index, log } = this.#deps;
		const fence = this.#fences.get(request.token.serial);
		const progress = { stopDispatched: false, writerGone: false };
		const admitted = Promise.withResolvers<void>();
		let abandoned = false;
		try {
			const running = index.lifecycle.run(request.conversation, async (lease): Promise<ReplaceWriterResult> => {
				admitted.resolve();
				// A caller that gave up waiting for the gate (see `bounded`) is not served late.
				if (abandoned) return { status: "refused", code: "target-changed", ...progress };
				return await this.#replace(request, lease, progress);
			});
			if (request.bounded === true) {
				try {
					await withSessionReadDeadline(admitted.promise);
				} catch (error) {
					abandoned = true;
					running.catch(() => undefined);
					throw error;
				}
			}
			return await running;
		} catch (error) {
			log(`tab ${request.conversation}: replacing the writer failed: ${messageOf(error)}`);
			return { status: "failed", detail: messageOf(error), ...progress };
		} finally {
			if (fence !== undefined) fence.keep = request.stop.kind === "force" ? progress.stopDispatched && !progress.writerGone : progress.stopDispatched;
		}
	}

	async #replace(request: ReplaceWriterRequest, lease: TabLifecycleLease, progress: { stopDispatched: boolean; writerGone: boolean }): Promise<ReplaceWriterResult> {
		const { index, window, chat, control, exit, log } = this.#deps;
		const tabId = request.conversation;
		const refused = (code: Extract<ReplaceWriterResult, { status: "refused" }>["code"], detail?: string): ReplaceWriterResult =>
			({ status: "refused", code, ...(detail === undefined ? {} : { detail }), ...progress });
		const record = this.#deps.records.get(tabId);
		const runtime = record?.runtime ?? null;
		const binding = index.slotBinding(request.binding.slot);
		if (record === undefined || runtime === null || record.tabId !== tabId || this.attachmentOf(runtime) !== request.target ||
			binding === null || binding.generation !== request.binding.generation || binding.tabId !== tabId) return refused("target-changed");
		if (request.stop.kind === "force" && (await readSessionFileHeader(request.stop.file))?.sessionId !== request.stop.durableSessionId) return refused("target-changed");
		if (!(await window.check(request.token, "gate"))) return refused("target-changed");
		let fresh: SessionTransitionFacts | null = null;
		if (request.stop.kind === "graceful") {
			const { captured, consent } = request.stop;
			fresh = await this.#deps.stop.readTransitionFacts(record, runtime);
			if (fresh === null || fresh.epoch !== captured.epoch || fresh.sessionId !== captured.sessionId || fresh.file !== captured.file || (!fresh.settled && !consent)) return refused("facts-changed");
			if (fresh.file !== null && await readSessionFileHeader(fresh.file) === null && fresh.hasContent !== false) return refused("not-durable");
		}
		const broker = await this.#deps.attachBrokerClient();
		if (request.stop.kind === "graceful") {
			if (broker === null || runtime.identity.childCreationTime === null) return refused("no-broker");
		} else if (broker === null || !(await window.check(request.token, "attached"))) {
			return refused("no-broker");
		}
		const row = index.get(tabId);
		let verdict: NativeStopVerdict;
		if (request.stop.kind === "force") {
			if (runtime.kind !== "chat") return refused("target-changed", "A forced replacement is only defined for a Chat runtime.");
			progress.stopDispatched = true;
			const requested = await withSessionReadDeadline(stopRpcHost(runtime, "force"), 35_000);
			verdict = await waitForManagedRootExit(runtime, broker as PtyBrokerClient, 5_000);
			log(`tab ${tabId}: explicit Restart stop: ${verdict.diagnosticDetail ?? verdict.detail}; request: ${requested.diagnosticDetail ?? requested.detail}`);
			if (!verdict.writerGone) return { status: "unconfirmed", detail: verdict.detail, stopDispatched: true, writerGone: false };
			progress.writerGone = true;
			if (!(await window.check(request.token, "stopped"))) return refused("checked-after-stop");
		} else {
			const stopped = await this.#stopGraceful(record, runtime, broker as PtyBrokerClient, request.stop, fresh as SessionTransitionFacts, progress);
			if ("refusal" in stopped) return stopped.refusal;
			verdict = stopped.verdict;
			log(`tab ${tabId}: view switch stop: ${verdict.diagnosticDetail ?? verdict.detail}`);
			if (!verdict.writerGone) verdict = await this.#deps.stop.confirmEnded(runtime) ?? verdict;
			if (!verdict.writerGone) return { status: "unconfirmed", detail: verdict.detail, stopDispatched: true, writerGone: false };
			progress.writerGone = true;
		}
		const owner = controlOwnerFor(runtime, row?.ownership?.ownerGeneration ?? "");
		this.#end(record);
		await control.release(tabId, owner);
		await exit.retireBroker(tabId, runtime);
		chat.release(tabId);
		const file = request.stop.kind === "graceful" ? (fresh as SessionTransitionFacts).file : request.stop.file;
		const afterExit = file === null ? null : await readSessionFileHeader(file);
		if (request.stop.kind === "graceful") {
			if (afterExit !== null && index.get(tabId)?.sessionFile === null) await index.promoteDraft(tabId, file as string, lease);
			if (row?.sessionFile !== null && afterExit === null) {
				await index.closeSession(tabId, { confirmedStopped: true, detail: "The durable file is missing after disposal; no successor was launched." }, lease);
				return { status: "closed", code: "file-missing", stopDispatched: true, writerGone: true };
			}
		} else if (afterExit?.sessionId !== request.stop.durableSessionId) {
			await index.closeSession(tabId, { confirmedStopped: true, detail: "The exact saved conversation is unavailable after disposal; no successor was launched." }, lease);
			return { status: "closed", code: "file-missing", stopDispatched: true, writerGone: true };
		}
		await window.prepare(request.token);
		const outcome: RestoreOutcome = await index.replaceHost(tabId, {
			confirmedStopped: true,
			expectedPid: runtime.pid,
			expectedCreationTime: runtime.identity.childCreationTime as string,
			mode: request.mode,
			slotId: request.binding.slot,
			emptyFile: file,
			launcher: this.#deps.launcher(),
		}, lease);
		if (outcome.status === "failed" && this.#deps.records.get(tabId)?.runtime === null) {
			await index.closeSession(tabId, { confirmedStopped: true, detail: outcome.detail }, lease);
		}
		return { status: "replaced", outcome, stopDispatched: true, writerGone: true };
	}

	/** The graceful stop of a view switch: native shutdown through host control, or abort, settle and a graceful RPC stop. */
	async #stopGraceful(
		record: RuntimeRecord, runtime: SessionHostRuntime, broker: PtyBrokerClient,
		stop: Extract<ReplaceWriterRequest["stop"], { kind: "graceful" }>, fresh: SessionTransitionFacts,
		progress: { stopDispatched: boolean; writerGone: boolean },
	): Promise<{ readonly verdict: NativeStopVerdict } | { readonly refusal: ReplaceWriterResult }> {
		const { chat, stop: ops } = this.#deps;
		const tabId = record.tabId as string;
		const refusal = (code: Extract<ReplaceWriterResult, { status: "refused" }>["code"]): { refusal: ReplaceWriterResult } =>
			({ refusal: { status: "refused", code, ...progress } });
		if (runtime.kind === "terminal") {
			const client = record.control?.client;
			if (client === undefined || !isOpenControlClient(client) || fresh.nativeTarget === null) return refusal("no-control");
			runtime.stopping = true;
			progress.stopDispatched = true; // An unanswered authenticated request may already have committed.
			const status = await withSessionReadDeadline(client.nativeShutdown(fresh.nativeTarget, stop.consent));
			if (status !== "accepted" && status !== "accepted-deferred") {
				runtime.stopping = false;
				progress.stopDispatched = false;
				this.#deps.log(`tab ${tabId}: native shutdown was refused (${status})`);
				return { refusal: { status: "refused", code: "native-refused", detail: status, ...progress } };
			}
			return { verdict: await waitForManagedRootExit(runtime, broker) };
		}
		// An abort or a settlement that a process which already ended cannot give is not a refusal: the proof of its root is the answer.
		let ended: NativeStopVerdict | null = null;
		if (stop.consent) {
			const abort = await withSessionReadDeadline(chat.sessionOf(tabId)?.abortForShutdown() ?? Promise.resolve(undefined));
			if (abort?.status !== "accepted") {
				ended = await ops.confirmEnded(runtime);
				if (ended === null) return refusal("abort-unconfirmed");
			}
		}
		if (ended === null && await ops.awaitSettled(record, runtime, fresh) === null) {
			ended = await ops.confirmEnded(runtime);
			if (ended === null) return refusal("settle-failed");
		}
		if (ended !== null) return { verdict: ended };
		progress.stopDispatched = true;
		const requested = await withSessionReadDeadline(stopRpcHost(runtime, "graceful"), 35_000);
		return { verdict: requested.writerGone ? await waitForManagedRootExit(runtime, broker, 5_000) : requested };
	}

	/** Raise or lower the fence of a conversation: the flag, the chat session's mutation fence, the window's projection. */
	#raise(conversation: string, on: boolean): void {
		const { window, chat } = this.#deps;
		const record = this.#deps.records.get(conversation);
		if (record !== undefined) record.transitioning = on;
		chat.sessionOf(conversation)?.setMutationFence(on ? TRANSITION_FENCE_REASON : null);
		window.fenced(conversation, on);
	}

	/** The old runtime of a stopped writer leaves its record: its watch, its frontend. */
	#end(record: RuntimeRecord): void {
		record.nativeWatch?.();
		record.nativeWatch = null;
		record.runtime = null;
		this.#deps.window.endTerminal(record);
	}
}
