/**
 * A ```svg fence of an assistant reply, made safe to show: parsed with a small XML reader of our own (no DOM, so it runs
 * under plain Node), rebuilt from an allow-list of elements and attributes, and written back as clean SVG text.
 *
 * The source is untrusted model output. Two walls stand between it and the page: this sanitizer, and the way the result is
 * shown (only as the `src` of an `<img>`, where an SVG cannot run script or load anything). Nothing here may throw, hang or
 * emit unescaped markup, so every loop advances through the source, nesting and element counts are capped, and every
 * piece of text that reaches the output is escaped on the way out.
 *
 * Theme tokens follow the terminal UI's `prepareSvg`: `var(--fg)` and friends become the reader's colours, because an SVG
 * image does not see the page's custom properties.
 */

/** The colours (and font) a figure's `var(--token)` references resolve to. */
export interface FigurePalette {
	readonly fg: string;
	readonly muted: string;
	readonly border: string;
	readonly accent: string;
	readonly success: string;
	readonly warning: string;
	readonly error: string;
	readonly surface: string;
	readonly c1: string;
	readonly c2: string;
	readonly c3: string;
	readonly c4: string;
	readonly c5: string;
	readonly c6: string;
	readonly fontFamily: string;
}

export type PreparedFigure =
	| {
			readonly ok: true;
			/** Clean SVG text with its own namespace, a viewBox and a size. */
			readonly svg: string;
			readonly width: number;
			readonly height: number;
			/** The figure's own `<title>` (a direct child of the root), whitespace collapsed; "" when it has none. */
			readonly title: string;
			/** Something unsafe or unsupported was removed. */
			readonly stripped: boolean;
	  }
	| { readonly ok: false; readonly reason: string };

// ---- limits -----------------------------------------------------------------------------------------

const MAX_SOURCE_CHARS = 400_000;
const MAX_ELEMENTS = 6_000;
const MAX_DEPTH = 40;
/** The longer edge of the size reported for the image. */
const MAX_EDGE = 4_096;
/** What `<use>` may expand to, counted in elements drawn: a chain of `<use>`s of `<use>`s doubles at every level. */
const MAX_EXPANDED_ELEMENTS = 60_000;
/** How far a `<use>` chain (tree nesting plus references) may reach before it is refused. */
const MAX_REFERENCE_DEPTH = 300;
const MAX_TITLE_CHARS = 120;

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const XLINK_NAMESPACE = "http://www.w3.org/1999/xlink";

/** A source the reader refuses, with the one line the reader is told. */
class Refusal extends Error {}

function refuse(reason: string): never {
	throw new Refusal(reason);
}

// ---- allow-lists --------------------------------------------------------------------------------------

/** A static lookup table; ask it with `Object.hasOwn`, so that a name like `constructor` is not found. */
function tableOf(names: readonly string[]): Record<string, true> {
	return Object.fromEntries(names.map(name => [name, true] as const));
}

/** Elements that are drawn; the fe* filter primitives are those that need no resource (`feImage` loads one, so it is not here). */
const ALLOWED_ELEMENTS = tableOf([
	"svg", "g", "defs", "symbol", "use", "title", "desc", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon",
	"text", "tspan", "textPath", "linearGradient", "radialGradient", "stop", "pattern", "clipPath", "mask", "marker", "filter", "style",
	"feBlend", "feColorMatrix", "feComponentTransfer", "feComposite", "feConvolveMatrix", "feDiffuseLighting", "feDisplacementMap",
	"feDistantLight", "feDropShadow", "feFlood", "feFuncA", "feFuncB", "feFuncG", "feFuncR", "feGaussianBlur", "feMerge", "feMergeNode",
	"feMorphology", "feOffset", "fePointLight", "feSpecularLighting", "feSpotLight", "feTile", "feTurbulence",
]);

/** Elements whose own text is kept; in the others text is only whitespace between tags. */
const TEXT_ELEMENTS = tableOf(["text", "tspan", "textPath", "title", "desc", "style"]);

/** The only namespace-prefixed attributes that survive; `xlink` and `xml` are declared by the output's root, nothing else is. */
const PREFIXED_ATTRIBUTES = tableOf(["xlink:href", "xlink:title", "xml:space", "xml:lang"]);

/** The tokens `var(--name)` resolves, as the terminal UI's palette names them. */
const COLOUR_TOKENS = tableOf(["fg", "muted", "border", "accent", "success", "warning", "error", "surface", "c1", "c2", "c3", "c4", "c5", "c6"]);

// ---- the XML reader -----------------------------------------------------------------------------------

interface Element {
	readonly name: string;
	readonly attributes: [name: string, value: string][];
	/** Elements and text, in document order. */
	readonly children: (Element | string)[];
}

/** An XML name, with at most one namespace prefix; ASCII only, so no name can carry markup or a look-alike. */
const NAME = /[A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?/y;
/**
 * The five predefined entities, a short list of the HTML names models write in SVG text (`&nbsp;`, `&mdash;`, …: a browser's XML
 * parser would refuse the figure over them), and numeric character references: nothing a source can define itself.
 */
const REFERENCE = /&(?:(lt|gt|amp|quot|apos|nbsp|mdash|ndash|hellip|times|deg|middot|bull|rarr|larr|copy|plusmn|minus|le|ge|ne|asymp|infin|alpha|beta|gamma|delta|mu|pi|sigma|omega|micro|euro|pound|yen|cent|trade|reg|laquo|raquo|lsquo|rsquo|ldquo|rdquo);|#([0-9]{1,7});|#x([0-9a-fA-F]{1,6});)/y;
const PREDEFINED: Readonly<Record<string, string>> = {
	lt: "<", gt: ">", amp: "&", quot: '"', apos: "'",
	nbsp: "\u00a0", mdash: "\u2014", ndash: "\u2013", hellip: "\u2026", times: "\u00d7", deg: "\u00b0", middot: "\u00b7", bull: "\u2022", rarr: "\u2192", larr: "\u2190",
	copy: "\u00a9", plusmn: "\u00b1", minus: "\u2212", le: "\u2264", ge: "\u2265", ne: "\u2260", asymp: "\u2248", infin: "\u221e", alpha: "\u03b1", beta: "\u03b2",
	gamma: "\u03b3", delta: "\u03b4", mu: "\u03bc", pi: "\u03c0", sigma: "\u03c3", omega: "\u03c9", micro: "\u00b5", euro: "\u20ac", pound: "\u00a3", yen: "\u00a5",
	cent: "\u00a2", trade: "\u2122", reg: "\u00ae", laquo: "\u00ab", raquo: "\u00bb", lsquo: "\u2018", rsquo: "\u2019", ldquo: "\u201c", rdquo: "\u201d",
};
/** Characters XML 1.0 does not allow anywhere, and a surrogate half without its partner. */
const ILLEGAL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function isWhitespace(code: number): boolean {
	return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

function isXmlCharacter(code: number): boolean {
	return code === 0x09 || code === 0x0a || code === 0x0d || (code >= 0x20 && code <= 0xd7ff) || (code >= 0xe000 && code <= 0xfffd) || (code >= 0x10000 && code <= 0x10ffff);
}

/** The text with its references replaced by what they name. */
function decode(raw: string): string {
	let at = raw.indexOf("&");
	if (at < 0) return raw;
	let out = "";
	let last = 0;
	while (at >= 0) {
		REFERENCE.lastIndex = at;
		const match = REFERENCE.exec(raw);
		if (match === null) refuse("The figure uses an entity that is not predefined");
		let value: string;
		if (match[1] !== undefined) value = PREDEFINED[match[1]] ?? "";
		else {
			const code = match[2] !== undefined ? Number.parseInt(match[2], 10) : Number.parseInt(match[3] ?? "", 16);
			if (!isXmlCharacter(code)) refuse("The figure has an invalid character reference");
			value = String.fromCodePoint(code);
		}
		out += raw.slice(last, at) + value;
		last = REFERENCE.lastIndex;
		at = raw.indexOf("&", last);
	}
	return out + raw.slice(last);
}

interface StartTag {
	readonly name: string;
	readonly attributes: [string, string][];
	readonly selfClosing: boolean;
	/** Index just past the tag. */
	readonly end: number;
}

function shortName(name: string): string {
	return name.length > 40 ? `${name.slice(0, 39)}…` : name;
}

function readStartTag(source: string, lt: number): StartTag {
	NAME.lastIndex = lt + 1;
	const named = NAME.exec(source);
	if (named === null) refuse("The figure has a malformed tag");
	const name = named[0];
	const attributes: [string, string][] = [];
	const seen = new Set<string>();
	let at = NAME.lastIndex;
	for (;;) {
		const gap = at;
		while (isWhitespace(source.charCodeAt(at))) at++;
		const char = source[at];
		if (char === undefined) refuse(`Unclosed tag <${shortName(name)}`);
		if (char === ">") return { name, attributes, selfClosing: false, end: at + 1 };
		if (char === "/") {
			if (source[at + 1] !== ">") refuse(`Malformed tag <${shortName(name)}>`);
			return { name, attributes, selfClosing: true, end: at + 2 };
		}
		if (at === gap) refuse(`Malformed tag <${shortName(name)}>`);
		NAME.lastIndex = at;
		const attribute = NAME.exec(source);
		if (attribute === null) refuse(`Malformed attribute in <${shortName(name)}>`);
		const attributeName = attribute[0];
		if (seen.has(attributeName)) refuse(`Duplicate attribute ${shortName(attributeName)}`);
		seen.add(attributeName);
		at = NAME.lastIndex;
		while (isWhitespace(source.charCodeAt(at))) at++;
		if (source[at] !== "=") refuse(`Attribute ${shortName(attributeName)} has no value`);
		at++;
		while (isWhitespace(source.charCodeAt(at))) at++;
		const quote = source[at];
		if (quote !== '"' && quote !== "'") refuse(`Attribute ${shortName(attributeName)} is not quoted`);
		const close = source.indexOf(quote, at + 1);
		if (close < 0) refuse(`Unclosed value of attribute ${shortName(attributeName)}`);
		attributes.push([attributeName, decode(source.slice(at + 1, close))]);
		at = close + 1;
	}
}

// ---- theme tokens and value filtering -----------------------------------------------------------------

const VAR_OPENER = /var\(/gi;
/** Longest chain of fallbacks resolved: `var(--a, var(--b, var(--c)))`. */
const MAX_VAR_DEPTH = 4;

/** `var(--name)` / `var(--name, fallback)` with the palette's colour; an unknown name takes its fallback, else `fg`. */
function resolveVariables(text: string, palette: FigurePalette, depth = 0): string {
	if (depth > MAX_VAR_DEPTH) return text;
	VAR_OPENER.lastIndex = 0;
	let out = "";
	let last = 0;
	for (;;) {
		const opener = VAR_OPENER.exec(text);
		if (opener === null) break;
		let at = opener.index + opener[0].length;
		while (isWhitespace(text.charCodeAt(at))) at++;
		if (text.startsWith("--", at)) {
			at += 2;
			const nameStart = at;
			while (/[\w-]/.test(text[at] ?? "")) at++;
			const name = text.slice(nameStart, at);
			while (isWhitespace(text.charCodeAt(at))) at++;
			let fallback: string | null = null;
			let end = -1;
			if (text[at] === ")") end = at + 1;
			else if (text[at] === ",") {
				// The fallback runs to the parenthesis that closes the `var(`; nested pairs (`rgb(…)`) belong to it.
				let level = 1;
				let scan = at + 1;
				for (; scan < text.length; scan++) {
					const char = text[scan];
					if (char === "(") level++;
					else if (char === ")" && --level === 0) break;
				}
				if (level === 0) {
					fallback = text.slice(at + 1, scan).trim();
					end = scan + 1;
				}
			}
			if (name.length > 0 && end > 0) {
				const token = Object.hasOwn(COLOUR_TOKENS, name) ? palette[name as keyof FigurePalette] : undefined;
				const resolved = token ?? (fallback !== null && fallback.length > 0 ? resolveVariables(fallback, palette, depth + 1) : palette.fg);
				out += text.slice(last, opener.index) + resolved;
				last = end;
				VAR_OPENER.lastIndex = end;
			}
		}
	}
	return out + text.slice(last);
}

const URL_OPENER = /url\s*\(/gi;
const LOCAL_URL = /\s*(['"]?)#([\w.:-]+)\1\s*\)/y;
/** What no value of the output may hold: a CSS escape (which can spell any other word), a script scheme, an old IE hook, an external address. */
const FORBIDDEN_VALUE = /\\|(?:javascript|vbscript):|expression\s*\(|-moz-binding|\bhttps?:/i;
/** CSS functions that take an address as a string (`image-set("https://…")`) or otherwise fetch. */
const FETCHING_FUNCTION = /\b(?:image-set|cross-fade|image|element|paint|src)\s*\(/i;

/** The value with every `url(…)` written as `url(#id)`, or null when one points anywhere but into the same document. */
function localUrls(value: string): string | null {
	URL_OPENER.lastIndex = 0;
	let out = "";
	let last = 0;
	for (;;) {
		const opener = URL_OPENER.exec(value);
		if (opener === null) break;
		const afterOpener = opener.index + opener[0].length;
		LOCAL_URL.lastIndex = afterOpener;
		const local = LOCAL_URL.exec(value);
		if (local === null) return null;
		out += `${value.slice(last, opener.index)}url(#${local[2]})`;
		last = LOCAL_URL.lastIndex;
		URL_OPENER.lastIndex = last;
	}
	return out + value.slice(last);
}

/** An attribute's value as it may be kept, or null. */
function cleanValue(value: string): string | null {
	if (FORBIDDEN_VALUE.test(value)) return null;
	return localUrls(value);
}

/** Whether one CSS statement (a declaration, or the prelude of a rule) may stay. */
function cssStatementAllowed(statement: string): boolean {
	if (FORBIDDEN_VALUE.test(statement) || /@import|behavior/i.test(statement) || FETCHING_FUNCTION.test(statement)) return false;
	return localUrls(statement) !== null;
}

function stripComments(css: string): string {
	let out = "";
	let at = 0;
	for (;;) {
		const open = css.indexOf("/*", at);
		if (open < 0) return out + css.slice(at);
		out += css.slice(at, open);
		const close = css.indexOf("*/", open + 2);
		if (close < 0) return out;
		at = close + 2;
	}
}

/**
 * CSS (a `<style>` element's text or a `style` attribute) with every statement that is not allowed removed: a declaration that
 * fetches or scripts, a rule whose selector does, an `@import`. The rest is written back as it was.
 */
function filterCss(source: string): { readonly css: string; readonly removed: boolean } {
	const css = stripComments(source);
	let out = "";
	let removed = false;
	let chunkStart = 0;
	let quote: string | null = null;
	let parentheses = 0;
	let open = 0;
	/** Braces still to close in a rule whose selector was refused; its whole block goes. */
	let skipping = 0;
	for (let at = 0; at < css.length; at++) {
		const char = css[at];
		if (quote !== null) {
			if (char === "\\") at++;
			else if (char === quote) quote = null;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}
		if (skipping > 0) {
			if (char === "{") skipping++;
			else if (char === "}" && --skipping === 0) chunkStart = at + 1;
			continue;
		}
		if (char === "(") parentheses++;
		else if (char === ")" && parentheses > 0) parentheses--;
		if (parentheses > 0 || (char !== ";" && char !== "{" && char !== "}")) continue;
		const statement = css.slice(chunkStart, at).trim();
		chunkStart = at + 1;
		if (char === "{") {
			if (cssStatementAllowed(statement)) {
				out += `${statement}{`;
				open++;
			} else {
				removed = true;
				skipping = 1;
			}
			continue;
		}
		if (statement.length > 0) {
			if (cssStatementAllowed(statement)) out += `${statement};`;
			else removed = true;
		}
		if (char === "}" && open > 0) {
			out += "}";
			open--;
		}
	}
	// A last declaration may end without its semicolon (and a quote left open ends it as unusable); open blocks are closed.
	const rest = skipping === 0 ? css.slice(chunkStart).trim() : "";
	if (rest.length > 0) {
		if (quote === null && cssStatementAllowed(rest)) out += `${rest};`;
		else removed = true;
	}
	out += "}".repeat(open);
	return { css: out, removed };
}

const SAME_DOCUMENT_REFERENCE = /^#[\w.:-]+$/;

/** The attributes of an allowed element that may stay. Everything dropped for safety or support sets `stripped`. */
function cleanAttributes(raw: readonly (readonly [string, string])[], palette: FigurePalette): { readonly attributes: [string, string][]; readonly stripped: boolean } {
	const attributes: [string, string][] = [];
	let stripped = false;
	for (const [name, value] of raw) {
		if (/^on/i.test(name)) {
			stripped = true;
		} else if (name === "xmlns" || name.startsWith("xmlns:")) {
			// The root writes the two namespaces itself; any other declaration could rebind what the elements mean.
			if (!((name === "xmlns" && value === SVG_NAMESPACE) || (name === "xmlns:xlink" && value === XLINK_NAMESPACE))) stripped = true;
		} else if (name.includes(":") && !Object.hasOwn(PREFIXED_ATTRIBUTES, name)) {
			stripped = true;
		} else if (name === "href" || name === "xlink:href") {
			const target = value.trim();
			if (SAME_DOCUMENT_REFERENCE.test(target)) attributes.push([name, target]);
			else stripped = true;
		} else if (name === "style") {
			const filtered = filterCss(resolveVariables(value, palette));
			if (filtered.removed) stripped = true;
			if (filtered.css.length > 0) attributes.push([name, filtered.css]);
		} else {
			const cleaned = cleanValue(resolveVariables(value, palette));
			if (cleaned === null) stripped = true;
			else attributes.push([name, cleaned]);
		}
	}
	return { attributes, stripped };
}

// ---- building the tree --------------------------------------------------------------------------------

interface Built {
	readonly root: Element;
	readonly stripped: boolean;
}

interface OpenElement {
	readonly name: string;
	/** The element's node; null when it (or an ancestor) was removed, and all of its content with it. */
	readonly node: Element | null;
}

function parse(source: string, palette: FigurePalette): Built {
	let root: Element | null = null;
	let closed = false;
	let stripped = false;
	let elements = 0;
	let anything = false;
	const stack: OpenElement[] = [];

	const addText = (text: string): void => {
		const node = stack[stack.length - 1]?.node;
		if (node === undefined) {
			if (/[^ \t\r\n]/.test(text)) refuse(root === null ? "The figure has text before the svg element" : "The figure has text after the svg element");
			return;
		}
		if (node === null || !Object.hasOwn(TEXT_ELEMENTS, node.name) || text.length === 0) return;
		const last = node.children[node.children.length - 1];
		if (typeof last === "string") node.children[node.children.length - 1] = last + text;
		else node.children.push(text);
	};

	let at = source.charCodeAt(0) === 0xfeff ? 1 : 0;
	while (at < source.length) {
		if (source[at] !== "<") {
			const next = source.indexOf("<", at);
			const end = next < 0 ? source.length : next;
			addText(decode(source.slice(at, end)));
			at = end;
			continue;
		}
		if (source.startsWith("<!--", at)) {
			const end = source.indexOf("-->", at + 4);
			if (end < 0) refuse("The figure has an unclosed comment");
			anything = true;
			at = end + 3;
		} else if (source.startsWith("<![CDATA[", at)) {
			const end = source.indexOf("]]>", at + 9);
			if (end < 0) refuse("The figure has an unclosed CDATA section");
			addText(source.slice(at + 9, end));
			at = end + 3;
		} else if (source.startsWith("<?", at)) {
			const end = source.indexOf("?>", at + 2);
			if (end < 0) refuse("The figure has an unclosed processing instruction");
			// Only the XML declaration, only first; any other instruction (a stylesheet link, say) is a way to load something.
			if (anything || stack.length > 0 || !/^xml[ \t\r\n]/.test(source.slice(at + 2, end + 1))) refuse("The figure has a processing instruction");
			anything = true;
			at = end + 2;
		} else if (source.startsWith("<!", at)) {
			refuse("The figure has a DOCTYPE or entity declaration, which is not allowed");
		} else if (source.startsWith("</", at)) {
			NAME.lastIndex = at + 2;
			const named = NAME.exec(source);
			if (named === null) refuse("The figure has a malformed closing tag");
			let end = NAME.lastIndex;
			while (isWhitespace(source.charCodeAt(end))) end++;
			if (source[end] !== ">") refuse("The figure has a malformed closing tag");
			const top = stack.pop();
			if (top === undefined) refuse(`Unexpected closing tag </${shortName(named[0])}>`);
			if (top.name !== named[0]) refuse(`Mismatched closing tag </${shortName(named[0])}> (expected </${shortName(top.name)}>)`);
			if (top.node?.name === "style") finishStyle(top.node, palette, () => { stripped = true; });
			if (stack.length === 0) closed = true;
			at = end + 1;
		} else {
			const tag = readStartTag(source, at);
			anything = true;
			if (closed) refuse("The figure must hold exactly one svg element");
			if (++elements > MAX_ELEMENTS) refuse(`The figure has more than ${MAX_ELEMENTS} elements`);
			if (stack.length + 1 > MAX_DEPTH) refuse(`The figure is nested deeper than ${MAX_DEPTH} levels`);
			if (stack.length === 0 && tag.name !== "svg") refuse("The root element of the figure is not <svg>");
			const parent = stack[stack.length - 1]?.node ?? null;
			let node: Element | null = null;
			if (Object.hasOwn(ALLOWED_ELEMENTS, tag.name) && (stack.length === 0 || parent !== null)) {
				const cleaned = cleanAttributes(tag.attributes, palette);
				if (cleaned.stripped) stripped = true;
				node = { name: tag.name, attributes: cleaned.attributes, children: [] };
				if (parent === null) root = node;
				else parent.children.push(node);
			} else {
				stripped = true;
			}
			if (tag.selfClosing) {
				if (stack.length === 0) closed = true;
			} else {
				stack.push({ name: tag.name, node });
			}
			at = tag.end;
		}
	}
	const unclosed = stack[stack.length - 1];
	if (unclosed !== undefined) refuse(`Unclosed tag <${shortName(unclosed.name)}>`);
	if (root === null) refuse(anything ? "The figure has no svg element" : "The figure is empty");
	return { root, stripped };
}

/** A `<style>` element's text, theme tokens resolved and filtered; replaces however many text pieces it was written in. */
function finishStyle(node: Element, palette: FigurePalette, onRemoved: () => void): void {
	const text = node.children.filter((child): child is string => typeof child === "string").join("");
	node.children.length = 0;
	const filtered = filterCss(resolveVariables(text, palette));
	if (filtered.removed) onRemoved();
	if (filtered.css.length > 0) node.children.push(filtered.css);
}

// ---- `<use>` expansion --------------------------------------------------------------------------------

function referencedId(element: Element): string | null {
	for (const [name, value] of element.attributes) if (name === "href" || name === "xlink:href") return value.slice(1);
	return null;
}

/**
 * A `<use>` draws another element again, so a few hundred of them, each drawing two of the next, ask a renderer for
 * billions of shapes. Refuses a figure that expands past a bound, or whose `<use>` leads back to itself.
 */
function checkUseExpansion(root: Element): void {
	const byId = new Map<string, Element>();
	let uses = 0;
	const index: Element[] = [root];
	for (let next = index.pop(); next !== undefined; next = index.pop()) {
		if (next.name === "use") uses++;
		for (const [name, value] of next.attributes) if (name === "id" && !byId.has(value)) byId.set(value, next);
		for (const child of next.children) if (typeof child !== "string") index.push(child);
	}
	if (uses === 0) return;
	const weights = new Map<Element, number>();
	const active = new Set<Element>();
	const weigh = (element: Element, depth: number): number => {
		const known = weights.get(element);
		if (known !== undefined) return known;
		if (depth > MAX_REFERENCE_DEPTH) refuse("The figure's use elements are chained too deeply");
		if (active.has(element)) refuse("A use element in the figure refers back to itself");
		active.add(element);
		let total = 1;
		for (const child of element.children) if (typeof child !== "string") total += weigh(child, depth + 1);
		if (element.name === "use") {
			const id = referencedId(element);
			const target = id === null ? undefined : byId.get(id);
			if (target !== undefined) total += weigh(target, depth + 1);
		}
		active.delete(element);
		if (total > MAX_EXPANDED_ELEMENTS) refuse("The figure's use elements expand to too many shapes");
		weights.set(element, total);
		return total;
	};
	weigh(root, 0);
}

// ---- writing it back ----------------------------------------------------------------------------------

function escapeText(text: string): string {
	// `javascript:` is not harmful as text, but the output is promised to hold none: its colon is written as a reference.
	return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replace(/javascript:/gi, match => `${match.slice(0, -1)}&#58;`);
}

function escapeAttribute(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("\n", "&#10;").replaceAll("\r", "&#13;").replaceAll("\t", "&#9;");
}

function write(element: Element, out: string[]): void {
	out.push("<", element.name);
	for (const [name, value] of element.attributes) out.push(" ", name, '="', escapeAttribute(value), '"');
	if (element.children.length === 0) {
		out.push("/>");
		return;
	}
	out.push(">");
	for (const child of element.children) {
		if (typeof child === "string") out.push(escapeText(child));
		else write(child, out);
	}
	out.push("</", element.name, ">");
}

// ---- size ---------------------------------------------------------------------------------------------

const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

function parseNumber(text: string): number {
	return NUMBER.test(text) ? Number(text) : Number.NaN;
}

/** A root `width` / `height` that is a plain number of pixels (`640` or `640px`); NaN for percentages, `auto`, other units. */
function pixels(text: string | undefined): number {
	if (text === undefined) return Number.NaN;
	const trimmed = text.trim();
	return parseNumber(trimmed.endsWith("px") ? trimmed.slice(0, -2).trim() : trimmed);
}

function attributeOf(element: Element, name: string): string | undefined {
	return element.attributes.find(([candidate]) => candidate === name)?.[1];
}

/** The root's viewBox `[minX, minY, width, height]`, derived from its size when it has none. */
function viewBoxOf(root: Element): readonly [number, number, number, number] {
	const given = attributeOf(root, "viewBox");
	let box: [number, number, number, number];
	if (given !== undefined) {
		const parts = given.trim().split(/[\s,]+/);
		if (parts.length !== 4) refuse("The figure's viewBox is not four numbers");
		box = [parseNumber(parts[0] ?? ""), parseNumber(parts[1] ?? ""), parseNumber(parts[2] ?? ""), parseNumber(parts[3] ?? "")];
	} else {
		const width = pixels(attributeOf(root, "width"));
		const height = pixels(attributeOf(root, "height"));
		if (Number.isNaN(width) || Number.isNaN(height)) refuse("The figure has no viewBox or size");
		box = [0, 0, width, height];
	}
	if (!box.every(Number.isFinite)) refuse("The figure's viewBox is not made of finite numbers");
	if (!(box[2] > 0 && box[3] > 0)) refuse("The figure's viewBox is empty");
	return box;
}

// ---- the entry point ----------------------------------------------------------------------------------

function titleOf(root: Element): string {
	for (const child of root.children) {
		if (typeof child === "string" || child.name !== "title") continue;
		const collapsed = child.children.filter((part): part is string => typeof part === "string").join("").replace(/\s+/g, " ").trim();
		return collapsed.length > MAX_TITLE_CHARS ? `${collapsed.slice(0, MAX_TITLE_CHARS - 1)}…` : collapsed;
	}
	return "";
}

function usesXlink(element: Element): boolean {
	const pending: Element[] = [element];
	for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
		if (next.attributes.some(([name]) => name.startsWith("xlink:"))) return true;
		for (const child of next.children) if (typeof child !== "string") pending.push(child);
	}
	return false;
}

/**
 * The figure as clean SVG text with its size, or the one line saying why it cannot be drawn.
 * Never throws; a source it cannot make sense of is refused, not repaired.
 */
export function prepareSvgFigure(source: string, palette: FigurePalette): PreparedFigure {
	try {
		if (source.length > MAX_SOURCE_CHARS) refuse(`The figure is larger than ${MAX_SOURCE_CHARS.toLocaleString("en-US")} characters`);
		if (ILLEGAL_CHARACTERS.test(source)) refuse("The figure has a character XML does not allow");
		const { root, stripped } = parse(source, palette);
		const [minX, minY, boxWidth, boxHeight] = viewBoxOf(root);
		checkUseExpansion(root);

		const scale = Math.min(1, MAX_EDGE / Math.max(boxWidth, boxHeight));
		const width = Math.max(1, Math.round(boxWidth * scale));
		const height = Math.max(1, Math.round(boxHeight * scale));

		const xlink = usesXlink(root);
		const kept = root.attributes.filter(([name]) => name !== "width" && name !== "height" && name !== "viewBox");
		const rootAttributes: [string, string][] = [["xmlns", SVG_NAMESPACE]];
		if (xlink) rootAttributes.push(["xmlns:xlink", XLINK_NAMESPACE]);
		rootAttributes.push(["width", String(width)], ["height", String(height)], ["viewBox", `${minX} ${minY} ${boxWidth} ${boxHeight}`], ...kept);
		if (attributeOf(root, "color") === undefined) rootAttributes.push(["color", palette.fg]);
		if (attributeOf(root, "font-family") === undefined) rootAttributes.push(["font-family", palette.fontFamily]);

		const out: string[] = [];
		write({ name: root.name, attributes: rootAttributes, children: root.children }, out);
		return { ok: true, svg: out.join(""), width, height, title: titleOf(root), stripped };
	} catch (error) {
		return { ok: false, reason: error instanceof Refusal ? error.message : "The figure could not be read" };
	}
}

/** The `src` that shows `svg` in an `<img>`; the text is percent-encoded, and a lone surrogate (which would throw) becomes U+FFFD. */
export function svgDataUrl(svg: string): string {
	const wellFormed = svg.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD");
	return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(wellFormed)}`;
}
