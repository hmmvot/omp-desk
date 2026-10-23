import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_CHAT_TEXT_LENGTH } from "../../../protocol/chat-messages.ts";
import { findFencedBlocks } from "../code-fence.ts";
import { neutraliseImageMarkers, placeQuote, quoteBlock, quoteLineCount, quoteTitle, removalRange } from "./quote-draft.ts";
import { findQuoteRuns } from "./quote-lines.ts";

/** The draft after a quote of `markdown` was appended, with the caret shown as `·`; `null` when it was refused. */
function quoted(text: string, markdown = "q"): string | null {
	const placed = placeQuote(text, quoteBlock(markdown));
	if (placed === null) return null;
	const next = text.slice(0, placed.from) + placed.insert + text.slice(placed.to);
	assert.equal(placed.caret, next.length, "the caret is the new end of the draft");
	assert.equal(placed.from, text.length);
	assert.equal(placed.to, text.length);
	return `${next}·`;
}

describe("the quote block", () => {
	it("prefixes each line with > and an empty line with a bare >", () => {
		assert.equal(quoteBlock("a\nb"), "> a\n> b");
		assert.equal(quoteBlock("a\n\nb"), "> a\n>\n> b");
		assert.equal(quoteBlock("a\r\nb\r\n"), "> a\n> b", "line endings are normalised and the trailing breaks go");
		assert.equal(quoteBlock("> already\nplain"), "> > already\n> plain", "a quoted reply's own > lines nest");
		assert.equal(quoteBlock("```ts\nconst x = 1;\n```"), "> ```ts\n> const x = 1;\n> ```");
		assert.equal(quoteLineCount("> a\n> b"), 2);
	});

	it("rewrites an image marker so it neither pairs with an attached image nor renders as one", () => {
		assert.equal(neutraliseImageMarkers("see [Image #1, 8x8] and [Image #12] but not [Image #0] or [image #3] or Image #4"), "see [image #1, 8x8] and [image #12] but not [Image #0] or [image #3] or Image #4");
		assert.equal(quoteBlock("[Image #1, 8x8]"), "> [image #1, 8x8]");
	});
});

describe("placing a quote at the end of the draft", () => {
	it("starts an empty draft with the quote and leaves the caret on the line under it", () => {
		assert.equal(quoted(""), "> q\n·");
	});

	it("puts a blank line between the text above and the quote, whatever the draft ends with", () => {
		assert.equal(quoted("foo"), "foo\n\n> q\n·");
		assert.equal(quoted("foo  "), "foo  \n\n> q\n·");
		assert.equal(quoted("foo\n  "), "foo\n  \n\n> q\n·", "the spaces are kept, so one more blank line appears");
		assert.equal(quoted("foo\n"), "foo\n\n> q\n·");
		assert.equal(quoted("foo\n\n"), "foo\n\n> q\n·", "the quote starts on the empty last line");
		assert.equal(quoted("\n\n"), "\n\n> q\n·");
		assert.equal(quoted("foo\n\n\n"), "foo\n\n\n> q\n·", "existing blank lines are never removed");
	});

	it("keeps two quotes two runs: a blank line separates them, with or without a comment between", () => {
		assert.equal(quoted("> a\n"), "> a\n\n> q\n·");
		assert.equal(quoted("> a"), "> a\n\n> q\n·");
		assert.equal(quoted("> a\ncomment\n"), "> a\ncomment\n\n> q\n·");
		const twice = quoted(quoted("")!.replace("·", ""), "second")!.replace("·", "");
		assert.equal(twice, "> q\n\n> second\n");
		assert.equal(findQuoteRuns(twice, findFencedBlocks(twice)).runs.length, 2);
	});

	it("closes an unclosed fenced block first, with a fence as long as the opening one", () => {
		assert.equal(quoted("```ts\nfoo"), "```ts\nfoo\n```\n\n> q\n·");
		assert.equal(quoted("```ts\nfoo\n"), "```ts\nfoo\n```\n\n> q\n·");
		assert.equal(quoted("intro\n````md\n```ts\nx\n```\n"), "intro\n````md\n```ts\nx\n```\n````\n\n> q\n·");
		assert.equal(quoted("```ts\nfoo\n```"), "```ts\nfoo\n```\n\n> q\n·", "a closed block is just text above");
	});

	it("refuses a quote that would take the draft past the length the host accepts", () => {
		assert.equal(placeQuote("x".repeat(MAX_CHAT_TEXT_LENGTH - 10), "> abcdefghij"), null);
		assert.notEqual(placeQuote("x".repeat(MAX_CHAT_TEXT_LENGTH - 20), "> a"), null);
		assert.equal(placeQuote("x".repeat(MAX_CHAT_TEXT_LENGTH), "> a"), null);
	});
});

describe("removing a quote", () => {
	const run = (text: string, index = 0) => findQuoteRuns(text, findFencedBlocks(text)).runs[index]!;

	it("takes the run and the one line break after it, not a comment under it nor the blank line above", () => {
		const text = "foo\n\n> q\ncomment";
		assert.deepEqual(removalRange(text, run(text)), { from: 5, to: 9 });
		assert.equal(text.slice(0, 5) + text.slice(9), "foo\n\ncomment");
	});

	it("takes the run alone when it ends the draft", () => {
		const text = "foo\n\n> q";
		assert.deepEqual(removalRange(text, run(text)), { from: 5, to: 8 });
	});

	it("takes a multi-line quote whole and leaves the other quote", () => {
		const text = "> a\n> b\n\n> c\n";
		assert.deepEqual(removalRange(text, run(text, 0)), { from: 0, to: 8 });
		assert.deepEqual(removalRange(text, run(text, 1)), { from: 9, to: 13 });
	});

	it("names the quote by its first words, without the prefixes", () => {
		const text = "> > nested start of the quote\n> second";
		assert.equal(quoteTitle(text, run(text)), "nested start of the quote");
		const long = `> ${"word ".repeat(20)}`;
		assert.equal(quoteTitle(long, run(long)), "word word word word word word word word…");
		const empty = ">\n> text";
		assert.equal(quoteTitle(empty, run(empty)), "text", "an empty first line is skipped");
		assert.equal(quoteTitle(">", run(">")), "empty quote");
	});
});

describe("several quotes in one placement (an editor's selections)", () => {
	it("joins the blocks with a blank line so they are separate quotes, placed as one edit with the caret under the last", () => {
		const block = ["a", "b\n\nc"].map(quoteBlock).join("\n\n");
		const placed = placeQuote("note", block)!;
		const next = "note" + placed.insert;
		assert.equal(next, "note\n\n> a\n\n> b\n>\n> c\n");
		assert.equal(placed.caret, next.length);
		assert.equal(findQuoteRuns(next, findFencedBlocks(next)).runs.length, 2, "two quotes, each with its own Remove button");
	});
});
