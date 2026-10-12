/**
 * Scenario c: a mock-model turn and OMP's real `/context` report render in Chat without terminal escape fragments and
 * with colored spans, and the Context view agrees with the Chat footer's ring and with the report's own percentage.
 */
import { expect, test } from "../support/fixtures.ts";

/** What a raw SGR sequence leaves behind when something prints it instead of interpreting it. */
const ESCAPE_FRAGMENTS = /\u001b|\[\d+(;\d+)*m/;

function percent(text: string | null | undefined, pattern: RegExp): number {
	const match = pattern.exec(text ?? "");
	return match === null ? Number.NaN : Number(match[1]);
}

test("/context renders styled, not as escape fragments, and its numbers match the footer and the Context view", async ({ desk }) => {
	const page = await desk.window("alpha-desk");
	await desk.ready(page);
	const chat = await desk.newChatSession(page, "alpha-desk");
	await desk.send(chat, "context please");
	await expect(chat.getByText("Mock reply to: context please")).toBeVisible();

	await desk.send(chat, "/context");
	const report = chat.locator("pre").filter({ hasText: "System prompt" });
	await expect(report).toBeVisible({ timeout: 60_000 });
	const text = await report.innerText();
	expect(text, "the report carries its own text").toContain("Free");
	expect(text, "no raw escape fragments in the report").not.toMatch(ESCAPE_FRAGMENTS);
	expect(await chat.locator(".omp-transcript").innerText(), "no raw escape fragments anywhere in the transcript").not.toMatch(ESCAPE_FRAGMENTS);
	await expect(report.locator("span[style*='color']"), "the report's bars are colored spans").not.toHaveCount(0);

	// The Context view, for the selected Chat session.
	const sidebar = page.locator("[id='workbench.parts.sidebar']");
	const header = sidebar.getByRole("button", { name: /^Context/ });
	if (await header.getAttribute("aria-expanded") !== "true") await header.click();
	const usage = sidebar.getByRole("tree", { name: "Context" }).getByRole("treeitem", { name: /Context window usage exactly as the Chat footer/ });
	const ring = chat.getByRole("button", { name: /^Context window \d+% used/ });
	await expect(usage).toBeVisible();

	// The report is computed by OMP when it runs and may precede the last usage update by one point; the footer ring and
	// the Context view read the same host state, so they must agree exactly and settle within a point of the report.
	const reportPercent = percent(text, /Context window: \d+ tokens \((\d+)% used\)/);
	expect(reportPercent).not.toBeNaN();
	await expect.poll(async () => {
		const footer = percent(await ring.getAttribute("aria-label"), /(\d+)% used/);
		const view = percent(await usage.innerText(), /(\d+)% used/);
		return footer === view && Math.abs(footer - reportPercent) <= 1;
	}, { message: "footer ring, Context view and /context report must show one percentage", timeout: 30_000 }).toBe(true);
});
