/**
 * `scripts/test-vscode.ps1 -Stop` against real processes: a stand-in for an environment (a parent that names the folder, a
 * detached broker that names it, and unnamed children and grandchildren of both, as ConPTY consoles and OMP tools are) is
 * ended completely, and a tree that names only a longer folder name survives.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { environmentProcesses, readProcesses, selfAndAncestors } from "./stale-environments.ts";

const SCRIPT = fileURLToPath(new URL("../../../scripts/test-vscode.ps1", import.meta.url));

const NAME = "e2e-run-stoptest";
const IDLE = "setInterval(() => {}, 1000)";
const SPAWN = "require('node:child_process').spawn(process.execPath, ['-e', %CODE%], { stdio: 'ignore' });";
/** Runs forever and starts a child that runs forever and starts a grandchild that runs forever; none of the three but the first has the folder in its command line. */
const TREE = `${SPAWN.replace("%CODE%", JSON.stringify(`${SPAWN.replace("%CODE%", JSON.stringify(IDLE))} ${IDLE}`))} ${IDLE}`;

let root: string;
let base: string;
const started: ChildProcess[] = [];

/** A node process that carries `marker` as an argument and starts the tree of three. */
function startTree(marker: string, options: { detached?: boolean } = {}): void {
	const child = spawn(process.execPath, ["-e", TREE, marker], { stdio: "ignore", windowsHide: true, detached: options.detached });
	child.unref();
	started.push(child);
}

/** Polls the real process list (each reading takes seconds, which is the pause between looks) until `count` processes belong to the environment. */
async function waitForMembers(folder: string, count: number): Promise<number[]> {
	for (let attempt = 0; attempt < 15; attempt++) {
		const processes = await readProcesses();
		assert.ok(processes, "the process list could not be read");
		const members = environmentProcesses(folder, processes, selfAndAncestors(processes, process.pid));
		if (members.length >= count) return members.map(member => member.pid);
	}
	throw new Error(`fewer than ${count} processes of ${folder} started`);
}

function stop(): { status: number | null; output: string } {
	const run = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", SCRIPT, "-Name", NAME, "-Root", root, "-Stop"], { encoding: "utf8", windowsHide: true, timeout: 120_000 });
	return { status: run.status, output: `${run.stdout}${run.stderr}` };
}

describe("test-vscode.ps1 -Stop", { skip: process.platform !== "win32" }, () => {
	before(() => {
		// Windows PowerShell 5.1 (.NET Framework) expands an 8.3 short name in `-Root` (a runner's `RUNNER~1`) while the processes
		// carry it as given, so the stand-in is placed under the long form, as the real environments are.
		root = realpathSync.native(mkdtempSync(join(tmpdir(), "omp-stop-")));
		base = join(root, NAME);
	});

	after(() => {
		for (const child of started) {
			if (child.pid !== undefined) spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
		}
		rmSync(root, { recursive: true, force: true });
	});

	it("ends every process of the environment with its unnamed descendants, leaves a longer folder name alone, and says so when nothing runs", { timeout: 240_000 }, async () => {
		startTree(join(base, "data"));
		startTree(join(base, "data", "broker.js"), { detached: true });
		startTree(`${base}-other\\data`);
		const members = await waitForMembers(base, 6);
		// Two trees of three, plus the console host Windows may give each tree's first process.
		assert.ok(members.length >= 6, `${members.length} members`);
		const others = await waitForMembers(`${base}-other`, 3);

		const first = stop();
		assert.equal(first.status, 0, first.output);
		assert.match(first.output, /Stopped VS Code for 'e2e-run-stoptest' \(\d+ processes\)/);

		const left = await readProcesses();
		assert.ok(left);
		const alive = new Set(left.map(item => item.pid));
		assert.deepEqual(members.filter(pid => alive.has(pid)), [], "a process of the environment still runs");
		assert.deepEqual(others.filter(pid => !alive.has(pid)), [], "the tree of the longer name was left alone");

		const second = stop();
		assert.equal(second.status, 0, second.output);
		assert.match(second.output, /is not running/);
	});
});
