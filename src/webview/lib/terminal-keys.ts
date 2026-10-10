/**
 * Which keystrokes copy the terminal selection instead of reaching the program.
 *
 * Two policies, chosen per pane by `ctrlCInterrupts`:
 *
 * - **A folder shell** follows the VS Code integrated terminal: Ctrl+C and Ctrl+Insert
 *   copy only while text is selected, and with nothing selected Ctrl+C is the interrupt
 *   byte (a shell needs it); Ctrl+Shift+C always copies.
 * - **A native OMP session** never sends Ctrl+C to the program. Ctrl+C is not an
 *   interrupt while OMP runs, and a forwarded ^C clears the TUI's input
 *   editor, so the key is claimed whether or not text is selected: it copies a selection
 *   and otherwise does nothing. The match follows the physical C key as well as the
 *   letter, so no keyboard layout slips it through.
 *
 * Ctrl+V, Ctrl+Shift+V and Shift+Insert are not classified here: they stay with the
 * browser's paste event.
 */

/** The parts of a `KeyboardEvent` the classification reads. */
export interface TerminalKeyEventLike {
	readonly type: string;
	readonly key: string;
	readonly code: string;
	readonly ctrlKey: boolean;
	readonly shiftKey: boolean;
	readonly altKey: boolean;
	readonly metaKey: boolean;
}

/**
 * `selection`: copy the selection and keep the key from the program (a chord that was
 * only a copy because text is selected). `always`: the key never reaches the program
 * and there is nothing to copy when no text is selected (Ctrl+Shift+C, and Ctrl+C in a
 * pane that never interrupts).
 */
export type TerminalCopyChord = "selection" | "always";

/** A Latin letter wins over the physical key so other layouts keep their own letters. */
function isKey(event: TerminalKeyEventLike, letter: string, code: string): boolean {
	return /^[a-z]$/i.test(event.key) ? event.key.toLowerCase() === letter : event.code === code;
}

export function terminalCopyChord(event: TerminalKeyEventLike, hasSelection: boolean, ctrlCInterrupts: boolean): TerminalCopyChord | null {
	if (!event.ctrlKey || event.altKey || event.metaKey) return null;
	if (event.shiftKey) return isKey(event, "c", "KeyC") ? "always" : null;
	if (isKey(event, "c", "KeyC")) return hasSelection ? "selection" : ctrlCInterrupts ? null : "always";
	if (!hasSelection) return null;
	return event.key === "Insert" || event.code === "Insert" ? "selection" : null;
}

/**
 * A chord the workbench runs, so the terminal must not encode it for the program; unlike a copy
 * chord it must still reach the workbench. Cmd stands in for Ctrl on a Mac, as for every other VS Code chord.
 *
 * - Ctrl+Alt+Shift+R, `OMP: Redraw Terminal`: no OMP default binds it (OMP uses Ctrl+Shift+O,
 *   Alt+Shift+C/L/P/V, Ctrl+Alt+]) and no VS Code default does.
 * - Ctrl+Shift+Q focuses the chat composer and Ctrl+Shift+M moves the file next to the chat into a new window.
 *   A terminal encodes them as Ctrl+Q, OMP's follow-up key on Windows (still available as Ctrl+Q itself), and
 *   Ctrl+M, a carriage return that would submit OMP's input.
 * - Ctrl+Alt+Q, `OMP: Go to Session…`: a terminal would encode it as Escape then Ctrl+Q, which OMP would read
 *   as Alt+Ctrl+Q; no OMP default binds it.
 */
export function isTerminalWorkbenchChord(event: TerminalKeyEventLike): boolean {
	if (!(event.ctrlKey || event.metaKey)) return false;
	if (!event.shiftKey) return event.altKey && isKey(event, "q", "KeyQ");
	return event.altKey ? isKey(event, "r", "KeyR") : isKey(event, "q", "KeyQ") || isKey(event, "m", "KeyM");
}

/**
 * Whether input a never-interrupting pane is about to send carries the interrupt byte.
 * Keys are claimed before xterm encodes them, so this is the second line of defence for
 * encodings that bypass the chord (Ctrl+Alt+C is `ESC ^C`) and for pasted text that
 * contains a literal ^C. The chord and a bare escape prefix are dropped whole, so a
 * lone `ESC` (which OMP reads as Escape) is not left behind; a paste keeps its other
 * characters.
 */
export function withoutInterrupt(data: string): string {
	if (!data.includes("\u0003")) return data;
	return data === "\u0003" || data === "\u001b\u0003" ? "" : data.replaceAll("\u0003", "");
}
