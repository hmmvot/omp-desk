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
 *   and otherwise does nothing.
 *
 * Every letter chord here is the physical key (`src/webview/lib/physical-keys.ts`), so Ctrl+С
 * on a Russian layout is Ctrl+C.
 *
 * Ctrl+V, Ctrl+Shift+V and Shift+Insert are not classified here: they stay with the
 * browser's paste event.
 */

import { isPhysicalKey } from "./physical-keys.ts";

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

export function terminalCopyChord(event: TerminalKeyEventLike, hasSelection: boolean, ctrlCInterrupts: boolean): TerminalCopyChord | null {
	if (!event.ctrlKey || event.altKey || event.metaKey) return null;
	if (event.shiftKey) return isPhysicalKey(event, "KeyC") ? "always" : null;
	if (isPhysicalKey(event, "KeyC")) return hasSelection ? "selection" : ctrlCInterrupts ? null : "always";
	if (!hasSelection) return null;
	return event.key === "Insert" ? "selection" : null;
}

/**
 * A chord the workbench runs, so the terminal must not encode it for the program; unlike a copy
 * chord it must still reach the workbench. Cmd stands in for Ctrl on a Mac, as for every other VS Code chord.
 *
 * - Ctrl+Alt+Shift+R, `OMP Desk: Redraw Terminal`: no OMP default binds it (OMP uses Ctrl+Shift+O,
 *   Alt+Shift+C/L/P/V, Ctrl+Alt+]) and no VS Code default does.
 * - Ctrl+Shift+L focuses the chat composer and Ctrl+Shift+M moves the file next to the chat into a new window.
 *   A terminal encodes them as Ctrl+L, a form feed, and Ctrl+M, a carriage return that would submit OMP's input.
 * - Ctrl+Alt+Q, `OMP Desk: Go to Session…`: a terminal would encode it as Escape then Ctrl+Q, which OMP would read
 *   as Alt+Ctrl+Q; no OMP default binds it.
 * - Ctrl+Alt+N, `OMP Desk: New Session`, and Ctrl+Alt+R, `OMP Desk: Resume Session`: encoded as Escape then Ctrl+N or Ctrl+R,
 *   which OMP would read as Alt+Ctrl+N and Alt+Ctrl+R; its documented defaults bind neither (Ctrl+R is history search,
 *   Alt+R retries). Ctrl+Alt+Shift+R above is the different Redraw Terminal chord.
 */
export function isTerminalWorkbenchChord(event: TerminalKeyEventLike): boolean {
	if (!(event.ctrlKey || event.metaKey)) return false;
	if (!event.shiftKey) return event.altKey && (isPhysicalKey(event, "KeyQ") || isPhysicalKey(event, "KeyN") || isPhysicalKey(event, "KeyR"));
	return event.altKey ? isPhysicalKey(event, "KeyR") : isPhysicalKey(event, "KeyL") || isPhysicalKey(event, "KeyM");
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
