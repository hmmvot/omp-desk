import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { paletteHex, parseAnsi, sanitizeAnsi, stripAnsi, withoutCutSgr, type AnsiLine } from "./ansi.ts";

const ESC = "\u001b";
const runs = (text: string): [string, unknown][] => parseAnsi(text)[0]!.map(span => [span.text, span.style]);
const plain = (lines: readonly AnsiLine[]): string => lines.map(line => line.map(span => span.text).join("")).join("\n");

describe("ansi parser", () => {
	it("reads SGR colors: 16-color, bright, 256-color and truecolor, foreground and background", () => {
		assert.deepEqual(runs(`${ESC}[31mred${ESC}[0m`), [["red", { fg: 1 }]]);
		assert.deepEqual(runs(`${ESC}[94;42mx`), [["x", { fg: 12, bg: 2 }]]);
		assert.deepEqual(runs(`${ESC}[38;5;202;48;5;17mx`), [["x", { fg: 202, bg: 17 }]]);
		assert.deepEqual(runs(`${ESC}[38;2;0;180;255mx${ESC}[48;2;1;2;3my`), [["x", { fg: "#00b4ff" }], ["y", { fg: "#00b4ff", bg: "#010203" }]]);
		assert.deepEqual(runs(`${ESC}[38:2::10:20:30mx${ESC}[38:5:9my`), [["x", { fg: "#0a141e" }], ["y", { fg: 9 }]]);
	});

	it("combines attributes and ends them with the matching reset", () => {
		assert.deepEqual(runs(`${ESC}[1;2;3;4;7;9mall${ESC}[22mnot-bold${ESC}[23;24;27;29mplain`), [
			["all", { bold: true, dim: true, italic: true, underline: true, strike: true, inverse: true }],
			["not-bold", { italic: true, underline: true, strike: true, inverse: true }],
			["plain", null],
		]);
		assert.deepEqual(runs(`${ESC}[1m${ESC}[31mx${ESC}[m y`), [["x", { fg: 1, bold: true }], [" y", null]]);
		assert.deepEqual(runs(`${ESC}[31mred${ESC}[39mdefault${ESC}[41mbg${ESC}[49mnone`), [["red", { fg: 1 }], ["default", null], ["bg", { bg: 1 }], ["none", null]]);
	});

	it("reads the /context bar shape: one color run after another, with nothing of a sequence left in the text", () => {
		const bar = `[${ESC}[38;2;107;114;128m░░░░${ESC}[39m${ESC}[38;2;156;163;176m░${ESC}[39m${ESC}[1m${ESC}[38;2;0;180;255m░░░${ESC}[22m${ESC}[39m] 1%  5700 tokens`;
		const line = parseAnsi(bar)[0]!;
		assert.equal(line.map(span => span.text).join(""), "[░░░░░░░░] 1%  5700 tokens");
		assert.deepEqual(line.map(span => span.style), [null, { fg: "#6b7280" }, { fg: "#9ca3b0" }, { bold: true, fg: "#00b4ff" }, null]);
	});

	it("merges neighbours of one style and carries a style across lines", () => {
		const lines = parseAnsi(`${ESC}[32ma${ESC}[32mb\nc${ESC}[0m\nd`);
		assert.deepEqual(lines.map(line => line.map(span => [span.text, span.style])), [[["ab", { fg: 2 }]], [["c", { fg: 2 }]], [["d", null]]]);
	});

	it("ignores out-of-range, unknown and malformed SGR parameters without losing the text", () => {
		assert.deepEqual(runs(`${ESC}[38;5;300mx`), [["x", null]]);
		assert.deepEqual(runs(`${ESC}[38;2;1;2mx`), [["x", null]]);
		assert.deepEqual(runs(`${ESC}[999;1;5mx`), [["x", { bold: true }]]);
		assert.deepEqual(runs(`${ESC}[38;9mx`), [["x", null]]);
		assert.equal(plain(parseAnsi(`${ESC}[${"1;".repeat(400)}mx`)), "x");
	});

	it("removes every other sequence whole", () => {
		const text = [`a${ESC}[2Jb`, `${ESC}[?25lc${ESC}[1;5H`, `${ESC}]0;window title\u0007d`, `${ESC}Pq#0;2;0;0;0${ESC}\\e`, `${ESC}_app${ESC}\\f`, `${ESC}^pm\u0007g`, `${ESC}(Bh${ESC}=${ESC}7i`, `\u009d0;t\u009cj`, `\u009b2Jk`].join("");
		assert.equal(stripAnsi(text), "abcdefghijk");
		assert.equal(plain(parseAnsi(text)), "abcdefghijk");
		assert.equal(sanitizeAnsi(text), "abcdefghijk");
		assert.equal(sanitizeAnsi("\u009b31mx"), `${ESC}[31mx`);
	});

	it("keeps only the link text of an OSC 8 hyperlink, with either terminator", () => {
		const link = `see ${ESC}]8;;https://example.test/a?b=1${ESC}\\the docs${ESC}]8;;${ESC}\\ and ${ESC}]8;id=1;file:///c:/x.ts\u0007x.ts${ESC}]8;;\u0007.`;
		assert.equal(stripAnsi(link), "see the docs and x.ts.");
		assert.doesNotMatch(plain(parseAnsi(link)), /example|file:|8;/);
	});

	it("keeps styling through a hyperlink", () => {
		assert.deepEqual(runs(`${ESC}[34m${ESC}]8;;http://x${ESC}\\link${ESC}]8;;${ESC}\\${ESC}[0m`), [["link", { fg: 4 }]]);
	});

	it("recovers from cut-off and malformed sequences at the byte that broke them", () => {
		assert.equal(stripAnsi(`ab${ESC}`), "ab");
		assert.equal(stripAnsi(`ab${ESC}[`), "ab");
		assert.equal(stripAnsi(`ab${ESC}[38;2;1;2`), "ab");
		assert.equal(stripAnsi(`ab${ESC}[31\ncd`), "ab\ncd");
		assert.equal(stripAnsi(`ab${ESC}[31\u0007cd`), "abcd");
		assert.equal(stripAnsi(`ab${ESC}]0;never ended\ncd`), "ab\ncd");
		assert.equal(stripAnsi(`ab${ESC}]0;cut${ESC}[31mcd`), "abcd");
		assert.equal(stripAnsi(`${ESC}${ESC}[31mx`), "x");
		assert.deepEqual(runs(`${ESC}[1${ESC}[31mx`), [["x", { fg: 1 }]]);
		assert.equal(stripAnsi(`x${ESC}[31;`), "x");
		assert.equal(stripAnsi(`x${ESC}[1 y`), "x");
	});

	it("does not treat an SGR with an intermediate byte, or other CSI finals, as styling", () => {
		assert.deepEqual(runs(`${ESC}[1 mx`), [["x", null]]);
		assert.deepEqual(runs(`${ESC}[1Kx${ESC}[1;2Hy`), [["xy", null]]);
		assert.deepEqual(runs(`${ESC}[?1mx`), [["x", null]]);
	});

	it("keeps tab and newline, turns CRLF into LF and drops every other control character", () => {
		assert.equal(stripAnsi("a\tb\r\nc\rd\u0007e\u0000f\u000bg\u007fh\u0085i"), "a\tb\ncdefghi");
		assert.equal(stripAnsi("plain text ✓ 😀"), "plain text ✓ 😀");
	});

	it("never leaves an escape byte or a sequence fragment in any output", () => {
		const hostile = `${ESC}[${ESC}]8;;${ESC}[38;2;${ESC}Pq${ESC}\\${ESC}[1;31`;
		for (const text of [stripAnsi(hostile), sanitizeAnsi(hostile), plain(parseAnsi(hostile))]) assert.doesNotMatch(text, /\u001b|\u009b|\[31|38;2/);
	});

	it("sanitizes to SGR only, verbatim, and can drop a half-cut SGR", () => {
		const text = `${ESC}[1;38;2;0;180;255mbar${ESC}[0m${ESC}[2Jtext${ESC}]0;t\u0007`;
		assert.equal(sanitizeAnsi(text), `${ESC}[1;38;2;0;180;255mbar${ESC}[0mtext`);
		assert.equal(withoutCutSgr(`ab${ESC}[38;2;1`), "ab");
		assert.equal(withoutCutSgr(`ab${ESC}`), "ab");
		assert.equal(withoutCutSgr(`ab${ESC}[0m`), `ab${ESC}[0m`);
		assert.equal(withoutCutSgr("ab"), "ab");
	});

	it("bounds the work on long input: characters read and runs produced", () => {
		const long = `${ESC}[31m${"x".repeat(1000)}`;
		assert.equal(plain(parseAnsi(long, { maxChars: 100, maxSpans: 10 })).length, 100 - 5);
		const flicker = Array.from({ length: 500 }, (_, index) => `${ESC}[${31 + (index % 2)}mx`).join("");
		const line = parseAnsi(flicker, { maxChars: 1_000_000, maxSpans: 50 })[0]!;
		assert.ok(line.length <= 50);
		assert.equal(line.map(span => span.text).join(""), "x".repeat(500));
		const started = performance.now();
		parseAnsi(`${ESC}[`.repeat(100_000) + "end");
		stripAnsi(`${ESC}]`.repeat(100_000));
		assert.ok(performance.now() - started < 1_000, "linear on pathological input");
	});

	it("computes 256-color cube and gray ramp values", () => {
		assert.equal(paletteHex(16), "#000000");
		assert.equal(paletteHex(196), "#ff0000");
		assert.equal(paletteHex(21), "#0000ff");
		assert.equal(paletteHex(231), "#ffffff");
		assert.equal(paletteHex(232), "#080808");
		assert.equal(paletteHex(255), "#eeeeee");
	});
});
