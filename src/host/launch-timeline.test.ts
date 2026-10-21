import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LaunchTimeline } from "./launch-timeline.ts";

function timeline() {
	let now = 1000;
	const lines: string[] = [];
	const instance = new LaunchTimeline(() => now, line => lines.push(line));
	return { instance, lines, now: () => now, advance(ms: number) { now += ms; } };
}

describe("launch timeline", () => {
	it("reports nothing for a tab whose launch did not begin a run", () => {
		const t = timeline();
		t.instance.lap("tab:a", "panel");
		t.instance.add("tab:a", "broker spawn", 5);
		assert.equal(t.instance.summary("tab:a"), null);
		assert.equal(t.instance.finish("tab:a"), null);
	});

	it("records laps and timed phases as milliseconds from the command, a timed phase continuing from the previous step", () => {
		const t = timeline();
		t.instance.begin("tab:a", "new session");
		t.advance(30);
		t.instance.lap("tab:a", "panel");
		t.advance(200);
		t.instance.add("tab:a", "runtime check", 150);
		t.instance.add("tab:a", "broker spawn", 40);
		t.advance(10);
		t.instance.lap("tab:a", "stage");
		t.advance(5);
		assert.deepEqual(t.instance.summary("tab:a"), { kind: "new session", totalMs: 245 });
		t.instance.finish("tab:a");
		assert.deepEqual(t.lines, ["window timing: new session tab:a start timeline, ms from the command: panel 30 · runtime check 180 · broker spawn 220 · stage 240 · host control verified 245"]);
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
		assert.deepEqual(t.instance.summary("tab:a"), { kind: "new session", totalMs: 0 });
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
		assert.deepEqual(t.instance.summary("tab:a"), { kind: "resume", totalMs: 500 });
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

	it("reports one line per started Chat, once it is live: laps, OMP's steps, host control and Chat live in order", () => {
		const t = timeline();
		t.instance.begin("tab:a", "new session");
		t.advance(5); t.instance.lap("tab:a", "admission");
		t.advance(20); t.instance.lap("tab:a", "stage");
		t.advance(300); t.instance.add("tab:a", "broker spawn", 280);
		t.instance.mark("tab:a", "omp spawned");
		t.instance.expectLive("tab:a");
		t.advance(4000); t.instance.mark("tab:a", "omp control published", t.now() - 500);
		t.advance(20_000); t.instance.mark("tab:a", "omp ready");
		t.advance(100); t.instance.finish("tab:a");
		assert.deepEqual(t.lines, [], "host control is verified but the Chat is not live yet: nothing is reported");
		t.advance(200); t.instance.mark("tab:a", "chat live");
		t.advance(50); t.instance.mark("tab:a", "chat live");
		assert.deepEqual(t.lines, ["window timing: new session tab:a start timeline, ms from the command: admission 5 · stage 25 · broker spawn 305 · omp spawned 325 · omp control published 3825 · omp ready 24325 · host control verified 24425 · chat live 24625"]);
	});

	it("reports a Terminal start or a Chat without host control at its end, with each step once", () => {
		const t = timeline();
		t.instance.begin("tab:a", "resume");
		t.advance(10); t.instance.mark("tab:a", "omp spawned");
		t.advance(10); t.instance.mark("tab:a", "omp spawned");
		t.advance(10); t.instance.finish("tab:a");
		t.instance.begin("tab:b", "open");
		t.instance.expectLive("tab:b");
		t.advance(10); t.instance.finishWithoutControl("tab:b");
		assert.equal(t.lines.length, 1);
		t.instance.mark("tab:b", "chat live");
		assert.deepEqual(t.lines, [
			"window timing: resume tab:a start timeline, ms from the command: omp spawned 10 · host control verified 30",
			"window timing: open tab:b start timeline, ms from the command: host control unavailable 10 · chat live 10",
		]);
	});

	it("reports the steps reached and where a start failed, for a run the launcher took or one that waits for its Chat", () => {
		const t = timeline();
		t.instance.begin("tab:a", "resume");
		t.advance(40); t.instance.lap("tab:a", "admission");
		t.advance(60); t.instance.discard("tab:a", "unconfirmed at the broker launch");
		assert.deepEqual(t.lines, ["window timing: resume tab:a start ended after 100 ms, failed or cancelled at unconfirmed at the broker launch; ms from the command: admission 40"]);
		assert.equal(t.instance.has("tab:a"), false);
		t.instance.begin("tab:b", "new session");
		t.instance.expectLive("tab:b");
		t.advance(7); t.instance.mark("tab:b", "omp spawned");
		t.instance.finish("tab:b");
		t.advance(3); t.instance.discard("tab:b", "chat failed (ready-timeout)");
		t.instance.mark("tab:b", "chat live");
		assert.deepEqual(t.lines.slice(1), ["window timing: new session tab:b start ended after 10 ms, failed or cancelled at chat failed (ready-timeout); ms from the command: omp spawned 7 · host control verified 7"]);
		t.instance.begin("tab:c", "open");
		t.advance(2); t.instance.discard("tab:c", "stopped");
		assert.match(t.lines[2]!, /failed or cancelled at stopped; ms from the command: no step reached$/);
	});

	it("reports a command that ended before any launch only when it says why, and a discard without a reason never", () => {
		const t = timeline();
		t.instance.begin("tab:a", "open");
		t.advance(3); t.instance.lap("tab:a", "ownership");
		t.instance.abandon("tab:a");
		t.instance.begin("tab:b", "open");
		t.advance(4); t.instance.lap("tab:b", "ownership");
		t.instance.abandon("tab:b", "the Cancel of the external-writer question");
		t.instance.begin("tab:c", "resume");
		t.instance.discard("tab:c");
		t.instance.begin("tab:d", "resume");
		t.instance.reached("tab:d");
		t.instance.abandon("tab:d", "an error");
		assert.deepEqual(t.lines, ["window timing: open tab:b start ended after 4 ms, failed or cancelled at the Cancel of the external-writer question; ms from the command: ownership 4"]);
		assert.equal(t.instance.has("tab:d"), true, "the launcher owns a run it took");
	});
});
