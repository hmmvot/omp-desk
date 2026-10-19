/**
 * Whether the `ompDesk.chatHtmlPages` setting is on, which the host pushes with the display preferences. While it is off a
 * closed `html` fence of a reply stays a code block ({@link ../components/HtmlPageBlock.tsx}). A module-level store, like the tool
 * intent switch, so a block deep in the transcript needs no prop from the App. A preference the host has not sent yet reads as on.
 */
import { useSyncExternalStore } from "react";

let active = true;
const listeners = new Set<() => void>();

export function setHtmlPagesEnabled(value: boolean): void {
	if (active === value) return;
	active = value;
	for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function useHtmlPagesEnabled(): boolean {
	return useSyncExternalStore(subscribe, () => active, () => active);
}
