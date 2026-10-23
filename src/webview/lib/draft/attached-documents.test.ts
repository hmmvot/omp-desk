import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_DOCUMENT_BYTES, MAX_MESSAGE_CHARS } from "../../../shared/attach-limits.ts";
import { classifyFile, draftRoomRefusal, readDocumentFile } from "./attached-documents.ts";

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

function file(name: string, bytes: Uint8Array<ArrayBuffer> | string): File {
	return new File([bytes], name);
}

describe("classifyFile", () => {
	it("calls a supported image an image, whatever its name says", async () => {
		assert.deepEqual(await classifyFile(file("notes.txt", PNG)), { kind: "image" });
	});

	it("calls text a candidate document, an empty file included", async () => {
		assert.deepEqual(await classifyFile(file("a.md", "# hi\n")), { kind: "text" });
		assert.deepEqual(await classifyFile(file("empty.txt", "")), { kind: "text" });
	});

	it("refuses an unsupported image and binary content by name, with the sentence the host uses", async () => {
		const bmp = await classifyFile(file("a.bmp", Uint8Array.from([0x42, 0x4d, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])));
		assert.equal(bmp.kind, "refused");
		assert.match(bmp.kind === "refused" ? bmp.reason : "", /^a\.bmp: unsupported format/);
		const binary = await classifyFile(file("a.bin", Uint8Array.from([1, 2, 3, 0, 4])));
		assert.equal(binary.kind, "refused");
		assert.match(binary.kind === "refused" ? binary.reason : "", /a\.bin/);
	});
});

describe("readDocumentFile", () => {
	it("reads the text and its byte size, decoding UTF-8 and normalising line endings", async () => {
		const read = await readDocumentFile(file("a.txt", "héllo\r\nworld"));
		assert.deepEqual(read, { ok: true, content: "héllo\nworld", bytes: Buffer.byteLength("héllo\r\nworld") });
	});

	it("refuses a file above the byte bound without reading it, and text above the character bound after decoding", async () => {
		const huge = { name: "big.txt", size: MAX_DOCUMENT_BYTES + 1, arrayBuffer: () => Promise.reject(new Error("must not be read")) } as unknown as File;
		const refused = await readDocumentFile(huge);
		assert.equal(refused.ok, false);
		assert.match(refused.ok ? "" : refused.reason, /^big\.txt is .*; one message carries at most 200.000 characters\.$/);
		const long = await readDocumentFile(file("long.txt", "x".repeat(MAX_MESSAGE_CHARS + 1)));
		assert.equal(long.ok, false);
		assert.match(long.ok ? "" : long.reason, /long\.txt is .* characters/);
		assert.equal((await readDocumentFile(file("fit.txt", "x".repeat(MAX_MESSAGE_CHARS)))).ok, true);
	});

	it("refuses invalid UTF-8 and control characters by name", async () => {
		const invalid = await readDocumentFile(file("a.txt", Uint8Array.from([0xff, 0xfe, 0x41])));
		assert.equal(invalid.ok, false);
		assert.match(invalid.ok ? "" : invalid.reason, /a\.txt/);
		const control = await readDocumentFile(file("c.txt", "a\u0001b"));
		assert.equal(control.ok, false);
	});
});

describe("draftRoomRefusal", () => {
	it("allows what fits the message exactly and names the file and the counts for what does not", () => {
		assert.equal(draftRoomRefusal("a.txt", 100, MAX_MESSAGE_CHARS - 100), null);
		const refusal = draftRoomRefusal("a.txt", 101, MAX_MESSAGE_CHARS - 100);
		assert.match(refusal ?? "", /^Adding a\.txt \(101 characters\) would take the draft over 200.000 characters\.$/);
	});
});
