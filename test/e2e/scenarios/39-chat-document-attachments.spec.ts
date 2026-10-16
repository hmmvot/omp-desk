/**
 * Scenario: documents attach to a Chat prompt like images do (docs/designs/2026-10-16-chat-document-attachments.md). A
 * 100 000-character Markdown file dragged from the Explorer (the page learns only its `file:` URI; the host reads it) is sent
 * while OMP is idle, a file with no path is pasted and sent as a steer while a turn runs, and the model receives each file's
 * whole text in a block, with U+200B before every sigil OMP would act on (decision 25) while the transcript shows the original.
 * Each message shows one closed row per file; the rows survive a Reload Window, and a rewind puts the chips back.
 *
 * The attach button opens a native dialog a hidden-desktop run cannot drive, so the page's pick path is covered by the
 * Chromium suite; here the same attach goes through a drop and a paste.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "../support/fixtures.ts";
import { FULL_USER_TEXT_LIMIT, type RecordedRequest } from "../fixtures/mock-openai-server.ts";

const ZERO_WIDTH_SPACE = "\u200b";

/** A Markdown file of just over 100 000 characters whose first lines hold every sigil OMP acts on, and whose last line is `END-OF-DOC`. */
function bigDocument(): string {
	const lines = ["# Attach probe", "see @src/a.ts and ^fast and +5 and /skill:probe here"];
	for (let line = 1; lines.join("\n").length < 100_000; line++) lines.push(`line ${String(line).padStart(5, "0")} of the attach probe`);
	lines.push("END-OF-DOC");
	return lines.join("\n");
}

async function requests(mockUrl: string): Promise<RecordedRequest[]> {
	return await (await fetch(`${mockUrl}/__requests`)).json();
}

test("a dropped and a pasted document reach the model whole and escaped, show as closed rows, and survive a reload and a rewind", async ({ desk, state }) => {
	expect(FULL_USER_TEXT_LIMIT, "the mock keeps a message with a 100 000-character file whole").toBeGreaterThan(110_000);
	const content = bigDocument();
	expect(content.length).toBeGreaterThan(100_000);
	const folder = join(state.folderA, "attach-docs");
	mkdirSync(folder, { recursive: true });
	const stamp = Date.now().toString(36);
	const name = `attach-probe-${stamp}.md`;
	const file = join(folder, name);
	writeFileSync(file, content);
	try {
		const page = await desk.window("alpha-desk");
		await desk.ready(page);
		const chat = await desk.newChatSession(page, "alpha-desk");
		const box = desk.composer(chat);

		// A drop from the Explorer: the tile and the marker appear, the draft holds the marker, no text is shown.
		await desk.dropUris(box, [pathToFileURL(file).href]);
		const tiles = chat.getByRole("list", { name: "attachments" }).locator("li.omp-attachment[data-file-number]");
		await expect(tiles, "the dropped file attached as a document").toHaveCount(1, { timeout: 60_000 });
		await expect.poll(() => desk.readDraft(box), "the marker is in the draft").toContain(`[File #1: ${name}]`);
		await box.press("Control+End");
		await box.pressSequentially(` summarise-${stamp}`);
		await chat.getByRole("button", { name: "Send message" }).click();

		// The model got the whole file in one block, escaped; nothing was cut at 50 KiB.
		let sent: RecordedRequest | undefined;
		await expect.poll(async () => (sent = (await requests(state.mockUrl)).find(request => request.fullUserText.includes(`summarise-${stamp}`))) !== undefined, { timeout: 120_000, message: "the model received the message" }).toBe(true);
		const text = sent!.fullUserText;
		expect(text.replaceAll("\\\\", "/"), "the block names the file by its path").toContain(`<file path="attach-docs/${name}" n="1" chars="`);
		expect(text, "the file's last line reached the model").toContain("END-OF-DOC");
		expect(text.length, "the whole file is there").toBeGreaterThan(100_000);
		for (const token of ["@src/a.ts", "^fast", "+5", "/skill:probe"]) {
			expect(text, `${token} is escaped with U+200B`).toContain(` ${ZERO_WIDTH_SPACE}${token}`);
		}
		expect(text, "no @ mention is left bare").not.toMatch(/(^|[\s(["'`{<])@src\/a\.ts/);

		// The transcript shows the file as one closed row with the original text, not the escaped one.
		const rows = chat.locator(".omp-file-row");
		await expect(rows, "one row for the one file").toHaveCount(1, { timeout: 60_000 });
		await expect(rows.first().locator("details")).not.toHaveAttribute("open", "");
		await expect(chat.locator(".omp-file-row-body"), "a closed row draws no file text").toHaveCount(0);
		await rows.first().locator("summary").click();
		const body = chat.locator(".omp-file-row-body").first();
		await expect(body).toContainText("# Attach probe");
		expect(await body.innerText(), "the original text is shown, without the inserted characters").not.toContain(ZERO_WIDTH_SPACE);
		await expect(body).toContainText("@src/a.ts");
		await rows.first().locator("summary").click();
		await expect(chat.locator(".omp-file-row-body")).toHaveCount(0);

		// A file with no path, pasted while a turn runs and sent with Enter, steers it.
		await expect(chat.getByText(/Mock reply to: .*summarise-/)).toBeVisible({ timeout: 120_000 });
		await desk.send(chat, `[slow] ${"keep the turn running a while ".repeat(6)}`);
		const busy = desk.composerWhileBusy(chat);
		await expect(chat.getByRole("button", { name: "Stop the running turn" }), "a turn is running").toBeVisible({ timeout: 60_000 });
		const note = `steer note ${stamp}\n@plans/b.md and ^fast\n`;
		await desk.pasteFiles(busy, [{ name: "steer-note.txt", type: "text/plain", bytes: Buffer.from(note) }]);
		await expect(chat.getByRole("list", { name: "attachments" }).locator("li.omp-attachment[data-file-number]"), "the pasted file attached").toHaveCount(1, { timeout: 30_000 });
		await busy.press("Control+End");
		await busy.pressSequentially(" use it");
		await busy.press("Enter");
		let steered: RecordedRequest | undefined;
		await expect.poll(async () => (steered = (await requests(state.mockUrl)).find(request => request.fullUserText.includes(`steer note ${stamp}`))) !== undefined, { timeout: 120_000, message: "the steer reached the model" }).toBe(true);
		expect(steered!.fullUserText, "a file with no path travels as a named block").toContain(`<file name="steer-note.txt" n="1" chars="`);
		expect(steered!.fullUserText, "its sigils are escaped too").toContain(`\n${ZERO_WIDTH_SPACE}@plans/b.md and ${ZERO_WIDTH_SPACE}^fast`);
		await expect(chat.locator(".omp-file-row"), "both messages show their row").toHaveCount(2, { timeout: 60_000 });

		// Reload Window: the history is read again from the session file, and the rows are rebuilt closed with the original text.
		const after = await desk.reloadWindow(page, "alpha-desk");
		const reloaded = desk.chat(after);
		await expect(reloaded.locator(".omp-file-row"), "the rows survive a reload").toHaveCount(2, { timeout: 90_000 });
		await expect(reloaded.locator(".omp-file-row-body")).toHaveCount(0);
		await reloaded.locator(".omp-file-row summary").nth(1).click();
		const reopened = reloaded.locator(".omp-file-row-body").first();
		await expect(reopened).toContainText("steer note");
		expect(await reopened.innerText()).not.toContain(ZERO_WIDTH_SPACE);

		// A rewind to the first message puts its file back as a chip and a tile, held (the text is the one that was sent).
		await reloaded.getByRole("button", { name: "Rewind to here" }).first().click();
		await reloaded.getByRole("group", { name: "Rewind the conversation" }).getByRole("button", { name: "Rewind", exact: true }).click();
		await expect(reloaded.getByRole("list", { name: "attachments" }).locator("li.omp-attachment[data-file-number='1']"), "the rewind restored the file as a tile").toHaveCount(1, { timeout: 90_000 });
		await expect.poll(() => desk.readDraft(desk.composer(reloaded)), "and its marker").toContain(`[File #1: ${name}]`);
	} finally {
		rmSync(folder, { recursive: true, force: true });
	}
});
