/**
 * A reply's HTML page cannot take the keyboard from the page by itself.
 *
 * Chromium already refuses `autofocus` and a `focus()` call made while the frame loads. A script that waits (`setTimeout(() => input.focus(), 500)`,
 * `window.focus()`) does take the focus from the composer, and then the user's typing and VS Code's shortcuts go into the frame. The
 * frame's own events are invisible to this page, but the focus change is not: the window blurs and `document.activeElement` becomes
 * the frame's element. That is accepted when the user caused it (a click inside the frame leaves the page with user activation and
 * no key typed here a moment before; Tab walked in) and undone otherwise, the focus returning to the element that had it.
 *
 * What stays possible: a frame that grabs the focus within a few seconds of the user's last input, which is the window user
 * activation lasts; it keeps the focus until the user clicks out. This is a guard against a page that interrupts typing, not a
 * boundary: nothing here lets the frame reach the page.
 */

/** The class every HTML page frame carries. */
export const HTML_PAGE_FRAME_CLASS = "omp-htmlpage-frame";

/** A key typed in this page this recently means the frame's focus is not the user's own doing, unless it was Tab. */
const KEY_WINDOW_MS = 600;
const TAB_WINDOW_MS = 400;
/** The element that had the focus is put back only when it lost it this recently. */
const RESTORE_WINDOW_MS = 3000;

export function installHtmlPageFocusGuard(win: Window & typeof globalThis, doc: Document): () => void {
	let lastKeyAt = Number.NEGATIVE_INFINITY;
	let lastTabAt = Number.NEGATIVE_INFINITY;
	let previous: HTMLElement | null = null;
	let previousAt = Number.NEGATIVE_INFINITY;
	/** The frame the user has taken the focus into; a window blur and focus with it still active is not a new decision. */
	let accepted: Element | null = null;
	const now = (): number => win.performance.now();
	const frameOf = (element: Element | null): HTMLIFrameElement | null =>
		element instanceof win.HTMLIFrameElement && element.classList.contains(HTML_PAGE_FRAME_CLASS) ? element : null;

	const onKeyDown = (event: KeyboardEvent): void => {
		lastKeyAt = now();
		if (event.key === "Tab") lastTabAt = lastKeyAt;
	};
	const onFocusOut = (event: FocusEvent): void => {
		const target = event.target;
		if (target instanceof win.HTMLElement && frameOf(target) === null) {
			previous = target;
			previousAt = now();
		}
	};
	const onFocusIn = (event: FocusEvent): void => {
		if (frameOf(event.target instanceof win.Element ? event.target : null) === null) accepted = null;
	};
	const check = (): void => {
		const frame = frameOf(doc.activeElement);
		if (frame === null || frame === accepted) return;
		const at = now();
		const activated = win.navigator.userActivation?.isActive ?? false;
		if ((activated && at - lastKeyAt > KEY_WINDOW_MS) || at - lastTabAt < TAB_WINDOW_MS) {
			accepted = frame;
			return;
		}
		if (previous !== null && previous.isConnected && at - previousAt < RESTORE_WINDOW_MS) previous.focus({ preventScroll: true });
		else frame.blur();
	};
	const onBlur = (event: Event): void => {
		// The window's own blur: the focus moved into a frame (or the window lost the OS focus, which leaves the active element as it was).
		if (event.target === win) win.setTimeout(check, 0);
	};

	win.addEventListener("keydown", onKeyDown, true);
	doc.addEventListener("focusout", onFocusOut, true);
	doc.addEventListener("focusin", onFocusIn, true);
	win.addEventListener("blur", onBlur, true);
	return () => {
		win.removeEventListener("keydown", onKeyDown, true);
		doc.removeEventListener("focusout", onFocusOut, true);
		doc.removeEventListener("focusin", onFocusIn, true);
		win.removeEventListener("blur", onBlur, true);
	};
}

let holders = 0;
let uninstall: (() => void) | null = null;

/** One guard for every page on the document; it stops with the last of them. Returns the release. */
export function holdHtmlPageFocusGuard(): () => void {
	holders++;
	if (holders === 1 && typeof window !== "undefined") uninstall = installHtmlPageFocusGuard(window, document);
	let released = false;
	return () => {
		if (released) return;
		released = true;
		holders--;
		if (holders === 0) {
			uninstall?.();
			uninstall = null;
		}
	};
}
