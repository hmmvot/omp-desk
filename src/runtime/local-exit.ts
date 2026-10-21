/**
 * The end of a process for the in-process runtime (ADR-0066, cut 5): a chat or native OMP process
 * that ended without this window asking for it, a broker that was ended from outside, and the
 * recording of an exit for a session whose recorded root is already gone (`endEnded`).
 *
 * One lifecycle operation each: clear the runtime, prove the exit (through the broker, else the operating
 * system's own view of the process), release control material and the claim, and record the end. A normal
 * exit (code 0, OMP's own `/exit`) records the stopped intent, and so does an end of a row that already
 * records it (the user's Kill or Stop wrote it first, so the end is that stop and not a crash); any other end
 * (a crash, the operating system ending the session) leaves the run intent as it was, so the next startup
 * relaunches the session. A close, reload or relaunch that reached the tab's gate first replaced or
 * cleared the runtime, and the notification then describes a process this window no longer drives, so it
 * does nothing. The handlers take the tab's gate themselves, so they are called outside it; what the
 * window shows (notices, the terminal pane, the session view, the launcher) is its hooks, run after the
 * state they describe is committed.
 *
 * Every await of the proof is bounded (`EXIT_PROOF_DEADLINE_MS`): a broker or a kernel probe that never
 * answers must not leave the row `Running` for as long as the window lives, and a step that did not
 * answer is logged and never counts as the process being gone.
 */
import { setImmediate as nextTurn, setTimeout as delay } from "node:timers/promises";
import type { Logger } from "../shared/logger.ts";
import type { NativeHostRuntime, SessionHostRuntime } from "../host/native-session.ts";
import type { PtyBrokerClient } from "../host/pty-client.ts";
import { retireStoppedRpcBroker } from "../host/rpc-launch.ts";
import type { RpcHostRuntime } from "../host/rpc-launch.ts";
import type { BrokerSlotStore } from "../host/broker-slots.ts";
import type { SessionIndex } from "../host/session-index.ts";
import type { NativeStopVerdict } from "../host/rpc-reconcile.ts";
import type { RunIntent } from "../host/session-model.ts";
import { controlOwnerFor } from "./local-control.ts";
import type { LocalHostControl } from "./local-control.ts";
import { withSessionReadDeadline } from "./local-stop.ts";
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
	/** Proves the exact OMP root gone through the broker and reports how it ended (`waitForManagedRootExit`). */
	readonly proveExit: (runtime: SessionHostRuntime, client: PtyBrokerClient, timeoutMs: number) => Promise<NativeStopVerdict>;
	/** The durable broker slot table, `undefined` before activation created it. */
	readonly brokerSlots: () => BrokerSlotStore | undefined;
	readonly log: Logger;
	/** How long each await of the exit proof may take (`EXIT_PROOF_DEADLINE_MS` when absent); a test shortens it. */
	readonly proofDeadlineMs?: number;
}

/**
 * How long each await of an exit proof (the broker client, the broker's reading of the exit, the kernel's
 * check of the root) may take before the proof goes on without it. The logs show hosts that stall for
 * seconds, so the bound is generous; it exists for the await that never settles, which left a session
 * `Running` until the user killed it.
 */
export const EXIT_PROOF_DEADLINE_MS = 3_000;

/** The broker's own bound for reading how the root exited; `EXIT_PROOF_DEADLINE_MS` guards what its reads await. */
const BROKER_EXIT_READ_MS = 1_000;

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** What one bounded await came to: its value, the failure it threw, or no answer within the deadline. */
type Bounded<T> =
	| { readonly kind: "value"; readonly value: T }
	| { readonly kind: "failed"; readonly reason: string }
	| { readonly kind: "deadline" };

/**
 * Await `work` for at most `deadlineMs` (`withSessionReadDeadline`) and report how it ended; never rejects, and
 * a work that outlives its deadline is only abandoned (it cannot be cancelled), so it must be read-only.
 */
async function bounded<T>(work: () => Promise<T>, deadlineMs: number): Promise<Bounded<T>> {
	const settled: { outcome: Bounded<T> | null } = { outcome: null };
	const answer = Promise.resolve().then(work).then<Bounded<T>, Bounded<T>>(
		value => (settled.outcome = { kind: "value", value }),
		(error: unknown) => (settled.outcome = { kind: "failed", reason: messageOf(error) }),
	);
	try {
		return await withSessionReadDeadline(answer, deadlineMs);
	} catch {
		// After a stall of the extension host the deadline's timer runs before the answers that arrived meanwhile are
		// delivered; one turn of the event loop lets them in before the step is given up.
		await nextTurn();
		return settled.outcome ?? { kind: "deadline" };
	}
}

/** What the end of an OMP process means for its row: the durable run intent, and the sentences that say so. */
export interface ExitOutcome {
	/** `"stopped"` for the user's own exit, `"unchanged"` for anything else (`CloseSessionOptions.runIntent`). */
	readonly intent: "stopped" | "unchanged";
	/** The row's detail. */
	readonly detail: string;
	/** The Output line. */
	readonly log: string;
}

/**
 * Classify the end of a process OMP Desk did not ask to end.
 *
 * A row that already records the stopped intent (`recorded`) was stopped by the user: Desk's Kill and a Stop of a
 * recorded host write the intent before they end the process, and the process dying after that is that stop, not a
 * crash, whatever the broker says (a Kill gives code 1, 4 or -1, or no answer from a broker killed with it). Nothing
 * relaunches such a row, so the sentences say so.
 *
 * Otherwise OMP's own ways out all leave through exit code 0: `/exit`, `/quit` and Ctrl+D in the terminal UI end
 * `shutdown()` with `postmortem.quit(0)`, and a Chat (RPC) child leaves `disposeAndExit` with `process.exit(0)`
 * once its stdin closes or an extension asks for shutdown. Everything else is not the user's decision to stop:
 * a non-zero code (the broker logs show `4` when Windows ends the session, `-1` with signal 15 for a forced
 * termination, `1` for a startup failure), a signal, no code, and no answer from the broker at all (it was killed
 * with the process). Those leave the run intent as recorded, so the next startup relaunches the row.
 *
 * `recorded` is the intent this window's copy of the row holds; a Kill or Stop another window recorded reaches it only
 * when the window adopts that row, which it does not while it drives the session.
 */
export function exitOutcome(stop: Pick<NativeStopVerdict, "exit" | "detail">, recorded: RunIntent | null = null): ExitOutcome {
	const exit = stop.exit;
	const how = exit === undefined
		? "the broker did not report how it ended"
		: exit.code === null && (exit.signal ?? 0) === 0
			? "it reported no exit code"
			: `exit code ${exit.code ?? "none"}${(exit.signal ?? 0) === 0 ? "" : `, signal ${exit.signal}`}`;
	if (recorded === "stopped") {
		return {
			intent: "stopped",
			detail: "The session was stopped. Resume to continue.",
			log: `user stop: OMP ended (${how}) after a Kill or Stop recorded the stopped intent for the row; it is not a crash, and nothing relaunches the row`,
		};
	}
	if (exit !== undefined && exit.code === 0 && (exit.signal ?? 0) === 0) {
		return { intent: "stopped", detail: stop.detail, log: "OMP exited normally (exit code 0); the row is recorded stopped" };
	}
	return {
		intent: "unchanged",
		detail: `The OMP process ended unexpectedly (${how}). The session restarts the next time VS Code starts; Resume starts it now.`,
		log: `OMP ended abnormally (${how}); the run intent stays as recorded, so the next startup relaunches the row`,
	};
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
	 * One lifecycle operation: clearing the runtime, proving the exit (through the broker, else the kernel; `#proveEnded`),
	 * retiring the broker, recording the end in one write (the host cleared and the claim released, with the
	 * run intent `exitOutcome` decides) and releasing control material.
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
			const stop = await this.#proveEnded(tabId, runtime);
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
			} catch (error) {
				log.error(`tab ${tabId}: the exit of the OMP process could not be recorded: ${messageOf(error)}`);
				window.notice("error", `The OMP process exited, but its session could not be closed: ${messageOf(error)}. Refresh Sessions before resuming it.`);
				window.view(current);
				window.refresh();
				return;
			}
			const outcome = exitOutcome(stop, index.get(tabId)?.runIntent ?? null);
			log.info(`tab ${tabId}: ${outcome.log}`);
			try {
				// The intent, the cleared host and the claim release are one record (`closeSession`): a window
				// killed between two writes can never leave a stopped intent beside a retained host.
				const result = await index.closeSession(tabId, { confirmedStopped: stop.writerGone, detail: outcome.detail, runIntent: outcome.intent }, lease);
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
			try {
				// Control material is dropped only for a stop this window can prove.
				await control.release(tabId, ownerGeneration);
			} catch (error) {
				log.error(`tab ${tabId}: host control could not be released after the OMP process exited: ${messageOf(error)}`);
			}
			window.view(current);
			window.refresh();
		}).catch((error: unknown) => {
			log.error(`tab ${tabId}: the exit of the OMP process could not be completed: ${messageOf(error)}`);
			window.notice("error", `The OMP process exited, but OMP Desk could not finish closing its session: ${messageOf(error)}. Refresh Sessions before resuming it.`);
		});
	}

	/**
	 * The broker's proof that the OMP root exited, else the kernel's. A broker that dies together with its
	 * child (Kill, a closing machine, Task Manager) closes the connection before it can answer, and that is
	 * no reason to leave the row Running when the recorded root's pid and creation time show it gone.
	 *
	 * Each await is bounded (`EXIT_PROOF_DEADLINE_MS`): a client that cannot be attached, a broker that does not
	 * answer and a kernel probe that does not answer each end their step and the proof goes on to the next. Only an
	 * answer proves the root gone; a step that failed or timed out never does, so the proof can end unproven, and the
	 * row then stays as it is. One Info line says how long each step took and what it came to.
	 */
	async #proveEnded(tabId: string, runtime: SessionHostRuntime): Promise<NativeStopVerdict> {
		const deadlineMs = this.#deps.proofDeadlineMs ?? EXIT_PROOF_DEADLINE_MS;
		const steps: string[] = [];
		const step = async <T>(name: string, work: () => Promise<T>, noteOf: (value: T) => string): Promise<T | null> => {
			const started = Date.now();
			const run = await bounded(work, deadlineMs);
			const took = `${name} ${Date.now() - started} ms`;
			steps.push(run.kind === "value" ? `${took}${noteOf(run.value)}` : run.kind === "failed" ? `${took} (failed: ${run.reason})` : `${took} (no answer within ${deadlineMs} ms)`);
			return run.kind === "value" ? run.value : null;
		};
		const concluded = (verdict: NativeStopVerdict): NativeStopVerdict => {
			this.#deps.log.info(`tab ${tabId}: exit proof: ${steps.join(", ")} -> ${verdict.writerGone ? "gone" : "not proven"}`);
			return verdict;
		};
		const client = await step("broker client", () => this.#deps.attachBrokerClient(), value => value === null ? " (unavailable)" : "");
		const proven = client === null ? null : await step("broker proof", () => this.#deps.proveExit(runtime, client, BROKER_EXIT_READ_MS), value => value.writerGone ? "" : " (writer not proven)");
		if (proven?.writerGone) return concluded(proven);
		const ended = await step("kernel root check", () => this.#deps.stop.confirmEnded(runtime), value => value === null ? " (root not shown gone)" : "");
		return concluded(ended ?? proven ?? {
			writerGone: false,
			treeEmpty: false,
			detail: "This session is disconnected. Reopen its editor and try Stop again.",
			diagnosticDetail: `Neither the PTY broker nor the kernel showed the exact OMP root pid ${runtime.pid} gone.`,
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
			const stop = await this.#proveEnded(tabId, runtime);
			log.info(`native exit ${runtime.pid}: ${stop.diagnosticDetail ?? stop.detail}`);
			if (!stop.writerGone) { state.controlFailure = stop.detail; return; }
			const owner = controlOwnerFor(runtime, index.get(tabId)?.ownership?.ownerGeneration ?? "");
			state.runtime = null;
			window.endTerminal(state);
			state.nativeWatch?.();
			state.nativeWatch = null;
			state.transitioning = false;
			await control.release(tabId, owner);
			const outcome = exitOutcome(stop, index.get(tabId)?.runIntent ?? null);
			log.info(`tab ${tabId}: ${outcome.log}`);
			await index.closeSession(tabId, { confirmedStopped: true, detail: outcome.detail, runIntent: outcome.intent }, lease);
			window.nativeEnded(tabId);
		});
	}

	/**
	 * End the runtime of a session whose recorded OMP root is already gone, the way its exit would have ended it
	 * (`rpcExited`, `nativeExited`: runtime cleared, credentials and claim released, row recorded stopped after a
	 * clean exit or a Kill or Stop that recorded the intent first, and left running after an abnormal one),
	 * so that a request made for a stopped session can follow. `false` when the root is not proven gone or the exit could
	 * not be completed (surviving children, no proof through the broker): the caller then reports what it found. The
	 * kernel's check is bounded like the proof of the exit (`#proveEnded`); an unanswered check is no proof.
	 * Call it outside the tab's lifecycle gate, which both handlers take.
	 */
	async endEnded(state: RuntimeRecord, runtime: SessionHostRuntime): Promise<boolean> {
		const tabId = state.tabId;
		if (tabId === null || state.runtime !== runtime) return false;
		const ended = await bounded(() => this.#deps.stop.confirmEnded(runtime), this.#deps.proofDeadlineMs ?? EXIT_PROOF_DEADLINE_MS);
		if (ended.kind !== "value") {
			this.#deps.log.warn(`tab ${tabId}: whether the OMP process already ended could not be read (${ended.kind === "failed" ? ended.reason : "no answer in time"})`);
			return false;
		}
		if (ended.value === null) return false;
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
