/**
 * Scenario d: latency budgets of the quick and cached paths, measured inside the page from a real click's `pointerdown`
 * (see support/latency.ts), plus the same measurements under CPU load.
 *
 *   - Sessions layout title button -> QuickPick with its rows rendered: budget 500 ms
 *   - Skills, first expand in a fresh profile ("cold", the inventory worker has to be started): recorded, no budget
 *   - Skills, collapse and expand again (cached): budget 300 ms
 *
 * A budget is checked against the median of three samples. Under load the numbers are recorded and only a coarse bound
 * (several seconds) is asserted: the point there is the report, and a blocked extension host still fails it.
 */
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import type { Desk } from "../support/desk.ts";
import { expect, test } from "../support/fixtures.ts";
import { clickToReady } from "../support/latency.ts";
import { startCpuLoad } from "../support/load.ts";
import type { RunState } from "../support/state.ts";

const SAMPLES = 3;
const LAYOUT_BUDGET_MS = 500;
const CACHED_BUDGET_MS = 300;
const LOADED_CEILING_MS = 8_000;

interface Numbers {
	readonly layoutQuickPickMs: number[];
	readonly skillsColdMs: number;
	readonly skillsCachedMs: number[];
}

const median = (values: readonly number[]): number => [...values].sort((x, y) => x - y)[Math.floor(values.length / 2)];

async function measure(desk: Desk, page: Page): Promise<Numbers> {
	await desk.ready(page);
	const sidebar = await desk.showSidebar(page);
	const sessionsHeader = sidebar.getByRole("button", { name: "Sessions Section" });
	const layoutButton = sidebar.getByRole("button", { name: /Sessions Layout/ });
	const layoutMs: number[] = [];
	for (let sample = 0; sample < SAMPLES; sample++) {
		await sessionsHeader.hover();
		layoutMs.push(await clickToReady(page, layoutButton, { selector: ".quick-input-widget .monaco-list-row", minCount: 3 }));
		await page.keyboard.press("Escape");
		await expect(page.locator(".quick-input-widget")).toBeHidden();
	}

	const skillsHeader = sidebar.getByRole("button", { name: /^Skills/ });
	const skillsRows = { selector: "[role=tree][aria-label='Skills'] [role=treeitem]", minCount: 1 };
	if (await skillsHeader.getAttribute("aria-expanded") === "true") await skillsHeader.click();
	const cold = await clickToReady(page, skillsHeader, skillsRows, 120_000);
	await expect(sidebar.getByRole("tree", { name: "Skills" }).getByRole("treeitem").first()).toBeVisible();
	const cachedMs: number[] = [];
	for (let sample = 0; sample < SAMPLES; sample++) {
		await skillsHeader.click(); // collapse
		await expect(skillsHeader).toHaveAttribute("aria-expanded", "false");
		cachedMs.push(await clickToReady(page, skillsHeader, skillsRows));
	}
	await skillsHeader.click(); // leave it collapsed
	return { layoutQuickPickMs: layoutMs, skillsColdMs: cold, skillsCachedMs: cachedMs };
}

function record(state: RunState, label: string, numbers: Numbers): void {
	const line = JSON.stringify({ label, ...numbers, layoutMedian: median(numbers.layoutQuickPickMs), skillsCachedMedian: median(numbers.skillsCachedMs) });
	console.log(`[latency] ${line}`);
	appendFileSync(join(state.resultsDir, "latency.jsonl"), `${line}\n`);
	test.info().annotations.push({ type: "latency", description: line });
}

test("quick and cached paths stay inside their budgets", async ({ desk, state }) => {
	test.setTimeout(300_000);
	const page = await desk.window("alpha-desk");
	const numbers = await measure(desk, page);
	record(state, "idle", numbers);
	expect(numbers.skillsColdMs, "the cold Skills expand must render rows").toBeGreaterThan(0);
	expect(median(numbers.layoutQuickPickMs), "Sessions layout QuickPick").toBeLessThan(LAYOUT_BUDGET_MS);
	expect(median(numbers.skillsCachedMs), "Skills reopened from the cache").toBeLessThan(CACHED_BUDGET_MS);
});

test("the same measurements under CPU load are recorded", async ({ desk, state }) => {
	test.setTimeout(480_000);
	const page = await desk.window("alpha-desk");
	const load = startCpuLoad();
	try {
		const numbers = await measure(desk, page);
		record(state, `cpu-load x${load.workers}`, numbers);
		for (const value of [...numbers.layoutQuickPickMs, ...numbers.skillsCachedMs]) {
			expect(value, "a quick path under load must still finish").toBeGreaterThan(0);
			expect(value).toBeLessThan(LOADED_CEILING_MS);
		}
	} finally {
		load.stop();
	}
});
