/**
 * Tests for the managed-rpc broker's line ring and its paced subscribers.
 *
 * Runner: `node --test src/broker/rpc-ring.test.ts`
 *
 * What matters here: the ring keeps exactly what a reattaching client needs to rebuild an
 * in-flight turn — the newest `message_update` of each open message, every unanswered dialog,
 * the open skeleton — no matter how much unrelated traffic follows, while answered or ended
 * things stop being replayed; and delivery to a consumer is one paced cursor for replay and
 * live lines that never lets a queue grow past its bound and never delivers a line twice.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PTY_RPC_FRAGMENT_RAW_BYTES } from "../host/pty-protocol.ts";
import {
	DEFAULT_RPC_RING_LIMITS,
	RPC_PACE_BYTES,
	RPC_RETAINED_RESPONSE_MAX_BYTES,
	RpcLineRing,
	RpcSubscriber,
	peekRpcLine,
	type RpcRingEntry,
	type RpcSink,
} from "./rpc-ring.ts";

const update = (messageId: string, text: string): string =>
	JSON.stringify({ type: "message_update", message: { role: "assistant", content: text }, messageId });
const start = (messageId: string): string => JSON.stringify({ type: "message_start", message: { role: "assistant" }, messageId });
const end = (messageId: string): string => JSON.stringify({ type: "message_end", message: { role: "assistant" }, messageId });
const toolStart = (toolCallId: string, args = "{}"): string =>
	JSON.stringify({ type: "tool_execution_start", toolCallId, toolName: "bash", args });
const toolEnd = (toolCallId: string): string => JSON.stringify({ type: "tool_execution_end", toolCallId, result: "ok" });
const dialog = (id: string, method = "select"): string =>
	JSON.stringify({ type: "extension_ui_request", id, method, title: "Approve?", options: ["Approve", "Deny"] });
const cancel = (targetId: string): string =>
	JSON.stringify({ type: "extension_ui_request", id: "cancel-1", method: "cancel", targetId });
const filler = (index: number, bytes = 16 * 1024): string =>
	JSON.stringify({ type: "tool_execution_update", n: index, pad: "x".repeat(bytes) });

/** The lines a replay from `since` would show, as text. */
function replayed(ring: RpcLineRing, since = 0): string[] {
	return ring.replay(since).entries.map(entry => entry.bytes.toString("utf8"));
}

const includesType = (lines: readonly string[], type: string, needle = ""): boolean =>
	lines.some(line => peekRpcLine(line).type === type && line.includes(needle));

describe("retention rules", () => {
	it("keeps only the newest update of an open message, and none once it ended", () => {
		const ring = new RpcLineRing();
		ring.append(start("msg-1"));
		ring.append(update("msg-1", "he"));
		ring.append(update("msg-1", "hel"));
		ring.append(update("msg-2", "other"));
		ring.append(update("msg-1", "hello"));
		const open = replayed(ring);
		assert.equal(open.filter(line => peekRpcLine(line).type === "message_update").length, 2);
		assert.equal(includesType(open, "message_update", '"hello"'), true);
		assert.equal(includesType(open, "message_update", '"hel"'), false);
		assert.equal(includesType(open, "message_update", '"other"'), true);

		ring.append(end("msg-1"));
		const closed = replayed(ring);
		assert.equal(includesType(closed, "message_update", '"hello"'), false, "an ended message's update is dropped");
		assert.equal(includesType(closed, "message_update", '"other"'), true, "another message is untouched");
		assert.equal(includesType(closed, "message_end"), true);
		// Superseded lines stop counting against the ring, so a long reply cannot fill it.
		assert.equal(ring.stats().lines, closed.length);
	});

	it("retains a line it cannot classify rather than dropping it", () => {
		const ring = new RpcLineRing();
		ring.append("not json at all");
		ring.append('{"type":"something_new","x":1}');
		ring.append('{"type":"message_update","message":{}}');
		assert.equal(replayed(ring).length, 3, "a message_update without a messageId tail is kept as it is");
	});

	it("treats responses and chunks as live-only, except a small vsc: response", () => {
		const ring = new RpcLineRing();
		ring.setConsumers(1);
		const ordinary = ring.append(JSON.stringify({ id: "int:1", type: "response", command: "get_state", success: true }));
		const refusal = ring.append(JSON.stringify({ id: "vsc:7", type: "response", command: "prompt", success: false }));
		const big = ring.append(
			JSON.stringify({ id: "vsc:8", type: "response", command: "prompt", success: false, pad: "x".repeat(RPC_RETAINED_RESPONSE_MAX_BYTES) }),
		);
		const chunk = ring.append(JSON.stringify({ type: "rpc_chunk", chunkId: "rpc-1", index: 0, count: 2 }));
		assert.ok(ordinary !== null && refusal !== null && big !== null && chunk !== null, "a consumer is shown live-only lines");
		const lines = replayed(ring);
		assert.equal(lines.length, 1);
		assert.match(lines[0] ?? "", /"vsc:7"/);
	});

	it("stores nothing for a live-only line when nobody reads the ring", () => {
		const ring = new RpcLineRing();
		assert.equal(ring.append(JSON.stringify({ id: "int:1", type: "response", command: "x", success: true })), null);
		assert.equal(ring.stats().lines, 0);
		// The seq is still consumed: gaps are normal and carry no meaning.
		assert.equal(ring.latestSeq, 1);
	});

	it("bounds the ring by lines and by bytes, evicting whole oldest lines and reporting truncation", () => {
		const ring = new RpcLineRing();
		for (let index = 0; index < DEFAULT_RPC_RING_LIMITS.maxLines + 10; index += 1) ring.append(filler(index, 8));
		assert.equal(ring.stats().lines, DEFAULT_RPC_RING_LIMITS.maxLines);
		const byLines = ring.replay(0);
		assert.equal(byLines.entries.length, DEFAULT_RPC_RING_LIMITS.maxLines);
		assert.equal(byLines.truncated, true);
		assert.equal(ring.oldestSeq(), byLines.entries[0]?.seq);

		const bytes = new RpcLineRing();
		for (let index = 0; index < 400; index += 1) bytes.append(filler(index, 32 * 1024));
		assert.ok(bytes.stats().bytes <= DEFAULT_RPC_RING_LIMITS.maxBytes);
		assert.ok(bytes.stats().lines < 400);
		// Asking from a position that is still retained is not a truncation.
		const from = bytes.replay(bytes.oldestSeq() - 1);
		assert.equal(from.truncated, false);
	});
});

describe("pinned dialogs", () => {
	it("keeps an unanswered approval through more than a full ring of other traffic", () => {
		const ring = new RpcLineRing();
		ring.append(start("msg-1"));
		const pinned = ring.append(dialog("ui-1"));
		for (let index = 0; index < 600; index += 1) ring.append(filler(index));
		assert.equal(ring.stats().bytes <= DEFAULT_RPC_RING_LIMITS.maxBytes, true);
		const result = ring.replay(0);
		assert.equal(result.truncated, true, "the older ordinary lines are gone");
		const lines = result.entries.map(entry => entry.bytes.toString("utf8"));
		assert.equal(includesType(lines, "extension_ui_request", '"ui-1"'), true, "the pending approval survives");
		assert.equal(pinned !== null && ring.oldestSeq() <= pinned.seq, true);
		// Replay is in seq order even where a pinned line sits before the ring's oldest.
		const seqs = result.entries.map(entry => entry.seq);
		assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
	});

	it("stops replaying a dialog once its answer was forwarded, or once it was cancelled", () => {
		const ring = new RpcLineRing();
		ring.append(dialog("ui-1"));
		ring.append(dialog("ui-2", "confirm"));
		ring.append(dialog("ui-3", "input"));
		assert.equal(ring.releaseDialog("ui-1"), true);
		assert.equal(ring.releaseDialog("ui-1"), false, "an answer is released once");
		ring.append(cancel("ui-2"));
		const lines = replayed(ring);
		// The cancel line itself names the target, so match on the request's own `id`.
		assert.equal(includesType(lines, "extension_ui_request", '"id":"ui-1"'), false, "an answered request is never replayed");
		assert.equal(includesType(lines, "extension_ui_request", '"id":"ui-2"'), false, "a cancelled request is never replayed");
		assert.equal(includesType(lines, "extension_ui_request", '"id":"ui-3"'), true);
		assert.equal(ring.stats().dialogs, 1);
	});

	it("pins a multi-question ask like any other dialog until it is answered", () => {
		const ring = new RpcLineRing();
		ring.append(JSON.stringify({ type: "extension_ui_request", id: "ask-1", method: "ask", questions: [{ id: "q", question: "Pick?", options: [{ label: "A" }] }] }));
		assert.equal(ring.stats().dialogs, 1);
		for (let index = 0; index < 600; index += 1) ring.append(filler(index));
		assert.equal(includesType(replayed(ring), "extension_ui_request", '"id":"ask-1"'), true, "the pending ask survives eviction");
		assert.equal(ring.releaseDialog("ask-1"), true);
		assert.equal(ring.stats().dialogs, 0);
	});

	it("does not pin fire-and-forget presentation requests, which are never answered", () => {
		const ring = new RpcLineRing();
		ring.append(JSON.stringify({ type: "extension_ui_request", id: "n-1", method: "notify", message: "hi" }));
		ring.append(JSON.stringify({ type: "extension_ui_request", id: "w-1", method: "setWidget", widgetKey: "k" }));
		assert.equal(ring.stats().dialogs, 0);
		for (let index = 0; index < 600; index += 1) ring.append(filler(index));
		assert.equal(includesType(replayed(ring), "extension_ui_request"), false);
	});

	it("never evicts a dialog past its budget: it reports the overflow instead", () => {
		const ring = new RpcLineRing();
		const budget = DEFAULT_RPC_RING_LIMITS.dialogMaxLines;
		for (let index = 0; index < budget + 5; index += 1) ring.append(dialog(`ui-${index}`));
		assert.equal(ring.pinnedOverflow, true);
		for (let index = 0; index < 600; index += 1) ring.append(filler(index));
		const kept = replayed(ring).filter(line => peekRpcLine(line).type === "extension_ui_request");
		assert.equal(kept.length, budget + 5, "every unanswered request is still there");
		for (let index = 0; index < 10; index += 1) ring.releaseDialog(`ui-${index}`);
		assert.equal(ring.pinnedOverflow, false);
	});
});

describe("pinned skeleton", () => {
	it("keeps an open message and tool start through a flood, and releases them at their end frames", () => {
		const ring = new RpcLineRing();
		ring.append(start("msg-1"));
		ring.append(toolStart("call-1"));
		for (let index = 0; index < 600; index += 1) ring.append(filler(index));
		let lines = replayed(ring);
		assert.equal(includesType(lines, "message_start", '"msg-1"'), true);
		assert.equal(includesType(lines, "tool_execution_start", '"call-1"'), true);

		ring.append(toolEnd("call-1"));
		ring.append(end("msg-1"));
		assert.equal(ring.stats().skeleton, 0);
		for (let index = 0; index < 600; index += 1) ring.append(filler(index));
		lines = replayed(ring);
		assert.equal(includesType(lines, "message_start"), false, "an ended message's start is no longer pinned");
		assert.equal(includesType(lines, "tool_execution_start"), false);
	});

	it("gives a start line above 64 KiB ordinary retention only", () => {
		const ring = new RpcLineRing();
		ring.append(toolStart("call-big", "x".repeat(DEFAULT_RPC_RING_LIMITS.skeletonLineMaxBytes + 1)));
		assert.equal(ring.stats().skeleton, 0);
		for (let index = 0; index < 600; index += 1) ring.append(filler(index));
		assert.equal(includesType(replayed(ring), "tool_execution_start"), false);
	});
});

describe("replay from a cursor", () => {
	it("replays only what follows the cursor, and says when the cursor is not this child's", () => {
		const ring = new RpcLineRing();
		const first = ring.append(start("msg-1"));
		ring.append(update("msg-1", "a"));
		ring.append(toolStart("call-1"));
		const from = first?.seq ?? 0;
		const later = ring.replay(from);
		assert.equal(later.fromSeq, from);
		assert.equal(later.truncated, false);
		assert.deepEqual(
			later.entries.map(entry => peekRpcLine(entry.bytes.toString("utf8")).type),
			["message_update", "tool_execution_start"],
		);
		assert.equal(ring.replay(ring.latestSeq).entries.length, 0);
		const foreign = ring.replay(ring.latestSeq + 50);
		assert.equal(foreign.truncated, true, "a cursor from another broker generation is not continuous");
		assert.equal(foreign.fromSeq, 0);
		assert.equal(foreign.entries.length, 3);
	});
});

/** A sink that records fragments and lets a test set its queue depth. */
class FakeSink implements RpcSink {
	closed = false;
	closeReason: string | null = null;
	pendingBytes = 0;
	readonly sent: Array<{ seq: number; index: number; count: number; data: string }> = [];

	sendFragment(seq: number, index: number, count: number, data: string): void {
		this.sent.push({ seq, index, count, data });
	}

	close(reason: string): void {
		this.closed = true;
		this.closeReason = reason;
	}

	/** Completed lines in delivery order, reassembled from their fragments. */
	lines(): Array<{ seq: number; text: string }> {
		const out: Array<{ seq: number; text: string }> = [];
		let parts: Buffer[] = [];
		for (const fragment of this.sent) {
			assert.equal(fragment.index, parts.length, "fragments of a line are contiguous and in order");
			parts.push(Buffer.from(fragment.data, "base64"));
			if (fragment.index + 1 === fragment.count) {
				out.push({ seq: fragment.seq, text: Buffer.concat(parts).toString("utf8") });
				parts = [];
			}
		}
		return out;
	}
}

function subscribe(ring: RpcLineRing, sink: FakeSink, since: number): RpcSubscriber {
	ring.setConsumers(1);
	const replay = ring.replay(since);
	return new RpcSubscriber(ring, sink, replay.entries, ring.latestSeq);
}

describe("paced subscriber", () => {
	it("delivers replay first and then live lines, each exactly once and in order", () => {
		const ring = new RpcLineRing();
		ring.append(start("msg-1"));
		ring.append(update("msg-1", "old"));
		const sink = new FakeSink();
		const subscriber = subscribe(ring, sink, 0);
		ring.append(update("msg-1", "newer"));
		ring.append(toolStart("call-1"));
		assert.equal(subscriber.pump(), true);
		assert.equal(subscriber.pump(), true, "a second pump has nothing more to send");
		const texts = sink.lines().map(line => line.text);
		assert.equal(texts.length, 3);
		// The replayed update was superseded before it was sent: only the newest is ever shown.
		assert.deepEqual(
			texts.map(text => peekRpcLine(text).type),
			["message_start", "message_update", "tool_execution_start"],
		);
		assert.match(texts[1] ?? "", /"newer"/);
		const seqs = sink.lines().map(line => line.seq);
		assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
		assert.equal(new Set(seqs).size, seqs.length);
	});

	it("skips a live update that a newer one superseded before the consumer's turn", () => {
		const ring = new RpcLineRing();
		const sink = new FakeSink();
		const subscriber = subscribe(ring, sink, 0);
		ring.append(update("msg-1", "a"));
		ring.append(update("msg-1", "ab"));
		ring.append(update("msg-1", "abc"));
		subscriber.pump();
		assert.equal(sink.lines().length, 1);
		assert.match(sink.lines()[0]?.text ?? "", /"abc"/);
	});

	it("stops at the pacing bound and resumes when the queue drains", () => {
		const ring = new RpcLineRing();
		const sink = new FakeSink();
		const subscriber = subscribe(ring, sink, 0);
		ring.append(filler(1));
		ring.append(filler(2));
		sink.pendingBytes = RPC_PACE_BYTES;
		assert.equal(subscriber.pump(), false, "paced: not idle, nothing sent");
		assert.equal(sink.sent.length, 0);
		sink.pendingBytes = 0;
		assert.equal(subscriber.pump(), true);
		assert.equal(sink.lines().length, 2);
	});

	it("sends a multi-fragment line one fragment at a time under pacing", () => {
		const ring = new RpcLineRing();
		const sink = new FakeSink();
		const subscriber = subscribe(ring, sink, 0);
		const big = filler(1, PTY_RPC_FRAGMENT_RAW_BYTES * 3);
		ring.append(big);
		const sentBefore = 1;
		const original = sink.sendFragment.bind(sink);
		sink.sendFragment = (seq, index, count, data) => {
			original(seq, index, count, data);
			// After the first fragment the queue is over the bound: the rest must wait for a drain.
			if (index === 0) sink.pendingBytes = RPC_PACE_BYTES;
		};
		assert.equal(subscriber.pump(), false);
		assert.equal(sink.sent.length, sentBefore, "one fragment went out before the queue filled");
		sink.pendingBytes = 0;
		sink.sendFragment = original;
		assert.equal(subscriber.pump(), true);
		assert.ok(sink.sent.length > sentBefore);
		assert.equal(sink.lines()[0]?.text, big);
	});

	it("disconnects a consumer whose cursor fell behind eviction, so it reattaches with its last seq", () => {
		const ring = new RpcLineRing();
		const sink = new FakeSink();
		const subscriber = subscribe(ring, sink, 0);
		for (let index = 0; index < DEFAULT_RPC_RING_LIMITS.maxLines + 50; index += 1) ring.append(filler(index, 8));
		subscriber.pump();
		assert.equal(sink.closed, true);
		assert.match(sink.closeReason ?? "", /reattach/);
	});

	it("releases live-only lines once every consumer has passed them", () => {
		const ring = new RpcLineRing();
		const sink = new FakeSink();
		const subscriber = subscribe(ring, sink, 0);
		for (let index = 0; index < 5; index += 1) {
			ring.append(JSON.stringify({ id: `int:${index}`, type: "response", command: "get_entries", success: true }));
		}
		assert.equal(ring.stats().lines, 5);
		subscriber.pump();
		ring.dropTransientsThrough(subscriber.cursor);
		assert.equal(sink.lines().length, 5, "a consumer attached now gets each response");
		assert.equal(ring.stats().lines, 0, "and the ring does not keep them");
	});

	it("keeps a pinned dialog replayable to a consumer that attaches after a flood", () => {
		const ring = new RpcLineRing();
		ring.append(dialog("ui-1"));
		for (let index = 0; index < 600; index += 1) ring.append(filler(index));
		const sink = new FakeSink();
		const subscriber = subscribe(ring, sink, 0);
		assert.equal(subscriber.pump(), true);
		const first: RpcRingEntry | undefined = ring.replay(0).entries[0];
		assert.equal(includesType(sink.lines().map(line => line.text), "extension_ui_request", '"ui-1"'), true);
		assert.equal(first?.pinned, "dialog");
	});
});
