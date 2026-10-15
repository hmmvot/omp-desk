/**
 * A Playwright view of the hidden-desktop VS Code: windows (one Page per window), the OMP Desk views and the Chat
 * webview. VS Code nests a webview as workbench page > `iframe.webview` (vscode-webview://, hosted in an overlay
 * container, not inside the editor part) > `iframe#active-frame`; a webview *view* of a side bar is the same with
 * `purpose=webviewView` in the outer iframe's URL.
 */
import { chromium, expect, type Browser, type BrowserContext, type FrameLocator, type Locator, type Page } from "@playwright/test";
import { startVsCode } from "./launcher.ts";
import type { RunState } from "./state.ts";
import { sleep } from "./time.ts";

/** The Activity Bar entry of OMP Desk: its own part on the side, or inside the side bar when the bar is at the top of it (`workbench.activityBar.location: top`). */
export const ACTIVITY_BAR_ENTRY = ["activitybar", "sidebar"].map(part => `[id='workbench.parts.${part}'] .action-label[aria-label='OMP Desk']`).join(", ");

export class Desk {
	constructor(readonly browser: Browser, readonly state: RunState) {}

	static async connect(state: RunState): Promise<Desk> {
		const browser = await chromium.connectOverCDP(`http://127.0.0.1:${state.cdpPort}`, { timeout: 120_000 });
		return new Desk(browser, state);
	}

	get context(): BrowserContext {
		return this.browser.contexts()[0];
	}

	/** The workbench page of the window whose title names `folderName` (the folder is the title's root name). */
	async window(folderName: string, timeoutMs = 120_000): Promise<Page> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			for (const page of this.context.pages()) {
				if (page.isClosed()) continue;
				const title = await page.title().catch(() => "");
				if (title.includes(` - ${folderName} - `) || title.endsWith(` - ${folderName}`) || title.startsWith(`${folderName} - `)) {
					await this.emulateFocus(page);
					return page;
				}
			}
			if (Date.now() > deadline) throw new Error(`no VS Code window titled for ${folderName}; pages: ${this.context.pages().length}`);
			await sleep(250);
		}
	}

	/** A window on the hidden desktop is never the focused one; without this a screenshot can come back stale or hang. */
	private async emulateFocus(page: Page): Promise<void> {
		const session = await this.context.newCDPSession(page);
		await session.send("Emulation.setFocusEmulationEnabled", { enabled: true });
	}

	/** Opens another window of the same profile on `folder` (the launcher forwards to the running VS Code). */
	async openWindow(folder: string, folderName: string): Promise<Page> {
		await startVsCode({ name: this.state.name, root: this.state.root, folder });
		const page = await this.window(folderName);
		await this.ready(page);
		return page;
	}

	/**
	 * Runs Developer: Reload Window from the Command Palette and returns the window once it is back with the extension
	 * contributed. The reload replaces the renderer, so the old `Page` and every locator on it are dead: the window is
	 * looked up again, and only after the old renderer has gone (its title or content is no longer the one that ran the command).
	 */
	async reloadWindow(page: Page, folderName: string): Promise<Page> {
		// F1 is swallowed while a webview holds the keyboard focus (the Chat composer does): the title bar takes it first.
		await page.locator("[id='workbench.parts.titlebar']").click({ position: { x: 5, y: 5 } });
		await page.keyboard.press("F1");
		const picker = page.locator(".quick-input-widget");
		await picker.locator(".quick-input-box input").fill(">Developer: Reload Window");
		const option = picker.getByRole("option", { name: /Developer: Reload Window/ });
		await expect(option).toBeVisible();
		// The page navigates away as the reload starts: a Promise that outlives it is the load event of the new renderer.
		const reloaded = page.waitForEvent("load", { timeout: 120_000 });
		await page.keyboard.press("Enter");
		await reloaded;
		const back = await this.window(folderName);
		await this.ready(back);
		return back;
	}

	/**
	 * Waits until the window has OMP Desk's Activity Bar entry, i.e. the extension's containers are contributed, and puts the
	 * window into the profile's layout (see layout.ts).
	 */
	async ready(page: Page): Promise<void> {
		await page.locator(ACTIVITY_BAR_ENTRY).waitFor({ timeout: 120_000 });
		if (this.state.layout === "user") await this.arrangeLayout(page);
	}

	/** The part of the user layout VS Code keeps per workspace: OMP Desk is the visible side bar and its Context view is expanded under Sessions. */
	private async arrangeLayout(page: Page): Promise<void> {
		const sidebar = await this.showSidebar(page);
		const context = sidebar.getByRole("button", { name: /^Context/ });
		if (await context.getAttribute("aria-expanded") !== "true") await context.click();
		await expect(context).toHaveAttribute("aria-expanded", "true");
	}

	/** Reveals the OMP Desk side bar container (idempotent: clicks only when it is not already the visible one). */
	async showSidebar(page: Page): Promise<Locator> {
		const sidebar = page.locator("[id='workbench.parts.sidebar']");
		const title = sidebar.getByRole("heading", { name: "OMP Desk", level: 2 });
		if (!await title.isVisible()) await page.locator(ACTIVITY_BAR_ENTRY).click();
		await expect(title).toBeVisible();
		return sidebar;
	}

	/** The Sessions tree (a workbench tree: ordinary roles and aria snapshots work on it). */
	async sessionsTree(page: Page): Promise<Locator> {
		const sidebar = await this.showSidebar(page);
		return sidebar.getByRole("tree", { name: "Sessions" });
	}

	/**
	 * The visible Chat webview of a window. Chat is a webview *panel* in the editor area, so it is told from a side-bar
	 * webview view by the absence of `purpose=webviewView`; hidden editor tabs keep their iframe but are not visible.
	 */
	chat(page: Page): FrameLocator {
		return page.frameLocator("iframe.webview.ready:visible:not([src*='purpose=webviewView'])").first().frameLocator("iframe#active-frame");
	}

	/** A webview view of the OMP Desk side bar (Settings). */
	sidebarWebview(page: Page): FrameLocator {
		return page.frameLocator("iframe.webview.ready:visible[src*='purpose=webviewView']").first().frameLocator("iframe#active-frame");
	}

	/**
	 * Starts a Chat session in `folderName` from the Sessions tree's New Session row. With one folder open VS Code Desk
	 * starts at once; with several it asks which folder first.
	 */
	async newChatSession(page: Page, folderName: string, timeout = 30_000): Promise<FrameLocator> {
		const tree = await this.sessionsTree(page);
		// A Chat of an earlier scenario may still be open with its composer visible: the new session is told from it by one
		// more Chat webview iframe (hidden editor tabs keep theirs), never by "a composer is visible".
		const panels = page.locator("iframe.webview:not([src*='purpose=webviewView'])");
		const before = await panels.count();
		const pick = page.locator(".quick-input-widget").getByRole("option", { name: new RegExp(`^${folderName}`) });
		// A tree row that re-renders between mouse down and up (the Sessions list refreshes right after a window closed) loses
		// the click; it is repeated only while neither the pick nor a new panel appeared, so it cannot start two sessions.
		await expect(async () => {
			await tree.getByRole("treeitem", { name: /^New Session/ }).click();
			await expect.poll(async () => await pick.isVisible() || await panels.count() > before, { timeout: 8_000 }).toBe(true);
		}, `a folder pick or a new Chat panel for ${folderName}`).toPass({ timeout, intervals: [200] });
		if (await pick.isVisible()) await pick.click();
		await expect.poll(async () => await panels.count(), { message: "the new Chat panel", timeout }).toBeGreaterThan(before);
		const composer = this.chat(page).getByRole("combobox", { name: "Message OMP" });
		await expect(composer).toBeVisible({ timeout });
		return this.chat(page);
	}

	/**
	 * Clicks an item of the open context menu. A click that lands the instant the menu opens is ignored by VS Code's
	 * menu, so the item is hovered and must show as focused (the menu has registered the pointer) before it is clicked.
	 */
	async clickMenuItem(page: Page, name: string): Promise<void> {
		const item = page.locator(".monaco-menu").getByRole("menuitem", { name, exact: true });
		await item.hover({ timeout: 30_000 });
		await expect(item.locator("xpath=..")).toHaveClass(/focused/);
		await item.click({ timeout: 30_000 });
	}

	/**
	 * Opens the context menu of a Sessions row and clicks one of its items. A tree row that re-renders between mouse down
	 * and up loses the right click (the Sessions list repaints as other windows publish), so the click is repeated until the
	 * menu shows the item; an open menu that lacks it is dismissed first, because it would swallow the next right click.
	 */
	async rowMenu(page: Page, row: Locator, item: string): Promise<void> {
		const entry = page.locator(".monaco-menu").getByRole("menuitem", { name: item, exact: true });
		await expect(async () => {
			await row.click({ button: "right" });
			try {
				await expect(entry).toBeVisible({ timeout: 2_000 });
			} catch (error) {
				await page.keyboard.press("Escape");
				throw error;
			}
		}, `the row menu offers ${item}`).toPass({ timeout: 30_000, intervals: [200, 500] });
		await this.clickMenuItem(page, item);
	}

	/** The modal confirmation VS Code shows as DOM (the profile sets `window.dialogStyle: custom`). */
	dialog(page: Page): Locator {
		return page.locator(".monaco-dialog-box");
	}

	/** Notification toasts (the `showInfo` / `showWarning` messages of the extension). */
	toasts(page: Page): Locator {
		return page.locator(".notifications-toasts .notification-toast");
	}

	/** Types `text` into a Chat composer and presses Send. */
	async send(chat: FrameLocator, text: string): Promise<void> {
		await chat.getByRole("combobox", { name: "Message OMP" }).fill(text);
		await chat.getByRole("button", { name: "Send message" }).click();
	}

	async close(): Promise<void> {
		await this.browser.close();
	}
}
