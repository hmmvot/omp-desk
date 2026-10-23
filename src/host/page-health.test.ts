import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GuestPageHealthMessage } from "../protocol/page-health.ts";
import { PAGE_STALL_THRESHOLD_MS } from "../protocol/page-health.ts";
import type { Logger } from "../shared/logger.ts";
import {
	LONG_TASK_LOG_CAP,
	LONG_TASK_LOG_GAP_MS,
	PAGE_CHECK_INTERVAL_MS,
	PAGE_CHECK_MAX_GAP_MS,
	STALL_LOG_CAP,
	PageHealthMonitor,
	PageStallDetector,
	describeEvents,
	describeLongTask,
	pageDuration,
} from "./page-health.ts";

function report(seq: number, patch: Partial<GuestPageHealthMessage> = {}): GuestPageHealthMessage {
	return { type: "omp:page-health", reason: "beat", seq, visible: true, lateMs: 0, events: [], ...patch };
}

/** A detector with a visible panel and an unfocused window unless a call says otherwise. */
function detectorFixture() {
	const detector = new PageStallDetector();
	return {
		detector,
		report: (now: number, message: GuestPageHealthMessage, hostVisible = true) => detector.report(now, message, hostVisible),
		check: (now: number, hostVisible = true, focused = false) => detector.check(now, hostVisible, focused),
	};
}

describe("the stall detector", () => {
	it("calls a visible page stalled once its silence reaches the threshold, and only once", () => {
		const d = detectorFixture();
		assert.equal(d.report(1_000, report(0)), null);
		for (let now = 3_000; now < 1_000 + PAGE_STALL_THRESHOLD_MS; now += PAGE_CHECK_INTERVAL_MS) assert.equal(d.check(now), null);
		assert.deepEqual(d.check(1_000 + PAGE_STALL_THRESHOLD_MS), { kind: "stalled", silentMs: PAGE_STALL_THRESHOLD_MS, lastReportAgoMs: PAGE_STALL_THRESHOLD_MS });
		assert.equal(d.detector.stalled, true);
		assert.equal(d.check(1_000 + PAGE_STALL_THRESHOLD_MS + PAGE_CHECK_INTERVAL_MS), null, "the same stall is not reported twice");
	});

	it("reports the end of a stall once, with its length from the last sign of life", () => {
		const d = detectorFixture();
		d.report(0, report(0));
		for (let now = PAGE_CHECK_INTERVAL_MS; now <= 20_000; now += PAGE_CHECK_INTERVAL_MS) d.check(now);
		assert.equal(d.detector.stalledFor(20_000), 20_000);
		assert.deepEqual(d.report(47_000, report(1)), { kind: "recovered", stalledMs: 47_000, hostPaused: false, replaced: false });
		assert.equal(d.detector.stalled, false);
		assert.equal(d.detector.stalledFor(48_000), null);
		assert.equal(d.report(49_000, report(2)), null);
	});

	it("does not measure silence while the host sees the panel hidden, and starts again when it is visible", () => {
		const d = detectorFixture();
		d.report(0, report(0));
		d.check(2_000);
		for (let now = 4_000; now <= 120_000; now += PAGE_CHECK_INTERVAL_MS) assert.equal(d.check(now, false), null);
		assert.equal(d.check(122_000), null, "the clock starts when the panel is seen visible again, not at the last beat");
		for (let now = 124_000; now < 122_000 + PAGE_STALL_THRESHOLD_MS; now += PAGE_CHECK_INTERVAL_MS) assert.equal(d.check(now), null);
		assert.equal(d.check(122_000 + PAGE_STALL_THRESHOLD_MS)?.kind, "stalled");
	});

	it("does not measure silence of a page that reported itself hidden in an unfocused window, and starts again on its visible report", () => {
		const d = detectorFixture();
		d.report(0, report(0));
		d.report(1_000, report(1, { reason: "visibility", visible: false }));
		for (let now = 3_000; now <= 600_000; now += PAGE_CHECK_INTERVAL_MS) assert.equal(d.check(now), null, `at ${now}`);
		d.report(601_000, report(2, { reason: "visibility", visible: true }));
		for (let now = 603_000; now < 601_000 + PAGE_STALL_THRESHOLD_MS; now += PAGE_CHECK_INTERVAL_MS) assert.equal(d.check(now), null);
		assert.equal(d.check(601_000 + PAGE_STALL_THRESHOLD_MS)?.kind, "stalled");
	});

	it("watches a page that last said it was hidden once the window has the focus: a page shown to the user that does not say so is stuck", () => {
		const d = detectorFixture();
		d.report(0, report(0));
		d.report(1_000, report(1, { reason: "visibility", visible: false }));
		for (let now = 3_000; now <= 600_000; now += PAGE_CHECK_INTERVAL_MS) assert.equal(d.check(now), null);
		// The user comes back to the window; a healthy page would say it is visible within moments.
		assert.equal(d.check(602_000, true, true), null, "the clock starts when the window is seen focused");
		for (let now = 604_000; now < 602_000 + PAGE_STALL_THRESHOLD_MS; now += PAGE_CHECK_INTERVAL_MS) assert.equal(d.check(now, true, true), null);
		assert.equal(d.check(602_000 + PAGE_STALL_THRESHOLD_MS, true, true)?.kind, "stalled");

		const healthy = detectorFixture();
		healthy.report(0, report(0, { reason: "visibility", visible: false }));
		for (let now = 2_000; now <= 600_000; now += PAGE_CHECK_INTERVAL_MS) healthy.check(now);
		healthy.check(602_000, true, true);
		healthy.report(602_100, report(1, { reason: "visibility", visible: true }));
		let seq = 2;
		for (let now = 604_000; now <= 700_000; now += PAGE_CHECK_INTERVAL_MS) {
			healthy.report(now - 500, report(seq++));
			assert.equal(healthy.check(now, true, true), null, `a page that beats is never stalled (${now})`);
		}
	});

	it("does not watch a page whose hidden report came while the user was in the window, until the user is seen to leave and come back", () => {
		// A tab in a window of its own that was minimised, while the user works in another window: the window the host asks about has the focus.
		const d = detectorFixture();
		d.report(0, report(0));
		d.report(1_000, report(1, { reason: "visibility", visible: false }));
		for (let now = 3_000; now <= 600_000; now += PAGE_CHECK_INTERVAL_MS) assert.equal(d.check(now, true, true), null, `at ${now}`);
		// The user leaves and returns: a page that is shown and has not said so is stuck.
		assert.equal(d.check(602_000, true, false), null);
		assert.equal(d.check(604_000, true, true), null);
		for (let now = 606_000; now < 604_000 + PAGE_STALL_THRESHOLD_MS; now += PAGE_CHECK_INTERVAL_MS) assert.equal(d.check(now, true, true), null);
		assert.equal(d.check(604_000 + PAGE_STALL_THRESHOLD_MS, true, true)?.kind, "stalled");
	});

	it("does not blame the page for a pause of the host itself", () => {
		const d = detectorFixture();
		d.report(0, report(0));
		d.check(2_000);
		// The host's event loop was blocked (or the machine slept) for a minute.
		assert.equal(d.check(62_000), null);
		assert.equal(d.check(62_000 + PAGE_CHECK_INTERVAL_MS), null);
		assert.equal(d.check(62_000 + PAGE_CHECK_MAX_GAP_MS), null, "the silence is measured from the first check after the pause");
		assert.equal(d.check(62_000 + PAGE_STALL_THRESHOLD_MS)?.kind, "stalled");
	});

	it("says that the host paused during a stall it reports the end of", () => {
		const d = detectorFixture();
		d.report(0, report(0));
		for (let now = 2_000; now <= 12_000; now += 2_000) d.check(now);
		assert.equal(d.detector.stalled, true);
		assert.equal(d.check(100_000), null);
		assert.deepEqual(d.report(101_000, report(1)), { kind: "recovered", stalledMs: 101_000, hostPaused: true, replaced: false });
	});

	it("takes a report whose counter did not advance for a new document, and says so after a stall", () => {
		const d = detectorFixture();
		d.report(0, report(7));
		assert.equal(d.detector.replaced, false);
		for (let now = 2_000; now <= 12_000; now += 2_000) d.check(now);
		assert.deepEqual(d.report(13_000, report(0)), { kind: "recovered", stalledMs: 13_000, hostPaused: false, replaced: true });
		assert.equal(d.detector.replaced, true);
		assert.equal(d.report(15_000, report(1)), null, "an ordinary advance is not a replacement");
		assert.equal(d.detector.replaced, false);
	});

	it("keeps a reported stall's length across a hidden spell", () => {
		const d = detectorFixture();
		d.report(0, report(0));
		for (let now = 2_000; now <= 12_000; now += 2_000) d.check(now);
		for (let now = 14_000; now <= 60_000; now += 2_000) d.check(now, false);
		for (let now = 62_000; now <= 70_000; now += 2_000) d.check(now);
		assert.deepEqual(d.report(71_000, report(1)), { kind: "recovered", stalledMs: 71_000, hostPaused: false, replaced: false });
	});
});

function fixture() {
	const clock = { now: 100_000 };
	const lines: string[] = [];
	const log: Logger = { error: () => {}, warn: line => lines.push(`warn ${line}`), info: line => lines.push(line), debug: () => {}, trace: () => {} };
	const timers = { started: 0, stopped: 0 };
	const monitor = new PageHealthMonitor({
		log,
		now: () => clock.now,
		startTimer: () => {
			timers.started += 1;
			return () => { timers.stopped += 1; };
		},
	});
	const panel = { visible: true };
	const focus = { on: false };
	const page = (target: { visible: boolean } = panel, label = "tab t1", document: object = target) => ({ panel: target, document, label, visible: () => target.visible, windowFocused: () => focus.on });
	const advance = (ms: number) => { for (let spent = 0; spent < ms; spent += PAGE_CHECK_INTERVAL_MS) { clock.now += PAGE_CHECK_INTERVAL_MS; monitor.check(); } };
	return { clock, lines, monitor, timers, panel, focus, page, advance };
}

describe("the page health monitor", () => {
	it("logs the silence of a visible page at Info with the page's last events, and its end with the length", () => {
		const f = fixture();
		f.monitor.note("s1", f.page(), report(4, { events: [{ kind: "rx:omp:chat-event", count: 230, agoMs: 1200 }, { kind: "render", count: 14, agoMs: 400 }, { kind: "key", count: 1, agoMs: 0 }] }));
		assert.deepEqual(f.lines, []);
		f.advance(PAGE_STALL_THRESHOLD_MS);
		assert.deepEqual(f.lines, ["tab t1: no report from the Chat page has reached the host for 10 s while it was visible (its last report, #4 (beat), came 10 s ago); its last events before it: rx:omp:chat-event ×230 (1.2 s), render ×14 (400 ms), key (0 ms)"]);
		f.advance(PAGE_STALL_THRESHOLD_MS);
		assert.equal(f.lines.length, 1, "one line per stall");
		f.clock.now += 1_000;
		f.monitor.note("s1", f.page(), report(5, { reason: "events", lateMs: 21_000 }));
		assert.equal(f.lines.length, 2);
		assert.equal(f.lines[1], "tab t1: the Chat page reports again after 21 s without a report; its own timer was 21 s overdue");
	});

	it("quotes the page's lateness only when it is worth quoting", () => {
		const f = fixture();
		f.monitor.note("s1", f.page(), report(0));
		f.advance(PAGE_STALL_THRESHOLD_MS);
		f.monitor.note("s1", f.page(), report(1, { lateMs: 40 }));
		assert.equal(f.lines[1], "tab t1: the Chat page reports again after 10 s without a report");
	});

	it("says that a stalled page was closed, with the silence it had", () => {
		const f = fixture();
		const closed = { visible: true };
		f.monitor.note("s1", f.page(closed), report(0));
		f.advance(PAGE_STALL_THRESHOLD_MS);
		f.clock.now += 5_000;
		f.monitor.forget("s1", closed);
		assert.equal(f.lines.at(-1), "tab t1: the Chat page was closed after 15 s without a report");
		const quiet = fixture();
		const other = { visible: true };
		quiet.monitor.note("s1", quiet.page(other), report(0));
		quiet.monitor.forget("s1", other);
		assert.deepEqual(quiet.lines, [], "a page that was not stalled closes without a line");
	});

	it("says that the last report of a stalled page said it was hidden, and why a figure of its own timer cannot be had", () => {
		const f = fixture();
		f.monitor.note("s1", f.page(), report(2, { reason: "visibility", visible: false }));
		f.advance(PAGE_CHECK_INTERVAL_MS);
		f.focus.on = true;
		f.advance(PAGE_STALL_THRESHOLD_MS + PAGE_CHECK_INTERVAL_MS);
		assert.match(f.lines[0]!, /\(its last report, #2 \(visibility\), came \d+ s ago and said the page was hidden\)/);
		f.monitor.note("s1", f.page(), report(3, { reason: "visibility", visible: true }));
		assert.match(f.lines[1]!, /reports again after \d+ s without a report; the page had reported itself hidden, so its own timer figure cannot tell whether it was stuck$/);
	});

	it("does not log a hidden panel's silence", () => {
		const f = fixture();
		f.monitor.note("s1", f.page(), report(0));
		f.panel.visible = false;
		f.advance(10 * 60_000);
		assert.deepEqual(f.lines, []);
		f.panel.visible = true;
		f.advance(PAGE_STALL_THRESHOLD_MS);
		assert.deepEqual(f.lines, [], "ten seconds of checks after the panel is seen visible again start with the first, so eight have passed");
		f.advance(PAGE_CHECK_INTERVAL_MS);
		assert.equal(f.lines.length, 1);
	});

	it("logs a long task with its attribution and events, bounded in rate and number", () => {
		const f = fixture();
		const task = { durationMs: 1300, name: "self", container: "window", scripts: [{ invoker: "event-listener:BUTTON.onclick", source: "guest.js:812345", fn: "renderRows", durationMs: 1250 }] };
		f.monitor.note("s1", f.page(), report(1, { reason: "long-task", longTask: task, events: [{ kind: "rx:omp:chat-snapshot", count: 1, agoMs: 1400 }] }));
		assert.deepEqual(f.lines, ["tab t1: the Chat page ran one task for 1.3 s, self in window, scripts: event-listener:BUTTON.onclick renderRows guest.js:812345 1.3 s; its last events: rx:omp:chat-snapshot (1.4 s)"]);
		f.clock.now += LONG_TASK_LOG_GAP_MS - 1;
		f.monitor.note("s1", f.page(), report(2, { reason: "long-task", longTask: task }));
		assert.equal(f.lines.length, 1, "a second one inside the gap is not logged");
		for (let index = 0; index < LONG_TASK_LOG_CAP + 5; index += 1) {
			f.clock.now += LONG_TASK_LOG_GAP_MS;
			f.monitor.note("s1", f.page(), report(3 + index, { reason: "long-task", longTask: task }));
		}
		assert.equal(f.lines.length, LONG_TASK_LOG_CAP + 1, "the cap, then one line that says the rest are not logged");
		assert.match(f.lines.at(-1)!, /are not logged for the rest of its life/);
	});

	it("bounds the lines of one page whatever it sends, and a document the host replaced starts a fresh budget", () => {
		const f = fixture();
		const stalls = () => f.lines.filter(line => line.includes("no report from the Chat page has reached the host")).length;
		const ends = () => f.lines.filter(line => line.includes("reports again after")).length;
		for (let cycle = 0; cycle < STALL_LOG_CAP + 5; cycle += 1) {
			f.monitor.note("s1", f.page(), report(cycle));
			f.advance(PAGE_STALL_THRESHOLD_MS);
		}
		assert.equal(stalls(), STALL_LOG_CAP);
		assert.equal(ends(), STALL_LOG_CAP, "only a stall that was logged gets an end line");
		assert.equal(f.lines.filter(line => line.includes("are not logged for the rest of its life")).length, 1, "said once");
		// A page that sends a counter that did not advance is a page that reloaded in place: the budget is the host's, not the page's.
		f.monitor.note("s1", f.page(), report(0));
		f.advance(PAGE_STALL_THRESHOLD_MS);
		assert.equal(stalls(), STALL_LOG_CAP);
		// A document the host itself replaced is a new page with its own budget.
		f.monitor.note("s1", f.page(f.panel, "tab t1", {}), report(0));
		f.advance(PAGE_STALL_THRESHOLD_MS);
		assert.equal(stalls(), STALL_LOG_CAP + 1);
	});

	it("does not let a page reset its long-task budget by restarting its counter", () => {
		const f = fixture();
		const task = { durationMs: 1300, name: "self", scripts: [] };
		for (let index = 0; index < LONG_TASK_LOG_CAP + 30; index += 1) {
			f.clock.now += LONG_TASK_LOG_GAP_MS;
			f.monitor.note("s1", f.page(), report(0, { reason: "long-task", longTask: task }));
		}
		assert.equal(f.lines.length, LONG_TASK_LOG_CAP + 1);
	});

	it("says that a stalled page was replaced by another document, with the silence it had", () => {
		const f = fixture();
		f.monitor.note("s1", f.page(f.panel, "tab t1", { first: true }), report(0));
		f.advance(PAGE_STALL_THRESHOLD_MS);
		f.clock.now += 5_000;
		f.monitor.note("s1", f.page(f.panel, "tab t1", { first: false }), report(0));
		assert.equal(f.lines.at(-1), "tab t1: the Chat page was replaced after 15 s without a report");
		assert.equal(f.lines.filter(line => line.includes("reports again after")).length, 0, "the new document did not recover the old one's stall");
	});

	it("treats a new panel under a slot as a new page and forgets a closed one", () => {
		const f = fixture();
		const first = { visible: true };
		f.monitor.note("s1", f.page(first), report(9));
		f.advance(PAGE_STALL_THRESHOLD_MS - PAGE_CHECK_INTERVAL_MS);
		const second = { visible: true };
		f.monitor.note("s1", f.page(second), report(0));
		f.advance(PAGE_STALL_THRESHOLD_MS - PAGE_CHECK_INTERVAL_MS);
		assert.deepEqual(f.lines, [], "the replaced page's silence is not charged to its successor");
		f.monitor.forget("s1", first);
		assert.equal(f.monitor.size, 1, "a superseded panel's close does not forget its successor");
		f.monitor.forget("s1", second);
		assert.equal(f.monitor.size, 0);
		f.advance(PAGE_STALL_THRESHOLD_MS * 2);
		assert.deepEqual(f.lines, []);
	});

	it("runs its timer only while a page is watched", () => {
		const f = fixture();
		assert.equal(f.timers.started, 0);
		f.monitor.note("s1", f.page(), report(0));
		f.monitor.note("s1", f.page(), report(1));
		assert.equal(f.timers.started, 1);
		f.monitor.forget("s1", f.panel);
		assert.equal(f.timers.stopped, 1);
		f.monitor.note("s1", f.page(), report(0));
		assert.equal(f.timers.started, 2);
		f.monitor.dispose();
		assert.equal(f.timers.stopped, 2);
	});
});

describe("the log phrases", () => {
	it("writes a duration as milliseconds, tenths of a second, seconds and minutes", () => {
		assert.deepEqual([0, 999, 1000, 1250, 9949, 10_000, 119_400, 125_000].map(pageDuration), ["0 ms", "999 ms", "1.0 s", "1.3 s", "9.9 s", "10 s", "119 s", "2 min 5 s"]);
	});

	it("describes events and a long task without a script", () => {
		assert.equal(describeEvents([]), "none");
		assert.equal(describeLongTask({ durationMs: 2500, name: "self", scripts: [] }), "2.5 s, self, no script attribution");
	});
});
