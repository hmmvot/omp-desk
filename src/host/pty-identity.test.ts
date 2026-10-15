/**
 * Tests for the kernel identity readings the whole design rests on.
 *
 * Runner: `node --test src/host/pty-identity.test.ts`
 *
 * Every claim about "our process" — adopting a surviving broker, proving a stop,
 * deciding that a `node` process in a folder shell's tree is gone — is a creation-time
 * reading of a pid, so what matters is that the reading is real (it matches the time this
 * process started), that it is tri-state rather than optimistic (`unknown` is never
 * reported as `gone`), that a descendant read answers from the process table, and that a
 * process without a loaded native module reads as `unknown` rather than as anything else.
 */

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { after, before, describe, it } from "node:test";
import {
	isPtyProcessAlive,
	queryPtyProcessIdentity,
	queryPtyProcessTree,
	waitForPtyProcessGone,
} from "./pty-identity.ts";
import { loadWin32Native, setWin32NativeForTest } from "./win32-native.ts";
import { installedAddonAsset } from "./win32-test-support.ts";

const children: ChildProcess[] = [];

after(() => {
	for (const child of children) {
		try {
			child.kill();
		} catch {
			// already gone
		}
	}
	setWin32NativeForTest(undefined);
});

/** A child that stays alive until it is killed. */
function holdingChild(): ChildProcess {
	const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
	children.push(child);
	return child;
}

/** Milliseconds between the FILETIME epoch (1601) and the Unix epoch. */
const FILETIME_EPOCH_OFFSET_MS = 11_644_473_600_000;

const windowsOnly = { skip: process.platform !== "win32" ? "the identity reading is implemented for Windows only" : false };

describe("with the real native module", windowsOnly, () => {
	before(async () => {
		setWin32NativeForTest(await loadWin32Native(await installedAddonAsset()));
	});

	describe("creation-time readings", () => {
		it("reads this process's kernel creation time", async () => {
			const reading = await queryPtyProcessIdentity(process.pid);
			assert.equal(reading.kind, "found");
			const mine = reading.kind === "found" ? reading.creationTime : "";
			assert.match(mine, /^[1-9][0-9]{9,19}$/);
			// An independent clock: the start time the kernel recorded is this process's uptime ago.
			const startedAt = Number(BigInt(mine) / 10_000n) - FILETIME_EPOCH_OFFSET_MS;
			assert.ok(Math.abs(Date.now() - process.uptime() * 1000 - startedAt) < 10_000, `creation time ${mine} does not match this process's uptime`);
		});

		it("reports a process that is gone as gone, and an unresolvable one as unknown", async () => {
			const child = holdingChild();
			const pid = child.pid;
			assert.ok(typeof pid === "number");
			const before = await queryPtyProcessIdentity(pid);
			assert.equal(before.kind, "found");
			child.kill();
			const gone = await waitForPtyProcessGone(pid, before.kind === "found" ? before.creationTime : null, 20_000);
			assert.equal(gone.gone, true);
			assert.equal(isPtyProcessAlive(pid), false);

			assert.equal((await queryPtyProcessIdentity(0)).kind, "unknown");
			const absent = await queryPtyProcessIdentity(2147483000);
			assert.equal(absent.kind, "gone");
		});

		it("treats a process whose id was reused as the one it waited for having gone", async () => {
			// A deliberately wrong expected creation time is exactly the reading a reused
			// process id produces, and it must not be waited on until the timeout.
			const child = holdingChild();
			const pid = child.pid;
			assert.ok(typeof pid === "number");
			const reading = await queryPtyProcessIdentity(pid);
			assert.equal(reading.kind, "found");
			const mismatched = await waitForPtyProcessGone(pid, "134349421014308869", 20_000);
			assert.equal(mismatched.gone, true);
			assert.match(mismatched.detail, /reused/);
		});
	});

	describe("descendant readings", () => {
		it("lists a live child of the process it is asked about", async () => {
			const parent = holdingChild();
			const child = holdingChild();
			// Both are children of this test process; the reading walks the real table.
			assert.ok(parent.pid !== undefined && child.pid !== undefined);
			const reading = await queryPtyProcessTree(process.pid);
			assert.equal(reading.kind, "found");
			const pids = reading.kind === "found" ? reading.pids : [];
			assert.ok(pids.includes(parent.pid as number), `expected ${parent.pid} in ${pids.join(",")}`);
			assert.ok(pids.includes(child.pid as number), `expected ${child.pid} in ${pids.join(",")}`);
		});

		it("answers about a process with no descendants as empty rather than unknown", async () => {
			// A pid nothing can have as a parent: an empty descendant set, not an unreadable
			// one. The stop verdict depends on that difference — `empty` is evidence,
			// `unknown` is not.
			assert.deepEqual(await queryPtyProcessTree(2147483000), { kind: "found", pids: [] });

			// A live process whose descendants are known to end: a console-hosting process has
			// its console host below it, and that host has nothing below it in turn.
			const child = holdingChild();
			assert.ok(child.pid !== undefined);
			const reading = await queryPtyProcessTree(child.pid);
			assert.equal(reading.kind, "found");
			const leaf = reading.kind === "found" ? reading.pids[0] : undefined;
			if (leaf !== undefined) {
				assert.deepEqual(await queryPtyProcessTree(leaf), { kind: "found", pids: [] });
			}
		});
	});
});

describe("without a native module", windowsOnly, () => {
	before(() => {
		setWin32NativeForTest(null);
	});

	it("reads a live process and its descendants as unknown, naming the unavailable module", async () => {
		const identity = await queryPtyProcessIdentity(process.pid);
		assert.equal(identity.kind, "unknown");
		assert.match(identity.kind === "unknown" ? identity.detail : "", /native module is not available/);
		const tree = await queryPtyProcessTree(process.pid);
		assert.equal(tree.kind, "unknown");
		assert.match(tree.kind === "unknown" ? tree.detail : "", /native module is not available/);
	});

	it("still reads an id no process holds as gone, without any native call", async () => {
		assert.throws(() => process.kill(2147483000, 0), (error: NodeJS.ErrnoException) => error.code === "ESRCH");
		assert.deepEqual(await queryPtyProcessIdentity(2147483000), { kind: "gone" });
		assert.deepEqual(await waitForPtyProcessGone(2147483000, "134349421014308869", 5_000), {
			gone: true,
			detail: "no process is running under this id",
		});
	});

	it("never claims a live process gone from an unknown reading", async () => {
		const gone = await waitForPtyProcessGone(process.pid, "134349421014308869", 0);
		assert.equal(gone.gone, false);
		assert.match(gone.detail, /native module is not available/);
	});
});

describe("on a platform without the reading", { skip: process.platform === "win32" ? "this is the Windows host" : false }, () => {
	it("is unknown for identity and tree", async () => {
		assert.equal((await queryPtyProcessIdentity(process.pid)).kind, "unknown");
		assert.equal((await queryPtyProcessTree(process.pid)).kind, "unknown");
	});
});
