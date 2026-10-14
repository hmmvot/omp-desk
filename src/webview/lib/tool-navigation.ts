/**
 * Arrow-key travel between the heads of the transcript: the tool heads and the group rows that are mounted, in the order
 * they stand on the page. The keys act only while focus is on a head itself, never inside a body, a filter field or a menu, so
 * they never take an arrow key from text being edited or a list being navigated.
 */

/** A head that takes part: a focusable tool head or a group row. */
export const HEAD_SELECTOR = "button.omp-tool-head, button.omp-overview-head";
const NAVIGATION_KEYS: readonly string[] = ["ArrowUp", "ArrowDown", "Home", "End"];

/** Whether `key` on `target` is a head-to-head move, which is not a request to scroll the transcript. */
export function isHeadNavigation(key: string, target: Element | null): boolean {
	return NAVIGATION_KEYS.includes(key) && target?.matches(HEAD_SELECTOR) === true;
}

/** The head `key` goes to from the head `from`, among the heads of the transcript `root` (not those of a nested one or inside a body); `null` where it does not move. */
export function nextHead(root: HTMLElement, from: Element, key: string): HTMLElement | null {
	const heads = [...root.querySelectorAll<HTMLElement>(HEAD_SELECTOR)].filter(head => head.closest(".omp-transcript") === root && head.closest(".omp-tool-body") === null);
	const at = heads.indexOf(from as HTMLElement);
	if (at < 0) return null;
	const to = key === "Home" ? 0 : key === "End" ? heads.length - 1 : key === "ArrowUp" ? at - 1 : at + 1;
	return heads[to] ?? null;
}
