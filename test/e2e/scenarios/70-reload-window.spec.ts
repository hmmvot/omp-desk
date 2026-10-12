/**
 * Scenario f: Developer: Reload Window with a running Chat. The extension host and the webview are replaced, the OMP
 * process (kept by its broker) is not: the window must reattach to the same process, show the row as running again,
 * restore the conversation in the Chat and let the user keep talking to it.
 */
import { expect, test } from "../support/fixtures.ts";
import { pidAlive, recordedSession } from "../support/records.ts";

test("Reload Window keeps the running Chat's process: the row, the transcript and a new prompt all work afterwards", async ({ desk, state }) => {
	const before = await desk.window("alpha-desk");
	await desk.ready(before);
	const marker = `reload-${Date.now().toString(36)}`;
	const chatBefore = await desk.newChatSession(before, "alpha-desk");
	await desk.send(chatBefore, marker);
	await expect(chatBefore.getByText(`Mock reply to: ${marker}`)).toBeVisible();
	await expect.poll(() => recordedSession(state, marker)?.childPid ?? null, { message: "Desk records the OMP child of the session" }).not.toBeNull();
	const { childPid } = recordedSession(state, marker)!;

	// A property of the old renderer: it is gone only if the window really was reloaded.
	await before.evaluate(() => { (globalThis as { e2eRenderer?: string }).e2eRenderer = "before reload"; });

	const after = await desk.reloadWindow(before, "alpha-desk");
	expect(await after.evaluate(() => (globalThis as { e2eRenderer?: string }).e2eRenderer), "the window was reloaded, not merely refreshed").toBeUndefined();

	const tree = await desk.sessionsTree(after);
	await expect(tree.getByRole("treeitem", { name: new RegExp(`${marker}, .*process running`) })).toBeVisible({ timeout: 60_000 });
	expect(pidAlive(childPid!), "the reload did not end the session's OMP process").toBe(true);
	expect(recordedSession(state, marker)!.childPid, "the same process serves the session").toBe(childPid);
	const chat = desk.chat(after);
	await expect(chat.getByText(`Mock reply to: ${marker}`)).toBeVisible({ timeout: 60_000 });
	await desk.send(chat, `after reload ${marker}`);
	await expect(chat.getByText(`Mock reply to: after reload ${marker}`)).toBeVisible({ timeout: 60_000 });
});
