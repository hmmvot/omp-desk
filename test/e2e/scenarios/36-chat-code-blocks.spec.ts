/**
 * Scenario: a fenced code block typed into the Chat composer of a real VS Code window. Inside the block `Enter` is a newline
 * that keeps the indentation (it does not send), `Tab` indents and keeps the focus in the composer, `Shift+Tab` outdents,
 * and `Ctrl+Enter` sends; outside it `Tab` still moves the focus. VS Code's workbench also sees every one of these key
 * presses (its webview script forwards them), so this is the check that none of its own bindings answers a key the page
 * handled (docs/designs/2026-10-15-composer-code-blocks.md).
 *
 * `E2E_SHOTS_DIR` names a folder that also receives screenshots of the composer with the block, for the design's smoke record.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "../support/fixtures.ts";

const CODE = [
	"export function touchedLines(text: string, start: number, end: number) {",
	"    const from = lineStartOf(text, start);",
	"    const lastStart = lineStartOf(text, end);",
	"    return { from, lastStart };",
	"}",
];

test("a code block typed in the composer edits like an editor and sends with Ctrl+Enter", async ({ desk }) => {
	const page = await desk.window("alpha-desk");
	await desk.ready(page);
	const chat = await desk.newChatSession(page, "alpha-desk");
	const box = desk.composer(chat);
	const prose = "Why does touchedLines in src/webview/lib/code-fence.ts leave out the last line of a selection?";

	await box.click();
	await box.pressSequentially(prose);
	await box.press("Shift+Enter");
	await box.pressSequentially("```ts");
	await box.press("Enter");
	await expect.poll(() => desk.readDraft(box), "Enter after the opening fence supplies the closing one").toBe(`${prose}\n\`\`\`ts\n\n\`\`\``);
	await expect(chat.getByRole("status").filter({ hasText: "Code block" }), "the keys are listed while the caret is in the block").toBeVisible();

	await box.pressSequentially(CODE[0]!);
	await box.press("Enter");
	await box.press("Tab");
	await box.pressSequentially("const from = lineStartOf(text, start);");
	await box.press("Enter");
	await box.pressSequentially("const lastStart = lineStartOf(text, end);");
	await box.press("Enter");
	await box.pressSequentially("return { from, lastStart };");
	await box.press("Enter");
	await box.press("Shift+Tab");
	await box.pressSequentially("}");
	const draft = `${prose}\n\`\`\`ts\n${CODE.join("\n")}\n\`\`\``;
	await expect.poll(() => desk.readDraft(box), "Enter kept the indentation, Tab indented, Shift+Tab outdented").toBe(draft);
	await expect(box, "none of those keys moved the focus").toBeFocused();
	await expect(chat.locator(".omp-composer-input .omp-line--code"), "the block's lines (fences included) have the band").toHaveCount(CODE.length + 2);
	const fonts = await box.evaluate(element => ({ prose: getComputedStyle(element.children[0]!).fontFamily, code: getComputedStyle(element.querySelector(".omp-line--code")!).fontFamily }));
	expect(fonts.code, "only the block is set in the editor font; the prose keeps the UI font").not.toBe(fonts.prose);

	const shots = process.env.E2E_SHOTS_DIR;
	if (shots) {
		await mkdir(shots, { recursive: true });
		await writeFile(join(shots, "composer-code-block.png"), await chat.locator(".omp-composer").screenshot());
		await writeFile(join(shots, "chat-page.png"), await page.screenshot());
	}

	await box.press("Control+Enter");
	await expect(chat.getByText(/Mock reply to: Why does touchedLines/), "the draft was sent and the model answered").toBeVisible({ timeout: 120_000 });
	await expect.poll(() => desk.readDraft(box), "a sent draft is cleared").toBe("");

	// Outside a block Tab still leaves the composer; inside one, Shift+Tab with nothing to outdent is the way out.
	await box.click();
	await box.press("Tab");
	await expect(box).not.toBeFocused();
	await box.click();
	await box.pressSequentially("```");
	await box.press("Enter");
	await box.press("Tab");
	await expect.poll(() => desk.readDraft(box)).toBe("```\n    \n```");
	await expect(box).toBeFocused();
	await box.press("Shift+Tab");
	await expect.poll(() => desk.readDraft(box)).toBe("```\n\n```");
	await box.press("Shift+Tab");
	await expect(box, "nothing left to outdent: the focus moves on").not.toBeFocused();
});
