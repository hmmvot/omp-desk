/**
 * Scenarios c and d: a session runs in window B and window A of the same profile shows its row. Ending it from either
 * window must leave both windows, the row and the process in agreement, with no question the user has to answer about a
 * process that is already gone.
 *
 *   c. Kill from the window that does not hold the session: the holding window learns of it without any user action
 *      (its row and its Chat say stopped), no Force Stop is offered, and the session resumes.
 *   d. Close from the holding window: the process ends and the other window's row follows.
 *
 * A Close issued before the holder noticed an outside kill (the original "could not be confirmed stopped" bug) is a
 * race of about a second against the broker watch and is covered by the lifecycle unit test, not here.
 */
import type { Page } from "@playwright/test";
import type { Desk } from "../support/desk.ts";
import { expect, test } from "../support/fixtures.ts";
import { pidAlive, recordedSession } from "../support/records.ts";
import type { RunState } from "../support/state.ts";

const STOPPED_CHAT = /Session stopped\. Resume to continue\.|OMP exited/;

/** Starts a Chat in `beta-desk`, lets it answer, and returns what Desk recorded about its processes. */
async function runningInB(desk: Desk, state: RunState, b: Page, marker: string) {
	const chat = await desk.newChatSession(b, "beta-desk");
	await desk.send(chat, marker);
	await expect(chat.getByText(`Mock reply to: ${marker}`)).toBeVisible();
	await expect.poll(() => recordedSession(state, marker)?.childPid ?? null, { message: "Desk records the OMP child of the session" }).not.toBeNull();
	const recorded = recordedSession(state, marker)!;
	expect(recorded.brokerPid, "Desk records the broker of the session").not.toBeNull();
	return { chat, recorded };
}

test("Kill from the window that does not hold a session stops it in both windows without a question, and it resumes", async ({ desk, state }) => {
	const a: Page = await desk.window("alpha-desk");
	await desk.ready(a);
	const b = await desk.openWindow(state.folderB, "beta-desk");
	try {
		const marker = `xkill-${Date.now().toString(36)}`;
		const { chat: chatB, recorded } = await runningInB(desk, state, b, marker);
		const treeA = await desk.sessionsTree(a);
		const rowA = treeA.getByRole("treeitem", { name: new RegExp(`${marker}.*process held by another window`) });
		await expect(rowA).toBeVisible({ timeout: 30_000 });

		await desk.rowMenu(a, rowA, "Kill");

		// Nobody touches window B from here on: it has to find out by itself.
		const treeB = await desk.sessionsTree(b);
		const stopped = new RegExp(`${marker}, Stopped`);
		await expect(treeB.getByRole("treeitem", { name: stopped })).toBeVisible({ timeout: 45_000 });
		await expect(treeA.getByRole("treeitem", { name: stopped })).toBeVisible({ timeout: 45_000 });
		await expect(chatB.getByText(STOPPED_CHAT)).toBeVisible();
		expect(pidAlive(recorded.childPid!), "the OMP process is gone").toBe(false);
		expect(pidAlive(recorded.brokerPid!), "the broker is gone").toBe(false);
		expect(await desk.dialog(b).count(), "no Force Stop or other question in the holding window").toBe(0);
		expect(await desk.dialog(a).count()).toBe(0);

		// The session is free again: it resumes in the holding window, answers, and the other window shows it held there.
		const rowB = treeB.getByRole("treeitem", { name: stopped });
		await desk.rowMenu(b, rowB, "Open in Chat");
		await expect(treeB.getByRole("treeitem", { name: new RegExp(`${marker}, .*process running`) })).toBeVisible({ timeout: 60_000 });
		await desk.send(chatB, `again ${marker}`);
		await expect(chatB.getByText(`Mock reply to: again ${marker}`)).toBeVisible({ timeout: 60_000 });
		await expect(treeA.getByRole("treeitem", { name: new RegExp(`${marker}.*process held by another window`) })).toBeVisible({ timeout: 45_000 });
	} finally {
		await b.close();
	}
});

test("Close in the holding window ends the process and the other window's row follows", async ({ desk, state }) => {
	const a: Page = await desk.window("alpha-desk");
	await desk.ready(a);
	const b = await desk.openWindow(state.folderB, "beta-desk");
	try {
		const marker = `xclose-${Date.now().toString(36)}`;
		const { chat: chatB, recorded } = await runningInB(desk, state, b, marker);
		const treeA = await desk.sessionsTree(a);
		await expect(treeA.getByRole("treeitem", { name: new RegExp(`${marker}.*process held by another window`) })).toBeVisible({ timeout: 30_000 });

		const treeB = await desk.sessionsTree(b);
		const rowB = treeB.getByRole("treeitem", { name: new RegExp(`${marker}.*process running`) });
		await desk.rowMenu(b, rowB, "Close");
		const question = desk.dialog(b);
		await expect(question).toContainText("Close the OMP session");
		await question.getByRole("button", { name: "Close", exact: true }).click();

		const stopped = new RegExp(`${marker}, Stopped`);
		await expect(treeB.getByRole("treeitem", { name: stopped })).toBeVisible({ timeout: 45_000 });
		await expect(treeA.getByRole("treeitem", { name: stopped })).toBeVisible({ timeout: 45_000 });
		await expect(chatB.getByText(STOPPED_CHAT)).toBeVisible();
		await expect.poll(() => pidAlive(recorded.childPid!), { message: "the OMP process ended" }).toBe(false);
		expect(await desk.dialog(b).count(), "a Close that succeeded asks nothing more (no Force Stop)").toBe(0);
	} finally {
		await b.close();
	}
});
