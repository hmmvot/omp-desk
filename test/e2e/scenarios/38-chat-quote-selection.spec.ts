/**
 * Scenario: quoting Chat text into the draft in a real VS Code window (docs/designs/2026-10-15-quote-chat-selection.md). The
 * workbench sees every key and owns the webview context menu, so this is the check that Alt+Q reaches the page's quote path, that the
 * "Quote Selection" item is offered in a menu the workbench renders, that it inserts the same text, and that a
 * sent draft carries the `>` lines to the model and shows as a quote followed by the comment.
 *
 * User messages render through the same Markdown component as replies, so the test messages are short Markdown the mock server
 * records whole (it keeps the first 200 characters).
 */
import type { FrameLocator, Locator } from "@playwright/test";
import { expect, test } from "../support/fixtures.ts";

/** Selects all the text of the first element `selector` matches in the transcript, as a user's drag would. */
async function select(chat: FrameLocator, selector: string): Promise<void> {
	await chat.locator(".omp-transcript").click({ position: { x: 2, y: 2 } });
	await chat.locator(selector).first().evaluate(element => {
		const range = document.createRange();
		range.selectNodeContents(element);
		const selection = getSelection()!;
		selection.removeAllRanges();
		selection.addRange(range);
	});
}

test("selected Chat text is quoted into the draft by Alt+Q and the context menu, and a sent quote reaches the model and renders as a quote", async ({ desk, state }) => {
	const page = await desk.window("alpha-desk");
	await desk.ready(page);
	const chat = await desk.newChatSession(page, "alpha-desk");
	const box: Locator = desk.composer(chat);
	const draft = () => desk.readDraft(box);

	await desk.send(chat, "Check **bold** and `code` here");
	await expect(chat.getByText(/Mock reply to: Check/), "the model answered").toBeVisible({ timeout: 120_000 });
	await expect.poll(draft).toBe("");

	// No Quote button is drawn: the key and the menu are the only triggers.
	await select(chat, ".omp-user .omp-md strong");
	await expect(chat.getByRole("button", { name: /^Quote/ })).toHaveCount(0);

	// Alt+Q quotes the source of exactly the selection and puts the caret under it, with the focus in the composer.
	await page.keyboard.press("Alt+q");
	await expect.poll(draft, "the quote and its line break").toBe("> **bold**\n");
	await expect(box, "the focus is in the composer").toBeFocused();

	// Alt+Q with a second selection, after a comment: the quote lands at the end after a blank line.
	await box.pressSequentially("my comment");
	await select(chat, ".omp-user .omp-md code");
	await page.keyboard.press("Alt+q");
	await expect.poll(draft).toBe("> **bold**\nmy comment\n\n> `code`\n");
	await expect(box).toBeFocused();

	// Enter in a quote is a line break that carries the prefix, Enter on its empty line lets go of the quote, Shift+Tab leaves at once, and none of them sends.
	await box.press("ArrowUp");
	await box.press("End");
	await box.press("Enter");
	await expect.poll(draft, "Enter continues the quote").toBe("> **bold**\nmy comment\n\n> `code`\n> \n");
	await box.press("Enter");
	await expect.poll(draft, "Enter on the empty quote line leaves it").toBe("> **bold**\nmy comment\n\n> `code`\n\n");
	await box.press("Control+z");
	await box.press("Control+z");
	await expect.poll(draft).toBe("> **bold**\nmy comment\n\n> `code`\n");
	await box.press("Shift+Tab");
	await expect.poll(draft, "Shift+Tab adds a plain line after the quote line").toBe("> **bold**\nmy comment\n\n> `code`\n\n");
	await expect(box, "the focus stayed in the composer").toBeFocused();
	await box.press("Control+z");
	await expect.poll(draft).toBe("> **bold**\nmy comment\n\n> `code`\n");

	// One Ctrl+Z takes back only the second quote; the first quote's remove button keeps the comment under it.
	await box.press("Control+z");
	await expect.poll(draft).toBe("> **bold**\nmy comment");
	await chat.getByRole("button", { name: /^Remove quote/ }).first().click();
	await expect.poll(draft, "the quote and its line break went, the comment stayed").toBe("my comment");

	// The context menu of the selection offers Quote Selection and inserts the same text.
	await select(chat, ".omp-user .omp-md strong");
	await chat.locator(".omp-user .omp-md strong").first().click({ button: "right" });
	// The item carries its key in its name ("Quote Selection Alt+Q"), so it is found by prefix rather than through desk.clickMenuItem.
	const item = page.locator(".monaco-menu").getByRole("menuitem", { name: /^Quote Selection/ });
	await item.hover({ timeout: 30_000 });
	await expect(item.locator("xpath=..")).toHaveClass(/focused/);
	await item.click({ timeout: 30_000 });
	await expect.poll(draft).toBe("my comment\n\n> **bold**\n");

	// Send: the model receives the `>` lines and the comment, and the transcript shows a quote followed by the comment paragraph.
	await box.pressSequentially("why this?");
	await expect.poll(draft).toBe("my comment\n\n> **bold**\nwhy this?");
	await box.press("Enter");
	await expect(chat.getByText(/Mock reply to: my comment/), "the draft was sent and answered").toBeVisible({ timeout: 120_000 });
	const sent = chat.locator(".omp-user").filter({ hasText: "why this?" });
	await expect(sent.locator("blockquote")).toHaveCount(1);
	await expect(sent.locator("blockquote strong")).toHaveText("bold");
	await expect(sent.locator("blockquote + p"), "the comment under the quote is its own paragraph, not part of the quote").toHaveText("why this?");
	const requests: { lastUserText: string }[] = await (await fetch(`${state.mockUrl}/__requests`)).json();
	expect(requests.some(request => request.lastUserText === "my comment\n\n> **bold**\nwhy this?")).toBe(true);
});
