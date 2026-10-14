/**
 * The end of a process for the in-process runtime (ADR-0066, cut 5): a chat or native OMP process
 * that ended without this window asking for it, a broker that was ended from outside, and the
 * recording of an exit for a session whose recorded root is already gone (`endEnded`).
 *
 * One lifecycle operation each: clear the runtime, prove the exit through the broker, release
 * control material and the claim, record the stopped intent. A close, reload or relaunch that
 * reached the tab's gate first replaced or cleared the runtime, and the notification then
 * describes a process this window no longer drives, so it does nothing. The handlers take the
 * tab's gate themselves, so they are called outside it; what the window shows (notices, the
 * terminal pane, the session view, the launcher) is its hooks, run after the state they describe
 * is committed.
 */
import { setTimeout as delay } from "node:timers/promises";
import type { Logger } from "../shared/logger.ts";
import { waitForManagedRootExit } from "../host/native-session.ts";
import type { NativeHostRuntime, SessionHostRuntime } from "../host/native-session.ts";
import type { PtyBrokerClient } from "../host/pty-client.ts";
import { retireStoppedRpcBroker } from "../host/rpc-launch.ts";
import type { RpcHostRuntime } from "../host/rpc-launch.ts";
import type { BrokerSlotStore } from "../host/broker-slots.ts";
import type { SessionIndex } from "../host/session-index.ts";
import { controlOwnerFor } from "./local-control.ts";
import type { LocalHostControl } from "./local-control.ts";
import type { StopOperations } from "./local-stop.ts";
import type { RuntimeRecord, RuntimeRecords } from "./runtime-record.ts";

/** What the end of a process asks of its window; in-process only (design §2.5). Hooks never wait for the user. */
export interface ExitWindow {
	/** Whether the window has been activated; before that nothing can be recorded. */
	activated(): boolean;
	/** Raise (or lower) the window's admission fence: the transition flag and the chat session's mutation fence. */
	fence(record: RuntimeRecord, on: boolean): void;
	/** The conversation's last restore outcome described a host that is no longer running. */
	forgetOutcome(conversation: string): void;
	/** Drop the record's terminal frontend; the broker keeps running. */
	endTerminal(record: RuntimeRecord): void;
	/** The window's projection of the record changed. */
	view(record: RuntimeRecord): void;
	/** The sessions catalogue changed. */
	refresh(): void;
	/** A native exit was recorded: drop the conversation's outcome and turn activity and refresh the guest context. */
	nativeEnded(conversation: string): void;
	/** Fire-and-forget: never awaited, so an unanswered notification cannot hold the gate. */
	notice(level: "warning" | "error", text: string): void;
}

export interface LocalExitDeps {
	readonly index: SessionIndex;
	readonly window: ExitWindow;
	readonly records: RuntimeRecords;
	readonly control: Pick<LocalHostControl, "release" | "dispose">;
	readonly stop: Pick<StopOperations, "confirmEnded">;
	readonly attachBrokerClient: () => Promise<PtyBrokerClient | null>;
	/** The durable broker slot table, `undefined` before activation created it. */
	readonly brokerSlots: () => BrokerSlotStore | undefined;
	readonly log: Logger;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class LocalExitOperations {
	readonly #deps: LocalExitDeps;

	constructor(deps: LocalExitDeps) {
		this.#deps = deps;
	}

	/**
	 * Shut down the broker of a host this window just proved stopped, and forget its slot.
	 *
	 * See `retireStoppedRpcBroker`: without this the broker outlives its child for as long as
	 * the machine runs. A refusal (the child not proven gone) leaves the broker and its slot exactly
	 * as they were, and is only logged.
	 */
	async retireBroker(tabId: string, runtime: SessionHostRuntime): Promise<void> {
		const result = await retireStoppedRpcBroker(runtime);
		this.#deps.log.info(`tab ${tabId}: ${result.detail}`);
		if (result.retired) await this.#deps.brokerSlots()?.forget(runtime.identity.slot).catch(() => undefined);
	}

	/**
	 * The chat process of a tab ended without this window asking for it.
	 *
	 * One lifecycle operation: clearing the runtime, proving the exit through the broker,
	 * releasing control material and the claim, and recording the stopped intent.
	 */
	async rpcExited(tabId: string, runtime: RpcHostRuntime): Promise<void> {
		const { index, window, control, log } = this.#deps;
		// Report-only boundary for the whole transaction: a failure after the runtime was cleared
		// (stopping its terminal, disposing control) must still be visible, and the broker watch
		// stops waiting once the runtime is gone. Nothing is mutated here: a replacement runtime
		// may already own the tab.
		await index.lifecycle.run(tabId, async lease => {
			const current = this.#deps.records.get(tabId);
			if (current === undefined || current.runtime !== runtime) return;
			// The tab's last restore outcome described a host that is no longer running; what
			// the index records from here on is the launcher's status.
			window.forgetOutcome(tabId);
			const ownerGeneration = index.get(tabId)?.ownership?.ownerGeneration ?? null;
			log.info(`tab ${tabId}: the OMP process exited`);
			const broker = await this.#deps.attachBrokerClient();
			if (broker === null) { window.fence(current, true); return; }
			const stop = await waitForManagedRootExit(runtime, broker, 1_000);
			log.info(`native exit ${runtime.pid}: ${stop.diagnosticDetail ?? stop.detail}`);
			if (!stop.writerGone) {
				current.controlFailure = stop.detail;
				window.fence(current, true);
				return;
			}
			current.runtime = null;
			window.endTerminal(current);
			current.transitioning = false;
			control.dispose(current);
			try {
				await this.retireBroker(tabId, runtime);
				// A writer that exited is a stopped session: the durable intent is what keeps its
				// row stopped across a reload instead of being re-launched.
				await index.setRunIntent(tabId, "stopped", stop.detail);
				// Control material is dropped only for a stop this window can prove.
				if (stop.writerGone) await control.release(tabId, ownerGeneration);
				else current.controlFailure = stop.detail;
			} catch (error) {
				log.error(`tab ${tabId}: the exit of the OMP process could not be recorded: ${messageOf(error)}`);
				window.notice("error", `The OMP process exited, but its session could not be recorded as stopped: ${messageOf(error)}. Refresh Sessions before resuming it.`);
				window.view(current);
				window.refresh();
				return;
			}
			try {
				const result = await index.closeSession(tabId, { confirmedStopped: stop.writerGone, detail: stop.detail }, lease);
				log.info(`tab ${tabId}: closeSession released=${result.released} (${result.detail})`);
				if (!result.released) {
					window.notice(
						"error",
						"This session could not finish closing. Refresh Sessions before resuming it; see OMP Desk output for details.",
					);
				}
			} catch (error) {
				log.error(`tab ${tabId}: closeSession failed: ${messageOf(error)}`);
				window.notice("error", `Session ownership could not be reconciled after the OMP process exited: ${messageOf(error)}`);
			}
			window.view(current);
			window.refresh();
		}).catch((error: unknown) => {
			log.error(`tab ${tabId}: the exit of the OMP process could not be completed: ${messageOf(error)}`);
			window.notice("error", `The OMP process exited, but OMP Desk could not finish closing its session: ${messageOf(error)}. Refresh Sessions before resuming it.`);
		});
	}

	/** The native process of a record ended without this window asking for it. */
	async nativeExited(state: RuntimeRecord, runtime: NativeHostRuntime): Promise<void> {
		const { index, window, control, log } = this.#deps;
		const tabId = state.tabId;
		if (tabId === null || !window.activated()) return;
		await index.lifecycle.run(tabId, async lease => {
			if (state.runtime !== runtime || state.tabId !== tabId) return;
			if (runtime.observedSurvivors.length > 0) {
				state.controlFailure = `The root exited, but the broker observed surviving processes (${runtime.observedSurvivors.join(", ")}). A successor is refused; use explicit Stop to recheck.`;
				window.view(state);
				return;
			}
			const client = await this.#deps.attachBrokerClient();
			if (client === null) return;
			const stop = await waitForManagedRootExit(runtime, client, 1_000);
			log.info(`native exit ${runtime.pid}: ${stop.diagnosticDetail ?? stop.detail}`);
			if (!stop.writerGone) { state.controlFailure = stop.detail; return; }
			const owner = controlOwnerFor(runtime, index.get(tabId)?.ownership?.ownerGeneration ?? "");
			state.runtime = null;
			window.endTerminal(state);
			state.nativeWatch?.();
			state.nativeWatch = null;
			state.transitioning = false;
			await control.release(tabId, owner);
			await index.setRunIntent(tabId, "stopped", stop.detail);
			await index.closeSession(tabId, { confirmedStopped: true, detail: stop.detail }, lease);
			window.nativeEnded(tabId);
		});
	}

	/**
	 * End the runtime of a session whose recorded OMP root is already gone, the way its exit would have ended it
	 * (`rpcExited`, `nativeExited`: runtime cleared, credentials and claim released, row recorded stopped),
	 * so that a request made for a stopped session can follow. `false` when the root is not proven gone or the exit could
	 * not be completed (surviving children, no proof through the broker): the caller then reports what it found.
	 * Call it outside the tab's lifecycle gate, which both handlers take.
	 */
	async endEnded(state: RuntimeRecord, runtime: SessionHostRuntime): Promise<boolean> {
		const tabId = state.tabId;
		if (tabId === null || state.runtime !== runtime || await this.#deps.stop.confirmEnded(runtime) === null) return false;
		try {
			if (runtime.kind === "chat") await this.rpcExited(tabId, runtime);
			else await this.nativeExited(state, runtime);
		} catch (error) {
			this.#deps.log.warn(`tab ${tabId}: the session whose OMP process already ended could not be closed: ${messageOf(error)}`);
		}
		return state.runtime !== runtime;
	}

	/**
	 * The broker of a runtime this window drives was ended from outside (Kill in Sessions, Task
	 * Manager, a crash) and `proven` says whether its OMP process is gone too (the detection is the
	 * launcher's broker watch). Called outside the gate.
	 */
	async brokerLost(tabId: string, runtime: SessionHostRuntime, proven: boolean): Promise<void> {
		const { window, log } = this.#deps;
		const isCurrent = (): boolean => this.#deps.records.get(tabId)?.runtime === runtime;
		if (!proven) {
			log.warn(`tab ${tabId}: the broker process is gone but its OMP process pid ${runtime.pid} could not be confirmed gone; the session is kept as it is`);
			window.notice("warning", "A session's background process ended, but its OMP process could not be confirmed ended. Check Task Manager, then use Stop Session or refresh Sessions.");
			return;
		}
		log.info(`tab ${tabId}: the broker process and the OMP process pid ${runtime.pid} are gone`);
		const incomplete = (why: string): void => {
			log.warn(`tab ${tabId}: the broker and the OMP process are gone but the session's exit could not be completed (${why}); the session is kept as it is`);
			window.notice("warning", "A session's process ended, but its exit could not be recorded. Refresh Sessions or reopen the session.");
		};
		try {
			if (runtime.kind === "chat") {
				runtime.handle.brokerGone();
				// The exit handling runs from the channel's close; it is complete when the runtime is no longer this window's.
				for (let look = 0; look < 40 && isCurrent(); look++) await delay(250);
				if (isCurrent()) incomplete("it did not finish within 10 s");
				return;
			}
			const state = this.#deps.records.get(tabId);
			if (state !== undefined) {
				// The pane ends as for an exit the broker reported, not as a lost connection; stale control errors
				// from the moments before the process ended are dropped once the exit has been recorded.
				state.endedNotice = "This terminal's process has ended.";
				state.pipeline?.noteProcessGone();
				await this.nativeExited(state, runtime);
				if (isCurrent()) incomplete("the terminal's exit handling left its runtime in place");
				else {
					state.controlFailure = null;
					window.view(state);
				}
			}
		} catch (error) {
			incomplete(messageOf(error));
		}
	}
}
