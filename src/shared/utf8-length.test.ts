import assert from "node:assert/strict";
import { test } from "node:test";
import { utf8Length } from "./utf8-length.ts";

test("utf8Length is the byte length TextEncoder gives, for ASCII, two-, three- and four-byte characters and a lone surrogate", () => {
	const encoder = new TextEncoder();
	for (const text of ["", "plain", "é", "日本語", "😀 emoji", "tab\tand\nnewline", "\ud800", "a\udc00b", "\ud83d"]) {
		assert.equal(utf8Length(text), encoder.encode(text).length, JSON.stringify(text));
	}
});
