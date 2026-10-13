/**
 * The stop verdict operations of the in-process runtime (ADR-0066, design §2.5 and cut 4): ask the
 * exact process a tab drives to stop and report the truthful verdict, read the facts a stop is
 * confirmed against, wait for a chat session to settle, and recognise a root that already ended.
 *
 * These are verdict-only and take no lifecycle gate: every caller already holds the tab's lease and
 * records the outcome under it (the stopped intent, closing the session), so recording stays in the
 * callers. They are `LocalSessionRuntime` members only until the gated `stop` replaces them (cut 7).
 *
 * The window's tab record is reached through the structural `StopRecord`: the runtime reads the
 * record's runtime (the identity check `record.runtime === runtime` of every confirmation), its
 * control client, and raises the raw fence a native stop raises (`transitioning`, the pipeline's
 * read-only note), never `fenceSessionAdmission`.
 */
import { isOpenControlClient } from "../host/control-attempt.ts";
import type { HostControlClient } from "../host/control-client.ts";
import type { ChatRuntime } from "../host/chat-runtime.ts";
import { waitForManagedRootExit } from "../host/native-session.ts";
import type { SessionHostRuntime, SessionTransitionFacts } from "../host/native-session.ts";
import type { PtyBrokerClient } from "../host/pty-client.ts";
import type { NativeStopVerdict } from "../host/rpc-reconcile.ts";
import { stopRpcHost } from "../host/rpc-launch.ts";

/** The part of the window's tab record the stop operations read and the raw fence they raise. */
export interface StopRecord {
	readonly tabId: string | null;
	readonly runtime: SessionHostRuntime | null;
	readonly control: { readonly client: HostControlClient } | null;
	/** Raised by a native stop; the window's admission fence is a different, wider operation. */
	transitioning: boolean;
	readonly pipeline: { noteReadOnly(reason: string): void } | null;
}

export interface LocalStopDeps {
	readonly chat: () => Pick<ChatRuntime, "sessionOf">;
	readonly attachBrokerClient: () => Promise<PtyBrokerClient | null>;
	/** Whether the recorded OMP root is gone; read at call time. */
	readonly rootGone: (root: { readonly pid: number; readonly creationTime: string | null }) => Promise<boolean>;
	readonly log: (message: string) => void;
}

export const SESSION_TRANSITION_READ_TIMEOUT_MS = 10_000;

/** Bound readback and gate admission, not a destructive transaction or a user's dialog. */
export async function withSessionReadDeadline<T>(read: Promise<T>, timeoutMs = SESSION_TRANSITION_READ_TIMEOUT_MS): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			read,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error("Session state read timed out.")), timeoutMs);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** What `LocalSessionRuntime` delegates its stop verdict operations to. */
export interface StopOperations {
	requestStop(state: StopRecord, runtime: SessionHostRuntime, mode: "graceful" | "force", consent: boolean, expected?: SessionTransitionFacts | null): Promise<NativeStopVerdict>;
	confirmEnded(runtime: SessionHostRuntime): Promise<NativeStopVerdict | null>;
	awaitSettled(state: StopRecord, runtime: SessionHostRuntime, expected: SessionTransitionFacts): Promise<SessionTransitionFacts | null>;
	readTransitionFacts(state: StopRecord, runtime: SessionHostRuntime): Promise<SessionTransitionFacts | null>;
}

export class LocalStopOperations implements StopOperations {
	readonly #deps: LocalStopDeps;

	constructor(deps: LocalStopDeps) {
		this.#deps = deps;
	}

	/**
	 * Stop a session's process, or recognize that it already ended.
	 *
	 * A stop that could not be confirmed (the broker was killed or crashed, the process cannot be reached, OMP did not
	 * answer) is not yet a failure: when the recorded OMP root is proven gone (`recordedRootGone`: its id unused, or now
	 * another process's), the writer is gone and the session is stopped, so Close, Stop and Reload finish normally
	 * instead of asking for a Force Stop that has nothing left to stop.
	 */
	async requestStop(state: StopRecord, runtime: SessionHostRuntime, mode: "graceful" | "force", consent: boolean, expected?: SessionTransitionFacts | null): Promise<NativeStopVerdict> {
		const verdict = await this.#requestSessionStop(state, runtime, mode, consent, expected);
		return verdict.writerGone ? verdict : await this.confirmEnded(runtime) ?? verdict;
	}

	/** A verdict for a runtime whose recorded OMP root is already gone, or `null` when that cannot be shown. */
	async confirmEnded(runtime: SessionHostRuntime): Promise<NativeStopVerdict | null> {
		const root = { pid: runtime.pid, creationTime: runtime.identity.childCreationTime };
		if (!await this.#deps.rootGone(root)) return null;
		return {
			writerGone: true,
			treeEmpty: false,
			detail: "The OMP process had already ended.",
			diagnosticDetail: `The stop was not confirmed by the broker, but the recorded OMP root pid ${root.pid} is gone.`,
		};
	}

	async awaitSettled(state: StopRecord, runtime: SessionHostRuntime, expected: SessionTransitionFacts): Promise<SessionTransitionFacts | null> {
		const deadline = Date.now() + 5_000;
		do {
			const last = await this.readTransitionFacts(state, runtime);
			if (last === null || last.epoch !== expected.epoch || last.file !== expected.file || last.sessionId !== expected.sessionId) return null;
			if (last.settled) return last;
			await new Promise<void>(resolve => setTimeout(resolve, 50));
		} while (Date.now() < deadline);
		return null;
	}

	async readTransitionFacts(state: StopRecord, runtime: SessionHostRuntime): Promise<SessionTransitionFacts | null> {
		if (state.tabId === null || state.runtime !== runtime) return null;
		if (runtime.kind === "chat") {
			const session = this.#deps.chat().sessionOf(state.tabId);
			if (session === null) return null;
			const facts = await withSessionReadDeadline(session.readSettlement());
			return facts === null ? null : { file: facts.sessionFile, sessionId: facts.sessionId, epoch: `${session.epoch.nonce}:${session.epoch.counter}`, settled: facts.settled, hasContent: facts.hasContent, nativeTarget: null };
		}
		const client = state.control?.client;
		if (client === undefined || !isOpenControlClient(client)) return null;
		const snapshot = await withSessionReadDeadline(client.snapshot());
		const facts = await withSessionReadDeadline(client.nativeState(true));
		if (!facts.available) return null;
		runtime.observed = facts;
		const target = { epoch: snapshot.host.epoch, sessionFile: facts.sessionFile, sessionId: facts.sessionId };
		return { file: facts.sessionFile, sessionId: facts.sessionId, epoch: target.epoch, settled: facts.settled === true, hasContent: facts.hasContent, nativeTarget: target };
	}

	/** Native graceful shutdown is an SDK request, never a ConPTY close. */
	async #requestSessionStop(state: StopRecord, runtime: SessionHostRuntime, mode: "graceful" | "force", consent: boolean, expected?: SessionTransitionFacts | null): Promise<NativeStopVerdict> {
		const { log } = this.#deps;
		if (runtime.kind === "chat") {
			const broker = await this.#deps.attachBrokerClient();
			if (broker === null) return { writerGone: false, treeEmpty: false, detail: "This session is disconnected. Reopen its editor and try Stop again." };
			if (mode === "graceful") {
				const captured = expected ?? await this.readTransitionFacts(state, runtime);
				if (captured === null) return { writerGone: false, treeEmpty: false, detail: "The running session could not be checked. Reopen its editor and try Stop again." };
				if (!captured.settled && !consent) return { writerGone: false, treeEmpty: false, detail: "OMP is busy. Confirm that you want to abort the current turn before stopping." };
				if (!captured.settled) {
					const abort = await this.#deps.chat().sessionOf(state.tabId ?? "")?.abortForShutdown();
					if (abort?.status !== "accepted") return { writerGone: false, treeEmpty: false, detail: "OMP did not confirm aborting the turn. Try Stop again." };
				}
				if (await this.awaitSettled(state, runtime, captured) === null) return { writerGone: false, treeEmpty: false, detail: "OMP is still finishing work, or the session changed. Nothing was replaced; try again when it is idle." };
			}
			const stopped = await stopRpcHost(runtime, mode);
			return stopped.writerGone ? await waitForManagedRootExit(runtime, broker, 5_000) : stopped;
		}
		const broker = await this.#deps.attachBrokerClient();
		if (broker === null) return { writerGone: false, treeEmpty: false, detail: "This session is disconnected. Reopen its editor and try Stop again." };
		try {
			if (mode === "force") {
				runtime.stopping = true;
				state.transitioning = true;
				const forced = await runtime.handle.stop({ mode: "force", timeoutMs: 5_000 });
				runtime.observedSurvivors = forced.remainingPids;
				if (forced.remainingPids.length > 0) {
					log(`native force stop: remaining pids ${forced.remainingPids.join(", ")}`);
					return { writerGone: false, treeEmpty: false, detail: "Some commands are still running. Nothing was restarted; try Stop again." };
				}
				return await waitForManagedRootExit(runtime, broker, 5_000);
			}
			const control = state.control?.client;
			if (control === undefined || !isOpenControlClient(control)) return { writerGone: false, treeEmpty: false, detail: "This Terminal is disconnected. Use /exit there, or choose Force Stop. Commands it started may continue running separately; no replacement is started." };
			const snapshot = await control.snapshot();
			const facts = await control.nativeState();
			if (!facts.available) return { writerGone: false, treeEmpty: false, detail: facts.unavailableReason ?? "Native shutdown is unsupported by this host." };
			if (expected !== undefined && (expected === null || expected.epoch !== snapshot.host.epoch || expected.file !== facts.sessionFile || expected.sessionId !== facts.sessionId)) {
				return { writerGone: false, treeEmpty: false, detail: "The native target changed after confirmation; nothing was stopped." };
			}
			runtime.stopping = true; // A lost acknowledgement may already have committed shutdown.
			state.transitioning = true;
			state.pipeline?.noteReadOnly("Native OMP is stopping; queued or background work may still be finishing.");
			const status = await control.nativeShutdown({ epoch: snapshot.host.epoch, sessionFile: facts.sessionFile, sessionId: facts.sessionId }, consent);
			if (status !== "accepted" && status !== "accepted-deferred") {
				runtime.stopping = false;
				log(`native shutdown refused: ${status}`);
				return { writerGone: false, treeEmpty: false, detail: "OMP did not accept the stop request. Try Stop again; nothing was restarted." };
			}
			return await waitForManagedRootExit(runtime, broker);
		} catch (error) {
			log(`native shutdown unconfirmed: ${messageOf(error)}`);
			return { writerGone: false, treeEmpty: false, detail: "The session could not be confirmed stopped. Check its Terminal before trying Stop again; see OMP Desk output for details." };
		}
	}
}
