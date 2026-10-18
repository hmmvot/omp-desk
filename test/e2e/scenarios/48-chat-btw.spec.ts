/**
 * Scenario: `/btw` side questions in a real Chat against a real `omp` and the mock model server
 * (docs/designs/2026-10-19-chat-btw-side-questions.md). A side question streams into a panel beside a running turn, is never a
 * transcript row or a journal entry, can be cancelled, is listed by a bare `/btw`, and survives Developer: Reload Window (the
 * extension host is replaced; OMP's own history is read again by the new host session).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { FrameLocator, Locator } from "@playwright/test";
import { expect, test } from "../support/fixtures.ts";

const panel = (chat: FrameLocator): Locator => chat.locator(".omp-btw");
const status = (chat: FrameLocator): Locator => chat.locator(".omp-btw .omp-btw-status").first();

/** Every `*.jsonl` file under `root` that contains `text`: the session journals this run wrote. */
function journalsContaining(root: string, text: string): string[] {
	const found: string[] = [];
	const walk = (folder: string): void => {
		for (const name of readdirSync(folder)) {
			const path = join(folder, name);
			const stats = statSync(path);
			if (stats.isDirectory()) walk(path);
			else if (name.endsWith(".jsonl") && readFileSync(path, "utf8").includes(text)) found.push(path);
		}
	};
	walk(root);
	return found;
}

test("a side question streams beside a running turn, stays out of the transcript and the journal, cancels, lists and survives a reload", async ({ desk, state }) => {
	test.setTimeout(360_000);
	const page = await desk.window("alpha-desk");
	await desk.ready(page);
	const chat = await desk.newChatSession(page, "alpha-desk");
	const marker = `side-${Date.now().toString(36)}`;
	const rows = chat.locator(".omp-user");

	// A main turn that streams for several seconds, and a side question asked while it runs.
	await desk.send(chat, `[slow] main turn ${"x".repeat(180)}`);
	await expect(chat.getByRole("button", { name: /Stop/ }).first()).toBeVisible({ timeout: 30_000 });
	const userRowsBefore = await rows.count();
	await desk.send(chat, `/btw ${marker} one`);
	await expect(panel(chat)).toBeVisible({ timeout: 30_000 });
	await expect(panel(chat).locator(".omp-btw-question")).toContainText(`${marker} one`);
	await expect(chat.locator(".omp-btw-answer")).toContainText("Mock reply to", { timeout: 90_000 });
	await expect(status(chat)).toHaveText("Done", { timeout: 90_000 });
	expect(await desk.readDraft(desk.composer(chat)), "an answered /btw consumes the draft").toBe("");
	expect(await rows.count(), "the typed /btw and its answer are not user or assistant rows").toBe(userRowsBefore);
	await expect(chat.locator(".omp-transcript").getByText(`${marker} one`)).toHaveCount(0);

	// Cancel a second one while it streams.
	await desk.send(chat, `/btw [slow] ${marker} two ${"y".repeat(180)}`);
	await expect(status(chat)).toHaveText("Answering…", { timeout: 30_000 });
	await chat.getByRole("button", { name: "Cancel the side question" }).click();
	await expect(status(chat)).toHaveText("Cancelled", { timeout: 60_000 });
	await expect(chat.getByRole("button", { name: "Cancel the side question" })).toHaveCount(0);

	// The main turn is untouched by all of it.
	await expect(chat.getByRole("button", { name: /Stop/ })).toHaveCount(0, { timeout: 90_000 });
	expect(journalsContaining(state.agentDir, marker), "a side question is never written to a session journal").toEqual([]);

	// A bare /btw lists both topics, newest first.
	await chat.getByRole("button", { name: "Close side question" }).click();
	await expect(panel(chat)).toHaveCount(0);
	await desk.send(chat, "/btw");
	await expect(chat.locator(".omp-btw-item")).toHaveCount(2, { timeout: 30_000 });
	await expect(chat.locator(".omp-btw-item-text").first()).toContainText(`${marker} two`);

	// Reload Window replaces the extension host and the page; the new host session reads OMP's history again.
	const after = await desk.reloadWindow(page, "alpha-desk");
	const reloaded = desk.chat(after);
	await expect(desk.composer(reloaded)).toBeVisible({ timeout: 60_000 });
	await desk.send(reloaded, "/btw");
	await expect(reloaded.locator(".omp-btw-item")).toHaveCount(2, { timeout: 60_000 });
	await reloaded.locator(".omp-btw-item").nth(1).click();
	await expect(reloaded.locator(".omp-btw-answer")).toContainText("Mock reply to", { timeout: 30_000 });
});
