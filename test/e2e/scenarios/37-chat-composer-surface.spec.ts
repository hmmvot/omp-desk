/**
 * Scenario: the Chat composer is a contenteditable surface with its own undo stack
 * (docs/designs/2026-10-15-composer-contenteditable-surface.md). In a real VS Code window the workbench also sees every
 * key the page sees, so this is the check that Ctrl+Z, Ctrl+Y, Ctrl+Shift+Z, Ctrl+X, Ctrl+C and Ctrl+V reach the page's
 * own handlers and that the draft is not changed twice, and that the caret survives leaving and re-entering the field
 * by click, by Tab and by the host's focus command.
 *
 * `E2E_SHOTS_DIR` names a folder that also receives screenshots (a draft with a code block, a draft with chips).
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Locator } from "@playwright/test";
import { expect, test } from "../support/fixtures.ts";

/** The caret's offset in a one-line draft, or -1 when the selection is not inside the field. */
function caretOffset(box: Locator): Promise<number> {
	return box.evaluate(element => {
		const selection = getSelection();
		if (selection === null || selection.rangeCount === 0 || selection.anchorNode === null || !element.contains(selection.anchorNode)) return -1;
		const range = document.createRange();
		range.selectNodeContents(element);
		range.setEnd(selection.anchorNode, selection.anchorOffset);
		return range.toString().length;
	});
}

test("the composer's own undo, clipboard and caret survive the workbench's key handling", async ({ desk }) => {
	const page = await desk.window("alpha-desk");
	await desk.ready(page);
	const chat = await desk.newChatSession(page, "alpha-desk");
	const box = desk.composer(chat);
	const draft = () => desk.readDraft(box);

	await box.click();
	await box.pressSequentially("one two");
	await box.press("Shift+Enter");
	await box.pressSequentially("three");
	await expect.poll(draft).toBe("one two\nthree");

	// Undo and redo through the real keys; the workbench's own Undo must not run on top of the page's.
	await box.press("Control+z");
	await expect.poll(draft, "one Ctrl+Z takes back the typing run after the newline").toBe("one two\n");
	await box.press("Control+z");
	await expect.poll(draft).toBe("one two");
	await box.press("Control+y");
	await expect.poll(draft).toBe("one two\n");
	await box.press("Control+Shift+z");
	await expect.poll(draft).toBe("one two\nthree");
	await expect(box).toBeFocused();

	// Clipboard: cut deletes once, paste brings the text back as plain text.
	await box.press("Control+a");
	await box.press("Control+x");
	await expect.poll(draft, "cut removes the selection once").toBe("");
	await box.press("Control+v");
	await expect.poll(draft, "paste inserts the cut text").toBe("one two\nthree");
	await box.press("Control+z");
	await expect.poll(draft, "one Ctrl+Z takes the paste back").toBe("");
	await box.press("Control+Shift+z");
	await expect.poll(draft).toBe("one two\nthree");
	await box.press("Control+a");
	await box.press("Control+c");
	await expect.poll(draft, "copy changes nothing").toBe("one two\nthree");

	// The caret survives leaving the field and coming back by click, Tab and the host's focus command.
	await box.fill("hello world");
	await expect.poll(draft, "fill, as desk.send uses it, reaches the draft").toBe("hello world");
	await box.press("End");
	for (let step = 0; step < 6; step++) await box.press("ArrowLeft");
	await expect.poll(() => caretOffset(box)).toBe(5);

	await box.press("Tab");
	await expect(box).not.toBeFocused();
	await page.keyboard.press("Shift+Tab");
	await expect(box, "Shift+Tab returns to the field").toBeFocused();
	await expect.poll(() => caretOffset(box), "re-entering by keyboard keeps the caret").toBe(5);

	await chat.locator(".omp-transcript").click({ position: { x: 5, y: 5 } });
	await expect(box).not.toBeFocused();
	await page.keyboard.press("Control+Shift+L");
	await expect(box, "the host's focus command focuses the field").toBeFocused();
	await expect.poll(() => caretOffset(box), "the host's focus command keeps the caret").toBe(5);

	await box.click({ position: { x: 4, y: 10 } });
	await expect.poll(() => caretOffset(box), "a click puts the caret where it lands").toBe(0);

	const shots = process.env.E2E_SHOTS_DIR;
	if (shots) {
		await mkdir(shots, { recursive: true });
		await box.fill("");
		await box.pressSequentially("Why does this loop skip the last item? It prints every row but the final one.");
		await box.press("Shift+Enter");
		await box.pressSequentially("```ts");
		await box.press("Enter");
		await box.pressSequentially("for (let i = 0; i < items.length - 1; i++) {");
		await box.press("Enter");
		await box.press("Tab");
		await box.pressSequentially("console.log(items[i]);");
		await box.press("Enter");
		await box.press("Shift+Tab");
		await box.pressSequentially("}");
		await writeFile(join(shots, "composer-prose-and-block.png"), await chat.locator(".omp-composer").screenshot());
		await box.press("Control+Enter");
		await expect.poll(draft, "a sent draft is cleared").toBe("");
	}
});
