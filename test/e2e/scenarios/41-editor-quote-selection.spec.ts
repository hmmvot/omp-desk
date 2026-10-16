/**
 * Scenario: quoting an editor's selection into a Chat draft in a real VS Code window
 * (docs/designs/2026-10-15-quote-chat-selection.md, decision 9). The workbench owns the editor's keys and its context menu, so this
 * is the check that Alt+Q in a text editor with a selection reaches "OMP Desk: Quote Selection to Session", that the session picker
 * offers the Chat, and that the draft receives the location as inline code and the text as a fenced block (a code file) or as
 * plain quote lines (a plain-text file), the second quote after a blank line, the focus in the composer.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "../support/fixtures.ts";

/** Opens `fileName` of the folder through Quick Open and waits for its tab. */
async function openFile(page: Page, fileName: string): Promise<void> {
	await page.keyboard.press("Control+p");
	const input = page.locator(".quick-input-widget input.input");
	await expect(input).toBeVisible();
	await input.fill(fileName);
	await expect(page.locator(".quick-input-widget .monaco-list-row").first()).toContainText(fileName);
	await page.keyboard.press("Enter");
	await expect(page.locator(`.tab[aria-label^="${fileName}"]`).first()).toBeVisible();
	await expect(page.locator(".monaco-editor.focused").first()).toBeVisible();
}

/** Answers the session picker with its preselected row, the most recently focused Chat. */
async function acceptPicker(page: Page): Promise<void> {
	await expect(page.locator(".quick-input-widget")).toBeVisible();
	await page.keyboard.press("Enter");
}

test("Alt+Q in a text editor quotes its selection into the Chat draft: a code file as a fenced block, a plain-text file as plain lines", async ({ desk, state }) => {
	writeFileSync(join(state.folderA, "quote-sample.ts"), "export const a = 1;\nexport function f(x: number) {\n  return x + a;\n}\n");
	const page = await desk.window("alpha-desk");
	await desk.ready(page);
	const chat = await desk.newChatSession(page, "alpha-desk");
	const box = desk.composer(chat);
	const draft = () => desk.readDraft(box);
	await expect.poll(draft).toBe("");

	// Lines 2 and 3, selected from the start of line 2 to the start of line 4: the location counts the lines the text is on.
	await openFile(page, "quote-sample.ts");
	await page.keyboard.press("Control+Home");
	await page.keyboard.press("ArrowDown");
	await page.keyboard.press("Shift+ArrowDown");
	await page.keyboard.press("Shift+ArrowDown");
	await page.keyboard.press("Alt+q");
	await acceptPicker(page);
	await expect.poll(draft, "the location as inline code, then the code in a fenced block with the file's language").toBe(
		"> `quote-sample.ts:2-3`\n> ```ts\n> export function f(x: number) {\n>   return x + a;\n> ```\n",
	);
	await expect(box, "the focus moved to the composer").toBeFocused();

	// A plain-text file is quoted as plain lines under its location, after a blank line.
	await openFile(page, "hello.txt");
	await page.keyboard.press("Control+a");
	await page.keyboard.press("Alt+q");
	await acceptPicker(page);
	await expect.poll(draft, "the second quote goes after a blank line").toBe(
		"> `quote-sample.ts:2-3`\n> ```ts\n> export function f(x: number) {\n>   return x + a;\n> ```\n\n> `hello.txt:1`\n>\n> hello from the fixture\n",
	);

	// One Ctrl+Z takes back only the second quote.
	await box.press("Control+z");
	await expect.poll(draft).toBe("> `quote-sample.ts:2-3`\n> ```ts\n> export function f(x: number) {\n>   return x + a;\n> ```\n");
});
