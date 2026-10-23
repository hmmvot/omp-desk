/**
 * Setup steps that go through VS Code's quick input (Command Palette, Quick Open): the specs that are not about those keys
 * use these, so one place holds what the quick input of a hidden-desktop window needs.
 *
 * Two things can spoil an attempt, and neither is the behaviour under test:
 *   - a Chat webview that holds the keyboard focus swallows F1, and a palette opened from it can lose the focus back to the page
 *     (the webview host restores the page's focus), so the text typed next lands in the composer: the title bar takes the focus
 *     first, and an attempt whose row never shows is made again;
 *   - Quick Open's file list can lack a file created a moment ago, which a new Quick Open lists.
 */
import { expect, type Locator, type Page } from "@playwright/test";

const TITLE_BAR = "[id='workbench.parts.titlebar']";

/** One attempt of a quick input: focus off the webview, the chord, the text, and the first row that must show. */
async function attempt(page: Page, chord: string, text: string, firstRow: Locator, what: string): Promise<void> {
	await page.locator(TITLE_BAR).click({ position: { x: 5, y: 5 } });
	await page.keyboard.press(chord);
	const input = page.locator(".quick-input-widget input.input");
	await expect(input, `${chord} opens the quick input`).toBeVisible({ timeout: 10_000 });
	await input.fill(text);
	await expect(firstRow, what).toBeVisible({ timeout: 10_000 });
}

/**
 * Runs a Command Palette command by the full label of its row (a category, a colon and the title). The row is clicked inside the
 * attempt: a palette that closes between its row showing and the click (the focus going back to the page) is opened again.
 */
export async function runPaletteCommand(page: Page, label: string): Promise<void> {
	const row = page.locator(`.quick-input-widget .monaco-list-row[aria-label^="${label}, "], .quick-input-widget .monaco-list-row[aria-label="${label}"]`).first();
	await expect(async () => {
		await attempt(page, "Control+Shift+p", `>${label}`, row, `the Command Palette lists ${label}`);
		await row.click({ timeout: 5_000 });
	}, `the Command Palette runs ${label}`).toPass({ timeout: 60_000, intervals: [500] });
}

/** Opens `fileName` of the window's folder through Quick Open and waits for its tab. */
export async function quickOpenFile(page: Page, fileName: string): Promise<void> {
	const firstRow = page.locator(".quick-input-widget .monaco-list-row").first().filter({ hasText: fileName });
	await expect(async () => {
		await attempt(page, "Control+p", fileName, firstRow, `Quick Open lists ${fileName}`);
		await page.keyboard.press("Enter");
		await expect(page.locator(`.tab[aria-label^="${fileName}"]`).first()).toBeVisible({ timeout: 10_000 });
	}, `Quick Open opens ${fileName}`).toPass({ timeout: 90_000, intervals: [1_000] });
}
