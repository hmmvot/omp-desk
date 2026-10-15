/**
 * The host's reading of a drag from VS Code's Explorer or an editor tab: only a local file that is a supported image
 * within the prompt's limits comes back; everything else is one refusal sentence.
 *
 * Runner: `node --test src/host/dropped-images.test.ts`.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { MAX_CHAT_IMAGES_BYTES, MAX_CHAT_IMAGE_BYTES } from "../protocol/chat-messages.ts";
import { readDroppedImages } from "./dropped-images.ts";

const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function png(size: number): Buffer {
	const bytes = Buffer.alloc(size, 9);
	Buffer.from(PNG_HEAD).copy(bytes);
	return bytes;
}

describe("readDroppedImages", () => {
	let folder = "";
	const file = (name: string): string => join(folder, name);
	const uri = (name: string): string => pathToFileURL(file(name)).href;

	before(async () => {
		folder = await mkdtemp(join(tmpdir(), "omp-desk-dropped-"));
		await writeFile(file("small.png"), png(40));
		await writeFile(file("with space #1.png"), png(41));
		await writeFile(file("four.png"), png(4 * 1024 * 1024));
		await writeFile(file("exact.png"), png(MAX_CHAT_IMAGE_BYTES));
		await writeFile(file("exact2.png"), png(MAX_CHAT_IMAGE_BYTES));
		await writeFile(file("over.png"), png(MAX_CHAT_IMAGE_BYTES + 1));
		await writeFile(file("notes.txt"), "not an image");
		await writeFile(file("empty.png"), "");
		await writeFile(file("renamed.png"), "<html>an error page saved as png</html>");
		await mkdir(file("dir.png"));
	});
	after(async () => {
		await rm(folder, { recursive: true, force: true });
	});

	it("returns a supported image's bytes with its name and the type its signature names", async () => {
		const read = await readDroppedImages([uri("small.png"), uri("with space #1.png")]);
		assert.deepEqual(read.refusals, []);
		assert.deepEqual(read.files.map(item => [item.name, item.mimeType]), [["small.png", "image/png"], ["with space #1.png", "image/png"]]);
		assert.equal(Buffer.from(read.files[0]!.data, "base64").equals(png(40)), true);
	});

	it("carries a file of exactly the per-image limit and refuses one byte more, naming the limit", async () => {
		const exact = await readDroppedImages([uri("exact.png")]);
		assert.equal(exact.files.length, 1);
		const over = await readDroppedImages([uri("over.png")]);
		assert.deepEqual(over.files, []);
		assert.match(over.refusals[0]!, /^over\.png: 5\.0 MB exceeds the 5\.0 MB limit per image\.$/);
	});

	it("keeps the whole drop within the per-prompt limit, refusing the image that would pass it, and reads a repeated URI once", async () => {
		const read = await readDroppedImages([uri("four.png"), uri("exact.png"), uri("exact2.png"), uri("small.png"), uri("small.png")]);
		assert.deepEqual(read.files.map(item => item.name), ["four.png", "exact.png", "small.png"]);
		assert.deepEqual(read.refusals, ["exact2.png: this prompt would carry 14.0 MB of images; the limit is 10.0 MB per prompt."]);
		const total = read.files.reduce((sum, item) => sum + Buffer.from(item.data, "base64").length, 0);
		assert.ok(total <= MAX_CHAT_IMAGES_BYTES);
	});

	it("refuses what is not a supported image, one sentence each, and returns nothing for it", async () => {
		const read = await readDroppedImages([uri("notes.txt"), uri("empty.png"), uri("renamed.png"), uri("dir.png"), uri("missing.png")]);
		assert.deepEqual(read.files, []);
		assert.deepEqual(read.refusals, [
			"notes.txt: not a PNG, JPEG, GIF, or WebP image.",
			"empty.png: the file is empty.",
			"renamed.png: not a PNG, JPEG, GIF, or WebP image.",
			"dir.png: is not a file.",
			"missing.png: could not be read.",
		]);
	});

	it("reads only a local drive path: no other scheme, no network share, no device path", async () => {
		const read = await readDroppedImages([
			"https://example.com/a.png",
			"vscode-remote://ssh-remote+box/home/a.png",
			"file://server/share/a.png",
			"file:////server/share/a.png",
			"file:///relative.png",
			"not a uri",
		]);
		assert.deepEqual(read.files, []);
		assert.equal(read.refusals.length, 6);
		assert.ok(read.refusals.every(sentence => sentence.startsWith("Dropped item: ")), read.refusals.join("\n"));
	});
});
