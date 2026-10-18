/**
 * Slash commands Chat runs itself on the session instead of sending them to OMP (ADR-0059).
 *
 * `/clear` is OMP's in-place context reset (through the Desk-registered `omp-desk-clear`), `/new` starts a new session
 * in the same folder in place of this tab, `/delete` runs Desk's own Delete Session flow for this session and then
 * starts a new one, and `/fork` opens a copy of this session in a new Chat tab beside it (the original is untouched).
 * Only a leading `/name` token counts, the same token rule as the identity-command refusal; any
 * text after it is an argument these commands do not take.
 */

export type DeskSessionCommand = "clear" | "new" | "delete" | "fresh" | "fork";

const NAMES: Readonly<Record<string, DeskSessionCommand>> = { clear: "clear", new: "new", delete: "delete", fresh: "fresh", fork: "fork" };

/** The Desk session command a draft starts with, and whether anything follows the command name; `null` otherwise. */
export function deskSessionCommand(text: string): { command: DeskSessionCommand; hasArguments: boolean } | null {
	const match = /^\s*\/([A-Za-z][A-Za-z0-9_-]*)(?=\s|$)(.*)$/s.exec(text);
	if (match === null) return null;
	const command = NAMES[match[1]!.toLowerCase()];
	return command === undefined ? null : { command, hasArguments: match[2]!.trim().length > 0 };
}

/** The sentence shown when `/new` is typed while a response is running. */
export const NEW_BUSY_SENTENCE = "A response is running. Stop it first, then use /new.";
/** The sentence shown when `/new` or `/delete` takes arguments. */
export const DESK_COMMAND_ARGUMENTS_SENTENCE = "This command takes no arguments.";
/** The sentence shown when a Desk session command cannot run in this host. */
export const DESK_COMMAND_UNAVAILABLE_SENTENCE = "This command is unavailable in this host.";
