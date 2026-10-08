/**
 * Whether this panel's completion popup or context popover is open.
 *
 * Each owner reports independently; the extension host needs the aggregate for
 * one decision: Escape must mean "dismiss the popup" while a popup is open, and
 * "stop the turn" otherwise. Without it one keypress would do both, aborting a
 * running agent on an ordinary dismissal.
 *
 * The composer reports its state here, `omp:composer-popup` carries it to the
 * host, and the host's stop keybinding requires a closed popup. Repeated
 * reports of the same state change nothing, and a subscribing reporter is
 * cleaned up by the function it returns.
 */
const listeners = new Set<(open: boolean) => void>();
/** Every chat popup whose open state must keep Escape from also stopping a running turn. */
export type ComposerPopupOwner = "completion" | "context";
const owners = new Set<ComposerPopupOwner>();
let open = false;

/** Closing one popup must not re-enable Stop while another popup remains open. */
export function reportComposerPopupOpen(owner: ComposerPopupOwner, next: boolean): void {
	if (next) owners.add(owner);
	else owners.delete(owner);
	const anyOpen = owners.size > 0;
	if (anyOpen === open) return;
	open = anyOpen;
	for (const listener of [...listeners]) listener(open);
}

/** The last reported state; `false` before any composer has reported. */
export function composerPopupOpen(): boolean {
	return open;
}

/** Subscribe to changes; the returned function unsubscribes. */
export function subscribeComposerPopupOpen(listener: (open: boolean) => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}
