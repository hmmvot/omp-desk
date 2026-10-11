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
 *   runtime and transition facts captured just before it runs. The flow proves the writer gone;
 *   the controller then proves the broker's process gone by its own identity (`waitBrokerGone`),
 *   because the flow's shutdown acknowledgement is not that evidence.
 * - `recorded`: a row of this window's catalog records this broker as its host and its
 *   child runs. The row's recorded-host flow stops it and updates the row; the broker is then proven
 *   gone the same way.
 * - `broker`: everything else — a terminal, an orphan, a slot whose row has no recorded
 *   host, any broker whose child exited, and a native session another window holds when that
 *   window cannot be asked (it is gone or did not answer). The broker is asked to stop its child and
 *   to shut down (`broker-process-stop.ts`).
 *
 * ## Kill All and other windows
 *
 * Kill All never stops a live window's sessions or terminals through the broker on that window's
 * behalf: it asks the window (a `stop` request, `window-requests.ts`) to stop the rows it runs through its
 * own lifecycle, and reports what each window answered. Only rows no window answers for are stopped here
 * by the authenticated broker, and the report names them.
 */

import path from "node:path";

import { BROKER_PROCESS_EXIT_TIMEOUT_MS } from "./broker-process-stop.ts";
import type { BrokerStopMode, BrokerStopOutcome, BrokerStopTarget } from "./broker-process-stop.ts";
import { mayRunInAnotherWindow, planKillAll, rowIdentityOf, rowMatchesIdentity, sameBroker, selectOrphanedAndIdle } from "./broker-processes.ts";
import type { BrokerProcessReadOptions, BrokerProcessRow, BrokerProcessSnapshot, KillAllPlan, RowIdentity } from "./broker-processes.ts";
import type { PeerRowAnswer, StopRowAnswer } from "./window-requests.ts";

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
	/**
	 * Prove the broker's process gone by its PID and creation time, waiting up to `timeoutMs`. This is
	 * evidence a row's own flow does not give (it proves the writer gone, not the broker retired), and it
	 * does not depend on the broker's record being readable.
	 */
	waitBrokerGone(target: BrokerStopTarget, timeoutMs: number): Promise<{ readonly gone: boolean; readonly detail: string }>;
	/** The child is confirmed gone: retire a shell recovery record or an unowned session mapping. */
	forgetStoppedSlot(slot: string): Promise<void>;
	/** The other live windows of this profile, from the window registry read now. Never throws. */
	peers(): Promise<readonly KillAllPeer[]>;
	/** Whether `holderId` is still a live window. */
	peerIsLive(holderId: string): Promise<boolean>;
	/**
	 * Ask a window to stop the rows it runs among `rows` (the identities this window was shown). One answer per
	 * row, in order. Never throws: a window that cannot be asked answers `not-accepted` for every row.
	 */
	askWindowToStop(holderId: string, rows: readonly RowIdentity[]): Promise<readonly PeerRowAnswer[]>;
	/** Refresh the Sessions view's process rows and the launcher. */
	refresh(): Promise<void>;
}

/** A live window other than this one, as the registry names it. */
export interface KillAllPeer {
	readonly holderId: string;
	/** The window's workspace name, for the report. */
	readonly label: string;
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

/** What {@link stopRow} did with one row. The writer's exit and the broker's exit are separate evidence: only both give `stopped`. */
export type RowStopResult =
	/** The writer is proven gone and so is the broker's process. */
	| { readonly kind: "stopped" }
	/** The row's own flow (driven or recorded) ran and did not confirm the writer gone. It showed its own messages. */
	| { readonly kind: "flow-unconfirmed" }
	/** A captured row flow could not be prepared: the session changed since the derivation. Nothing was stopped. */
	| { readonly kind: "changed" }
	/** The writer or child is proven gone but the broker's process is not proven gone. */
	| { readonly kind: "broker-unconfirmed" }
	/** The route did not stop it, or a window's report says so; `message` names what and why. */
	| { readonly kind: "failed"; readonly message: string; readonly reason: string };

/** A broker-route stop confirmed the child gone: retire a shell recovery record or an unowned session mapping. */
async function retireStoppedSlot(row: BrokerProcessRow, ports: ProcessControllerPorts): Promise<void> {
	if (row.kind === "terminal" || (row.kind === "session" && !(row.host?.kind === "session" && row.host.recorded))) {
		await ports.forgetStoppedSlot(row.slot).catch(() => undefined);
	}
}

/**
 * Stop one freshly derived row by the route its derivation chose. Every stop in this module
 * (a single Stop, Kill All, a stop another window asked for) is this function, so there is one code path
 * to the authenticated stops. It asks for an authenticated force stop only after a graceful stop failed and
 * only when `offerForce` (a window serving another window's request never prompts on its behalf), and it
 * neither refreshes nor reports: callers do.
 */
async function stopRow(row: BrokerProcessRow, ports: ProcessControllerPorts, options: { readonly offerForce: boolean } = { offerForce: true }): Promise<RowStopResult> {
	const route = routeOf(row);
	if (route !== "broker") {
		const captured = route === "driven" ? await ports.captureDrivenStop(row) : await ports.captureRecordedStop(row);
		if (captured === null) return { kind: "changed" };
		if (!(await captured.run())) return { kind: "flow-unconfirmed" };
		// The flow proves the session's writer gone, not that the broker retired (its shutdown acknowledgement is not an
		// exit): the broker's own process is probed by its identity, and an unproven exit is never reported as stopped.
		const gone = await ports.waitBrokerGone(stopTargetOf(row), BROKER_PROCESS_EXIT_TIMEOUT_MS).catch(() => ({ gone: false, detail: "the process probe failed" }));
		return gone.gone ? { kind: "stopped" } : { kind: "broker-unconfirmed" };
	}
	let outcome = await ports.stopThroughBroker(stopTargetOf(row), "graceful");
	if (options.offerForce && outcome.kind === "unconfirmed" && outcome.canForce) {
		const force = await ports.confirm({
			message: `Force ${describeProcess(row)} to stop?`,
			detail: "It did not stop when asked. Forcing it ends it at once, and unsaved work in it is lost.",
			label: "Force Stop",
		});
		if (force) outcome = await ports.stopThroughBroker(stopTargetOf(row), "force");
	}
	if (outcome.kind !== "stopped") return { kind: "failed", message: failureText(row, outcome), reason: outcome.kind === "refused" ? outcome.reason : outcome.detail };
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
		plan.here.length > 0 && elsewhere.length > 0 ? `Stop in All Windows also ends ${where}. Other windows are asked to stop their own; whatever no window answers for is stopped directly.` : null,
		plan.here.length === 0 ? `Nothing runs in this window. Stop in All Windows ends ${where}. Other windows are asked to stop their own; whatever no window answers for is stopped directly.` : null,
		plan.blocked.length > 0 ? `${plural(plan.blocked.length, "process", "processes")} started by another version of OMP Desk cannot be stopped from here.` : null,
	].filter((line): line is string => line !== null).join(" ");
	const message = plan.here.length > 0 ? `Stop ${countKinds(plan.here)} in this window?` : `Stop ${countKinds(elsewhere)}?`;
	return { message, detail, options };
}

/** What Kill All says about rows this build cannot stop, by name. */
function blockedNote(blocked: readonly BrokerProcessRow[]): string {
	return `Not stoppable from here: ${blocked.map(row => describeProcess(row)).join("; ")} (started by another version of OMP Desk).`;
}

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

/** What one live window answered for one row, and whether it still looks alive when it went silent. */
export interface PeerAnswerFor {
	readonly peer: KillAllPeer;
	readonly answer: PeerRowAnswer;
	/** Meaningful for a `silent` answer: the window is still listed as live (it may be working, or waiting on a prompt). */
	readonly live: boolean;
}

/** How the answers of the live windows settle one row that another window might run. */
export type RemoteVerdict =
	/** A window that runs it answered (stopped, did not confirm, or says it changed), or a live window took the request and is silent: the requester stops nothing for this row. */
	| { readonly kind: "settled"; readonly result: RowStopResult }
	/** No window answers for it: the requester stops it through the authenticated broker. `note` says why it is "without its window", or `null` when no window owned it. */
	| { readonly kind: "fallback"; readonly note: string | null };

/**
 * Settle one row from what every live other window answered for it. Pure.
 *
 * A window's `stopped` or `unconfirmed` is the owner's verdict: it ran the row and tried. `changed`
 * leaves the row alone (the owner runs it, so no one else may stop it on this request). A window that took
 * the request up and went silent while still live may be running the row or waiting on a prompt, so the row
 * is left to it and reported. Only when no window answers for the row does it fall back to the broker,
 * with a note when some window should have answered (the row records another window, or one did not take
 * the request, or stopped answering).
 */
export function settleRemoteRow(row: BrokerProcessRow, answers: readonly PeerAnswerFor[]): RemoteVerdict {
	const name = describeProcess(row);
	const reportOf = (entry: PeerAnswerFor): string => `${name}: its window "${entry.peer.label}" reported: ${entry.answer.reason === "" ? "no reason" : entry.answer.reason}`;
	const stopped = answers.find(entry => entry.answer.state === "stopped");
	if (stopped !== undefined) return { kind: "settled", result: { kind: "stopped" } };
	const unconfirmed = answers.find(entry => entry.answer.state === "unconfirmed");
	if (unconfirmed !== undefined) return { kind: "settled", result: { kind: "failed", message: `${reportOf(unconfirmed)}.`, reason: unconfirmed.answer.reason } };
	if (answers.some(entry => entry.answer.state === "changed")) return { kind: "settled", result: { kind: "changed" } };
	const withheld = answers.find(entry => entry.answer.state === "silent" && entry.live);
	if (withheld !== undefined) {
		return {
			kind: "settled",
			result: { kind: "failed", message: `${name}: its window "${withheld.peer.label}" took the request up and has not reported back, so it was left to that window.`, reason: "its window has not reported back" },
		};
	}
	const reasons = answers.flatMap(entry =>
		entry.answer.state === "not-accepted"
			? [`window "${entry.peer.label}" did not take the request up${entry.answer.reason === "" ? "" : ` (${entry.answer.reason})`}`]
			: entry.answer.state === "silent"
				? [`window "${entry.peer.label}" stopped answering and is no longer open`]
				: [],
	);
	if (reasons.length === 0 && row.window === "other-window") {
		reasons.push(answers.length === 0 ? "no other window of this profile is open" : "no open window runs it");
	}
	return { kind: "fallback", note: reasons.length === 0 ? null : reasons.join("; ") };
}

/** Ask every other live window about `rows` at once and settle each row from the answers. Never throws. */
async function askOtherWindows(rows: readonly BrokerProcessRow[], ports: ProcessControllerPorts): Promise<ReadonlyMap<string, RemoteVerdict>> {
	let peers: readonly KillAllPeer[] = [];
	try {
		peers = await ports.peers();
	} catch {
		peers = [];
	}
	const identities = rows.map(rowIdentityOf);
	const asked = await Promise.all(
		peers.map(async peer => {
			let answers: readonly PeerRowAnswer[];
			try {
				answers = await ports.askWindowToStop(peer.holderId, identities);
			} catch (error) {
				answers = rows.map(() => ({ state: "not-accepted" as const, reason: asError(error).message }));
			}
			const silent = answers.some(answer => answer.state === "silent");
			// An unreadable registry does not prove the window gone: a window that took the request up is left alone then.
			const live = silent ? await ports.peerIsLive(peer.holderId).catch(() => true) : false;
			return { peer, answers, live };
		}),
	);
	const verdicts = new Map<string, RemoteVerdict>();
	for (const [position, row] of rows.entries()) {
		verdicts.set(
			row.id,
			settleRemoteRow(
				row,
				asked.map(({ peer, answers, live }) => ({ peer, answer: answers[position] ?? { state: "not-accepted" as const, reason: "" }, live })),
			),
		);
	}
	return verdicts;
}

/**
 * Kill All: end every OMP process this profile has that this build can stop, in tiers behind one
 * confirmation (see `planKillAll`).
 *
 * - Rows this window provably runs are stopped one after another by {@link stopRow}, so a session goes
 *   through its own stop lifecycle.
 * - With *Stop in All Windows*, every other live window is asked, at the same time, to stop the rows it runs
 *   among those that another window might run, through its own lifecycle; its per-row answers are the
 *   verdicts for those rows ({@link settleRemoteRow}). A row no window answers for, and every row no window can
 *   run (an orphan, an idle process, a detached terminal, the dashboard), is stopped here through the
 *   authenticated broker, and the report names the ones that were stopped without their window.
 * - The confirmed set only shrinks: every target is derived afresh immediately before it is dispatched and left
 *   alone when it is gone, replaced by another broker, or no longer in a tier the choice covers.
 *
 * The report is per target: what its route (or its window) confirmed, cross-checked against a final fresh
 * read. A row still listed is still running; a row that is merely no longer listed is not proof it stopped (an
 * unreadable identity hides a live broker too), so it counts as stopped only when it was confirmed.
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
	const hereIds = new Set(second.here.map(row => row.id));
	const hereRows = targets.filter(row => hereIds.has(row.id));
	const remoteRows = choice === "all" ? targets.filter(row => !hereIds.has(row.id) && mayRunInAnotherWindow(row)) : [];
	const remoteIds = new Set(remoteRows.map(row => row.id));
	const directRows = choice === "all" ? targets.filter(row => !hereIds.has(row.id) && !remoteIds.has(row.id)) : [];
	const results = new Map<string, RowStopResult | Error>();
	/** Rows stopped through the broker although a window should have stopped them, with why. */
	const withoutWindow = new Map<string, string>();
	let leftAlone = 0;
	/** Any tier the choice covers: a row that was not this window's may have become this window's meanwhile, and is then stopped by its own flow. */
	const inChosenTiers = (plan: KillAllPlan): readonly BrokerProcessRow[] => [...plan.here, ...plan.otherWindows, ...plan.notRun];
	/** Derive the row afresh from the broker records and stop it by that derivation, or leave it alone when it is no longer the row that was confirmed. */
	const dispatch = async (row: BrokerProcessRow, tier: (plan: KillAllPlan) => readonly BrokerProcessRow[]): Promise<void> => {
		try {
			const current = tier(planKillAll((await ports.read()).rows)).find(candidate => sameBroker(row, candidate));
			if (current === undefined) {
				leftAlone += 1;
				return;
			}
			results.set(row.id, await stopRow(current, ports));
		} catch (error) {
			results.set(row.id, asError(error));
		}
	};
	await ports.withProgress(`Stopping ${plural(targets.length, "OMP process", "OMP processes")}…`, async () => {
		try {
			const verdicts = new Map<string, RemoteVerdict>();
			// This window's own rows and the other windows' answers proceed at the same time: the windows stop theirs while this one stops its own.
			await Promise.all([
				(async () => {
					for (const row of hereRows) await dispatch(row, plan => plan.here);
				})(),
				(async () => {
					if (remoteRows.length === 0) return;
					for (const [id, verdict] of await askOtherWindows(remoteRows, ports)) verdicts.set(id, verdict);
				})(),
			]);
			for (const row of remoteRows) {
				const verdict = verdicts.get(row.id);
				if (verdict === undefined || verdict.kind === "fallback") {
					if (verdict?.note != null) withoutWindow.set(row.id, verdict.note);
					await dispatch(row, inChosenTiers);
				} else {
					results.set(row.id, verdict.result);
				}
			}
			for (const row of directRows) await dispatch(row, inChosenTiers);
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
	const stoppedWithoutWindow = stopped.filter(row => withoutWindow.has(row.id));
	const withoutWindowNote = stoppedWithoutWindow.length > 0
		? `Stopped without their window: ${stoppedWithoutWindow.map(row => `${describeProcess(row)} (${withoutWindow.get(row.id)})`).join("; ")}.`
		: null;
	if (stillRunning.length === 0 && unconfirmed.length === 0 && changedSince === 0 && second.blocked.length === 0 && remaining !== null) {
		ports.info([`Stopped ${plural(stopped.length, "OMP process", "OMP processes")}.`, withoutWindowNote].filter((part): part is string => part !== null).join(" "));
		return;
	}
	const reasonOf = (row: BrokerProcessRow): string => {
		const result = results.get(row.id);
		const base =
			result instanceof Error ? `${describeProcess(row)} was not stopped: ${result.message}`
			: result?.kind === "failed" ? result.message
			: result?.kind === "changed" ? `${describeProcess(row)} changed while it was being prepared`
			: result?.kind === "broker-unconfirmed" ? `${describeProcess(row)} was stopped, but its background process could not be confirmed closed`
			: describeProcess(row);
		const note = withoutWindow.get(row.id);
		return note === undefined ? base : `${base} (stopped without its window: ${note})`;
	};
	const notes = [
		stillRunning.length > 0 ? `Still running: ${stillRunning.map(reasonOf).join("; ")}.` : null,
		unconfirmed.length > 0 ? `Could not be confirmed stopped: ${unconfirmed.map(reasonOf).join("; ")}.` : null,
		remaining === null ? "The final check of the process list failed, so only what each stop reported is counted." : null,
		changedSince > 0 ? `${plural(changedSince, "process", "processes")} changed after the confirmation and ${changedSince === 1 ? "was" : "were"} left alone.` : null,
		withoutWindowNote,
		second.blocked.length > 0 ? blockedNote(second.blocked) : null,
	].filter((note): note is string => note !== null);
	ports.warn([`Stopped ${stopped.length} of ${attempted.length} OMP ${attempted.length === 1 ? "process" : "processes"}.`, ...notes].join(" "));
}

/** The wire answer for the result of {@link stopRow} on one row this window runs. */
function answerOf(result: RowStopResult): StopRowAnswer {
	switch (result.kind) {
		case "stopped":
			return { state: "stopped", reason: "" };
		case "broker-unconfirmed":
			return { state: "unconfirmed", reason: "it was stopped, but its background process could not be confirmed closed" };
		case "flow-unconfirmed":
			return { state: "unconfirmed", reason: "its own stop flow did not confirm the session stopped (see that window's messages)" };
		case "changed":
			return { state: "changed", reason: "it changed while it was being prepared; nothing was stopped" };
		case "failed":
			return { state: "unconfirmed", reason: result.reason };
	}
}

/**
 * Serve a stop request of another window (Kill All): stop, through this window's own lifecycle, the rows among
 * `identities` that this window provably runs, and answer per row in the order asked. Nothing here widens what the
 * requester asked for:
 *
 * - a row is stopped only when it still equals the identity named (slot, broker id, generation, type and
 *   conversation) *and* is in this window's own tier (`planKillAll.here`: a runtime of this window under that exact
 *   broker, or a terminal editor of this window for that generation) — otherwise it is `refused` (not provably
 *   run here) or `changed` (gone, replaced, or changed while it was being prepared);
 * - each row is derived afresh immediately before it is stopped;
 * - nothing is forced: a graceful stop that did not work is answered `unconfirmed`, and Force Stop stays an
 *   explicit prompt of a window the user is using (the row's own flow may still show its own prompt in this window).
 *
 * `progress` is told after each finished row so the requester can tell a working window from a silent one.
 * Never throws.
 */
export async function stopRowsOnRequest(
	identities: readonly RowIdentity[],
	ports: ProcessControllerPorts,
	progress: (done: number) => Promise<void> = async () => {},
): Promise<readonly StopRowAnswer[]> {
	let rows: readonly BrokerProcessRow[];
	try {
		rows = (await ports.read({ fresh: true })).rows;
	} catch (error) {
		const reason = `this window could not read its processes (${asError(error).message}); nothing was stopped`;
		return identities.map(() => ({ state: "changed" as const, reason }));
	}
	const here = planKillAll(rows).here;
	const answers: StopRowAnswer[] = [];
	try {
		for (const identity of identities) {
			answers.push(await serveOneRow(identity, rows, here, ports));
			await progress(answers.length);
		}
	} finally {
		await ports.refresh().catch(() => undefined);
	}
	return answers;
}

async function serveOneRow(
	identity: RowIdentity,
	rows: readonly BrokerProcessRow[],
	here: readonly BrokerProcessRow[],
	ports: ProcessControllerPorts,
): Promise<StopRowAnswer> {
	const row = rows.find(candidate => rowMatchesIdentity(candidate, identity));
	if (row === undefined) return { state: "changed", reason: "that process is gone or is not the one that was shown; nothing was stopped" };
	if (!row.stop.available) return { state: "refused", reason: "this build cannot stop it" };
	if (!here.some(candidate => sameBroker(row, candidate))) return { state: "refused", reason: "this window does not run it" };
	try {
		const current = planKillAll((await ports.read()).rows).here.find(candidate => sameBroker(row, candidate) && rowMatchesIdentity(candidate, identity));
		if (current === undefined) return { state: "changed", reason: "it changed before it could be stopped; nothing was stopped" };
		return answerOf(await stopRow(current, ports, { offerForce: false }));
	} catch (error) {
		return { state: "unconfirmed", reason: `it was not stopped: ${asError(error).message}` };
	}
}
