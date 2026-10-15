import assert from "node:assert/strict";
import { test } from "node:test";
import { breakPieces, LONG_SEGMENT } from "./break-points.ts";

test("a path breaks after every slash and the pieces rebuild the text", () => {
	const path = "src/webview/components/Markdown.tsx";
	assert.deepEqual(breakPieces(path), ["src/", "webview/", "components/", "Markdown.tsx"]);
	assert.equal(breakPieces(path).join(""), path);
	assert.deepEqual(breakPieces("D:\\work\\repo\\a.ts"), ["D:\\", "work\\", "repo\\", "a.ts"]);
});

test("no break between two slashes, after a trailing separator or in a short segment", () => {
	assert.deepEqual(breakPieces("https://example.com/a"), ["https://", "example.com/", "a"]);
	assert.deepEqual(breakPieces("\\\\server\\share"), ["\\\\", "server\\", "share"]);
	assert.deepEqual(breakPieces("src/"), ["src/"]);
	assert.deepEqual(breakPieces("a_b-c.d"), ["a_b-c.d"]);
	assert.deepEqual(breakPieces("plain"), ["plain"]);
	assert.deepEqual(breakPieces(""), [""]);
});

test("a segment longer than the limit also breaks after . _ and -, never between two separators", () => {
	const segment = "ChatTranscriptRenderer_Layout03_Feature-m.json";
	assert.ok(segment.length > LONG_SEGMENT);
	assert.deepEqual(breakPieces(`dir/${segment}`), ["dir/", "ChatTranscriptRenderer_", "Layout03_", "Feature-", "m.", "json"]);
	const long = "a".repeat(LONG_SEGMENT);
	assert.deepEqual(breakPieces(`${long}__b`), [`${long}__`, "b"]);
	assert.deepEqual(breakPieces(`${long}_._b`), [`${long}_._`, "b"]);
});

test("spaces end a segment, so ordinary prose in code gets no extra break points", () => {
	assert.deepEqual(breakPieces("git commit -m a_b"), ["git commit -m a_b"]);
});
