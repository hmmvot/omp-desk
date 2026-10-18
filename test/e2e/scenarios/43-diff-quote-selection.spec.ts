/**
 * Scenario: quoting a selection from a diff editor in a real VS Code window
 * (docs/designs/2026-10-15-quote-chat-selection.md, decision 10). A side of a diff is a document of its own: the working file (`file:`) or
 * a Git version (`git:`, the Git extension's query `{"path","ref"}`), and the quote names the file and the lines of the side the focus is
 * in, with the version after ` @ ` for a Git side. This checks the key and the editor's right-click menu on both sides of the Source
 * Control diff of a changed file and of a staged file, of a commit's changes in the multi-file diff editor and of a diff of two plain
 * files, the left side of a file that is staged and then changed again, the inline view, and that a sent Git location is plain code and not a link to the file on disk.
 *
 * Measured here and recorded in the design: the deleted lines of an inline diff are drawn by VS Code as view-zone text, not as editor
 * text, so no editor selection (`editorHasSelection`) exists there and the key does nothing.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../support/fixtures.ts";

const git = (cwd: string, ...args: string[]): string => execFileSync("git", ["-c", "core.autocrlf=false", ...args], { cwd, encoding: "utf8", windowsHide: true }).trim();

/** Runs a Command Palette command by the full label of its row (a category, a colon and the title). */
async function runCommand(page: Page, label: string): Promise<void> {
	await page.keyboard.press("Control+Shift+p");
	const input = page.locator(".quick-input-widget input.input");
	await expect(input).toBeVisible();
	await input.fill(`>${label}`);
	const row = page.locator(`.quick-input-widget .monaco-list-row[aria-label^="${label}, "], .quick-input-widget .monaco-list-row[aria-label="${label}"]`).first();
	await expect(row).toBeVisible();
	await row.click();
}

/** Opens `fileName` of the folder through Quick Open and waits for its tab. */
async function openFile(page: Page, fileName: string): Promise<void> {
	await page.keyboard.press("Control+p");
	const input = page.locator(".quick-input-widget input.input");
	await expect(input).toBeVisible();
	await input.fill(fileName);
	await expect(page.locator(".quick-input-widget .monaco-list-row").first()).toContainText(fileName);
	await page.keyboard.press("Enter");
	await expect(page.locator(`.tab[aria-label^="${fileName}"]`).first()).toBeVisible();
}

const MAIN_LINES = ["// app", "export const a = 1;", "export function f(x: number) {", "  return x + a;", "}", 'export const tail = "end";', ""];

test("Alt+Q and the right-click menu quote either side of a diff with its file, its lines and its Git version", async ({ desk, state }) => {
	test.setTimeout(240_000);
	// The repository sits in a folder of the window's folder, so the locations are relative to the session's folder and Git finds it by its scan.
	const repo = join(state.folderA, "diff-repo");
	mkdirSync(repo, { recursive: true });
	git(repo, "init", "-b", "main");
	git(repo, "config", "user.email", "e2e@example.invalid");
	git(repo, "config", "user.name", "e2e");
	for (const name of ["diff-app.ts", "diff-staged.ts", "diff-history.ts", "diff-both.ts"]) writeFileSync(join(repo, name), MAIN_LINES.join("\n"));
	git(repo, "add", ".");
	git(repo, "commit", "-m", "first");
	const parent = git(repo, "rev-parse", "HEAD");
	writeFileSync(join(repo, "diff-history.ts"), ["// history", "// second commit", ...MAIN_LINES.slice(1)].join("\n"));
	git(repo, "commit", "-am", "second");
	const head = git(repo, "rev-parse", "HEAD");
	const [parentShort, headShort] = [parent.slice(0, 7), head.slice(0, 7)];
	// The working tree differs from HEAD in the lines before and in the lines of `export const a`: line 3 of each side is another text.
	writeFileSync(join(repo, "diff-app.ts"), ["// app", "// edited", "// edited again", "export const a = 2;", ...MAIN_LINES.slice(2)].join("\n"));
	writeFileSync(join(repo, "diff-staged.ts"), ["// staged", "// staged too", ...MAIN_LINES.slice(1)].join("\n"));
	git(repo, "add", "diff-staged.ts");
	// diff-both.ts is staged and then changed again: its working-tree diff reads the left side (`~`) from the index, not from HEAD.
	writeFileSync(join(repo, "diff-both.ts"), ["// both staged", "// both staged too", ...MAIN_LINES.slice(1)].join("\n"));
	git(repo, "add", "diff-both.ts");
	writeFileSync(join(repo, "diff-both.ts"), ["// both changed", "// both changed again", ...MAIN_LINES.slice(1)].join("\n"));
	writeFileSync(join(repo, "diff-a.txt"), "alpha one\nalpha two\nalpha three\n");
	writeFileSync(join(repo, "diff-b.txt"), "beta one\nalpha two\nbeta three\n");

	const userDir = join(state.dataDir, "User");
	const settingsFile = join(userDir, "settings.json");
	const originalSettings = readFileSync(settingsFile, "utf8");
	const setSettings = (extra: Record<string, unknown>): void => { writeFileSync(settingsFile, JSON.stringify({ ...JSON.parse(originalSettings), ...extra })); };
	// A diff in the narrow editor group beside the Chat would switch to the inline view by itself; the side-by-side steps ask for two columns.
	setSettings({ "diffEditor.useInlineViewWhenSpaceIsLimited": false, "diffEditor.renderSideBySide": true });
	try {
		const page = await desk.window("alpha-desk");
		await desk.ready(page);
		await runCommand(page, "View: Close All Editors");
		const chat = await desk.newChatSession(page, "alpha-desk");
		const box = desk.composer(chat);
		const draft = () => desk.readDraft(box);
		await expect.poll(draft).toBe("");

		/** The main lines of a side, not the view zones the inline view draws the deleted lines in. */
		const side = (which: "original" | "modified"): Locator => page.locator(`.monaco-diff-editor .editor.${which} .lines-content > .view-lines`).first();
		/** Puts the caret in a side and selects `count` lines from the line after `skip` lines, by keys, so the selection is the editor's own. */
		const select = async (which: "original" | "modified", skip: number, count: number): Promise<void> => {
			await side(which).click();
			await page.keyboard.press("Control+Home");
			for (let i = 0; i < skip; i++) await page.keyboard.press("ArrowDown");
			for (let i = 0; i < count; i++) await page.keyboard.press("Shift+ArrowDown");
		};
		const clear = async (): Promise<void> => {
			await box.click();
			await page.keyboard.press("Control+a");
			await page.keyboard.press("Delete");
			await expect.poll(draft).toBe("");
		};
		/** Alt+Q in the side, then the draft must be exactly `quote`; the draft is emptied for the next step. */
		const quoteWithKey = async (which: "original" | "modified", skip: number, count: number, quote: string): Promise<void> => {
			await select(which, skip, count);
			await page.keyboard.press("Alt+q");
			await expect.poll(draft, `${which} side`).toBe(quote);
			await clear();
		};
		/** The same through the editor's right-click menu, on the first selected line (found by its text: the DOM order of an editor's lines is not the order of the document). */
		const quoteWithMenu = async (which: "original" | "modified", skip: number, count: number, quote: string): Promise<void> => {
			await select(which, skip, count);
			const firstSelectedLine = quote.split("\n")[2]!.slice(2);
			await side(which).locator(".view-line").filter({ hasText: firstSelectedLine }).first().click({ button: "right", position: { x: 30, y: 5 } });
			// The item's accessible name carries its keybinding too (Alt+Q), so it is found by its label.
			const item = page.locator(".monaco-menu .action-label", { hasText: /^Quote Selection to Session$/ });
			await item.hover();
			await expect(item.locator("xpath=ancestor::li[1]")).toHaveClass(/focused/);
			// The mouse click on a hovered item was dropped now and then (the menu closed and nothing ran); Enter runs the item the hover focused.
			await page.keyboard.press("Enter");
			await expect.poll(draft, `${which} side, menu`).toBe(quote);
			await clear();
		};
		const closeDiff = async (): Promise<void> => {
			await side("modified").click();
			// Ctrl+W closes what has the focus, and the Chat is where clear() left it: the focus must have moved into the diff first.
			await expect(page.locator(".monaco-diff-editor .editor.modified .monaco-editor.focused")).toBeVisible();
			await page.keyboard.press("Control+w");
		};
		const code = (location: string, ...lines: string[]): string => `> \`${location}\`\n> \`\`\`ts\n${lines.map(line => `> ${line}\n`).join("")}> \`\`\`\n`;

		await test.step("a changed file: the left side is HEAD (the file is not staged), the right side is the file", async () => {
			await openFile(page, "diff-app.ts");
			await runCommand(page, "Git: Open Changes");
			await expect(page.locator('.tab[aria-label*="Working Tree"]').first()).toBeVisible({ timeout: 60_000 });
			await expect(page.locator(".monaco-diff-editor")).toBeVisible();
			await quoteWithKey("original", 2, 2, code(`diff-repo/diff-app.ts:3-4 @ HEAD (${headShort})`, "export function f(x: number) {", "  return x + a;"));
			await quoteWithKey("modified", 2, 2, code("diff-repo/diff-app.ts:3-4", "// edited again", "export const a = 2;"));
			await quoteWithMenu("original", 2, 2, code(`diff-repo/diff-app.ts:3-4 @ HEAD (${headShort})`, "export function f(x: number) {", "  return x + a;"));
			await quoteWithMenu("modified", 2, 2, code("diff-repo/diff-app.ts:3-4", "// edited again", "export const a = 2;"));
			await closeDiff();
		});

		await test.step("a staged file: HEAD on the left, the index on the right", async () => {
			await openFile(page, "diff-staged.ts");
			await runCommand(page, "Git: Open Changes");
			await expect(page.locator('.tab[aria-label*="Index"]').first()).toBeVisible({ timeout: 60_000 });
			await quoteWithKey("original", 2, 2, code(`diff-repo/diff-staged.ts:3-4 @ HEAD (${headShort})`, "export function f(x: number) {", "  return x + a;"));
			await quoteWithKey("modified", 2, 2, code("diff-repo/diff-staged.ts:3-4 @ index", "export const a = 1;", "export function f(x: number) {"));
			await quoteWithMenu("original", 2, 2, code(`diff-repo/diff-staged.ts:3-4 @ HEAD (${headShort})`, "export function f(x: number) {", "  return x + a;"));
			await quoteWithMenu("modified", 2, 2, code("diff-repo/diff-staged.ts:3-4 @ index", "export const a = 1;", "export function f(x: number) {"));
			await closeDiff();
		});

		await test.step("a file staged and then changed again: the left side of the working-tree diff is the index", async () => {
			await openFile(page, "diff-both.ts");
			await runCommand(page, "Git: Open Changes");
			await expect(page.locator('.tab[aria-label*="Working Tree"]').first()).toBeVisible({ timeout: 60_000 });
			await quoteWithKey("original", 2, 2, code("diff-repo/diff-both.ts:3-4 @ index", "export const a = 1;", "export function f(x: number) {"));
			await quoteWithKey("modified", 2, 2, code("diff-repo/diff-both.ts:3-4", "export const a = 1;", "export function f(x: number) {"));
			await closeDiff();
		});

		await test.step("a commit's changes in the multi-file diff editor: both sides are Git versions at commits", async () => {
			// What `git.viewCommit` opens (read from the Git extension of VS Code 1.142): the workbench's multi-file diff editor over `git:` documents whose ref is the full hash of the parent and of the commit. A keybinding calls that command with the same payload.
			const fsPath = join(repo, "diff-history.ts").replace(/^[A-Z]:/, drive => drive.toLowerCase());
			const gitUri = (ref: string) => ({ scheme: "git", path: `/${fsPath.replaceAll("\\", "/")}`, query: JSON.stringify({ path: fsPath, ref }) });
			const multiDiff = { multiDiffSourceUri: { scheme: "scm-history-item", path: `${repo.replaceAll("\\", "/")}/${parent}..${head}` }, title: "second", resources: [{ originalUri: gitUri(parent), modifiedUri: gitUri(head) }] };
			writeFileSync(join(userDir, "keybindings.json"), JSON.stringify([{ key: "ctrl+shift+f10", command: "_workbench.openMultiDiffEditor", args: multiDiff }]));
			await expect(async () => {
				await page.keyboard.press("Control+Shift+F10");
				await expect(page.locator(".tab", { hasText: "second" }).first()).toBeVisible({ timeout: 4_000 });
			}).toPass({ timeout: 30_000, intervals: [1_000] });
			await expect(page.locator(".monaco-diff-editor")).toBeVisible();
			await quoteWithKey("original", 2, 2, code(`diff-repo/diff-history.ts:3-4 @ ${parentShort}`, "export function f(x: number) {", "  return x + a;"));
			await quoteWithKey("modified", 2, 2, code(`diff-repo/diff-history.ts:3-4 @ ${headShort}`, "export const a = 1;", "export function f(x: number) {"));
			await quoteWithMenu("original", 2, 2, code(`diff-repo/diff-history.ts:3-4 @ ${parentShort}`, "export function f(x: number) {", "  return x + a;"));
			await quoteWithMenu("modified", 2, 2, code(`diff-repo/diff-history.ts:3-4 @ ${headShort}`, "export const a = 1;", "export function f(x: number) {"));
			await closeDiff();
		});

		await test.step("a diff shown inline: the file's lines quote, and the deleted lines are not editor text", async () => {
			setSettings({ "diffEditor.useInlineViewWhenSpaceIsLimited": false, "diffEditor.renderSideBySide": false });
			await page.waitForTimeout(2_000);
			await openFile(page, "diff-app.ts");
			await runCommand(page, "Git: Open Changes");
			await expect(page.locator('.tab[aria-label*="Working Tree"]').first()).toBeVisible({ timeout: 60_000 });
			await expect(page.locator(".monaco-diff-editor .editor.modified .view-zones .view-line"), "the deleted line is drawn in a view zone").toHaveCount(1, { timeout: 30_000 });
			await quoteWithKey("modified", 2, 2, code("diff-repo/diff-app.ts:3-4", "// edited again", "export const a = 2;"));
			await quoteWithMenu("modified", 2, 2, code("diff-repo/diff-app.ts:3-4", "// edited again", "export const a = 2;"));
			// The one deleted line is text in a view zone: a triple click selects it in the page, but the editor has no selection, so the key finds nothing to quote.
			const deleted = page.locator(".monaco-diff-editor .editor.modified .view-zones .view-line").first();
			await expect(deleted).toHaveText("export const a = 1;");
			await deleted.click({ clickCount: 3 });
			expect((await page.evaluate(() => String(getSelection()))).replaceAll("\u00a0", " ")).toContain("export const a = 1;");
			await page.keyboard.press("Alt+q");
			await page.waitForTimeout(2_000);
			expect(await draft(), "no quote was made from a deleted line").toBe("");
			await expect(page.locator(".quick-input-widget")).toBeHidden();
			await closeDiff();
			setSettings({ "diffEditor.useInlineViewWhenSpaceIsLimited": false, "diffEditor.renderSideBySide": true });
			await page.waitForTimeout(2_000);
		});

		await test.step("two plain files: each side is its own file on disk", async () => {
			await openFile(page, "diff-a.txt");
			await runCommand(page, "File: Compare Active File With...");
			const input = page.locator(".quick-input-widget input.input");
			await input.fill("diff-b.txt");
			await expect(page.locator(".quick-input-widget .monaco-list-row").first()).toContainText("diff-b.txt");
			await page.keyboard.press("Enter");
			await expect(page.locator(".monaco-diff-editor")).toBeVisible({ timeout: 30_000 });
			await quoteWithKey("original", 0, 2, "> `diff-repo/diff-a.txt:1-2`\n>\n> alpha one\n> alpha two\n");
			await quoteWithKey("modified", 0, 2, "> `diff-repo/diff-b.txt:1-2`\n>\n> beta one\n> alpha two\n");
			await quoteWithMenu("original", 0, 2, "> `diff-repo/diff-a.txt:1-2`\n>\n> alpha one\n> alpha two\n");
			await quoteWithMenu("modified", 0, 2, "> `diff-repo/diff-b.txt:1-2`\n>\n> beta one\n> alpha two\n");
			await closeDiff();
		});

		await test.step("a sent Git location is plain code, not a link to the file on disk", async () => {
			await openFile(page, "diff-app.ts");
			await runCommand(page, "Git: Open Changes");
			await expect(page.locator('.tab[aria-label*="Working Tree"]').first()).toBeVisible({ timeout: 60_000 });
			await select("original", 2, 2);
			await page.keyboard.press("Alt+q");
			await expect.poll(draft).toBe(code(`diff-repo/diff-app.ts:3-4 @ HEAD (${headShort})`, "export function f(x: number) {", "  return x + a;"));
			await box.pressSequentially("why?");
			await box.press("Enter");
			const sent = chat.locator(".omp-user").last();
			await expect(sent.locator("blockquote")).toHaveCount(1, { timeout: 60_000 });
			const location = sent.locator("blockquote code").first();
			await expect(location).toHaveText(`diff-repo/diff-app.ts:3-4 @ HEAD (${headShort})`);
			await expect(sent.locator("blockquote .omp-file-link"), "no link to the file on disk, whose lines 3-4 are other lines").toHaveCount(0);
			await closeDiff();
		});
	} finally {
		writeFileSync(settingsFile, originalSettings);
		rmSync(join(userDir, "keybindings.json"), { force: true });
	}
});
