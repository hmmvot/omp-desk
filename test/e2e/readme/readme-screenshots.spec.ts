/**
 * The six README images (`media/readme/chat.png`, `sessions.png`, `chat-agents.png`, `terminal.png`, `models.png`,
 * `omp-settings.png`), captured from one hidden test window in the user layout (layout.ts) on the README scene (scene.ts):
 * scripted conversations of the project itself, no real model, no personal data. The window has its own OMP profile: its agent
 * directory (`PI_CODING_AGENT_DIR`) and its own home folder (`-IsolateHome`), where OMP finds the user-level agents; the Agents
 * editor's sources are checked before the Models and OMP Settings images are taken (profile-guard.ts). Run with
 * `npm run readme:screenshots`.
 *
 * Fixed capture: the window's viewport is 1760 x 900 CSS pixels at device scale 1; `sessions.png` is a clip of the side bar
 * at device scale 2. The images are written over the committed ones.
 */
import type { FrameLocator, Locator, Page } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Desk } from "../support/desk.ts";
import { expect, test } from "../support/fixtures.ts";
import { REPO_ROOT } from "../support/launcher.ts";
import { agentSourceLabels, expectOwnProfile, openAgentsEditor } from "../support/profile-guard.ts";
import { IMAGE_QUESTION, IMAGE_TITLE, QUEUED_FOLLOW_UP, STOPPED_SESSIONS, TERMINAL_REQUEST, TERMINAL_TITLE, TIMING_REQUEST, TIMING_TITLE, WORKING_REQUEST, WORKING_TITLE } from "./scripts.ts";
import { ATTACHMENTS_PATH, FIXTURE_AGENTS, sourceFacts, WORKSPACE_NAME } from "./scene.ts";

const OUTPUT_DIR = join(REPO_ROOT, "media", "readme");
const VIEWPORT = { width: 1760, height: 900 };
const SIDEBAR_SCALE = 2;
/** A session start on a busy machine can take far longer than the suite's default. */
const START_TIMEOUT = 120_000;

function sessionsTree(page: Page) {
	return page.locator("[id='workbench.parts.sidebar']").getByRole("tree", { name: "Sessions" });
}

function treeRow(page: Page, title: string) {
	return sessionsTree(page).getByRole("treeitem", { name: new RegExp(`^${WORKSPACE_NAME}, ${title}`) });
}

/** The Command Palette. F1 is swallowed while a webview holds the keyboard: the title bar takes the focus first. */
async function runCommand(page: Page, command: string): Promise<void> {
	await page.locator("[id='workbench.parts.titlebar']").click({ position: { x: 5, y: 5 } });
	await page.keyboard.press("F1");
	const picker = page.locator(".quick-input-widget");
	await picker.locator(".quick-input-box input").fill(`>${command}`);
	const option = picker.getByRole("option", { name: command });
	await expect(option).toBeVisible();
	await page.keyboard.press("Enter");
}

/** Quick Open on a file at a line: the editor goes to the group on the right (`ompDesk.chatColumn`). */
async function openFileAt(page: Page, file: string): Promise<void> {
	await page.locator("[id='workbench.parts.titlebar']").click({ position: { x: 5, y: 5 } });
	await page.keyboard.press("Control+p");
	const picker = page.locator(".quick-input-widget");
	await picker.locator(".quick-input-box input").fill(file);
	await expect(picker.getByRole("option", { name: new RegExp(file.split(":")[0].replace(".", "\\.")) }).first()).toBeVisible({ timeout: 60_000 });
	await page.waitForTimeout(1_000);
	await page.keyboard.press("Enter");
}

/** Starts a Chat session and sends `prompt`; resolves once the composer accepted it. */
async function startSession(desk: Desk, page: Page, prompt: string): Promise<FrameLocator> {
	const chat = await desk.newChatSession(page, WORKSPACE_NAME, START_TIMEOUT);
	await desk.send(chat, prompt);
	return chat;
}

/** Gives the selected session its name through the Sessions view's Rename; a rename box that lost the typing is dismissed and tried again. */
async function nameSession(desk: Desk, page: Page, title: string): Promise<void> {
	const selected = sessionsTree(page).getByRole("treeitem", { name: /selected session/ });
	await expect(async () => {
		await desk.rowMenu(page, selected, "Rename");
		await expect(page.locator(".quick-input-widget .quick-input-box input")).toBeVisible();
		// Typed like a user would, once the box has taken the focus.
		await page.waitForTimeout(800);
		await page.keyboard.press("Control+a");
		await page.keyboard.type(title);
		await page.keyboard.press("Enter");
		try {
			await expect(treeRow(page, title)).toBeVisible({ timeout: 10_000 });
		} catch (error) {
			await page.keyboard.press("Escape");
			throw error;
		}
	}, `the session is named ${title}`).toPass({ timeout: 120_000, intervals: [500] });
}

function sessionRows(page: Page): Locator {
	return sessionsTree(page).getByRole("treeitem", { name: /^omp-vscode, / });
}

async function closeTab(page: Page, name: RegExp | string): Promise<void> {
	// A middle click closes a tab, whether or not its close button is shown.
	await page.getByRole("tab", { name }).click({ button: "middle" });
}

/** The mouse goes to the blank title bar so no hover state or tooltip is in the picture, and the toasts are gone. */
async function settle(page: Page): Promise<void> {
	await page.mouse.move(1250, 16);
	await expect(page.locator(".notifications-toasts.visible")).toHaveCount(0, { timeout: 30_000 });
	await page.waitForTimeout(1_500);
}

/** Waits until a visible editor webview (not the Chat, not a side bar view) shows `text`. */
async function editorShows(page: Page, text: RegExp): Promise<void> {
	const selector = "iframe.webview.ready:visible:not([src*='purpose=webviewView'])";
	await expect(async () => {
		const count = await page.locator(selector).count();
		let loaded = false;
		for (let index = 0; index < count; index++) loaded ||= (await page.frameLocator(selector).nth(index).frameLocator("iframe#active-frame").getByText(text).count()) > 0;
		expect(loaded).toBe(true);
	}).toPass({ timeout: 60_000 });
}

test("capture the README images in the user layout", async ({ desk, state }) => {
	const page = await desk.window(WORKSPACE_NAME);
	await desk.ready(page);
	await page.setViewportSize(VIEWPORT);
	page.setDefaultTimeout(60_000);
	mkdirSync(OUTPUT_DIR, { recursive: true });

	// Stopped sessions first: the working ones below must still be working when the images are taken.
	for (const session of STOPPED_SESSIONS) {
		const chat = await startSession(desk, page, session.prompt);
		await expect(chat.getByText(session.reply)).toBeVisible({ timeout: 120_000 });
		await nameSession(desk, page, session.title);
		await desk.rowMenu(page, treeRow(page, session.title), "Close");
		await desk.dialog(page).getByRole("button", { name: "Close", exact: true }).click();
		await expect(treeRow(page, `${session.title}, Stopped`)).toBeVisible({ timeout: 60_000 });
		await closeTab(page, new RegExp(`^${session.title}`));
	}

	// The session of chat.png: a question about the code, answered from the attachments source.
	const question = await startSession(desk, page, IMAGE_QUESTION);
	await expect(question.getByText(/before Send instead of failing later/)).toBeVisible({ timeout: 120_000 });
	await nameSession(desk, page, IMAGE_TITLE);

	// The editors on the right: OMP's own settings editors and a source file at a line. They run on the scene's own profile (the
	// agent directory and the home folder of the window, see scene.ts); the Agents editor's sources prove it before anything is captured.
	await openAgentsEditor(page);
	expectOwnProfile(await agentSourceLabels(page), FIXTURE_AGENTS.length);
	await runCommand(page, "OMP Desk: Open Models Settings");
	await expect(page.getByRole("tab", { name: /^OMP Models/ })).toBeVisible({ timeout: 60_000 });
	await page.getByRole("tab", { name: /^OMP Models/ }).click();
	await editorShows(page, /Model roles/);
	await settle(page);
	await page.screenshot({ path: join(OUTPUT_DIR, "models.png") });
	await runCommand(page, "OMP Desk: Open OMP Settings");
	await expect(page.getByRole("tab", { name: /^OMP Settings/ })).toBeVisible({ timeout: 60_000 });
	await page.getByRole("tab", { name: /^OMP Settings/ }).click();
	await editorShows(page, /Credentials are never shown/);
	await settle(page);
	await page.screenshot({ path: join(OUTPUT_DIR, "omp-settings.png") });
	await closeTab(page, /^OMP Settings/);
	await openFileAt(page, `${ATTACHMENTS_PATH.split("/").at(-1)}:${sourceFacts(readFileSync(join(REPO_ROOT, ATTACHMENTS_PATH), "utf8")).attachmentBytesLine}`);
	await expect(page.getByRole("tab", { name: /^attachments\.ts/ })).toBeVisible({ timeout: 60_000 });

	// A session that keeps working with its tab closed: its row keeps spinning.
	await startSession(desk, page, WORKING_REQUEST);
	await expect(sessionsTree(page).getByRole("treeitem", { name: /, Working/ }).first()).toBeVisible({ timeout: 120_000 });
	await nameSession(desk, page, WORKING_TITLE);
	await closeTab(page, new RegExp(`^${WORKING_TITLE}`));

	// One session working on a subagent, with a queued follow-up: chat-agents.png.
	const timing = await startSession(desk, page, TIMING_REQUEST);
	await expect(timing.getByText(/1 running/)).toBeVisible({ timeout: 120_000 });
	// While a turn runs the composer is the steer box: found by its role, not by its idle name.
	const steer = desk.composerWhileBusy(timing);
	await steer.fill(QUEUED_FOLLOW_UP);
	await steer.press("Alt+Enter");
	await expect(timing.getByText("Queued")).toBeVisible();
	await nameSession(desk, page, TIMING_TITLE);

	// A start that stalled on a busy machine leaves an extra row: such a run is not an image to keep.
	await expect(sessionRows(page)).toHaveCount(8);

	await page.getByRole("tab", { name: new RegExp(`^${IMAGE_TITLE}`) }).click();
	await settle(page);
	await page.screenshot({ path: join(OUTPUT_DIR, "chat.png") });

	await page.getByRole("tab", { name: new RegExp(`^${TIMING_TITLE}`) }).click();
	await expect(timing.getByText("Queued")).toBeVisible();
	await settle(page);
	await page.screenshot({ path: join(OUTPUT_DIR, "chat-agents.png") });

	// The Sessions view: the side bar down to its last row, at twice the scale.
	const sidebar = await page.locator("[id='workbench.parts.sidebar']").boundingBox();
	const last = await page.locator("[id='workbench.parts.sidebar']").getByRole("treeitem", { name: /^Resume Session/ }).boundingBox();
	if (sidebar === null || last === null) throw new Error("the Sessions view has no layout box");
	const cdp = await desk.context.newCDPSession(page);
	const clip = { x: sidebar.x, y: sidebar.y, width: sidebar.width, height: last.y + last.height + 8 - sidebar.y, scale: SIDEBAR_SCALE };
	const shot = await cdp.send("Page.captureScreenshot", { format: "png", clip });
	writeFileSync(join(OUTPUT_DIR, "sessions.png"), Buffer.from(shot.data, "base64"));

	// Terminal mode: the same editor, switched to the native OMP UI.
	const terminal = await startSession(desk, page, TERMINAL_REQUEST);
	await expect(terminal.getByText(/exports the attachment limits/)).toBeVisible({ timeout: 120_000 });
	await page.locator(".editor-actions .action-label[aria-label='Switch to Terminal']").first().click();
	await expect(desk.chat(page).locator(".xterm-rows")).toContainText("exports the attachment limits", { timeout: 120_000 });
	await expect(sessionRows(page)).toHaveCount(9);
	await settle(page);
	await page.screenshot({ path: join(OUTPUT_DIR, "terminal.png") });
});
