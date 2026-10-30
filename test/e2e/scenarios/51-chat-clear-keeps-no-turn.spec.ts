/**
 * Scenario: after Clear, the Chat shows only what OMP keeps in context. A turn with a tool call is cleared by typed `/clear` in a
 * Chat that was reattached after Reload Window (the broker replays the turn's lines), and a second turn is cleared from the Sessions
 * row's Clear Context…; each time the divider says how many messages it hides, nothing of the turn stays below it, and OMP's own report
 * of the provider reset that a clear runs inside itself ("Fresh provider session started …") is not a row, also after Reload Window.
 *
 * The unfixed build passed this scenario's order checks (the turn stayed behind the divider), so the divider's order among rows the page
 * positioned live is pinned by `src/chat/projection.test.ts` and `model.test.ts`, not here.
 *
 * Harness: the real OMP with the mock model; the row menu and the modal question are VS Code's DOM widgets (see `45-session-fork-branch-clear`).
 */
import type { FrameLocator, Page } from "@playwright/test";
import { expect, test } from "../support/fixtures.ts";
import { recordedSession } from "../support/records.ts";

const CLEAR_DONE_SENTENCE = "Context cleared. The session, its file and its title are unchanged.";
const DIVIDER = /^Context cleared · (at least )?\d+ messages? dropped$/;

/** The Chat in front shows the divider, and nothing of `turn` (its prompt, its reply) or of OMP's fresh report below it. */
async function expectClearedBehindDivider(chat: FrameLocator, turn: string, message: string): Promise<void> {
	const transcript = chat.locator(".omp-transcript");
	const divider = chat.locator(".omp-cleared-history summary");
	await expect(divider, `${message}: the divider`).toHaveText(DIVIDER, { timeout: 60_000 });
	await expect(transcript.getByText(turn, { exact: false }), `${message}: the cleared turn is not below the divider`).toHaveCount(0);
	await expect(transcript.getByText("Tool result received."), `${message}: the cleared tool turn's answer is not below the divider`).toHaveCount(0);
	await expect(transcript.getByText("Fresh provider session started"), `${message}: OMP's report of the reset inside the clear is not a row`).toHaveCount(0);
	await expect(chat.locator(".omp-cleared-history-cards"), `${message}: the disclosure is closed`).toHaveCount(0);
}

test("Clear leaves no earlier turn below the divider: typed after Reload Window, from the row menu, and after Reload Window again", async ({ desk, state }) => {
	test.setTimeout(420_000);
	const marker = `xclr-${Date.now().toString(36)}`;
	let page: Page = await desk.window("alpha-desk");
	await desk.ready(page);
	// Run alone, this is the first session of a fresh environment: the runtime proof and the broker start are cold.
	let chat = await desk.newChatSession(page, "alpha-desk", 120_000);

	// 1. A turn with a tool call, then Reload Window: the window reattaches to the same OMP process and rebuilds the transcript.
	const first = `first ${marker} [tool:hello.txt]`;
	await desk.send(chat, first);
	await expect(chat.locator(".omp-transcript").getByText("Tool result received."), "the tool turn finished").toBeVisible({ timeout: 90_000 });
	await expect(desk.composer(chat), "the turn ended").toBeVisible({ timeout: 60_000 });
	await expect.poll(() => recordedSession(state, marker)?.childPid ?? null, { message: "Desk records the OMP child of the session" }).not.toBeNull();
	const { childPid } = recordedSession(state, marker)!;
	page = await desk.reloadWindow(page, "alpha-desk");
	let tree = await desk.sessionsTree(page);
	let row = tree.getByRole("treeitem", { name: new RegExp(`${marker}.*process running`) });
	await desk.revealSessionRow(page, row, 60_000);
	chat = desk.chat(page);
	await expect(chat.locator(".omp-transcript").getByText(`first ${marker}`, { exact: false }).first(), "the reattached Chat shows the turn").toBeVisible({ timeout: 60_000 });

	// 2. Typed /clear.
	await desk.send(chat, "/clear");
	await expect(chat.getByText(CLEAR_DONE_SENTENCE), "typed /clear says so").toBeVisible({ timeout: 90_000 });
	await expectClearedBehindDivider(chat, `first ${marker}`, "after typed /clear");
	await chat.locator(".omp-cleared-history summary").click();
	await expect(chat.locator(".omp-cleared-history").getByText(`first ${marker}`, { exact: false }).first(), "opening the divider shows the cleared turn").toBeVisible();
	await chat.locator(".omp-cleared-history summary").click();

	// 3. A second turn, cleared from the Sessions row's menu.
	const second = `second ${marker}`;
	await desk.send(chat, second);
	await expect(chat.locator(".omp-transcript").getByText(`Mock reply to: ${second}`), "the model answered after the clear").toBeVisible({ timeout: 90_000 });
	await expect(desk.composer(chat), "the turn ended").toBeVisible({ timeout: 60_000 });
	tree = await desk.sessionsTree(page);
	row = tree.getByRole("treeitem", { name: new RegExp(marker) }).first();
	await desk.rowMenu(page, row, "Clear Context…");
	const question = desk.dialog(page);
	await expect(question, "the modal question").toBeVisible({ timeout: 30_000 });
	await question.getByRole("button", { name: "Clear Context", exact: true }).click();
	await expect(chat.getByText(CLEAR_DONE_SENTENCE), "the menu clear says so").toBeVisible({ timeout: 90_000 });
	await expectClearedBehindDivider(chat, second, "after the menu clear");

	// 4. Reload Window: the clear holds after a reattach too.
	page = await desk.reloadWindow(page, "alpha-desk");
	tree = await desk.sessionsTree(page);
	row = tree.getByRole("treeitem", { name: new RegExp(`${marker}.*process running`) });
	await desk.revealSessionRow(page, row, 60_000);
	chat = desk.chat(page);
	await expectClearedBehindDivider(chat, second, "after Reload Window");
	await expect(chat.locator(".omp-transcript").getByText(`first ${marker}`, { exact: false }), "nor the first turn").toHaveCount(0);
	expect(recordedSession(state, marker)?.childPid, "the same OMP process served all of it").toBe(childPid);
});
