/**
 * The Markdown of a quote taken from a text editor: its location, then the text as code or as prose.
 *
 * Runner: `node --test src/webview/lib/editor-quote.test.ts`
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { GuestEditorQuote } from "../../protocol/messages.ts";
import { codeSpan, editorQuoteMarkdown, editorQuoteRequest } from "./editor-quote.ts";
import { quoteBlock } from "./quote-draft.ts";

const quote = (over: Partial<GuestEditorQuote> = {}): GuestEditorQuote => ({ location: "src/app.ts:42-43", fileName: "app.ts", languageId: "typescript", text: "const x = 1;\nconst y = 2;", ...over });

describe("a code file's quote", () => {
	it("is the location as inline code, then the text in a fence named by the file's language", () => {
		assert.equal(editorQuoteMarkdown(quote()), "`src/app.ts:42-43`\n```ts\nconst x = 1;\nconst y = 2;\n```");
		assert.equal(quoteBlock(editorQuoteMarkdown(quote({ text: "const x = 1;" }))), "> `src/app.ts:42-43`\n> ```ts\n> const x = 1;\n> ```");
	});

	it("uses the editor's language id when the file name says nothing, and no info string when neither is known", () => {
		assert.equal(editorQuoteMarkdown(quote({ fileName: "data.zzz", languageId: "javascript", text: "a" })), "`src/app.ts:42-43`\n```js\na\n```");
		assert.equal(editorQuoteMarkdown(quote({ fileName: "data.zzz", languageId: "zzzlang", text: "a" })), "`src/app.ts:42-43`\n```\na\n```");
	});

	it("fences with one backtick more than the longest run in the text, never fewer than three", () => {
		assert.equal(editorQuoteMarkdown(quote({ text: "a ``` b" })), "`src/app.ts:42-43`\n```ts\na ``` b\n```", "a fence in the middle of a line cannot close the block");
		assert.equal(editorQuoteMarkdown(quote({ text: "```\nx" })), "`src/app.ts:42-43`\n````ts\n```\nx\n````");
		assert.equal(editorQuoteMarkdown(quote({ text: "`````\nx" })), "`src/app.ts:42-43`\n``````ts\n`````\nx\n``````");
	});

	it("quotes a document with no location without one", () => {
		assert.equal(editorQuoteMarkdown(quote({ location: null, fileName: "", languageId: "javascript", text: "f()" })), "```js\nf()\n```");
	});
});

describe("a Markdown or plain-text file's quote", () => {
	it("is plain quote lines with no fence, set apart from the location by an empty line", () => {
		const markdown = editorQuoteMarkdown(quote({ location: "docs/a.md:3", fileName: "a.md", languageId: "markdown", text: "# Title\n\nbody" }));
		assert.equal(markdown, "`docs/a.md:3`\n\n# Title\n\nbody");
		assert.equal(quoteBlock(markdown), "> `docs/a.md:3`\n>\n> # Title\n>\n> body");
		assert.equal(editorQuoteMarkdown(quote({ location: "n.txt:1", fileName: "n.txt", languageId: "plaintext", text: "hello" })), "`n.txt:1`\n\nhello");
		assert.equal(editorQuoteMarkdown(quote({ location: null, fileName: "", languageId: "plaintext", text: "hello" })), "hello");
	});
});

describe("the location as inline code", () => {
	it("is longer-delimited than any backtick run in the path, padded when the path starts or ends with one", () => {
		assert.equal(codeSpan("src/a.ts:1"), "`src/a.ts:1`");
		assert.equal(codeSpan("src/a`b.ts:1"), "``src/a`b.ts:1``");
		assert.equal(codeSpan("`a.ts:1"), "`` `a.ts:1 ``");
	});
});

describe("the request that places the quotes", () => {
	it("carries one Markdown per selection and the size of the selected text", () => {
		const request = editorQuoteRequest([quote({ text: "aa" }), quote({ text: "bbb" })]);
		assert.equal(request.kind, "editor");
		if (request.kind !== "editor") return;
		assert.equal(request.sources.length, 2);
		assert.equal(request.size, 5);
	});
});
