/**
 * Global setup / teardown of the end-to-end suite.
 *
 *   1. hash the user's real OMP config, plugin lock and VS Code settings (side-effect guard)
 *   2. build the VSIX (or reuse one that is newer than every source file) and start the mock model server
 *   3. write an isolated OMP agent directory that names the mock server as its only provider
 *   4. start the foreground watchdog on the user's desktop and wait until it samples
 *   5. start one VS Code through scripts/test-vscode.ps1 (hidden desktop, fresh profile, CDP port)
 *
 * Every acquired resource is released independently (a failing step never skips the rest, nor the guards); teardown then fails the run if the watchdog saw a test window on the user's desktop or any guarded user
 * file changed. `E2E_KEEP_ENV=1` keeps the VS Code and its profile running so the next run attaches to it (development
 * loop); stop it with `npm run test:e2e:stop`.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startMockServer, type MockServer } from "./fixtures/mock-openai-server.ts";
import * as readmeScene from "./readme/scene.ts";
import { describeChanges, fingerprintUserState, startWatchdog, watchGuardedFiles, type Fingerprint, type Watchdog } from "./support/guard.ts";
import { freePort, REPO_ROOT, startVsCode, stopVsCode, waitForCdp } from "./support/launcher.ts";
import { layoutFromEnv, layoutSettings, seedGlobalState } from "./support/layout.ts";
import { writeFixtureSkill, writeMockAgentConfig, writeProfileSettings } from "./support/omp-agent.ts";
import { ENVIRONMENT_PREFIX, readCommandLines, selectStaleEnvironments } from "./support/stale-environments.ts";
import { STATE_ENV, type RunState } from "./support/state.ts";
import { resolveVsix } from "./support/vsix.ts";

// `E2E_RESULTS_DIR` keeps one run's state, watchdog report and VSIX apart from another run in the same checkout.
const RESULTS_DIR = process.env.E2E_RESULTS_DIR ?? join(REPO_ROOT, "out", "e2e-results");
const KEPT_FILE = join(RESULTS_DIR, "kept-env.json");
const NAME_PREFIX = ENVIRONMENT_PREFIX;

/**
 * Removes the environments earlier runs left behind. Other agents and checkouts run the suite in the same root at the same
 * time, so a folder goes only when no process names it and it is old enough (see `stale-environments.ts`).
 */
async function sweepStaleEnvironments(root: string, keep: string | undefined): Promise<void> {
	if (!existsSync(root)) return;
	const entries = readdirSync(root).filter(name => name.startsWith(NAME_PREFIX)).map(name => ({ name, modifiedAt: statSync(join(root, name)).mtimeMs }));
	const commandLines = await readCommandLines();
	if (commandLines === undefined) console.log("[e2e] could not read the running processes: no earlier test environment is removed");
	for (const name of selectStaleEnvironments(entries, { root, keep, now: Date.now(), commandLines })) {
		await rm(join(root, name), { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
	}
}

async function createFixtureFolders(base: string): Promise<{ folderA: string; folderB: string }> {
	const folderA = join(base, "ws", "alpha-desk");
	const folderB = join(base, "ws", "beta-desk");
	for (const folder of [folderA, folderB]) {
		await mkdir(folder, { recursive: true });
		await writeFile(join(folder, "hello.txt"), "hello from the fixture\n");
	}
	return { folderA, folderB };
}

/** The longest file of the PTY runtime that Desk stages under a profile (content-addressed folder of 64 hex digits). */
const STAGED_RUNTIME_FILE = join("data", "User", "globalStorage", "hmmvot.omp-desk", "runtime", "pty-tree", "0".repeat(64), "node_modules", "node-pty", "prebuilds", "win32-x64", "conpty_console_list.node");
const WINDOWS_PATH_LIMIT = 259;

/** A root that makes that path longer than Windows allows ends in "Failed to load conpty.dll, error code 206" and no session ever starts. */
function assertRootFitsPtyRuntime(base: string): void {
	const length = join(base, STAGED_RUNTIME_FILE).length;
	if (length > WINDOWS_PATH_LIMIT) throw new Error(`the test environment folder ${base} is ${length - STAGED_RUNTIME_FILE.length - 1} characters long: the PTY runtime would be staged at ${length} characters, over the ${WINDOWS_PATH_LIMIT} Windows allows. Use a shorter E2E_ROOT.`);
}

async function alive(port: number): Promise<boolean> {
	try {
		await waitForCdp(port, 3_000);
		return true;
	} catch {
		return false;
	}
}

/** Runs every cleanup even when earlier ones throw; the first error wins and the rest are appended to its message. */
async function runAll(steps: ReadonlyArray<readonly [string, () => Promise<void> | void]>): Promise<string[]> {
	const failures: string[] = [];
	for (const [label, step] of steps) {
		try { await step(); } catch (error) { failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`); }
	}
	return failures;
}

export default async function globalSetup(): Promise<() => Promise<void>> {
	await mkdir(RESULTS_DIR, { recursive: true });
	// `E2E_ROOT` gives a run a root of its own: the stale-environment sweep below deletes every `e2e-run-*` folder of its root, so runs that share one (two agents, two checkouts) end each other's windows.
	const root = process.env.E2E_ROOT ?? join(process.env.LOCALAPPDATA ?? "", "omp-desk-test");
	const keep = process.env.E2E_KEEP_ENV === "1";
	const fingerprint: Fingerprint = await fingerprintUserState();
	const fileWatch = await watchGuardedFiles();

	let watchdog: Watchdog | undefined;
	let mock: Pick<MockServer, "url" | "close"> | undefined;
	let state: RunState | undefined;
	let reused = false;

	/** Stops everything this run acquired, then evaluates both guards. Throws one error that carries every problem. */
	const finish = async (setupError?: unknown): Promise<void> => {
		const problems: string[] = [];
		if (setupError !== undefined) problems.push(`setup failed: ${setupError instanceof Error ? setupError.message : String(setupError)}`);
		const keepRunning = keep && state !== undefined && setupError === undefined;
		problems.push(...await runAll([
			["mock server", async () => { await mock?.close(); }],
			["VS Code", async () => { if (state !== undefined && !keepRunning) await stopVsCode(state.name, state.root); }],
			["test profile", async () => { if (state !== undefined && !keepRunning) await rm(state.base, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); }],
		]));
		if (watchdog !== undefined) {
			const guardDog = watchdog;
			problems.push(...await runAll([["foreground watchdog", async () => {
				const report = await guardDog.stop();
				console.log(`[e2e] foreground watchdog: ${report.samples} samples over ${Math.round(report.durationMs / 1000)} s (every ${report.intervalMs} ms), `
					+ `${report.foregroundChanges} foreground changes, ${report.visibleWindowsSeen} visible windows checked, max gap ${report.maxGapMs} ms, ${report.violations.length} violations`);
				if (report.violations.length > 0) throw new Error(`a test VS Code window reached the user's desktop: ${report.violations.join("; ")}`);
			}]]));
			guardDog.abort();
		}
		problems.push(...await runAll([["user-state guard", async () => {
			const changed = describeChanges(fingerprint, await fingerprintUserState(), fileWatch.events);
			if (changed.length > 0) throw new Error(`the run changed user state it must never touch:\n  ${changed.join("\n  ")}`);
			if (fileWatch.events.length > 0) console.log(`[e2e] note: ${fileWatch.events.length} change events on guarded files left their content identical`);
		}]]));
		fileWatch.stop();
		if (problems.length > 0) throw new Error(`[e2e] ${setupError !== undefined ? "setup/teardown" : "teardown"} problems: ${problems.join(" | ")}`);
	};

	try {
		watchdog = await startWatchdog("omp-desk-test", RESULTS_DIR);
		await watchdog.ready();

		const scene = process.env.E2E_SCENE === "readme" ? readmeScene : undefined;
		const kept: RunState | undefined = existsSync(KEPT_FILE) ? JSON.parse(await readFile(KEPT_FILE, "utf8")) : undefined;
		const keptAlive = kept !== undefined && await alive(kept.cdpPort);
		if (keptAlive && keep && (process.env.E2E_VSIX !== undefined || process.env.E2E_REBUILD === "1")) {
			throw new Error("a kept environment is running and E2E_KEEP_ENV=1 would reuse its installed extension, ignoring E2E_VSIX/E2E_REBUILD; run `npm run test:e2e:stop` first or drop those variables");
		}
		reused = keptAlive && keep;
		await sweepStaleEnvironments(root, reused ? kept?.name : undefined);

		if (reused && kept !== undefined) {
			state = kept;
			mock = scene === undefined ? await startMockServer(Number(new URL(kept.mockUrl).port)) : await scene.startModelServer(kept.folderA, Number(new URL(kept.mockUrl).port));
		} else {
			await rm(KEPT_FILE, { force: true });
			const vsix = await resolveVsix(RESULTS_DIR);
			const name = `${NAME_PREFIX}${Date.now().toString(36)}`;
			const base = join(root, name);
			assertRootFitsPtyRuntime(base);
			const folders = scene === undefined ? await createFixtureFolders(base) : await scene.createFolders(base);
			mock = scene === undefined ? await startMockServer() : await scene.startModelServer(folders.folderA);
			await writeMockAgentConfig(join(base, "agent"), mock.url, scene?.AGENT_CONFIG);
			await writeFixtureSkill(join(base, "agent"));
			await scene?.writeHomeProfile(join(base, "home"));
			const layout = layoutFromEnv();
			await writeProfileSettings(join(base, "data"), layoutSettings(layout));
			seedGlobalState(join(base, "data"), layout);
			const cdpPort = await freePort();
			state = { name, root, base, agentDir: join(base, "agent"), homeDir: join(base, "home"), dataDir: join(base, "data"), cdpPort, mockUrl: mock.url, ...folders, vsix, resultsDir: RESULTS_DIR, layout };
			await startVsCode({ name, root, folder: folders.folderA, vsix, port: cdpPort });
			await waitForCdp(cdpPort, 180_000);
			if (keep) await writeFile(KEPT_FILE, JSON.stringify(state, null, 2));
		}
		const stateFile = join(RESULTS_DIR, "run-state.json");
		await writeFile(stateFile, JSON.stringify(state, null, 2));
		process.env[STATE_ENV] = stateFile;
	} catch (error) {
		await finish(error);
		throw error;
	}
	return () => finish();
}
