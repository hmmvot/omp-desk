import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseGuestWebviewMessage } from "../../protocol/messages.ts";
import { PAGE_BEAT_INTERVAL_MS, PAGE_EVENT_POST_GAP_MS, PAGE_EVENT_RING_SIZE } from "../../protocol/page-health.ts";
import type { GuestPageHealthMessage, PageLongTask } from "../../protocol/page-health.ts";
import { LONG_TASK_JOIN_MS, LongTaskJoin, PageEventRing, PageHeartbeat, normalizeFunction, normalizeInvoker, normalizeSource, receivedKind } from "./page-health.ts";

function fixture() {
	const clock = { now: 5_000, visible: true };
	const posted: GuestPageHealthMessage[] = [];
	const timers = new Map<number, { at: number; run: () => void }>();
	let nextTimer = 1;
	const heartbeat = new PageHeartbeat({
		now: () => clock.now,
		visible: () => clock.visible,
		post: message => posted.push(message),
		setTimer: (run, ms) => { timers.set(nextTimer, { at: clock.now + ms, run }); return nextTimer++; },
		clearTimer: handle => void timers.delete(handle as number),
	});
	/** Move the clock; fire the timer that falls due, `lateBy` ms after its time (a frozen main thread runs it late). */
	const advanceTo = (time: number, lateBy = 0) => {
		for (const [id, timer] of [...timers]) {
			if (timer.at > time) continue;
			timers.delete(id);
			clock.now = timer.at + lateBy;
			timer.run();
		}
		clock.now = Math.max(clock.now, time);
	};
	return { clock, posted, timers, heartbeat, advanceTo };
}

describe("the page event ring", () => {
	it("folds consecutive events of one kind into a run and ages each by its last event", () => {
		const ring = new PageEventRing();
		ring.note("rx:omp:chat-event", 100);
		ring.note("rx:omp:chat-event", 110);
		ring.note("render", 120);
		ring.note("rx:omp:chat-event", 130);
		assert.deepEqual(ring.snapshot(150), [
			{ kind: "rx:omp:chat-event", count: 2, agoMs: 40 },
			{ kind: "render", count: 1, agoMs: 30 },
			{ kind: "rx:omp:chat-event", count: 1, agoMs: 20 },
		]);
	});

	it("keeps the newest events only", () => {
		const ring = new PageEventRing();
		for (let index = 0; index < PAGE_EVENT_RING_SIZE + 3; index += 1) ring.note(index % 2 === 0 ? "key" : "pointer", index);
		const events = ring.snapshot(100);
		assert.equal(events.length, PAGE_EVENT_RING_SIZE);
		assert.equal(events.at(-1)?.agoMs, 100 - (PAGE_EVENT_RING_SIZE + 2));
	});

	it("names a received host message by its type, and `rx:other` when the type is not of the protocol's form", () => {
		assert.equal(receivedKind("omp:chat-event"), "rx:omp:chat-event");
		assert.equal(receivedKind("omp:chat-btw-delta"), "rx:omp:chat-btw-delta");
		for (const odd of ["", "chat-event", "omp:Chat", "omp:chat event", "omp:" + "a".repeat(41), "omp:chat\n"]) assert.equal(receivedKind(odd), "rx:other", JSON.stringify(odd));
	});
});

describe("the page heartbeat", () => {
	it("reports at start, then every beat interval while visible, and says how late a timer ran", () => {
		const f = fixture();
		f.heartbeat.start();
		assert.deepEqual(f.posted.map(message => [message.reason, message.seq, message.visible, message.lateMs]), [["beat", 0, true, 0]]);
		f.advanceTo(5_000 + PAGE_BEAT_INTERVAL_MS);
		f.advanceTo(5_000 + 2 * PAGE_BEAT_INTERVAL_MS + 100);
		assert.deepEqual(f.posted.map(message => [message.reason, message.seq, message.lateMs]), [["beat", 0, 0], ["beat", 1, 0], ["beat", 2, 0]]);
		// The main thread was stuck for 30 s: the next beat's timer runs that late.
		f.advanceTo(5_000 + 3 * PAGE_BEAT_INTERVAL_MS + 130, 30_000);
		assert.equal(f.posted.at(-1)?.lateMs, 30_000);
	});

	it("says how overdue the beat is on whichever report leaves first after a freeze", () => {
		const f = fixture();
		f.heartbeat.start();
		f.clock.now = 5_000 + PAGE_BEAT_INTERVAL_MS + 30_000;
		// Queued input runs before the overdue timer: the event's report carries the figure.
		f.heartbeat.note("key");
		assert.deepEqual([f.posted.at(-1)?.reason, f.posted.at(-1)?.lateMs], ["events", 30_000]);
		f.heartbeat.longTask({ durationMs: 30_000, name: "self", scripts: [] });
		assert.equal(f.posted.at(-1)?.lateMs, 30_000);
	});

	it("reports what happened at most once per gap, ahead of the beat, with the events so far", () => {
		const f = fixture();
		f.heartbeat.start();
		f.clock.now += PAGE_EVENT_POST_GAP_MS;
		f.heartbeat.note("rx:omp:chat-snapshot");
		assert.equal(f.posted.length, 2);
		assert.equal(f.posted[1]?.reason, "events");
		assert.deepEqual(f.posted[1]?.events, [{ kind: "rx:omp:chat-snapshot", count: 1, agoMs: 0 }]);
		f.clock.now += PAGE_EVENT_POST_GAP_MS - 1;
		f.heartbeat.note("key");
		assert.equal(f.posted.length, 2, "inside the gap the event waits for the next report");
		f.clock.now += 1;
		f.heartbeat.note("key");
		assert.equal(f.posted.length, 3);
		assert.deepEqual(f.posted[2]?.events.map(event => [event.kind, event.count]), [["rx:omp:chat-snapshot", 1], ["key", 2]]);
	});

	it("stops its timer while hidden, says so, and starts again with a report when visible", () => {
		const f = fixture();
		f.heartbeat.start();
		f.clock.visible = false;
		f.heartbeat.visibilityChanged();
		assert.equal(f.timers.size, 0, "no timer runs in a hidden page");
		assert.deepEqual(f.posted.at(-1) && [f.posted.at(-1)!.reason, f.posted.at(-1)!.visible, f.posted.at(-1)!.lateMs], ["visibility", false, 0]);
		const count = f.posted.length;
		f.clock.now += 60 * 60_000;
		f.heartbeat.note("key");
		assert.equal(f.posted.length, count, "a hidden page posts nothing, whatever it does");
		f.clock.visible = true;
		f.heartbeat.visibilityChanged();
		assert.deepEqual([f.posted.at(-1)!.reason, f.posted.at(-1)!.visible], ["visibility", true]);
		assert.equal(f.timers.size, 1);
		assert.deepEqual(f.posted.at(-1)!.events.map(event => event.kind), ["hidden", "key", "visible"]);
		f.heartbeat.visibilityChanged();
		assert.equal(f.posted.length, count + 1, "a visibility event that changes nothing is not reported");
	});

	it("takes the overdue figure before a visibility change cancels the timer", () => {
		const f = fixture();
		f.heartbeat.start();
		// A freeze that ends with the page being hidden: the report of the change still says how long the thread was stuck.
		f.clock.now = 5_000 + PAGE_BEAT_INTERVAL_MS + 20_000;
		f.clock.visible = false;
		f.heartbeat.visibilityChanged();
		assert.deepEqual([f.posted.at(-1)?.reason, f.posted.at(-1)?.lateMs], ["visibility", 20_000]);
		// Hidden pages have no pending beat: the report that shows the page again carries none.
		f.clock.visible = true;
		f.heartbeat.visibilityChanged();
		assert.equal(f.posted.at(-1)?.lateMs, 0);
	});

	it("reports a long task at once, and everything it posts is accepted by the host's parser", () => {
		const f = fixture();
		f.heartbeat.start();
		const task: PageLongTask = { durationMs: 1300, name: "self", container: "window", scripts: [{ invoker: "user-callback:TimerHandler:setTimeout", source: "guest.js:12", fn: "-", durationMs: 1200 }] };
		f.heartbeat.longTask(task);
		assert.equal(f.posted.at(-1)?.reason, "long-task");
		assert.deepEqual(f.posted.at(-1)?.longTask, task);
		f.heartbeat.note("rx:omp:chat-event");
		for (const message of f.posted) assert.deepEqual(parseGuestWebviewMessage(message), message);
	});

	it("posts nothing and keeps no timer after it is disposed", () => {
		const f = fixture();
		f.heartbeat.start();
		const count = f.posted.length;
		f.heartbeat.dispose();
		assert.equal(f.timers.size, 0);
		f.clock.now += 10_000;
		f.heartbeat.note("key");
		f.heartbeat.longTask({ durationMs: 1000, name: "self", scripts: [] });
		f.clock.visible = false;
		f.heartbeat.visibilityChanged();
		assert.equal(f.posted.length, count);
	});

	it("survives a post that throws and numbers every report", () => {
		const posted: number[] = [];
		const heartbeat = new PageHeartbeat({
			now: () => 0, visible: () => true, setTimer: () => 0, clearTimer: () => {},
			post: message => { posted.push(message.seq); if (message.seq === 0) throw new Error("channel closed"); },
		});
		heartbeat.start();
		heartbeat.longTask({ durationMs: 1000, name: "self", scripts: [] });
		assert.deepEqual(posted, [0, 1]);
	});
});

describe("the long task join", () => {
	function joinFixture() {
		const reported: PageLongTask[] = [];
		const timers: Array<{ run: () => void; ms: number }> = [];
		const join = new LongTaskJoin(task => reported.push(task), (run, ms) => timers.push({ run, ms }));
		return { reported, timers, join, fire: () => { for (const timer of timers.splice(0)) timer.run(); } };
	}
	const frame = { startTime: 1_000, duration: 1_400, scripts: [
		{ invoker: "TimerHandler:setTimeout", invokerType: "user-callback", sourceURL: "https://host.example/a/b/guest.js?v=1", sourceFunctionName: "step", sourceCharPosition: 4521, duration: 100 },
		{ invoker: "BUTTON#send.onclick", invokerType: "event-listener", sourceURL: "webview://x/guest.js", sourceFunctionName: "renderRows", sourceCharPosition: 812345, duration: 1_250 },
	] };

	it("ignores a task shorter than a second", () => {
		const f = joinFixture();
		f.join.task({ startTime: 0, duration: 999, name: "self" });
		assert.equal(f.timers.length, 0);
	});

	it("waits for the frame, then names the longest scripts without element identity or folders", () => {
		const f = joinFixture();
		f.join.task({ startTime: 1_050, duration: 1_300, name: "self", attribution: [{ containerType: "window" }] });
		assert.equal(f.timers[0]?.ms, LONG_TASK_JOIN_MS);
		f.join.frame(frame);
		f.fire();
		assert.deepEqual(f.reported, [{
			durationMs: 1300,
			name: "self",
			container: "window",
			scripts: [
				{ invoker: "event-listener:BUTTON.onclick", source: "guest.js:812345", fn: "renderRows", durationMs: 1250 },
				{ invoker: "user-callback:TimerHandler:setTimeout", source: "guest.js:4521", fn: "step", durationMs: 100 },
			],
		}]);
		assert.deepEqual(parseGuestWebviewMessage({ type: "omp:page-health", reason: "long-task", seq: 1, visible: true, lateMs: 0, events: [], longTask: f.reported[0] })?.type, "omp:page-health");
	});

	it("sends the browser's name and container only when they are in its fixed list", () => {
		const f = joinFixture();
		f.join.task({ startTime: 1_000, duration: 1_500, name: "something-new", attribution: [{ containerType: "tab-of-the-future" }] });
		f.fire();
		assert.deepEqual(f.reported, [{ durationMs: 1500, name: "unknown", scripts: [] }]);
	});

	it("reports the task alone when no frame overlaps it or the browser has none", () => {
		const f = joinFixture();
		f.join.frame({ startTime: 50_000, duration: 100, scripts: [] });
		f.join.task({ startTime: 1_000, duration: 2_000, name: "same-origin-ancestor" });
		f.fire();
		assert.deepEqual(f.reported, [{ durationMs: 2000, name: "same-origin-ancestor", scripts: [] }]);
	});

	it("keeps only a few frames", () => {
		const f = joinFixture();
		f.join.frame(frame);
		for (let index = 0; index < 4; index += 1) f.join.frame({ startTime: 100_000 + index, duration: 1, scripts: [] });
		f.join.task({ startTime: 1_050, duration: 1_300, name: "self" });
		f.fire();
		assert.deepEqual(f.reported[0]?.scripts, []);
	});
});

describe("the attribution shapes", () => {
	it("keeps of a listener's invoker its tag and handler, with no id, class, attribute or source", () => {
		assert.equal(normalizeInvoker("event-listener", "BUTTON#my-private-title.onclick"), "event-listener:BUTTON.onclick");
		assert.equal(normalizeInvoker("event-listener", "DIV.omp-composer-input.oninput"), "event-listener:DIV.oninput");
		assert.equal(normalizeInvoker("event-listener", "Window.onmessage"), "event-listener:Window.onmessage");
		assert.equal(normalizeInvoker("event-listener", "IMG[src=data:image/svg+xml,<svg>secret</svg>].onload"), "event-listener:IMG.onload");
		assert.equal(normalizeInvoker("event-listener", "no handler here"), "event-listener:-");
	});

	it("keeps a callback's or a promise's own name only when it has the browser's plain form", () => {
		assert.equal(normalizeInvoker("user-callback", "TimerHandler:setTimeout"), "user-callback:TimerHandler:setTimeout");
		assert.equal(normalizeInvoker("user-callback", "FrameRequestCallback"), "user-callback:FrameRequestCallback");
		assert.equal(normalizeInvoker("resolve-promise", "Promise.then"), "resolve-promise:Promise.then");
		assert.equal(normalizeInvoker("reject-promise", "some free text"), "reject-promise:-");
		assert.equal(normalizeInvoker("resolve-promise", "Response.json.then"), "resolve-promise:Response.json.then", "two dots keep their attribution");
		assert.equal(normalizeInvoker("resolve-promise", "A.b.c.d"), "resolve-promise:-");
	});

	it("names a script by its type alone, and an unknown type by nothing", () => {
		assert.equal(normalizeInvoker("classic-script", "https://host/folder/guest.js?token=abc"), "classic-script:-");
		assert.equal(normalizeInvoker("module-script", "webview://x/y.js"), "module-script:-");
		assert.equal(normalizeInvoker("a-new-kind", "BUTTON.onclick"), "-");
		assert.equal(normalizeInvoker(undefined, "BUTTON.onclick"), "-");
		assert.equal(normalizeInvoker(undefined, undefined), "-");
	});

	it("keeps a script's file name and position and nothing of its folder, host or query", () => {
		assert.equal(normalizeSource("https://file+.vscode-resource.vscode-cdn.net/c%3A/Users/someone/ext/media/guest.js?x=1#y", 99), "guest.js:99");
		assert.equal(normalizeSource("C:\\Users\\someone\\guest.js", undefined), "guest.js");
		assert.equal(normalizeSource("", 5), "-");
		assert.equal(normalizeSource(undefined, undefined), "-");
		assert.equal(normalizeSource("https://host/guest.js", -1), "guest.js");
		assert.equal(normalizeSource("https://host/guest.js", 999_999_999.4), "guest.js:999999999");
		assert.equal(normalizeSource("https://host/guest.js", 999_999_999.5), "guest.js", "a position that rounds out of range is dropped, not sent");
		assert.equal(normalizeSource("data:text/javascript,alert(1)", 5), "-", "an address that is not a file name");
		assert.equal(normalizeSource("https://host/some name.js", 5), "-");
	});

	it("keeps a function name only when it is an identifier", () => {
		assert.equal(normalizeFunction("renderRows"), "renderRows");
		assert.equal(normalizeFunction("$a_1"), "$a_1");
		assert.equal(normalizeFunction("an anonymous function"), "-");
		assert.equal(normalizeFunction("1st"), "-");
		assert.equal(normalizeFunction(""), "-");
		assert.equal(normalizeFunction(undefined), "-");
	});
});
