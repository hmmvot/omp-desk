import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { blockContaining, draftPieces, findFencedBlocks, indentEdit, newlineEdit, outdentEdit, type FencedBlock, type TextEdit } from "./code-fence.ts";

interface Marked {
	text: string;
	start: number;
	end: number;
}

/** Applies an edit the way the composer does: replace the range, then take the edit's selection. */
function apply(text: string, edit: TextEdit): Marked {
	return { text: text.slice(0, edit.from) + edit.insert + text.slice(edit.to), start: edit.selectionStart, end: edit.selectionEnd };
}

/** `|` marks the caret, `[` and `]` a selection. */
function mark(source: string): Marked {
	const caret = source.indexOf("|");
	if (caret >= 0) return { text: source.replace("|", ""), start: caret, end: caret };
	const start = source.indexOf("[");
	const end = source.indexOf("]") - 1;
	return { text: source.replace("[", "").replace("]", ""), start, end };
}

function show(result: Marked): string {
	if (result.start === result.end) return `${result.text.slice(0, result.start)}|${result.text.slice(result.start)}`;
	return `${result.text.slice(0, result.start)}[${result.text.slice(result.start, result.end)}]${result.text.slice(result.end)}`;
}

function run(source: string, edit: (text: string, block: FencedBlock, start: number, end: number) => TextEdit | null): string | null {
	const { text, start, end } = mark(source);
	const block = blockContaining(findFencedBlocks(text), start, end);
	assert.ok(block, `no block at the mark in ${JSON.stringify(source)}`);
	const result = edit(text, block, start, end);
	return result === null ? null : show(apply(text, result));
}

describe("finding fenced blocks", () => {
	it("reads an opening fence with an optional language up to its closing fence", () => {
		const text = "Look:\n```ts\nconst a = 1;\n```\nthanks";
		assert.deepEqual(findFencedBlocks(text), [{ start: 6, openEnd: 11, fenceLength: 3, closeStart: 25, end: 28 }]);
	});

	it("runs an unclosed block to the end of the draft", () => {
		const text = "```\nopen";
		assert.deepEqual(findFencedBlocks(text), [{ start: 0, openEnd: 3, fenceLength: 3, closeStart: null, end: 8 }]);
	});

	it("needs a closing run at least as long as the opening one, and nothing else on the line", () => {
		const text = "````\n```\n``` x\n````  \nafter";
		const [block] = findFencedBlocks(text);
		assert.equal(block!.fenceLength, 4);
		assert.equal(text.slice(block!.closeStart!, block!.end), "````  ");
	});

	it("allows up to three blanks before a fence and rejects four", () => {
		assert.equal(findFencedBlocks("   ```").length, 1);
		assert.equal(findFencedBlocks("    ```").length, 0);
	});

	it("does not take a backtick in the info string, or inline code, for a fence", () => {
		assert.deepEqual(findFencedBlocks("```code``` and `x`\n``\n`"), []);
	});

	it("finds several blocks in order and reopens after a close", () => {
		const blocks = findFencedBlocks("```\na\n```\nb\n```js\nc\n```\n");
		assert.equal(blocks.length, 2);
		assert.equal(blocks[1]!.closeStart, 20);
	});

	it("handles an empty draft and a lone fence", () => {
		assert.deepEqual(findFencedBlocks(""), []);
		assert.equal(findFencedBlocks("```").length, 1);
	});
});

describe("whether a selection is inside a block", () => {
	const text = "a\n```\nb\n```\nc";
	const blocks = findFencedBlocks(text);

	it("counts the fence lines and their ends, not the line breaks around them", () => {
		assert.ok(blockContaining(blocks, 2), "start of the opening fence");
		assert.ok(blockContaining(blocks, 11), "end of the closing fence line");
		assert.equal(blockContaining(blocks, 1), null, "end of the line before the block");
		assert.equal(blockContaining(blocks, 12), null, "start of the line after it");
	});

	it("is outside when a selection starts or ends outside", () => {
		assert.equal(blockContaining(blocks, 0, 5), null);
		assert.equal(blockContaining(blocks, 5, 12), null);
		assert.ok(blockContaining(blocks, 2, 11));
	});
});

describe("Enter inside a block", () => {
	it("keeps the indentation of the current line up to the caret", () => {
		assert.equal(run("```\n    foo|\n```", newlineEdit), "```\n    foo\n    |\n```");
		assert.equal(run("```\n    fo|o\n```", newlineEdit), "```\n    fo\n    |o\n```");
		assert.equal(run("```\n  | x\n```", newlineEdit), "```\n  \n  | x\n```");
		assert.equal(run("```\n\tfoo|\n```", newlineEdit), "```\n\tfoo\n\t|\n```");
	});

	it("replaces a selection and takes the indentation before it", () => {
		assert.equal(run("```\n  a[bc]d\n```", newlineEdit), "```\n  a\n  |d\n```");
	});

	it("adds no indentation on a fence line", () => {
		assert.equal(run("```ts|x\n  y\n```", newlineEdit), "```ts\n|x\n  y\n```");
		assert.equal(run("```\n  y\n```|", newlineEdit), "```\n  y\n```\n|");
	});

	it("supplies the closing fence at the end of an unclosed opening line", () => {
		assert.equal(run("```ts|", newlineEdit), "```ts\n|\n```");
		assert.equal(run("note\n````|", newlineEdit), "note\n````\n|\n````");
		assert.equal(run("```|\n\nmore", newlineEdit), "```\n|\n```\n\nmore");
	});

	it("does not close a block that already has a closing fence, or when the caret is not at the line end", () => {
		assert.equal(run("```|\nx\n```", newlineEdit), "```\n|\nx\n```");
		assert.equal(run("``|`ts", newlineEdit), "``\n|`ts");
	});
});

describe("Tab inside a block", () => {
	it("inserts spaces up to the next tab stop", () => {
		assert.equal(run("```\n|x\n```", indentEdit), "```\n    |x\n```");
		assert.equal(run("```\nab|x\n```", indentEdit), "```\nab  |x\n```");
		assert.equal(run("```\nabcd|\n```", indentEdit), "```\nabcd    |\n```");
	});

	it("replaces a selection inside one line", () => {
		assert.equal(run("```\na[bc]d\n```", indentEdit), "```\na   |d\n```");
	});

	it("does nothing on a fence line", () => {
		assert.equal(run("```|ts\nx\n```", indentEdit), null);
		assert.equal(run("```\nx\n```|", indentEdit), null);
	});

	it("indents every touched non-blank line of a multi-line selection and keeps the selection on the same text", () => {
		assert.equal(run("```\n[a\n\n  b]\n```", indentEdit), "```\n[    a\n\n      b]\n```");
		assert.equal(run("```\nx[a\nb]y\n```", indentEdit), "```\n    x[a\n    b]y\n```");
	});

	it("leaves a last line alone when the selection only reaches its start", () => {
		assert.equal(run("```\n[a\nb\n]c\n```", indentEdit), "```\n[    a\n    b\n]c\n```");
	});

	it("leaves the fence lines of a selection that includes them", () => {
		assert.equal(run("[```\na\n```]", indentEdit), "[```\n    a\n```]");
		assert.equal(run("[```\n```]", indentEdit), null);
	});
});

describe("Shift+Tab inside a block", () => {
	it("removes up to one indentation step, or one tab, from the caret's line", () => {
		assert.equal(run("```\n      x|\n```", outdentEdit), "```\n    x|\n```");
		assert.equal(run("```\n        x|\n```", outdentEdit), "```\n    x|\n```");
		assert.equal(run("```\n  x|\n```", outdentEdit), "```\nx|\n```");
		assert.equal(run("```\n\tx|\n```", outdentEdit), "```\nx|\n```");
		assert.equal(run("```\n 1|\n```", outdentEdit), "```\n1|\n```");
	});

	it("keeps the caret on the same character, clamped to the line start", () => {
		assert.equal(run("```\n    a|b\n```", outdentEdit), "```\na|b\n```");
		assert.equal(run("```\n  |  ab\n```", outdentEdit), "```\n|ab\n```");
	});

	it("outdents every touched non-fence line of a selection", () => {
		assert.equal(run("```\n[    a\n  b\n]c\n```", outdentEdit), "```\n[a\nb\n]c\n```");
		assert.equal(run("```\n    x[a\n      b]y\n```", outdentEdit), "```\nx[a\n    b]y\n```");
	});

	it("changes nothing without leading blanks, and never touches a fence line", () => {
		assert.equal(run("```\nx|\n```", outdentEdit), null);
		assert.equal(run("   ```|", outdentEdit), null);
	});
});

describe("pieces for the highlight layer", () => {
	const describePieces = (text: string): string[] => draftPieces(text, findFencedBlocks(text)).map(piece => `${piece.block ? "B" : "P"}:${text.slice(piece.start, piece.end)}`);

	it("splits around each block and drops the line breaks that separate the pieces", () => {
		assert.deepEqual(describePieces("a\n```\nb\n```\nc"), ["P:a", "B:```\nb\n```", "P:c"]);
	});

	it("keeps empty pieces, so an empty line next to a block keeps its row", () => {
		assert.deepEqual(describePieces("\n```\nb\n```\n"), ["P:", "B:```\nb\n```", "P:"]);
	});

	it("has no leading piece for a block at the start and no trailing one for a block at the end", () => {
		assert.deepEqual(describePieces("```\nb"), ["B:```\nb"]);
	});

	it("puts no piece between adjacent blocks: one newline separates two boxes", () => {
		assert.deepEqual(describePieces("```\na\n```\n```\nb\n```"), ["B:```\na\n```", "B:```\nb\n```"]);
	});

	it("is one ordinary piece without blocks", () => {
		assert.deepEqual(describePieces("abc"), ["P:abc"]);
	});
});
