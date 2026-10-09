/** The composer's ↑/↓ prompt history. Runner: `node --test src/webview/lib/prompt-history.test.ts`. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChatEntry } from "../../chat/messages.ts";
import { historyStep, sessionPrompts, type HistoryCursor } from "./prompt-history.ts";

const user = (id: string, content: unknown, extra: Record<string, unknown> = {}): ChatEntry =>
	({ type: "message", id, parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content, timestamp: 1, ...extra } }) as unknown as ChatEntry;
const assistant = (id: string): ChatEntry =>
	({ type: "message", id, parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "assistant", content: [{ type: "text", text: "reply" }], timestamp: 1 } }) as unknown as ChatEntry;

describe("prompt history", () => {
	it("lists the user's prompts oldest first, once per immediate repeat, without synthetic or image-only ones", () => {
		const entries = [
			user("1", "first"), assistant("a"), user("2", [{ type: "text", text: "second" }, { type: "image", mimeType: "image/png", data: "x" }]),
			user("3", "second"), user("4", [{ type: "image", mimeType: "image/png", data: "x" }]), user("5", "hidden", { synthetic: true }), user("6", "third\nline"),
		];
		assert.deepEqual(sessionPrompts(entries), ["first", "second", "third\nline"]);
	});

	it("walks back from an empty draft and forward to the draft it started from", () => {
		const list = ["one", "two", "three"];
		let cursor: HistoryCursor | null = null;
		let text = "";
		const step = (direction: "older" | "newer") => {
			const next = historyStep(list, cursor, direction, text);
			if (next === null) return false;
			({ cursor, text } = next);
			return true;
		};
		assert.equal(step("newer"), false, "↓ without a walk is the caret's");
		assert.equal(step("older"), true); assert.equal(text, "three");
		assert.equal(step("older"), true); assert.equal(text, "two");
		assert.equal(step("older"), true); assert.equal(text, "one");
		assert.equal(step("older"), false, "the oldest prompt ends the walk back");
		assert.equal(step("newer"), true); assert.equal(text, "two");
		assert.equal(step("newer"), true); assert.equal(text, "three");
		assert.equal(step("newer"), true); assert.equal(text, "", "past the newest, the original draft returns");
		assert.equal(cursor, null);
	});

	it("never replaces a draft the user typed or a recalled prompt the user edited", () => {
		assert.equal(historyStep(["one"], null, "older", "my draft"), null);
		const recalled = historyStep(["one", "two"], null, "older", "   ");
		assert.ok(recalled !== null);
		assert.equal(historyStep(["one", "two"], recalled.cursor, "older", `${recalled.text} edited`), null);
		assert.equal(historyStep(["one", "two"], recalled.cursor, "newer", `${recalled.text} edited`), null);
		assert.deepEqual(historyStep(["one", "two"], recalled.cursor, "newer", recalled.text), { text: "   ", cursor: null }, "a whitespace draft is restored as it was");
		assert.equal(historyStep([], null, "older", ""), null);
	});
});
