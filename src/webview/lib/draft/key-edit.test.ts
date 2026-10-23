/**
 * `keyEdit` and `recall`: the keys of a fenced code block and a quote line, and the ↑/↓ walk of the session's prompts, through the
 * Draft interface with the in-memory cell and a recording field.
 *
 * Runner: `node --test src/webview/lib/draft/key-edit.test.ts`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDraftCell, type DraftCell } from "./cell.ts";
import { stubPort, type StubPort } from "./draft-test-stub.ts";
import { keyEdit, type KeyContext, type KeyPress } from "./key-edit.ts";
import { recall } from "./recall.ts";
import { withState } from "./value.ts";

function open(text: string): { cell: DraftCell; port: StubPort } {
	const port = stubPort();
	const cell = createDraftCell(port);
	port.bind(cell);
	cell.commit({ draft: withState(cell.read(), { text }), writes: [{ kind: "text", text, history: "reset", focus: false }] });
	port.calls.length = 0;
	return { cell, port };
}

const press = (key: string, modifiers: Partial<KeyPress> = {}): KeyPress => ({ key, keyCode: key === "Enter" ? 13 : 9, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...modifiers });
const idle: KeyContext = { composing: false, held: false, sendWith: "enter" };

/** What the key does to `text` with the selection `[start, end]`: the text after it, or `null` when the key is not claimed. */
function after(text: string, key: KeyPress, start: number, end = start, context: KeyContext = idle): { text: string; caret: number } | "claimed" | null {
	const { cell, port } = open(text);
	const claim = keyEdit(cell.read(), { anchor: start, focus: end }, key, context);
	if (!claim.claimed) return null;
	if (claim.change === null) return "claimed";
	assert.equal(cell.commit(claim.change), true);
	return { text: cell.read().text, caret: port.selected.focus };
}

describe("keys inside a fenced code block", () => {
	const code = "```ts\n  const a = 1;\n```";

	it("Enter is a newline that keeps the line's indentation, as one block edit", () => {
		const at = code.indexOf("const");
		const { cell, port } = open(code);
		const claim = keyEdit(cell.read(), { anchor: at + 12, focus: at + 12 }, press("Enter"), idle);
		assert.equal(claim.claimed, true);
		if (claim.claimed && claim.change !== null) cell.commit(claim.change);
		assert.equal(cell.read().text, "```ts\n  const a = 1;\n  \n```");
		assert.deepEqual(port.calls, ["write edit 20..20 \"\\n  \" as block"]);
	});

	it("Tab indents and Shift+Tab outdents the line", () => {
		const at = code.indexOf("const");
		assert.equal((after(code, press("Tab"), at) as { text: string }).text, "```ts\n    const a = 1;\n```");
		assert.equal((after(code, press("Tab", { shiftKey: true }), at) as { text: string }).text, "```ts\nconst a = 1;\n```");
	});

	it("Shift+Tab with nothing to outdent is not claimed: it is the way out of the block, backwards", () => {
		const { cell } = open("```\nx\n```");
		const claim = keyEdit(cell.read(), { anchor: 5, focus: 5 }, press("Tab", { shiftKey: true }), idle);
		assert.deepEqual(claim, { claimed: false, inBlock: true });
	});

	it("Ctrl+Enter is not claimed: it is the chord that sends from there, and the caret is reported in the block", () => {
		const { cell } = open(code);
		assert.deepEqual(keyEdit(cell.read(), { anchor: 10, focus: 10 }, press("Enter", { ctrlKey: true }), idle), { claimed: false, inBlock: true });
	});

	it("nothing is claimed while an IME composition is active or the draft is held, and the block is not reported", () => {
		const { cell } = open(code);
		assert.deepEqual(keyEdit(cell.read(), { anchor: 10, focus: 10 }, press("Enter"), { ...idle, composing: true }), { claimed: false, inBlock: false });
		assert.deepEqual(keyEdit(cell.read(), { anchor: 10, focus: 10 }, { ...press("Enter"), keyCode: 229 }, idle), { claimed: false, inBlock: false });
		assert.deepEqual(keyEdit(cell.read(), { anchor: 10, focus: 10 }, press("Enter"), { ...idle, held: true }), { claimed: false, inBlock: false });
	});

	it("a caret outside any block is not in one", () => {
		const { cell } = open("plain text");
		assert.deepEqual(keyEdit(cell.read(), { anchor: 3, focus: 3 }, press("Enter"), idle), { claimed: false, inBlock: false });
	});
});

describe("keys on a quote line", () => {
	it("Enter carries the prefix to the new line", () => {
		assert.deepEqual(after("> quoted", press("Enter"), 8), { text: "> quoted\n> ", caret: 11 });
	});

	it("Enter on an empty quote line lets go of the quote", () => {
		assert.deepEqual(after("> a\n> ", press("Enter"), 6), { text: "> a\n", caret: 4 });
	});

	it("Shift+Tab leaves the quote and Backspace at the start of the text takes the prefix", () => {
		assert.ok(after("> a", press("Tab", { shiftKey: true }), 3) !== null);
		assert.deepEqual(after("> a\n> b", press("Backspace"), 6), { text: "> a\nb", caret: 4 });
	});

	it("Ctrl+Enter is not ours, and in Shift+Enter mode a plain Shift+Enter in a quote sends", () => {
		assert.equal(after("> a", press("Enter", { ctrlKey: true }), 3), null);
		assert.equal(after("> a", press("Enter", { shiftKey: true }), 3, 3, { ...idle, sendWith: "shiftEnter" }), null);
		assert.ok(after("> a", press("Enter", { shiftKey: true }), 3, 3, idle) !== null, "in Enter mode Shift+Enter is the quote's new line");
		assert.ok(after("> a", press("Enter"), 3, 3, { ...idle, sendWith: "shiftEnter" }) !== null, "a plain Enter is the quote's new line in both modes");
	});

	it("Enter, Shift+Enter and Alt+Enter continue a nested quote with its whole prefix, and the continuation is one block edit", () => {
		assert.deepEqual(after("> ab", press("Enter"), 3), { text: "> a\n> b", caret: 6 });
		for (const modifiers of [{ shiftKey: true }, { altKey: true }]) assert.deepEqual(after("> > ab", press("Enter", modifiers), 5), { text: "> > a\n> > b", caret: 10 });
	});

	it("an empty quote line lets go of one level at a time, the caret staying on the line", () => {
		assert.deepEqual(after("> a\n> > ", press("Enter"), 8), { text: "> a\n> ", caret: 6 });
	});

	it("Shift+Tab leaves the quote: a plain line after it, one level out for a nested line, the prefix off an empty one; inside the prefix it is the browser's", () => {
		assert.deepEqual(after("> a", press("Tab", { shiftKey: true }), 3), { text: "> a\n", caret: 4 });
		assert.deepEqual(after("> > ab", press("Tab", { shiftKey: true }), 4), { text: "> > ab\n> ", caret: 9 });
		assert.deepEqual(after("> a\n> ", press("Tab", { shiftKey: true }), 6), { text: "> a\n", caret: 4 });
		assert.equal(after("> a", press("Tab", { shiftKey: true }), 1), null);
	});

	it("Enter inside a fenced block nested in a quote keeps the prefix, even on an empty line", () => {
		assert.deepEqual(after("> ```ts\n> \n> ```", press("Enter"), 10), { text: "> ```ts\n> \n> \n> ```", caret: 13 });
	});

	it("Backspace takes one level of prefix at a time, Delete takes the next line's prefix with the line break", () => {
		assert.deepEqual(after("> > x", press("Backspace"), 4), { text: "> x", caret: 2 });
		assert.deepEqual(after("> x", press("Backspace"), 2), { text: "x", caret: 0 });
		assert.deepEqual(after("> a\n> b", press("Delete"), 3), { text: "> ab", caret: 3 });
	});

	it("a line that is not in a quote is not claimed", () => {
		assert.equal(after("a > b", press("Enter"), 5), null);
	});
});

describe("recall", () => {
	const prompts = ["first", "second"];

	it("walks older and newer from an empty draft, replacing it as one recorded step with the caret at the end, and ↓ past the newest returns the draft", () => {
		const { cell, port } = open("");
		const up = recall(cell.read(), prompts, "older", false);
		assert.ok(up !== null);
		cell.commit(up);
		assert.equal(cell.read().text, "second");
		assert.deepEqual(port.calls, ['write text "second" caret 6 record focus']);
		const again = recall(cell.read(), prompts, "older", false);
		assert.ok(again !== null);
		cell.commit(again);
		assert.equal(cell.read().text, "first");
		cell.commit(recall(cell.read(), prompts, "newer", false)!);
		cell.commit(recall(cell.read(), prompts, "newer", false)!);
		assert.equal(cell.read().text, "");
		assert.equal(cell.read().walk, null);
	});

	it("is not ours while the draft is held", () => {
		const { cell } = open("typed");
		assert.equal(recall(cell.read(), prompts, "older", true), null);
	});

	it("is not ours when the draft holds any image at all, one whose marker was deleted included", () => {
		const { cell } = open("typed");
		const image = { id: 1, name: "a.png", mimeType: "image/png" as const, bytes: 3, data: "AAA", number: 1 };
		cell.commit({ draft: withState(cell.read(), { images: [image] }), writes: [] });
		assert.equal(recall(cell.read(), prompts, "older", false), null);
	});

	it("is not ours over a typed draft, past the newest prompt or without prompts", () => {
		const { cell } = open("typed");
		assert.equal(recall(cell.read(), prompts, "older", false), null);
		cell.commit({ draft: withState(cell.read(), { text: "" }), writes: [{ kind: "text", text: "", history: "reset", focus: false }] });
		assert.equal(recall(cell.read(), prompts, "newer", false), null);
		assert.equal(recall(cell.read(), [], "older", false), null);
	});

	it("a recalled prompt that carried a file is walked by its prose and brings the file back as a held document", () => {
		const sent = '[File #1: notes.md]\n\n<file name="notes.md" n="1" chars="2">\nhi\n</file>';
		const { cell } = open("");
		const step = recall(cell.read(), [sent], "older", false);
		assert.ok(step !== null);
		cell.commit(step);
		assert.deepEqual(cell.read().documents.map(document => [document.number, document.name, document.source.kind]), [[1, "notes.md", "held"]]);
		assert.equal(cell.read().next.document, 2);
		cell.commit(recall(cell.read(), [sent], "newer", false)!);
		assert.deepEqual(cell.read().documents, []);
		assert.equal(cell.read().next.document, 1);
	});
});
