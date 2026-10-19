/**
 * Whether the `ompDesk.toolIntentDescriptions` setting is on, which the host pushes with the display preferences. While it
 * is, a tool call that has an intent shows it first in its collapsed head (the reason), before the target (the path or
 * command); see {@link ToolCard}. A module-level store, like the screen-reader mode, so a card deep in the transcript
 * needs no prop from the App.
 */
import { useSyncExternalStore } from "react";

let active = false;
const listeners = new Set<() => void>();

export function setToolIntentFirst(value: boolean): void {
	if (active === value) return;
	active = value;
	for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function useToolIntentFirst(): boolean {
	return useSyncExternalStore(subscribe, () => active, () => active);
}
