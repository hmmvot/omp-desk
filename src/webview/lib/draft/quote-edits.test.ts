import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findFencedBlocks, type TextEdit } from "../code-fence.ts";
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

const enter = plain("Enter");
const shiftEnter = plain("Enter", { shiftKey: true });
const altEnter = plain("Enter", { altKey: true });
const shiftTab = plain("Tab", { shiftKey: true });

describe("Enter on a quote line", () => {
	it("is a new line that carries the line's whole prefix, at any depth and indentation", () => {
		assert.equal(run("> a|b", enter), "> a\n> |b");
		assert.equal(run("> ab|", enter), "> ab\n> |");
		assert.equal(run("> > a|b", enter), "> > a\n> > |b");
		assert.equal(run("  > a|b", enter), "  > a\n  > |b");
		assert.equal(run(">a|b", enter), ">a\n>|b");
		assert.equal(run("x\n> a|b\ny", enter), "x\n> a\n> |b\ny");
	});

	it("is the same with Shift and with Alt, as in a code block", () => {
		for (const key of [shiftEnter, altEnter, plain("Enter", { shiftKey: true, altKey: true })]) {
			assert.equal(run("> > a|b", key), "> > a\n> > |b");
			assert.equal(run("> a\n> |", key), "> a\n|");
		}
	});

	it("replaces a selection by the line break and the prefix", () => {
		assert.equal(run("> a[bc]d", enter), "> a\n> |d");
	});

	it("is a plain line break, never a send, with the selection start inside the prefix", () => {
		assert.equal(run("|> a", enter), "\n|> a");
		assert.equal(run(">| a", enter), ">\n| a");
		assert.equal(run("> >| a", enter), "> >\n| a");
		assert.equal(run("> > |a", enter), "> > \n> > |a", "right after the prefix it continues");
	});

	it("on a line that holds only its prefix lets go of one level and keeps the caret on the line", () => {
		assert.equal(run("> a\n> |", enter), "> a\n|", "a plain empty line");
		assert.equal(run(">|", enter), "|");
		assert.equal(run("  > |", enter), "|", "the indentation goes with the prefix");
		assert.equal(run("> a\n> > |", enter), "> a\n> |", "one level at a time");
		assert.equal(run("> > > |", enter), "> > |");
		assert.equal(run("> >|", enter), "> |", "a prefix without a blank");
		assert.equal(run("> a\n>  |", enter), "> a\n|", "blanks after the prefix are part of the empty line");
		assert.equal(run("> | ", enter), "|", "the caret may sit among the blanks");
		assert.equal(run("> a\n> |\n> b", enter), "> a\n|\n> b", "the lines around keep their prefix");
	});

	it("does not leave the quote from an empty line in a fenced block nested in it: a blank line there is code", () => {
		assert.equal(run("> ```ts\n> |\n> ```", enter), "> ```ts\n> \n> |\n> ```");
		assert.equal(run("> ```ts\n> a\n> ```\n> |", enter), "> ```ts\n> a\n> ```\n|", "after the closing fence it is a quote line again");
	});

	it("is not ours on a line that is not a quote, in a top-level fenced block, with Ctrl or Meta (they send) or in four blanks of indentation", () => {
		assert.equal(run("a|b", enter), null);
		assert.equal(run("```\n> a|b\n```", enter), null);
		assert.equal(run("> a|b", plain("Enter", { ctrlKey: true })), null);
		assert.equal(run("> a|b", plain("Enter", { metaKey: true })), null);
		assert.equal(run("> a|b", plain("Enter", { shiftKey: true, ctrlKey: true })), null);
		assert.equal(run("> |", plain("Enter", { ctrlKey: true })), null, "Ctrl+Enter sends from an empty quote line too");
		assert.equal(run("    > a|b", enter), null);
	});
});

describe("Shift+Tab on a quote line", () => {
	it("adds a plain line after the line and puts the caret on it, leaving the text and the lines below as they are", () => {
		assert.equal(run("> a|b", shiftTab), "> ab\n|");
		assert.equal(run("> ab|", shiftTab), "> ab\n|");
		assert.equal(run("x\n> a|b\n> c", shiftTab), "x\n> ab\n|\n> c");
		assert.equal(run(">|a", shiftTab), ">a\n|");
		assert.equal(run("> [ab]c", shiftTab), "> abc\n|", "with a selection, the line it starts on");
	});

	it("leaves one level at a time on a nested line: the new line has the outer prefix", () => {
		assert.equal(run("> > a|", shiftTab), "> > a\n> |");
		assert.equal(run("> > > a|", shiftTab), "> > > a\n> > |");
		assert.equal(run("  > > a|", shiftTab), "  > > a\n  > |");
		assert.equal(run(">> a|", shiftTab), ">> a\n> |");
	});

	it("on a line that holds only its prefix removes one level of it", () => {
		assert.equal(run("> a\n> |", shiftTab), "> a\n|");
		assert.equal(run("> > |", shiftTab), "> |");
		assert.equal(run("  > |", shiftTab), "|");
		assert.equal(run("> | ", shiftTab), "|");
	});

	it("works on a line of a fenced block nested in the quote", () => {
		assert.equal(run("> ```ts\n> a|\n> ```", shiftTab), "> ```ts\n> a\n|\n> ```");
		assert.equal(run("> ```ts\n> |\n> ```", shiftTab), "> ```ts\n|\n> ```");
	});

	it("is the browser's with the selection start inside the prefix, for Tab alone, with another modifier, off a quote and in a top-level block", () => {
		assert.equal(run("|> a", shiftTab), null);
		assert.equal(run(">| a", shiftTab), null);
		assert.equal(run("> a|", plain("Tab")), null);
		assert.equal(run("> a|", plain("Tab", { shiftKey: true, ctrlKey: true })), null);
		assert.equal(run("> a|", plain("Tab", { shiftKey: true, altKey: true })), null);
		assert.equal(run("> a|", plain("Tab", { shiftKey: true, metaKey: true })), null);
		assert.equal(run("a|", shiftTab), null);
		assert.equal(run("```\n> a|\n```", shiftTab), null);
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
