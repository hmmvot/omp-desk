/**
 * Panel-local registry for the composer actions a VS Code command or keybinding
 * can trigger.
 *
 * A keybinding reaches the extension host, and the extension host answers by
 * posting `omp:webview-action` to the focused panel; this registry is where that
 * message becomes the same function the composer's own buttons call. It exists
 * so a keybinding cannot do anything a button cannot: the composer registers its
 * `send`/`stop`/`focus` entry points here and the panel dispatches into them,
 * rather than the extension host inventing a second way to submit a prompt.
 *
 * Registration returns its own release function, and dispatch tries the newest
 * provider first: a replaced composer owns the action from the
 * moment it mounts, and a stale one cannot keep answering for the panel.
 */
import type { GuestPanelAction } from "../messages.ts";

/**
 * The actions themselves are the message contract's ({@link GuestPanelAction});
 * extending the record with the named members below keeps the doc comments while
 * making the compiler refuse a handler map that misses one.
 */
export interface PanelActionHandlers extends Record<GuestPanelAction, () => void> {
	/** Submit the current draft; a no-op when the composer cannot send it. */
	"send-prompt"(): void;
	/** Stop the running turn (the Stop button's own path). */
	"stop-turn"(): void;
	/** Move focus into the prompt textarea. */
	"focus-composer"(): void;
	/** Re-run a failed or aborted last turn (`/retry`), like the TUI's F5; a no-op while a turn runs. */
	"retry-turn"(): void;
}

const providers: PanelActionHandlers[] = [];

/** Register this composer's handlers; call the returned function on unmount. */
export function providePanelActions(handlers: PanelActionHandlers): () => void {
	providers.push(handlers);
	return () => {
		const index = providers.indexOf(handlers);
		if (index >= 0) providers.splice(index, 1);
	};
}

/**
 * Run `action` in the panel's composer.
 *
 * @returns `false` when no composer is mounted, so the caller can say so
 *          instead of reporting a send or a stop that never happened.
 */
export function requestPanelAction(action: GuestPanelAction): boolean {
	for (let index = providers.length - 1; index >= 0; index--) {
		const provider = providers[index];
		if (provider !== undefined) {
			provider[action]();
			return true;
		}
	}
	return false;
}
