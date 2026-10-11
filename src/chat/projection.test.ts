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
