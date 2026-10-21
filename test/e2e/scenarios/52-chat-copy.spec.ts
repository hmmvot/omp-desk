/**
 * Scenario: copying selected Chat text in a real VS Code window. The workbench owns the clipboard commands of a webview:
 * Ctrl+C, Ctrl+Insert and the context menu's Copy all end in a message to the webview's host frame, which, when the page's
 * `document.activeElement` is the `<body>`, first focuses the last element the page focused (the composer) and then runs
 * `execCommand('copy')`. A selection made by mouse after the composer was used leaves `<body>` active, so that refocus moved
 * the selection into the empty composer and nothing was copied (on every layout). This is the check that each of the four
 * ways puts the selection on the clipboard, that the composer takes no focus, and that the selection is still there afterwards,
 * on a Latin layout and on a Russian one (the physical C key reports "с" with code KeyC).
 */
import type { CDPSession, Page } from "@playwright/test";
import { expect, test } from "../support/fixtures.ts";

const CTRL = 2;

test("Ctrl+C, Ctrl+Insert, Ctrl+С and the context menu's Copy copy the selected Chat text and leave the composer unfocused", async ({ desk }) => {
	test.slow();
	const page: Page = await desk.window("alpha-desk");
	await desk.ready(page);
	const chat = await desk.newChatSession(page, "alpha-desk");
	const box = desk.composer(chat);
	await desk.send(chat, "Copy this quokka sentence please");
	await expect(chat.getByText(/Mock reply to: Copy this/), "the model answered").toBeVisible({ timeout: 120_000 });
	const reply = chat.locator(".omp-md:not(.omp-user .omp-md) p", { hasText: /Mock reply to: Copy this/ }).first();
	const cdp: CDPSession = await page.context().newCDPSession(page);
	const chord = async (key: string, code: string, vk: number): Promise<void> => {
		const args = { modifiers: CTRL, key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk } as const;
		await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...args });
		await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...args });
	};
	const selected = (): Promise<string> => reply.evaluate(() => getSelection()?.toString() ?? "");
	const selectByMouse = async (): Promise<void> => {
		// A real drag, as the user's: the press moves the keyboard focus to the page, the drag selects.
		const rect = (await reply.boundingBox())!;
		await page.mouse.move(rect.x + 2, rect.y + rect.height / 2);
		await page.mouse.down();
		await page.mouse.move(rect.x + rect.width - 2, rect.y + rect.height / 2, { steps: 8 });
		await page.mouse.up();
		await expect.poll(selected).toContain("quokka");
		await expect(box, "the drag took the focus out of the composer").not.toBeFocused();
	};
	/** What the clipboard holds, read through a paste into the draft (which is then emptied). */
	const clipboard = async (): Promise<string> => {
		await box.click();
		await page.keyboard.press("Control+v");
		const text = await desk.readDraft(box);
		await page.keyboard.press("Control+a");
		await page.keyboard.press("Delete");
		await expect.poll(() => desk.readDraft(box)).toBe("");
		return text;
	};
	const poison = async (): Promise<void> => {
		await box.click();
		await box.fill("poison");
		await page.keyboard.press("Control+a");
		await page.keyboard.press("Control+x");
		await expect.poll(() => desk.readDraft(box)).toBe("");
	};

	const cases: { name: string; run: () => Promise<void> }[] = [
		{ name: "Ctrl+C", run: () => page.keyboard.press("Control+c") },
		{ name: "Ctrl+С on a Russian layout", run: () => chord("\u0441", "KeyC", 67) },
		{ name: "Ctrl+Insert", run: () => page.keyboard.press("Control+Insert") },
		{
			name: "the context menu's Copy",
			run: async () => {
				await reply.click({ button: "right" });
				// The item carries its key in its name ("Copy Ctrl+C"), so it is found by pattern rather than through desk.clickMenuItem.
				const item = page.locator(".monaco-menu").getByRole("menuitem", { name: /^Copy(\s+Ctrl\+C)?$/ });
				await item.hover({ timeout: 30_000 });
				await expect(item.locator("xpath=..")).toHaveClass(/focused/);
				await item.click({ timeout: 30_000 });
			},
		},
	];
	for (const { name, run } of cases) {
		await poison();
		await selectByMouse();
		// The page's own copy event, with the selection it found: VS Code's Copy fires it after any refocus of its own.
		await box.evaluate(() => {
			const seen: string[] = [];
			Object.assign(window, { copyEvents: seen });
			document.addEventListener("copy", () => { seen.push(getSelection()?.toString() ?? ""); }, { capture: true, once: true });
		});
		await run();
		const copyEvents = (): Promise<string[]> => box.evaluate(() => Reflect.get(window, "copyEvents") as string[]);
		await expect.poll(async () => (await copyEvents()).length, { message: `${name} reached the page as a copy`, timeout: 15_000 }).toBe(1);
		expect((await copyEvents())[0], `${name} found the selection when the page copied`).toContain("quokka");
		await expect(box, `${name} did not move the focus to the composer`).not.toBeFocused();
		expect(await selected(), `${name} kept the selection`).toContain("quokka");
		expect(await clipboard(), `${name} copied the selection`).toContain("Mock reply to: Copy this");
		await page.keyboard.press("Escape");
	}

	// Inside the composer its own selection is copied (the field holds the focus, so nothing is refocused): Ctrl+C on either layout and Ctrl+Insert.
	for (const { name, run } of [cases[0]!, cases[1]!, cases[2]!]) {
		await box.click();
		await box.fill("text typed in the composer");
		await page.keyboard.press("Control+a");
		await run();
		await page.keyboard.press("Delete");
		await expect.poll(() => desk.readDraft(box)).toBe("");
		await page.keyboard.press("Control+v");
		await expect.poll(() => desk.readDraft(box), { message: `${name} copied the composer's own selection` }).toBe("text typed in the composer");
		await page.keyboard.press("Control+a");
		await page.keyboard.press("Delete");
		await expect.poll(() => desk.readDraft(box)).toBe("");
	}
});
