import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChatEntry } from "./messages.ts";
import { positionTranscript } from "./projection.ts";
import { applyChatSnapshot, createChatModel, reduceChatFrame, snapshotOf } from "./model.ts";
import { assistantMessage, messageEntry, userMessage } from "../host/rpc/test-support.ts";

describe("positionTranscript with entries nobody positioned", () => {
	it("keeps a reset boundary and its marker after the row they follow when a later prompt was anchored before them", () => {
		const a2 = messageEntry("a2", null, assistantMessage("two", 2_000));
		const boundary: ChatEntry = { type: "reset_boundary", id: "b", parentId: "a2", timestamp: new Date(3_000).toISOString() };
		const marker = { type: "custom", id: "m", parentId: "b", timestamp: new Date(3_001).toISOString(), customType: "omp-desk/clear", data: {} } as ChatEntry;
		const q3 = messageEntry("q3", "m", userMessage("three", 4_000));
		const entries = [a2, boundary, marker, q3];
		const positions = new Map([["a2", { anchorId: null, seq: 1 }], ["q3", { anchorId: "a2", seq: 2 }]]);
		const shown = positionTranscript(entries, entries.length, new Map(), [], null, positions).map(entry => entry.id);
		assert.deepEqual(shown, ["a2", "b", "m", "q3"]);
	});

	it("keeps a reset boundary and its marker below the live turn they follow when the entry between them is not held", () => {
		// OMP writes model usage, a title change or a memory pass after a turn; the file reader returns none of them, so the
		// boundary's parent is not among the rows. Its turn was shown live (positioned); the boundary was not.
		const u2 = messageEntry("u2", null, userMessage("two", 2_000));
		const a2 = messageEntry("a2", "u2", assistantMessage("answer", 3_000));
		const boundary: ChatEntry = { type: "reset_boundary", id: "b", parentId: "usage-not-held", timestamp: new Date(4_000).toISOString() };
		const marker = { type: "custom", id: "m", parentId: "b", timestamp: new Date(4_001).toISOString(), customType: "omp-desk/clear", data: {} } as ChatEntry;
		const entries = [u2, a2, boundary, marker];
		const positions = new Map([["u2", { anchorId: null, seq: 1 }], ["a2", { anchorId: "u2", seq: 2 }]]);
		assert.deepEqual(positionTranscript(entries, entries.length, new Map(), [], null, positions).map(entry => entry.id), ["u2", "a2", "b", "m"]);
	});

	it("keeps older history above live rows and a row whose parent is not held below the live row before it", () => {
		const old = messageEntry("old", null, userMessage("old", 1_000));
		const older = messageEntry("older", "gone", assistantMessage("older answer", 1_500));
		const live = messageEntry("live", "older", userMessage("live", 2_000));
		const after = messageEntry("after", "also-gone", assistantMessage("after", 3_000));
		const entries = [old, older, live, after];
		const positions = new Map([["live", { anchorId: null, seq: 1 }]]);
		assert.deepEqual(positionTranscript(entries, entries.length, new Map(), [], null, positions).map(entry => entry.id), ["old", "older", "live", "after"]);
	});

	it("leaves entries without any positions in file order", () => {
		const entries = [messageEntry("u", null, userMessage("one", 1_000)), messageEntry("a", "u", assistantMessage("two", 2_000))];
		assert.deepEqual(positionTranscript(entries, 2, new Map(), []).map(entry => entry.id), ["u", "a"]);
	});
});

it("model-derived TODO stays empty after a boundary instead of falling back to the previous seed", () => {
	const boundary: ChatEntry = { type: "reset_boundary", id: "boundary", parentId: null, timestamp: new Date(1).toISOString() };
	const model = { ...createChatModel(), entries: [boundary], durableCount: 1, leafId: "boundary", todoSeed: [{ name: "Old", tasks: [{ content: "earlier work", status: "pending" }] }] };
	const next = reduceChatFrame(model, { type: "message_end", messageId: "new", message: userMessage("new context", 2) });
	assert.deepEqual(next.todo?.phases, []);
});

it("snapshot carries only host-known incomplete Desk clear provenance", () => {
	const epoch = { nonce: "attach", counter: 1 };
	const model = { ...createChatModel(), unconfirmedClearBoundaryId: "own-incomplete-boundary" };
	const snapshot = snapshotOf(model, epoch);
	assert.equal(applyChatSnapshot(createChatModel(), snapshot).unconfirmedClearBoundaryId, "own-incomplete-boundary");
	const { unconfirmedClearBoundaryId: _oldAttach, ...unknownOrigin } = snapshot;
	assert.equal(applyChatSnapshot(model, unknownOrigin).unconfirmedClearBoundaryId, null, "absent provenance is not inferred from a markerless boundary");
});
