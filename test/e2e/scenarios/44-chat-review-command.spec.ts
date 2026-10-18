/**
 * Scenario: OMP's bundled `/review` command in a Chat, against a real `omp` and a scratch Git repository
 * (docs/designs/2026-10-18-chat-review-command.md). `/review` is not a TUI builtin but a custom command: OMP runs it inside the
 * `prompt` command and asks its questions as `extension_ui_request` dialogs (select, input, editor) with status and notify lines,
 * then returns the review prompt, which becomes the turn. The mock model answers every turn and records the prompt it was given.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FrameLocator, Locator, Page } from "@playwright/test";
import { deskLogLines } from "../support/desk-log.ts";
import type { Desk } from "../support/desk.ts";
import { expect, test } from "../support/fixtures.ts";
import type { RunState } from "../support/state.ts";

const git = (cwd: string, ...args: string[]): string => execFileSync("git", ["-c", "core.autocrlf=false", ...args], { cwd, encoding: "utf8", windowsHide: true }).trim();

/** The model-visible user text of every request the mock has seen. */
async function modelPrompts(mockUrl: string): Promise<string[]> {
	const requests: { fullUserText: string }[] = await (await fetch(`${mockUrl}/__requests`)).json();
	return requests.map(request => request.fullUserText);
}

/** The open dialog of the Chat composer, found by its title. */
const dialog = (chat: FrameLocator, title: string): Locator => chat.locator(".omp-ask").filter({ has: chat.locator(".omp-ask-title", { hasText: title }) });

/** The sentences the Chat shows for a message OMP did not confirm (the composer notice and the transcript marker). */
const UNCONFIRMED = /has not confirmed this message|may not have been delivered/;

/** A repository on `feature` that is one commit ahead of `main` and has an uncommitted change. */
function scratchRepository(state: RunState, name: string): string {
	const folder = join(state.base, "ws", name);
	rmSync(folder, { recursive: true, force: true });
	mkdirSync(folder, { recursive: true });
	git(folder, "init", "-b", "main");
	git(folder, "config", "user.email", "e2e@example.invalid");
	git(folder, "config", "user.name", "e2e");
	writeFileSync(join(folder, "notes.txt"), "one\n");
	git(folder, "add", ".");
	git(folder, "commit", "-m", "first");
	git(folder, "switch", "-c", "feature");
	writeFileSync(join(folder, "notes.txt"), "one\ntwo\n");
	git(folder, "commit", "-am", "second on feature");
	writeFileSync(join(folder, "notes.txt"), "one\ntwo\nthree\n");
	return folder;
}

/** Opens a window on a scratch repository with one Chat session and hands over its chat; closes the window afterwards. */
async function inReviewChat(desk: Desk, state: RunState, name: string, body: (chat: FrameLocator, page: Page) => Promise<void>): Promise<void> {
	const folder = scratchRepository(state, name);
	const main = await desk.window("alpha-desk");
	await desk.ready(main);
	const page: Page = await desk.openWindow(folder, name);
	try {
		await body(await desk.newChatSession(page, name), page);
	} finally {
		await page.close();
	}
}

/** Sends `text` and waits for OMP's Review Mode dialog. */
async function openReviewMode(desk: Desk, chat: FrameLocator, text: string): Promise<Locator> {
	await desk.send(chat, text);
	const picker = dialog(chat, "Review Mode");
	await expect(picker).toBeVisible({ timeout: 60_000 });
	return picker;
}

test("/review on uncommitted changes reaches a review turn, through the Review Mode dialog", async ({ desk, state }) => {
	test.setTimeout(240_000);
	await inReviewChat(desk, state, "review-desk", async chat => {
		const picker = await openReviewMode(desk, chat, "/review");
		await picker.getByRole("button", { name: /Review uncommitted changes/ }).click();
		await expect(chat.getByText(/Mock reply to: ## Code Review Request/)).toBeVisible({ timeout: 90_000 });
		await expect(chat.locator(".omp-user").last()).toContainText("Reviewing uncommitted changes");
		expect((await modelPrompts(state.mockUrl)).some(text => text.includes("## Code Review Request") && text.includes("Reviewing uncommitted changes") && text.includes("+three"))).toBe(true);
		await expect(chat.getByText(UNCONFIRMED)).toHaveCount(0);
	});
});

test("a base branch and a commit are picked from the lists OMP offers", async ({ desk, state }) => {
	test.setTimeout(240_000);
	await inReviewChat(desk, state, "review-picks", async chat => {
		let picker = await openReviewMode(desk, chat, "/review");
		await picker.getByRole("button", { name: /Review against a base branch/ }).click();
		const branches = dialog(chat, "Select base branch to compare against");
		await expect(branches).toBeVisible({ timeout: 60_000 });
		await branches.getByRole("button", { name: /^main/ }).click();
		await expect.poll(async () => (await modelPrompts(state.mockUrl)).some(text => text.includes("Reviewing changes between `main` and `feature` (PR-style)")), { timeout: 90_000 }).toBe(true);

		picker = await openReviewMode(desk, chat, "/review");
		await picker.getByRole("button", { name: /Review a specific commit/ }).click();
		const commits = dialog(chat, "Select commit to review");
		await expect(commits).toBeVisible({ timeout: 60_000 });
		await commits.getByRole("button", { name: /second on feature/ }).click();
		await expect.poll(async () => (await modelPrompts(state.mockUrl)).some(text => /Reviewing commit `[0-9a-f]+`/.test(text)), { timeout: 90_000 }).toBe(true);
	});
});

test("custom review instructions are typed in a multi-line editor dialog", async ({ desk, state }) => {
	test.setTimeout(240_000);
	await inReviewChat(desk, state, "review-custom", async chat => {
		const picker = await openReviewMode(desk, chat, "/review");
		await picker.getByRole("button", { name: /Custom review instructions/ }).click();
		const editor = dialog(chat, "Enter custom review instructions");
		await expect(editor).toBeVisible({ timeout: 60_000 });
		const box = editor.getByRole("textbox");
		await expect(box).toHaveValue("Review the following:\n\n");
		await box.press("Control+End");
		await box.pressSequentially("check the error handling");
		await box.press("Shift+Enter");
		await box.pressSequentially("and the tests");
		await editor.getByRole("button", { name: "Submit" }).click();
		await expect.poll(async () => (await modelPrompts(state.mockUrl)).some(text => text.includes("check the error handling\nand the tests")), { timeout: 90_000 }).toBe(true);
	});
});

test("extra instructions after /review are kept and the menu leaves out the custom choice", async ({ desk, state }) => {
	test.setTimeout(240_000);
	await inReviewChat(desk, state, "review-focus", async chat => {
		const picker = await openReviewMode(desk, chat, "/review focus on error handling");
		await expect(picker.getByRole("button", { name: /Custom review instructions/ })).toHaveCount(0);
		await picker.getByRole("button", { name: /Review uncommitted changes/ }).click();
		await expect.poll(async () => (await modelPrompts(state.mockUrl)).some(text => text.includes("## Code Review Request") && text.includes("focus on error handling")), { timeout: 90_000 }).toBe(true);
	});
});

test("cancelling the Review Mode dialog starts no turn, returns the composer to idle at once and leaves the Chat usable", async ({ desk, state }) => {
	test.setTimeout(240_000);
	await inReviewChat(desk, state, "review-cancel", async chat => {
		const before = (await modelPrompts(state.mockUrl)).length;
		const picker = await openReviewMode(desk, chat, "/review");
		// The progress bar is the composer's "a turn is running" animation: it must be gone a moment after the cancel, every time.
		const progress = chat.locator(".omp-turn-progress");
		for (let round = 1; round <= 3; round++) {
			await chat.getByRole("button", { name: "Cancel" }).click();
			await expect(picker).toHaveCount(0);
			await expect(progress, `round ${round}: the working animation stays after the picker is cancelled`).toHaveCount(0, { timeout: 5_000 });
			await expect(chat.getByRole("button", { name: "Stop the running turn" })).toHaveCount(0);
			if (round < 3) await openReviewMode(desk, chat, "/review");
		}
		await desk.send(chat, "still here");
		await expect(chat.getByText("Mock reply to: still here")).toBeVisible({ timeout: 60_000 });
		const prompts = (await modelPrompts(state.mockUrl)).slice(before);
		expect(prompts.some(text => text.includes("Code Review Request")), "the cancelled review reached the model").toBe(false);
		await expect(chat.getByText(UNCONFIRMED)).toHaveCount(0);
	});
});

test("Escape cancels the Review Mode dialog, wherever the focus is in the Chat, returns the composer to idle and sends the next message", async ({ desk, state }) => {
	test.setTimeout(240_000);
	await inReviewChat(desk, state, "review-escape", async chat => {
		const before = (await modelPrompts(state.mockUrl)).length;
		const progress = chat.locator(".omp-turn-progress");
		// Round 1: the focus is on a picker row; round 2: on the Cancel button; round 3: nowhere in particular (the page body).
		for (let round = 1; round <= 3; round++) {
			const picker = await openReviewMode(desk, chat, "/review");
			if (round === 1) await picker.getByRole("button", { name: /Review uncommitted changes/ }).focus();
			else if (round === 2) await chat.getByRole("button", { name: "Cancel" }).focus();
			else await chat.locator("body").evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));
			await chat.locator("body").press("Escape");
			await expect(picker, `round ${round}: Escape leaves the dialog open`).toHaveCount(0, { timeout: 5_000 });
			await expect(progress, `round ${round}: the working animation stays after Escape`).toHaveCount(0, { timeout: 5_000 });
			await expect(chat.getByRole("button", { name: "Stop the running turn" })).toHaveCount(0);
		}
		await desk.send(chat, "after escape");
		await expect(chat.getByText("Mock reply to: after escape")).toBeVisible({ timeout: 60_000 });
		const prompts = (await modelPrompts(state.mockUrl)).slice(before);
		expect(prompts.some(text => text.includes("Code Review Request")), "the cancelled review reached the model").toBe(false);
		await expect(chat.getByText(UNCONFIRMED)).toHaveCount(0);
	});
});

test("a pull request without the GitHub CLI says so, and so does /review <PR link>", async ({ desk, state }) => {
	test.setTimeout(240_000);
	let ghInstalled = true;
	try { execFileSync("gh", ["--version"], { stdio: "ignore", windowsHide: true }); } catch { ghInstalled = false; }
	test.skip(ghInstalled, "this machine has the GitHub CLI: the missing-gh message cannot be observed");
	await inReviewChat(desk, state, "review-gh", async (chat, page) => {
		const picker = await openReviewMode(desk, chat, "/review");
		await picker.getByRole("button", { name: /Review a specific PR/ }).click();
		// OMP's own notify (error level) is the window's error message, whole in its text and cut to one line by the toast.
		await expect(desk.toasts(page).filter({ hasText: /GitHub CLI \(gh\) is not installed/ }).first()).toBeAttached({ timeout: 60_000 });
		await desk.send(chat, "/review https://github.com/example-org/omp-vscode/pull/1");
		await expect(desk.toasts(page).filter({ hasText: /Failed to fetch PR diff for example-org\/omp-vscode#1/ }).first()).toBeAttached({ timeout: 60_000 });
		await desk.send(chat, "after");
		await expect(chat.getByText("Mock reply to: after")).toBeVisible({ timeout: 60_000 });
		expect((await modelPrompts(state.mockUrl)).some(text => text.includes("Failed to fetch PR diff")), "OMP's failure text must not become a prompt").toBe(false);
	});
});

test("a dialog left open for longer than the command deadline and the idle watchdog costs neither the message nor the connection", async ({ desk, state }) => {
	test.setTimeout(420_000);
	await inReviewChat(desk, state, "review-long", async chat => {
		const recoveries = () => deskLogLines(state.dataDir, /chat connection recovery/).length;
		const before = recoveries();
		const picker = await openReviewMode(desk, chat, "/review");
		// Longer than the 30 s command deadline and than the 90 s silence the watchdog tolerates from an idle session.
		await chat.owner().page().waitForTimeout(100_000);
		await expect(picker).toBeVisible();
		await picker.getByRole("button", { name: /Review uncommitted changes/ }).click();
		await expect(chat.getByText(/Mock reply to: ## Code Review Request/)).toBeVisible({ timeout: 90_000 });
		await expect(chat.getByText(UNCONFIRMED)).toHaveCount(0);
		expect(recoveries(), "the connection was not replaced while the dialog waited").toBe(before);
	});
});

test("/review is suggested with what it offers and takes a PR link or a focus", async ({ desk, state }) => {
	test.setTimeout(240_000);
	await inReviewChat(desk, state, "review-suggest", async chat => {
		await desk.composer(chat).fill("/rev");
		const row = chat.getByRole("listbox", { name: "Slash commands" }).getByRole("option", { name: /\/review/ });
		await expect(row).toContainText("a pull request");
		await expect(row).toContainText("[PR link] [what to focus on]");
	});
});
