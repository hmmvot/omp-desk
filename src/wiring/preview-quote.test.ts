/**
 * The quote of a Markdown preview's selection: which file a preview tab shows and the location line of the quote.
 *
 * Runner: `node --test src/wiring/preview-quote.test.ts`
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { composePreviewQuote, fallbackName, resolvePreviewFile } from "./preview-quote.ts";

const CWD = "D:\\Work\\Repo";

describe("the file a preview tab shows", () => {
	const chat = "D:\\Work\\Repo\\docs\\guide\\chat.md";
	const other = "D:\\Work\\Repo\\notes\\chat.md";

	it("is the one candidate whose file name ends the label, in any language of the label", () => {
		assert.equal(resolvePreviewFile("[Preview] chat.md", [chat, "D:\\Work\\Repo\\README.md"]), chat);
		assert.equal(resolvePreviewFile("Просмотр chat.md", [chat]), chat);
		assert.equal(resolvePreviewFile("Preview my notes.md", ["D:\\Work\\Repo\\my notes.md"]), "D:\\Work\\Repo\\my notes.md");
	});

	it("counts one file once however many open documents or workspace hits name it", () => {
		assert.equal(resolvePreviewFile("Preview chat.md", [chat, chat]), chat);
	});

	it("is null when no candidate or several different ones match, and a name that is only the end of another name does not match", () => {
		assert.equal(resolvePreviewFile("Preview chat.md", []), null);
		assert.equal(resolvePreviewFile("Preview chat.md", [chat, other]), null);
		assert.equal(resolvePreviewFile("Preview chat.md", ["D:\\Work\\Repo\\subchat.md"]), null);
	});

	it("falls back to the last word of the label", () => {
		assert.equal(fallbackName("Preview chat.md"), "chat.md");
		assert.equal(fallbackName("chat.md"), "chat.md");
	});
});

describe("the quote of a preview selection", () => {
	const document = { fsPath: "D:\\Work\\Repo\\docs\\guide\\chat.md", name: "chat.md" };

	it("is the rendered text under the relative path, with no line numbers", () => {
		const composed = composePreviewQuote(document, "Press Alt+Q.\r\nThen type.\r\n", CWD);
		assert.deepEqual(composed, {
			ok: true,
			quotes: [{ location: "docs/guide/chat.md", fileName: "chat.md", languageId: "markdown", text: "Press Alt+Q.\nThen type." }],
			summary: "docs/guide/chat.md",
		});
	});

	it("names a file outside the session's folder by its full path", () => {
		const composed = composePreviewQuote(document, "x", "D:\\Elsewhere");
		assert.equal(composed.ok && composed.quotes[0]?.location, "D:/Work/Repo/docs/guide/chat.md");
	});

	it("names the document by its name alone when no file was found", () => {
		const composed = composePreviewQuote({ fsPath: null, name: "chat.md" }, "x", CWD);
		assert.equal(composed.ok && composed.quotes[0]?.location, "chat.md");
	});

	it("refuses an empty or whitespace selection, a control character and an oversize selection", () => {
		assert.deepEqual(composePreviewQuote(document, " \n\t ", CWD), { ok: false, reason: "Select some text in the preview first." });
		assert.equal(composePreviewQuote(document, "a\u0007b", CWD).ok, false);
		assert.equal(composePreviewQuote(document, "a".repeat(200_000), CWD).ok, false);
	});
});
