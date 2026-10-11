import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { callerOf, describeElement, FocusTrace, TRACE_MAX_REPORTS, TRACE_MIN_GAP_MS, TRACE_RING_SIZE, USER_ACTION_WINDOW_MS } from "./focus-trace.ts";
import { MAX_FOCUS_TRACE_DETAIL_LENGTH } from "../messages.ts";

function fixture() {
	const clock = { now: 10_000 };
	const lines: string[] = [];
	const trace = new FocusTrace(() => clock.now, line => lines.push(line));
	return { clock, lines, trace };
}

describe("the focus trace", () => {
	it("posts the reason with what the page saw, newest first, with its age", () => {
		const f = fixture();
		f.trace.note("in textarea.omp-textarea");
		f.clock.now += 30;
		f.trace.note("window blur");
		f.clock.now += 20;
		assert.equal(f.trace.report("composer lost focus to none"), true);
		assert.deepEqual(f.lines, ["composer lost focus to none | -20ms window blur | -50ms in textarea.omp-textarea"]);
	});

	it("keeps only the newest events", () => {
		const f = fixture();
		for (let index = 0; index < TRACE_RING_SIZE + 5; index += 1) f.trace.note(`event ${index}`);
		f.trace.report("lost");
		const line = f.lines[0]!;
		assert.equal(line.split(" | ").length, TRACE_RING_SIZE + 1);
		assert.ok(!line.includes("event 0 ") && !line.endsWith("event 0"));
		assert.ok(line.includes(`event ${TRACE_RING_SIZE + 4}`));
	});

	it("reports at most once a second and a bounded number of times", () => {
		const f = fixture();
		assert.equal(f.trace.report("one"), true);
		f.clock.now += TRACE_MIN_GAP_MS - 1;
		assert.equal(f.trace.report("too soon"), false);
		f.clock.now += 1;
		assert.equal(f.trace.report("two"), true);
		for (let index = 0; index < TRACE_MAX_REPORTS; index += 1) {
			f.clock.now += TRACE_MIN_GAP_MS;
			f.trace.report("more");
		}
		assert.equal(f.lines.length, TRACE_MAX_REPORTS);
	});

	it("knows a pointer press or focus key as the user's own move for a short while", () => {
		const f = fixture();
		assert.equal(f.trace.userRecently, false);
		f.trace.userMoved();
		f.clock.now += USER_ACTION_WINDOW_MS;
		assert.equal(f.trace.userRecently, true);
		f.clock.now += 1;
		assert.equal(f.trace.userRecently, false);
	});

	it("never posts a line the boundary would refuse", () => {
		const f = fixture();
		f.trace.note("a\u0000b\nc".repeat(500));
		f.trace.report("x");
		const line = f.lines[0]!;
		assert.ok(line.length <= MAX_FOCUS_TRACE_DETAIL_LENGTH);
		assert.doesNotMatch(line, /[\u0000-\u001f]/);
	});

	it("names an element by tag and first class, and the caller by function and file position", () => {
		assert.equal(describeElement({ nodeType: 1, tagName: "TEXTAREA", classList: { item: () => "omp-textarea" } }), "textarea.omp-textarea");
		assert.equal(describeElement({ nodeType: 1, tagName: "DIV", classList: { item: () => null }, id: "root" }), "div#root");
		assert.equal(describeElement(null), "none");
		assert.equal(describeElement({ nodeType: 9 }), "window");
		const stack = [
			"Error",
			"    at HTMLElement.focusTraced (webview://x/focus-trace.ts:160:30)",
			"    at takeFocus (webview://x/ui.js:4812:11)",
			"    at https://host/ui.js:9:3",
		].join("\n");
		assert.equal(callerOf(stack), "takeFocus@ui.js:4812");
		assert.equal(callerOf("Error\n    at https://host/other.js:9:3"), "other.js:9");
		assert.equal(callerOf(undefined), "unknown");
	});
});
