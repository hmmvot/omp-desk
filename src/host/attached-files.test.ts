/**
 * The host's reading of what an attach names: an image comes back as an image, a text file as a document without its text,
 * and everything else as one refusal sentence; at send the host reads the documents again by reference.
 *
 * Runner: `node --test src/host/attached-files.test.ts`.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { MAX_CHAT_IMAGES_BYTES, MAX_CHAT_IMAGE_BYTES } from "../protocol/chat-messages.ts";
import type { GuestAttachedDocument } from "../protocol/messages.ts";
import { MAX_DOCUMENT_BYTES, MAX_MESSAGE_CHARS } from "../shared/attach-limits.ts";
import { AttachedFileRegistry, readAttachedFiles, readAttachedForSend } from "./attached-files.ts";

const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function png(size: number): Buffer {
	const bytes = Buffer.alloc(size, 9);
	Buffer.from(PNG_HEAD).copy(bytes);
	return bytes;
}

const documents = (items: readonly { readonly kind: string }[]): GuestAttachedDocument[] => items.filter((item): item is GuestAttachedDocument => item.kind === "document");

describe("readAttachedFiles", () => {
	let folder = "";
	let registry = new AttachedFileRegistry();
	const file = (name: string): string => join(folder, name);
	const uri = (name: string): string => pathToFileURL(file(name)).href;
	const drop = (...names: string[]) => readAttachedFiles(names.map(name => ({ uri: uri(name) })), registry);
	const pick = (...names: string[]) => readAttachedFiles(names.map(name => ({ path: file(name) })), registry);

	before(async () => {
		folder = await mkdtemp(join(tmpdir(), "omp-desk-attached-"));
		await writeFile(file("small.png"), png(40));
		await writeFile(file("with space #1.png"), png(41));
		await writeFile(file("four.png"), png(4 * 1024 * 1024));
		await writeFile(file("exact.png"), png(MAX_CHAT_IMAGE_BYTES));
		await writeFile(file("exact2.png"), png(MAX_CHAT_IMAGE_BYTES));
		await writeFile(file("over.png"), png(MAX_CHAT_IMAGE_BYTES + 1));
		await writeFile(file("notes.md"), "# Notes\r\nline two\r\n");
		await writeFile(file("bom.txt"), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("héllo 日本")]));
		await writeFile(file("empty.txt"), "");
		await writeFile(file("empty.png"), "");
		await writeFile(file("renamed.png"), "<html>an error page saved as png</html>");
		await writeFile(file("Makefile"), "all:\n\techo hi\n");
		await writeFile(file("plan.pdf"), Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.from([0x00, 0xff, 0xfe, 0x80]), Buffer.alloc(100, 1)]));
		await writeFile(file("big.pdf"), Buffer.concat([Buffer.from("%PDF-1.7\n%"), Buffer.from([0xe2, 0xe3, 0xcf, 0xd3]), Buffer.alloc(6 * 1024 * 1024, 7)]));
		await writeFile(file("binary.bin"), Buffer.alloc(700 * 1024, 0));
		await writeFile(file("utf16.txt"), Buffer.from([0xff, 0xfe, 0x61, 0x00, 0x62, 0x00]));
		await writeFile(file("latin1.txt"), Buffer.from([0x63, 0x61, 0x66, 0xe9]));
		await writeFile(file("formfeed.txt"), "a\fb");
		await writeFile(file("exactly.md"), "x".repeat(MAX_MESSAGE_CHARS));
		await writeFile(file("long.md"), "x".repeat(MAX_MESSAGE_CHARS + 1));
		await writeFile(file("huge.md"), Buffer.alloc(MAX_DOCUMENT_BYTES + 1, 0x61));
		await writeFile(file("picture.bmp"), Buffer.concat([Buffer.from("BM"), Buffer.alloc(12, 0)]));
		await mkdir(file("dir.png"));
	});
	after(async () => {
		await rm(folder, { recursive: true, force: true });
	});

	it("returns a supported image's bytes with its name and the type its signature names", async () => {
		registry = new AttachedFileRegistry();
		const read = await drop("small.png", "with space #1.png");
		assert.deepEqual(read.refusals, []);
		assert.deepEqual(read.items.map(item => [item.kind, item.name]), [["image", "small.png"], ["image", "with space #1.png"]]);
		const first = read.items[0]!;
		assert.ok(first.kind === "image" && first.mimeType === "image/png" && Buffer.from(first.data, "base64").equals(png(40)));
	});

	it("carries an image of exactly the per-image limit and refuses one byte more, naming the limit", async () => {
		registry = new AttachedFileRegistry();
		assert.equal((await drop("exact.png")).items.length, 1);
		const over = await drop("over.png");
		assert.deepEqual(over.items, []);
		assert.match(over.refusals[0]!, /^over\.png: 5\.0 MB exceeds the 5\.0 MB limit per image\.$/);
	});

	it("keeps the whole drop within the per-prompt image limit and reads a repeated file once", async () => {
		registry = new AttachedFileRegistry();
		const read = await drop("four.png", "exact.png", "exact2.png", "small.png", "small.png");
		assert.deepEqual(read.items.map(item => item.name), ["four.png", "exact.png", "small.png"]);
		assert.deepEqual(read.refusals, ["exact2.png: this prompt would carry 14.0 MB of images; the limit is 10.0 MB per prompt."]);
		const total = read.items.reduce((sum, item) => sum + (item.kind === "image" ? Buffer.from(item.data, "base64").length : 0), 0);
		assert.ok(total <= MAX_CHAT_IMAGES_BYTES);
	});

	it("answers a text file with a document that has no text, only a size and an opaque reference", async () => {
		registry = new AttachedFileRegistry();
		const read = await drop("notes.md", "bom.txt", "Makefile");
		assert.deepEqual(read.refusals, []);
		const docs = documents(read.items);
		assert.deepEqual(docs.map(item => [item.name, item.bytes, item.chars]), [["notes.md", 19, 17], ["bom.txt", 3 + Buffer.byteLength("héllo 日本"), "héllo 日本".length], ["Makefile", 14, 14]]);
		for (const item of docs) {
			assert.match(item.ref, /^[A-Za-z0-9_-]{8,64}$/);
			assert.equal(Object.keys(item).sort().join(), "bytes,chars,kind,name,ref");
		}
	});

	it("decides by content, not by name: a renamed text file is a document, a PDF a refusal, an empty file a document of 0 bytes", async () => {
		registry = new AttachedFileRegistry();
		const read = await drop("renamed.png", "empty.txt", "empty.png", "plan.pdf");
		assert.deepEqual(documents(read.items).map(item => [item.name, item.bytes, item.chars]), [["renamed.png", 39, 39], ["empty.txt", 0, 0], ["empty.png", 0, 0]]);
		assert.deepEqual(read.refusals, ["plan.pdf is not a text file (its bytes are not UTF-8)."]);
	});

	it("refuses a big binary as not text before any size sentence, and an image format Desk does not take by name", async () => {
		registry = new AttachedFileRegistry();
		const read = await drop("big.pdf", "binary.bin", "utf16.txt", "latin1.txt", "formfeed.txt", "picture.bmp");
		assert.deepEqual(read.items, []);
		assert.deepEqual(read.refusals, [
			"big.pdf is not a text file (its bytes are not UTF-8).",
			"binary.bin is not a text file (it contains control characters).",
			"utf16.txt is not a text file (its bytes are not UTF-8).",
			"latin1.txt is not a text file (its bytes are not UTF-8).",
			"formfeed.txt is not a text file (it contains control characters).",
			"picture.bmp: unsupported format (image/bmp) — attach PNG, JPEG, GIF, or WebP.",
		]);
	});

	it("bounds a document by the message: exactly 200 000 characters passes, one more is refused with the count, a file above the byte bound is refused unread", async () => {
		registry = new AttachedFileRegistry();
		assert.equal(documents((await drop("exactly.md")).items)[0]!.chars, MAX_MESSAGE_CHARS);
		const long = await drop("long.md");
		assert.deepEqual(long.refusals, ["long.md is 200 001 characters; one message carries at most 200 000."]);
		const huge = await drop("huge.md");
		assert.deepEqual(huge.refusals, ["huge.md is 586 KB; one message carries at most 200 000 characters."]);
	});

	it("keeps the order of a mixed drop and refuses a folder, a missing file and a non-file address, one sentence each", async () => {
		registry = new AttachedFileRegistry();
		const read = await readAttachedFiles([{ uri: uri("notes.md") }, { uri: uri("small.png") }, { uri: uri("dir.png") }, { uri: uri("missing.md") }, { uri: "https://example.com/a.md" }, { uri: uri("exact.png") }], registry);
		assert.deepEqual(read.items.map(item => [item.kind, item.name]), [["document", "notes.md"], ["image", "small.png"], ["image", "exact.png"]]);
		assert.deepEqual(read.refusals, [
			"dir.png: a folder cannot be attached; attach the files in it.",
			"missing.md: could not be read.",
			"Dropped item: only files on this computer can be attached by dropping.",
		]);
	});

	it("reads only a local drive path from a drop: no other scheme, no network share, no device path", async () => {
		registry = new AttachedFileRegistry();
		const read = await readAttachedFiles(
			[
				"https://example.com/a.md",
				"vscode-remote://ssh-remote+box/home/a.md",
				"file://server/share/a.md",
				"file:////server/share/a.md",
				"file:///relative.md",
				"not a uri",
			].map(item => ({ uri: item })),
			registry,
		);
		assert.deepEqual(read.items, []);
		assert.equal(read.refusals.length, 6);
		assert.ok(read.refusals.every(sentence => sentence.startsWith("Dropped item: ")), read.refusals.join("\n"));
		assert.equal(registry.size, 0);
	});

	it("accepts a network path the dialog returned, which a drop may not name, and refuses a relative one", async () => {
		registry = new AttachedFileRegistry();
		const read = await readAttachedFiles([{ path: "\\\\nonexistent-host-for-test\\share\\notes.md" }, { path: "notes.md" }], registry);
		assert.deepEqual(read.refusals, ["notes.md: could not be read.", "Picked item: this is not an absolute file path."], "the share was tried, the relative path was not");
	});

	it("gives the same reference to the same path, in any casing and from a drop and a pick, and a different one to another file", async () => {
		registry = new AttachedFileRegistry();
		const first = documents((await drop("notes.md")).items)[0]!;
		const again = documents((await drop("notes.md")).items)[0]!;
		const picked = documents((await pick("notes.md")).items)[0]!;
		const other = documents((await drop("bom.txt")).items)[0]!;
		assert.equal(again.ref, first.ref);
		assert.equal(picked.ref, first.ref);
		assert.notEqual(other.ref, first.ref);
		if (process.platform === "win32") {
			const shouting = await readAttachedFiles([{ path: file("NOTES.MD") }], registry);
			assert.equal(documents(shouting.items)[0]!.ref, first.ref);
		}
		assert.equal(registry.size, 2);
	});
});

describe("AttachedFileRegistry", () => {
	it("is bounded: past its capacity the least recently used reference stops resolving", () => {
		const registry = new AttachedFileRegistry(3);
		const a = registry.register("C:\\x\\a.md", "drop");
		const b = registry.register("C:\\x\\b.md", "drop");
		const c = registry.register("C:\\x\\c.md", "dialog");
		assert.equal(registry.resolve(a)?.path, "C:\\x\\a.md", "using a makes it the most recent");
		const d = registry.register("C:\\x\\d.md", "drop");
		assert.equal(registry.size, 3);
		assert.equal(registry.resolve(b), null, "b was the least recently used");
		assert.notEqual(registry.resolve(a), null);
		assert.notEqual(registry.resolve(c), null);
		assert.notEqual(registry.resolve(d), null);
		assert.equal(registry.register("C:\\x\\b.md", "drop") === b, false, "an evicted path gets a new reference");
		assert.equal(registry.resolve("not-a-known-reference"), null);
	});

	it("upgrades a dropped path the user then chose in the dialog, and never downgrades it", () => {
		const registry = new AttachedFileRegistry();
		const ref = registry.register("C:\\x\\a.md", "drop");
		assert.equal(registry.resolve(ref)?.origin, "drop");
		assert.equal(registry.register("C:\\x\\a.md", "dialog"), ref);
		assert.equal(registry.resolve(ref)?.origin, "dialog");
		assert.equal(registry.register("C:\\x\\a.md", "drop"), ref);
		assert.equal(registry.resolve(ref)?.origin, "dialog");
	});
});

describe("readAttachedForSend", () => {
	let folder = "";
	const file = (name: string): string => join(folder, name);
	const context = (cwd: string | null, dirty: readonly string[] = []) => ({ cwd, isDirty: (path: string) => dirty.includes(path) });

	before(async () => {
		folder = await mkdtemp(join(tmpdir(), "omp-desk-send-read-"));
		await mkdir(join(folder, "docs"));
	});
	after(async () => {
		await rm(folder, { recursive: true, force: true });
	});

	async function attach(name: string, content: string | Buffer): Promise<{ registry: AttachedFileRegistry; ref: string }> {
		await writeFile(file(name), content);
		const registry = new AttachedFileRegistry();
		const read = await readAttachedFiles([{ path: file(name) }], registry);
		return { registry, ref: documents(read.items)[0]!.ref };
	}

	it("reads the saved text, with a label relative to the session folder inside it and absolute outside it, and tells which file has unsaved changes", async () => {
		const { registry, ref } = await attach("docs/plan.md", "# Plan\r\ntext\r\n");
		const inside = await readAttachedForSend([{ number: 3, ref }], 200_000, registry, context(folder, [file("docs/plan.md")]));
		assert.deepEqual(inside, { files: [{ number: 3, label: "docs/plan.md", content: "# Plan\ntext\n", dirty: true }], failures: [] });
		const outside = await readAttachedForSend([{ number: 3, ref }], 200_000, registry, context(join(folder, "docs", "elsewhere")));
		assert.equal(outside.files[0]!.label, file("docs/plan.md").replaceAll("\\", "/"));
		assert.equal(outside.files[0]!.dirty, false);
		const noCwd = await readAttachedForSend([{ number: 3, ref }], 200_000, registry, context(null));
		assert.equal(noCwd.files[0]!.label, file("docs/plan.md").replaceAll("\\", "/"), "a session with no folder yet gets an absolute label");
	});

	it("reads again what changed since the attach and fails for a deleted file, a file that became binary and a file that grew past the message", async () => {
		const changed = await attach("changed.md", "old");
		await writeFile(file("changed.md"), "new text");
		assert.equal((await readAttachedForSend([{ number: 1, ref: changed.ref }], 100, changed.registry, context(folder))).files[0]!.content, "new text");

		await writeFile(file("changed.md"), Buffer.from([0x61, 0x00, 0x62]));
		const binary = await readAttachedForSend([{ number: 1, ref: changed.ref }], 100, changed.registry, context(folder));
		assert.deepEqual(binary.failures, [{ number: 1, name: "changed.md", reason: "changed.md is not a text file (it contains control characters)." }]);

		await writeFile(file("changed.md"), "x".repeat(MAX_DOCUMENT_BYTES + 1));
		const grown = await readAttachedForSend([{ number: 1, ref: changed.ref }], 100, changed.registry, context(folder));
		assert.match(grown.failures[0]!.reason, /^changed\.md is now 586 KB; one message carries at most 200 000 characters\.$/);

		await rm(file("changed.md"));
		const gone = await readAttachedForSend([{ number: 1, ref: changed.ref }], 100, changed.registry, context(folder));
		assert.deepEqual(gone, { files: [], failures: [{ number: 1, name: "changed.md", reason: "changed.md no longer exists." }] });
	});

	it("keeps the running sum of characters within the budget, one failure for each file that would pass it, and reads the rest", async () => {
		await writeFile(file("a.md"), "a".repeat(60));
		await writeFile(file("b.md"), "b".repeat(60));
		await writeFile(file("c.md"), "c".repeat(30));
		const registry = new AttachedFileRegistry();
		const read = await readAttachedFiles([{ path: file("a.md") }, { path: file("b.md") }, { path: file("c.md") }], registry);
		const [a, b, c] = documents(read.items);
		const answer = await readAttachedForSend([{ number: 1, ref: a!.ref }, { number: 2, ref: b!.ref }, { number: 3, ref: c!.ref }], 100, registry, context(folder));
		assert.deepEqual(answer.files.map(item => item.number), [1, 3]);
		assert.deepEqual(answer.failures.map(item => [item.number, item.name]), [[2, "b.md"]]);
		assert.match(answer.failures[0]!.reason, /^b\.md \(60 characters\) would take the message over the 200 000-character limit\.$/);
	});

	it("fails an unknown reference without reading anything else, and a network path that was only dropped", async () => {
		const registry = new AttachedFileRegistry();
		const unknown = await readAttachedForSend([{ number: 4, ref: "AAAAAAAAAAAA" }], 100, registry, context(folder));
		assert.deepEqual(unknown, { files: [], failures: [{ number: 4, name: "", reason: "An attached file is no longer known; attach it again." }] });
		const ref = registry.register("\\\\server\\share\\a.md", "drop");
		const share = await readAttachedForSend([{ number: 5, ref }], 100, registry, context(folder));
		assert.deepEqual(share.failures, [{ number: 5, name: "a.md", reason: "a.md is on a network share, which only the attach button may open." }]);
	});

	it("reads an empty file as an empty text", async () => {
		const empty = await attach("empty.md", "");
		const read = await readAttachedForSend([{ number: 1, ref: empty.ref }], 0, empty.registry, context(folder));
		assert.deepEqual(read.files.map(item => item.content), [""]);
		assert.deepEqual(read.failures, []);
	});
});
