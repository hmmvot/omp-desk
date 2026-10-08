/**
 * Where the user is looking while a terminal pane is displayed.
 *
 * The pane that is displayed reports itself here, and the host learns the same facts
 * through `omp:terminal-visibility` / `omp:terminal-focus` so that, when more than one
 * editor shows the same terminal, exactly one frontend owns input.
 *
 * The state is this document's own and is never persisted: a document reloaded from
 * disk starts with nothing displayed, which is the truth.
 */

export interface TerminalPresence {
	/** The terminal pane is the pane this document displays. */
	readonly visible: boolean;
	/** Keyboard focus is inside the terminal pane. */
	readonly focused: boolean;
	/** The generation that pane is displaying, or `null` when it holds none. */
	readonly generation: string | null;
}

const listeners = new Set<(presence: TerminalPresence) => void>();
let presence: TerminalPresence = { visible: false, focused: false, generation: null };

/** Report where the terminal pane is; a repeat of the current state is a no-op. */
export function reportTerminalPresence(next: Partial<TerminalPresence>): void {
	const merged: TerminalPresence = { ...presence, ...next };
	if (merged.visible === presence.visible && merged.focused === presence.focused && merged.generation === presence.generation) return;
	presence = merged;
	for (const listener of [...listeners]) listener(presence);
}

/** The last reported presence; nothing displayed before a pane reports. */
export function terminalPresence(): TerminalPresence {
	return presence;
}

/** Subscribe to changes; the returned function unsubscribes. */
export function subscribeTerminalPresence(listener: (presence: TerminalPresence) => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}
