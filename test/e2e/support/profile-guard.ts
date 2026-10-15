/**
 * The proof that a test window reads its own OMP profile and not the user's. `PI_CODING_AGENT_DIR` moves only the agent
 * directory: OMP finds the user-level agents it hands to subagents in `~/.omp/agent/agents` (and reads `~/.claude`, `~/.codex`
 * and `~/.gemini`), so the launcher also gives the window its own home folder (`test-vscode.ps1 -IsolateHome`, `RunState.homeDir`).
 *
 * The Agents editor lists every agent with its source, and its source filter names each source with a count (`user (2)`,
 * `bundled (5)`). A window that read the real profile would count the user's own agents under `user`, or add a source of its own,
 * so the filter is the evidence: the sources are exactly `user` (the agents this run wrote into its home folder) and `bundled`.
 * Nothing of the real profile is read by the guard, and no name from it is ever printed.
 */
import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";

const FRAMES = "iframe.webview.ready:visible:not([src*='purpose=webviewView'])";

/** Opens the Agents editor through the Command Palette (F1 is swallowed while a webview holds the keyboard: the title bar takes the focus first). */
export async function openAgentsEditor(page: Page): Promise<void> {
	const command = "OMP Desk: Open Agents Settings";
	await page.locator("[id='workbench.parts.titlebar']").click({ position: { x: 5, y: 5 } });
	await page.keyboard.press("F1");
	const picker = page.locator(".quick-input-widget");
	await picker.locator(".quick-input-box input").fill(`>${command}`);
	await expect(picker.getByRole("option", { name: command })).toBeVisible();
	await page.keyboard.press("Enter");
	const tab = page.getByRole("tab", { name: /^OMP Agents/ });
	await expect(tab).toBeVisible({ timeout: 60_000 });
	await tab.click();
}

/** The labels of the Agents editor's source filter (`All sources (7)`, `user (2)`, ...), once the editor has loaded. */
export async function agentSourceLabels(page: Page): Promise<string[]> {
	let labels: string[] = [];
	await expect(async () => {
		const count = await page.locator(FRAMES).count();
		for (let index = 0; index < count; index++) {
			const options = await page.frameLocator(FRAMES).nth(index).frameLocator("iframe#active-frame").locator("select option").allInnerTexts();
			if (options.some(option => option.startsWith("All sources"))) { labels = options; return; }
		}
		throw new Error("the Agents editor has not listed its sources yet");
	}).toPass({ timeout: 60_000 });
	return labels;
}

/**
 * Fails when the Agents editor lists a source besides `user` and `bundled`, or a `user` count other than `expectedUser` (the agents
 * this run wrote into its own home folder). The message carries counts only.
 */
export function expectOwnProfile(labels: readonly string[], expectedUser: number): void {
	const sources = labels.filter(label => !label.startsWith("All sources")).map(label => /^(.*?) \((\d+)\)$/.exec(label.trim()));
	expect(sources.every(match => match !== null), `every source filter reads "name (count)": ${labels.length} labels`).toBe(true);
	const counts = new Map(sources.map(match => [match![1], Number(match![2])] as const));
	const foreign = [...counts.keys()].filter(name => name !== "user" && name !== "bundled");
	expect(foreign.length, "the Agents editor lists no source but user and bundled: another source means a profile outside the test home was read").toBe(0);
	expect(counts.get("user") ?? 0, "user-level agents are exactly the ones this run wrote into its own home folder").toBe(expectedUser);
}
