/**
 * The inline grammar of the transcript's Markdown renderer, and the text the renderer shows for each piece of it.
 *
 * One definition serves the renderer (`components/Markdown.tsx`) and quoting (`quote-capture.ts`): quoting maps a selection of the
 * *shown* text back to the source through these pieces, so the two must never drift (docs/designs/2026-10-15-quote-chat-selection.md,
 * Section 3).
 */
import { webLinkUrl } from "../../shared/terminal-links.ts";
import { nextMathSpan } from "./latex-math.ts";
import { latexToUnicode } from "./latex-unicode.ts";

const CODE = "(`[^`\\n]+`)";
const EMPHASIS = "(\\*\\*[^*\\n]+\\*\\*)|(__[^_\\n]+__)|(\\*[^*\\n]+\\*)|(_[^_\\n]+_)|(~~[^~\\n]+~~)";
const LINKS = "(\\[[^\\]\\n]*\\]\\((?:[^()\\s]|\\([^()\\s]*\\))+\\))|(\\[Image #[1-9]\\d*(?:,[^\\]\\n]*)?\\])|(<https?:\\/\\/[^\\s<>]+>)|((?<![A-Za-z\\d+.-])[Hh][Tt][Tt][Pp][Ss]?:\\/\\/[^\\s<>\"`]+)";

/**
 * Inline token grammar; code wins over emphasis, bold over italic, matching markdown. A bare URL
 * is one token so the `_`/`*` inside it never start emphasis; `<https://…>` is an autolink.
 */
export const INLINE_TOKEN = new RegExp(`${CODE}|${EMPHASIS}|${LINKS}`, "g");

/**
 * The grammar of text the user typed: the same tokens without `**x**`, `__x__`, `*x*`, `_x_` and `~~x~~`, so the characters
 * of `obj._method() … obj._other()` or `1*234*343` stay as written and nothing is styled.
 */
export const USER_INLINE_TOKEN = new RegExp(`${CODE}|${LINKS}`, "g");

/** How many emphasis levels deep inline content is still parsed for links and code spans (bold inside italic inside strike). */
export const MAX_EMPHASIS_DEPTH = 2;

/** A line longer than this is never searched for math: the search is per line and a transcript line this long is data, not prose. */
const MAX_MATH_LINE = 4000;

/** One token of a line of inline Markdown: where it starts and its exact text. */
export interface InlineMatch {
	readonly index: number;
	readonly text: string;
}

/** Whether `token` (a whole match of {@link scanInline}) is a math span: no other token starts with `$`, `\(` or `\[`. */
export function isMathToken(token: string): boolean {
	return token.startsWith("$") || token.startsWith("\\(") || token.startsWith("\\[");
}

/**
 * The tokens of one line, left to right and without overlap: those of `grammar`, and, when `math` is set, math spans
 * (`lib/latex-math.ts`). Whichever starts first wins, so a `$` inside a code span is code and `*` or `_` inside a math span is
 * math; a math span that starts inside an earlier token is skipped. Math is searched only in text the model wrote.
 */
export function scanInline(text: string, grammar: RegExp, math: boolean): InlineMatch[] {
	const tokens: InlineMatch[] = [];
	const search = math && text.length <= MAX_MATH_LINE;
	let cursor = 0;
	// The first math span at or after `cursor`; it stays the answer for every later cursor that has not passed its start.
	let span = search ? nextMathSpan(text, 0) : undefined;
	while (cursor < text.length) {
		grammar.lastIndex = cursor;
		const found = grammar.exec(text);
		if (span !== undefined && span.start < cursor) span = nextMathSpan(text, cursor);
		if (span !== undefined && (found === null || span.start < found.index)) {
			tokens.push({ index: span.start, text: text.slice(span.start, span.end) });
			cursor = span.end;
			span = nextMathSpan(text, cursor);
		} else if (found !== null) {
			tokens.push({ index: found.index, text: found[0] });
			cursor = found.index + found[0].length;
		} else {
			break;
		}
	}
	return tokens;
}

/** One run of a line of inline Markdown: plain text, or one token; `visible` is the text the renderer shows for it. */
export interface InlinePiece {
	readonly start: number;
	readonly end: number;
	readonly token: boolean;
	readonly visible: string;
}

/** The shown text of a token's inner content: parsed again until the depth bound, plain after it (only where emphasis exists). */
function emphasizedVisible(inner: string, depth: number): string {
	return depth < MAX_EMPHASIS_DEPTH ? inlinePieces(inner, true, depth + 1).map(piece => piece.visible).join("") : inner;
}

/** The Unicode text a math token shows: its body converted (`lib/latex-unicode.ts`); the token as written when the span cannot be re-read (it cannot happen for a token {@link scanInline} found). */
export function mathTokenText(token: string): string {
	const span = nextMathSpan(token, 0);
	return span !== undefined && span.start === 0 && span.end === token.length ? latexToUnicode(span.body) : token;
}

/** The text the renderer shows for `token` (the one place that knows each token kind's markup, beside `renderInline`). */
function tokenVisible(token: string, depth: number): string {
	if (isMathToken(token)) return mathTokenText(token);
	if (token.startsWith("`")) return token.slice(1, -1);
	if (token.startsWith("**") || token.startsWith("__") || token.startsWith("~~")) return emphasizedVisible(token.slice(2, -2), depth);
	if (token.startsWith("[Image #") && !token.includes("](")) return token;
	if (token.startsWith("[")) return token.slice(1, token.indexOf("](")).replace(/`([^`]+)`/g, "$1");
	if (token.startsWith("<")) return webLinkUrl(token.slice(1, -1)) === null ? token : token.slice(1, -1);
	if (/^https?:/i.test(token)) return token;
	return emphasizedVisible(token.slice(1, -1), depth);
}

/**
 * The pieces of one line of inline Markdown, in order, covering the line; the plain pieces between tokens are text as it stands.
 * `emphasis` is false for text the user typed ({@link USER_INLINE_TOKEN}): it must match how the renderer parsed the line.
 */
export function inlinePieces(text: string, emphasis = true, depth = 0): InlinePiece[] {
	const pieces: InlinePiece[] = [];
	let cursor = 0;
	for (const match of scanInline(text, emphasis ? INLINE_TOKEN : USER_INLINE_TOKEN, emphasis)) {
		if (match.index > cursor) pieces.push({ start: cursor, end: match.index, token: false, visible: text.slice(cursor, match.index) });
		pieces.push({ start: match.index, end: match.index + match.text.length, token: true, visible: tokenVisible(match.text, depth) });
		cursor = match.index + match.text.length;
	}
	if (cursor < text.length) pieces.push({ start: cursor, end: text.length, token: false, visible: text.slice(cursor) });
	return pieces;
}
