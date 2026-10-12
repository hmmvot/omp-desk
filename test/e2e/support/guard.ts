/**
 * Side-effect guard and foreground watchdog supervision.
 *
 * The suite must never change what belongs to the user: the real OMP global settings (`~/.omp/agent/config.yml`),
 * the OMP plugin lock (`~/.omp/plugins` is not moved by `PI_CODING_AGENT_DIR`) and the real VS Code `settings.json`.
 * SHA-256 hashes are taken before anything starts and compared after everything stopped. For a changed small text
 * file the failure names the changed lines and the time of every change event seen during the run, so a real
 * side effect (a line that mentions the test environment) can be told from the user's own concurrent OMP or VS Code
 * saving their settings (a line that has nothing to do with it).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, watch, type FSWatcher } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "./launcher.ts";
import { sleep } from "./time.ts";

const OMP_HOME = join(homedir(), ".omp");
const APP_DATA = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");

/** Small text files compared by content. */
const GUARDED_FILES: readonly string[] = [
	join(OMP_HOME, "agent", "config.yml"),
	join(APP_DATA, "Code", "User", "settings.json"),
	...["installed_plugins.json", "omp-plugins.lock.json", "package.json", "bun.lock"].map(name => join(OMP_HOME, "plugins", name)),
];
const PLUGINS_DIR = join(OMP_HOME, "plugins");

export interface Fingerprint {
	readonly hashes: Readonly<Record<string, string>>;
	readonly texts: Readonly<Record<string, string>>;
}

export async function fingerprintUserState(): Promise<Fingerprint> {
	const hashes: Record<string, string> = {};
	const texts: Record<string, string> = {};
	for (const file of GUARDED_FILES) {
		if (!existsSync(file)) { hashes[file] = "absent"; continue; }
		const bytes = await readFile(file);
		hashes[file] = createHash("sha256").update(bytes).digest("hex");
		if (bytes.length < 64 * 1024) texts[file] = bytes.toString("utf8");
	}
	const names = existsSync(PLUGINS_DIR) ? (await readdir(PLUGINS_DIR)).sort() : [];
	hashes[`${PLUGINS_DIR} (top-level names)`] = createHash("sha256").update(names.join("\n")).digest("hex");
	return { hashes, texts };
}

/** Records when each guarded file reported a change while the suite ran. */
export function watchGuardedFiles(): { readonly events: string[]; stop(): void } {
	const events: string[] = [];
	const watchers: FSWatcher[] = [];
	for (const file of GUARDED_FILES) {
		if (!existsSync(file)) continue;
		watchers.push(watch(file, () => events.push(`${new Date().toISOString()} ${file}`)));
	}
	return { events, stop: () => watchers.forEach(watcher => watcher.close()) };
}

function changedLines(before: string, after: string): string[] {
	const old = new Set(before.split(/\r?\n/));
	const current = new Set(after.split(/\r?\n/));
	return [
		...[...old].filter(line => !current.has(line)).map(line => `- ${line}`),
		...[...current].filter(line => !old.has(line)).map(line => `+ ${line}`),
	];
}

/** One description per guarded path whose content differs; empty when nothing changed. */
export function describeChanges(before: Fingerprint, after: Fingerprint, events: readonly string[]): string[] {
	const out: string[] = [];
	for (const key of Object.keys(before.hashes)) {
		if (before.hashes[key] === after.hashes[key]) continue;
		const lines = key in before.texts && key in after.texts ? changedLines(before.texts[key], after.texts[key]) : [];
		out.push(`${key} changed${lines.length > 0 ? `:\n    ${lines.join("\n    ")}` : ""}`);
	}
	if (out.length > 0 && events.length > 0) out.push(`change events seen: ${events.join("; ")}`);
	return out;
}

export interface WatchdogReport {
	readonly samples: number;
	readonly durationMs: number;
	readonly intervalMs: number;
	readonly foregroundChanges: number;
	readonly distinctForegroundProcesses: number;
	readonly windowEnumerations: number;
	readonly visibleWindowsSeen: number;
	readonly maxGapMs: number;
	readonly violations: readonly string[];
}

export interface Watchdog {
	/** Ends the watchdog and returns its report. Throws when it could not produce one. */
	stop(): Promise<WatchdogReport>;
}

/** Starts test/e2e/foreground-watchdog.ps1 on the user's desktop; it also ends when this process exits. */
export function startWatchdog(marker: string, reportFile: string, stopFile: string): Watchdog {
	const script = join(REPO_ROOT, "test", "e2e", "foreground-watchdog.ps1");
	const child: ChildProcess = spawn("powershell.exe", [
		"-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script,
		"-Marker", marker, "-ReportFile", reportFile, "-StopFile", stopFile, "-ParentPid", String(process.pid),
	], { cwd: REPO_ROOT, windowsHide: true, stdio: "ignore" });
	const closed = Promise.withResolvers<void>();
	child.once("close", () => closed.resolve());
	return {
		async stop(): Promise<WatchdogReport> {
			await writeFile(stopFile, "stop");
			await Promise.race([closed.promise, sleep(20_000)]);
			if (!existsSync(reportFile)) throw new Error("the foreground watchdog wrote no report");
			return JSON.parse(await readFile(reportFile, "utf8"));
		},
	};
}
