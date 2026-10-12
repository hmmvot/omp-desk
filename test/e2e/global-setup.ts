/**
 * Global setup / teardown of the end-to-end suite.
 *
 *   1. hash the user's real OMP config, plugin lock and VS Code settings (side-effect guard)
 *   2. build the VSIX (or reuse one that is newer than every source file) and start the mock model server
 *   3. write an isolated OMP agent directory that names the mock server as its only provider
 *   4. start the foreground watchdog on the user's desktop
 *   5. start one VS Code through scripts/test-vscode.ps1 (hidden desktop, fresh profile, CDP port)
 *
 * Teardown reverses it, then fails the run if the watchdog saw a test window on the user's desktop or any guarded user
 * file changed. `E2E_KEEP_ENV=1` keeps the VS Code and its profile running so the next run attaches to it (development
 * loop); stop it with `npm run test:e2e:stop`.
 */
import { existsSync, readdirSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startMockServer, type MockServer } from "./fixtures/mock-openai-server.ts";
import { describeChanges, fingerprintUserState, startWatchdog, watchGuardedFiles, type Fingerprint } from "./support/guard.ts";
import { freePort, REPO_ROOT, startVsCode, stopVsCode, waitForCdp } from "./support/launcher.ts";
import { writeMockAgentConfig, writeProfileSettings } from "./support/omp-agent.ts";
import { STATE_ENV, type RunState } from "./support/state.ts";
import { resolveVsix } from "./support/vsix.ts";

const RESULTS_DIR = join(REPO_ROOT, "out", "e2e-results");
const KEPT_FILE = join(RESULTS_DIR, "kept-env.json");
const NAME_PREFIX = "e2e-run-";

async function sweepStaleEnvironments(root: string, keep: string | undefined): Promise<void> {
	if (!existsSync(root)) return;
	for (const entry of readdirSync(root)) {
		if (!entry.startsWith(NAME_PREFIX) || entry === keep) continue;
		await stopVsCode(entry, root);
		await rm(join(root, entry), { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
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

async function alive(port: number): Promise<boolean> {
	try {
		await waitForCdp(port, 3_000);
		return true;
	} catch {
		return false;
	}
}

export default async function globalSetup(): Promise<() => Promise<void>> {
	await mkdir(RESULTS_DIR, { recursive: true });
	const root = join(process.env.LOCALAPPDATA ?? "", "omp-desk-test");
	const fingerprint: Fingerprint = await fingerprintUserState();
	const fileWatch = watchGuardedFiles();
	const watchdogStop = join(RESULTS_DIR, "watchdog.stop");
	await rm(watchdogStop, { force: true });
	const watchdog = startWatchdog("omp-desk-test", join(RESULTS_DIR, "watchdog.json"), watchdogStop);

	const keep = process.env.E2E_KEEP_ENV === "1";
	const kept: RunState | undefined = existsSync(KEPT_FILE) ? JSON.parse(await readFile(KEPT_FILE, "utf8")) : undefined;
	const reuse = kept !== undefined && await alive(kept.cdpPort);
	await sweepStaleEnvironments(root, reuse ? kept.name : undefined);

	let state: RunState;
	let mock: MockServer;
	if (reuse) {
		state = kept;
		mock = await startMockServer(Number(new URL(kept.mockUrl).port));
	} else {
		await rm(KEPT_FILE, { force: true });
		const vsix = await resolveVsix(RESULTS_DIR);
		mock = await startMockServer();
		const name = `${NAME_PREFIX}${Date.now().toString(36)}`;
		const base = join(root, name);
		const folders = await createFixtureFolders(base);
		await writeMockAgentConfig(join(base, "agent"), mock.url);
		await writeProfileSettings(join(base, "data"));
		const cdpPort = await freePort();
		state = { name, root, base, agentDir: join(base, "agent"), dataDir: join(base, "data"), cdpPort, mockUrl: mock.url, ...folders, vsix, resultsDir: RESULTS_DIR };
		await startVsCode({ name, root, folder: folders.folderA, vsix, port: cdpPort });
		await waitForCdp(cdpPort, 180_000);
		if (keep) await writeFile(KEPT_FILE, JSON.stringify(state, null, 2));
	}
	const stateFile = join(RESULTS_DIR, "run-state.json");
	await writeFile(stateFile, JSON.stringify(state, null, 2));
	process.env[STATE_ENV] = stateFile;

	return async () => {
		const problems: string[] = [];
		await mock.close();
		if (!keep) {
			await stopVsCode(state.name, state.root);
			await rm(state.base, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
		}
		const report = await watchdog.stop();
		await writeFile(join(RESULTS_DIR, "watchdog.json"), JSON.stringify(report, null, 2));
		console.log(`[e2e] foreground watchdog: ${report.samples} samples over ${Math.round(report.durationMs / 1000)} s (every ${report.intervalMs} ms), `
			+ `${report.foregroundChanges} foreground changes, ${report.visibleWindowsSeen} visible windows checked, max gap ${report.maxGapMs} ms, ${report.violations.length} violations`);
		if (report.violations.length > 0) problems.push(`a test VS Code window reached the user's desktop: ${report.violations.join("; ")}`);
		const changed = describeChanges(fingerprint, await fingerprintUserState(), fileWatch.events);
		fileWatch.stop();
		if (changed.length > 0) problems.push(`the run changed user state it must never touch:\n  ${changed.join("\n  ")}`);
		if (problems.length > 0) throw new Error(`[e2e] side-effect guard failed: ${problems.join(" | ")}`);
	};
}
