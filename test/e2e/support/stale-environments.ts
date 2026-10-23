/**
 * Which `e2e-run-*` test environments belong to nobody any more, and which of their processes are still running.
 *
 * Every run of the suite creates one environment folder under the shared test root, and agents (or checkouts) run the suite
 * at the same time, so "every folder that is not mine" is somebody else's live window. An environment belongs to the run
 * that wrote `run-owner.json` into it (the Playwright process: its pid and start time), and to nobody once that process is
 * gone. A run killed from outside (a job limit, Task Manager) never reaches its teardown, and a Chat broker is detached by
 * design, so the window, its brokers and their OMP processes keep running after the run is gone.
 *
 * - The processes of an environment are every process whose command line names the folder (the VS Code and bun brokers
 *   carry its data path, OMP its `--cwd`; the same test `scripts/test-vscode.ps1` uses to stop them), and everything
 *   those started.
 * - An environment is abandoned when it has processes and no live owner: the next run stops them. A live owner is never
 *   disturbed, and neither is an environment a development run keeps on purpose (`keep`).
 * - A folder is stale, and deleted, when no process names it and either its owner is gone or (no owner file: an older run, or
 *   a folder a run created seconds ago) it is older than `MIN_STALE_AGE_MS`.
 * - An environment without an owner file (written by a run that predates it) that still has processes is abandoned only after
 *   `LEGACY_ABANDONED_AGE_MS`, far longer than any run: it may be a live run of another checkout.
 *
 * Without a reading of the running processes nothing is abandoned or stale.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const ENVIRONMENT_PREFIX = "e2e-run-";
export const OWNER_FILE = "run-owner.json";
export const MIN_STALE_AGE_MS = 15 * 60_000;
export const LEGACY_ABANDONED_AGE_MS = 6 * 60 * 60_000;
/** The two readings of one process's start time (the owner file's and the process list's) differ by rounding only. */
const START_TOLERANCE_MS = 2_000;

/** The run that created an environment, as it wrote itself into `<environment>/run-owner.json`. */
export interface EnvironmentOwner {
	readonly pid: number;
	/** The owner's start time (ms since the epoch) as the process list reports it; pids are reused, so a pid alone proves nothing. */
	readonly startedAt: number | undefined;
	/** A development run that leaves its VS Code running on purpose (`E2E_KEEP_ENV=1`): ended by `npm run test:e2e:stop`, never by a guard. */
	readonly keep: boolean;
}

export interface ProcessInfo {
	readonly pid: number;
	readonly parentPid: number;
	readonly name: string;
	readonly commandLine: string | undefined;
	/** ms since the epoch. */
	readonly startedAt: number | undefined;
}

export interface EnvironmentEntry {
	readonly name: string;
	/** The folder's own modification time, used when the name carries no readable creation time. */
	readonly modifiedAt: number;
	readonly owner?: EnvironmentOwner;
}

/** The moment a run created `name`: its suffix is `Date.now()` in base 36, or else the folder's modification time. */
export function createdAtOf(entry: Pick<EnvironmentEntry, "name" | "modifiedAt">): number {
	const stamp = Number.parseInt(entry.name.slice(ENVIRONMENT_PREFIX.length), 36);
	return Number.isFinite(stamp) && stamp > 1e12 && stamp < 1e14 ? stamp : entry.modifiedAt;
}

/** Whether `commandLine` names the folder `base` as a path of its own (not a longer name that starts with it). Separators and case do not matter. */
export function namesPath(base: string, commandLine: string | undefined): boolean {
	if (commandLine === undefined) return false;
	const needle = base.toLowerCase().replaceAll("/", "\\");
	const line = commandLine.toLowerCase().replaceAll("/", "\\");
	for (let at = line.indexOf(needle); at >= 0; at = line.indexOf(needle, at + 1)) {
		const next = line[at + needle.length];
		if (next === undefined || next === "\\" || next === '"' || next === "'" || next === " ") return true;
	}
	return false;
}

/**
 * Every process of the environment `base`: those whose command line names it and everything they started. A child never
 * starts before its parent, so a process that merely carries a pid some dead member once had is not followed.
 * `except` are never members (the run itself and its ancestors: a caller's command line may name the folder).
 */
export function environmentProcesses(base: string, processes: readonly ProcessInfo[], except: ReadonlySet<number> = new Set()): ProcessInfo[] {
	const members = new Map<number, ProcessInfo>();
	for (const process of processes) {
		if (!except.has(process.pid) && namesPath(base, process.commandLine)) members.set(process.pid, process);
	}
	for (let grew = true; grew;) {
		grew = false;
		for (const process of processes) {
			if (members.has(process.pid) || except.has(process.pid)) continue;
			const parent = members.get(process.parentPid);
			if (parent === undefined) continue;
			if (process.startedAt !== undefined && parent.startedAt !== undefined && process.startedAt < parent.startedAt) continue;
			members.set(process.pid, process);
			grew = true;
		}
	}
	return [...members.values()];
}

/** This process and its ancestors: what no guard of this run may end. */
export function selfAndAncestors(processes: readonly ProcessInfo[], pid: number): Set<number> {
	const byPid = new Map(processes.map(process => [process.pid, process]));
	const chain = new Set<number>();
	for (let at: number | undefined = pid; at !== undefined && at > 0 && !chain.has(at); at = byPid.get(at)?.parentPid) chain.add(at);
	return chain;
}

/** Whether the run that wrote `owner` still runs: its pid exists and started when the owner file says (a reused pid started later). */
export function ownerRuns(owner: EnvironmentOwner, processes: readonly ProcessInfo[]): boolean {
	const process = processes.find(candidate => candidate.pid === owner.pid);
	if (process === undefined) return false;
	if (owner.startedAt === undefined || process.startedAt === undefined) return true;
	return Math.abs(process.startedAt - owner.startedAt) <= START_TOLERANCE_MS;
}

interface Selection {
	readonly root: string;
	/** The environment a kept run reuses. */
	readonly keep: string | undefined;
	readonly now: number;
	readonly minAgeMs?: number;
	/** Every running process, or `undefined` when they could not be read. */
	readonly processes: readonly ProcessInfo[] | undefined;
	/** The run asking: it and its ancestors are not part of any environment. */
	readonly selfPid?: number;
}

function candidates(entries: readonly EnvironmentEntry[], options: Selection): EnvironmentEntry[] {
	return entries.filter(entry => entry.name.startsWith(ENVIRONMENT_PREFIX) && entry.name !== options.keep);
}

function processesOfEntry(entry: EnvironmentEntry, options: Selection & { readonly processes: readonly ProcessInfo[] }): ProcessInfo[] {
	const except = options.selfPid === undefined ? new Set<number>() : selfAndAncestors(options.processes, options.selfPid);
	return environmentProcesses(join(options.root, entry.name), options.processes, except);
}

/** The environments that still have processes and no run to answer for them: the next run stops them (see the module comment). */
export function selectAbandonedEnvironments(entries: readonly EnvironmentEntry[], options: Selection): string[] {
	const { processes } = options;
	if (processes === undefined) return [];
	return candidates(entries, options)
		.filter(entry => processesOfEntry(entry, { ...options, processes }).length > 0)
		.filter(entry => {
			if (entry.owner === undefined) return options.now - createdAtOf(entry) >= LEGACY_ABANDONED_AGE_MS;
			return !entry.owner.keep && !ownerRuns(entry.owner, processes);
		})
		.map(entry => entry.name);
}

/** The environments whose folder may be deleted: nothing runs in them and nobody owns them (see the module comment). */
export function selectStaleEnvironments(entries: readonly EnvironmentEntry[], options: Selection): string[] {
	const { processes } = options;
	if (processes === undefined) return [];
	const minAge = options.minAgeMs ?? MIN_STALE_AGE_MS;
	return candidates(entries, options)
		.filter(entry => processesOfEntry(entry, { ...options, processes }).length === 0)
		.filter(entry => {
			if (entry.owner !== undefined && !entry.owner.keep) return !ownerRuns(entry.owner, processes);
			return options.now - createdAtOf(entry) >= minAge;
		})
		.map(entry => entry.name);
}

/** Reads `<base>/run-owner.json`; `undefined` when there is none or it is not an owner record. */
export function readOwner(base: string): EnvironmentOwner | undefined {
	try {
		const parsed: unknown = JSON.parse(readFileSync(join(base, OWNER_FILE), "utf8"));
		if (typeof parsed !== "object" || parsed === null) return undefined;
		const { pid, startedAt, keep } = parsed as Record<string, unknown>;
		if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return undefined;
		return { pid, startedAt: typeof startedAt === "number" ? startedAt : undefined, keep: keep === true };
	} catch {
		return undefined;
	}
}

const LIST_SCRIPT = [
	"[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-CimInstance Win32_Process | ForEach-Object {",
	"[pscustomobject]@{ pid = [int]$_.ProcessId; parentPid = [int]$_.ParentProcessId; name = $_.Name; commandLine = $_.CommandLine;",
	"startedAt = $(if ($_.CreationDate) { ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } else { $null }) } }",
	"| ConvertTo-Json -Compress",
].join(" ");

/** Parses the JSON of `LIST_SCRIPT`: one object for a single process, an array otherwise. `undefined` when it is neither. */
export function parseProcessList(stdout: string): ProcessInfo[] | undefined {
	let parsed: unknown;
	try { parsed = JSON.parse(stdout); } catch { return undefined; }
	const rows = Array.isArray(parsed) ? parsed : [parsed];
	const processes: ProcessInfo[] = [];
	for (const row of rows) {
		if (typeof row !== "object" || row === null) return undefined;
		const { pid, parentPid, name, commandLine, startedAt } = row as Record<string, unknown>;
		if (typeof pid !== "number" || typeof parentPid !== "number" || typeof name !== "string") return undefined;
		processes.push({ pid, parentPid, name, commandLine: typeof commandLine === "string" ? commandLine : undefined, startedAt: typeof startedAt === "number" ? startedAt : undefined });
	}
	return processes;
}

/** Every running process (one PowerShell start per call), or `undefined` when they cannot be read. */
export function readProcesses(): Promise<ProcessInfo[] | undefined> {
	const done = Promise.withResolvers<ProcessInfo[] | undefined>();
	const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", LIST_SCRIPT], { windowsHide: true });
	let stdout = "";
	child.stdout.on("data", chunk => { stdout += chunk; });
	const timer = setTimeout(() => { child.kill(); done.resolve(undefined); }, 60_000);
	child.once("error", () => { clearTimeout(timer); done.resolve(undefined); });
	child.once("close", code => {
		clearTimeout(timer);
		done.resolve(code === 0 ? parseProcessList(stdout) : undefined);
	});
	return done.promise;
}

