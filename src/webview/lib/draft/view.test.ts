/**
 * `viewOf` (`view.ts`): what the composer draws and gates on, derived from the Draft and the caret.
 *
 * Runner: `node --test src/webview/lib/draft/view.test.ts`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { emptyDraft, withState, type DraftImage } from "./value.ts";
import { viewOf } from "./view.ts";

const image = (number: number): DraftImage => ({ id: number, name: `${number}.png`, mimeType: "image/png", bytes: 10, data: "AAA", number });
const held = (number: number, name: string) => ({ number, name, source: { kind: "held" as const, content: "text", label: null, bytes: 4 } });

describe("viewOf", () => {
	it("is empty and untouched for an empty draft", () => {
		const view = viewOf(emptyDraft(), 0);
		assert.deepEqual(view.images, []);
		assert.deepEqual(view.documents, []);
		assert.deepEqual(view.blocks, []);
		assert.equal(view.caretBlock, null);
		assert.equal(view.caretInQuote, false);
		assert.equal(view.hasContent, false);
		assert.equal(view.untouched, true);
	});

	it("has content for text beyond blanks, and none for blanks alone, which are still a touched draft", () => {
		assert.equal(viewOf(withState(emptyDraft(), { text: "hi" }), 2).hasContent, true);
		const blank = viewOf(withState(emptyDraft(), { text: " \n " }), 0);
		assert.equal(blank.hasContent, false);
		assert.equal(blank.untouched, false);
	});

	it("shows the attachments whose marker is in the text, in number order, and none for a marker without one", () => {
		const text = "[Image #2, 1x1] and [File #1: a.md] and [Image #5, 1x1]";
		const view = viewOf(withState(emptyDraft(), { text, images: [image(3), image(2)], documents: [held(1, "a.md"), held(2, "b.md")] }), 0);
		assert.deepEqual(view.images.map(entry => entry.number), [2], "#3 has no marker and #5 has no attachment");
		assert.deepEqual(view.documents.map(entry => entry.number), [1]);
		assert.equal(view.hasContent, true);
	});

	it("keeps the attachments of a deleted marker out of what is sent and out of the strip, but not out of the touched draft", () => {
		const view = viewOf(withState(emptyDraft(), { text: "", images: [image(1)], documents: [held(1, "a.md")] }), 0);
		assert.deepEqual(view.images, []);
		assert.deepEqual(view.documents, []);
		assert.equal(view.hasContent, false, "nothing to send");
		assert.equal(view.untouched, false, "Rewind does not open over a draft that Undo could bring back");
	});

	it("tells whether the caret is in a fenced block, whose keys are an editor's", () => {
		const text = "Look:\n```ts\nif (x) {\n```\nafter";
		const inside = viewOf(withState(emptyDraft(), { text }), text.indexOf("if"));
		assert.equal(inside.blocks.length, 1);
		assert.notEqual(inside.caretBlock, null);
		assert.equal(viewOf(withState(emptyDraft(), { text }), 2).caretBlock, null);
		assert.equal(viewOf(withState(emptyDraft(), { text }), text.length).caretBlock, null);
	});

	it("tells whether the caret is on a quote line, outside a fenced block", () => {
		const text = "> quoted\nmy comment";
		assert.equal(viewOf(withState(emptyDraft(), { text }), 3).caretInQuote, true);
		assert.equal(viewOf(withState(emptyDraft(), { text }), text.length).caretInQuote, false);
		const code = "```\n> not a quote\n```";
		assert.equal(viewOf(withState(emptyDraft(), { text: code }), 7).caretInQuote, false);
	});

	it("scans the text once while only the caret moves, and again when the text or an attachment list changes", () => {
		const draft = withState(emptyDraft(), { text: "> a\n```\nx\n```", images: [image(1)] });
		const first = viewOf(draft, 0);
		const moved = viewOf(draft, 5);
		assert.equal(moved.blocks, first.blocks);
		assert.equal(moved.quote, first.quote);
		assert.equal(moved.images, first.images);
		const typed = viewOf(withState(draft, { text: `${draft.text}!` }), 0);
		assert.notEqual(typed.blocks, first.blocks);
		const attached = viewOf(withState(draft, { images: [image(1), image(2)] }), 0);
		assert.notEqual(attached.images, first.images);
	});
});
