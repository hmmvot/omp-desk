/**
 * Scenario: Ctrl+Alt+N (New Session) and Ctrl+Alt+R (Resume Session) work from anywhere. They carry no `when` clause, so
 * the chord has to reach the workbench from a text editor, from the Chat webview (which forwards the keys it does not
 * handle itself) and from the integrated terminal (where VS Code's own Ctrl+Alt+R is Run Recent Command, so the
 * contributed binding has to win there); both commands then run as they do from the Sessions rows.
 */
import { expect, test } from "../support/fixtures.ts";

test("Ctrl+Alt+R opens the Resume picker and Ctrl+Alt+N starts a session, from a text editor, a focused Chat and the terminal", async ({ desk }) => {
	const page = await desk.window("alpha-desk");
	await desk.ready(page);

	// A session that has a file, so Resume has something to list.
	const first = await desk.newChatSession(page, "alpha-desk");
	await desk.send(first, "keys scenario");
	await expect(first.getByText("Mock reply to: keys scenario")).toBeVisible();

	const panels = page.locator("iframe.webview:not([src*='purpose=webviewView'])");
	const picker = page.locator(".quick-input-widget");
	const resumePicker = picker.getByText(/Resume an OMP session in alpha-desk/);
	const composer = desk.chat(page).getByRole("combobox", { name: "Message OMP" });

	/** Ctrl+Alt+R: the folder's saved sessions, in the Resume picker (one folder is shown, so no folder question comes first). */
	const resumeFrom = async (where: string): Promise<void> => {
		await page.keyboard.press("Control+Alt+r");
		await expect(resumePicker, `Ctrl+Alt+R from ${where} opens the Resume picker`).toBeVisible({ timeout: 30_000 });
		await page.keyboard.press("Escape");
		await expect(resumePicker).toBeHidden();
	};

	/** Ctrl+Alt+N: with one folder shown the session starts at once, and its Chat panel is one more editor. */
	const startFrom = async (where: string): Promise<void> => {
		const before = await panels.count();
		await page.keyboard.press("Control+Alt+n");
		await expect.poll(async () => await panels.count(), { message: `Ctrl+Alt+N from ${where} opens a new Chat panel`, timeout: 30_000 }).toBeGreaterThan(before);
		await expect(composer).toBeVisible({ timeout: 30_000 });
	};

	// From a text editor: Quick Open puts hello.txt in an editor that holds the keyboard focus. The title bar takes the
	// focus off the Chat page first, as Desk.reloadWindow does.
	await page.locator("[id='workbench.parts.titlebar']").click({ position: { x: 5, y: 5 } });
	await page.keyboard.press("Control+p");
	await picker.locator(".quick-input-box input").fill("hello.txt");
	await expect(picker.getByRole("option", { name: /hello\.txt/ }).first()).toBeVisible({ timeout: 60_000 });
	await page.keyboard.press("Enter");
	const file = page.locator(".monaco-editor[data-uri$='hello.txt']");
	await expect(file, "hello.txt is open in a text editor").toBeVisible({ timeout: 30_000 });
	// The file opens beside the Chat, whose webview may keep the focus: a click puts it in the text.
	await file.locator(".view-lines").click();
	const editor = page.locator(".monaco-editor.focused[data-uri$='hello.txt']");
	await expect(editor, "the text editor holds the keyboard focus").toBeVisible();
	await resumeFrom("a text editor");
	await expect(editor, "dismissing the picker returns the focus to the editor").toBeVisible();
	await startFrom("a text editor");

	// From the Chat composer, which is a webview: the page forwards the chord to the workbench.
	await composer.click();
	await expect(composer).toBeFocused();
	await resumeFrom("a focused Chat");
	await startFrom("a focused Chat");

	// From the integrated terminal, which would otherwise take the chord for itself.
	await page.keyboard.press("Control+Backquote");
	const terminal = page.locator(".terminal-wrapper .xterm-helper-textarea");
	await expect(terminal, "the integrated terminal holds the keyboard focus").toBeFocused({ timeout: 60_000 });
	await resumeFrom("the integrated terminal");
	await expect(terminal, "dismissing the picker returns the focus to the terminal").toBeFocused();
	await startFrom("the integrated terminal");

	// The terminal this scenario opened is not left behind for the next one.
	await page.locator("[id='workbench.parts.panel']").getByRole("tab", { name: /Terminal/ }).first().click();
	await page.keyboard.press("F1");
	await picker.locator(".quick-input-box input").fill(">Terminal: Kill the Active Terminal Instance");
	await page.keyboard.press("Enter");
	await expect(terminal).toHaveCount(0, { timeout: 30_000 });
});
