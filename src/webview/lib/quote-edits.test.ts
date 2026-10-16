import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findFencedBlocks, type TextEdit } from "./code-fence.ts";
import { quoteKeyEdit, quotePasteEdit, type QuoteKey } from "./quote-edits.ts";
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

/** The draft after pasting `pasted` at `|` (or over `[` `]`), with the caret shown as `|`; `null` when the paste is the plain one. */
function paste(source: string, pasted: string): string | null {
	const caret = source.indexOf("|");
	const text = caret >= 0 ? source.replace("|", "") : source.replace("[", "").replace("]", "");
	const start = caret >= 0 ? caret : source.indexOf("[");
	const end = caret >= 0 ? caret : source.indexOf("]") - 1;
	const edit = quotePasteEdit(text, findQuoteRuns(text, findFencedBlocks(text)), pasted, start, end);
	if (edit === null) return null;
	const result = text.slice(0, edit.from) + edit.insert + text.slice(edit.to);
	return `${result.slice(0, edit.selectionStart)}|${result.slice(edit.selectionStart)}`;
}

describe("pasting several lines into a quote line", () => {
	it("keeps every pasted line in the quote, the first at the caret and each later one under the line's prefix", () => {
		assert.equal(paste("> |", "one\ntwo\nthree"), "> one\n> two\n> three|");
		assert.equal(paste("> a|b", "x\ny"), "> ax\n> y|b");
	});

	it("repeats the whole prefix: nested levels, indentation and a prefix without a blank", () => {
		assert.equal(paste("> > |", "one\ntwo"), "> > one\n> > two|");
		assert.equal(paste("  > |", "one\ntwo"), "  > one\n  > two|");
		assert.equal(paste(">|a", "x\ny"), ">x\n>y|a");
	});

	it("makes an empty pasted line a bare prefix without its trailing blank, as the capture does", () => {
		assert.equal(paste("> > |", "one\n\ntwo"), "> > one\n> >\n> > two|");
		assert.equal(paste("  > |", "one\n\ntwo"), "  > one\n  >\n  > two|");
	});

	it("gives the line the caret ends on the full prefix when the paste ends with a line break", () => {
		assert.equal(paste("> |", "one\n"), "> one\n> |");
		assert.equal(paste("> a|b", "x\n"), "> ax\n> |b");
		assert.equal(paste("> |", "\n\n"), "> \n>\n> |");
	});

	it("does not nest again a pasted line that already is a quote line", () => {
		assert.equal(paste("> |", "> one\n> two"), "> one\n> two|", "a quoted block replaces the line's own prefix");
		assert.equal(paste("> |", "> one\n> > two"), "> one\n> > two|", "its own depth is kept");
		assert.equal(paste("> > |", "> one\n> two"), "> one\n> two|");
		assert.equal(paste("> |", "one\n> two\nthree"), "> one\n> two\n> three|", "a mixed block: quote lines stay, the others join the quote");
		assert.equal(paste("> a|", "b\n> c"), "> ab\n> c|", "the first line joins the text before the caret");
	});

	it("keeps a quote line pasted first after text in a line as text, with the prefix on the next lines", () => {
		assert.equal(paste("> a|", "> b\nc"), "> a> b\n> c|");
	});

	it("handles CRLF and a lone CR as line breaks", () => {
		assert.equal(paste("> |", "one\r\ntwo\r\n\r\nthree"), "> one\n> two\n>\n> three|");
		assert.equal(paste("> |", "one\rtwo"), "> one\n> two|");
		assert.equal(paste("> |", "one\r\n> two"), "> one\n> two|");
	});

	it("keeps the prefix inside a fenced block nested in the quote", () => {
		assert.equal(paste("> ```ts\n> a|\n> ```", "x\n\ny"), "> ```ts\n> ax\n>\n> y|\n> ```");
	});

	it("is the plain paste with the caret at column 0, inside the prefix, or before the text that follows it", () => {
		assert.equal(paste("|> a", "x\ny"), null);
		assert.equal(paste("> >| a", "x\ny"), null);
		assert.equal(paste(" |> a", "x\ny"), null);
	});

	it("is the plain paste for a single line, on a line that is not a quote and in a top-level fenced block", () => {
		assert.equal(paste("> a|", "x"), null);
		assert.equal(paste("a|", "x\ny"), null);
		assert.equal(paste("```\n> a|\n```", "x\ny"), null);
		assert.equal(paste("> a\n\n|", "x\ny"), null);
	});

	it("uses the prefix of the line where a selection starts, whatever lines the selection spans", () => {
		assert.equal(paste("> a[b\n> c]d", "x\ny"), "> ax\n> y|d");
		assert.equal(paste("> a[b\nplain]d", "x\ny"), "> ax\n> y|d", "the plain tail joins the last pasted line, as typing over the selection would join it");
		assert.equal(paste("plain[ a\n> b]c", "x\ny"), null, "a selection that starts outside a quote is the plain paste");
		assert.equal(paste("> [a]b", "x\ny"), "> x\n> y|b");
	});
});
