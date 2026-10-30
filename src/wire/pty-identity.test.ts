/**
 * Tests for the kernel identity readings the whole design rests on.
 *
 * Runner: `node --test src/wire/pty-identity.test.ts`
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
import { once } from "node:events";
import { after, before, describe, it } from "node:test";
import {
	isPtyProcessAlive,
	queryPtyProcessIdentity,
	queryPtyProcessTree,
	waitForPtyProcessGone,
} from "./pty-identity.ts";
import { loadWin32Native, setWin32NativeForTest, type ProcessTableEntry, type Win32Native } from "./win32-native.ts";
import { installedAddonAsset } from "../host/win32-test-support.ts";

const children: ChildProcess[] = [];
/** Processes started by an exited parent: they outlive the test unless it ends them. */
const orphans: number[] = [];

after(() => {
	for (const child of children) {
		try {
			child.kill();
		} catch {
			// already gone
		}
	}
	for (const pid of orphans) {
		try {
			process.kill(pid);
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

/** A process that started a long-lived one of its own and exited: the survivor keeps a parent link to the exited process's id. */
async function orphaned(): Promise<{ readonly parent: number; readonly orphan: number }> {
	const script = "const c = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true, windowsHide: true }); c.unref(); process.stdout.write(c.pid + '\\n');";
	const parent = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
	assert.ok(parent.pid !== undefined && parent.stdout !== null);
	const reported = Promise.withResolvers<string>();
	parent.stdout.once("data", chunk => reported.resolve(String(chunk)));
	const orphan = Number.parseInt(await reported.promise, 10);
	assert.ok(orphan > 0);
	orphans.push(orphan);
	if (parent.exitCode === null) await once(parent, "exit");
	return { parent: parent.pid, orphan };
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

		it("keeps a real child of a live process when that process's creation time is given", async () => {
			const own = await queryPtyProcessIdentity(process.pid);
			assert.equal(own.kind, "found");
			const child = holdingChild();
			assert.ok(child.pid !== undefined);
			const reading = await queryPtyProcessTree(process.pid, own.kind === "found" ? own.creationTime : null);
			assert.equal(reading.kind, "found");
			assert.ok(reading.kind === "found" && reading.pids.includes(child.pid as number), "a child is never older than the process that started it");
		});

		it("drops a process older than the root: the table keeps an exited parent's id on the processes it left running", async () => {
			const { parent, orphan } = await orphaned();
			// By id alone the survivor still reads as a descendant of the exited parent, which is what a later process
			// that is given that id would be told.
			const byId = await queryPtyProcessTree(parent);
			assert.ok(byId.kind === "found" && byId.pids.includes(orphan), `expected ${orphan} in ${JSON.stringify(byId)}`);
			// Such a process starts after the survivor, so a root created a second after it cannot have started it.
			const created = await queryPtyProcessIdentity(orphan);
			assert.ok(created.kind === "found", JSON.stringify(created));
			const filtered = await queryPtyProcessTree(parent, String(BigInt(created.creationTime) + 10_000_000n));
			assert.ok(filtered.kind === "found" && !filtered.pids.includes(orphan), `the orphan is older than the root and is no descendant of it: ${JSON.stringify(filtered)}`);
		});
	});
});

/** One row of a fixed process table: its parent, and what a creation-time read of it answers (seconds after an arbitrary base). */
type FixedRow = readonly [pid: number, parentPid: number, created: number | "gone" | "unreadable" | "malformed"];

const FIXED_BASE = 134_000_000_000_000_000n;
const filetime = (seconds: number): string => String(FIXED_BASE + BigInt(seconds) * 10_000_000n);

/** A native module whose process table and creation times are fixed, so a walk is decided by the rows and not by which ids the machine reuses. */
function fixedProcesses(rows: readonly FixedRow[]): Win32Native & { readonly reads: { table: number; descendants: number } } {
	const reads = { table: 0, descendants: 0 };
	const unused = (): never => { throw new Error("not read by a process tree test"); };
	return {
		reads,
		mutexState: unused,
		processCreation: pid => {
			const created = rows.find(row => row[0] === pid)?.[2];
			if (created === undefined || created === "gone") return { kind: "gone" };
			if (created === "unreadable") return { kind: "unknown", detail: "access denied" };
			return { kind: "found", filetime: created === "malformed" ? "not-a-filetime" : filetime(created) };
		},
		processDescendants: () => { reads.descendants += 1; return { kind: "found", pids: [999] }; },
		processTable: () => {
			reads.table += 1;
			return { kind: "found", entries: rows.map((row): ProcessTableEntry => ({ pid: row[0], parentPid: row[1], exe: "fixture.exe" })) };
		},
		processCommandLine: unused,
		openPipeClient: unused,
		volumeOf: unused,
		readSecuritySync: unused,
		readSecurity: unused,
		lookupAccountNames: unused,
		administratorsMembership: unused,
	};
}

describe("with a fixed process table", windowsOnly, () => {
	/** The stopped child, created at 100 s. Its own row names one of its grandchildren as parent, which makes the table cyclic. */
	const rows: readonly FixedRow[] = [
		[100, 301, 100],
		// An old process whose creator had the child's id: older than the child, so not its descendant, and nothing below it is walked.
		[200, 100, 50],
		[201, 200, 120],
		// Genuine descendants, each created after the parent it names.
		[300, 100, 110],
		[301, 300, 130],
		// Created after the child but before the parent it names: the intermediate id was reused, so it is not that parent's.
		[302, 300, 105],
		// Created at the child's own instant: not ruled out.
		[700, 100, 100],
		// A creation time that cannot be read cannot be ruled out; what is below it is held to the nearest time that was read.
		[400, 100, "unreadable"],
		[401, 400, 90],
		[402, 400, 140],
		[600, 100, "malformed"],
		// Gone since the snapshot: no survivor itself, but what names it is still walked, under the bound that was read.
		[500, 100, "gone"],
		[501, 500, 150],
		[502, 500, 90],
	];

	it("keeps the processes the child can have started, and drops the rest with everything below them", async () => {
		const native = fixedProcesses(rows);
		setWin32NativeForTest(native);
		const reading = await queryPtyProcessTree(100, filetime(100));
		assert.equal(reading.kind, "found");
		assert.deepEqual(reading.kind === "found" ? [...reading.pids].sort((a, b) => a - b) : [], [300, 301, 400, 402, 501, 600, 700]);
		assert.deepEqual(native.reads, { table: 1, descendants: 0 }, "one snapshot, and no walk by id alone");
	});

	it("walks by id alone when the child's creation time was never read", async () => {
		const native = fixedProcesses(rows);
		setWin32NativeForTest(native);
		assert.deepEqual(await queryPtyProcessTree(100, null), { kind: "found", pids: [999] });
		assert.deepEqual(await queryPtyProcessTree(100), { kind: "found", pids: [999] });
		assert.deepEqual(native.reads, { table: 0, descendants: 2 });
	});

	it("reads a failed snapshot as unknown, whatever the creation time", async () => {
		const failing = { ...fixedProcesses(rows), processTable: () => ({ kind: "unknown", detail: "snapshot failed" }) as const };
		setWin32NativeForTest(failing);
		assert.deepEqual(await queryPtyProcessTree(100, filetime(100)), { kind: "unknown", detail: "snapshot failed" });
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
