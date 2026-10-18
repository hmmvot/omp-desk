import assert from "node:assert/strict";
import { test } from "node:test";
import { isRevisionLocation, lineRangeText, MAX_QUOTE_VERSION_LENGTH, quoteLocationText } from "./quote-location.ts";

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
