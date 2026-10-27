/**
 * Scenario: user link rules (`ompDesk.chatLinkRules`, docs/designs/2026-10-27-chat-link-rules.md) in a real VS Code window.
 *
 *   1. A rule in the profile's user settings turns the matching text of an assistant reply into a link while the user's own message
 *      stays text; a click and Enter reach `vscode.env.openExternal` with the URL the host built from the rule. The test window
 *      must not start a browser: VS Code asks "Do you want Code to open the external website?" for a domain that is not trusted
 *      (the rule's host is a reserved `.test` name), which proves the open request reached VS Code, and the test cancels it. The
 *      log line of `openPageWebLink` (origin only) is the host's own record of the decision.
 *   2. Removing the rule makes the old reply's link text again (the setting is followed live).
 *   3. The same rule only in the workspace's `.vscode/settings.json` is ignored: the setting is application-scoped and the host reads
 *      the user's value only, so a cloned repository cannot inject links.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { deskLogLines } from "../support/desk-log.ts";
import { expect, test } from "../support/fixtures.ts";

const RULE = { pattern: "\\bISSUE-(\\d{1,6})\\b", url: "https://issues.example.test/browse/$1", name: "Issue" };
const OPENED = /web link: opening https:\/\/issues\.example\.test in the external browser/;

test("a rule in user settings links reply text and a click opens its URL through the host; the same rule in workspace settings does nothing", async ({ desk, state }) => {
	test.slow();
	const userSettings = join(state.dataDir, "User", "settings.json");
	const workspaceDir = join(state.folderA, ".vscode");
	const original = readFileSync(userSettings, "utf8");
	const setRules = (rules: unknown): void => {
		const current = JSON.parse(readFileSync(userSettings, "utf8")) as Record<string, unknown>;
		if (rules === undefined) delete current["ompDesk.chatLinkRules"];
		else current["ompDesk.chatLinkRules"] = rules;
		writeFileSync(userSettings, JSON.stringify(current, null, "\t"));
	};
	const page: Page = await desk.window("alpha-desk");
	try {
		await desk.ready(page);
		setRules([RULE]);
		const chat = await desk.newChatSession(page, "alpha-desk");
		await desk.send(chat, "see ISSUE-123 today");
		const reply = chat.locator(".omp-md:not(.omp-user .omp-md) p", { hasText: /Mock reply to: see ISSUE-123/ }).first();
		await expect(reply, "the model answered").toBeVisible({ timeout: 120_000 });

		const link = reply.locator(".omp-rule-link");
		await expect(link, "the rule's match in the reply is a link").toHaveCount(1, { timeout: 30_000 });
		await expect(link).toHaveText("ISSUE-123");
		await expect(link).toHaveAttribute("role", "link");
		await expect(link).toHaveAttribute("title", /https:\/\/issues\.example\.test\/browse\/123/);
		await expect(chat.locator(".omp-user .omp-rule-link"), "the user's own message stays text").toHaveCount(0);
		expect(await reply.innerText(), "no character on screen changed").toContain("Mock reply to: see ISSUE-123 today");

		// A click: VS Code is asked to open the URL the host built, and asks to trust the domain; cancel, so no browser starts.
		await link.click();
		const dialog = desk.dialog(page);
		await expect(dialog, "the open request reached VS Code").toBeVisible({ timeout: 30_000 });
		await expect(dialog).toContainText("issues.example.test");
		await page.keyboard.press("Escape");
		await expect(dialog).toBeHidden();
		await expect.poll(() => deskLogLines(state.dataDir, OPENED).length, { message: "the host logged the open" }).toBeGreaterThan(0);
		const clicks = deskLogLines(state.dataDir, OPENED).length;

		// The keyboard: Enter on the focused link does the same.
		await link.focus();
		await page.keyboard.press("Enter");
		await expect(dialog, "Enter on the link reaches VS Code too").toBeVisible({ timeout: 30_000 });
		await page.keyboard.press("Escape");
		await expect(dialog).toBeHidden();
		await expect.poll(() => deskLogLines(state.dataDir, OPENED).length).toBeGreaterThan(clicks);

		// The setting is followed live: without the rule the reply's text is plain again.
		setRules(undefined);
		await expect(link, "the link goes when the rule does").toHaveCount(0, { timeout: 30_000 });
		expect(await reply.innerText()).toContain("ISSUE-123");

		// The same rule only in the workspace's settings: nothing is linked.
		mkdirSync(workspaceDir, { recursive: true });
		writeFileSync(join(workspaceDir, "settings.json"), JSON.stringify({ "ompDesk.chatLinkRules": [RULE] }, null, "\t"));
		await desk.send(chat, "also ISSUE-456 here");
		const second = chat.locator(".omp-md:not(.omp-user .omp-md) p", { hasText: /Mock reply to: also ISSUE-456/ }).first();
		await expect(second, "the model answered again").toBeVisible({ timeout: 120_000 });
		// Give the workspace file time to be read by VS Code and by the host's refresh before concluding nothing happened.
		await page.waitForTimeout(3_000);
		await expect(chat.locator(".omp-rule-link"), "a workspace-scoped rule is ignored").toHaveCount(0);
		expect(await second.innerText()).toContain("ISSUE-456");
		await expect(desk.dialog(page)).toBeHidden();
	} finally {
		writeFileSync(userSettings, original);
		rmSync(workspaceDir, { recursive: true, force: true });
	}
});
