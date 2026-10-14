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
		t.instance.begin("tab:a");
		t.advance(30);
		t.instance.lap("tab:a", "panel");
		t.advance(200);
		t.instance.add("tab:a", "runtime proof", 150);
		t.advance(10);
		t.instance.lap("tab:a", "rest");
		t.advance(5);
		assert.deepEqual(t.instance.summary("tab:a"), { totalMs: 245, phases: "panel 30 · runtime proof 150 · rest 10" });
	});

	it("ends the run at finish with the time since the command", () => {
		const t = timeline();
		t.instance.begin("tab:a");
		t.advance(35_000);
		assert.equal(t.instance.finish("tab:a"), 35_000);
		assert.equal(t.instance.has("tab:a"), false);
		assert.equal(t.instance.finish("tab:a"), null);
	});

	it("starts a tab's run again from begin, and drops a run that was never finished once it is old", () => {
		const t = timeline();
		t.instance.begin("tab:a");
		t.advance(50);
		t.instance.lap("tab:a", "panel");
		t.instance.begin("tab:a");
		assert.deepEqual(t.instance.summary("tab:a"), { totalMs: 0, phases: "" });
		t.advance(11 * 60_000);
		t.instance.begin("tab:b");
		assert.equal(t.instance.has("tab:a"), false);
		assert.equal(t.instance.has("tab:b"), true);
	});
});
