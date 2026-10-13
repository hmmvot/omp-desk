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
	PtyIdentityReadings,
	isPtyProcessAlive,
	queryPtyProcessIdentity,
	queryPtyProcessTree,
	waitForPtyProcessGone,
	type PtyIdentityReading,
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

	/** A helper whose bytes match its digest and that answers the one line given, whatever pid it is asked about. */
	async function answeringHelper(answer: string, exitCode: number): Promise<PtyProbeHelper> {
		const root = await mkdtemp(path.join(tmpdir(), "omp-pty-probe-"));
		roots.push(root);
		const script = path.join(root, "helper.ps1");
		const bytes = Buffer.from(`[Console]::Out.Write("${answer}\`n")\nexit ${exitCode}\n`, "utf8");
		await writeFile(script, bytes);
		return { path: script, sha256: createHash("sha256").update(bytes).digest("hex") };
	}

	it("reads a pid the kernel does not know as gone without starting the helper, even when the helper cannot start", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "omp-pty-probe-"));
		roots.push(root);
		const copy = path.join(root, "helper.ps1");
		await writeFile(copy, "# replaced\n", "utf8");
		// A helper that cannot start answers `unknown` for every pid it is asked about, so `gone` can only come from the pre-check.
		const tampered: PtyProbeHelper = { path: copy, sha256: "f".repeat(64) };
		assert.throws(() => process.kill(2147483000, 0), (error: NodeJS.ErrnoException) => error.code === "ESRCH");
		assert.deepEqual(await queryPtyProcessIdentity(tampered, 2147483000), { kind: "gone" });
		assert.deepEqual(await waitForPtyProcessGone(tampered, 2147483000, "134349421014308869", 5_000), {
			gone: true,
			detail: "no process is running under this id",
		});
		// A live pid and a pid this account may not open (EPERM: System, pid 4) still reach the helper, which cannot start here.
		const live = await queryPtyProcessIdentity(tampered, process.pid);
		assert.equal(live.kind, "unknown");
		assert.match(live.detail, /could not be started/);
		assert.throws(() => process.kill(4, 0), (error: NodeJS.ErrnoException) => error.code === "EPERM");
		const unreadable = await queryPtyProcessIdentity(tampered, 4);
		assert.equal(unreadable.kind, "unknown");
		assert.match(unreadable.detail, /could not be started/);
	});

	it("keeps the helper's own answers for a pid that exists: its refusal is still gone, its creation time is still used for an EPERM pid", async () => {
		const refusing = await answeringHelper("!ERROR PROCESS_QUERY_FAILED", 15);
		assert.deepEqual(await queryPtyProcessIdentity(refusing, process.pid), { kind: "gone" });
		const answering = await answeringHelper("!GENERATION 134349421014308869", 0);
		assert.deepEqual(await queryPtyProcessIdentity(answering, 4), { kind: "found", creationTime: "134349421014308869" });
	});

	it("tells a reused id from the recorded process by creation time, as before", async () => {
		const child = holdingChild();
		const pid = child.pid;
		assert.ok(typeof pid === "number");
		const live = await queryPtyProcessIdentity(helper, pid);
		assert.equal(live.kind, "found");
		const creation = live.kind === "found" ? live.creationTime : "";
		const other = holdingChild();
		const reuse = await waitForPtyProcessGone(helper, other.pid as number, creation, 20_000);
		assert.equal(reuse.gone, true);
		assert.match(reuse.detail, /reused/);
		child.kill();
		await new Promise<void>(resolve => child.once("close", () => resolve()));
		assert.deepEqual(await queryPtyProcessIdentity(helper, pid), { kind: "gone" });
	});
});

describe("attachment-proof readings", () => {
	const helperOf = (sha256: string): PtyProbeHelper => ({ path: "unused.ps1", sha256 }) as PtyProbeHelper;

	it("shares one probe among proofs of a pid that are in flight together, and keeps nothing afterwards", async () => {
		const asked: number[] = [];
		const pending: Array<PromiseWithResolvers<PtyIdentityReading>> = [];
		const readings = new PtyIdentityReadings({
			query: (_helper, pid) => {
				asked.push(pid);
				const gate = Promise.withResolvers<PtyIdentityReading>();
				pending.push(gate);
				return gate.promise;
			},
		});
		const helper = helperOf("a");
		const first = readings.read(helper, 10);
		const second = readings.read(helper, 10);
		const other = readings.read(helper, 11);
		assert.deepEqual(asked, [10, 11], "one probe per pid while they are in flight");
		pending[0]!.resolve({ kind: "found", creationTime: "T1" });
		pending[1]!.resolve({ kind: "found", creationTime: "T3" });
		assert.deepEqual(await Promise.all([first, second, other]), [
			{ kind: "found", creationTime: "T1" },
			{ kind: "found", creationTime: "T1" },
			{ kind: "found", creationTime: "T3" },
		]);

		// The pid changed hands after the answer: the next proof must see that, not the earlier process.
		const later = readings.read(helper, 10);
		assert.deepEqual(asked, [10, 11, 10], "an answered probe is not reused");
		pending[2]!.resolve({ kind: "found", creationTime: "T2" });
		assert.deepEqual(await later, { kind: "found", creationTime: "T2" });
	});

	it("does not let a refused probe poison the next proof", async () => {
		let calls = 0;
		const readings = new PtyIdentityReadings({
			query: async () => {
				calls += 1;
				if (calls === 1) throw new Error("the probe could not start");
				return { kind: "found", creationTime: "T" };
			},
		});
		const helper = helperOf("b");
		await assert.rejects(readings.read(helper, 5), /could not start/);
		assert.deepEqual(await readings.read(helper, 5), { kind: "found", creationTime: "T" });
	});
});
