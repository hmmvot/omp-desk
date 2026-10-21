/**
 * Keep a text selection from being taken away by VS Code's own Copy.
 *
 * VS Code runs Copy, Cut and Paste of a webview (Ctrl+C, Ctrl+Insert, Edit > Copy, the context menu's Copy) as a message
 * to the page's host frame (`execCommand` in its `index.html`). To rescue a paste after the focus went missing, that code
 * remembers the last element the page focused and, when the page's `document.activeElement` is the `<body>`, focuses that
 * element again just before it runs `document.execCommand`. A selection made with the mouse in the transcript leaves
 * `<body>` active (nothing there takes focus), the last element focused is the composer, and so the Copy that follows moves
 * the focus, and with it the selection, into the empty composer: nothing is copied, and the composer has the focus.
 * No keyboard layout is involved; every Copy of text selected by mouse after the composer was last used does it.
 *
 * The page cannot intercept that refocus, but it can make it land on the selection: while text is selected and nothing holds
 * the focus, the page's root element (made focusable only for that time) takes it. VS Code remembers the root as the last
 * element focused, so even when the frame's own refocus empties the page's focus again (the context menu does it: the window
 * blurs and regains the focus) the Copy that follows refocuses the root, runs on the selection, and the composer is left alone.
 * With no selection the root gives the focus up again. The price is that a Paste from the menu right after a selection that was
 * then cleared has no composer to be rescued into (Ctrl+V and Shift+Insert still reach it, `type-to-focus.ts` moves the focus
 * on the keystroke).
 */

/** Starts holding the focus for a selection in `win`'s document (its `#root` element); returns the function that stops it. */
export function installSelectionFocusHold(win: Window & typeof globalThis): () => void {
	const doc = win.document;
	const root = doc.getElementById("root");
	if (root === null) return () => undefined;
	// A focus change in the middle of a drag ends the selection being dragged, so nothing is done between press and release.
	let pressed = false;
	const settle = (): void => {
		if (pressed) return;
		const selection = doc.getSelection();
		const selected = selection !== null && selection.rangeCount > 0 && !selection.isCollapsed;
		const active = doc.activeElement;
		if (selected) {
			if (active !== null && active !== doc.body && active !== doc.documentElement) return;
			root.tabIndex = -1;
			root.style.outline = "none";
			root.focus({ preventScroll: true });
		} else if (active === root) {
			root.blur();
			root.removeAttribute("tabindex");
			root.style.removeProperty("outline");
		}
	};
	const press = (event: PointerEvent): void => {
		if (event.button === 0) pressed = true;
	};
	const release = (): void => {
		pressed = false;
		settle();
	};
	// Element blurs and focuses reach a capturing window listener too; only the window itself matters here.
	const windowBlur = (event: Event): void => {
		if (event.target === win) pressed = false;
	};
	const windowFocus = (event: Event): void => {
		if (event.target === win) settle();
	};
	// `selectionchange` follows every change a mouse, a double click or Select All makes; the end of a press and a refocus of the
	// window (which can empty the page's focus without a selection change) are checked too.
	doc.addEventListener("selectionchange", settle);
	doc.addEventListener("pointerdown", press, true);
	doc.addEventListener("pointerup", release, true);
	doc.addEventListener("pointercancel", release, true);
	win.addEventListener("blur", windowBlur, true);
	win.addEventListener("focus", windowFocus, true);
	return () => {
		doc.removeEventListener("selectionchange", settle);
		doc.removeEventListener("pointerdown", press, true);
		doc.removeEventListener("pointerup", release, true);
		doc.removeEventListener("pointercancel", release, true);
		win.removeEventListener("blur", windowBlur, true);
		win.removeEventListener("focus", windowFocus, true);
	};
}
