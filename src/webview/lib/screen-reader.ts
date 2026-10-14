/**
 * Whether a screen reader is in use (VS Code's `editor.accessibilitySupport` is `on`), which the host pushes with the display
 * preferences. A windowed list is unreadable to a reader, so a tool card's full view puts its whole text in the page instead.
 */
import { useSyncExternalStore } from "react";

let active = false;
const listeners = new Set<() => void>();

export function setScreenReaderMode(value: boolean): void {
	if (active === value) return;
	active = value;
	for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function useScreenReaderMode(): boolean {
	return useSyncExternalStore(subscribe, () => active, () => false);
}
