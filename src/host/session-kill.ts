/**
 * Kill: end one session's, terminal's or process's process tree at once.
 *
 * This is the user's explicit decision of 2026-10-12 (ADR-0060, amended) and the one place that
 * signals a process id. It is deliberately not a stop: it asks OMP nothing, waits for no answer and
 * reads neither the session's state (busy, settled), nor who holds it, nor its claims. Every
 * other stop path (Stop, Stop Orphaned and Idle, Kill All) keeps its authenticated, graceful
 * semantics and never reaches this module.
 *
 * ## What is killed
 *
 * The *broker*: the detached process that owns the session (ADR-0024, ADR-0038). It is the parent of
 * the OMP child on both paths (a pipe child for chat, the process started in the pseudo console
 * for a native terminal and for a folder shell), so the tree it roots is the broker, OMP, the
 * pseudo console host and what OMP started and did not detach. A session that recorded its OMP
 * child additionally names it as a second root, which covers an OMP process that outlived a dead
 * broker.
 *
 * ## The one check that stays
 *
 * A process id is not an identity: Windows reuses ids (ADR-0035). Every root carries the kernel
 * creation time Desk recorded for it (the broker's own record, or the session's recorded host),
 * and is killed only when a fresh reading of that id equals it. An id that is gone, or that now
 * belongs to a process created later, is "already gone": nothing is killed. A reading that cannot
 * decide refuses too, because killing on a guess could end a stranger. This is not a state check
 * of OMP; it is what makes the target the process Desk means. The check and the kill are two
 * steps, so it is a best-effort guard, not an atomic one: a stranger could be ended only if the
 * recorded process exited and its id was reissued between them.
 *
 * ## How
 *
 * `taskkill.exe /PID <pid> /T /F` from `System32` (never found on `PATH`): the operating system's
 * own tree kill. It needs no helper script and adds no dependency. Which descendants it reaches
 * and in what order is taskkill's own behaviour, not something this module proves: a descendant
 * that detached from the tree earlier is not reached, and nothing here claims the tree empty
 * (ADR-0029). What is proven is each *recorded root*: after the kill it is shown gone by a
 * liveness look and, when its id is still in use, by the creation-time probe, so an exit code is
 * never trusted alone.
 *
 * ## Records
 *
 * A session's records are retired only when the captured OMP child (id and creation time) is among
 * the roots and is proven gone. A broker's absence alone is never writer evidence.
 *
 * This module has no `vscode` import and does no I/O but through its ports.
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { join } from "node:path";
import type { Logger } from "../shared/logger.ts";
import type { BrokerProcessRow } from "./broker-processes.ts";
import type { PtyGoneReading, PtyIdentityReading } from "./pty-identity.ts";

/** How long a root may take to disappear after the tree kill returned. */
export const KILL_GONE_TIMEOUT_MS = 5_000;
/** Bound on one `taskkill` run. */
export const TASKKILL_TIMEOUT_MS = 15_000;
const MAX_TASKKILL_OUTPUT = 4 * 1024;
/** Characters of `taskkill`'s own output the log keeps when a kill was incomplete or failed. */
const LOGGED_TASKKILL_OUTPUT = 400;
/** After the kill: looks at the cheap liveness before the creation-time probe is asked. */
const FAST_GONE_ATTEMPTS = 40;
const FAST_GONE_PAUSE_MS = 50;

/** One process the kill may end, with the creation time Desk recorded for it. */
export interface KillRoot {
	readonly pid: number;
	/** FILETIME decimal string. A root without one is never killed (it cannot be told from a stranger). */
	readonly creationTime: string;
	readonly role: "broker" | "child";
}

/** The session host Desk recorded: the same facts the session index keeps for a running row. */
export interface RecordedProcess {
	readonly slot: string;
	readonly brokerId: string;
	readonly brokerGeneration: string;
	readonly brokerPid: number;
	readonly brokerCreationTime: string | null;
	readonly childPid: number | null;
	readonly childCreationTime: string | null;
	/** The launch attempt the host record names (`host.startedAt`), `null` when the row records no host. */
	readonly attemptStartedAt: string | null;
	/** The host record's own pid (`host.pid`). */
	readonly hostPid: number | null;
}

/** The exact incarnation of a session's process that a kill examined; reconciliation applies to this and nothing newer. */
export interface CapturedHost {
	readonly slot: string;
	readonly brokerId: string;
	readonly brokerGeneration: string;
	readonly attemptStartedAt: string;
	readonly hostPid: number | null;
}

/** What the user pointed at. */
export type KillSelection =
	| { readonly kind: "session"; readonly tabId: string; readonly title: string }
	| { readonly kind: "process"; readonly row: BrokerProcessRow };

/** What to do with Desk's own records once a target's roots are proven gone. */
export type KillReconcile =
	/** A session row: its host record, claim and stopped intent, for exactly the captured incarnation (`reconcileSession`). */
	| { readonly kind: "session"; readonly tabId: string; readonly captured: CapturedHost }
	/** A folder shell or a mapping no row records: only the broker-slot mapping of the broker shown gone is forgotten; a shell's recovery record stays for its owner's watch. */
	| { readonly kind: "slot"; readonly slot: string }
	| { readonly kind: "none" };

export interface KillTarget {
	/** What the user knows it as, for messages. */
	readonly label: string;
	readonly slot: string | null;
	/** Broker first; the recorded OMP child after it. */
	readonly roots: readonly KillRoot[];
	readonly reconcile: KillReconcile;
}

/** What the kernel gave one `taskkill` run. */
export interface TreeKillRun {
	readonly started: boolean;
	readonly exitCode: number | null;
	/** Bounded stdout and stderr, for the log only. */
	readonly output: string;
	readonly timedOut: boolean;
}

export interface TreeKillPorts {
	/** Whether any process has this id right now (a syscall; `false` is conclusive, `true` proves nothing about identity). */
	isAlive(pid: number): boolean;
	/** Wait before the next liveness look. */
	pause(ms: number): Promise<void>;
	readIdentity(pid: number): Promise<PtyIdentityReading>;
	killTree(pid: number): Promise<TreeKillRun>;
	waitGone(pid: number, creationTime: string, timeoutMs: number): Promise<PtyGoneReading>;
}

export type RootResult =
	| { readonly root: KillRoot; readonly kind: "killed"; readonly incomplete: string | null; readonly output: string }
	| { readonly root: KillRoot; readonly kind: "gone"; readonly why: string }
	| { readonly root: KillRoot; readonly kind: "failed"; readonly reason: string; readonly output: string };

export interface KillOutcome {
	/** `killed`: something was ended and nothing failed. `gone`: every root was already gone. `failed`: at least one root could not be ended or shown gone. */
	readonly kind: "killed" | "gone" | "failed";
	/** `taskkill` could not end something in a tree whose root is gone. */
	readonly incomplete: boolean;
	readonly results: readonly RootResult[];
	/** One authored sentence for the user. */
	readonly message: string;
	/** What the log gets: ids, results and, for an incomplete or failed kill, a bounded excerpt of taskkill's own output. */
	readonly detail: string;
}

/** The `System32` copy: a development toolchain on `PATH` can ship its own `taskkill`. */
export function taskkillExecutable(): string {
	const root = process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows";
	return join(root, "System32", "taskkill.exe");
}

/** Run the operating system's tree kill on one process id. Never throws. */
export function runTaskkillTree(pid: number, timeoutMs = TASKKILL_TIMEOUT_MS): Promise<TreeKillRun> {
	const notRun: TreeKillRun = { started: false, exitCode: null, output: "", timedOut: false };
	if (process.platform !== "win32" || !Number.isSafeInteger(pid) || pid <= 0) return Promise.resolve(notRun);
	let child: ChildProcess;
	try {
		child = spawn(taskkillExecutable(), ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
	} catch {
		return Promise.resolve(notRun);
	}
	const { promise, resolve } = Promise.withResolvers<TreeKillRun>();
	let output = "";
	let timedOut = false;
	let settled = false;
	const finish = (run: TreeKillRun): void => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		resolve(run);
	};
	const take = (chunk: Buffer): void => {
		if (output.length < MAX_TASKKILL_OUTPUT) output += chunk.toString("utf8");
	};
	child.stdout?.on("data", take);
	child.stderr?.on("data", take);
	const timer = setTimeout(() => {
		timedOut = true;
		child.kill();
	}, timeoutMs);
	timer.unref();
	child.on("error", () => finish({ started: false, exitCode: null, output, timedOut }));
	child.on("close", code => finish({ started: true, exitCode: code, output: output.slice(0, MAX_TASKKILL_OUTPUT), timedOut }));
	return promise;
}

function excerpt(output: string): string {
	return output.replace(/\s+/g, " ").trim().slice(0, LOGGED_TASKKILL_OUTPUT);
}

async function killRoot(root: KillRoot, ports: TreeKillPorts): Promise<RootResult> {
	// No process has this id: nothing to verify and nothing to kill, with no process spawn (the common case of an OMP child that went with its broker).
	if (!ports.isAlive(root.pid)) return { root, kind: "gone", why: "no process has this id any more" };
	let reading: PtyIdentityReading;
	try {
		reading = await ports.readIdentity(root.pid);
	} catch (error) {
		return { root, kind: "failed", reason: `the process could not be verified (${error instanceof Error ? error.message : String(error)})`, output: "" };
	}
	if (reading.kind === "gone") return { root, kind: "gone", why: "no process has this id any more" };
	if (reading.kind === "unknown") return { root, kind: "failed", reason: `the process could not be verified, so nothing was killed (${reading.detail})`, output: "" };
	if (reading.creationTime !== root.creationTime) return { root, kind: "gone", why: "the id now belongs to a process created later" };
	const run = await ports.killTree(root.pid);
	if (!run.started) return { root, kind: "failed", reason: "Windows' taskkill could not be started", output: "" };
	// A process id that no longer exists is conclusive and costs no process spawn; only an id still in use needs the creation-time probe.
	let proved = false;
	for (let attempt = 0; attempt < FAST_GONE_ATTEMPTS && !proved; attempt++) {
		if (!ports.isAlive(root.pid)) proved = true;
		else await ports.pause(FAST_GONE_PAUSE_MS);
	}
	const gone = proved
		? { gone: true, detail: "no process has this id any more" }
		: await ports.waitGone(root.pid, root.creationTime, KILL_GONE_TIMEOUT_MS).catch(error => ({ gone: false, detail: `the process probe failed: ${error instanceof Error ? error.message : String(error)}` }));
	const how = run.timedOut ? "taskkill did not finish in time" : `taskkill exited with ${run.exitCode ?? "no code"}`;
	if (!gone.gone) {
		return { root, kind: "failed", reason: `it could not be confirmed gone after the kill (${how}; ${gone.detail}); Windows may have refused it (access denied or a protected process)`, output: excerpt(run.output) };
	}
	// The root is gone. A non-zero exit means taskkill could not end something in its tree.
	return { root, kind: "killed", incomplete: run.exitCode === 0 ? null : how, output: excerpt(run.output) };
}

function describeRoot(result: RootResult): string {
	const who = `${result.root.role} pid ${result.root.pid}`;
	if (result.kind === "killed") return `${who}: tree kill issued, root gone${result.incomplete === null ? "" : ` (incomplete: ${result.incomplete}; taskkill said: ${result.output})`}`;
	if (result.kind === "gone") return `${who}: already gone (${result.why})`;
	return `${who}: FAILED (${result.reason}${result.output === "" ? "" : `; taskkill said: ${result.output}`})`;
}

/**
 * Kill the roots of one target, broker first.
 *
 * The broker's tree normally holds the recorded OMP child, so by the time the second root is read it
 * is gone and costs nothing; an OMP process that outlived its broker is still found by its own
 * recorded identity.
 */
export async function killProcessTree(target: KillTarget, ports: TreeKillPorts): Promise<KillOutcome> {
	const results: RootResult[] = [];
	for (const root of target.roots) results.push(await killRoot(root, ports));
	const failed = results.find(result => result.kind === "failed");
	const killed = results.filter(result => result.kind === "killed");
	const incomplete = killed.some(result => result.kind === "killed" && result.incomplete !== null);
	const detail = results.map(describeRoot).join("; ");
	if (failed !== undefined && failed.kind === "failed") {
		return { kind: "failed", incomplete, results, detail, message: `${target.label} could not be killed: ${failed.reason}.` };
	}
	if (killed.length > 0) {
		return {
			kind: "killed",
			incomplete,
			results,
			detail,
			message: incomplete
				? `${target.label} was killed, but Windows could not end every process it started. Check Task Manager for leftovers.`
				: `${target.label} was killed.`,
		};
	}
	return { kind: "gone", incomplete: false, results, detail, message: `${target.label} is already gone; nothing was killed.` };
}

function rootsOf(pid: number, creationTime: string | null, role: KillRoot["role"]): KillRoot[] {
	return creationTime === null || !Number.isSafeInteger(pid) || pid <= 0 ? [] : [{ pid, creationTime, role }];
}

function labelOfRow(row: BrokerProcessRow): string {
	if (row.kind === "stats") return "the Stats dashboard";
	if (row.host?.kind === "session") return `the OMP session "${row.host.title}"`;
	if (row.host?.kind === "terminal") return `the terminal "${row.host.label}"`;
	if (row.kind === "terminal") return "a terminal";
	return row.title === null || row.title === "" ? "an OMP session process" : `the OMP session "${row.title}"`;
}

/**
 * The session reconciliation of a target: only when the captured launch attempt and the OMP child's id
 * and creation time are all known, so that the child is a root and its absence is what the records are
 * retired on. Without them nothing is recorded: a broker's absence alone is not evidence about its writer.
 */
function sessionReconcile(tabId: string, recorded: RecordedProcess | null): KillReconcile {
	if (recorded === null || recorded.attemptStartedAt === null) return { kind: "none" };
	if (rootsOf(recorded.childPid ?? 0, recorded.childCreationTime, "child").length === 0) return { kind: "none" };
	return {
		kind: "session",
		tabId,
		captured: { slot: recorded.slot, brokerId: recorded.brokerId, brokerGeneration: recorded.brokerGeneration, attemptStartedAt: recorded.attemptStartedAt, hostPid: recorded.hostPid },
	};
}

/** What Desk's records still hold for a killed row, by what the row is. The same rule a broker-route stop uses to retire a slot. */
function reconcileOfRow(row: BrokerProcessRow, recorded: RecordedProcess | null): KillReconcile {
	if (row.kind === "terminal") return { kind: "slot", slot: row.slot };
	if (row.kind !== "session") return { kind: "none" };
	if (row.host?.kind === "session" && row.host.recorded && row.host.tabId !== null) {
		const under = recorded !== null && recorded.brokerId === row.brokerId && recorded.brokerGeneration === row.generation ? recorded : null;
		return sessionReconcile(row.host.tabId, under);
	}
	return { kind: "slot", slot: row.slot };
}

/**
 * The target a process row stands for: its broker, plus the OMP child when the session recorded it
 * under this exact broker (`recorded`).
 */
export function targetOfRow(row: BrokerProcessRow, recorded: RecordedProcess | null = null): KillTarget {
	const roots = rootsOf(row.brokerPid, row.brokerCreationTime === "" ? null : row.brokerCreationTime, "broker");
	const under = recorded !== null && recorded.brokerId === row.brokerId && recorded.brokerGeneration === row.generation ? recorded : null;
	if (under !== null) roots.push(...rootsOf(under.childPid ?? 0, under.childCreationTime, "child"));
	return { label: labelOfRow(row), slot: row.slot, roots, reconcile: reconcileOfRow(row, recorded) };
}

/** The target a session's recorded host stands for, with no process row needed. */
export function targetOfRecorded(tabId: string, title: string, recorded: RecordedProcess): KillTarget {
	return {
		label: `the OMP session "${title}"`,
		slot: recorded.slot,
		roots: [...rootsOf(recorded.brokerPid, recorded.brokerCreationTime, "broker"), ...rootsOf(recorded.childPid ?? 0, recorded.childCreationTime, "child")],
		reconcile: sessionReconcile(tabId, recorded),
	};
}

/**
 * The processes a session's Kill ends: the session's recorded host when it has one (no read needed:
 * the broker's own record, kept by the index), otherwise every live broker row that hosts the
 * conversation. Pure; an empty answer means the session has no process Desk knows of.
 */
export function planSessionKill(tabId: string, title: string, recorded: RecordedProcess | null, rows: readonly BrokerProcessRow[]): readonly KillTarget[] {
	if (recorded !== null && recorded.brokerCreationTime !== null) return [targetOfRecorded(tabId, title, recorded)];
	const hosting = rows.filter(row => row.host?.kind === "session" && row.host.tabId === tabId);
	if (hosting.length > 0) return hosting.map(row => targetOfRow(row, recorded));
	// A host that recorded no broker creation time can still name its OMP child.
	if (recorded !== null) {
		const roots = rootsOf(recorded.childPid ?? 0, recorded.childCreationTime, "child");
		if (roots.length > 0) return [{ label: `the OMP session "${title}"`, slot: recorded.slot, roots, reconcile: sessionReconcile(tabId, recorded) }];
	}
	return [];
}

/** Everything the Kill command needs from the window. */
export interface KillCommandPorts extends TreeKillPorts {
	/** The live broker rows, read only when the session recorded no host. */
	readRows(): Promise<readonly BrokerProcessRow[]>;
	recordedProcess(tabId: string): RecordedProcess | null;
	/** Retire a shell recovery record and a broker slot mapping the killed process left. */
	forgetStoppedSlot(slot: string): Promise<void>;
	/**
	 * Let the session index record exactly the captured incarnation as stopped (stopped intent, claim, host
	 * record). It leaves the row alone when the session started a new process meanwhile or a live window holds it:
	 * that window's own broker watch finishes it. Throws when the records could not be updated.
	 */
	reconcileSession(tabId: string, captured: CapturedHost): Promise<void>;
	/** Re-read the Sessions view. */
	refresh(): Promise<unknown>;
	info(message: string): void;
	warn(message: string): void;
	readonly log: Logger;
	/** Who asked, for the log. */
	readonly requester: string;
}

/** The Kill command: plan, kill, reconcile, report. Never throws. */
export async function killSelection(selection: KillSelection, ports: KillCommandPorts): Promise<void> {
	let targets: readonly KillTarget[];
	try {
		if (selection.kind === "process") {
			const host = selection.row.host;
			const recorded = host?.kind === "session" && host.tabId !== null ? ports.recordedProcess(host.tabId) : null;
			targets = [targetOfRow(selection.row, recorded)];
		} else {
			const recorded = ports.recordedProcess(selection.tabId);
			targets = planSessionKill(selection.tabId, selection.title, recorded, recorded !== null && recorded.brokerCreationTime !== null ? [] : await ports.readRows());
		}
	} catch (error) {
		ports.log.error(`kill: the target could not be planned (${error instanceof Error ? error.message : String(error)})`);
		ports.warn("Kill could not find the process of this row. Refresh Sessions and try again.");
		return;
	}
	if (targets.length === 0) {
		ports.log.info(`kill: requested by ${ports.requester}: no recorded process for ${selection.kind === "session" ? `session ${selection.tabId}` : selection.row.id}`);
		ports.info("This row has no process Desk knows of, so there is nothing to kill.");
		return;
	}
	try {
		for (const target of targets) {
			if (target.roots.length === 0) {
				ports.log.warn(`kill: requested by ${ports.requester}: ${target.label}: no process identity is recorded (no creation time), so nothing was killed`);
				ports.warn(`${target.label} recorded no process identity, so Kill cannot tell it from another process and killed nothing. Use Stop, or Task Manager.`);
				continue;
			}
			const outcome = await killProcessTree(target, ports);
			const line = `kill: requested by ${ports.requester}: ${target.label}${target.slot === null ? "" : ` (slot ${target.slot})`}: ${outcome.kind}: ${outcome.detail}`;
			if (outcome.kind === "failed") ports.log.error(line);
			else if (outcome.incomplete) ports.log.warn(line);
			else ports.log.info(line);
			if (outcome.kind === "failed") {
				ports.warn(outcome.message);
				continue;
			}
			if (outcome.kind === "gone") ports.info(outcome.message);
			else if (outcome.incomplete) ports.warn(outcome.message);
			// Every root of the target is proven gone (killed now, or not running): what its records say is stale.
			await reconcile(target, ports);
		}
	} finally {
		await ports.refresh().catch(() => undefined);
	}
}

async function reconcile(target: KillTarget, ports: KillCommandPorts): Promise<void> {
	try {
		if (target.reconcile.kind === "slot") await ports.forgetStoppedSlot(target.reconcile.slot);
		else if (target.reconcile.kind === "session") await ports.reconcileSession(target.reconcile.tabId, target.reconcile.captured);
	} catch (error) {
		ports.log.error(`kill: ${target.label}: its records could not be updated (${error instanceof Error ? error.message : String(error)})`);
		ports.warn(`${target.label} was killed, but Desk could not update its own records. Refresh Sessions; see the OMP Desk output.`);
	}
}
