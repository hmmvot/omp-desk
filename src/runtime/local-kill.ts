/**
 * Kill (ADR-0060, amended; ADR-0066 cut 7): end the process tree of a session row or of a process
 * row at once, then record a killed session as stopped.
 *
 * What Kill is, and why it may signal a process id, is in `host/session-kill.ts`. This module only
 * builds its ports: the kernel identity readings and `taskkill` it ends trees with, the recorded process it
 * examines (this window's own runtime identity, else the index's record) and the recording that
 * follows a proven kill, through the index's incarnation-bound `reconcileKilledHost`. Everything the
 * user sees (the selection, the notifications, the launcher refreshes) is the window's, through
 * `KillWindow`.
 */
import { setTimeout as delay } from "node:timers/promises";
import type { Logger } from "../shared/logger.ts";
import type { BrokerProcessRow } from "../host/broker-processes.ts";
import type { BrokerSlotStore } from "../host/broker-slots.ts";
import { isPtyProcessAlive, queryPtyProcessIdentity, waitForPtyProcessGone } from "../host/pty-identity.ts";
import { killSelection, runTaskkillTree } from "../host/session-kill.ts";
import type { CapturedHost, KillSelection, RecordedProcess } from "../host/session-kill.ts";
import type { SessionIndex } from "../host/session-index.ts";
import { isManagedHost } from "../host/session-model.ts";
import type { RecordedRpcIdentity } from "../host/session-model.ts";
import { recordedControlOwner } from "./local-control.ts";
import type { LocalHostControl } from "./local-control.ts";

/** What Kill reads and shows through the window. */
export interface KillWindow {
	/** The identity of the RPC host this window's own runtime copy of a session records, or `null`. */
	runtimeIdentity(tabId: string): RecordedRpcIdentity | null;
	/** Drop the window's remembered stop outcome of a session. */
	forgetOutcome(tabId: string): void;
	/** A fresh read of the live broker rows; asked only for a session that recorded no host. */
	readRows(): Promise<readonly BrokerProcessRow[]>;
	/** The launcher changed (a broker slot was forgotten). */
	launcherChanged(): void;
	/** After a kill: refresh the launcher's ownership and the processes list. */
	refresh(): Promise<void>;
	notice(level: "info" | "warning", text: string): void;
	/** Names this window in the log: who asked for the kill. */
	requester(): string;
}

export interface LocalKillDeps {
	readonly index: SessionIndex;
	readonly control: LocalHostControl;
	readonly window: KillWindow;
	readonly brokerSlots: () => BrokerSlotStore | undefined;
	readonly log: Logger;
	/** End this window's own runtime of a session whose process Kill proved gone, as the process's exit would; `false` when there is none or it could not be ended. */
	readonly endDriven: (tabId: string) => Promise<boolean>;
}

export class LocalKill {
	readonly #deps: LocalKillDeps;

	constructor(deps: LocalKillDeps) {
		this.#deps = deps;
	}

	/** The Kill command: one selection in, the report out. Never throws. */
	kill(selection: KillSelection): Promise<void> {
		const { index, window, log } = this.#deps;
		return killSelection(selection, {
			isAlive: isPtyProcessAlive,
			pause: ms => delay(ms),
			readIdentity: queryPtyProcessIdentity,
			killTree: pid => runTaskkillTree(pid),
			waitGone: waitForPtyProcessGone,
			readRows: () => window.readRows(),
			recordedProcess: tabId => this.#recordedProcessOf(tabId),
			forgetStoppedSlot: async slot => {
				await index.lifecycle.run(slot, async () => {
					// Only the broker-slot mapping of a broker shown gone. A folder shell's recovery record stays until its own owner
					// watch proves the shell root gone too: a broker-only proof must not retire it (ADR-0060 amendment).
					await this.#deps.brokerSlots()?.forget(slot);
				});
				window.launcherChanged();
			},
			recordStopIntent: async (tabId, captured) => {
				const recorded = await index.recordKillIntent(tabId, captured);
				if (recorded === null || recorded.previous === "stopped") return async () => undefined;
				return async () => { await index.setRunIntent(tabId, recorded.previous); };
			},
			reconcileSession: (tabId, captured) => this.#reconcileKilled(tabId, captured),
			refresh: () => window.refresh(),
			info: message => window.notice("info", message),
			warn: message => window.notice("warning", message),
			log,
			requester: window.requester(),
		});
	}

	/**
	 * The host a session's process is recorded as: this window's own runtime identity when it has one,
	 * else the index's record, together with the launch attempt the row's host record names, so that what
	 * Kill examined stays one exact incarnation.
	 */
	#recordedProcessOf(tabId: string): RecordedProcess | null {
		const entry = this.#deps.index.get(tabId);
		const rpc = this.#deps.window.runtimeIdentity(tabId) ?? (entry?.host != null && isManagedHost(entry.host) ? entry.host.rpc ?? null : null);
		if (rpc === null) return null;
		return {
			slot: rpc.slot, brokerId: rpc.brokerId, brokerGeneration: rpc.brokerGeneration, brokerPid: rpc.brokerPid,
			brokerCreationTime: rpc.brokerCreationTime, childPid: rpc.childPid, childCreationTime: rpc.childCreationTime,
			attemptStartedAt: entry?.host?.startedAt ?? null, hostPid: entry?.host?.pid ?? null,
		};
	}

	/**
	 * After Kill proved a session's OMP child (and broker) gone: record the row as stopped through the index's
	 * own incarnation-bound transaction (`SessionIndex.reconcileKilledHost`: under the tab's gate, no live rival
	 * holder, the claim taken, and a shared write that is refused when the committed row no longer records the
	 * killed process), then forget the broker slot and the control material of that incarnation.
	 *
	 * A session this window drives, one a live rival window holds, and one that now records a newer launch are
	 * left alone (a benign skip, logged): the owner's broker watch ends the first two, and the third is not the
	 * killed process. Anything else that left the row unrecorded throws, so the command tells the user.
	 */
	async #reconcileKilled(tabId: string, captured: CapturedHost): Promise<void> {
		const { index, window, log } = this.#deps;
		const before = index.get(tabId);
		const result = await index.lifecycle.run(tabId, async lease => {
			const recorded = await index.reconcileKilledHost(tabId, captured, lease);
			if (recorded.kind === "recorded") {
				await this.#deps.brokerSlots()?.forget(recorded.slot);
				window.forgetOutcome(tabId);
				await this.#deps.control.release(tabId, before === null ? null : recordedControlOwner(before));
			}
			return recorded;
		});
		if (result.kind === "recorded") log.info(`tab ${tabId}: after Kill: the row is recorded as stopped`);
		else if (result.kind === "skipped") {
			log.info(`tab ${tabId}: after Kill: ${result.detail}`);
			// A runtime this window still holds for a process that is now proven gone is no longer ended by anything else:
			// its exit handling already ran (and could not finish), or the process died before it was watched. Close it as its exit would.
			if (result.why === "driven" && await this.#deps.endDriven(tabId)) log.info(`tab ${tabId}: after Kill: this window's runtime of the killed session was ended`);
			else if (result.why === "rival") window.notice("warning", "The process is ended, but another window still holds this session and has not recorded that. Run Kill on the row in that window, or refresh Sessions.");
		} else {
			log.error(`tab ${tabId}: after Kill: ${result.detail}`);
			throw new Error(result.detail);
		}
	}
}
