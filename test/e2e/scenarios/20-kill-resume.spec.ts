/**
 * Scenario b: Kill a running Chat session from the Sessions context menu and resume it at once. The resume must start
 * a new OMP process for the same session (a different pid in the Desk log) and the Chat must answer again, instead of
 * finding the dead runtime still in place.
 */
import type { Page } from "@playwright/test";
import { deskLogLines } from "../support/desk-log.ts";
import { expect, test } from "../support/fixtures.ts";

const HOST_PID = /host control verified \(pid (\d+),/;

function hostPids(dataDir: string): number[] {
	return deskLogLines(dataDir, HOST_PID).map(line => Number(HOST_PID.exec(line)![1]));
}

test("Kill, then an immediate Open in Chat from the context menu, starts a new process", async ({ desk, state }) => {
	const a: Page = await desk.window("alpha-desk");
	await desk.ready(a);
	const chat = await desk.newChatSession(a, "alpha-desk");
	const marker = `kill-${Date.now().toString(36)}`;
	await desk.send(chat, marker);
	await expect(chat.getByText(`Mock reply to: ${marker}`)).toBeVisible();
	const tree = await desk.sessionsTree(a);
	const row = tree.getByRole("treeitem", { name: new RegExp(marker) });
	await expect(row).toHaveAccessibleName(/process running/);
	await expect.poll(() => hostPids(state.dataDir).length, { message: "the host's control channel is verified" }).toBeGreaterThan(0);
	const pidsBefore = hostPids(state.dataDir);

	await row.click({ button: "right" });
	await desk.clickMenuItem(a, "Kill");

	// Resume as soon as the row offers it: a stopped row's menu is "Open in Chat" (a running row's has Kill instead).
	const openInChat = a.locator(".monaco-menu").getByRole("menuitem", { name: "Open in Chat", exact: true });
	await expect(async () => {
		await row.click({ button: "right" });
		try {
			await expect(openInChat).toBeVisible({ timeout: 1_000 });
		} catch (error) {
			await a.keyboard.press("Escape"); // a menu that is still open blocks the next right click
			throw error;
		}
		await desk.clickMenuItem(a, "Open in Chat");
	}).toPass({ timeout: 60_000, intervals: [50, 100, 200] });

	await expect(row).toHaveAccessibleName(/process running/, { timeout: 60_000 });
	await expect.poll(() => hostPids(state.dataDir).length, { message: "a second OMP host must be started" }).toBeGreaterThan(pidsBefore.length);
	const pidsAfter = hostPids(state.dataDir);
	expect(pidsAfter.filter(pid => !pidsBefore.includes(pid)), "the resumed session runs in a process the killed one was not").not.toHaveLength(0);

	await desk.send(chat, `after resume ${marker}`);
	await expect(chat.getByText(`Mock reply to: after resume ${marker}`)).toBeVisible({ timeout: 60_000 });
	// The conversation is the same one: the history survived the kill.
	await expect(chat.getByText(`Mock reply to: ${marker}`)).toBeVisible();
});
