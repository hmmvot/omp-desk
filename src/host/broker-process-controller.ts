/**
 * Orchestration of the stop actions of the Sessions view's processes: a row's Stop, Stop Orphaned
 * and Idle, and Kill All.
 *
 * Every effect and every prompt arrives through a port, so the policy is testable with
 * fakes: a stop re-derives its row from fresh records and a fresh catalog before anything
 * is done; the route is chosen from that same derivation; and the row's identity captured
 * at that moment is what the stop re-verifies. A single stop asks nothing; only the bulk stops and an authenticated force stop do.
 * No process id is ever signalled (see `broker-processes.ts`).
 *
 * ## Routes
 *
 * - `driven`: this window runs the session's host. The row's own flow stops it, with its
 *   runtime and transition facts captured just before it runs.
 * - `recorded`: a row of this window's catalog records this broker as its host and its
 *   child runs. The row's recorded-host flow stops it and updates the row. This is also how a
 *   session another window holds is stopped: through the authenticated broker, with no request
 *   to that window.
 * - `broker`: everything else — a terminal, an orphan, a slot whose row has no recorded
 *   host, any broker whose child exited. The broker is asked to stop its child and to
 *   shut down (`broker-process-stop.ts`).
 */

import path from "node:path";

import type { BrokerStopMode, BrokerStopOutcome, BrokerStopTarget } from "./broker-process-stop.ts";
import { planKillAll, selectOrphanedAndIdle } from "./broker-processes.ts";
import type { BrokerProcessReadOptions, BrokerProcessRow, BrokerProcessSnapshot, KillAllPlan } from "./broker-processes.ts";

/**
 * A stop of a row's own flow, captured just before it runs. `run` shows its own messages and answers
 * whether the flow confirmed the session's writer gone.
 */
export interface CapturedRowStop {
	run(): Promise<boolean>;
}

export interface ConfirmRequest {
	readonly message: string;
	readonly detail: string;
	readonly label: string;
}

export interface ChoiceOption {
	readonly id: string;
	readonly label: string;
}

/** A modal with several buttons; Cancel is always there and answers `null`. */
export interface ChoiceRequest {
	readonly message: string;
	readonly detail: string;
	readonly options: readonly ChoiceOption[];
}

export interface ProcessControllerPorts {
	read(options?: BrokerProcessReadOptions): Promise<BrokerProcessSnapshot>;
	/** A modal confirmation; `false` for a dismissal. */
	confirm(request: ConfirmRequest): Promise<boolean>;
	/** A modal with one button per option: the chosen option's id, or `null` for Cancel or a dismissal. */
	choose(request: ChoiceRequest): Promise<string | null>;
	/** Show a progress notification while `work` runs. */
	withProgress(title: string, work: () => Promise<void>): Promise<void>;
	info(message: string): void;
	warn(message: string): void;
	/** Capture the row's own stop flow for a session this window drives, or `null` when it changed. */
	captureDrivenStop(row: BrokerProcessRow): Promise<CapturedRowStop | null>;
	/** Capture the row's recorded-host stop flow, or `null` when the row no longer records this exact broker. */
	captureRecordedStop(row: BrokerProcessRow): Promise<CapturedRowStop | null>;
	stopThroughBroker(target: BrokerStopTarget, mode: BrokerStopMode): Promise<BrokerStopOutcome>;
	/** The child is confirmed gone: retire a shell recovery record or an unowned session mapping. */
	forgetStoppedSlot(slot: string): Promise<void>;
	/** Refresh the Sessions view's process rows and the launcher. */
	refresh(): Promise<void>;
}

type Route = "driven" | "recorded" | "broker";

function routeOf(row: BrokerProcessRow): Route {
	if (row.drivenHere) return "driven";
	// A native session another window holds cannot be reattached from here (its claim refuses it), so it
	// is stopped through its authenticated broker exactly as a process no row records.
	if (row.ptyKind === "managed-omp" && row.window === "other-window") return "broker";
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

/** What {@link stopRow} did with one row. */
type RowStopResult =
	/** The row's own flow (driven or recorded) confirmed the session's writer gone. It showed its own messages. */
	| { readonly kind: "stopped" }
	/** The row's own flow ran and did not confirm the writer gone. It showed its own messages. */
	| { readonly kind: "flow-unconfirmed" }
	/** A captured row flow could not be prepared: the session changed since the derivation. Nothing was stopped. */
	| { readonly kind: "changed" }
	/** The broker route stopped the child but could not prove the broker gone. */
	| { readonly kind: "broker-unconfirmed" }
	/** The broker route did not stop it; `message` names what and why. */
	| { readonly kind: "failed"; readonly message: string };

/** A broker-route stop confirmed the child gone: retire a shell recovery record or an unowned session mapping. */
async function retireStoppedSlot(row: BrokerProcessRow, ports: ProcessControllerPorts): Promise<void> {
	if (row.kind === "terminal" || (row.kind === "session" && !(row.host?.kind === "session" && row.host.recorded))) {
		await ports.forgetStoppedSlot(row.slot).catch(() => undefined);
	}
}

/**
 * Stop one freshly derived row by the route its derivation chose. Every stop in this module
 * (a single Stop, Kill All) is this function, so there is one code path to the authenticated stops.
 * It asks only for an authenticated force stop after a graceful stop failed, and it neither
 * refreshes nor reports: callers do.
 */
async function stopRow(row: BrokerProcessRow, ports: ProcessControllerPorts): Promise<RowStopResult> {
	const route = routeOf(row);
	if (route !== "broker") {
		const captured = route === "driven" ? await ports.captureDrivenStop(row) : await ports.captureRecordedStop(row);
		if (captured === null) return { kind: "changed" };
		return (await captured.run()) ? { kind: "stopped" } : { kind: "flow-unconfirmed" };
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
	if (outcome.kind !== "stopped") return { kind: "failed", message: failureText(row, outcome) };
	await retireStoppedSlot(row, ports);
	// The child exiting is not the broker retiring: a broker whose exit is unproven may still be listed
	// or hidden by an unreadable record, so it is never reported as confirmed stopped.
	if (!outcome.brokerGone) return { kind: "broker-unconfirmed" };
	return { kind: "stopped" };
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
	let result: RowStopResult;
	try {
		result = await stopRow(row, ports);
	} finally {
		await ports.refresh();
	}
	if (result.kind === "changed") ports.warn("The session changed while it was being prepared, so nothing was stopped. Try again.");
	else if (result.kind === "broker-unconfirmed") ports.warn(`${describeProcess(row)} was stopped, but its background process could not be confirmed closed. Refresh Sessions and check it.`);
	else if (result.kind === "failed") ports.warn(result.message);
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
			// Selected rows are never driven and never recorded-running, so this is the broker route; the
			// bulk stop does not force: the confirmation did not promise to.
			const outcome = await ports.stopThroughBroker(stopTargetOf(row), "graceful");
			if (outcome.kind === "stopped") {
				stopped++;
				await retireStoppedSlot(row, ports);
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

function plural(count: number, one: string, many: string): string {
	return `${count} ${count === 1 ? one : many}`;
}

/** "2 sessions, 1 terminal and the Stats dashboard" for the rows of a Kill All tier. */
function countKinds(rows: readonly BrokerProcessRow[]): string {
	const sessions = rows.filter(row => row.kind === "session").length;
	const terminals = rows.filter(row => row.kind === "terminal").length;
	const stats = rows.filter(row => row.kind === "stats").length;
	const parts = [
		sessions > 0 ? plural(sessions, "session", "sessions") : null,
		terminals > 0 ? plural(terminals, "terminal", "terminals") : null,
		stats > 0 ? "the Stats dashboard" : null,
	].filter((part): part is string => part !== null);
	return parts.length < 2 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** The one modal of Kill All: what each button ends, by tier. Pure. */
export function describeKillAll(plan: KillAllPlan): ChoiceRequest {
	const elsewhere = [...plan.otherWindows, ...plan.notRun];
	const options: ChoiceOption[] = [];
	if (plan.here.length > 0) options.push({ id: "here", label: "Stop in This Window" });
	if (elsewhere.length > 0) options.push({ id: "all", label: "Stop in All Windows" });
	const where = [
		plan.otherWindows.length > 0 ? `${countKinds(plan.otherWindows)} that another window holds` : null,
		plan.notRun.length > 0 ? `${countKinds(plan.notRun)} that this window does not run` : null,
	].filter((part): part is string => part !== null).join(" and ");
	const detail = [
		"Running sessions and terminals end, and a turn in progress is aborted. Conversations stay in OMP's session files and can be resumed.",
		plan.here.length > 0 && elsewhere.length > 0 ? `Stop in All Windows also ends ${where}.` : null,
		plan.here.length === 0 ? `Nothing runs in this window. Stop in All Windows ends ${where}.` : null,
		plan.blocked.length > 0 ? `${plural(plan.blocked.length, "process", "processes")} started by another version of OMP Desk cannot be stopped from here.` : null,
	].filter((line): line is string => line !== null).join(" ");
	const message = plan.here.length > 0 ? `Stop ${countKinds(plan.here)} in this window?` : `Stop ${countKinds(elsewhere)}?`;
	return { message, detail, options };
}

/** What Kill All says about rows this build cannot stop, by name. */
function blockedNote(blocked: readonly BrokerProcessRow[]): string {
	return `Not stoppable from here: ${blocked.map(row => describeProcess(row)).join("; ")} (started by another version of OMP Desk).`;
}

/**
 * Kill All: end every OMP process this profile has that this build can stop, in tiers behind one
 * confirmation (see `planKillAll`). Each row is stopped by {@link stopRow}, one after another, so a
 * session this window drives goes through its own stop lifecycle and a process another window holds
 * through its authenticated broker. The report is per target: what its route confirmed, cross-checked
 * against a final fresh read. A row still listed is still running; a row that is merely no longer
 * listed is not proof it stopped (an unreadable identity hides a live broker too), so it counts as
 * stopped only when its route confirmed it.
 */
export async function killAll(ports: ProcessControllerPorts): Promise<void> {
	const first = planKillAll((await ports.read({ fresh: true })).rows);
	if (first.here.length === 0 && first.otherWindows.length === 0 && first.notRun.length === 0) {
		if (first.blocked.length === 0) ports.info("No OMP processes are running.");
		else ports.warn(`No OMP process can be stopped from here. ${blockedNote(first.blocked)}`);
		return;
	}
	const choice = await ports.choose(describeKillAll(first));
	if (choice !== "here" && choice !== "all") {
		ports.info("Nothing was stopped.");
		return;
	}
	const chosen = new Set((choice === "all" ? [...first.here, ...first.otherWindows, ...first.notRun] : first.here).map(row => row.id));
	const second = planKillAll((await ports.read({ fresh: true })).rows);
	// A row that left the chosen tier meanwhile (it is no longer provably this window's) is left alone.
	const eligible = choice === "all" ? [...second.here, ...second.otherWindows, ...second.notRun] : second.here;
	const targets = eligible.filter(row => chosen.has(row.id));
	const skipped = chosen.size - targets.length;
	const results = new Map<string, RowStopResult | Error>();
	let leftAlone = 0;
	await ports.withProgress(`Stopping ${plural(targets.length, "OMP process", "OMP processes")}…`, async () => {
		try {
			for (const [position, row] of targets.entries()) {
				try {
					// Earlier stops take time: a terminal another window attached meanwhile is no longer this window's.
					// The confirmed set never grows; a row only leaves it.
					if (choice === "here" && position > 0) {
						const current = planKillAll((await ports.read()).rows);
						if (!current.here.some(candidate => candidate.id === row.id)) {
							leftAlone += 1;
							continue;
						}
					}
					results.set(row.id, await stopRow(row, ports));
				} catch (error) {
					results.set(row.id, error instanceof Error ? error : new Error(String(error)));
				}
			}
		} finally {
			await ports.refresh();
		}
	});
	let remaining: ReadonlySet<string> | null = null;
	try {
		remaining = new Set((await ports.read({ fresh: true })).rows.map(row => row.id));
	} catch {
		remaining = null;
	}
	const confirmedStopped = (row: BrokerProcessRow): boolean => {
		const result = results.get(row.id);
		return result !== undefined && !(result instanceof Error) && result.kind === "stopped";
	};
	const attempted = targets.filter(row => results.has(row.id));
	const changedSince = skipped + leftAlone;
	const stillRunning = remaining === null ? [] : attempted.filter(row => remaining.has(row.id));
	const stopped = attempted.filter(row => confirmedStopped(row) && !stillRunning.includes(row));
	const unconfirmed = attempted.filter(row => !confirmedStopped(row) && !stillRunning.includes(row));
	if (stillRunning.length === 0 && unconfirmed.length === 0 && changedSince === 0 && second.blocked.length === 0 && remaining !== null) {
		ports.info(`Stopped ${plural(stopped.length, "OMP process", "OMP processes")}.`);
		return;
	}
	const reasonOf = (row: BrokerProcessRow): string => {
		const result = results.get(row.id);
		if (result instanceof Error) return `${describeProcess(row)} was not stopped: ${result.message}`;
		if (result?.kind === "failed") return result.message;
		if (result?.kind === "changed") return `${describeProcess(row)} changed while it was being prepared`;
		if (result?.kind === "broker-unconfirmed") return `${describeProcess(row)} was stopped, but its background process could not be confirmed closed`;
		return describeProcess(row);
	};
	const notes = [
		stillRunning.length > 0 ? `Still running: ${stillRunning.map(reasonOf).join("; ")}.` : null,
		unconfirmed.length > 0 ? `Could not be confirmed stopped: ${unconfirmed.map(reasonOf).join("; ")}.` : null,
		remaining === null ? "The final check of the process list failed, so only what each stop reported is counted." : null,
		changedSince > 0 ? `${plural(changedSince, "process", "processes")} changed after the confirmation and ${changedSince === 1 ? "was" : "were"} left alone.` : null,
		second.blocked.length > 0 ? blockedNote(second.blocked) : null,
	].filter((note): note is string => note !== null);
	ports.warn([`Stopped ${stopped.length} of ${attempted.length} OMP ${attempted.length === 1 ? "process" : "processes"}.`, ...notes].join(" "));
}
