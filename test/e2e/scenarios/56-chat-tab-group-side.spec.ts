/**
 * Scenario: `ompDesk.chatTabGroup` in a real VS Code window. With two file groups open and the first one active, a new Chat opens
 * in a group of its own at the edge the setting names (the right, then the left, then the right again after every editor was
 * closed and the emptied locked group was left behind) whatever group was active, and a file opened afterwards lands in a file
 * group, not in the Chat's. No empty group stays behind.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../support/fixtures.ts";
import { quickOpenFile, runPaletteCommand } from "../support/quick-input.ts";

const EDITOR_GROUPS = "[id='workbench.parts.editor'] .editor-group-container";

/** An earlier scenario's tabs would still be in their groups: each side starts with no editor open. */
async function closeAllEditors(page: Page): Promise<void> {
	await runPaletteCommand(page, "View: Close All Editors");
	await expect(page.locator(".editor-group-container .tab")).toHaveCount(0);
}

/** The left edge of every editor group of the main window. */
async function groupEdges(page: Page): Promise<number[]> {
	return await page.locator(EDITOR_GROUPS).evaluateAll(groups => groups.map(group => group.getBoundingClientRect().x));
}

test("a new Chat opens at the edge ompDesk.chatTabGroup names and files open on the other side", async ({ desk, state }) => {
	test.slow();
	const settingsFile = join(state.dataDir, "User", "settings.json");
	const original = readFileSync(settingsFile, "utf8");
	writeFileSync(join(state.folderA, "side-second.txt"), "a second file\n");
	const page: Page = await desk.window("alpha-desk");
	try {
		await desk.ready(page);
		for (const side of ["right", "left", "right"] as const) {
			await test.step(`the Chat group is at the ${side} edge`, async () => {
				writeFileSync(settingsFile, JSON.stringify({ ...JSON.parse(original), "ompDesk.chatTabGroup": side }, null, "\t"));
				await page.waitForTimeout(2_000);
				await closeAllEditors(page);
				await quickOpenFile(page, "hello.txt");
				// Two file groups, the first one active: a Chat opened beside the active group lands between them and has to be moved to an edge.
				await runPaletteCommand(page, "View: Split Editor Right");
				await runPaletteCommand(page, "View: Focus First Editor Group");
				await desk.newChatSession(page, "alpha-desk");
				const chatTab = page.locator(".tab[aria-label^='New session']").first();
				await expect(chatTab).toBeVisible();
				const chatGroup: Locator = page.locator(EDITOR_GROUPS).filter({ has: chatTab }).first();
				// The group is moved after the editor is reported active, a moment after its tab shows, and the emptied locked group of the last round is closed after that.
				await expect.poll(async () => {
					const box = await chatGroup.boundingBox();
					if (box === null) return -1;
					const others = (await groupEdges(page)).filter(edge => edge !== box.x);
					const atEdge = side === "right" ? others.every(edge => edge < box.x) : others.every(edge => edge > box.x);
					return atEdge ? others.length : -1;
				}, { message: `the Chat group is the ${side}most of three groups`, timeout: 30_000 }).toBe(2);

				// The Chat group is locked: the next file goes to a file group, never into the Chat's.
				await quickOpenFile(page, "side-second.txt");
				const secondTab = page.locator(".tab[aria-label^='side-second.txt']").first();
				await expect(secondTab).toBeVisible();
				const chatHandle = await chatGroup.elementHandle();
				expect(await page.locator(EDITOR_GROUPS).filter({ has: secondTab }).first().evaluate((group, chat) => group === chat, chatHandle), "the file did not open in the Chat's group").toBe(false);
			});
		}
	} finally {
		writeFileSync(settingsFile, original);
	}
});
