/**
 * Scenario e: the processes of a running Chat end outside Desk (Task Manager, a crash), by the pids Desk itself
 * recorded. The window that runs the session must notice without any user action: the row says Stopped, the Chat says
 * the session ended, the other window's row follows, and the session can be resumed and answers again. Nothing asks
 * the user a question about a process that is already gone.
 *
 * `taskkill` of the broker's tree and of the OMP child alone are the two ways it ends: the broker's loss is noticed by
 * the window's own watch (one look per second, then a proof of the OMP root), the child's by the broker's report.
 */
import type { Page } from "@playwright/test";
import type { Desk } from "../support/desk.ts";
import { expect, test } from "../support/fixtures.ts";
import { pidAlive, recordedSession, taskkillTree } from "../support/records.ts";
import type { RunState } from "../support/state.ts";

/** Generous: the watch looks every second and then waits up to 30 s for the root's proof; the machine is often busy. */
const NOTICE_WITHIN_MS = 45_000;
const STOPPED_CHAT = /Session stopped\. Resume to continue\.|OMP exited/;

async function crashScenario(desk: Desk, state: RunState, tag: string, crash: (broker: number, child: number) => Promise<void>): Promise<void> {
	const a: Page = await desk.window("alpha-desk");
	await desk.ready(a);
	const b = await desk.openWindow(state.folderB, "beta-desk");
	try {
		const marker = `${tag}-${Date.now().toString(36)}`;
		const chat = await desk.newChatSession(b, "beta-desk");
		await desk.send(chat, marker);
		await expect(chat.getByText(`Mock reply to: ${marker}`)).toBeVisible();
		await expect.poll(() => recordedSession(state, marker)?.childPid ?? null, { message: "Desk records the OMP child of the session" }).not.toBeNull();
		const { brokerPid, childPid } = recordedSession(state, marker)!;
		expect(brokerPid, "Desk records the broker of the session").not.toBeNull();
		const treeA = await desk.sessionsTree(a);
		await expect(treeA.getByRole("treeitem", { name: new RegExp(`${marker}.*process held by another window`) })).toBeVisible({ timeout: 30_000 });
		const treeB = await desk.sessionsTree(b);
		await expect(treeB.getByRole("treeitem", { name: new RegExp(`${marker}.*process running`) })).toBeVisible();

		await crash(brokerPid!, childPid!);

		const stopped = new RegExp(`${marker}, Stopped`);
		await expect(treeB.getByRole("treeitem", { name: stopped })).toBeVisible({ timeout: NOTICE_WITHIN_MS });
		await expect(chat.getByText(STOPPED_CHAT)).toBeVisible();
		await expect(treeA.getByRole("treeitem", { name: stopped })).toBeVisible({ timeout: NOTICE_WITHIN_MS });
		expect(pidAlive(childPid!), "the OMP process is gone").toBe(false);
		expect(await desk.dialog(b).count(), "no question about a process that is already gone").toBe(0);

		await desk.rowMenu(b, treeB.getByRole("treeitem", { name: stopped }), "Open in Chat");
		await expect(treeB.getByRole("treeitem", { name: new RegExp(`${marker}, .*process running`) })).toBeVisible({ timeout: 60_000 });
		await desk.send(chat, `again ${marker}`);
		await expect(chat.getByText(`Mock reply to: again ${marker}`)).toBeVisible({ timeout: 60_000 });
		expect(recordedSession(state, marker)!.childPid, "the resumed session runs in a new process").not.toBe(childPid);
	} finally {
		await b.close();
	}
}

test("the broker's process tree ended outside Desk: the session shows Stopped by itself in both windows and resumes", async ({ desk, state }) => {
	await crashScenario(desk, state, "xbroker", broker => taskkillTree(broker));
});

test("only the OMP process ended outside Desk: the session shows Stopped by itself in both windows and resumes", async ({ desk, state }) => {
	await crashScenario(desk, state, "xchild", (_broker, child) => taskkillTree(child, false));
});
