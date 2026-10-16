import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findFencedBlocks, type TextEdit } from "./code-fence.ts";
import { quoteKeyEdit, type QuoteKey } from "./quote-edits.ts";
import { findQuoteRuns } from "./quote-lines.ts";

const plain = (key: string, modifiers: Partial<QuoteKey> = {}): QuoteKey => ({ key, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...modifiers });

/** `|` marks the caret, `[` and `]` a selection; runs the key and shows the result the same way, or `null` when the key is left to the browser. */
function run(source: string, key: QuoteKey): string | null {
	const caret = source.indexOf("|");
	const text = caret >= 0 ? source.replace("|", "") : source.replace("[", "").replace("]", "");
	const start = caret >= 0 ? caret : source.indexOf("[");
	const end = caret >= 0 ? caret : source.indexOf("]") - 1;
	const edit: TextEdit | null = quoteKeyEdit(text, findQuoteRuns(text, findFencedBlocks(text)), key, start, end);
	if (edit === null) return null;
	const result = text.slice(0, edit.from) + edit.insert + text.slice(edit.to);
	return `${result.slice(0, edit.selectionStart)}|${result.slice(edit.selectionStart)}`.replace(/\|(?=.*\|)/s, "");
}

const shiftEnter = plain("Enter", { shiftKey: true });

describe("Shift+Enter on a quote line", () => {
	it("continues the quote with the whole prefix of the line, at any depth and indentation", () => {
		assert.equal(run("> a|b", shiftEnter), "> a\n> |b");
		assert.equal(run("> ab|", shiftEnter), "> ab\n> |");
		assert.equal(run("> > a|b", shiftEnter), "> > a\n> > |b");
		assert.equal(run("  > a|b", shiftEnter), "  > a\n  > |b");
		assert.equal(run(">a|b", shiftEnter), ">a\n>|b");
		assert.equal(run("x\n> a|b\ny", shiftEnter), "x\n> a\n> |b\ny");
	});

	it("replaces a selection by the line break and the prefix", () => {
		assert.equal(run("> a[bc]d", shiftEnter), "> a\n> |d");
	});

	it("does nothing special with the selection start inside the prefix", () => {
		assert.equal(run("|> a", shiftEnter), null);
		assert.equal(run(">| a", shiftEnter), null);
		assert.equal(run("> > |a", shiftEnter), "> > \n> > |a", "right after the prefix it still continues");
		assert.equal(run("> >| a", shiftEnter), null);
	});

	it("leaves the quote on a line that holds only its prefix, with the caret at its end", () => {
		assert.equal(run("> a\n> |", shiftEnter), "> a\n\n|");
		assert.equal(run("> a\n> > |", shiftEnter), "> a\n\n|");
		assert.equal(run("> a\n>  |", shiftEnter), "> a\n\n|", "blanks after the prefix are part of the empty line");
		assert.equal(run(">|", shiftEnter), "\n|");
		assert.equal(run("> | ", shiftEnter), "> \n> | ", "the caret not at the line's end continues instead");
	});

	it("is not ours on a line that is not a quote, in a fenced block, with another modifier or with Enter alone", () => {
		assert.equal(run("a|b", shiftEnter), null);
		assert.equal(run("```\n> a|b\n```", shiftEnter), null);
		assert.equal(run("> a|b", plain("Enter")), null);
		assert.equal(run("> a|b", plain("Enter", { shiftKey: true, ctrlKey: true })), null);
		assert.equal(run("> a|b", plain("Enter", { shiftKey: true, altKey: true })), null);
		assert.equal(run("> a|b", plain("Enter", { shiftKey: true, metaKey: true })), null);
		assert.equal(run("    > a|b", shiftEnter), null, "four blanks of indentation is not a quote line");
	});

	it("continues inside a fenced block nested in the quote without code keys", () => {
		assert.equal(run("> ```ts\n> a|b\n> ```", shiftEnter), "> ```ts\n> a\n> |b\n> ```");
	});
});

describe("Backspace right after the prefix", () => {
	it("removes one nesting level in one step", () => {
		assert.equal(run("> > |a", plain("Backspace")), "> |a");
		assert.equal(run("> > > |a", plain("Backspace")), "> > |a");
		assert.equal(run(">> |a", plain("Backspace")), "> |a");
		assert.equal(run("> |a", plain("Backspace")), "|a");
		assert.equal(run("> |", plain("Backspace")), "|");
		assert.equal(run("  > |a", plain("Backspace")), "|a", "the indentation goes with the prefix");
		assert.equal(run("x\n> |a", plain("Backspace")), "x\n|a");
	});

	it("is the browser's anywhere else: inside the prefix, in the text, with a selection or a modifier", () => {
		assert.equal(run(">| a", plain("Backspace")), null);
		assert.equal(run("> a|", plain("Backspace")), null);
		assert.equal(run("> [a]b", plain("Backspace")), null);
		assert.equal(run("> |a", plain("Backspace", { ctrlKey: true })), null);
		assert.equal(run("> |a", plain("Backspace", { shiftKey: true })), null);
		assert.equal(run("> |a", plain("Backspace", { altKey: true })), null);
		assert.equal(run("a|b", plain("Backspace")), null);
		assert.equal(run("```\n> |a\n```", plain("Backspace")), null);
	});
});

describe("Delete at the end of a quote line", () => {
	it("joins the next quote line as text, taking its whole prefix", () => {
		assert.equal(run("> a|\n> b", plain("Delete")), "> a|b");
		assert.equal(run("> a|\n> > b", plain("Delete")), "> a|b");
		assert.equal(run("> a|\n>b", plain("Delete")), "> a|b");
		assert.equal(run("> a|\n>\n> c", plain("Delete")), "> a|\n> c");
	});

	it("is the browser's when the next line is not a quote line, or the caret is not at the end, or the key is changed", () => {
		assert.equal(run("> a|\nb", plain("Delete")), null);
		assert.equal(run("> a|\n\n> b", plain("Delete")), null);
		assert.equal(run("> |a\n> b", plain("Delete")), null);
		assert.equal(run("> a|\n> b", plain("Delete", { ctrlKey: true })), null);
		assert.equal(run("> a|\n> b", plain("Delete", { shiftKey: true })), null);
		assert.equal(run("> a|", plain("Delete")), null);
	});
});

describe("other keys", () => {
	it("are not handled", () => {
		assert.equal(run("> a|b", plain("a")), null);
		assert.equal(run("> a|b", plain("Tab")), null);
	});
});
