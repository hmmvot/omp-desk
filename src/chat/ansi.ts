/**
 * Terminal styling in text OMP prints for a terminal (`/context` bars, bash output, extension widgets).
 *
 * One tokenizer serves every consumer, so a sequence is never half-handled:
 *
 * - SGR (`ESC [ … m`): colors, bold, dim, italic, underline, strike and inverse are *styling*, kept by
 *   {@link parseAnsi} and {@link sanitizeAnsi}, dropped by {@link stripAnsi}.
 * - Every other escape sequence is removed whole and never shown: CSI that is not SGR, OSC (hyperlinks keep
 *   their link text and lose the URL), DCS/SOS/PM/APC strings, two-character escapes, 8-bit C1 controls.
 * - A sequence that is cut off or malformed is dropped up to the byte that broke it; that byte is then read
 *   as ordinary text (or as the start of the next sequence), so one bad sequence never swallows the output.
 *   A string control ends at its terminator, at the next escape, or at a newline.
 * - Other control characters are dropped. Tab and newline stay; a carriage return is dropped, so `\r\n`
 *   reads as `\n`.
 *
 * The scan is a single left-to-right pass, linear in the input. No consumer ever sees an escape byte.
 */

/** A palette index (0-255) or a `#rrggbb` truecolor. */
export type AnsiColor = number | string;

/** The attributes in force for a run of text; an attribute that is off is absent. */
export interface AnsiStyle {
	readonly fg?: AnsiColor;
	readonly bg?: AnsiColor;
	readonly bold?: true;
	readonly dim?: true;
	readonly italic?: true;
	readonly underline?: true;
	readonly strike?: true;
	readonly inverse?: true;
}

/** Text with one style; `style` is `null` for the default appearance. */
export interface AnsiSpan {
	readonly text: string;
	readonly style: AnsiStyle | null;
}

/** One output line: its styled runs, with no newline inside. */
export type AnsiLine = readonly AnsiSpan[];

export interface AnsiLimits {
	/** Input characters read; the rest is ignored. */
	readonly maxChars: number;
	/** Styled runs produced; once reached, further text joins the last run of its line. */
	readonly maxSpans: number;
}

export const DEFAULT_ANSI_LIMITS: AnsiLimits = { maxChars: 256 * 1024, maxSpans: 20_000 };

/** Longest SGR parameter string honored; a longer one is not a styling worth applying. */
const MAX_SGR_PARAMS_LENGTH = 256;
/** Most parameters applied from one SGR sequence. */
const MAX_SGR_PARAMS = 64;

interface Sink {
	text(text: string): void;
	sgr(params: string): void;
}

const ESC = 0x1b;

function isIntermediateByte(code: number): boolean {
	return code >= 0x20 && code <= 0x2f;
}

/** The index after a CSI whose parameters start at `start` (just past `ESC [` or C1 CSI); SGR goes to `sink`. */
function skipCsi(input: string, start: number, end: number, sink: Sink): number {
	let at = start;
	while (at < end && input.charCodeAt(at) >= 0x30 && input.charCodeAt(at) <= 0x3f) at += 1;
	const paramsEnd = at;
	while (at < end && isIntermediateByte(input.charCodeAt(at))) at += 1;
	if (at >= end || input.charCodeAt(at) < 0x40 || input.charCodeAt(at) > 0x7e) return at;
	if (input.charCodeAt(at) === 0x6d && at === paramsEnd && paramsEnd - start <= MAX_SGR_PARAMS_LENGTH) {
		const params = input.slice(start, paramsEnd);
		if (/^[0-9;:]*$/.test(params)) sink.sgr(params);
	}
	return at + 1;
}

/** The index after a string control (OSC, DCS, SOS, PM, APC) whose payload starts at `start`. */
function skipString(input: string, start: number, end: number): number {
	let at = start;
	while (at < end) {
		const code = input.charCodeAt(at);
		if (code === 0x07 || code === 0x9c) return at + 1;
		if (code === ESC) return input.charCodeAt(at + 1) === 0x5c ? at + 2 : at;
		if (code === 0x0a) return at;
		at += 1;
	}
	return end;
}

/** The index after the escape whose `ESC` is at `esc`. */
function skipEscape(input: string, esc: number, end: number, sink: Sink): number {
	const at = esc + 1;
	if (at >= end) return end;
	const code = input.charCodeAt(at);
	if (code === 0x5b) return skipCsi(input, at + 1, end, sink);
	if (code === 0x5d || code === 0x50 || code === 0x58 || code === 0x5e || code === 0x5f) return skipString(input, at + 1, end);
	let next = at;
	while (next < end && isIntermediateByte(input.charCodeAt(next))) next += 1;
	if (next < end && input.charCodeAt(next) >= 0x30 && input.charCodeAt(next) <= 0x7e) return next + 1;
	return next;
}

function scan(input: string, maxChars: number, sink: Sink): void {
	const end = Math.min(input.length, maxChars);
	let runStart = 0;
	let at = 0;
	while (at < end) {
		const code = input.charCodeAt(at);
		if (code >= 0x20 && code < 0x7f || code > 0x9f || code === 0x0a || code === 0x09) {
			at += 1;
			continue;
		}
		if (at > runStart) sink.text(input.slice(runStart, at));
		if (code === ESC) at = skipEscape(input, at, end, sink);
		else if (code === 0x9b) at = skipCsi(input, at + 1, end, sink);
		else if (code === 0x9d || code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) at = skipString(input, at + 1, end);
		else at += 1;
		runStart = at;
	}
	if (at > runStart) sink.text(input.slice(runStart, at));
}

/** Text with nothing to remove: printable characters, tab, newline. */
const PLAIN = /^[\n\t\u0020-\u007e\u00a0-\uffff]*$/;

/** The text with every escape sequence and control character (other than tab and newline) removed. */
export function stripAnsi(text: string, maxChars = Number.MAX_SAFE_INTEGER): string {
	if (text.length <= maxChars && PLAIN.test(text)) return text;
	let out = "";
	scan(text, maxChars, { text: part => { out += part; }, sgr: () => {} });
	return out;
}

/** The text with SGR styling kept (re-emitted as `ESC [ params m`) and everything else removed. */
export function sanitizeAnsi(text: string, maxChars = Number.MAX_SAFE_INTEGER): string {
	if (text.length <= maxChars && PLAIN.test(text)) return text;
	let out = "";
	scan(text, maxChars, { text: part => { out += part; }, sgr: params => { out += `\u001b[${params}m`; } });
	return out;
}

/** Sanitized text ({@link sanitizeAnsi}) without a trailing SGR sequence that a clamp cut in half. */
export function withoutCutSgr(sanitized: string): string {
	return sanitized.replace(/\u001b(?:\[[0-9;:]*)?$/, "");
}

interface Working {
	fg: AnsiColor | undefined;
	bg: AnsiColor | undefined;
	bold: boolean;
	dim: boolean;
	italic: boolean;
	underline: boolean;
	strike: boolean;
	inverse: boolean;
}

/** A decimal 0-255 parameter, or `null`. */
function byte(value: string | undefined): number | null {
	if (value === undefined || !/^\d{1,3}$/.test(value)) return null;
	const number = Number(value);
	return number <= 255 ? number : null;
}

function hex(r: number, g: number, b: number): string {
	return `#${[r, g, b].map(channel => channel.toString(16).padStart(2, "0")).join("")}`;
}

/** `38:5:n`, `38:2:r:g:b` and the colorspace form `38:2::r:g:b`. */
function colonColor(parts: readonly string[]): AnsiColor | undefined {
	if (parts[1] === "5") return byte(parts[2]) ?? undefined;
	if (parts[1] === "2" && parts.length >= 5) {
		const r = byte(parts[parts.length - 3]);
		const g = byte(parts[parts.length - 2]);
		const b = byte(parts[parts.length - 1]);
		return r !== null && g !== null && b !== null ? hex(r, g, b) : undefined;
	}
	return undefined;
}

function applySgr(state: Working, params: string): void {
	const items = (params === "" ? ["0"] : params.split(";")).slice(0, MAX_SGR_PARAMS);
	for (let index = 0; index < items.length; index += 1) {
		const item = items[index]!;
		if (item.includes(":")) {
			const parts = item.split(":");
			const head = byte(parts[0] === "" ? "0" : parts[0]);
			if (head === 38 || head === 48) {
				const color = colonColor(parts);
				if (color !== undefined) { if (head === 38) state.fg = color; else state.bg = color; }
			} else if (head === 4) {
				state.underline = parts[1] !== "0";
			}
			continue;
		}
		const code = item === "" ? 0 : byte(item);
		if (code === null) continue;
		if (code === 38 || code === 48) {
			const mode = items[index + 1];
			if (mode === "5") {
				const palette = byte(items[index + 2]);
				if (palette !== null) { if (code === 38) state.fg = palette; else state.bg = palette; }
				index += 2;
			} else if (mode === "2") {
				const r = byte(items[index + 2]);
				const g = byte(items[index + 3]);
				const b = byte(items[index + 4]);
				if (r !== null && g !== null && b !== null) { if (code === 38) state.fg = hex(r, g, b); else state.bg = hex(r, g, b); }
				index += 4;
			} else {
				return;
			}
		} else if (code === 0) {
			state.fg = undefined; state.bg = undefined;
			state.bold = state.dim = state.italic = state.underline = state.strike = state.inverse = false;
		} else if (code === 1) state.bold = true;
		else if (code === 2) state.dim = true;
		else if (code === 3) state.italic = true;
		else if (code === 4 || code === 21) state.underline = true;
		else if (code === 7) state.inverse = true;
		else if (code === 9) state.strike = true;
		else if (code === 22) { state.bold = false; state.dim = false; }
		else if (code === 23) state.italic = false;
		else if (code === 24) state.underline = false;
		else if (code === 27) state.inverse = false;
		else if (code === 29) state.strike = false;
		else if (code >= 30 && code <= 37) state.fg = code - 30;
		else if (code === 39) state.fg = undefined;
		else if (code >= 40 && code <= 47) state.bg = code - 40;
		else if (code === 49) state.bg = undefined;
		else if (code >= 90 && code <= 97) state.fg = code - 90 + 8;
		else if (code >= 100 && code <= 107) state.bg = code - 100 + 8;
	}
}

/** The style in force and a key that is equal exactly when two styles are. */
function freeze(state: Working): { style: AnsiStyle | null; key: string } {
	const style: { -readonly [K in keyof AnsiStyle]: AnsiStyle[K] } = {};
	if (state.fg !== undefined) style.fg = state.fg;
	if (state.bg !== undefined) style.bg = state.bg;
	if (state.bold) style.bold = true;
	if (state.dim) style.dim = true;
	if (state.italic) style.italic = true;
	if (state.underline) style.underline = true;
	if (state.strike) style.strike = true;
	if (state.inverse) style.inverse = true;
	const key = Object.entries(style).map(([name, value]) => `${name}=${value}`).join(";");
	return { style: key === "" ? null : style, key };
}

/** The text as lines of styled runs; adjacent runs of one style are merged. Work is bounded by `limits`. */
export function parseAnsi(text: string, limits: AnsiLimits = DEFAULT_ANSI_LIMITS): AnsiLine[] {
	const lines: AnsiSpan[][] = [[]];
	const state: Working = { fg: undefined, bg: undefined, bold: false, dim: false, italic: false, underline: false, strike: false, inverse: false };
	let current = freeze(state);
	let lineKey: string | null = null;
	let spans = 0;
	const push = (piece: string): void => {
		if (piece.length === 0) return;
		const line = lines[lines.length - 1]!;
		const last = line[line.length - 1];
		if (last !== undefined && (lineKey === current.key || spans >= limits.maxSpans)) {
			line[line.length - 1] = { text: last.text + piece, style: last.style };
			return;
		}
		line.push({ text: piece, style: current.style });
		lineKey = current.key;
		spans += 1;
	};
	scan(text, limits.maxChars, {
		text(part) {
			const pieces = part.split("\n");
			push(pieces[0]!);
			for (let index = 1; index < pieces.length; index += 1) {
				lines.push([]);
				lineKey = null;
				push(pieces[index]!);
			}
		},
		sgr(params) {
			applySgr(state, params);
			const next = freeze(state);
			if (next.key !== current.key) current = next;
		},
	});
	return lines;
}

/** The sRGB value of a 256-color palette index of 16 or above (the xterm color cube and gray ramp). */
export function paletteHex(index: number): string {
	if (index >= 232) {
		const level = 8 + (index - 232) * 10;
		return hex(level, level, level);
	}
	const cube = index - 16;
	const step = (value: number): number => (value === 0 ? 0 : 55 + value * 40);
	return hex(step(Math.floor(cube / 36)), step(Math.floor(cube / 6) % 6), step(cube % 6));
}
