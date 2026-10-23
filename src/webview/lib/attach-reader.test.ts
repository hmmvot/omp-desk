/**
 * The real `AttachReader` (`attach-reader.ts`): how a `File` of a paste or a drop is told apart by its first bytes and read. It crosses node's
 * `File` and `Blob` only; `createImageBitmap` is guarded, so only the pixel size of an image is missing in node.
 *
 * Runner: `node --test src/webview/lib/attach-reader.test.ts`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_DOCUMENT_BYTES, MAX_MESSAGE_CHARS } from "../../shared/attach-limits.ts";
import { attachReader, classifyFile, readDocumentFile, readImageAttachment } from "./attach-reader.ts";

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

function file(name: string, bytes: Uint8Array<ArrayBuffer> | string, type = ""): File {
	return new File([bytes], name, { type });
}

/** A file whose bytes cannot be read, as a file the user deleted after dropping it. */
function unreadable(name: string, size = 10): File {
	return { name, size, type: "", slice: () => ({ arrayBuffer: () => Promise.reject(new Error("gone")) }), arrayBuffer: () => Promise.reject(new Error("gone")) } as unknown as File;
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

	it("refuses a pasted PDF by name: a file that is not text is never attached", async () => {
		const pdf = await classifyFile(file("report.pdf", "%PDF-1.7\n\u0000\u0001binary", "application/pdf"));
		assert.equal(pdf.kind, "refused");
		assert.match(pdf.kind === "refused" ? pdf.reason : "", /report\.pdf/);
	});

	it("refuses a file that cannot be read, naming it", async () => {
		assert.deepEqual(await classifyFile(unreadable("gone.txt")), { kind: "refused", reason: "gone.txt: could not be read." });
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

	it("refuses a 2.6 MB log by name and size, and reads the next small file", async () => {
		const line = `[0000000] Unity PlayMode line ${"x".repeat(440)}\r\n`;
		const log = line.repeat(Math.ceil(2_649_137 / line.length)).slice(0, 2_649_137);
		const refused = await readDocumentFile(file("Unity_PlayMode.log", log));
		assert.equal(refused.ok, false);
		assert.match(refused.ok ? "" : refused.reason, /^Unity_PlayMode\.log is 2\.5 MB; one message carries at most 200.000 characters\.$/);
		assert.equal((await readDocumentFile(file("notes.txt", "small"))).ok, true);
	});

	it("refuses a file that cannot be read, naming it", async () => {
		assert.deepEqual(await readDocumentFile(unreadable("gone.txt")), { ok: false, reason: "gone.txt: could not be read." });
	});
});

describe("readImageAttachment", () => {
	it("reads an image whole: the sniffed type, its size and the base64 that goes on the wire", async () => {
		const read = await readImageAttachment(file("shot.png", PNG, "image/png"), 7);
		assert.equal(read.ok, true);
		if (!read.ok) return;
		assert.deepEqual(read.image, { id: 7, name: "shot.png", mimeType: "image/png", bytes: PNG.byteLength, data: Buffer.from(PNG).toString("base64") });
	});

	it("encodes a multi-megabyte image without the argument limit of one spread", async () => {
		const big = new Uint8Array(4 * 1024 * 1024);
		big.set(PNG);
		const read = await readImageAttachment(file("big.png", big, "image/png"), 1);
		assert.equal(read.ok, true);
		assert.equal(read.ok ? read.image.data.length : 0, Math.ceil((4 * 1024 * 1024) / 3) * 4);
	});

	it("names a mislabeled file by what was declared: the bytes decide, and the format list would mislead", async () => {
		const html = await readImageAttachment(file("error.png", "<html>nope</html>", "image/png"), 1);
		assert.deepEqual(html, { ok: false, reason: "error.png: its contents are not a valid image/png image." });
	});

	it("tells an undeclared or octet-stream file from a declared unsupported type", async () => {
		const bare = await readImageAttachment(file("a.bin", "text"), 1);
		assert.deepEqual(bare, { ok: false, reason: "a.bin: not a PNG, JPEG, GIF, or WebP image." });
		const octet = await readImageAttachment(file("a.bin", "text", "application/octet-stream"), 1);
		assert.deepEqual(octet, { ok: false, reason: "a.bin: not a PNG, JPEG, GIF, or WebP image." });
		const bmp = await readImageAttachment(file("a.bmp", "text", "image/bmp"), 1);
		assert.deepEqual(bmp, { ok: false, reason: "a.bmp: unsupported format (image/bmp) — attach PNG, JPEG, GIF, or WebP." });
	});

	it("refuses a file that cannot be read, naming it", async () => {
		assert.deepEqual(await readImageAttachment(unreadable("gone.png"), 1), { ok: false, reason: "gone.png: could not be read." });
	});
});

describe("attachReader", () => {
	it("is the three readers of this file", () => {
		assert.equal(attachReader.classify, classifyFile);
		assert.equal(attachReader.readImage, readImageAttachment);
		assert.equal(attachReader.readDocument, readDocumentFile);
	});
});
