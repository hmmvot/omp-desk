/**
 * Scenario: the unsent Chat draft survives Reload Window (docs/designs/2026-11-03-keep-the-chat-draft-across-a-window-reload.md).
 * A draft with typed text, a document dragged in from the Explorer (linked by path: the page knows only a host reference) and a
 * pasted image is saved to the extension's private storage, and after the window reloads the revived editor holds the text, both
 * attachments and their markers. Sending it reaches the model with the file's text and the image bytes, and the record is deleted,
 * so a second reload shows an empty composer.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import { randomBytes } from "node:crypto";
import { expect, test } from "../support/fixtures.ts";
import type { RecordedRequest } from "../fixtures/mock-openai-server.ts";

/** A valid RGB PNG of incompressible pixels, `width` x `height`. */
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

async function requests(mockUrl: string): Promise<RecordedRequest[]> {
	return await (await fetch(`${mockUrl}/__requests`)).json();
}

test("a draft with text, a linked file and an image comes back after Reload Window, is sent whole, and a second reload shows it empty", async ({ desk, state }) => {
	const folder = join(state.folderA, "draft-reload");
	mkdirSync(folder, { recursive: true });
	const stamp = Date.now().toString(36);
	const name = `draft-probe-${stamp}.md`;
	const file = join(folder, name);
	writeFileSync(file, `# Draft probe ${stamp}\nEND-OF-DRAFT-PROBE\n`);
	const store = join(state.dataDir, "User", "globalStorage", "hmmvot.omp-desk", "drafts");
	const records = (suffix: string): string[] => existsSync(store) ? readdirSync(store).filter(entry => entry.endsWith(suffix)) : [];
	try {
		const page = await desk.window("alpha-desk");
		await desk.ready(page);
		const chat = await desk.newChatSession(page, "alpha-desk");
		const box = desk.composer(chat);
		const tiles = (frame: typeof chat) => frame.getByRole("list", { name: "attachments" }).locator("li.omp-attachment");

		await box.click();
		await box.pressSequentially(`remember ${stamp} `);
		await desk.dropUris(box, [pathToFileURL(file).href]);
		await expect(tiles(chat), "the dropped file attached").toHaveCount(1, { timeout: 60_000 });
		await desk.pasteFiles(box, [{ name: "shot.png", type: "image/png", bytes: noisePng(64, 48) }]);
		await expect(tiles(chat), "the pasted image attached").toHaveCount(2, { timeout: 30_000 });
		const typed = await desk.readDraft(box);
		expect(typed).toContain(`remember ${stamp}`);
		expect(typed).toContain(`[File #1: ${name}]`);
		expect(typed).toMatch(/\[Image #\d+/);

		// The page saves a moment after the last change; the host keeps two files for the editor.
		await expect.poll(() => [records(".draft.json").length, records(".images.json").length], { timeout: 30_000, message: "the draft reached the private store" }).toEqual([1, 1]);

		const after = await desk.reloadWindow(page, "alpha-desk");
		const reloaded = desk.chat(after);
		const restoredBox = desk.composer(reloaded);
		await expect.poll(() => desk.readDraft(restoredBox), { timeout: 90_000, message: "the draft is back after the reload" }).toBe(typed);
		await expect(tiles(reloaded), "with its two attachments").toHaveCount(2, { timeout: 30_000 });

		// What came back is a real draft: the file is read again by path and the image travels as an image.
		await reloaded.getByRole("button", { name: "Send message" }).click();
		let sent: RecordedRequest | undefined;
		await expect.poll(async () => (sent = (await requests(state.mockUrl)).find(request => request.fullUserText.includes(`remember ${stamp}`))) !== undefined, { timeout: 120_000, message: "the model received the restored draft" }).toBe(true);
		expect(sent!.fullUserText, "the linked file was read after the reload").toContain("END-OF-DRAFT-PROBE");
		expect(sent!.imageBytes.length, "one image").toBe(1);
		expect(sent!.imageBytes[0], "the image is the pasted one, not an empty file").toBeGreaterThan(1000);
		await expect.poll(() => [records(".draft.json").length, records(".images.json").length], { timeout: 30_000, message: "the send deleted the record" }).toEqual([0, 0]);

		const again = await desk.reloadWindow(after, "alpha-desk");
		const second = desk.chat(again);
		await expect(second.getByText(new RegExp(`Mock reply to: .*remember ${stamp}`)), "the conversation is back").toBeVisible({ timeout: 90_000 });
		expect(await desk.readDraft(desk.composer(second)), "a sent draft is not restored").toBe("");
		await expect(tiles(second)).toHaveCount(0);
	} finally {
		rmSync(folder, { recursive: true, force: true });
	}
});
