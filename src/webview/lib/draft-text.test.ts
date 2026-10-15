import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deletionTarget, normalizeLineEndings } from "./draft-text.ts";

const caret = (text: string, at: number, kind: Parameters<typeof deletionTarget>[3]) => deletionTarget(text, at, at, kind);

describe("deletionTarget", () => {
	it("keeps a selection as it is", () => {
		assert.deepEqual(deletionTarget("hello world", 2, 7, "char-back"), { from: 2, to: 7 });
	});

	it("removes one grapheme, not one UTF-16 unit", () => {
		const text = "a👍🏽b";
		assert.deepEqual(caret(text, text.length - 1, "char-back"), { from: 1, to: text.length - 1 });
		assert.deepEqual(caret(text, 1, "char-fwd"), { from: 1, to: text.length - 1 });
		assert.deepEqual(caret("e\u0301x", 2, "char-back"), { from: 0, to: 2 });
	});

	it("crosses a line break one character at a time", () => {
		assert.deepEqual(caret("ab\ncd", 3, "char-back"), { from: 2, to: 3 });
		assert.deepEqual(caret("ab\ncd", 2, "char-fwd"), { from: 2, to: 3 });
		assert.equal(caret("ab", 0, "char-back"), null);
		assert.equal(caret("ab", 2, "char-fwd"), null);
	});

	it("removes a word and the blanks before it, stopping at the line start", () => {
		assert.deepEqual(caret("one two  ", 9, "word-back"), { from: 4, to: 9 });
		assert.deepEqual(caret("one two", 4, "word-back"), { from: 0, to: 4 });
		assert.deepEqual(caret("a\nb", 2, "word-back"), { from: 1, to: 2 });
		assert.deepEqual(caret("  one two", 0, "word-fwd"), { from: 0, to: 5 });
		assert.deepEqual(caret("x\ny", 1, "word-fwd"), { from: 1, to: 2 });
	});

	it("removes to the line edge, then the line break itself", () => {
		assert.deepEqual(caret("ab\ncdef", 6, "line-back"), { from: 3, to: 6 });
		assert.deepEqual(caret("ab\ncdef", 3, "line-back"), { from: 2, to: 3 });
		assert.deepEqual(caret("abcd\nef", 1, "line-fwd"), { from: 1, to: 4 });
		assert.deepEqual(caret("abcd\nef", 4, "line-fwd"), { from: 4, to: 5 });
	});
});

describe("normalizeLineEndings", () => {
	it("turns CRLF and lone CR into LF", () => {
		assert.equal(normalizeLineEndings("a\r\nb\rc\nd"), "a\nb\nc\nd");
	});
});
