import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LaunchTimeline } from "./launch-timeline.ts";

function timeline() {
	let now = 1000;
	const instance = new LaunchTimeline(() => now);
	return { instance, advance(ms: number) { now += ms; } };
}

describe("launch timeline", () => {
	it("reports nothing for a tab whose launch did not begin a run", () => {
		const t = timeline();
		t.instance.lap("tab:a", "panel");
		t.instance.add("tab:a", "broker spawn", 5);
		assert.equal(t.instance.summary("tab:a"), null);
		assert.equal(t.instance.finish("tab:a"), null);
	});

	it("lists laps and timed phases in order, and a lap excludes a phase the caller timed itself", () => {
		const t = timeline();
		t.instance.begin("tab:a", "new session");
		t.advance(30);
		t.instance.lap("tab:a", "panel");
		t.advance(200);
		t.instance.add("tab:a", "runtime proof", 150);
		t.advance(10);
		t.instance.lap("tab:a", "stage");
		t.advance(5);
		assert.deepEqual(t.instance.summary("tab:a"), { kind: "new session", totalMs: 245, phases: "panel 30 · runtime proof 150 · stage 10" });
	});

	it("ends the run at finish with its kind and the time since the command", () => {
		const t = timeline();
		t.instance.begin("tab:a", "resume");
		t.advance(35_000);
		assert.deepEqual(t.instance.finish("tab:a"), { kind: "resume", totalMs: 35_000 });
		assert.equal(t.instance.has("tab:a"), false);
		assert.equal(t.instance.finish("tab:a"), null);
	});

	it("starts a tab's run again from begin, and drops a run that was never finished once it is old", () => {
		const t = timeline();
		t.instance.begin("tab:a", "new session");
		t.advance(50);
		t.instance.lap("tab:a", "panel");
		t.instance.begin("tab:a", "new session");
		assert.deepEqual(t.instance.summary("tab:a"), { kind: "new session", totalMs: 0, phases: "" });
		t.advance(11 * 60_000);
		t.instance.begin("tab:b", "new session");
		assert.equal(t.instance.has("tab:a"), false);
		assert.equal(t.instance.has("tab:b"), true);
	});

	it("times a Resume from the moment the command was entered, not from the moment the run began", () => {
		const t = timeline();
		t.advance(400);
		t.instance.begin("tab:a", "resume", 1000);
		t.advance(100);
		t.instance.lap("tab:a", "panel");
		assert.deepEqual(t.instance.summary("tab:a"), { kind: "resume", totalMs: 500, phases: "panel 500" });
	});

	it("drops the run of a command whose launch never reached the launcher, and keeps one the launcher took", () => {
		const t = timeline();
		t.instance.begin("tab:a", "open");
		t.instance.abandon("tab:a");
		assert.equal(t.instance.has("tab:a"), false, "an Open that launched nothing leaves no run for a later launch to claim");
		t.instance.begin("tab:b", "open");
		assert.equal(t.instance.reached("tab:b"), "open");
		t.instance.abandon("tab:b");
		assert.equal(t.instance.has("tab:b"), true, "the launcher owns a run it took");
		assert.equal(t.instance.reached("tab:none"), null);
	});

	it("tells its observer of each lap, added phase and end of a tab that has a run, and of nothing else", () => {
		const t = timeline();
		const told: string[] = [];
		t.instance.observe({ onLap: (tabId, lap) => told.push(`${tabId} lap ${lap}`), onAdd: tabId => told.push(`${tabId} add`), onEnd: tabId => told.push(`${tabId} end`) });
		t.instance.lap("tab:a", "panel");
		t.instance.add("tab:a", "spawn", 1);
		t.instance.finish("tab:a");
		t.instance.discard("tab:a");
		assert.deepEqual(told, [], "no run: no lap, no end and no observation");
		t.instance.begin("tab:a", "view switch");
		t.instance.lap("tab:a", "admission");
		t.instance.add("tab:a", "spawn", 1);
		assert.deepEqual(told, ["tab:a lap admission", "tab:a add"]);
		t.instance.finish("tab:a");
		t.instance.begin("tab:b", "resume");
		t.instance.discard("tab:b");
		assert.deepEqual(told, ["tab:a lap admission", "tab:a add", "tab:a end", "tab:b end"], "finish and discard both end a run, once");
		t.instance.observe(null);
		t.instance.begin("tab:c", "resume");
		t.instance.lap("tab:c", "stage");
		t.instance.finish("tab:c");
		assert.equal(told.length, 4);
	});
});
