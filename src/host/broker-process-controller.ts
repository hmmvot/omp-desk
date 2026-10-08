/**
 * Orchestration of the Processes view's stop actions.
 *
 * Every effect and every prompt arrives through a port, so the policy is testable with
 * fakes: a stop re-derives its row from fresh records and a fresh catalog before anything
 * is done; the route is chosen from that same derivation; and the row's identity captured
 * at that moment is what the stop re-verifies. A single stop asks nothing; only the bulk stop and an authenticated force stop do.
 * No process id is ever signalled (see `broker-processes.ts`).
 *
 * ## Routes
 *
 * - `driven`: this window runs the session's host. The row's own flow stops it, with its
 *   runtime and transition facts captured just before it runs.
 * - `recorded`: a row of this window's catalog records this broker as its host and its
 *   child runs. The row's recorded-host flow stops it and updates the row.
 * - `broker`: everything else — a terminal, an orphan, a slot whose row has no recorded
 *   host, any broker whose child exited. The broker is asked to stop its child and to
 *   shut down (`broker-process-stop.ts`).
 */

import path from "node:path";

import type { BrokerStopMode, BrokerStopOutcome, BrokerStopTarget } from "./broker-process-stop.ts";
import { selectOrphanedAndIdle } from "./broker-processes.ts";
import type { BrokerProcessReadOptions, BrokerProcessRow, BrokerProcessSnapshot } from "./broker-processes.ts";

/** A stop of a row's own flow, captured just before it runs. `run` shows its own messages. */
export interface CapturedRowStop {
	run(): Promise<void>;
}

export interface ConfirmRequest {
	readonly message: string;
	readonly detail: string;
	readonly label: string;
}

export interface ProcessControllerPorts {
	read(options?: BrokerProcessReadOptions): Promise<BrokerProcessSnapshot>;
	/** A modal confirmation; `false` for a dismissal. */
	confirm(request: ConfirmRequest): Promise<boolean>;
	info(message: string): void;
	warn(message: string): void;
	/** Capture the row's own stop flow for a session this window drives, or `null` when it changed. */
	captureDrivenStop(row: BrokerProcessRow): Promise<CapturedRowStop | null>;
	/** Capture the row's recorded-host stop flow, or `null` when the row no longer records this broker. */
	captureRecordedStop(row: BrokerProcessRow): Promise<CapturedRowStop | null>;
	stopThroughBroker(target: BrokerStopTarget, mode: BrokerStopMode): Promise<BrokerStopOutcome>;
	/** The child is confirmed gone: retire a shell recovery record or an unowned session mapping. */
	forgetStoppedSlot(slot: string): Promise<void>;
	/** Refresh the Processes view and the Sessions launcher. */
	refresh(): Promise<void>;
}

type Route = "driven" | "recorded" | "broker";

function routeOf(row: BrokerProcessRow): Route {
	if (row.drivenHere) return "driven";
	if (row.host?.kind === "session" && row.host.recorded && row.host.tabId !== null && row.child !== "exited") return "recorded";
	return "broker";
}

export function stopTargetOf(row: BrokerProcessRow): BrokerStopTarget {
	return {
		slot: row.slot,
		kind: row.ptyKind,
		brokerId: row.brokerId,
		generation: row.generation,
		brokerPid: row.brokerPid,
		brokerCreationTime: row.brokerCreationTime,
	};
}

/**
 * What the row hosts, as the user knows it. No process id or slot: those are for the tooltip
 * and the log, not for a question the user must answer.
 */
export function describeProcess(row: BrokerProcessRow): string {
	if (row.kind === "stats") return "the Stats dashboard";
	if (row.host?.kind === "session") return `the OMP session "${row.host.title}"`;
	if (row.host?.kind === "terminal") return `the terminal "${terminalLabel(row.host.folder)}"`;
	if (row.kind === "terminal") return "a terminal that no longer has a record";
	return row.title === null || row.title === "" ? "an OMP session process that no session row refers to" : `the OMP session "${row.title}"`;
}

function terminalLabel(folder: string): string {
	return path.win32.basename(folder) || folder;
}

function failureText(row: BrokerProcessRow, outcome: BrokerStopOutcome): string {
	const name = describeProcess(row);
	if (outcome.kind === "refused") return `${name} was not stopped: ${outcome.reason}.`;
	if (outcome.kind === "unconfirmed") return `${name} could not be confirmed stopped. ${outcome.detail}`.trim();
	return "";
}

/**
 * Stop one row. There is no confirmation: Stop is an explicit action on one named row, and the
 * row is re-derived from fresh records immediately before anything is done. Only an authenticated
 * force stop, which appears when a graceful stop failed, asks.
 *
 * Two facts the user is not shown: a Windows tree walk cannot prove a process tree empty
 * (ADR-0029), so a descendant that detached from the stopped process is not accounted for; and a
 * stopped terminal keeps its record, so Reconnect Terminal reports it as no longer running.
 */
export async function stopProcess(rowId: string, ports: ProcessControllerPorts): Promise<void> {
	const snapshot = await ports.read({ fresh: true });
	const row = snapshot.rows.find(candidate => candidate.id === rowId);
	if (row === undefined) {
		ports.warn("That process is gone or was replaced by another, so nothing was stopped.");
		await ports.refresh();
		return;
	}
	if (!row.stop.available) {
		ports.warn(row.stop.reason);
		return;
	}
	const route = routeOf(row);
	let captured: CapturedRowStop | null = null;
	if (route !== "broker") {
		captured = route === "driven" ? await ports.captureDrivenStop(row) : await ports.captureRecordedStop(row);
		if (captured === null) {
			ports.warn("The session changed while it was being prepared, so nothing was stopped. Try again.");
			await ports.refresh();
			return;
		}
	}
	try {
		if (captured !== null) {
			await captured.run();
			return;
		}
		let outcome = await ports.stopThroughBroker(stopTargetOf(row), "graceful");
		if (outcome.kind === "unconfirmed" && outcome.canForce) {
			const force = await ports.confirm({
				message: `Force ${describeProcess(row)} to stop?`,
				detail: "It did not stop when asked. Forcing it ends it at once, and unsaved work in it is lost.",
				label: "Force Stop",
			});
			if (force) outcome = await ports.stopThroughBroker(stopTargetOf(row), "force");
		}
		if (outcome.kind === "stopped") {
			if (row.kind === "terminal" || (row.kind === "session" && !(row.host?.kind === "session" && row.host.recorded))) {
				await ports.forgetStoppedSlot(row.slot).catch(() => undefined);
			}
		} else {
			ports.warn(failureText(row, outcome));
		}
	} finally {
		await ports.refresh();
	}
}

/** Stop every orphaned or idle process, behind one confirmation, graceful and never forced. */
export async function stopOrphanedAndIdle(ports: ProcessControllerPorts): Promise<void> {
	const first = selectOrphanedAndIdle((await ports.read({ fresh: true })).rows);
	if (first.length === 0) {
		ports.info("No orphaned or idle OMP processes were found.");
		return;
	}
	const sessions = first.filter(row => row.kind === "session").length;
	const terminals = first.filter(row => row.kind === "terminal").length;
	const stats = first.filter(row => row.kind === "stats").length;
	const running = first.filter(row => row.child !== "exited").length;
	const parts = [
		sessions > 0 ? `${sessions} session ${sessions === 1 ? "process" : "processes"}` : null,
		terminals > 0 ? `${terminals} terminal ${terminals === 1 ? "process" : "processes"}` : null,
		stats > 0 ? `${stats} Stats dashboard ${stats === 1 ? "process" : "processes"}` : null,
	].filter((part): part is string => part !== null);
	const detail = [
		"These background processes are no longer used by a session or terminal, or their session, terminal or dashboard has ended.",
		running > 0 ? `${running === 1 ? "One still has" : `${running} still have`} a session or shell running, which ends.` : null,
	].filter((line): line is string => line !== null).join(" ");
	if (!(await ports.confirm({ message: `Stop ${parts.join(" and ")}?`, detail, label: "Stop Processes" }))) {
		ports.info("Nothing was stopped.");
		return;
	}
	const confirmed = new Set(first.map(row => row.id));
	const targets = selectOrphanedAndIdle((await ports.read({ fresh: true })).rows).filter(row => confirmed.has(row.id));
	let stopped = 0;
	const left: string[] = [];
	try {
		for (const row of targets) {
			const outcome = await ports.stopThroughBroker(stopTargetOf(row), "graceful");
			if (outcome.kind === "stopped") {
				stopped++;
				if (row.kind === "terminal" || (row.kind === "session" && !(row.host?.kind === "session" && row.host.recorded))) {
					await ports.forgetStoppedSlot(row.slot).catch(() => undefined);
				}
			} else {
				left.push(describeProcess(row));
			}
		}
	} finally {
		await ports.refresh();
	}
	const skipped = first.length - targets.length;
	const base = `Stopped ${stopped} of ${first.length} background ${first.length === 1 ? "process" : "processes"}.`;
	const notes = [
		skipped > 0 ? `${skipped} changed after the confirmation and ${skipped === 1 ? "was" : "were"} left alone.` : null,
		left.length > 0 ? `Still running: ${left.join("; ")}.` : null,
	].filter((note): note is string => note !== null);
	if (left.length > 0 || skipped > 0) ports.warn([base, ...notes].join(" "));
}
