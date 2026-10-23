import assert from "node:assert/strict";
import { it } from "node:test";
import { parseChatEntry, parseChatMessage } from "./messages.ts";
import { projectTranscript } from "./transcript.ts";

const assistant = (content: unknown[]) => ({ role: "assistant", timestamp: 5, model: "m", provider: "p", stopReason: "stop", content });
const entry = (id: string, message: unknown) => ({ type: "message", id, parentId: null, timestamp: "2026-10-22T10:00:00.000Z", message });

it("shows a thinking block OMP marks as narration as answer text, as OMP's own surfaces do", () => {
	const parsed = parseChatMessage(assistant([
		{ type: "thinking", thinking: "Planning the change", thinkingSignature: "sig-a" },
		{ type: "thinking", thinking: "I found the cause; fixing it now.", thinkingSignature: "sig-b", narration: true },
		{ type: "thinking", thinking: "Not narration", narration: false },
	]));
	assert.ok(parsed?.role === "assistant");
	assert.deepEqual(parsed.content, [
		{ type: "thinking", thinking: "Planning the change", thinkingSignature: "sig-a" },
		{ type: "text", text: "I found the cause; fixing it now." },
		{ type: "thinking", thinking: "Not narration", narration: false },
	]);
});

it("keeps narration out of the reasoning card: a reply of narration alone is one answer card without a thinking block", () => {
	const parsed = parseChatEntry(entry("a1", assistant([{ type: "thinking", thinking: "Done: the file is fixed.", narration: true }])));
	assert.ok(parsed !== null);
	const cards = projectTranscript([parsed]);
	assert.equal(cards.length, 1);
	const card = cards[0]!;
	assert.ok(card.kind === "assistant");
	assert.deepEqual(card.content, [{ type: "text", text: "Done: the file is fixed." }]);
});

it("parses an already converted block again without change", () => {
	const once = parseChatMessage(assistant([{ type: "thinking", thinking: "Hello", narration: true }]));
	assert.ok(once?.role === "assistant");
	const twice = parseChatMessage(once);
	assert.ok(twice?.role === "assistant");
	assert.deepEqual(twice.content, once.content);
});
