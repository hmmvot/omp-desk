/**
 * Scenario: Find in Chat in a real VS Code window (docs/designs/2026-10-17-chat-find.md). The workbench sees every key before a
 * webview page does anything with it and owns the keybinding table, so this is the check that Ctrl+F opens the find bar from the
 * composer, from the transcript and with nothing focused, on a layout that types another script for the F key, that the contributed
 * keybinding reaches the host command, that typing counts matches, and that the Command Palette entry opens the same bar.
 */
import type { Page } from "@playwright/test";
import { deskLogLines } from "../support/desk-log.ts";
import { expect, test } from "../support/fixtures.ts";
import { runPaletteCommand } from "../support/quick-input.ts";

/** The line the host's Find in Chat command writes: one per run, whether the key, the palette or the menu ran it. */
const HOST_RAN = /find-in-chat asked from a VS Code command/;

test("Ctrl+F opens the Chat find bar from the composer, the transcript, an unfocused page and a Cyrillic layout, and typing counts matches", async ({ desk, state }) => {
	const page: Page = await desk.window("alpha-desk");
	await desk.ready(page);
	const chat = await desk.newChatSession(page, "alpha-desk");
	const box = desk.composer(chat);

	await desk.send(chat, "Find the quokka and the quokka");
	await expect(chat.getByText(/Mock reply to: Find/), "the model answered").toBeVisible({ timeout: 120_000 });
	const find = chat.locator(".omp-find");
	const field = find.getByRole("textbox", { name: "Find in conversation" });
	const hostRuns = (): number => deskLogLines(state.dataDir, HOST_RAN).length;
	/** The host's command runs a moment after the page has handled the same press and posts the find action back, so a bar closed before that lands is opened again by it. */
	const hostRanTimes = async (count: number, message: string): Promise<void> => {
		await expect.poll(hostRuns, { message, timeout: 10_000 }).toBeGreaterThanOrEqual(count);
	};

	// From the composer. VS Code's keybinding table sees the same press and runs the contributed command.
	const ranBefore = hostRuns();
	await box.click();
	await page.keyboard.press("Control+f");
	await expect(find, "Ctrl+F in the composer opens the bar").toBeVisible({ timeout: 10_000 });
	await expect(field, "the field has the focus").toBeFocused();
	await hostRanTimes(ranBefore + 1, "the contributed keybinding ran ompDesk.findInChat");
	await page.keyboard.type("quokka");
	await expect(field, "the second arrival of the press (the host's action) did not reselect and swallow the typing").toHaveValue("quokka");
	await expect(find.getByRole("status"), "the matches are counted").toHaveText(/\d+ of \d+/, { timeout: 10_000 });
	await page.keyboard.press("Escape");
	await expect(find).toHaveCount(0);
	await expect(box, "the focus is back in the composer").toBeFocused();

	// From the transcript.
	await chat.locator(".omp-transcript").click({ position: { x: 2, y: 2 } });
	await page.keyboard.press("Control+f");
	await expect(find, "Ctrl+F in the transcript opens the bar").toBeVisible({ timeout: 10_000 });
	await expect(field).toBeFocused();
	await expect(field, "the previous query is kept").toHaveValue("quokka");
	await page.keyboard.type("Mock");
	await expect(field, "typing replaced the selected query").toHaveValue("Mock");
	await expect(find.getByRole("status")).toHaveText(/\d+ of \d+/, { timeout: 10_000 });
	await hostRanTimes(ranBefore + 2, "the keybinding ran for the press in the transcript");
	await page.keyboard.press("Escape");
	await expect(find).toHaveCount(0);

	// With nothing focused in the page.
	await chat.locator("body").evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
	await page.keyboard.press("Control+f");
	await expect(find, "Ctrl+F with nothing focused in the page opens the bar").toBeVisible({ timeout: 10_000 });
	await hostRanTimes(ranBefore + 3, "the keybinding ran for the press with nothing focused");
	await page.keyboard.press("Escape");
	await expect(find).toHaveCount(0);

	// A non-Latin layout (Russian): the key reports "а" for the physical F key, as Chromium does on Windows; VS Code itself still reads it as Ctrl+F.
	await chat.locator(".omp-transcript").click({ position: { x: 2, y: 2 } });
	const cdp = await page.context().newCDPSession(page);
	const chord = { modifiers: 2, key: "а", code: "KeyF", windowsVirtualKeyCode: 70, nativeVirtualKeyCode: 70 } as const;
	await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...chord });
	await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...chord });
	await expect(find, "Ctrl+F on a Cyrillic layout opens the bar").toBeVisible({ timeout: 10_000 });
	await expect(field).toBeFocused();
	await hostRanTimes(ranBefore + 4, "the keybinding ran for the Cyrillic press");
	await page.keyboard.press("Escape");
	await expect(find).toHaveCount(0);

	// The Command Palette entry opens the same bar.
	const paletteBefore = hostRuns();
	await runPaletteCommand(page, "OMP Desk: Find in Chat");
	await expect(find, "the palette command opens the bar").toBeVisible({ timeout: 10_000 });
	await expect.poll(hostRuns, { timeout: 10_000 }).toBeGreaterThan(paletteBefore);
});
