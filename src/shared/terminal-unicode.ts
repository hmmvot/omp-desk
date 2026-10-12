/**
 * Character-width agreement between the OMP TUI and both xterm.js instances that mirror it.
 *
 * The OMP TUI lays out its own rows — wrapping, padding, the hardware cursor column —
 * from `Bun.stringWidth` / `unicode-width`, which are Unicode 11+ tables: an
 * emoji-presentation or East-Asian-Wide code point such as `⌚` (U+231A) or `😀` is two
 * cells. xterm.js starts on its Unicode 6 table, where those code points are one cell, so
 * after such a character the program's cursor position (`CSI row;col H`) and the emulator's
 * own advance disagree by one column per character and the visible cursor drifts to the
 * right of where text lands; wrapping onto the next row repositions it absolutely, which is
 * why the drift appears to heal.
 *
 * The fix is to run the Unicode 11 table on every emulator that interprets this stream:
 * the Webview renderer (what the user sees) and the broker's headless mirror (what a
 * reattach snapshot is serialized from). Both must use the same table, otherwise a
 * serialized screen would place cells differently from the live stream it replaces.
 *
 * `@xterm/addon-unicode-graphemes` was measured against `Bun.stringWidth` and rejected: its
 * `15`/`15-graphemes` providers return one cell for supplementary-plane wide emoji such as
 * `😀` and `🚀` (the common case), which the TUI measures as two. The Unicode 11 addon agrees
 * with the TUI for CJK, `⌚`, and every emoji with a wide default presentation; it still
 * disagrees for sequences that only a grapheme-cluster model can size (a text symbol made
 * emoji by U+FE0F such as `⚠️`, ZWJ families, skin-tone modifiers).
 */

/** The xterm.js `unicode.activeVersion` this extension runs; the Unicode11Addon registers it. */
export const TERMINAL_UNICODE_VERSION = "11";

/** What `loadAddon` needs from an addon; kept structural so xterm and headless both fit. */
export interface TerminalUnicodeAddon {
	activate(terminal: never): void;
	dispose(): void;
}

/** The part of an xterm.js terminal (browser or headless) that width selection touches. */
export interface TerminalUnicodeTarget {
	loadAddon(addon: TerminalUnicodeAddon): void;
	readonly unicode: { activeVersion: string };
}

/**
 * Load the Unicode 11 width addon into `terminal` and make it the active table.
 *
 * The terminal must have been created with `allowProposedApi: true`, which xterm.js
 * requires for the `unicode` API.
 */
export function activateTerminalUnicode(terminal: TerminalUnicodeTarget, unicode11: TerminalUnicodeAddon): void {
	terminal.loadAddon(unicode11);
	terminal.unicode.activeVersion = TERMINAL_UNICODE_VERSION;
}
