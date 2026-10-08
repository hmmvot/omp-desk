/**
 * Tests for the kernel identity readings the whole design rests on.
 *
 * Runner: `node --test src/host/pty-identity.test.ts`
 *
 * Every claim about "our process" — adopting a surviving broker, proving a stop,
 * deciding that a `node` process in a folder shell's tree is gone — is a creation-time
 * reading of a pid, so what matters is that the reading is real (the same value the
 * host-control helper gives for the same process), that it is tri-state rather than
 * optimistic (`unknown` is never reported as `gone`), that a descendant read answers
 * from the process table, and that a helper whose bytes changed is refused instead of
 * run.
 */

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	isPtyProcessAlive,
	queryPtyProcessIdentity,
	queryPtyProcessTree,
	waitForPtyProcessGone,
	type PtyProbeHelper,
} from "./pty-identity.ts";
import { windowsPowerShellEnvironment, windowsPowerShellExecutable } from "./windows-powershell.ts";

const HELPER = fileURLToPath(new URL("./pty-process-probe.ps1", import.meta.url));

const roots: string[] = [];
const children: ChildProcess[] = [];
let helper: PtyProbeHelper;

before(async () => {
	const bytes = await readFile(HELPER);
	helper = { path: HELPER, sha256: createHash("sha256").update(bytes).digest("hex") };
});

after(async () => {
	for (const child of children) {
		try {
			child.kill();
		} catch {
			// already gone
		}
	}
	for (const root of roots) await rm(root, { recursive: true, force: true });
});

/** A child that stays alive until it is killed. */
function holdingChild(): ChildProcess {
	const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
	children.push(child);
	return child;
}

/** The same reading through the host-control helper, so the two agree by measurement. */
async function controlHelperReading(pid: number): Promise<string> {
	const script = fileURLToPath(new URL("./verified-pipe.ps1", import.meta.url));
	const child = spawn(
		windowsPowerShellExecutable(),
		["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-Mode", "generation", "-TargetPid", String(pid)],
		{ windowsHide: true, stdio: ["ignore", "pipe", "ignore"], env: windowsPowerShellEnvironment() },
	);
	let out = "";
	child.stdout?.on("data", chunk => {
		out += chunk.toString("utf8");
	});
	const exited = Promise.withResolvers<void>();
	child.on("close", () => exited.resolve());
	child.on("error", () => exited.resolve());
	await exited.promise;
	return out.trim().replace(/^!GENERATION /, "");
}

const windowsOnly = { skip: process.platform !== "win32" ? "the identity probe is implemented for Windows only" : false };

describe("creation-time readings", windowsOnly, () => {
	it("reads this process's kernel creation time, and agrees with the host-control helper", async () => {
		const reading = await queryPtyProcessIdentity(helper, process.pid);
		assert.equal(reading.kind, "found");
		const mine = reading.kind === "found" ? reading.creationTime : "";
		assert.match(mine, /^[1-9][0-9]{9,19}$/);
		// The two helpers must agree: a broker's record is written with one and checked
		// with the other when the webview comes back after a reload.
		assert.equal(await controlHelperReading(process.pid), mine);
	});

	it("reports a process that is gone as gone, and an unresolvable one as unknown", async () => {
		const child = holdingChild();
		const pid = child.pid;
		assert.ok(typeof pid === "number");
		const before = await queryPtyProcessIdentity(helper, pid);
		assert.equal(before.kind, "found");
		child.kill();
		const gone = await waitForPtyProcessGone(helper, pid, before.kind === "found" ? before.creationTime : null, 20_000);
		assert.equal(gone.gone, true);
		assert.equal(isPtyProcessAlive(pid), false);

		assert.equal((await queryPtyProcessIdentity(helper, 0)).kind, "unknown");
		const absent = await queryPtyProcessIdentity(helper, 2147483000);
		assert.equal(absent.kind, "gone");
	});

	it("treats a process whose id was reused as the one it waited for having gone", async () => {
		// A deliberately wrong expected creation time is exactly the reading a reused
		// process id produces, and it must not be waited on until the timeout.
		const child = holdingChild();
		const pid = child.pid;
		assert.ok(typeof pid === "number");
		const reading = await queryPtyProcessIdentity(helper, pid);
		assert.equal(reading.kind, "found");
		const mismatched = await waitForPtyProcessGone(helper, pid, "134349421014308869", 20_000);
		assert.equal(mismatched.gone, true);
		assert.match(mismatched.detail, /reused/);
	});
});

describe("descendant readings", windowsOnly, () => {
	it("lists a live child of the process it is asked about", async () => {
		const parent = holdingChild();
		const child = holdingChild();
		// Both are children of this test process; the reading walks the real table.
		assert.ok(parent.pid !== undefined && child.pid !== undefined);
		const reading = await queryPtyProcessTree(helper, process.pid);
		assert.equal(reading.kind, "found");
		const pids = reading.kind === "found" ? reading.pids : [];
		assert.ok(pids.includes(parent.pid as number), `expected ${parent.pid} in ${pids.join(",")}`);
		assert.ok(pids.includes(child.pid as number), `expected ${child.pid} in ${pids.join(",")}`);
	});

	it("answers about a process with no descendants as empty rather than unknown", async () => {
		// A pid nothing can have as a parent: an empty descendant set, not an unreadable
		// one. The stop verdict depends on that difference — `empty` is evidence,
		// `unknown` is not.
		assert.deepEqual(await queryPtyProcessTree(helper, 2147483000), { kind: "found", pids: [] });

		// A live process whose descendants are known to end: a console-hosting process has
		// its console host below it, and that host has nothing below it in turn.
		const child = holdingChild();
		assert.ok(child.pid !== undefined);
		const reading = await queryPtyProcessTree(helper, child.pid);
		assert.equal(reading.kind, "found");
		const leaf = reading.kind === "found" ? reading.pids[0] : undefined;
		if (leaf !== undefined) {
			assert.deepEqual(await queryPtyProcessTree(helper, leaf), { kind: "found", pids: [] });
		}
	});
});

describe("helper integrity", windowsOnly, () => {
	it("refuses to run a helper whose bytes no longer match its digest", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "omp-pty-probe-"));
		roots.push(root);
		const copy = path.join(root, "helper.ps1");
		await writeFile(copy, "# replaced\n", "utf8");
		const tampered: PtyProbeHelper = { path: copy, sha256: "f".repeat(64) };
		const reading = await queryPtyProcessIdentity(tampered, process.pid);
		assert.equal(reading.kind, "unknown");
		assert.match(reading.detail, /could not be started/);
		assert.equal((await queryPtyProcessTree(tampered, process.pid)).kind, "unknown");
	});
});
