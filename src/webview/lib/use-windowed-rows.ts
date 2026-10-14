/**
 * A fixed-row-height list in the normal flow of the page: one spacer of `count × rowHeight`, and only the rows that
 * the nearest scrolling ancestor shows (plus {@link OVERSCAN} above and below) are in the DOM. There is no scroller of
 * its own; the transcript scrolls.
 */
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

/** Rows kept in the DOM beyond the visible range, above and below. */
export const OVERSCAN = 20;
/** A text of more rows than this is windowed (with wrap off); a shorter one is simply rendered. */
export const WINDOW_AFTER_ROWS = 120;
/** With wrap on, at most this many rows are rendered (their height is not fixed, so they cannot be windowed). */
export const WRAP_MAX_ROWS = 1_500;
/** A reader of a screen reader gets the whole text up to this many rows. */
export const READER_MAX_ROWS = 5_000;
/** The rendered range moves in steps of this many rows, so scrolling re-renders the list once per step, not once per frame. */
const STEP = 10;

/** The nearest ancestor that scrolls vertically (`overflow-y` of `auto` or `scroll`): the transcript; `null` when the page itself does. */
export function scrollOwner(element: HTMLElement): HTMLElement | null {
	for (let ancestor = element.parentElement; ancestor !== null; ancestor = ancestor.parentElement) {
		const overflow = getComputedStyle(ancestor).overflowY;
		if (overflow === "auto" || overflow === "scroll") return ancestor;
	}
	return null;
}

export interface WindowedRows {
	readonly ref: RefObject<HTMLDivElement | null>;
	/** Height of one row, in px: read once from the block's font, never from a row. */
	readonly rowHeight: number;
	/** The rows `first..last` of the list are in the DOM. */
	readonly first: number;
	readonly last: number;
}

/** The range of `count` rows to mount, for a block whose top is where `ref` is. A selection inside the block keeps the rows it reached mounted. */
export function useWindowedRows(count: number): WindowedRows {
	const ref = useRef<HTMLDivElement | null>(null);
	const [rowHeight, setRowHeight] = useState(18);
	const [range, setRange] = useState({ first: 0, last: Math.min(count, 2 * OVERSCAN) });
	useLayoutEffect(() => {
		const element = ref.current;
		if (element === null) return;
		const size = Number.parseFloat(getComputedStyle(element).fontSize);
		if (Number.isFinite(size) && size > 0) setRowHeight(Math.round(size * 1.5));
	}, []);
	useEffect(() => {
		const element = ref.current;
		if (element === null) return;
		const owner = scrollOwner(element);
		let frame: number | null = null;
		const compute = (): void => {
			frame = null;
			const box = element.getBoundingClientRect();
			const top = owner === null ? 0 : owner.getBoundingClientRect().top;
			const bottom = owner === null ? window.innerHeight : owner.getBoundingClientRect().bottom;
			const from = Math.max(0, Math.floor((top - box.top) / rowHeight) - OVERSCAN);
			const to = Math.min(count, Math.ceil((bottom - box.top) / rowHeight) + OVERSCAN);
			const first = Math.min(count, Math.floor(from / STEP) * STEP), last = Math.max(first, Math.min(count, Math.ceil(to / STEP) * STEP));
			const selection = document.getSelection();
			const held = selection !== null && !selection.isCollapsed && element.contains(selection.anchorNode);
			setRange(previous => {
				// While the reader holds a selection in the block, the rows it passed over stay: dropping them would drop the selection.
				const next = held ? { first: Math.min(first, previous.first), last: Math.max(last, previous.last) } : { first, last };
				return next.first === previous.first && next.last === previous.last ? previous : next;
			});
		};
		const schedule = (): void => { if (frame === null) frame = requestAnimationFrame(compute); };
		compute();
		(owner ?? window).addEventListener("scroll", schedule, { passive: true });
		window.addEventListener("resize", schedule);
		document.addEventListener("selectionchange", schedule);
		const observer = new ResizeObserver(schedule);
		observer.observe(owner ?? document.documentElement);
		observer.observe(element);
		return () => {
			if (frame !== null) cancelAnimationFrame(frame);
			(owner ?? window).removeEventListener("scroll", schedule);
			window.removeEventListener("resize", schedule);
			document.removeEventListener("selectionchange", schedule);
			observer.disconnect();
		};
	}, [count, rowHeight]);
	return { ref, rowHeight, first: Math.min(range.first, count), last: Math.min(range.last, count) };
}
