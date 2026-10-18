/**
 * Vocabulary of Desk's Fork (typed `/fork`, the Sessions menu, the palette), shared by the host and the extension.
 *
 * A fork is a new Desk session whose OMP process starts with `--fork <the original's session file>`: OMP itself writes the
 * new file (new id, `parentSession` link, the whole history) and the original's process, tab and file are never touched.
 * Every sentence is fixed; nothing from OMP is shown.
 */

/** Why a session cannot be forked now: decided by the host from state it knows, before anything is launched. */
export type ForkRefusal = "not-live" | "busy" | "empty" | "unsaved" | "terminal";

/** OMP's own sentence for a fork refused while a response streams (its `/fork` command shows exactly this). */
export const FORK_BUSY_SENTENCE = "Wait for the current response to finish or abort it before forking.";

export const FORK_REFUSAL_SENTENCES: Readonly<Record<ForkRefusal, string>> = {
	"not-live": "/fork needs a running session. Resume it first.",
	busy: FORK_BUSY_SENTENCE,
	empty: "This session has no saved messages yet, so there is nothing to fork.",
	unsaved: "OMP is still saving this session. Try again in a moment.",
	terminal: "Fork works in Chat. Show this session in Chat first.",
};

/** `/fork` typed with anything after it: `pane`, `window` and `tab` are the terminal UI's multiplexer placements. */
export const FORK_ARGUMENTS_SENTENCE = "/fork takes no arguments here: the fork always opens in a new Chat tab.";

/** The line shown when the fork's tab could not be opened. */
export const FORK_FAILED_SENTENCE = "/fork did not open a new Chat tab.";

/** What the host knows of a session that may be forked. */
export type ForkSource =
	| { readonly status: "ready"; readonly file: string; readonly sessionId: string; readonly cwd: string }
	| { readonly status: "refused"; readonly reason: ForkRefusal };
