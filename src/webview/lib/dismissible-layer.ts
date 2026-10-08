/**
 * The one rule every transient layer in the chat page follows — the Tools menu, the
 * context-usage popover and the `/` and `@` completion list — so each behaves like a
 * VS Code menu instead of carrying its own ad-hoc listeners:
 *
 * - a pointer press or click anywhere outside the layer dismisses it (the transcript, the
 *   composer, the rest of the page); a press inside never does, and the outside press is not
 *   swallowed, so it still performs its own action;
 * - Escape dismisses the most recently opened layer only, never composes with an IME
 *   candidate window, and — when the layer holds focus — returns focus to the control that
 *   opened it;
 * - the webview window losing focus (the user went to another VS Code area) dismisses it.
 *
 * While a layer is open it reports itself through {@link reportComposerPopupOpen} when it
 * names an `owner`, so the host's Escape-to-stop keybinding stays disarmed for that press.
 */
import type { RefObject } from "react";
import { useEffect, useRef } from "react";
import { reportComposerPopupOpen, type ComposerPopupOwner } from "./composer-overlay";

export type DismissReason = "outside" | "escape" | "blur";

export interface DismissibleLayerOptions {
	/** Whether the layer is currently showing; listeners exist only while it is. */
	open: boolean;
	/** Elements that belong to the layer (its trigger and its content); a press inside them is not "outside". */
	inside: readonly RefObject<Element | null>[];
	/** Close the layer. Called at most once per user action. */
	onDismiss(reason: DismissReason): void;
	/** Focus target after an Escape that happened while focus was inside the layer. */
	returnFocusTo?: RefObject<HTMLElement | null>;
	/** Reports the open layer so the host's Escape-to-stop binding does not also fire. */
	owner?: ComposerPopupOwner;
}

/** Open layers, oldest first; Escape belongs to the last one. */
const openLayers: symbol[] = [];

export function useDismissibleLayer(options: DismissibleLayerOptions): void {
	const { open, owner } = options;
	// Handlers read the latest options without re-subscribing on every render.
	const latest = useRef(options);
	latest.current = options;
	useEffect(() => {
		if (!open) return;
		const layer = Symbol("dismissible-layer");
		openLayers.push(layer);
		if (owner !== undefined) reportComposerPopupOpen(owner, true);
		const holdsFocus = (): boolean => {
			const active = document.activeElement;
			return active === null || active === document.body || latest.current.inside.some(ref => ref.current?.contains(active) === true);
		};
		const onPress = (event: Event): void => {
			// `composedPath` is computed at dispatch, so a target a click handler later detaches is still recognised.
			const path = event.composedPath();
			if (latest.current.inside.some(ref => ref.current !== null && path.includes(ref.current))) return;
			latest.current.onDismiss("outside");
		};
		const onKeyDown = (event: KeyboardEvent): void => {
			if (event.key !== "Escape" || event.isComposing || openLayers[openLayers.length - 1] !== layer) return;
			event.preventDefault();
			event.stopPropagation();
			const restore = holdsFocus();
			latest.current.onDismiss("escape");
			if (restore) latest.current.returnFocusTo?.current?.focus();
		};
		const onWindowBlur = (event: FocusEvent): void => {
			// Element blurs reach a capturing window listener too; only the window itself losing focus counts.
			if (event.target === window) latest.current.onDismiss("blur");
		};
		document.addEventListener("pointerdown", onPress, true);
		document.addEventListener("click", onPress, true);
		document.addEventListener("keydown", onKeyDown, true);
		window.addEventListener("blur", onWindowBlur);
		return () => {
			document.removeEventListener("pointerdown", onPress, true);
			document.removeEventListener("click", onPress, true);
			document.removeEventListener("keydown", onKeyDown, true);
			window.removeEventListener("blur", onWindowBlur);
			const index = openLayers.indexOf(layer);
			if (index >= 0) openLayers.splice(index, 1);
			if (owner !== undefined) reportComposerPopupOpen(owner, false);
		};
	}, [open, owner]);
}
