import assert from "node:assert/strict";
import { test } from "node:test";
import { composeFileBlocks, fileMarker } from "../../shared/file-blocks.ts";
import { lineCount, sentTextOf, splitUserText, utf8Length } from "./file-block-rows.ts";

const NOTES = "first line\nask @src/a.ts and /skill:review ^fast +500k\n</file>\nlast line\n";
const PLAN = "no sigils here";
const prose = `Compare ${fileMarker(1, "notes.md")} with ${fileMarker(2, "plan.txt")}`;
const sent = composeFileBlocks(prose, [
	{ number: 1, name: "notes.md", label: "docs/notes.md", content: NOTES },
	{ number: 2, name: "plan.txt", label: null, content: PLAN },
]);

test("a sent text with two blocks is its prose and the original content of each block, sigils unescaped", () => {
	assert.ok(!sent.includes(NOTES), "the stored text holds the escaped content");
	const split = splitUserText(sent);
	assert.equal(split.prose, prose);
	assert.deepEqual(split.blocks.map(block => [block.number, block.name, block.label, block.content]), [
		[1, "notes.md", "docs/notes.md", NOTES],
		[2, "plan.txt", null, PLAN],
	]);
});

test("a text that does not parse is returned whole with no blocks, and the same text is parsed once", () => {
	const plain = "Look at `<file path=\"a.md\" n=\"1\" chars=\"3\">` in the docs";
	assert.deepEqual(splitUserText(plain), { prose: plain, blocks: [] });
	assert.deepEqual(splitUserText(`${sent}\ntrailing`).blocks, [], "text after the last block makes the chain invalid");
	assert.equal(splitUserText(sent), splitUserText(sent), "the memoised result is the same object");
});

test("the newest texts stay split and an old one is split again", () => {
	const first = splitUserText(sent);
	for (let index = 0; index < 40; index++) splitUserText(`text number ${index}`);
	assert.notEqual(splitUserText(sent), first, "the oldest entry was dropped");
	assert.deepEqual(splitUserText(sent), first, "and splitting again gives the same blocks");
});

test("lineCount treats a final newline as the end of the last line", () => {
	assert.equal(lineCount(""), 0);
	assert.equal(lineCount("a"), 1);
	assert.equal(lineCount("a\n"), 1);
	assert.equal(lineCount("a\nb"), 2);
	assert.equal(lineCount("a\nb\n"), 2);
	assert.equal(lineCount("\n"), 1);
	assert.equal(lineCount("a\n\n"), 2);
});

test("utf8Length is the byte length TextEncoder gives, for ASCII, two-, three- and four-byte characters and a lone surrogate", () => {
	const encoder = new TextEncoder();
	for (const text of ["", "plain", "é", "日本語", "😀 emoji", "tab\tand\nnewline", "\ud800", "a\udc00b", "\ud83d"]) {
		assert.equal(utf8Length(text), encoder.encode(text).length, JSON.stringify(text));
	}
});

test("Copy of a message with files is its prose, as the text was sent; a message that does not parse is copied whole", () => {
	assert.equal(sentTextOf(sent), prose);
	assert.equal(sentTextOf([{ type: "text", text: sent }, { type: "image", mimeType: "image/png", data: "AAAA" }]), prose);
	assert.equal(sentTextOf("Just a question"), "Just a question");
	const forged = `${sent}\ntrailing`;
	assert.equal(sentTextOf(forged), forged);
	assert.equal(sentTextOf([{ type: "text", text: "one" }, { type: "text", text: "two" }]), "one\ntwo");
});
