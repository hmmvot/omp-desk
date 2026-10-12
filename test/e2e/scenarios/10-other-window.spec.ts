/**
 * Scenario a: two windows of one profile. A session running in window B shows in window A as held by another window
 * (the accessible name says so and the row carries the joined-squares badge), and a click on it switches to B: the
 * requester's own log records `held elsewhere=true` and the answer of the window that owns the session.
 *
 * Not covered: a slow PowerShell. The extension resolves PowerShell from `%SystemRoot%\System32` with no seam to slow it
 * down, so the slow start-time reading that this row once depended on is approximated only by the CPU-loaded variant:
 * the load starts once the session in B is running and lasts through the row check and the click. (Starting the
 * session itself under that load fails on this machine, see the report: the PTY broker self-check hits its deadline.)
 */
import type { Page } from "@playwright/test";
import { deskLogLines } from "../support/desk-log.ts";
import type { Desk } from "../support/desk.ts";
import { expect, test } from "../support/fixtures.ts";
import { startCpuLoad, type Load } from "../support/load.ts";
import type { RunState } from "../support/state.ts";

const REQUESTER_HELD = /requester: open of a row this window does not run \S+ held elsewhere=true/;
const REQUESTER_ANSWER = /requester: answer seen select \S+ served/;

/** `patience` is the timeout of every wait after the session runs; `underLoad` saturates the CPU from that point. */
async function otherWindowScenario(desk: Desk, state: RunState, marker: string, patience: number, underLoad: boolean): Promise<void> {
	const a = await desk.window("alpha-desk");
	await desk.ready(a);
	const b: Page = await desk.openWindow(state.folderB, "beta-desk");
	let load: Load | undefined;
	try {
		const chatB = await desk.newChatSession(b, "beta-desk");
		await desk.send(chatB, marker);
		await expect(chatB.getByText(`Mock reply to: ${marker}`)).toBeVisible();
		if (underLoad) load = startCpuLoad();

		const treeA = await desk.sessionsTree(a);
		const row = treeA.getByRole("treeitem", { name: new RegExp(`${marker}.*process held by another window`) });
		await expect(row).toBeVisible({ timeout: patience });
		// The joined-squares badge is a decoration drawn by CSS, so it is in the aria snapshot's text but not in innerText.
		await expect(treeA).toMatchAriaSnapshot(`
			- tree "Sessions":
			  - treeitem /beta-desk, ${marker}, .*process held by another window/: /.*\u29C9$/
		`, { timeout: patience });
		const heldBefore = deskLogLines(state.dataDir, REQUESTER_HELD).length;
		const answersBefore = deskLogLines(state.dataDir, REQUESTER_ANSWER).length;
		await row.click();
		await expect.poll(() => deskLogLines(state.dataDir, REQUESTER_HELD).length, { message: "the requester must see the claim held elsewhere", timeout: patience }).toBeGreaterThan(heldBefore);
		await expect.poll(() => deskLogLines(state.dataDir, REQUESTER_ANSWER).length, { message: "the owning window must answer the switch", timeout: patience }).toBeGreaterThan(answersBefore);
	} finally {
		load?.stop();
		await b.close();
	}
}

test("a session another window runs shows as held there, and a click switches to that window", async ({ desk, state }) => {
	await otherWindowScenario(desk, state, `held-${Date.now().toString(36)}`, 30_000, false);
});

test("the same while the CPU is saturated (twice the logical processors spinning)", async ({ desk, state }) => {
	test.setTimeout(300_000);
	await otherWindowScenario(desk, state, `loaded-${Date.now().toString(36)}`, 120_000, true);
});
