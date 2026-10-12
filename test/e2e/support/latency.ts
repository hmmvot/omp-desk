/**
 * In-page latency: from the `pointerdown` of a real (Playwright-dispatched) click to the moment a DOM condition became
 * true, both read from the page's own clock inside one MutationObserver callback. This excludes CDP round trips and
 * Playwright's actionability waits, which would otherwise add tens of milliseconds to every sample.
 */
import type { Locator, Page } from "@playwright/test";

export interface ReadyCondition {
	/** CSS selector evaluated against the workbench document. */
	readonly selector: string;
	/** At least this many matches must be rendered (have a layout box) for the click's result to count as on screen. */
	readonly minCount: number;
}

/**
 * Clicks `target` and returns the milliseconds until `ready` first held, measured in the page. Returns -1 when it did
 * not hold within `timeoutMs`.
 */
export async function clickToReady(page: Page, target: Locator, ready: ReadyCondition, timeoutMs = 30_000): Promise<number> {
	await page.evaluate(({ selector, minCount }) => {
		const probe: { down?: number; done?: number; observer?: MutationObserver } = {};
		Reflect.set(window, "__latency", probe);
		const rendered = (): number => [...document.querySelectorAll(selector)].filter(element => element.getClientRects().length > 0).length;
		const check = (): void => {
			if (probe.down !== undefined && probe.done === undefined && rendered() >= minCount) probe.done = performance.now();
		};
		document.addEventListener("pointerdown", event => { probe.down = event.timeStamp; probe.done = undefined; }, { capture: true, once: true });
		probe.observer = new MutationObserver(check);
		probe.observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
	}, ready);
	await target.click();
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const sample = await page.evaluate(() => {
			const probe: { down?: number; done?: number } = Reflect.get(window, "__latency");
			return { down: probe.down, done: probe.done };
		});
		const finished = sample.down !== undefined && sample.done !== undefined;
		if (finished || Date.now() > deadline) {
			await page.evaluate(() => { Reflect.get(window, "__latency").observer?.disconnect(); });
			return finished ? sample.done! - sample.down! : -1;
		}
		await page.waitForTimeout(25);
	}
}
