/**
 * Scenario: quoting an editor's selection into a Chat draft in a real VS Code window
 * (docs/designs/2026-10-15-quote-chat-selection.md, decision 9). The workbench owns the editor's keys and its context menu, so this
 * is the check that Alt+Q in a text editor with a selection reaches "OMP Desk: Quote Selection to Session", that the session picker
 * offers the Chat when none is visible, and that the draft receives the location as inline code and the text as a fenced block (a code
 * file) or as plain quote lines (a plain-text file), the second quote after a blank line, the focus in the composer. With a Chat tab
 * visible in another editor group there is no picker: the quote goes straight into that composer (the addendum to decision 9).
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
	// The window is not the operating system's foreground window, so Monaco never shows its focused class; a click puts the caret, and with it editorTextFocus, in the editor.
	const editor = page.locator(".editor-instance .monaco-editor:visible").first();
	await expect(editor).toBeVisible();
	await editor.locator(".view-lines").click();
}

/** Answers the session picker with its preselected row, the most recently focused Chat. */
async function acceptPicker(page: Page): Promise<void> {
	await expect(page.locator(".quick-input-widget")).toBeVisible();
	await page.keyboard.press("Enter");
}

/** Runs a Command Palette command by the full label of its row (a category, a colon and the title). */
async function runCommand(page: Page, label: string): Promise<void> {
	await page.keyboard.press("Control+Shift+p");
	const input = page.locator(".quick-input-widget input.input");
	await expect(input).toBeVisible();
	await input.fill(`>${label}`);
	const row = page.locator(`.quick-input-widget .monaco-list-row[aria-label^="${label}, "], .quick-input-widget .monaco-list-row[aria-label="${label}"]`);
	await expect(row).toBeVisible();
	await row.click();
}

/** An earlier scenario's Chat tabs would still be visible and take the quote: each scenario starts with no editor open. */
async function closeAllEditors(page: Page): Promise<void> {
	await runCommand(page, "View: Close All Editors");
	await expect(page.locator(".editor-group-container .tab")).toHaveCount(0);
}

/** The layout depends on where the Chat was placed: join every group into one and put the file's tab in front, so the Chat is open but not shown. */
async function showFileInOneGroup(page: Page, fileName: string): Promise<void> {
	await runCommand(page, "View: Join All Editor Groups");
	await page.locator(`.tab[aria-label^="${fileName}"]`).first().click();
	const editor = page.locator(".editor-instance .monaco-editor:visible").first();
	await expect(editor).toBeVisible();
	await editor.locator(".view-lines").click();
}

test("Alt+Q in a text editor quotes its selection into the Chat draft: a code file as a fenced block, a plain-text file as plain lines", async ({ desk, state }) => {
	writeFileSync(join(state.folderA, "quote-sample.ts"), "export const a = 1;\nexport function f(x: number) {\n  return x + a;\n}\n");
	const page = await desk.window("alpha-desk");
	await desk.ready(page);
	await closeAllEditors(page);
	const chat = await desk.newChatSession(page, "alpha-desk");
	const box = desk.composer(chat);
	const draft = () => desk.readDraft(box);
	await expect.poll(draft).toBe("");

	// Lines 2 and 3, selected from the start of line 2 to the start of line 4: the location counts the lines the text is on.
	await openFile(page, "quote-sample.ts");
	await showFileInOneGroup(page, "quote-sample.ts");
	await expect(box, "the Chat is open behind the file's tab, so the picker is what asks").toBeHidden();
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

	// Send the first quote with a comment: the transcript shows the location as a file link (a code span that is one path, with a line range).
	await box.pressSequentially("why?");
	await box.press("Enter");
	const sent = chat.locator(".omp-user").last();
	await expect(sent.locator("blockquote")).toHaveCount(1, { timeout: 60_000 });
	const link = sent.locator("blockquote .omp-file-link");
	await expect(link, "the location is drawn as a file link").toHaveCount(1, { timeout: 30_000 });
	await expect(link).toHaveText("quote-sample.ts:2-3");
	await expect(link).toHaveAttribute("data-file-target", "quote-sample.ts:2-3");
});

test("Alt+Q with a Chat visible in another editor group quotes into that composer without the session picker", async ({ desk, state }) => {
	writeFileSync(join(state.folderA, "quote-sample.ts"), "export const a = 1;\nexport function f(x: number) {\n  return x + a;\n}\n");
	const page = await desk.window("alpha-desk");
	await desk.ready(page);
	await closeAllEditors(page);
	const chat = await desk.newChatSession(page, "alpha-desk");
	const box = desk.composer(chat);
	const draft = () => desk.readDraft(box);
	await expect.poll(draft).toBe("");

	// One group holding the Chat and the file, the file in front; splitting it right gives the file a group of its own, and a click on the Chat tab brings the Chat to the front of the left group.
	await openFile(page, "quote-sample.ts");
	await showFileInOneGroup(page, "quote-sample.ts");
	await page.keyboard.press("Control+\\");
	await page.locator('.tab[aria-label^="New session"]').first().click();
	await expect(box, "the Chat is visible in the left group").toBeVisible();
	const editor = page.locator(".editor-instance .monaco-editor:visible").first();
	await expect(editor, "the file's editor is in the right group").toBeVisible();
	await editor.locator(".view-lines").click();
	await page.keyboard.press("Control+Home");
	await page.keyboard.press("ArrowDown");
	await page.keyboard.press("Shift+ArrowDown");
	await page.keyboard.press("Shift+ArrowDown");
	await page.keyboard.press("Alt+q");
	await expect.poll(draft, "the quote went straight into the visible composer").toBe(
		"> `quote-sample.ts:2-3`\n> ```ts\n> export function f(x: number) {\n>   return x + a;\n> ```\n",
	);
	await expect(page.locator(".quick-input-widget"), "no session picker was shown").toBeHidden();
	await expect(box, "the focus moved to the composer").toBeFocused();
});
