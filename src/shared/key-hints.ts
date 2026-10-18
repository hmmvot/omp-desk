/**
 * The keys the empty Chat shows, as host and page both know them (docs/designs/2026-10-18-chat-keys-and-empty-state.md).
 *
 * The host works out, for each command below, the key the user effectively has and the other commands that may take it
 * (`src/host/key-hints.ts`); the page draws the answer next to each hint (`src/webview/components/EmptyState.tsx`). This one list
 * is what both sides agree on, so the page names no command the host would not answer for.
 */

/** The Desk commands whose key the empty state shows or whose conflict it can open. Order is not meaningful. */
export const EMPTY_STATE_KEY_COMMANDS = [
	"ompDesk.searchPromptHistory",
	"ompDesk.stopTurn",
	"ompDesk.findInChat",
	"ompDesk.quoteChatSelection",
	"ompDesk.toggleThinking",
	"ompDesk.toggleToolOutput",
	"ompDesk.quoteEditorSelection",
	"ompDesk.focusComposer",
	"ompDesk.goToSession",
	"ompDesk.newSession",
	"ompDesk.showChatKeyboardShortcuts",
] as const;

export type EmptyStateKeyCommand = (typeof EMPTY_STATE_KEY_COMMANDS)[number];

export function isEmptyStateKeyCommand(value: unknown): value is EmptyStateKeyCommand {
	return typeof value === "string" && (EMPTY_STATE_KEY_COMMANDS as readonly string[]).includes(value);
}

/** Another command that may take a key: who contributed it (an extension's display name, or the user's own file) and its command id. */
export interface ChatKeyConflict {
	by: string;
	command: string;
}

/**
 * One command's effective key. `key` is the display form (`Ctrl+Alt+T`, `Ctrl+K Ctrl+T`, `Alt+↑`), or `null` when the user removed the
 * command's key and left it none. `conflicts` holds at most {@link MAX_KEY_CONFLICTS} entries; `more` counts those left out.
 */
export interface ChatKeyHint {
	command: EmptyStateKeyCommand;
	key: string | null;
	conflicts: ChatKeyConflict[];
	more: number;
}

/** Hints one `omp:chat-keys` message may carry: one per command of {@link EMPTY_STATE_KEY_COMMANDS}. */
export const MAX_KEY_HINTS = EMPTY_STATE_KEY_COMMANDS.length;
/** Conflicts one hint names; the rest are counted. */
export const MAX_KEY_CONFLICTS = 3;
/** Longest display key (several chords). */
export const MAX_KEY_LENGTH = 64;
/** Longest `by` and conflicting command id. */
export const MAX_KEY_SOURCE_LENGTH = 128;
