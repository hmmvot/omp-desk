/**
 * Give a field back the focus it lost only because it was disabled for a moment.
 *
 * A disabled field cannot hold focus, and the browser does not give it back when the field is enabled again.
 * The chat composer is disabled whenever the session is not live, which happens on its own while the user types:
 * the host re-attaches a session whose connection dropped or went silent, and a rebuild after a damaged frame goes
 * through "resyncing". The draft survives, but the caret does not, and the user types into nothing.
 *
 * The field "holds" focus from the moment it gains it until the focus moves somewhere else for another reason than
 * being disabled: another element takes it, or the user presses on something that takes none. When the field is
 * enabled again while it still holds its place and nothing else has focus, it is focused again.
 */
import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { describeElement, traceNote } from "./focus-trace.ts";

/** `reason` says, for the focus trace, why `enabled` is false. */
export function useHeldFocus(getField: () => HTMLElement | null, enabled: boolean, reason: string): void {
	const held = useRef(false);
	const enabledNow = useRef(enabled);
	useLayoutEffect(() => {
		enabledNow.current = enabled;
	}, [enabled]);

	useEffect(() => {
		const onFocusIn = (event: FocusEvent): void => {
			held.current = event.target !== null && event.target === getField();
		};
		const onFocusOut = (event: FocusEvent): void => {
			const field = getField();
			if (field === null || event.target !== field || field.getAttribute("aria-disabled") === "true") return;
			// The window being deactivated keeps the page's active element: the field still holds its place.
			if (document.activeElement === field) return;
			held.current = false;
		};
		const onPointerDown = (event: PointerEvent): void => {
			// While the field is enabled the focus events say where focus went; a press that keeps it in the field
			// (a suggestion list that refuses the focus) must not clear it. While it is disabled, a press on anything
			// else is the user moving on.
			if (enabledNow.current) return;
			if (!(event.target instanceof Node) || getField()?.contains(event.target) !== true) held.current = false;
		};
		document.addEventListener("focusin", onFocusIn, true);
		document.addEventListener("focusout", onFocusOut, true);
		document.addEventListener("pointerdown", onPointerDown, true);
		return () => {
			document.removeEventListener("focusin", onFocusIn, true);
			document.removeEventListener("focusout", onFocusOut, true);
			document.removeEventListener("pointerdown", onPointerDown, true);
		};
	}, [getField]);

	useLayoutEffect(() => {
		const field = getField();
		if (!enabled) {
			traceNote(`composer not writable: ${reason}`);
			return;
		}
		if (field === null || !held.current || field.getAttribute("aria-disabled") === "true") return;
		const active = document.activeElement;
		if (active !== null && active !== document.body) return;
		field.focus({ preventScroll: true });
		traceNote(`composer focus restored to ${describeElement(field)}; it was disabled while it held focus`);
	}, [getField, enabled, reason]);
}
