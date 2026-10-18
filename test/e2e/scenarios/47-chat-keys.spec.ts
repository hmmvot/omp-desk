/**
 * Scenario: the keys of a Chat and of the empty session in a real VS Code window (docs/designs/2026-10-18-chat-keys-and-empty-state.md).
 * The workbench owns the keybinding table and, on Windows, the menu bar's Alt+letter mnemonics, so this is the check that:
 *
 * - Ctrl+Alt+T (thinking) and Ctrl+Alt+Y (prompt history; Alt+T and Alt+H were tried first and both open the Terminal and Help menus
 *   of the menu bar) reach Desk's commands from a Chat and do not open the Terminal or the Help menu of
 *   the menu bar (run it with `E2E_LAYOUT=minimal` for VS Code's default menu bar, and once with the default layout, whose menu is
 *   the compact one);
 * - Ctrl+/ and the composer's keyboard button open Keyboard Shortcuts filtered to `ompDesk.`, also for the key a Russian layout
 *   reports for the physical Slash key;
 * - Alt+Q in a text editor with no selection puts the caret line's location into the draft, and an untitled document is refused;
 * - a binding of Ctrl+Alt+T to another command in the user's keybindings.json puts a marker on that key in the empty session, and
 *   removing it takes the marker away.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { deskLogLines } from "../support/desk-log.ts";
import { expect, test } from "../support/fixtures.ts";

/** What the host's thinking toggle writes: one line per run, whichever way the command was run. */
const THINKING_TOGGLED = /thinking blocks: (shown|hidden) by default/;

/** A menu of the menu bar that is open: VS Code marks its top-level button `open` while its dropdown is shown. */
const OPEN_MENU = ".menubar-menu-button.open";

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

/** An earlier scenario's tabs would still be visible and take what a command inserts: each scenario starts with no editor open. */
async function closeAllEditors(page: Page): Promise<void> {
	await runCommand(page, "View: Close All Editors");
	await expect(page.locator(".editor-group-container .tab")).toHaveCount(0);
}

/** The Keyboard Shortcuts editor, and the text of its search field. */
function shortcutsEditor(page: Page): { readonly editor: Locator; readonly query: Locator; readonly tab: Locator } {
	const editor = page.locator(".keybindings-editor");
	return { editor, query: editor.locator(".keybindings-header").getByRole("textbox"), tab: page.getByRole("tab", { name: /^Keyboard Shortcuts/ }) };
}

/** Closes the Keyboard Shortcuts editor (it holds the keyboard after it opens), so the next check starts with only the Chat. */
async function closeShortcuts(page: Page): Promise<void> {
	const { editor } = shortcutsEditor(page);
	if (!await editor.isVisible()) return;
	await page.keyboard.press("Control+w");
	await expect(editor, "Keyboard Shortcuts closed").toBeHidden({ timeout: 15_000 });
}

/** Opens `fileName` of the folder through Quick Open and puts the caret in its editor. */
async function openFile(page: Page, fileName: string): Promise<void> {
	await page.keyboard.press("Control+p");
	const input = page.locator(".quick-input-widget input.input");
	await expect(input).toBeVisible();
	await input.fill(fileName);
	await expect(page.locator(".quick-input-widget .monaco-list-row").first()).toContainText(fileName);
	await page.keyboard.press("Enter");
	await expect(page.locator(`.tab[aria-label^="${fileName}"]`).first()).toBeVisible();
	const editor = page.locator(".editor-instance .monaco-editor:visible").first();
	await expect(editor).toBeVisible();
	await editor.locator(".view-lines").click();
}

test("Ctrl+Alt+T and Ctrl+Alt+Y run Desk's commands from a Chat and open no menu-bar menu; Ctrl+/ and the keyboard button open Keyboard Shortcuts filtered to ompDesk.", async ({ desk, state }) => {
	test.slow();
	const page: Page = await desk.window("alpha-desk");
	await desk.ready(page);
	await closeAllEditors(page);
	const chat = await desk.newChatSession(page, "alpha-desk");
	const box = desk.composer(chat);
	const toggles = (): number => deskLogLines(state.dataDir, THINKING_TOGGLED).length;
	const noMenu = async (why: string): Promise<void> => { await expect(page.locator(OPEN_MENU), why).toHaveCount(0); };

	// Ctrl+Alt+T twice: the thinking default is shown, then hidden again, and no menu of the menu bar opened.
	await box.click({ timeout: 15_000 });
	const before = toggles();
	await page.keyboard.press("Control+Alt+t");
	await expect.poll(toggles, { message: "Ctrl+Alt+T ran ompDesk.toggleThinking", timeout: 15_000 }).toBe(before + 1);
	await noMenu("Ctrl+Alt+T must not open the Terminal menu");
	await page.keyboard.press("Control+Alt+t");
	await expect.poll(toggles, { message: "the second Ctrl+Alt+T ran it again", timeout: 15_000 }).toBe(before + 2);
	await noMenu("a second Ctrl+Alt+T opened no menu either");
	await expect(box, "the composer kept the focus").toBeFocused();

	// Ctrl+Alt+Y with a prompt in the history: the search opens, and the Help menu does not.
	await desk.send(chat, "Remember the quokka");
	await expect(chat.getByText(/Mock reply to: Remember/), "the model answered").toBeVisible({ timeout: 120_000 });
	await box.click({ timeout: 15_000 });
	await page.keyboard.press("Control+Alt+y");
	const picker = page.locator(".quick-input-widget");
	await expect(picker.getByText("Search Prompt History"), "Ctrl+Alt+Y opened the history search").toBeVisible({ timeout: 15_000 });
	await expect(picker.locator(".monaco-list-row").filter({ hasText: "Remember the quokka" })).toHaveCount(1);
	await noMenu("Ctrl+Alt+Y must not open any menu");
	await page.keyboard.press("Escape");
	await expect(picker).toBeHidden();

	// Ctrl+/ from the composer opens Keyboard Shortcuts, filtered to the commands of the extension.
	const { editor, query } = shortcutsEditor(page);
	await box.click({ timeout: 15_000 });
	await page.keyboard.press("Control+/");
	await expect(editor, "Ctrl+/ opened Keyboard Shortcuts").toBeVisible({ timeout: 15_000 });
	await expect(query, "the search is filtered to the extension's commands").toHaveValue(/ompDesk\./);
	await expect(editor.locator(".monaco-list-row").filter({ hasText: "OMP Desk" }).first(), "the list shows the extension's commands").toBeVisible({ timeout: 30_000 });
	await closeShortcuts(page);

	// The same key on a Russian layout: the physical Slash key reports "." (Chromium on Windows), and VS Code still reads it as Ctrl+/.
	await box.click({ timeout: 15_000 });
	const cdp = await page.context().newCDPSession(page);
	const chord = { modifiers: 2, key: ".", code: "Slash", windowsVirtualKeyCode: 191, nativeVirtualKeyCode: 191 } as const;
	await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...chord });
	await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...chord });
	await expect(editor, "Ctrl+/ on a Russian layout opened Keyboard Shortcuts").toBeVisible({ timeout: 15_000 });
	await expect(query).toHaveValue(/ompDesk\./);
	await closeShortcuts(page);

	// The keyboard button of the composer's action row does the same, and so does the link of the empty session.
	await desk.newChatSession(page, "alpha-desk");
	const fresh = desk.chat(page);
	await fresh.getByRole("button", { name: "Keyboard shortcuts", exact: true }).click({ timeout: 15_000 });
	await expect(editor, "the keyboard button opened Keyboard Shortcuts").toBeVisible({ timeout: 15_000 });
	await expect(query).toHaveValue(/ompDesk\./);
	await closeShortcuts(page);
	await fresh.locator(".omp-empty-shortcuts").click({ timeout: 15_000 });
	await expect(editor, "the link of the empty session opened Keyboard Shortcuts").toBeVisible({ timeout: 15_000 });
	await expect(query).toHaveValue(/ompDesk\./);
	await closeShortcuts(page);
});

test("Alt+Q in a text editor with nothing selected puts the caret line's location into the Chat draft, and an untitled document is refused", async ({ desk, state }) => {
	writeFileSync(join(state.folderA, "caret-sample.ts"), "export const a = 1;\nexport function f(x: number) {\n  return x + a;\n}\n");
	const page: Page = await desk.window("alpha-desk");
	await desk.ready(page);
	await closeAllEditors(page);
	const chat = await desk.newChatSession(page, "alpha-desk");
	const box = desk.composer(chat);
	const draft = () => desk.readDraft(box);

	// A Chat visible in its own group takes the reference with no picker; the caret is on line 3.
	await openFile(page, "caret-sample.ts");
	await page.keyboard.press("Control+Home");
	await page.keyboard.press("ArrowDown");
	await page.keyboard.press("ArrowDown");
	await page.keyboard.press("Alt+q");
	const picker = page.locator(".quick-input-widget");
	if (await picker.isVisible()) await page.keyboard.press("Enter");
	await expect.poll(draft, "the location as inline code, no text of the file").toMatch(/^\s*`caret-sample\.ts:3`\s*$/);
	await expect(box, "the focus moved to the composer").toBeFocused();

	// An untitled document has no location: nothing is inserted, and the reason is shown.
	const before = await draft();
	await runCommand(page, "File: New Untitled Text File");
	await expect(page.locator('.tab[aria-label^="Untitled-1"]').first()).toBeVisible();
	const editor = page.locator(".editor-instance .monaco-editor:visible").first();
	await editor.locator(".view-lines").click();
	await page.keyboard.press("Alt+q");
	await expect(page.locator(".notifications-toasts, .notification-toast").getByText(/no file location/), "the refusal says why").toBeVisible({ timeout: 15_000 });
	expect(await draft(), "nothing was inserted").toBe(before);
});

test("a binding of Ctrl+Alt+T to another command in the user's keybindings.json marks the key in the empty session, and removing it takes the marker away", async ({ desk, state }) => {
	test.slow();
	const keybindings = join(state.dataDir, "User", "keybindings.json");
	mkdirSync(join(state.dataDir, "User"), { recursive: true });
	const page: Page = await desk.window("alpha-desk");
	await desk.ready(page);
	await closeAllEditors(page);
	try {
		const chat = await desk.newChatSession(page, "alpha-desk");
		const marker = chat.locator(".omp-empty-key-conflict");
		await expect(chat.locator(".omp-empty-key kbd", { hasText: /^Ctrl\+Alt\+T$/ }), "the default key is shown").toHaveCount(1, { timeout: 30_000 });
		await expect(marker, "nothing else binds the keys the empty session shows").toHaveCount(0);

		writeFileSync(keybindings, `// the user's own keys\n[\n  { "key": "ctrl+alt+t", "command": "workbench.action.terminal.toggleTerminal" }, // takes the key\n]\n`);
		await expect(marker, "the key is marked").toHaveCount(1, { timeout: 30_000 });
		await expect(marker).toHaveAttribute("title", /Ctrl\+Alt\+T may be taken by your keybindings\.json: workbench\.action\.terminal\.toggleTerminal/);
		await expect(chat.locator(".omp-empty-key kbd", { hasText: /^Ctrl\+Alt\+T$/ }), "the key itself is still Ctrl+Alt+T").toHaveCount(1);

		// A click opens Keyboard Shortcuts on that key.
		await marker.click({ timeout: 15_000 });
		const { editor, query } = shortcutsEditor(page);
		await expect(editor, "the marker opened Keyboard Shortcuts").toBeVisible({ timeout: 15_000 });
		await expect(query).toHaveValue(/@keybinding:"ctrl\+alt\+t"/);
		await closeShortcuts(page);

		// A removal of the Desk key leaves the command with none.
		writeFileSync(keybindings, `[\n  { "key": "ctrl+alt+t", "command": "-ompDesk.toggleThinking" }\n]\n`);
		await expect(marker, "no marker for a removed key").toHaveCount(0, { timeout: 30_000 });
		await expect(chat.locator(".omp-empty-key kbd", { hasText: /^Ctrl\+Alt\+T$/ }), "a removed key is not shown").toHaveCount(0, { timeout: 30_000 });

		// Back to the default: the key returns, and the marker with it gone.
		rmSync(keybindings);
		await expect(chat.locator(".omp-empty-key kbd", { hasText: /^Ctrl\+Alt\+T$/ }), "the default key is back").toHaveCount(1, { timeout: 30_000 });
		await expect(marker).toHaveCount(0);
	} finally {
		rmSync(keybindings, { force: true });
	}
});
