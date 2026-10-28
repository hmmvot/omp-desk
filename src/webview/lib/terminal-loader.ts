/**
 * The page's side of the terminal renderer: when it is loaded and what a refusal reads like.
 *
 * The renderer itself (`media/terminal.js`: xterm.js, its addons and its stylesheet, about 390 KB minified) is not part of the
 * page bundle. A pane adds it as a script the first time it needs a terminal, from the folder this page's own script came from,
 * with this document's nonce (`./sibling-script.ts`); a page that never shows a terminal never fetches it. A page whose bundle
 * and renderer come from different builds (a reinstall under an open page) refuses to talk across the gap.
 */
import { TERMINAL_CONTRACT, TERMINAL_GLOBAL, type OmpTerminal } from "../terminal/contract.ts";
import { loadSiblingScript } from "./sibling-script.ts";

/** What a pane shows when the renderer cannot be used; both end in what the reader can do. */
export const TERMINAL_UNAVAILABLE = "The terminal renderer could not be loaded. Reload the window";
export const TERMINAL_OUT_OF_DATE = "The terminal renderer is out of date. Reload the window";

function isTerminal(value: unknown): value is OmpTerminal {
	return typeof value === "object" && value !== null
		&& "contract" in value && typeof value.contract === "number"
		&& "createTerminalRenderer" in value && typeof value.createTerminalRenderer === "function";
}

/** The renderer the script published, or why it cannot be used. */
function published(): OmpTerminal {
	const terminal: unknown = Reflect.get(window, TERMINAL_GLOBAL);
	if (!isTerminal(terminal)) throw new Error(TERMINAL_UNAVAILABLE);
	if (terminal.contract !== TERMINAL_CONTRACT) throw new Error(TERMINAL_OUT_OF_DATE);
	return terminal;
}

async function fetchTerminal(): Promise<OmpTerminal> {
	if (Reflect.has(window, TERMINAL_GLOBAL)) return published();
	try {
		await loadSiblingScript("terminal.js");
	} catch {
		throw new Error(TERMINAL_UNAVAILABLE);
	}
	return published();
}

let loading: Promise<OmpTerminal> | null = null;

/**
 * The renderer, loaded once. A failure is not remembered: a pane mounted later (the reader switched mode again) tries again,
 * and the reason a refusal is shown for is the one of that attempt.
 */
export function loadTerminal(): Promise<OmpTerminal> {
	const attempt = (loading ??= fetchTerminal());
	attempt.catch(() => {
		if (loading === attempt) loading = null;
	});
	return attempt;
}
