/**
 * The OMP TUI and both xterm.js instances must agree on how many cells a character takes.
 *
 * The TUI sizes characters with Unicode 11+ widths (`Bun.stringWidth`, `unicode-width`) and
 * addresses the cursor by the column it computed. If xterm.js advances by a different
 * amount the visible cursor and the next typed character land off the insertion point; the
 * misalignment disappears when the row wraps because the next row is positioned absolutely.
 *
 * The real xterm.js classes run here, unopened, because the width table and the cursor
 * advance live in the parser, not the renderer: the browser `Terminal` the Webview creates
 * and the `Terminal` of `@xterm/headless` the broker mirrors with. Both are given the
 * Unicode 11 table through the same function the production call sites use.
 *
 * Runner: `node --test src/webview/lib/terminal-unicode.test.ts`
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import { activateTerminalUnicode, TERMINAL_UNICODE_VERSION, type TerminalUnicodeTarget } from "./terminal-unicode.ts";

const require = createRequire(import.meta.url);
const { Unicode11Addon } = require("@xterm/addon-unicode11") as { Unicode11Addon: new () => never };
const xtermModule = require("@xterm/xterm") as { Terminal: TerminalConstructor };
const headlessModule = require("@xterm/headless") as { Terminal: TerminalConstructor };

/** The terminal surface these tests read; both xterm.js classes provide it. */
interface TestTerminal extends TerminalUnicodeTarget {
	write(data: string, callback: () => void): void;
	dispose(): void;
	readonly buffer: {
		readonly active: {
			readonly cursorX: number;
			getLine(y: number):
				| { translateToString(trimRight?: boolean): string; getCell(x: number): { getChars(): string; getWidth(): number } | undefined }
				| undefined;
		};
	};
}
type TerminalConstructor = new (options: { cols: number; rows: number; allowProposedApi: boolean; logLevel: "off" }) => TestTerminal;

const IMPLEMENTATIONS: ReadonlyArray<readonly [string, TerminalConstructor]> = [
	["@xterm/xterm (Webview renderer)", xtermModule.Terminal],
	["@xterm/headless (broker mirror)", headlessModule.Terminal],
];

/**
 * Characters the TUI measures, with the cell count its width function reports. The
 * counts are written out rather than computed: they are the contract being defended.
 */
const MEASURED: ReadonlyArray<{ readonly label: string; readonly text: string; readonly cells: number }> = [
	{ label: "U+231A WATCH (emoji presentation, East-Asian-Wide)", text: "\u231A", cells: 2 },
	{ label: "U+231B U+23F3 hourglasses", text: "\u231B\u23F3", cells: 4 },
	{ label: "U+2705 white heavy check mark", text: "\u2705", cells: 2 },
	{ label: "U+1F600 grinning face (supplementary plane)", text: "\u{1F600}", cells: 2 },
	{ label: "CJK ideographs", text: "\u4F60\u597D", cells: 4 },
	{ label: "mixed narrow, wide emoji and CJK", text: "a\u231Ab\u{1F680}\u754C", cells: 8 },
	{ label: "ASCII only", text: "abc", cells: 3 },
];

/** The TUI's prompt gutter: `> ` is two narrow cells before the input text. */
const PROMPT = "> ";

async function feed(terminal: TestTerminal, data: string): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	terminal.write(data, resolve);
	await promise;
}

function createTerminal(Terminal: TerminalConstructor, unicode: "default" | "unicode11"): TestTerminal {
	const terminal = new Terminal({ cols: 40, rows: 6, allowProposedApi: true, logLevel: "off" });
	if (unicode === "unicode11") activateTerminalUnicode(terminal, new Unicode11Addon());
	return terminal;
}

for (const [implementation, Terminal] of IMPLEMENTATIONS) {
	describe(`cell widths agree with the TUI: ${implementation}`, () => {
		it("activates the Unicode 11 table", () => {
			const terminal = createTerminal(Terminal, "unicode11");
			try {
				assert.equal(terminal.unicode.activeVersion, TERMINAL_UNICODE_VERSION);
				assert.equal(TERMINAL_UNICODE_VERSION, "11");
			} finally {
				terminal.dispose();
			}
		});

		for (const { label, text, cells } of MEASURED) {
			it(`advances ${cells} cells after ${label} and a CSI-positioned cursor lands on the next character`, async () => {
				const terminal = createTerminal(Terminal, "unicode11");
				try {
					// A TUI redraw: clear, home, draw the prompt row, then park the hardware
					// cursor exactly where the input text ends (CSI n G is a 1-based column).
					await feed(terminal, `\u001b[2J\u001b[H${PROMPT}${text}x`);
					const insertion = PROMPT.length + cells;
					assert.equal(terminal.buffer.active.cursorX, insertion + 1, "plain output advances by the TUI's width");

					await feed(terminal, `\u001b[${insertion + 1}G`);
					assert.equal(terminal.buffer.active.cursorX, insertion, "CSI G addresses the TUI's column");
					const line = terminal.buffer.active.getLine(0);
					assert.ok(line);
					assert.equal(line.getCell(insertion)?.getChars(), "x", "the next character sits at the cursor");
					assert.equal(line.translateToString(true), `${PROMPT}${text}x`);

					// Typing at the parked cursor overwrites exactly the character the TUI meant.
					await feed(terminal, "Z");
					assert.equal(line.translateToString(true), `${PROMPT}${text}Z`);
					assert.equal(terminal.buffer.active.cursorX, insertion + 1);
				} finally {
					terminal.dispose();
				}
			});
		}

		it("gives a wide character one two-cell glyph, not a glyph and a stray cell", async () => {
			const terminal = createTerminal(Terminal, "unicode11");
			try {
				await feed(terminal, `\u001b[2J\u001b[H${PROMPT}\u231Ax`);
				const line = terminal.buffer.active.getLine(0);
				assert.ok(line);
				assert.equal(line.getCell(PROMPT.length)?.getChars(), "\u231A");
				assert.equal(line.getCell(PROMPT.length)?.getWidth(), 2);
				assert.equal(line.getCell(PROMPT.length + 1)?.getWidth(), 0, "the second cell is the glyph's continuation");
				assert.equal(line.getCell(PROMPT.length + 2)?.getChars(), "x");
			} finally {
				terminal.dispose();
			}
		});

		it("is what the default table gets wrong: one cell for U+231A, so the cursor sits a column early", async () => {
			const terminal = createTerminal(Terminal, "default");
			try {
				await feed(terminal, `\u001b[2J\u001b[H${PROMPT}\u231A`);
				assert.equal(terminal.buffer.active.cursorX, PROMPT.length + 1, "xterm.js defaults to Unicode 6 widths");
			} finally {
				terminal.dispose();
			}
		});
	});
}
