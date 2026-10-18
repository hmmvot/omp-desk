import assert from "node:assert/strict";
import { test } from "node:test";
import { hunkLocationText, isHunkLocation, isRevisionLocation, lineRangeText, MAX_QUOTE_VERSION_LENGTH, quoteLocationText } from "./quote-location.ts";

test("a location is path:line or path:start-end, with the version after ` @ ` for a Git revision", () => {
	assert.equal(lineRangeText(7, 7), "7");
	assert.equal(lineRangeText(7, 9), "7-9");
	assert.equal(quoteLocationText("src/app.ts", 42, 50, null), "src/app.ts:42-50");
	assert.equal(quoteLocationText("src/app.ts", 42, 42, "index"), "src/app.ts:42 @ index");
	assert.equal(quoteLocationText("src/app.ts", 42, 50, "HEAD (3f2a9c1)"), "src/app.ts:42-50 @ HEAD (3f2a9c1)");
});

test("a revision location is told from the location of the file on disk and from other code", () => {
	for (const revision of ["src/app.ts:42 @ index", "src/app.ts:42-50 @ HEAD (3f2a9c1)", "D:/Other/b.ts:1 @ 3f2a9c1", "a b/c.ts:3-4 @ ours (index :2)"]) {
		assert.equal(isRevisionLocation(revision), true, revision);
		assert.equal(isRevisionLocation(quoteLocationText("x", 1, 2, null)), false);
	}
	for (const other of ["src/app.ts:42-50", "src/app.ts", "user @ host", "src/app.ts:42 @", "src/app.ts:42 @ ", "x:1 @ a\nb", `x:1 @ ${"a".repeat(MAX_QUOTE_VERSION_LENGTH + 1)}`]) {
		assert.equal(isRevisionLocation(other), false, JSON.stringify(other));
	}
});

test("a hunk location names the modified side, then the original side, and leaves out a side that has no line", () => {
	const modified = quoteLocationText("src/app.ts", 3, 5, null);
	const original = quoteLocationText("src/app.ts", 3, 4, "HEAD (3f2a9c1)");
	assert.equal(hunkLocationText(modified, original), "src/app.ts:3-5 was src/app.ts:3-4 @ HEAD (3f2a9c1)");
	assert.equal(hunkLocationText(modified, null), "src/app.ts:3-5");
	assert.equal(hunkLocationText(null, original), "src/app.ts:3-4 @ HEAD (3f2a9c1)");
	assert.equal(hunkLocationText(null, null), null);
});

test("a hunk location is told from a file location and from other code, whatever its sides are", () => {
	for (const hunk of ["src/app.ts:3-5 was src/app.ts:3-4", "src/a.ts:3 @ index was src/a.ts:3 @ HEAD (3f2a9c1)", "D:/Work Dir/a.ts:1-2 was D:/Work Dir/b.ts:7-8", "a.ts:3 was old/a.ts:3 @ merge base (index :1)"]) {
		assert.equal(isHunkLocation(hunk), true, hunk);
	}
	for (const other of ["src/app.ts:3-5", "src/app.ts:3-5 @ index", "it was a:3", "src/app.ts was src/app.ts:3", "a:3 was b:4\nc:5", "a:3 was b:4 @ ", `a:3 was b:4 @ ${"v".repeat(MAX_QUOTE_VERSION_LENGTH + 1)}`, `x:1 was ${"p".repeat(9000)}:2`]) {
		assert.equal(isHunkLocation(other), false, JSON.stringify(other.slice(0, 60)));
	}
});
