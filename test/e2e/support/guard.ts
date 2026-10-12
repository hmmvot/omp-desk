/**
 * Side-effect guard and foreground watchdog supervision.
 *
 * The suite must never change what belongs to the user. Protected state (the exact contract):
 *   - the real OMP global settings `~/.omp/agent/config.yml` and the real VS Code `settings.json` (content hash);
 *   - the real OMP plugin installation `~/.omp/plugins`: the content of every top-level file, the names of every top-level
 *     entry, and for every installed package (`node_modules/<name>`, `node_modules/@scope/<name>`) the content of its
 *     `package.json` - so installs, removals, upgrades and enable/disable toggles are caught. Package sources and the
 *     `cache` directory are not fingerprinted (tens of thousands of files).
 * `PI_CODING_AGENT_DIR` moves only the agent directory, so these paths stay reachable from the test VS Code: the guard
 * detects a change, it does not sandbox. Hashes are taken before anything starts and compared after everything stopped;
 * a change fails the run and nothing is restored (the user's own concurrent edits must never be overwritten). Change
 * events that leave the content identical (an editor re-saving the same bytes) are only reported. For a changed small
 * text file the failure names the changed lines and the time of every change event, so a real side effect (a line that
 * mentions the test environment) can be told from the user's own concurrent OMP or VS Code saving their settings.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, watch, type FSWatcher } from "node:fs";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "./launcher.ts";
import { sleep } from "./time.ts";

const OMP_HOME = join(homedir(), ".omp");
const APP_DATA = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");

const PLUGINS_DIR = join(OMP_HOME, "plugins");
/** Files compared by content, always. */
const FIXED_FILES: readonly string[] = [
	join(OMP_HOME, "agent", "config.yml"),
	join(APP_DATA, "Code", "User", "settings.json"),
];

/** Top-level plugin files and every installed package manifest. */
async function pluginFiles(): Promise<string[]> {
	if (!existsSync(PLUGINS_DIR)) return [];
	const files: string[] = [];
	const entries = await readdir(PLUGINS_DIR, { withFileTypes: true });
	for (const entry of entries) if (entry.isFile()) files.push(join(PLUGINS_DIR, entry.name));
	const modules = join(PLUGINS_DIR, "node_modules");
	if (!existsSync(modules)) return files;
	for (const pkg of await readdir(modules, { withFileTypes: true })) {
		if (pkg.name === ".bin" || pkg.name.startsWith(".")) continue;
		if (pkg.name.startsWith("@")) {
			for (const scoped of await readdir(join(modules, pkg.name), { withFileTypes: true })) files.push(join(modules, pkg.name, scoped.name, "package.json"));
		} else {
			files.push(join(modules, pkg.name, "package.json"));
		}
	}
	return files;
}

async function guardedFiles(): Promise<string[]> {
	return [...FIXED_FILES, ...await pluginFiles()];
}

export interface Fingerprint {
	readonly hashes: Readonly<Record<string, string>>;
	readonly texts: Readonly<Record<string, string>>;
}

export async function fingerprintUserState(): Promise<Fingerprint> {
	const hashes: Record<string, string> = {};
	const texts: Record<string, string> = {};
	for (const file of await guardedFiles()) {
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
export async function watchGuardedFiles(): Promise<{ readonly events: string[]; stop(): void }> {
	const events: string[] = [];
	const watchers: FSWatcher[] = [];
	for (const file of FIXED_FILES.concat(await pluginFiles().then(files => files.filter(file => !file.includes("node_modules"))))) {
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
	/** Resolves once the sampling loop runs; rejects if the watchdog exits or does not start. Call before launching VS Code. */
	ready(): Promise<void>;
	/** Ends the watchdog and returns its fresh report. Throws when the watchdog failed, timed out or wrote no report. */
	stop(): Promise<WatchdogReport>;
	/** Kills the watchdog without a report (setup failed before it was needed). */
	abort(): void;
}

/**
 * Starts test/e2e/foreground-watchdog.ps1 on the user's desktop; it also ends when this process exits. Stale ready, stop
 * and report files of a previous run are removed first, so a report can only come from this watchdog. This is sampled
 * detection (every ~50 ms), not proof that no transient foreground event ever occurred.
 */
export async function startWatchdog(marker: string, dir: string): Promise<Watchdog> {
	const reportFile = join(dir, "watchdog.json");
	const stopFile = join(dir, "watchdog.stop");
	const readyFile = join(dir, "watchdog.ready");
	for (const file of [reportFile, stopFile, readyFile]) await rm(file, { force: true });
	const script = join(REPO_ROOT, "test", "e2e", "foreground-watchdog.ps1");
	const child: ChildProcess = spawn("powershell.exe", [
		"-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script,
		"-Marker", marker, "-ReportFile", reportFile, "-StopFile", stopFile, "-ReadyFile", readyFile, "-ParentPid", String(process.pid),
	], { cwd: REPO_ROOT, windowsHide: true, stdio: "ignore" });
	const exited = new Promise<number | null>(resolve => child.once("close", code => resolve(code)));
	let exitCode: number | null | undefined;
	void exited.then(code => { exitCode = code; });
	return {
		async ready(): Promise<void> {
			const deadline = Date.now() + 60_000;
			while (!existsSync(readyFile)) {
				if (exitCode !== undefined) throw new Error(`the foreground watchdog exited with code ${exitCode} before it started sampling`);
				if (Date.now() > deadline) throw new Error("the foreground watchdog did not start sampling within 60 s");
				await sleep(100);
			}
		},
		async stop(): Promise<WatchdogReport> {
			await writeFile(stopFile, "stop");
			const code = await Promise.race([exited, sleep(30_000).then(() => "timeout" as const)]);
			if (code === "timeout") { child.kill(); throw new Error("the foreground watchdog did not stop within 30 s"); }
			if (code !== 0 && code !== 3) throw new Error(`the foreground watchdog failed with exit code ${code}`);
			if (!existsSync(reportFile)) throw new Error("the foreground watchdog wrote no report");
			return JSON.parse(await readFile(reportFile, "utf8"));
		},
		abort(): void { child.kill(); },
	};
}
