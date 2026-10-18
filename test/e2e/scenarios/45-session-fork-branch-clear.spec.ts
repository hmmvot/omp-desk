/**
 * Scenario: Fork, Branch and Clear for a live Chat session in a real VS Code window, with the real OMP and the mock model
 * (docs/designs/2026-10-18-fork-branch-clear-session-actions.md).
 *
 *   1. One prompt gives the original session a history; its file is read.
 *   2. Fork Session from the row's context menu: a second row and a second Chat tab, whose transcript is the original's history; the
 *      fork's own file names the original as `parentSession`; the original's file stays byte-identical and its process lives on;
 *      both tabs answer a second prompt and the two files diverge.
 *   3. Typed `/fork pane` is refused with one line and opens nothing; typed `/fork` while a response streams shows OMP's own sentence.
 *   4. Branch… on the original's row shows the Rewind message picker.
 *   5. Clear Context… asks first (Cancel changes nothing), then Clear Context appends the reset boundary and says so.
 *
 * Harness: the context menus are VS Code's DOM menus (`window.dialogStyle: custom`, `Desk.rowMenu`), so the real menu contribution is
 * clicked, not `executeCommand`; the modal question is the DOM dialog (`Desk.dialog`). Nothing here uses a native menu or dialog.
 * The OMP session files are read from the isolated agent directory the run gave OMP.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FrameLocator, Locator, Page } from "@playwright/test";
import type { Desk } from "../support/desk.ts";
import { expect, test } from "../support/fixtures.ts";
import { pidAlive, recordedSessions } from "../support/records.ts";
import type { RunState } from "../support/state.ts";
import { sleep } from "../support/time.ts";

/** The sentences the Chat shows (pinned literally: a copy change must be a visible change of this check). */
const FORK_ARGUMENTS_SENTENCE = "/fork takes no arguments here: the fork always opens in a new Chat tab.";
const FORK_BUSY_SENTENCE = "Wait for the current response to finish or abort it before forking.";
const CLEAR_DONE_SENTENCE = "Context cleared. The session, its file and its title are unchanged.";

interface SessionFile {
	readonly path: string;
	readonly bytes: Buffer;
	readonly header: { readonly id: string; readonly parentSession?: string; readonly title?: string; readonly cwd?: string };
}

/** Every OMP session file of the run whose content names `marker`, by path. The run's agent directory and home hold nothing else. */
function sessionFiles(state: RunState, marker: string): SessionFile[] {
	const found: SessionFile[] = [];
	const walk = (dir: string): void => {
		let entries;
		try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
		for (const entry of entries) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) { walk(path); continue; }
			if (!entry.name.endsWith(".jsonl")) continue;
			let bytes: Buffer;
			try { bytes = readFileSync(path); } catch { continue; }
			if (!bytes.includes(marker)) continue;
			// Line 1 is OMP's fixed-width title slot; the session header is the first `type: "session"` line after it.
			const headerLine = bytes.toString("utf8").split("\n").slice(0, 4).find(line => line.startsWith('{"type":"session"'));
			if (headerLine === undefined) continue;
			try { found.push({ path, bytes, header: JSON.parse(headerLine) }); } catch { /* a file mid-write */ }
		}
	};
	walk(state.agentDir);
	walk(state.homeDir);
	return found;
}

const treeRows = (tree: Locator, marker: string): Locator => tree.getByRole("treeitem", { name: new RegExp(marker) });
const chatTabs = (page: Page, marker: string): Locator => page.locator(".editor-group-container .tab").filter({ hasText: marker });

/** The Chat page in front shows `text`; the Chat page of the other tab does not count (hidden editor tabs keep their iframe). */
async function expectTranscript(chat: FrameLocator, text: string, message: string): Promise<void> {
	await expect(chat.locator(".omp-transcript").getByText(text, { exact: false }).first(), message).toBeVisible({ timeout: 60_000 });
}

/** Sends a prompt from the visible Chat and waits until its mock reply is shown and the composer is idle again. */
async function ask(desk: Desk, chat: FrameLocator, prompt: string): Promise<void> {
	await desk.send(chat, prompt);
	await expectTranscript(chat, `Mock reply to: ${prompt}`, `the model answered ${prompt}`);
	await expect(desk.composer(chat), "the turn ended").toBeVisible({ timeout: 60_000 });
}

test("Fork Session, Branch… and Clear Context… act on a live session from its Sessions row", async ({ desk, state }) => {
	test.setTimeout(420_000);
	const marker = `xfork-${Date.now().toString(36)}`;
	const page: Page = await desk.window("alpha-desk");
	await desk.ready(page);
	const tree = await desk.sessionsTree(page);
	let chat = await desk.newChatSession(page, "alpha-desk");

	// 1. The original's history: one prompt and its reply.
	const firstPrompt = `origin ${marker}`;
	await ask(desk, chat, firstPrompt);
	await expect.poll(() => sessionFiles(state, marker).length, { message: "OMP wrote the original's session file", timeout: 30_000 }).toBe(1);
	await expect.poll(() => recordedSessions(state, marker)[0]?.childPid ?? null, { message: "Desk records the original's OMP process" }).not.toBeNull();
	const original = recordedSessions(state, marker)[0]!;
	await expect(treeRows(tree, marker), "one row and one tab before the fork").toHaveCount(1);
	await expect(chatTabs(page, marker)).toHaveCount(1);
	// The writer is asynchronous: wait until the file stopped growing, so the byte-for-byte comparison starts from the settled file.
	let settled = sessionFiles(state, marker)[0]!;
	await expect.poll(() => { const now = sessionFiles(state, marker)[0]!; const same = now.bytes.equals(settled.bytes); settled = now; return same; }, { timeout: 15_000, intervals: [500] }).toBe(true);
	const originalFile = settled;
	const originalRow = treeRows(tree, marker).first();

	// 2. Fork Session from the row's context menu.
	await desk.rowMenu(page, originalRow, "Fork Session");
	await expect(treeRows(tree, marker), "the fork has its own row").toHaveCount(2, { timeout: 90_000 });
	await expect(chatTabs(page, marker), "the fork has its own Chat tab").toHaveCount(2, { timeout: 90_000 });
	chat = desk.chat(page);
	await expectTranscript(chat, firstPrompt, "the fork's transcript holds the original's prompt");
	await expectTranscript(chat, `Mock reply to: ${firstPrompt}`, "the fork's transcript holds the original's reply");

	await expect.poll(() => sessionFiles(state, marker).length, { message: "OMP wrote the fork's session file", timeout: 60_000 }).toBe(2);
	const forkFile = sessionFiles(state, marker).find(file => file.path !== originalFile.path)!;
	console.log(`[fork] original header ${JSON.stringify(originalFile.header)}`);
	console.log(`[fork] fork header ${JSON.stringify(forkFile.header)}`);
	expect(forkFile.header.id, "the fork has its own session id").not.toBe(originalFile.header.id);
	expect(forkFile.header.parentSession, "the fork names the original as its parent").toBe(originalFile.header.id);
	expect(originalFile.header.parentSession, "the original has no parent").toBeUndefined();
	const originalNow = sessionFiles(state, marker).find(file => file.path === originalFile.path)!;
	expect(originalNow.bytes.equals(originalFile.bytes), "the original's file is byte-identical after the fork").toBe(true);
	const recorded = recordedSessions(state, marker);
	expect(recorded.length, "Desk indexes two sessions").toBe(2);
	const survivor = recorded.find(entry => entry.tabId === original.tabId)!;
	expect(survivor.childPid, "the original keeps its OMP process").toBe(original.childPid);
	expect(pidAlive(original.childPid!), "the original's OMP process is alive").toBe(true);
	const forkRecord = recorded.find(entry => entry.tabId !== original.tabId)!;
	await expect.poll(() => recordedSessions(state, marker).find(entry => entry.tabId === forkRecord.tabId)?.childPid ?? null, { message: "the fork runs its own OMP process" }).not.toBeNull();
	const forkPid = recordedSessions(state, marker).find(entry => entry.tabId === forkRecord.tabId)!.childPid!;
	expect(forkPid, "a process of its own").not.toBe(original.childPid);
	expect(pidAlive(forkPid)).toBe(true);

	// Both tabs continue: the fork (in front) first, then the original (the left tab).
	const forkPrompt = `second fork ${marker}`;
	await ask(desk, chat, forkPrompt);
	await chatTabs(page, marker).first().click();
	chat = desk.chat(page);
	await expect(chat.locator(".omp-transcript").getByText(forkPrompt), "the original's transcript does not show the fork's prompt").toHaveCount(0);
	const originalPrompt = `second original ${marker}`;
	await ask(desk, chat, originalPrompt);
	await expect.poll(() => {
		const files = sessionFiles(state, marker);
		const orig = files.find(file => file.path === originalFile.path)!;
		const fork = files.find(file => file.path === forkFile.path)!;
		return [orig.bytes.includes(originalPrompt), orig.bytes.includes(forkPrompt), fork.bytes.includes(forkPrompt), fork.bytes.includes(originalPrompt)];
	}, { message: "the two files diverge", timeout: 30_000 }).toEqual([true, false, true, false]);
	const grown = sessionFiles(state, marker).find(file => file.path === originalFile.path)!;
	expect(grown.bytes.subarray(0, originalFile.bytes.length).equals(originalFile.bytes), "the original only grew: its earlier bytes are untouched").toBe(true);

	// 3. Typed refusals, in the original's composer.
	await desk.send(chat, "/fork pane");
	await expect(chat.getByText(FORK_ARGUMENTS_SENTENCE), "typed /fork pane is refused in one line").toBeVisible({ timeout: 30_000 });
	await expect(treeRows(tree, marker), "no third row").toHaveCount(2);
	await expect(chatTabs(page, marker), "no third tab").toHaveCount(2);

	// `[slow]` makes the mock stream its reply for several seconds: a response is running when /fork is typed.
	const slowPrompt = `[slow] ${marker} ${"streaming ".repeat(20)}`;
	await desk.send(chat, slowPrompt);
	const steer = desk.composerWhileBusy(chat);
	await expect(chat.getByRole("button", { name: /Stop|Abort/ }).first(), "a response is running").toBeVisible({ timeout: 30_000 });
	await steer.fill("/fork");
	await chat.getByRole("button", { name: "Steer the running turn" }).click();
	await expect(chat.getByText(FORK_BUSY_SENTENCE), "typed /fork during a response shows OMP's own sentence").toBeVisible({ timeout: 30_000 });
	await expect(treeRows(tree, marker), "still two rows").toHaveCount(2);
	await expect(chatTabs(page, marker), "still two tabs").toHaveCount(2);
	await expect(desk.composer(chat), "the slow turn ended").toBeVisible({ timeout: 90_000 });

	// 4. Branch… on the original's row shows the Rewind picker. The row is the one that shows the original's transcript.
	const rowOfOriginal = await rowShowing(desk, page, tree, marker, originalPrompt);
	await desk.rowMenu(page, rowOfOriginal, "Branch…");
	chat = desk.chat(page);
	const picker = chat.locator(".omp-rewind-bar--picking");
	await expect(picker, "the Rewind message picker is open").toBeVisible({ timeout: 30_000 });
	await expect(picker.getByRole("button", { name: "Cancel" })).toBeVisible();
	await picker.getByRole("button", { name: "Cancel" }).click();
	await expect(picker).toHaveCount(0);

	// 5. Clear Context…: Cancel changes nothing.
	const beforeClear = sessionFiles(state, marker).find(file => file.path === originalFile.path)!;
	const transcriptBefore = await chat.locator(".omp-transcript").innerText();
	await desk.rowMenu(page, rowOfOriginal, "Clear Context…");
	const question = desk.dialog(page);
	await expect(question, "the modal question").toBeVisible({ timeout: 30_000 });
	await expect(question).toContainText("Clear the context");
	await question.getByRole("button", { name: "Cancel" }).click();
	await expect(question).toHaveCount(0);
	await sleep(2_000);
	expect(sessionFiles(state, marker).find(file => file.path === originalFile.path)!.bytes.equals(beforeClear.bytes), "Cancel left the file untouched").toBe(true);
	expect(await chat.locator(".omp-transcript").innerText(), "Cancel left the transcript untouched").toBe(transcriptBefore);
	await expect(chat.getByText(CLEAR_DONE_SENTENCE)).toHaveCount(0);

	// Confirm: the context is cleared, the file and title stay, the reset boundary is appended.
	await desk.rowMenu(page, rowOfOriginal, "Clear Context…");
	await expect(question).toBeVisible({ timeout: 30_000 });
	await question.getByRole("button", { name: "Clear Context", exact: true }).click();
	await expect(chat.getByText(CLEAR_DONE_SENTENCE), "the context-cleared sentence").toBeVisible({ timeout: 90_000 });
	const afterClear = sessionFiles(state, marker).find(file => file.path === originalFile.path)!;
	console.log(`[fork] file after clear: ${beforeClear.bytes.length} -> ${afterClear.bytes.length} bytes`);
	expect(afterClear.header, "the header (id and title) is unchanged").toEqual(beforeClear.header);
	expect(afterClear.bytes.subarray(0, beforeClear.bytes.length).equals(beforeClear.bytes), "the earlier entries are untouched; only the reset boundary is appended").toBe(true);
	expect(afterClear.bytes.length, "the boundary entries were appended").toBeGreaterThan(beforeClear.bytes.length);
	// ADR-0059: the last confirmed boundary collapses the earlier display history behind a read-only disclosure.
	const disclosure = chat.locator(".omp-cleared-history");
	await expect(disclosure.locator("summary"), "the reset boundary is drawn as a disclosure").toHaveText(/Context cleared · (at least )?\d+ messages? dropped/);
	await expect(chat.locator(".omp-transcript").getByText(firstPrompt, { exact: false }), "the cleared messages are collapsed").toHaveCount(0);
	await disclosure.locator("summary").click();
	await expect(disclosure.getByText(firstPrompt, { exact: false }).first(), "opening the disclosure shows the earlier messages").toBeVisible();
	expect(await desk.dialog(page).count()).toBe(0);
});

/** The Sessions row (of those naming `marker`) whose Chat, once shown, holds `text`: the rows of a fork and its original share one title. */
async function rowShowing(desk: Desk, page: Page, tree: Locator, marker: string, text: string): Promise<Locator> {
	const rows = treeRows(tree, marker);
	const count = await rows.count();
	for (let index = 0; index < count; index++) {
		await rows.nth(index).click();
		const chat = desk.chat(page);
		if (await chat.locator(".omp-transcript").getByText(text).count() > 0) return rows.nth(index);
	}
	throw new Error(`no Sessions row of ${marker} shows ${text}; labels: ${JSON.stringify(await rows.evaluateAll(nodes => nodes.map(node => node.getAttribute("aria-label"))))}`);
}
