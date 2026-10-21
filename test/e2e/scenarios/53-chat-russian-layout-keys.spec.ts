/**
 * Scenario: every Desk keybinding of a Chat on a Russian layout, in a real VS Code window. VS Code reads a chord by the virtual key,
 * and a Cyrillic layout gives each letter key the virtual key of the Latin letter (the key that types "е" is VK_T), so a binding named
 * `ctrl+alt+t` must fire for the character "е" as it does for "t". The punctuation key is the one a layout can move (the Slash key types
 * "." and is VK_OEM_2); `Ctrl+/` has its own check in `47-chat-keys.spec.ts`. Each row presses the chord as the Russian layout reports it
 * (the Cyrillic character, the physical `code`, the virtual key of the Latin letter) and asserts what the Latin chord does.
 *
 * Commands without a cheap observable effect in a window with one mock session (Ctrl+O, Ctrl+Shift+O, Ctrl+Shift+U, Ctrl+Shift+M, F5 and
 * Alt+R retry, the Terminal editor's Ctrl+Alt+Shift+R) are named in the docs table with the same rule and are not pressed here.
 */
import type { CDPSession, Locator, Page } from "@playwright/test";
import { deskLogLines } from "../support/desk-log.ts";
import { expect, test } from "../support/fixtures.ts";

const ALT = 1, CTRL = 2, SHIFT = 8;
const THINKING_TOGGLED = /thinking blocks: (shown|hidden) by default/;

interface Chord {
	readonly name: string;
	/** The character the Russian layout reports for the physical key. */
	readonly key: string;
	readonly code: string;
	readonly vk: number;
	readonly modifiers: number;
}

const CHORDS = {
	thinking: { name: "Ctrl+Alt+T", key: "\u0435", code: "KeyT", vk: 84, modifiers: CTRL | ALT },
	history: { name: "Ctrl+Alt+Y", key: "\u043d", code: "KeyY", vk: 89, modifiers: CTRL | ALT },
	find: { name: "Ctrl+F", key: "\u0430", code: "KeyF", vk: 70, modifiers: CTRL },
	goToSession: { name: "Ctrl+Alt+Q", key: "\u0439", code: "KeyQ", vk: 81, modifiers: CTRL | ALT },
	newSession: { name: "Ctrl+Alt+N", key: "\u0442", code: "KeyN", vk: 78, modifiers: CTRL | ALT },
	resume: { name: "Ctrl+Alt+R", key: "\u043a", code: "KeyR", vk: 82, modifiers: CTRL | ALT },
	focusComposer: { name: "Ctrl+Shift+L", key: "\u0414", code: "KeyL", vk: 76, modifiers: CTRL | SHIFT },
	symbol: { name: "Ctrl+N", key: "\u0442", code: "KeyN", vk: 78, modifiers: CTRL },
	file: { name: "Ctrl+Shift+N", key: "\u0422", code: "KeyN", vk: 78, modifiers: CTRL | SHIFT },
	quote: { name: "Alt+Q", key: "\u0439", code: "KeyQ", vk: 81, modifiers: ALT },
} as const satisfies Record<string, Chord>;

async function pressRussian(cdp: CDPSession, chord: Chord): Promise<void> {
	const args = { modifiers: chord.modifiers, key: chord.key, code: chord.code, windowsVirtualKeyCode: chord.vk, nativeVirtualKeyCode: chord.vk } as const;
	await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...args });
	await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...args });
}

async function closeQuickInput(page: Page): Promise<void> {
	await page.keyboard.press("Escape");
	await expect(page.locator(".quick-input-widget")).toBeHidden({ timeout: 15_000 });
}

test("every Desk keybinding of a Chat fires for the character a Russian layout types on its key", async ({ desk, state }) => {
	test.slow();
	const page: Page = await desk.window("alpha-desk");
	await desk.ready(page);
	const chat = await desk.newChatSession(page, "alpha-desk");
	const box: Locator = desk.composer(chat);
	const cdp = await page.context().newCDPSession(page);
	const quickInput = page.locator(".quick-input-widget");
	await desk.send(chat, "Remember the **quokka** now");
	await expect(chat.getByText(/Mock reply to: Remember/), "the model answered").toBeVisible({ timeout: 120_000 });
	await box.click({ timeout: 15_000 });

	const toggles = (): number => deskLogLines(state.dataDir, THINKING_TOGGLED).length;
	const before = toggles();
	await pressRussian(cdp, CHORDS.thinking);
	await expect.poll(toggles, { message: `${CHORDS.thinking.name} ran ompDesk.toggleThinking`, timeout: 15_000 }).toBe(before + 1);

	await pressRussian(cdp, CHORDS.history);
	await expect(quickInput.getByText("Search Prompt History"), `${CHORDS.history.name} opened the history search`).toBeVisible({ timeout: 15_000 });
	await closeQuickInput(page);

	await pressRussian(cdp, CHORDS.goToSession);
	await expect(quickInput, `${CHORDS.goToSession.name} opened Go to Session`).toBeVisible({ timeout: 15_000 });
	await closeQuickInput(page);

	await box.click({ timeout: 15_000 });
	await pressRussian(cdp, CHORDS.symbol);
	await expect(quickInput, `${CHORDS.symbol.name} opened the symbol search`).toBeVisible({ timeout: 15_000 });
	await closeQuickInput(page);

	await box.click({ timeout: 15_000 });
	await pressRussian(cdp, CHORDS.file);
	await expect(quickInput, `${CHORDS.file.name} opened Go to File`).toBeVisible({ timeout: 15_000 });
	await closeQuickInput(page);

	// Ctrl+F opens the page's find bar, Ctrl+Shift+L puts the keyboard back in the composer.
	await box.click({ timeout: 15_000 });
	await pressRussian(cdp, CHORDS.find);
	await expect(chat.locator(".omp-find-input"), `${CHORDS.find.name} opened the find bar`).toBeFocused({ timeout: 15_000 });
	await page.keyboard.press("Escape");
	await expect(chat.locator(".omp-find")).toBeHidden();
	await chat.locator(".omp-transcript").click({ position: { x: 2, y: 2 } });
	await pressRussian(cdp, CHORDS.focusComposer);
	await expect(box, `${CHORDS.focusComposer.name} focused the composer`).toBeFocused({ timeout: 15_000 });

	// Alt+Q quotes the selected reply text into the draft.
	await chat.locator(".omp-md:not(.omp-user .omp-md) strong").first().evaluate(element => {
		const range = document.createRange();
		range.selectNodeContents(element);
		const selection = getSelection()!;
		selection.removeAllRanges();
		selection.addRange(range);
	});
	await pressRussian(cdp, CHORDS.quote);
	await expect.poll(() => desk.readDraft(box), { message: `${CHORDS.quote.name} quoted the selection`, timeout: 15_000 }).toMatch(/^> /);

	// New Session and Resume Session ask for a folder in a window with several, and start (or list) straight away in a window with one:
	// either way something opens, and the same chord on the Latin layout opens it too.
	const tabs = page.locator(".editor-group-container .tab");
	for (const chord of [CHORDS.newSession, CHORDS.resume]) {
		const tabsBefore = await tabs.count();
		await pressRussian(cdp, chord);
		await expect.poll(async () => (await quickInput.isVisible()) || (await tabs.count()) > tabsBefore, { message: `${chord.name} opened a picker or a session`, timeout: 30_000 }).toBe(true);
		if (await quickInput.isVisible()) await closeQuickInput(page);
	}
});
