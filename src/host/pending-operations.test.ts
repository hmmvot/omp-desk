import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LaunchTimeline } from "./launch-timeline.ts";
import { PendingOperations, type PendingChange, type PendingTimers } from "./pending-operations.ts";
import { STEP_AFTER_LAP, observeLaunchSteps } from "./pending-steps.ts";
import type { LaunchLap } from "./launch-timeline.ts";

function world() {
	let now = 10_000;
	const timers: { callback: () => void; ms: number; cleared: boolean }[] = [];
	const fake: PendingTimers = {
		set: (callback, ms) => { const timer = { callback, ms, cleared: false }; timers.push(timer); return timer; },
		clear: handle => { const timer = timers.find(candidate => candidate === handle); if (timer !== undefined) timer.cleared = true; },
	};
	const logs: string[] = [];
	const pending = new PendingOperations({ now: () => now, timers: fake, log: line => logs.push(line) });
	const changes: PendingChange[] = [];
	pending.onDidChange(change => changes.push(change));
	return { pending, changes, logs, timers, advance(ms: number) { now += ms; }, fire() { for (const timer of timers) if (!timer.cleared) { timer.cleared = true; timer.callback(); } } };
}

describe("pending operations", () => {
	it("begins synchronously, shows the latest begun operation of a key, and ends with its handle", () => {
		const w = world();
		const handle = w.pending.begin("tab:a", "resume", { origin: "row", requestId: "r1" });
		assert.deepEqual(w.changes, [{ key: "tab:a" }], "the change is reported before begin returns");
		assert.deepEqual(w.pending.get("tab:a"), { key: "tab:a", kind: "resume", step: "waiting", origin: "row", requestId: "r1", startedAt: 10_000, still: false });
		handle.step("ownership");
		assert.equal(w.pending.get("tab:a")?.step, "ownership");
		handle.end("running");
		assert.equal(w.pending.get("tab:a"), undefined);
		assert.deepEqual(w.changes.at(-1), { key: "tab:a", ended: { kind: "resume", requestId: "r1", status: "running" } });
		assert.deepEqual(w.pending.list(), []);
	});

	it("joins an operation of the same family on a key instead of duplicating it, and ends with the last handle", () => {
		const w = world();
		const first = w.pending.begin("tab:a", "open", { origin: "row" });
		w.advance(300);
		const second = w.pending.begin("tab:a", "resume", { origin: "row", requestId: "r2" });
		const shown = w.pending.get("tab:a");
		assert.equal(w.pending.list().length, 1);
		assert.equal(shown?.kind, "resume", "a later Resume upgrades an earlier history Open (the double click)");
		assert.equal(shown?.requestId, "r2");
		assert.equal(shown?.startedAt, 10_000, "the clock is the first click's");
		first.end("running");
		assert.ok(w.pending.get("tab:a"), "one handle left");
		second.end("running");
		assert.equal(w.pending.get("tab:a"), undefined);
		assert.equal(w.changes.filter(change => change.ended !== undefined).length, 1, "one end for one operation");
	});

	it("keeps operations of different families on one key apart and displays the latest", () => {
		const w = world();
		const launch = w.pending.begin("tab:a", "resume");
		const rename = w.pending.begin("tab:a", "rename");
		assert.equal(w.pending.get("tab:a")?.kind, "rename");
		w.pending.step("tab:a", "connect");
		assert.equal(w.pending.get("tab:a")?.step, "waiting", "the keyed step call names the launch family's operation, not the displayed rename");
		rename.end("running");
		assert.equal(w.pending.get("tab:a")?.step, "connect");
		launch.end("failed");
		assert.equal(w.pending.get("tab:a"), undefined);
	});

	it("ends once: a second end, or a step after the end, changes nothing", () => {
		const w = world();
		const handle = w.pending.begin("tab:a", "delete");
		handle.end("refused");
		const count = w.changes.length;
		handle.end("failed");
		handle.step("working");
		assert.equal(w.changes.length, count);
	});

	it("marks an operation still after 60 s: the words change and one line is logged, and nothing is cleared", () => {
		const w = world();
		w.pending.begin("tab:a", "resume");
		w.advance(60_000);
		w.fire();
		assert.equal(w.pending.get("tab:a")?.still, true);
		assert.deepEqual(w.logs, ["window timing: resume tab:a still at waiting after 60 s"]);
		assert.equal(w.pending.list().length, 1, "age never clears an operation");
		assert.equal(w.pending.elapsedMs(w.pending.get("tab:a")!), 60_000);
	});

	it("drops every operation and its timers on dispose, and ignores a later begin", () => {
		const w = world();
		w.pending.begin("tab:a", "resume");
		w.pending.dispose();
		assert.deepEqual(w.pending.list(), []);
		assert.ok(w.timers.every(timer => timer.cleared));
		const heard = w.changes.length;
		w.pending.begin("tab:b", "resume").step("working");
		assert.equal(w.changes.length, heard);
		assert.equal(w.pending.get("tab:b"), undefined);
	});

	it("takes its steps from the launch laps of the tab, and a lap that is not mapped moves nothing", () => {
		const w = world();
		const timeline = new LaunchTimeline();
		timeline.observe(observeLaunchSteps(w.pending));
		timeline.begin("tab:a", "resume");
		w.pending.begin("tab:a", "resume");
		w.pending.step("tab:a", "ownership");
		timeline.lap("tab:a", "panel");
		assert.equal(w.pending.get("tab:a")?.step, "ownership", "the editor lap does not leave the ownership step");
		timeline.lap("tab:a", "admission");
		assert.equal(w.pending.get("tab:a")?.step, "prepare");
		timeline.lap("tab:a", "host control keys");
		assert.equal(w.pending.get("tab:a")?.step, "runtime");
		timeline.lap("tab:a", "broker slot");
		assert.equal(w.pending.get("tab:a")?.step, "spawn");
		timeline.add("tab:a", "child spawn", 12);
		assert.equal(w.pending.get("tab:a")?.step, "connect");
	});

	it("maps every launch lap", () => {
		const laps: LaunchLap[] = ["draft", "wait", "ownership", "panel", "admission", "stage", "host control keys", "runtime proof", "editor document", "broker slot", "conversation", "run intent"];
		assert.deepEqual(Object.keys(STEP_AFTER_LAP).sort(), [...laps].sort());
	});
});

describe("naming the step of an action that is not a launch", () => {
	it("moves the latest operation of the given kind, and leaves a launch alone when none of that kind is pending", () => {
		const w = world();
		const launch = w.pending.begin("tab:a", "resume");
		w.pending.step("tab:a", "working", "delete");
		assert.equal(w.pending.get("tab:a")?.step, "waiting", "no delete is pending: nothing moves");
		const removal = w.pending.begin("tab:a", "delete", { step: "checking" });
		w.pending.step("tab:a", "working", "delete");
		assert.equal(w.pending.get("tab:a")?.kind, "delete");
		assert.equal(w.pending.get("tab:a")?.step, "working");
		removal.end("running");
		assert.equal(w.pending.get("tab:a")?.step, "waiting", "the launch kept its own step");
		launch.end("running");
	});
});
