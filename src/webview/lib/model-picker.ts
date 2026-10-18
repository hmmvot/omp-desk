/**
 * Where the rest of the page asks for the model picker. The footer owns the picker (its control book and the host exchange),
 * so it registers its own opener here while it can open one, and the provider-error frame's Switch model calls it: one way to
 * open the picker, the footer's, and never a second implementation of its protocol.
 */
import { useSyncExternalStore } from "react";

let opener: (() => void) | null = null;
const listeners = new Set<() => void>();

/** Register the opener of the footer's model picker, or `null` while it cannot open one; the returned function releases it. */
export function provideModelPicker(open: (() => void) | null): () => void {
	opener = open;
	for (const listener of listeners) listener();
	return () => {
		if (opener !== open) return;
		opener = null;
		for (const listener of listeners) listener();
	};
}

/** Open the picker; `false` when the footer cannot open it now (no live session, a request in flight). */
export function openModelPicker(): boolean {
	if (opener === null) return false;
	opener();
	return true;
}

/** Whether {@link openModelPicker} would open the picker now, tracked for rendering. */
export function useModelPickerAvailable(): boolean {
	return useSyncExternalStore(onChange => { listeners.add(onChange); return () => { listeners.delete(onChange); }; }, () => opener !== null);
}
