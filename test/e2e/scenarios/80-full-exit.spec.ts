/**
 * Scenario g: close VS Code completely (every window, the whole application) and open it again with a running Chat. The
 * OMP process is kept by its detached broker, so the reopened window must re-adopt the same process: same pid, same
 * transcript, a new prompt answered. This is README's "close VS Code: the session keeps working; reopen it to get the same
 * process back". It runs last and takes its own CDP connection: it ends the one every other scenario shares.
 */
import { expect, test } from "@playwright/test";
import { Desk } from "../support/desk.ts";
import { startVsCode, waitForCdp } from "../support/launcher.ts";
import { pidAlive, recordedSession } from "../support/records.ts";
import { readState } from "../support/state.ts";
import { sleep } from "../support/time.ts";

async function cdpGone(port: number, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1_000) });
		} catch {
			return;
		}
		if (Date.now() > deadline) throw new Error(`VS Code still answers on port ${port} after ${timeoutMs} ms`);
		await sleep(500);
	}
}

test("a full VS Code exit and reopen re-adopts the running Chat's own OMP process", async () => {
	test.setTimeout(420_000);
	// Not the shared `desk` fixture: its per-test clean-up would reach for a browser this test ends.
	const state = readState();
	const desk = await Desk.connect(state);
	const before = await desk.window("alpha-desk");
	await desk.ready(before);
	const marker = `exit-${Date.now().toString(36)}`;
	const chatBefore = await desk.newChatSession(before, "alpha-desk");
	await desk.send(chatBefore, marker);
	await expect(chatBefore.getByText(`Mock reply to: ${marker}`)).toBeVisible();
	await expect.poll(() => recordedSession(state, marker)?.childPid ?? null, { message: "Desk records the OMP child of the session" }).not.toBeNull();
	const { childPid } = recordedSession(state, marker)!;

	// The application quits the way a user's Quit does (Browser.close ends it through VS Code's own shutdown), not through a kill.
	const quit = await desk.browser.newBrowserCDPSession();
	// The reply may never come (the browser it would come from is gone): do not wait for it.
	await Promise.race([quit.send("Browser.close").catch(() => undefined), sleep(10_000)]);
	await cdpGone(state.cdpPort, 120_000);
	expect(pidAlive(childPid!), "quitting VS Code did not end the session's OMP process").toBe(true);

	await startVsCode({ name: state.name, root: state.root, folder: state.folderA, port: state.cdpPort });
	await waitForCdp(state.cdpPort, 180_000);
	const reopened = await Desk.connect(state);
	const after = await reopened.window("alpha-desk");
	await reopened.ready(after);

	const tree = await reopened.sessionsTree(after);
	await reopened.revealSessionRow(after, tree.getByRole("treeitem", { name: new RegExp(`${marker}, .*process running`) }), 90_000);
	expect(pidAlive(childPid!), "the reopened window did not replace the OMP process").toBe(true);
	expect(recordedSession(state, marker)!.childPid, "the same process serves the session").toBe(childPid);
	const chat = reopened.chat(after);
	await expect(chat.getByText(`Mock reply to: ${marker}`)).toBeVisible({ timeout: 90_000 });
	await reopened.send(chat, `after exit ${marker}`);
	await expect(chat.getByText(`Mock reply to: after exit ${marker}`)).toBeVisible({ timeout: 60_000 });
	await reopened.close();
});
