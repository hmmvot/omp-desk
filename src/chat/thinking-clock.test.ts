/** Thinking time as the page measures it from the stream: watched blocks have it, history and mid-stream snapshots do not. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AssistantMessage, ChatContent } from "./messages.ts";
import { ThinkingClocks, thinkingKey, thoughtDuration } from "./thinking-clock.ts";

const stream = (content: ChatContent[], patch: Partial<AssistantMessage> = {}): AssistantMessage => ({ role: "assistant", timestamp: 100, model: "m", provider: "p", stopReason: "stop", content, ...patch });
const thinking = (text: string): ChatContent => ({ type: "thinking", thinking: text });
const text = (value: string): ChatContent => ({ type: "text", text: value });
const call: ChatContent = { type: "toolCall", id: "t", name: "read", arguments: {} };
const key = (message: AssistantMessage, index = 0) => thinkingKey("chat", message, index);

describe("thinking clocks", () => {
	it("start when a block is first seen streaming and end when text follows it", () => {
		const clocks = new ThinkingClocks();
		assert.equal(clocks.observe("chat", null, 1000), false);
		const first = stream([thinking("")]);
		assert.equal(clocks.observe("chat", first, 2000), true);
		assert.deepEqual(clocks.get(key(first)), { start: 2000 });
		assert.equal(clocks.observe("chat", stream([thinking("Hmm")]), 3000), false, "growing text changes nothing");
		const answered = stream([thinking("Hmm"), text("Answer")]);
		assert.equal(clocks.observe("chat", answered, 9500), true);
		assert.deepEqual(clocks.get(key(answered)), { start: 2000, end: 9500 });
		assert.equal(clocks.observe("chat", null, 12_000), false, "an ended block is not ended again");
		assert.deepEqual(clocks.get(key(answered)), { start: 2000, end: 9500 });
	});

	it("end a block that was last when the message ends or another message replaces it", () => {
		const clocks = new ThinkingClocks();
		const aborted = stream([thinking("Hmm")]);
		clocks.observe("chat", null, 500);
		clocks.observe("chat", aborted, 1000);
		clocks.observe("chat", null, 4000);
		assert.deepEqual(clocks.get(key(aborted)), { start: 1000, end: 4000 });
		const one = stream([thinking("a")], { timestamp: 200 });
		clocks.observe("chat", one, 5000);
		clocks.observe("chat", stream([thinking("b")], { timestamp: 300 }), 7000);
		assert.deepEqual(clocks.get(key(one)), { start: 5000, end: 7000 });
	});

	it("keep each thinking block of one message apart", () => {
		const clocks = new ThinkingClocks();
		clocks.observe("chat", null, 0);
		const message = stream([thinking("first"), call, thinking("second")]);
		clocks.observe("chat", stream([thinking("first")]), 1000);
		clocks.observe("chat", message, 4000);
		assert.deepEqual(clocks.get(key(message, 0)), { start: 1000, end: 4000 });
		assert.deepEqual(clocks.get(key(message, 2)), { start: 4000 });
	});

	it("claim no time for a block the page did not watch: a snapshot taken mid-stream, or one first seen already passed over", () => {
		const clocks = new ThinkingClocks();
		const attached = stream([thinking("Already going")]);
		clocks.observe("chat", attached, 1000, true);
		assert.deepEqual(clocks.get(key(attached)), { start: null });
		clocks.observe("chat", stream([thinking("Already going"), text("Done")]), 5000);
		assert.deepEqual(clocks.get(key(attached)), { start: null, end: 5000 });
		const jumped = stream([thinking("Quick"), text("Answer")], { timestamp: 900 });
		clocks.observe("chat", jumped, 6000);
		assert.deepEqual(clocks.get(key(jumped)), { start: null, end: 6000 });
	});

	it("time a block that begins after a snapshot, even in the same message", () => {
		const clocks = new ThinkingClocks();
		clocks.observe("chat", stream([thinking("one")]), 1000, true);
		const later = stream([thinking("one"), call, thinking("two")]);
		clocks.observe("chat", later, 3000);
		assert.deepEqual(clocks.get(key(later, 0)), { start: null, end: 3000 });
		assert.deepEqual(clocks.get(key(later, 2)), { start: 3000 });
	});

	it("know nothing of a message that was never streamed here (history)", () => {
		const clocks = new ThinkingClocks();
		clocks.observe("chat", null, 1000);
		assert.equal(clocks.get(key(stream([thinking("Saved")]))), undefined);
	});

	it("keep conversations apart", () => {
		const clocks = new ThinkingClocks();
		clocks.observe("a", null, 0);
		clocks.observe("b", null, 0);
		const message = stream([thinking("x")]);
		clocks.observe("a", message, 1000);
		assert.equal(clocks.get(thinkingKey("b", message, 0)), undefined);
		assert.deepEqual(clocks.get(thinkingKey("a", message, 0)), { start: 1000 });
	});
});

describe("how long it thought", () => {
	it("words whole seconds like the TUI, at least one, and minutes from a minute on", () => {
		assert.deepEqual([0, 400, 1000, 1499, 12_400, 59_400, 60_000, 61_000, 125_000, 3_700_000].map(thoughtDuration), ["1s", "1s", "1s", "1s", "12s", "59s", "1m 00s", "1m 01s", "2m 05s", "1h 01m"]);
	});
});
