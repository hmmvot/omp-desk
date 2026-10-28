/**
 * What the Chat page, the folder-shell page and the lazily loaded terminal renderer (`media/terminal.js`, built from
 * `./entry.ts`) agree on.
 *
 * This module imports no value, so a page can name the contract without pulling xterm.js into its own bundle. The bundles are
 * separate files shipped together; they can still meet in different builds when the extension is reinstalled under a page that
 * stayed open, which is what {@link TERMINAL_CONTRACT} is for.
 */
import type { TerminalRenderer, TerminalRendererHooks } from "../lib/terminal-renderer.ts";

/** Bumped whenever {@link OmpTerminal}, `TerminalRenderer` or `TerminalRendererHooks` changes shape. */
export const TERMINAL_CONTRACT = 1;

/** The page's global the renderer script publishes. */
export const TERMINAL_GLOBAL = "ompTerminal";

export interface OmpTerminal {
	readonly contract: number;
	/**
	 * Create the renderer in `host`, which must already be in the document with its final size. The first call also adds
	 * xterm.js's own stylesheet to the document, ahead of the page's own rules.
	 */
	createTerminalRenderer(host: HTMLElement, hooks: TerminalRendererHooks): TerminalRenderer;
}
