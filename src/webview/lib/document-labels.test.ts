/**
 * The words and the icon of an attachment tile (`document-labels.ts`): what a document looks like in the strip, never what its text is.
 *
 * Runner: `node --test src/webview/lib/document-labels.test.ts`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DraftDocument } from "./draft/draft.ts";
import { documentExtension, documentIcon, documentTooltip } from "./document-labels.ts";

function held(number: number, name: string, content: string, label: string | null = null): DraftDocument {
	return { number, name, source: { kind: "held", content, label, bytes: content.length } };
}

function linked(number: number, name: string, chars = 10): DraftDocument {
	return { number, name, source: { kind: "linked", ref: "AbCdEf012345", bytes: chars, chars } };
}

describe("icon, extension and tooltip", () => {
	it("chooses the codicon by extension, and a dotfile or a bare name has none", () => {
		assert.equal(documentIcon("README.MD"), "markdown");
		assert.equal(documentIcon("a.ts"), "file-code");
		assert.equal(documentIcon("a.txt"), "file");
		assert.equal(documentIcon("Makefile"), "file");
		assert.equal(documentIcon(".env"), "file");
		assert.equal(documentExtension("a.b.c"), "c");
		assert.equal(documentExtension("trailing."), "");
	});

	it("words the tooltip without file text", () => {
		assert.equal(documentTooltip(linked(1, "a")), "read from disk when sent");
		assert.equal(documentTooltip(held(1, "a", "secret", "docs/a.md")), "docs/a.md");
		assert.equal(documentTooltip(held(1, "a", "secret")), "no path: the text is held in the draft");
	});
});
