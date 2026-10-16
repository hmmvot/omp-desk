import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_DOCUMENT_BYTES, MAX_MESSAGE_CHARS } from "./attach-limits.ts";
import { decodeTextFile, normalizeLineEndings, sniffTextFile, textFileRefusalSentence } from "./text-file.ts";

const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values);
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("decodeTextFile", () => {
	it("decodes UTF-8 with and without a byte order mark", () => {
		assert.deepEqual(decodeTextFile(utf8("héllo 日本 😀")), { ok: true, text: "héllo 日本 😀" });
		assert.deepEqual(decodeTextFile(bytes(0xef, 0xbb, 0xbf, ...utf8("bom"))), { ok: true, text: "bom" });
	});

	it("normalises CRLF and a lone CR to LF and keeps tab", () => {
		assert.deepEqual(decodeTextFile(utf8("a\r\nb\rc\nd\te")), { ok: true, text: "a\nb\nc\nd\te" });
	});

	it("refuses bytes that are not UTF-8: UTF-16 and a Latin-1 byte", () => {
		assert.deepEqual(decodeTextFile(bytes(0xff, 0xfe, 0x61, 0x00)), { ok: false, reason: "not-utf8" });
		assert.deepEqual(decodeTextFile(bytes(0x63, 0x61, 0x66, 0xe9)), { ok: false, reason: "not-utf8" });
	});

	it("refuses a control character other than tab and newline: NUL and a form feed", () => {
		assert.deepEqual(decodeTextFile(bytes(0x61, 0x00, 0x62)), { ok: false, reason: "control-characters" });
		assert.deepEqual(decodeTextFile(bytes(0x61, 0x0c, 0x62)), { ok: false, reason: "control-characters" });
		assert.deepEqual(decodeTextFile(new Uint8Array(0)), { ok: true, text: "" });
	});
});

describe("sniffTextFile", () => {
	it("refuses a binary prefix and accepts text, ignoring a UTF-8 character cut at the end", () => {
		assert.equal(sniffTextFile(bytes(0x50, 0x4b, 0x03, 0x04, 0x00)), "control-characters");
		assert.equal(sniffTextFile(bytes(0x25, 0x50, 0x44, 0x46, 0x2d, 0xe2, 0x80)), null, "the cut of an incomplete sequence is not an error");
		assert.equal(sniffTextFile(bytes(0x25, 0xff, 0x44)), "not-utf8");
		assert.equal(sniffTextFile(utf8("plain")), null);
	});
});

describe("limits and sentences", () => {
	it("derives the byte bound from the character bound", () => {
		assert.equal(MAX_DOCUMENT_BYTES, 600_003);
		assert.equal(MAX_MESSAGE_CHARS, 200_000);
	});

	it("names the file and the reason", () => {
		assert.equal(textFileRefusalSentence("plan.pdf", "not-utf8"), "plan.pdf is not a text file (its bytes are not UTF-8).");
		assert.equal(textFileRefusalSentence("a.bin", "control-characters"), "a.bin is not a text file (it contains control characters).");
	});

	it("turns CRLF and lone CR into LF", () => {
		assert.equal(normalizeLineEndings("a\r\nb\rc\nd"), "a\nb\nc\nd");
	});
});
