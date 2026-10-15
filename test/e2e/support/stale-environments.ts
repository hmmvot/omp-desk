/**
 * Which `e2e-run-*` test environments a run may delete before it starts its own.
 *
 * Every run of the suite creates one environment folder under the shared test root, and agents (or checkouts) run the suite
 * at the same time, so "every folder that is not mine" is somebody else's live window. A folder is stale only when both hold:
 *
 * - no running process names it: the VS Code and bun brokers of an environment, and the OMP processes under them, carry the
 *   folder's path in their command line (the same test `scripts/test-vscode.ps1` uses to find a window to stop);
 * - it is older than `MIN_STALE_AGE_MS`: a run creates its folder several seconds before its VS Code starts, and a loaded
 *   machine stretches that gap, so a folder with no process yet is not necessarily abandoned.
 *
 * Without a reading of the running processes nothing is stale.
 */
import { spawn } from "node:child_process";
import { join } from "node:path";

export const ENVIRONMENT_PREFIX = "e2e-run-";
export const MIN_STALE_AGE_MS = 15 * 60_000;

export interface EnvironmentEntry {
	readonly name: string;
	/** The folder's own modification time, used when the name carries no readable creation time. */
	readonly modifiedAt: number;
}

/** The moment a run created `name`: its suffix is `Date.now()` in base 36, or else the folder's modification time. */
export function createdAtOf(entry: EnvironmentEntry): number {
	const stamp = Number.parseInt(entry.name.slice(ENVIRONMENT_PREFIX.length), 36);
	return Number.isFinite(stamp) && stamp > 1e12 && stamp < 1e14 ? stamp : entry.modifiedAt;
}

/** Whether one of `commandLines` names the folder `base` as a path of its own (not a longer name that starts with it). */
function isNamed(base: string, commandLines: readonly string[]): boolean {
	const needle = base.toLowerCase();
	return commandLines.some(commandLine => {
		const line = commandLine.toLowerCase();
		for (let at = line.indexOf(needle); at >= 0; at = line.indexOf(needle, at + 1)) {
			const next = line[at + needle.length];
			if (next === undefined || next === "\\" || next === "/" || next === '"' || next === "'" || next === " ") return true;
		}
		return false;
	});
}

export function selectStaleEnvironments(entries: readonly EnvironmentEntry[], options: {
	readonly root: string;
	/** The environment a kept run reuses. */
	readonly keep: string | undefined;
	readonly now: number;
	readonly minAgeMs?: number;
	/** The command lines of every running process, or `undefined` when they could not be read. */
	readonly commandLines: readonly string[] | undefined;
}): string[] {
	if (options.commandLines === undefined) return [];
	const minAge = options.minAgeMs ?? MIN_STALE_AGE_MS;
	return entries
		.filter(entry => entry.name.startsWith(ENVIRONMENT_PREFIX) && entry.name !== options.keep)
		.filter(entry => options.now - createdAtOf(entry) >= minAge)
		.filter(entry => !isNamed(join(options.root, entry.name), options.commandLines ?? []))
		.map(entry => entry.name);
}

/** The command line of every running process (one PowerShell start per run), or `undefined` when it cannot be read. */
export function readCommandLines(): Promise<string[] | undefined> {
	const script = "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine } | ForEach-Object { $_.CommandLine } | ConvertTo-Json -Compress";
	const done = Promise.withResolvers<string[] | undefined>();
	const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], { windowsHide: true });
	let stdout = "";
	child.stdout.on("data", chunk => { stdout += chunk; });
	const timer = setTimeout(() => { child.kill(); done.resolve(undefined); }, 60_000);
	child.once("error", () => { clearTimeout(timer); done.resolve(undefined); });
	child.once("close", code => {
		clearTimeout(timer);
		try {
			const parsed: unknown = JSON.parse(stdout);
			const lines = typeof parsed === "string" ? [parsed] : parsed;
			done.resolve(code === 0 && Array.isArray(lines) && lines.every(line => typeof line === "string") ? lines : undefined);
		} catch {
			done.resolve(undefined);
		}
	});
	return done.promise;
}
