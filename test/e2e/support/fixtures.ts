/**
 * `test` for the suite: a worker-scoped `desk` (one CDP connection), an automatic per-test trace and a clean slate
 * after every test.
 *
 * Playwright did not launch this browser, so its own `trace` option does not apply; the trace is started on the
 * connected default context and kept (out/e2e-results/artifacts/<test>/trace.zip) only when the test failed, together
 * with one screenshot of every window. Open a trace with `npx playwright show-trace <trace.zip>`.
 *
 * The clean slate keeps one failed scenario from failing the next: open menus and QuickPicks are dismissed and any
 * window other than the first (`alpha-desk`) is closed.
 */
import { test as base } from "@playwright/test";
import { Desk } from "./desk.ts";
import { readState, type RunState } from "./state.ts";

export { expect } from "@playwright/test";

interface WorkerFixtures {
	desk: Desk;
	state: RunState;
}

export const test = base.extend<{ failureTrace: void; cleanSlate: void }, WorkerFixtures>({
	state: [async ({}, use) => { await use(readState()); }, { scope: "worker" }],
	desk: [async ({ state }, use) => {
		const desk = await Desk.connect(state);
		await use(desk);
		await desk.close();
	}, { scope: "worker" }],
	failureTrace: [async ({ desk }, use, testInfo) => {
		await desk.context.tracing.start({ screenshots: true, snapshots: true, sources: false, title: testInfo.title });
		await use();
		const failed = testInfo.status !== testInfo.expectedStatus;
		if (failed) {
			// The trace follows one page; a failure in another window (the second window of a profile) needs its own picture.
			for (const [index, page] of desk.context.pages().entries()) {
				await page.screenshot({ path: testInfo.outputPath(`window-${index}.png`), timeout: 15_000 }).catch(() => undefined);
			}
		}
		await desk.context.tracing.stop(failed ? { path: testInfo.outputPath("trace.zip") } : undefined);
	}, { auto: true }],
	cleanSlate: [async ({ desk }, use) => {
		await use();
		for (const page of desk.context.pages()) {
			if (page.isClosed()) continue;
			const title = await page.title().catch(() => "");
			if (!title.includes("alpha-desk")) {
				await page.close().catch(() => undefined);
				continue;
			}
			await page.keyboard.press("Escape").catch(() => undefined);
			await page.keyboard.press("Escape").catch(() => undefined);
		}
	}, { auto: true }],
});
