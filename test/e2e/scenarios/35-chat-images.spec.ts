/**
 * Scenario: a screenshot-sized image attaches to a Chat prompt, travels to OMP, reaches the model and renders in the
 * transcript. The composer used to refuse anything over 512 KiB, which is below an ordinary screenshot; the grammar now
 * carries 5 MiB per image and 10 MiB per prompt (`MAX_CHAT_IMAGE_BYTES`, `MAX_CHAT_IMAGES_BYTES`).
 *
 * The images are noise, so they do not compress: the file sizes below are what the composer reads and the broker's stdin
 * line carries. OMP resizes an attachment before the model sees it, so the model's side is checked for presence and for
 * being smaller, not for equality.
 */
import { crc32, deflateSync } from "node:zlib";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "../support/fixtures.ts";

/** A valid RGB PNG of incompressible pixels, `width` x `height` (about `3 * width * height` bytes). */
function noisePng(width: number, height: number): Buffer {
	const rows = Buffer.alloc((width * 3 + 1) * height);
	for (let y = 0; y < height; y++) randomBytes(width * 3).copy(rows, y * (width * 3 + 1) + 1);
	const chunk = (type: string, data: Buffer): Buffer => {
		const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
		const length = Buffer.alloc(4);
		length.writeUInt32BE(data.length);
		const check = Buffer.alloc(4);
		check.writeUInt32BE(crc32(body));
		return Buffer.concat([length, body, check]);
	};
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header.set([8, 2, 0, 0, 0], 8);
	return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows, { level: 0 })), chunk("IEND", Buffer.alloc(0))]);
}

test("a 770 KB and a 4 MB screenshot attach, send, reach the model and render in the transcript", async ({ desk }, testInfo) => {
	const folder = testInfo.outputPath("images");
	await mkdir(folder, { recursive: true });
	const small = join(folder, "screenshot-770kb.png");
	const large = join(folder, "screenshot-4mb.png");
	await writeFile(small, noisePng(500, 513));
	await writeFile(large, noisePng(1200, 1160));

	const page = await desk.window("alpha-desk");
	await desk.ready(page);
	const chat = await desk.newChatSession(page, "alpha-desk");
	await chat.locator("input.omp-file-input").setInputFiles([small, large]);
	await expect(chat.locator(".omp-attachment-number"), "both files attach: neither is refused for its size").toHaveCount(2, { timeout: 60_000 });
	await expect(chat.locator(".omp-attach-error"), "no refusal text is shown").toHaveCount(0);

	await desk.send(chat, "look at these");
	const reply = chat.getByText(/Mock reply to: look at these.*\[image bytes: \d+,\d+\]/);
	await expect(reply, "the model received both images").toBeVisible({ timeout: 120_000 });
	const sizes = /\[image bytes: (\d+),(\d+)\]/.exec(await reply.innerText());
	expect(sizes, "the reply names the size of each image the model saw").not.toBeNull();
	const [seenSmall, seenLarge] = [Number(sizes![1]), Number(sizes![2])];
	expect(seenSmall, "OMP passes on an image it resized, or the original").toBeGreaterThan(0);
	expect(seenLarge, "OMP resizes a screenshot well under the 4 MB it was sent").toBeLessThan(4 * 1024 * 1024);

	await expect(chat.locator(".omp-native-image"), "the user's message renders both images").toHaveCount(2, { timeout: 60_000 });
	const loaded = await chat.locator(".omp-native-image").evaluateAll(images => images.map(image => (image instanceof HTMLImageElement ? image.naturalWidth : 0)));
	expect(loaded.every(width => width > 0), `every image decoded: ${JSON.stringify(loaded)}`).toBe(true);
});
