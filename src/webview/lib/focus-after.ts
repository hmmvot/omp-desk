/**
 * The element that holds focus once `event` has settled. A `focusout` is dispatched while `document.activeElement` is already
 * `body`, so moving focus between two elements of one card (a menu's items under a mouse press) reads as focus leaving it
 * unless the element taking focus, the event's `relatedTarget`, is used. A `focusout` with no target (the window lost focus,
 * a press on something that cannot take focus) and every other event keep `document.activeElement`.
 */
export function focusAfter(event: Event): Element | null {
	if (event.type === "focusout" && event instanceof FocusEvent && event.relatedTarget instanceof Element) return event.relatedTarget;
	return document.activeElement;
}
