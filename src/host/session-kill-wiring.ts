/**
 * The Kill command's connection to the window: the process probe it verifies identities with, the
 * `taskkill` it ends trees with, the notifications it reports through and the log.
 *
 * What Kill is and why it is allowed to signal a process id is in `session-kill.ts` and ADR-0060
 * (amended). This file only builds the ports and holds no policy.
 */

import { setTimeout as delay } from "node:timers/promises";
import * as vscode from "vscode";
import type { BrokerProcessRow } from "./broker-processes";
import { isPtyProcessAlive, queryPtyProcessIdentity, waitForPtyProcessGone } from "./pty-identity";
import type { PtyProbeHelper } from "./pty-identity";
import type { PtyBrokerClient } from "./pty-client";
import { killSelection, runTaskkillTree } from "./session-kill";
import type { CapturedHost, KillSelection, RecordedProcess } from "./session-kill";

export interface SessionKillDeps {
	/** The broker client, or `null` when brokers are unavailable in this window. Its verified probe helper reads identities. */
	client(): Promise<PtyBrokerClient | null>;
	/** A fresh read of the live broker rows; asked only for a session that recorded no host. */
	readRows(): Promise<readonly BrokerProcessRow[]>;
	recordedProcess(tabId: string): RecordedProcess | null;
	forgetStoppedSlot(slot: string): Promise<void>;
	reconcileSession(tabId: string, captured: CapturedHost): Promise<void>;
	refresh(): Promise<unknown>;
	/** Names this window in the log: who asked for the kill. */
	requester(): string;
	log(message: string): void;
}

/** The Kill command: one selection in, the report out. Never throws. */
export function createSessionKiller(deps: SessionKillDeps): (selection: KillSelection) => Promise<void> {
	/** The identity probe, or `null`: without it no process can be told from a stranger, so nothing is killed. */
	const helper = async (): Promise<PtyProbeHelper | null> => {
		const client = await deps.client();
		const ready = client === null ? null : await client.attachReady().catch(() => null);
		return ready?.helper ?? null;
	};
	return selection =>
		killSelection(selection, {
			isAlive: isPtyProcessAlive,
			pause: ms => delay(ms),
			async readIdentity(pid) {
				const probe = await helper();
				return probe === null ? { kind: "unknown", detail: "the process probe is not available in this window" } : await queryPtyProcessIdentity(probe, pid);
			},
			killTree: pid => runTaskkillTree(pid),
			async waitGone(pid, creationTime, timeoutMs) {
				const probe = await helper();
				return probe === null ? { gone: false, detail: "the process probe is not available in this window" } : await waitForPtyProcessGone(probe, pid, creationTime, timeoutMs);
			},
			readRows: deps.readRows,
			recordedProcess: deps.recordedProcess,
			forgetStoppedSlot: deps.forgetStoppedSlot,
			reconcileSession: deps.reconcileSession,
			refresh: deps.refresh,
			info: message => void vscode.window.showInformationMessage(message),
			warn: message => void vscode.window.showWarningMessage(message),
			log: deps.log,
			requester: deps.requester(),
		});
}
