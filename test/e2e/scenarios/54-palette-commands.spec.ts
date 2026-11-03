/**
 * Scenario: the Command Palette access to OMP Desk's commands (0.5.0). Ctrl+Alt+P, the contributed `OMP Desk: Show Commands`, opens Quick Open
 * with the value ">OMP Desk: ", which the Command Palette filters on the label `<category>: <title>`: the list holds this extension's commands
 * and no command of VS Code or another extension, and none of the row and view commands the manifest hides from the palette. The workbench
 * owns the keybinding table, the quick input and the `enablement` filter, so a unit test of the manifest cannot say that the chord reaches the
 * command from a text editor, from a focused Chat and from the integrated terminal, or what the filter really lists.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "../support/fixtures.ts";
import { REPO_ROOT } from "../support/launcher.ts";

interface Manifest {
	readonly contributes: {
		readonly commands: readonly { readonly command: string; readonly title: string; readonly category?: string; readonly enablement?: string }[];
		readonly menus: { readonly commandPalette: readonly { readonly command: string; readonly when: string }[] };
	};
}
const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as Manifest;
const hidden = new Set(manifest.contributes.menus.commandPalette.filter(entry => entry.when === "false").map(entry => entry.command));
const label = (command: { category?: string; title: string }): string => `${command.category}: ${command.title}`;
/** The commands the palette may offer under the prefix: the ones the manifest does not hide. The palette also drops a command whose `enablement` is false. */
const offered = manifest.contributes.commands.filter(command => !hidden.has(command.command));
/** The ones that no `enablement` can take away while the window is idle (the clauses on the catalog and the editor transition are false then). */
const always = offered.filter(command => command.enablement === undefined || /^!ompDesk\.(catalogPending|sessionTransitionPending)$/.test(command.enablement));
/** VS Code adds `<container>: Focus on <View> View` for every contributed view, in this category; a `when: false` palette entry of the manifest does not take them out (measured in 1.141). */
const FOCUS_COMMANDS = ["Context", "Extensions", "MCP", "Sessions", "Settings", "Skills", "Tools"].map(view => `OMP Desk: Focus on ${view} View`);

test("Ctrl+Alt+P lists the commands of the OMP Desk category and no others, from a text editor, a focused Chat and the terminal", async ({ desk }, testInfo) => {
	const page: Page = await desk.window("alpha-desk");
	await desk.ready(page);
	const chat = await desk.newChatSession(page, "alpha-desk");
	const picker = page.locator(".quick-input-widget");
	const input = picker.locator(".quick-input-box input");
	const rows = picker.locator("#quickInput_list .monaco-list-row");

	/** Every row the open palette lists, by scrolling the list from the first row to the last one (it renders only the rows in view). */
	const listedLabels = async (): Promise<string[]> => {
		const labels = new Set<string>();
		await picker.locator("#quickInput_list").hover();
		await page.mouse.wheel(0, -100_000);
		for (let step = 0; step < 40; step += 1) {
			const seen = await rows.evaluateAll(elements => elements.map(element => element.getAttribute("aria-label") ?? ""));
			const before = labels.size;
			for (const text of seen) labels.add(text);
			if (step > 0 && labels.size === before) break;
			await page.mouse.wheel(0, 300);
		}
		return [...labels].filter(text => text !== "").map(text => text.replace(/, .*$/, ""));
	};

	/** The chord from wherever the keyboard is: the palette opens prefilled and lists commands. */
	const openFrom = async (where: string): Promise<void> => {
		await page.keyboard.press("Control+Alt+p");
		await expect(input, `Ctrl+Alt+P from ${where} opens the quick input`).toBeVisible({ timeout: 15_000 });
		await expect(input, `Ctrl+Alt+P from ${where} prefills the Command Palette query`).toHaveValue(">OMP Desk: ");
		await expect(rows.first(), `the palette lists commands from ${where}`).toBeVisible({ timeout: 15_000 });
	};
	const close = async (): Promise<void> => {
		await page.keyboard.press("Escape");
		await expect(picker).toBeHidden();
	};
	const hiddenRows = ["OMP Desk: Rename", "OMP Desk: Close", "OMP Desk: Delete", "OMP Desk: Forget", "OMP Desk: Open", "OMP Desk: Pin Folder", "OMP Desk: Refresh Skills"];

	// From a text editor: Quick Open puts hello.txt in an editor that takes the keyboard focus.
	await page.locator("[id='workbench.parts.titlebar']").click({ position: { x: 5, y: 5 } });
	await page.keyboard.press("Control+p");
	await input.fill("hello.txt");
	await expect(picker.getByRole("option", { name: /hello\.txt/ }).first()).toBeVisible({ timeout: 60_000 });
	await page.keyboard.press("Enter");
	const file = page.locator(".monaco-editor[data-uri$='hello.txt']");
	await expect(file, "hello.txt is open in a text editor").toBeVisible({ timeout: 30_000 });
	await file.locator(".view-lines").click();
	await expect(page.locator(".monaco-editor.focused[data-uri$='hello.txt']"), "the text editor holds the keyboard focus").toBeVisible();
	await openFrom("a text editor");

	const fromEditor = await listedLabels();
	await page.screenshot({ path: testInfo.outputPath("palette-omp-desk-commands.png") });
	expect(fromEditor.filter(text => !text.startsWith("OMP Desk: ")), "every listed row is a command of the category").toEqual([]);
	const allowed = new Set([...offered.map(label), ...FOCUS_COMMANDS]);
	expect(fromEditor.filter(text => !allowed.has(text)), "no listed row is a command the manifest hides").toEqual([]);
	expect(always.map(label).filter(text => !fromEditor.includes(text)), "every command that is always enabled is listed").toEqual([]);
	for (const shown of ["OMP Desk: New Session", "OMP Desk: Go to Session…", "OMP Desk: Show Commands", "OMP Desk: Open OMP Settings", ...FOCUS_COMMANDS]) expect(fromEditor).toContain(shown);
	for (const absent of hiddenRows) expect(fromEditor, `${absent} needs a row or a view and is not offered`).not.toContain(absent);
	expect(fromEditor, "a Chat command is not offered while no Chat is in front").not.toContain("OMP Desk: Find in Chat");
	await close();
	await expect(page.locator(".monaco-editor.focused[data-uri$='hello.txt']"), "closing the palette returns the focus to the editor").toBeVisible();

	// From the Chat composer, which is a webview that forwards the chord to the workbench: the Chat's own commands join the list.
	const composer = desk.composer(chat);
	await desk.send(chat, "palette scenario");
	await expect(chat.getByText("Mock reply to: palette scenario")).toBeVisible({ timeout: 120_000 });
	await composer.click();
	await expect(composer).toBeFocused();
	await openFrom("a focused Chat");
	const fromChat = await listedLabels();
	await page.screenshot({ path: testInfo.outputPath("palette-omp-desk-commands-chat.png") });
	expect(fromChat.filter(text => !text.startsWith("OMP Desk: ")), "every row listed from a Chat is a command of the category").toEqual([]);
	for (const shown of ["OMP Desk: Find in Chat", "OMP Desk: Compact Conversation…", "OMP Desk: Show/Hide All Thinking"]) expect(fromChat, `${shown} is listed beside a Chat`).toContain(shown);
	expect(fromChat, "Redraw Terminal is a Terminal command").not.toContain("OMP Desk: Redraw Terminal");
	await close();

	// From the integrated terminal, which would otherwise take the chord for itself.
	await page.keyboard.press("Control+Backquote");
	const terminal = page.locator(".terminal-wrapper .xterm-helper-textarea");
	await expect(terminal, "the integrated terminal holds the keyboard focus").toBeFocused({ timeout: 60_000 });
	await openFrom("the integrated terminal");
	await close();
	await expect(terminal, "closing the palette returns the focus to the terminal").toBeFocused();

	// The terminal this scenario opened is not left behind for the next one.
	await page.locator("[id='workbench.parts.panel']").getByRole("tab", { name: /Terminal/ }).first().click();
	await page.keyboard.press("F1");
	await input.fill(">Terminal: Kill the Active Terminal Instance");
	await page.keyboard.press("Enter");
	await expect(terminal).toHaveCount(0, { timeout: 30_000 });
});
