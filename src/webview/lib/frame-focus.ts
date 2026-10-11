/**
 * Give an element back the keyboard focus that VS Code took from it by focusing the page's frame.
 *
 * When a window gains the operating-system focus, VS Code's webview editor focuses its webview again (`WebviewEditor`
 * re-runs `focus()` on every window focus while it is the active editor and the editor part holds the DOM focus). The
 * webview is two frames deep, and the workbench's `contentWindow.focus()` on the outer one moves the focused frame away
 * from the page's own frame; 50 ms later the webview host focuses the page's frame again. Chromium clears the focused
 * element when its frame loses the focus that way, so a click into the composer of an unfocused window lands, is
 * followed by that refocus, and leaves the page focused with nothing focused in it.
 *
 * The page sees `focusout` of an element with no element taking the focus, the window's `blur` in the same task with
 * `document.activeElement` already the body, and the window's `focus` shortly after. The operating system
 * deactivating the window keeps `activeElement`, so it never matches. A user who clicks away from the page and comes
 * back later also does not match: the return is not within {@link FRAME_REFOCUS_MS}.
 */

/** The longest between an element losing focus and the window blur that says its frame lost the focus too. */
export const FRAME_BLUR_PAIR_MS = 100;
/** The longest between that window blur and the window focus that returns the frame; VS Code's own wait is 50 ms. */
export const FRAME_REFOCUS_MS = 750;

export class FrameFocusRestorer {
	readonly #now: () => number;
	#left: { readonly element: unknown; readonly at: number } | null = null;
	#lost: { readonly element: unknown; readonly at: number } | null = null;

	constructor(now: () => number) {
		this.#now = now;
	}

	/** An element lost focus; `toElement` says whether another element took it. */
	focusOut(element: unknown, toElement: boolean): void {
		this.#left = toElement || element === null || element === undefined ? null : { element, at: this.#now() };
	}

	/** The window lost focus; `idle` says whether nothing in the page holds focus any more (the body does). */
	windowBlur(idle: boolean): void {
		const left = this.#left;
		this.#left = null;
		const at = this.#now();
		this.#lost = idle && left !== null && at - left.at <= FRAME_BLUR_PAIR_MS ? { element: left.element, at } : null;
	}

	/** The window gained focus; the element to give the focus back to, or `null` when nothing should be restored. */
	windowFocus(idle: boolean): unknown {
		const lost = this.#lost;
		this.#lost = null;
		return lost !== null && idle && this.#now() - lost.at <= FRAME_REFOCUS_MS ? lost.element : null;
	}
}

/** Starts restoring focus taken by VS Code's webview refocus in `win`; returns the function that stops it. */
export function restoreFocusTakenByHost(win: Window & typeof globalThis): () => void {
	const doc = win.document;
	const restorer = new FrameFocusRestorer(() => performance.now());
	const idle = (): boolean => doc.activeElement === null || doc.activeElement === doc.body;
	const onFocusOut = (event: FocusEvent): void => restorer.focusOut(event.target, event.relatedTarget !== null);
	const onBlur = (event: Event): void => {
		// Element blurs reach a capturing window listener too; only the window itself losing focus counts.
		if (event.target === win) restorer.windowBlur(idle());
	};
	const onFocus = (event: Event): void => {
		if (event.target !== win) return;
		const element = restorer.windowFocus(idle());
		if (element instanceof win.HTMLElement && element.isConnected && !element.matches(":disabled")) element.focus({ preventScroll: true });
	};
	doc.addEventListener("focusout", onFocusOut, true);
	win.addEventListener("blur", onBlur, true);
	win.addEventListener("focus", onFocus, true);
	return () => {
		doc.removeEventListener("focusout", onFocusOut, true);
		win.removeEventListener("blur", onBlur, true);
		win.removeEventListener("focus", onFocus, true);
	};
}
