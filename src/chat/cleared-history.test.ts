import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChatEntry, ChatMessage } from "./messages.ts";
import { splitClearedHistory } from "./cleared-history.ts";
import { CLEAR_MARKER_TYPE } from "./clear.ts";
import { rewindTargets } from "./rewind.ts";

const base = (id: string) => ({ id, parentId: null, timestamp: "2026-10-11T00:00:00Z" });
const entry = (id: string, message: ChatMessage): ChatEntry => ({ ...base(id), type: "message", message });
const user = (id: string) => entry(id, { role: "user", timestamp: 1, content: id });
const assistant = (id: string) => entry(id, { role: "assistant", model: "m", timestamp: 2, stopReason: "stop", content: [{ type: "text", text: id }] });
const boundary = (id: string): ChatEntry => ({ ...base(id), type: "reset_boundary" });
const marker = (boundaryId: string): ChatEntry => ({ ...base(`m-${boundaryId}`), type: "custom", customType: CLEAR_MARKER_TYPE, data: { v: 1, requestId: "00112233445566778899aabbccddeeff", boundaryId } });

test("cleared history splits at the last boundary and counts only its user and assistant segment", () => {
	const entries: ChatEntry[] = [user("old-user"), assistant("old-answer"), boundary("first"), user("user"),
		entry("result", { role: "toolResult", timestamp: 3, toolCallId: "call", toolName: "read", isError: false, content: [] }),
		{ ...base("custom"), type: "custom", customType: "metadata" },
		entry("notice", { role: "custom", timestamp: 3, customType: "notice", display: true, content: "notice" }),
		assistant("answer"), boundary("last"), marker("last"), user("current")];
	const split = splitClearedHistory(entries, 50)!;
	assert.equal(split.boundary, entries[8]);
	assert.deepEqual(split.before, entries.slice(0, 8));
	assert.deepEqual(split.after, entries.slice(8));
	assert.equal(split.before.filter(entry => entry.type === "reset_boundary").length, 1, "earlier boundaries remain ordinary history");
	assert.equal(split.messages, 2);
	assert.equal(split.atLeast, false, "the preceding loaded boundary gives an exact segment count");
	assert.equal(split.summary, "Context cleared · 2 messages dropped");
});

test("cleared history reports at least only when the counted segment reaches unloaded history", () => {
	const entries = [user("user"), assistant("answer"), boundary("clear"), marker("clear")];
	assert.equal(splitClearedHistory(entries, 0)!.summary, "Context cleared · 2 messages dropped");
	const split = splitClearedHistory(entries, 10)!;
	assert.equal(split.atLeast, true);
	assert.equal(split.summary, "Context cleared · at least 2 messages dropped");
	assert.equal(splitClearedHistory([boundary("clear"), marker("clear")], 1)!.summary, "Context cleared · at least 0 messages dropped");
	assert.deepEqual(splitClearedHistory([boundary("clear"), marker("clear")], 0)!.before, []);
});

test("cleared history without a boundary leaves the transcript unchanged", () => {
	assert.equal(splitClearedHistory([], 0), null);
	assert.equal(splitClearedHistory([user("user"), assistant("answer")], 20), null);
	assert.equal(splitClearedHistory([user("user"), boundary("bare")], 0), null, "a failed/unknown live reset cannot hide the old history");
	assert.equal(splitClearedHistory([marker("later"), user("old"), boundary("later")], 0), null, "confirmation must follow the boundary");
	assert.deepEqual(rewindTargets([user("old"), boundary("clear"), marker("clear"), user("current")]).map(target => target.id), ["current"]);
});
