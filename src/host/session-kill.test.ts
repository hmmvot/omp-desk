/**
 * Tests for Kill (ADR-0060, amended): what is killed, the one identity check that stays, the
 * reconciliation after it, and a real tree kill.
 *
 * Runner: `node --test src/host/session-kill.test.ts`
 */

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { after, before, describe, it } from "node:test";
import type { LogLevel } from "../shared/logger.ts";
import type { BrokerProcessRow } from "./broker-processes.ts";
import { isPtyProcessAlive, queryPtyProcessIdentity, waitForPtyProcessGone } from "../wire/pty-identity.ts";
import type { PtyIdentityReading } from "../wire/pty-identity.ts";
import { loadWin32Native, setWin32NativeForTest } from "../wire/win32-native.ts";
import { installedAddonAsset } from "./win32-test-support.ts";
import {
	killProcessTree,
	killSelection,
	planSessionKill,
	runTaskkillTree,
	targetOfRecorded,
	targetOfRow,
} from "./session-kill.ts";
import type { KillCommandPorts, KillTarget, RecordedProcess, TreeKillPorts, TreeKillRun } from "./session-kill.ts";

const BROKER_CREATED = "134349421010000001";
const CHILD_CREATED = "134349421010000002";
const ATTEMPT = "2026-10-12T09:59:59.000Z";
const CAPTURED = { slot: "tab:one", brokerId: "pty-one", brokerGeneration: "g1", attemptStartedAt: ATTEMPT, hostPid: 4100 };

const recorded = (overrides: Partial<RecordedProcess> = {}): RecordedProcess => ({
	slot: "tab:one",
	brokerId: "pty-one",
	brokerGeneration: "g1",
	brokerPid: 4100,
	brokerCreationTime: BROKER_CREATED,
	childPid: 4200,
	childCreationTime: CHILD_CREATED,
	attemptStartedAt: ATTEMPT,
	hostPid: 4100,
	...overrides,
});

function row(overrides: Partial<BrokerProcessRow> = {}): BrokerProcessRow {
	return {
		id: "current|tab:one|pty-one",
		source: "current",
		kind: "session",
		ptyKind: "managed-rpc",
		slot: "tab:one",
		brokerId: "pty-one",
		generation: "g1",
		brokerPid: 4100,
		brokerCreationTime: BROKER_CREATED,
		startedAt: "2026-10-12T10:00:00.000Z",
		uptimeMs: 1000,
		title: null,
		status: "in-use",
		host: { kind: "session", tabId: "tab-1", title: "Fix the build", folder: "C:/work/app", window: "this-window", drivenHere: true, recorded: true },
		window: "this-window",
		drivenHere: true,
		child: "running",
		olderBuild: false,
		stop: { available: true },
		...overrides,
	};
}

/** A process table: pid -> creation time. Killing a root removes it, and every listed descendant with it. */
function fakeKernel(initial: Record<number, string>, tree: Record<number, readonly number[]> = {}) {
	const alive = new Map<number, string>(Object.entries(initial).map(([pid, created]) => [Number(pid), created]));
	const calls: string[] = [];
	const ports: TreeKillPorts & { run?: TreeKillRun; stillAlive?: boolean } = {
		isAlive: pid => alive.has(pid),
		pause: async () => {},
		async readIdentity(pid): Promise<PtyIdentityReading> {
			calls.push(`read ${pid}`);
			const created = alive.get(pid);
			return created === undefined ? { kind: "gone" } : { kind: "found", creationTime: created };
		},
		async killTree(pid) {
			calls.push(`kill ${pid}`);
			if (ports.stillAlive !== true) {
				alive.delete(pid);
				for (const descendant of tree[pid] ?? []) alive.delete(descendant);
			}
			return ports.run ?? { started: true, exitCode: 0, output: "", timedOut: false };
		},
		async waitGone(pid, creationTime) {
			calls.push(`wait ${pid}`);
			const created = alive.get(pid);
			return created === undefined || created !== creationTime ? { gone: true, detail: "gone" } : { gone: false, detail: "alive" };
		},
	};
	return { ports, calls, alive };
}

const target = (overrides: Partial<KillTarget> = {}): KillTarget => ({
	label: 'the OMP session "Fix the build"',
	slot: "tab:one",
	roots: [
		{ pid: 4100, creationTime: BROKER_CREATED, role: "broker" },
		{ pid: 4200, creationTime: CHILD_CREATED, role: "child" },
	],
	reconcile: { kind: "session", tabId: "tab-1", captured: CAPTURED },
	...overrides,
});

describe("what Kill ends", () => {
	it("ends the broker's tree and finds the recorded OMP child already gone with it", async () => {
		const kernel = fakeKernel({ 4100: BROKER_CREATED, 4200: CHILD_CREATED }, { 4100: [4200] });
		const outcome = await killProcessTree(target(), kernel.ports);
		assert.equal(outcome.kind, "killed");
		assert.deepEqual(kernel.calls, ["read 4100", "kill 4100"], "the child's id is gone with the tree: no probe, and no kill of its own");
		assert.deepEqual(outcome.results.map(result => result.kind), ["killed", "gone"]);
	});

	it("still ends an OMP child that outlived its broker, by the child's own recorded identity", async () => {
		const kernel = fakeKernel({ 4100: BROKER_CREATED, 4200: CHILD_CREATED });
		const outcome = await killProcessTree(target(), kernel.ports);
		assert.equal(outcome.kind, "killed");
		assert.deepEqual(kernel.calls, ["read 4100", "kill 4100", "read 4200", "kill 4200"]);
		assert.equal(kernel.alive.size, 0);
	});

	it("takes the broker of a process row, and the recorded child only under that exact broker", () => {
		const own = targetOfRow(row(), recorded());
		assert.deepEqual(own.roots.map(root => [root.pid, root.role]), [[4100, "broker"], [4200, "child"]]);
		const otherBroker = targetOfRow(row(), recorded({ brokerId: "pty-other" }));
		assert.deepEqual(otherBroker.roots.map(root => root.pid), [4100], "a recorded child of another broker is not this row's");
		const noIdentity = targetOfRow(row({ brokerCreationTime: "" }));
		assert.deepEqual(noIdentity.roots, [], "a broker with no recorded creation time cannot be told from a stranger");
	});

	it("plans a session's kill from its recorded host first, then from the rows that host it, and names nothing otherwise", () => {
		assert.deepEqual(planSessionKill("tab-1", "Fix", recorded(), [row()]).map(next => next.roots.map(root => root.pid)), [[4100, 4200]]);
		const fromRows = planSessionKill("tab-1", "Fix", null, [row(), row({ id: "other", host: { kind: "terminal", folder: "C:/x", label: "x", window: "none" } })]);
		assert.equal(fromRows.length, 1, "only the broker row that hosts the conversation");
		assert.deepEqual(fromRows[0]?.reconcile, { kind: "none" }, "rows alone name no recorded OMP child");
		assert.deepEqual(planSessionKill("tab-1", "Fix", null, []), []);
		const childOnly = planSessionKill("tab-1", "Fix", recorded({ brokerCreationTime: null }), []);
		assert.deepEqual(childOnly[0]?.roots.map(root => root.pid), [4200], "a host that recorded no broker identity still names its child");
	});

	it("reconciles a killed row like a broker-route stop retires one: terminals and unrecorded mappings forget the slot, a recorded session goes through the index only with its captured child", () => {
		assert.deepEqual(targetOfRow(row({ kind: "terminal", ptyKind: "folder-shell", host: { kind: "terminal", folder: "C:/x", label: "x", window: "none" } })).reconcile, { kind: "slot", slot: "tab:one" });
		assert.deepEqual(targetOfRow(row(), recorded()).reconcile, { kind: "session", tabId: "tab-1", captured: CAPTURED });
		assert.deepEqual(targetOfRow(row()).reconcile, { kind: "none" }, "a broker's absence alone is no evidence about the writer");
		assert.deepEqual(targetOfRow(row(), recorded({ childCreationTime: null })).reconcile, { kind: "none" }, "a child with no recorded creation time cannot be proven gone");
		assert.deepEqual(targetOfRow(row(), recorded({ attemptStartedAt: null })).reconcile, { kind: "none" });
		assert.deepEqual(targetOfRow(row({ host: null, status: "orphaned" })).reconcile, { kind: "slot", slot: "tab:one" });
		assert.deepEqual(targetOfRow(row({ kind: "stats", ptyKind: "stats-dashboard", host: { kind: "stats", window: "none" } })).reconcile, { kind: "none" });
		assert.deepEqual(targetOfRecorded("tab-1", "Fix", recorded()).reconcile, { kind: "session", tabId: "tab-1", captured: CAPTURED });
	});
});

describe("the identity check that stays", () => {
	it("kills nothing when the id now belongs to another process", async () => {
		const kernel = fakeKernel({ 4100: "134349421019999999", 4200: "134349421018888888" });
		const outcome = await killProcessTree(target(), kernel.ports);
		assert.equal(outcome.kind, "gone");
		assert.ok(!kernel.calls.some(call => call.startsWith("kill")), "a stranger is never killed");
		assert.equal(kernel.alive.size, 2);
		assert.match(outcome.message, /already gone; nothing was killed/);
	});

	it("kills nothing when no process has the id", async () => {
		const kernel = fakeKernel({});
		const outcome = await killProcessTree(target(), kernel.ports);
		assert.equal(outcome.kind, "gone");
		assert.deepEqual(kernel.calls, [], "an id nobody has needs no probe");
	});

	it("kills nothing when the identity cannot be read, and says so", async () => {
		const ports: TreeKillPorts = {
			isAlive: () => true,
			pause: async () => {},
			readIdentity: async () => ({ kind: "unknown", detail: "the process probe is not available in this window" }),
			killTree: async () => assert.fail("no kill on a guess"),
			waitGone: async () => assert.fail("nothing was killed"),
		};
		const outcome = await killProcessTree(target(), ports);
		assert.equal(outcome.kind, "failed");
		assert.match(outcome.message, /could not be verified/);
	});

	it("does not look at OMP's state: a busy, held or claimed session has no bearing on the plan", () => {
		// The plan takes a recorded host and rows; nothing about busy/settled/ownership/claims exists in its inputs.
		const busyOtherWindow = row({ window: "other-window", child: "running", host: { kind: "session", tabId: "tab-1", title: "Fix", folder: "C:/x", window: "other-window", drivenHere: false, recorded: true } });
		assert.equal(planSessionKill("tab-1", "Fix", null, [busyOtherWindow]).length, 1);
	});
});

describe("failures", () => {
	it("reports a kill whose root is still running afterwards, and a taskkill that could not start", async () => {
		const stuck = fakeKernel({ 4100: BROKER_CREATED, 4200: CHILD_CREATED });
		stuck.ports.stillAlive = true;
		stuck.ports.run = { started: true, exitCode: 1, output: "ERROR: Access is denied.", timedOut: false };
		const refused = await killProcessTree(target(), stuck.ports);
		assert.equal(refused.kind, "failed");
		assert.match(refused.message, /could not be confirmed gone/);
		assert.match(refused.message, /access denied/i);
		assert.doesNotMatch(refused.message, /ERROR: Access is denied/, "process output goes to the log, not into a message");

		const notStarted = fakeKernel({ 4100: BROKER_CREATED });
		notStarted.ports.run = { started: false, exitCode: null, output: "", timedOut: false };
		assert.equal((await killProcessTree(target(), notStarted.ports)).kind, "failed");
	});

	it("says a tree could not be fully ended when taskkill failed on something but the root is gone", async () => {
		const kernel = fakeKernel({ 4100: BROKER_CREATED, 4200: CHILD_CREATED }, { 4100: [4200] });
		kernel.ports.run = { started: true, exitCode: 1, output: "ERROR: protected", timedOut: false };
		const outcome = await killProcessTree(target(), kernel.ports);
		assert.equal(outcome.kind, "killed");
		assert.equal(outcome.incomplete, true);
		assert.match(outcome.message, /could not end every process/);
		assert.match(outcome.detail, /ERROR: protected/);
	});

	it("does not claim a process is running when the probe could not decide", async () => {
		const kernel = fakeKernel({ 4100: BROKER_CREATED });
		kernel.ports.stillAlive = true;
		kernel.ports.waitGone = async () => ({ gone: false, detail: "the probe failed" });
		const outcome = await killProcessTree(target({ roots: [{ pid: 4100, creationTime: BROKER_CREATED, role: "broker" }] }), kernel.ports);
		assert.equal(outcome.kind, "failed");
		assert.match(outcome.message, /could not be confirmed gone/);
		assert.match(outcome.message, /the probe failed/);
		assert.doesNotMatch(outcome.message, /still running/);
	});
});

function commandPorts(kernel: ReturnType<typeof fakeKernel>, overrides: Partial<KillCommandPorts> = {}) {
	const events: string[] = [];
	const logAt = (level: LogLevel) => (message: string): void => void events.push(`log ${level} ${message}`);
	const ports: KillCommandPorts = {
		...kernel.ports,
		readRows: async () => {
			events.push("readRows");
			return [];
		},
		recordedProcess: () => recorded(),
		forgetStoppedSlot: async slot => void events.push(`forget ${slot}`),
		recordStopIntent: async tabId => { events.push(`intend ${tabId}`); return async () => void events.push(`withdraw ${tabId}`); },
		reconcileSession: async tabId => void events.push(`reconcile ${tabId}`),
		refresh: async () => void events.push("refresh"),
		info: message => void events.push(`info ${message}`),
		warn: message => void events.push(`warn ${message}`),
		log: { error: logAt("error"), warn: logAt("warn"), info: logAt("info"), debug: logAt("debug"), trace: logAt("trace") },
		requester: "the test",
		...overrides,
	};
	return { ports, events };
}

describe("the Kill command", () => {
	it("kills, then reconciles the row, then refreshes, and logs who asked and what was killed", async () => {
		const kernel = fakeKernel({ 4100: BROKER_CREATED, 4200: CHILD_CREATED }, { 4100: [4200] });
		const { ports, events } = commandPorts(kernel);
		await killSelection({ kind: "session", tabId: "tab-1", title: "Fix the build" }, ports);
		assert.deepEqual(events.filter(event => !event.startsWith("log")), ["intend tab-1", "reconcile tab-1", "refresh"]);
		const log = events.find(event => event.startsWith("log"));
		assert.match(log ?? "", /^log info .*requested by the test/);
		assert.match(log ?? "", /broker pid 4100: tree kill issued, root gone/);
		assert.ok(!events.includes("readRows"), "a recorded host needs no read of the live rows");
	});

	it("reads the live rows only for a session that recorded no host", async () => {
		const kernel = fakeKernel({ 4100: BROKER_CREATED }, {});
		const { ports, events } = commandPorts(kernel, { recordedProcess: () => null, readRows: async () => [row({ kind: "terminal", ptyKind: "folder-shell", host: { kind: "terminal", folder: "C:/x", label: "x", window: "none" } }), row()] });
		await killSelection({ kind: "session", tabId: "tab-1", title: "Fix the build" }, ports);
		assert.equal(kernel.alive.size, 0);
		assert.ok(!events.some(event => event.startsWith("reconcile")), "rows name no recorded OMP child, so no writer proof exists");
	});

	it("forgets the slot of a killed terminal row, and records nothing for a stranger's id", async () => {
		const terminal = row({ kind: "terminal", ptyKind: "folder-shell", host: { kind: "terminal", folder: "C:/x", label: "x", window: "none" } });
		const killed = commandPorts(fakeKernel({ 4100: BROKER_CREATED }));
		await killSelection({ kind: "process", row: terminal }, killed.ports);
		assert.ok(killed.events.includes("forget tab:one"));

		const stranger = commandPorts(fakeKernel({ 4100: "134349421019999999" }));
		await killSelection({ kind: "process", row: terminal }, stranger.ports);
		assert.ok(stranger.events.some(event => event.startsWith("info ") && /already gone/.test(event)), "the user is told it is already gone");
		assert.ok(stranger.events.includes("forget tab:one"), "a recorded process proven not running leaves a stale record: it is reconciled");
	});

	it("does not touch the records when the kill failed, tells the user, and still refreshes", async () => {
		const kernel = fakeKernel({ 4100: BROKER_CREATED });
		kernel.ports.stillAlive = true;
		kernel.ports.run = { started: true, exitCode: 5, output: "Access is denied", timedOut: false };
		const { ports, events } = commandPorts(kernel);
		await killSelection({ kind: "session", tabId: "tab-1", title: "Fix the build" }, ports);
		assert.ok(events.some(event => event.startsWith("warn ") && /could not be killed/.test(event)));
		assert.ok(!events.some(event => event.startsWith("reconcile") || event.startsWith("forget")));
		assert.ok(events.includes("refresh"));
		assert.ok(events.some(event => event.startsWith("log error ") && /FAILED/.test(event)), "every kill is logged, failures included");
	});

	it("says there is nothing to kill for a session with no process, and for a row with no recorded identity", async () => {
		const none = commandPorts(fakeKernel({}), { recordedProcess: () => null });
		await killSelection({ kind: "session", tabId: "tab-1", title: "x" }, none.ports);
		assert.ok(none.events.some(event => event.startsWith("info This row has no process")));
		assert.deepEqual(none.events.filter(event => event.startsWith("reconcile") || event.startsWith("forget")), []);

		const unidentified = commandPorts(fakeKernel({ 4100: BROKER_CREATED }), { recordedProcess: () => null });
		await killSelection({ kind: "process", row: row({ brokerCreationTime: "" }) }, unidentified.ports);
		assert.ok(unidentified.events.some(event => event.startsWith("warn ") && /recorded no process identity/.test(event)));
	});

	it("kills an unmanaged broker only after its identity is proven again, and touches none of Desk's records", async () => {
		const unmanaged = row({ source: "unmanaged", status: "unmanaged", slot: "tab:lost", title: "Lost session", host: null, stop: { available: false, reason: "no record" } });
		const proven = commandPorts(fakeKernel({ 4100: BROKER_CREATED }), { verifyUnmanaged: async () => true });
		await killSelection({ kind: "process", row: unmanaged }, proven.ports);
		assert.equal(proven.events.some(event => event.startsWith("log info ") && /the unmanaged OMP process "Lost session" \(slot tab:lost\): killed/.test(event)), true);
		assert.deepEqual(proven.events.filter(event => event.startsWith("reconcile") || event.startsWith("forget") || event.startsWith("intend")), []);

		const kernel = fakeKernel({ 4100: BROKER_CREATED });
		const refused = commandPorts(kernel, { verifyUnmanaged: async () => false });
		await killSelection({ kind: "process", row: unmanaged }, refused.ports);
		assert.equal(kernel.alive.size, 1, "a process that is not the described broker is never killed");
		assert.ok(refused.events.some(event => event.startsWith("warn ") && /no longer the one this row described/.test(event)));
		assert.ok(refused.events.some(event => event.startsWith("log warn ") && /nothing was killed/.test(event)));
	});

	it("survives a records update that throws: the kill stands, the user and the log are told", async () => {
		const kernel = fakeKernel({ 4100: BROKER_CREATED });
		const { ports, events } = commandPorts(kernel, { reconcileSession: async () => { throw new Error("catalog locked"); } });
		await killSelection({ kind: "session", tabId: "tab-1", title: "Fix the build" }, ports);
		assert.ok(events.some(event => event.startsWith("log error ") && /records could not be updated \(catalog locked\)/.test(event)));
		assert.ok(events.some(event => event.startsWith("warn ") && /could not update its own records/.test(event)), "a failed reconciliation is not silent");
		assert.ok(events.includes("refresh"));
	});

	it("passes the exact captured incarnation to the reconciliation", async () => {
		const kernel = fakeKernel({ 4100: BROKER_CREATED, 4200: CHILD_CREATED }, { 4100: [4200] });
		const seen: unknown[] = [];
		const { ports } = commandPorts(kernel, { reconcileSession: async (_tabId, captured) => void seen.push(captured) });
		await killSelection({ kind: "session", tabId: "tab-1", title: "Fix the build" }, ports);
		assert.deepEqual(seen, [{ slot: "tab:one", brokerId: "pty-one", brokerGeneration: "g1", attemptStartedAt: ATTEMPT, hostPid: 4100 }]);
	});

	it("records the stopped intent before it kills, so the driving window's exit handler cannot read a Kill as a crash", async () => {
		const kernel = fakeKernel({ 4100: BROKER_CREATED, 4200: CHILD_CREATED }, { 4100: [4200] });
		const events: string[] = [];
		const { ports } = commandPorts(kernel, {
			recordStopIntent: async tabId => { events.push(`intend ${tabId}`); return async () => void events.push("withdraw"); },
			killTree: async pid => { events.push(`kill ${pid}`); return await kernel.ports.killTree(pid); },
			reconcileSession: async tabId => void events.push(`reconcile ${tabId}`),
		});
		await killSelection({ kind: "session", tabId: "tab-1", title: "Fix the build" }, ports);
		assert.equal(events[0], "intend tab-1", "the intent comes before the first kill");
		assert.ok(events.includes("kill 4100"), "the broker tree was killed");
		assert.equal(events.at(-1), "reconcile tab-1", "and the records follow the kill");
		assert.ok(!events.includes("withdraw"), "a kill that worked keeps the intent");
	});

	it("puts the earlier intent back when the kill failed, and kills nothing when the intent could not be recorded", async () => {
		const failing = fakeKernel({ 4100: BROKER_CREATED });
		failing.ports.stillAlive = true;
		failing.ports.run = { started: true, exitCode: 5, output: "Access is denied", timedOut: false };
		const withdrawn: string[] = [];
		const stuck = commandPorts(failing, { recordStopIntent: async () => async () => void withdrawn.push("back") });
		await killSelection({ kind: "session", tabId: "tab-1", title: "Fix the build" }, stuck.ports);
		assert.deepEqual(withdrawn, ["back"], "a process that is still running is not left recorded as stopped by a Kill");

		const kernel = fakeKernel({ 4100: BROKER_CREATED, 4200: CHILD_CREATED }, { 4100: [4200] });
		let killed = 0;
		const refused = commandPorts(kernel, {
			recordStopIntent: async () => { throw new Error("catalog locked"); },
			killTree: async pid => { killed++; return await kernel.ports.killTree(pid); },
		});
		await killSelection({ kind: "session", tabId: "tab-1", title: "Fix the build" }, refused.ports);
		assert.equal(killed, 0, "an intent that cannot be recorded stops the kill, as for Stop");
		assert.ok(refused.events.some(event => event.startsWith("warn ") && /was not killed/.test(event)));
		assert.ok(!refused.events.some(event => event.startsWith("reconcile")));
	});

	it("retires no session record on a broker's absence alone: a process row that cannot name the OMP child records nothing", async () => {
		const kernel = fakeKernel({ 4100: BROKER_CREATED });
		const { ports, events } = commandPorts(kernel, { recordedProcess: () => null });
		await killSelection({ kind: "process", row: row() }, ports);
		assert.equal(kernel.alive.size, 0, "the broker is still killed");
		assert.ok(!events.some(event => event.startsWith("reconcile") || event.startsWith("forget")));

		const survivor = fakeKernel({ 4100: BROKER_CREATED, 4200: CHILD_CREATED });
		const second = commandPorts(survivor, { recordedProcess: () => recorded() });
		survivor.ports.stillAlive = true;
		await killSelection({ kind: "process", row: row() }, second.ports);
		assert.ok(!second.events.some(event => event.startsWith("reconcile")), "a child that is still running keeps its records");
	});

	it("shows the warning of an incomplete kill and still reconciles the proven roots", async () => {
		const kernel = fakeKernel({ 4100: BROKER_CREATED, 4200: CHILD_CREATED }, { 4100: [4200] });
		kernel.ports.run = { started: true, exitCode: 1, output: "ERROR: the process 4300 could not be terminated.", timedOut: false };
		const { ports, events } = commandPorts(kernel);
		await killSelection({ kind: "session", tabId: "tab-1", title: "Fix the build" }, ports);
		assert.ok(events.some(event => event.startsWith("warn ") && /could not end every process/.test(event)));
		assert.ok(events.includes("reconcile tab-1"));
		assert.ok(events.some(event => event.startsWith("log warn ") && /incomplete: taskkill exited with 1; taskkill said: ERROR: the process 4300/.test(event)), "the log keeps taskkill's own words");
	});
});

const windowsOnly = { skip: process.platform !== "win32" ? "tree kill is implemented for Windows only" : false };
const spawned: ChildProcess[] = [];

before(async () => {
	if (process.platform === "win32") setWin32NativeForTest(await loadWin32Native(await installedAddonAsset()));
});

after(() => {
	for (const child of spawned) {
		try {
			child.kill();
		} catch {
			// already gone
		}
	}
});

/** A process that starts a grandchild, prints the grandchild's id, and holds. */
async function treeWithGrandchild(): Promise<{ parent: ChildProcess; grandchildPid: number }> {
	const script = [
		"const { spawn } = require('node:child_process');",
		"const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });",
		"console.log(grandchild.pid);",
		"setInterval(() => {}, 1000);",
	].join("");
	const parent = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
	spawned.push(parent);
	const { promise, resolve } = Promise.withResolvers<number>();
	parent.stdout?.once("data", chunk => resolve(Number(String(chunk).trim())));
	return { parent, grandchildPid: await promise };
}

describe("a real tree kill", windowsOnly, () => {
	const ports: TreeKillPorts = {
		isAlive: isPtyProcessAlive,
		// Integration against real processes: the pause is the platform's own wait for a terminated process to disappear.
		pause: ms => delay(ms),
		readIdentity: queryPtyProcessIdentity,
		killTree: pid => runTaskkillTree(pid),
		waitGone: waitForPtyProcessGone,
	};

	it("ends the process and the process it started, and the root is proven gone by its creation time", async () => {
		const { parent, grandchildPid } = await treeWithGrandchild();
		const parentPid = parent.pid as number;
		const identity = await queryPtyProcessIdentity(parentPid);
		assert.equal(identity.kind, "found");
		const creationTime = identity.kind === "found" ? identity.creationTime : "";
		assert.equal(isPtyProcessAlive(grandchildPid), true);

		const outcome = await killProcessTree({ label: "the test tree", slot: null, roots: [{ pid: parentPid, creationTime, role: "broker" }], reconcile: { kind: "none" } }, ports);
		assert.equal(outcome.kind, "killed", outcome.detail);
		assert.equal(isPtyProcessAlive(parentPid), false);
		assert.equal(isPtyProcessAlive(grandchildPid), false, "the process the root started went with it");
	});

	it("leaves a live process alone when the recorded creation time is not its own", async () => {
		const { parent, grandchildPid } = await treeWithGrandchild();
		const parentPid = parent.pid as number;
		const outcome = await killProcessTree({ label: "the test tree", slot: null, roots: [{ pid: parentPid, creationTime: "134349421019999999", role: "broker" }], reconcile: { kind: "none" } }, ports);
		assert.equal(outcome.kind, "gone");
		assert.equal(isPtyProcessAlive(parentPid), true, "a process that is not the recorded one is never killed");
		assert.equal(isPtyProcessAlive(grandchildPid), true);
	});

	it("runs taskkill from System32 and reports a process id that does not exist without throwing", async () => {
		const run = await runTaskkillTree(2147483000);
		assert.equal(run.started, true);
		assert.notEqual(run.exitCode, 0);
		assert.ok(run.output.length > 0 || run.exitCode !== 0, "taskkill answered for a process that does not exist");
	});
});
