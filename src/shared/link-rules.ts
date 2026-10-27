/**
 * User-defined link rules for Chat replies (`docs/designs/2026-10-27-chat-link-rules.md`): a regular expression and a URL template
 * from the user's own `ompDesk.chatLinkRules` setting turn matching text of an assistant reply into a link that opens the built
 * `http(s)` URL in the external browser.
 *
 * This module is the one copy of every rule: the host compiles the setting with it, the page compiles what the host sent with it
 * again (a page never trusts a rule it was given), and the host re-runs the matched text with it when a link is clicked. The click
 * carries a rule id and the matched characters ({@link linkRuleTarget}), never a URL: the host builds the URL itself.
 *
 * A rule is `{ pattern, url, ignoreCase?, name? }`. The URL template is `http(s)://host/...` with `$0` (the whole match), `$1` to
 * `$9` (capture groups, each URL-encoded as one component) and `$$` (a dollar sign); a placeholder may stand anywhere after the host,
 * never in the scheme or the host, so the text of a reply can pick a path or a query but never the site.
 *
 * JavaScript has no regular-expression time limit, so a pattern is screened ({@link screenPattern}: no back-references, no repeated group
 * that holds a repeat or an alternative, a budget for the variable repeats: {@link MAX_REPEAT_COST})
 * and every scan is bounded ({@link MAX_SCANNED_TEXT}, {@link MAX_MATCHES_PER_TEXT}). That limits the cost of an honest mistake to a
 * quadratic one; it is not a proof for a hostile pattern, and the setting is read from the user's own settings only for that reason.
 */
import { WEB_LINK_HINT, webLinkUrl } from "./terminal-links.ts";

/** The key under `ompDesk.`. */
export const LINK_RULES_SETTING = "chatLinkRules";
/** Rules the host accepts; the rest of the list is reported and ignored. */
export const MAX_LINK_RULES = 20;
export const MAX_PATTERN_LENGTH = 256;
export const MAX_TEMPLATE_LENGTH = 1024;
export const MAX_NAME_LENGTH = 80;
/** A text is scanned up to this many characters; what lies beyond is never linked by a rule. */
export const MAX_SCANNED_TEXT = 2000;
/** One text carries at most this many rule links. */
export const MAX_MATCHES_PER_TEXT = 32;
/** A match longer than this is not a link (it also bounds what a click may carry). */
export const MAX_MATCH_LENGTH = 200;
/**
 * What the variable repeats of one pattern may cost in all: an unbounded repeat (`*`, `+`, `{n,}`, `{n,m}` with `m` over {@link MAX_BOUNDED_REPEAT}) costs {@link UNBOUNDED_REPEAT_COST}, a
 * `{n,m}` up to that bound costs {@link RANGED_REPEAT_COST}, a `?` costs {@link OPTIONAL_REPEAT_COST} (a chain of them doubles the search each). The budget allows two unbounded repeats, one of each, or three ranged ones, with a few `?` beside them: backtracking
 * multiplies the repeats of one pattern, and these are the combinations measured to stay near a second on a crafted text of one unbroken 2000-character word.
 */
export const MAX_REPEAT_COST = 9;
const UNBOUNDED_REPEAT_COST = 4;
const RANGED_REPEAT_COST = 3;
const OPTIONAL_REPEAT_COST = 1;
/** Quantifiers of any kind one pattern may hold. */
export const MAX_QUANTIFIERS = 8;
/** The largest `m` of a `{n,m}` that counts as bounded. */
const MAX_BOUNDED_REPEAT = 40;
/** A scan reads a text in pieces of at most this many characters ({@link scanChunks}), and cuts at whitespace after the first {@link SCAN_CHUNK_MIN}. */
const SCAN_CHUNK = 500;
const SCAN_CHUNK_MIN = 300;
const MAX_RULE_ID = 999;
const MAX_BUILT_URL_LENGTH = 2048;

/** A rule as the page receives it: already screened by the host, still compiled again by the page. `id` is the rule's position in the setting. */
export interface LinkRuleEntry {
	readonly id: number;
	readonly pattern: string;
	readonly url: string;
	readonly ignoreCase: boolean;
	readonly name: string | null;
}

export interface LinkRule extends LinkRuleEntry {
	/** Global; never executed directly (scans use `matchAll`, which works on a copy), so its `lastIndex` stays 0. */
	readonly regex: RegExp;
	/** The number of capture groups. */
	readonly groups: number;
	/** The host (with port) the template names; a built URL must still have it. */
	readonly host: string;
	readonly parts: readonly TemplatePart[];
}

export type TemplatePart = string | number;

export interface LinkRuleProblem {
	/** The rule's position in the setting. */
	readonly index: number;
	readonly message: string;
}

export interface CompiledLinkRules {
	readonly rules: LinkRule[];
	readonly problems: LinkRuleProblem[];
}

export interface LinkRuleMatch {
	readonly rule: LinkRule;
	/** UTF-16 offsets into the scanned text; the characters are exactly `text.slice(start, end)`. */
	readonly start: number;
	readonly end: number;
	/** The URL a click opens. */
	readonly url: string;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Why `pattern` is refused before it is ever run, or `null`. A scan of the source that skips escapes and character classes and tracks groups.
 * What it refuses is what makes a backtracking matcher exponential or of a high degree on a long text: a back-reference; a group that holds
 * a repeat or an alternative being repeated (`(a+)+`, `(a|ab)*`, `(a?){30}`, only `?` may follow such a group); repeats costing more than {@link MAX_REPEAT_COST}
 * in all or more than {@link MAX_QUANTIFIERS} quantifiers. A pattern that passes can still be
 * quadratic (two unbounded repeats over the same characters), so this limits the cost of a mistake; it does not prove a pattern fast.
 */
export function screenPattern(pattern: string): string | null {
	/** Whether the group being read so far holds a quantifier or an alternative; `outer` keeps the enclosing groups' flag while an inner one is read. */
	let varied: boolean = false;
	const outer: boolean[] = [];
	let quantifiers = 0;
	let cost = 0;
	/** What the last atom was: `null` before one, else whether it was a group and whether that group held a quantifier or an alternative. */
	let previous: { group: boolean; varied: boolean } | null = null;
	for (let index = 0; index < pattern.length; index++) {
		const char = pattern[index] as string;
		if (char === "\\") {
			const next = pattern[index + 1] ?? "";
			if (/[1-9]/.test(next) || next === "k") return "back-references (\\1, \\k<name>) are not allowed";
			index++;
			previous = { group: false, varied: false };
			continue;
		}
		if (char === "[") {
			index++;
			while (index < pattern.length && pattern[index] !== "]") index += pattern[index] === "\\" ? 2 : 1;
			previous = { group: false, varied: false };
			continue;
		}
		if (char === "(") {
			outer.push(varied);
			varied = false;
			previous = null;
			// A group prefix (`(?:`, `(?=`, `(?!`, `(?<=`, `(?<!`, `(?<name>`) is not a quantifier.
			if (pattern[index + 1] === "?") {
				index++;
				const kind = pattern[index + 1];
				if (kind === ":" || kind === "=" || kind === "!") index++;
				else if (kind === "<") {
					index++;
					if (pattern[index + 1] === "=" || pattern[index + 1] === "!") index++;
					else while (index + 1 < pattern.length && pattern[index] !== ">") index++;
				}
			}
			continue;
		}
		if (char === ")") {
			const closed: boolean = varied;
			varied = (outer.pop() ?? false) || closed;
			previous = { group: true, varied: closed };
			continue;
		}
		if (char === "|") {
			varied = true;
			previous = null;
			continue;
		}
		let quantifier: { kind: "optional" | "exact" | "ranged" | "unbounded"; length: number } | null = null;
		if (char === "*" || char === "+") quantifier = { kind: "unbounded", length: 1 };
		else if (char === "?") quantifier = { kind: "optional", length: 1 };
		else if (char === "{") {
			const range = /^\{(\d+)(?:(,)(\d*))?\}/.exec(pattern.slice(index));
			if (range !== null) {
				const low = Number(range[1]);
				const high = range[2] === undefined ? low : range[3] === "" ? Number.POSITIVE_INFINITY : Number(range[3]);
				quantifier = { kind: high === low ? "exact" : high > MAX_BOUNDED_REPEAT ? "unbounded" : "ranged", length: range[0].length };
			}
		}
		if (quantifier === null) {
			previous = { group: false, varied: false };
			continue;
		}
		index += quantifier.length - 1;
		// A lazy marker belongs to the quantifier.
		if (pattern[index + 1] === "?") index++;
		if (previous?.group === true && previous.varied && quantifier.kind !== "optional") return "a group that holds a repeat or an alternative may only be made optional with ?, never repeated: write [ab]{2} or a+ instead of (a|b){2} or (a+)+";
		if (++quantifiers > MAX_QUANTIFIERS) return `at most ${MAX_QUANTIFIERS} quantifiers (*, +, ?, {n,m}) are allowed`;
		cost += quantifier.kind === "unbounded" ? UNBOUNDED_REPEAT_COST : quantifier.kind === "ranged" ? RANGED_REPEAT_COST : quantifier.kind === "optional" ? OPTIONAL_REPEAT_COST : 0;
		if (cost > MAX_REPEAT_COST) return `the repeats cost too much: * + {n,} and {n,m} over ${MAX_BOUNDED_REPEAT} count ${UNBOUNDED_REPEAT_COST}, {n,m} up to ${MAX_BOUNDED_REPEAT} counts ${RANGED_REPEAT_COST}, ? counts ${OPTIONAL_REPEAT_COST}, at most ${MAX_REPEAT_COST} in all (two of the first, or one of each, or three of the second, with a few ? beside them)`;
		varied = true;
		previous = previous === null ? null : { group: previous.group, varied: true };
	}
	return null;
}

/** The template's literal and placeholder parts, or why it is refused. */
function parseTemplate(url: string, groups: number): { parts: TemplatePart[]; host: string } | string {
	if (url.length === 0) return "url is empty";
	if (url.length > MAX_TEMPLATE_LENGTH) return `url is longer than ${MAX_TEMPLATE_LENGTH} characters`;
	if (!/^https?:\/\//i.test(url)) return "url must start with http:// or https://";
	// The host must follow `//` directly and hold no placeholder: the URL parser would read `https:///$1` or `https://\\$1` as a host taken from the placeholder.
	if (!/^https?:\/\/[^/\\?#$]+(?:[/?#]|$)/i.test(url)) return "url must name its host right after // (a $ placeholder may not stand in the host: the text of a reply must not choose the site)";
	const parts: TemplatePart[] = [];
	let literal = "";
	for (let index = 0; index < url.length; index++) {
		const char = url[index] as string;
		if (char !== "$") { literal += char; continue; }
		const next = url[index + 1] ?? "";
		if (next === "$") { literal += "$"; index++; continue; }
		if (!/[0-9]/.test(next)) return `"$${next}" is not a placeholder; use $0 to $9 or $$ for a dollar sign`;
		if (Number(next) > groups) return `$${next} refers to a capture group the pattern does not have`;
		if (literal !== "") parts.push(literal);
		literal = "";
		parts.push(Number(next));
		index++;
	}
	if (literal !== "") parts.push(literal);
	let sample: URL;
	try { sample = new URL(parts.map(part => typeof part === "string" ? part : "x").join("")); }
	catch { return "url is not a valid web address"; }
	if ((sample.protocol !== "http:" && sample.protocol !== "https:") || sample.hostname === "") return "url must be an http or https address with a host";
	return { parts, host: sample.host };
}

/** `text` with each unpaired surrogate replaced by U+FFFD: `encodeURIComponent` throws on one, and a reply may hold one. */
function wellFormed(text: string): string {
	return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD");
}

function fill(parts: readonly TemplatePart[], match: RegExpExecArray): string {
	return parts.map(part => typeof part === "string" ? part : encodeURIComponent(wellFormed(match[part] ?? ""))).join("");
}

/** One rule of the setting (`raw`) as the compiled rule with position `id`, or why it is refused. */
export function compileLinkRule(raw: unknown, id: number): LinkRule | string {
	if (!isObject(raw)) return "a rule must be an object with a pattern and a url";
	const unknownKey = Object.keys(raw).find(key => key !== "pattern" && key !== "url" && key !== "ignoreCase" && key !== "name" && key !== "id");
	if (unknownKey !== undefined) return `unknown property "${unknownKey}"`;
	const { pattern, url, ignoreCase, name } = raw;
	if (typeof pattern !== "string" || pattern === "") return "pattern must be a non-empty string";
	if (typeof url !== "string") return "url must be a string";
	if (ignoreCase !== undefined && typeof ignoreCase !== "boolean") return "ignoreCase must be true or false";
	if (name !== undefined && name !== null && (typeof name !== "string" || name.length > MAX_NAME_LENGTH)) return `name must be a string of at most ${MAX_NAME_LENGTH} characters`;
	if (!Number.isSafeInteger(id) || id < 0 || id > MAX_RULE_ID) return "a rule's position is out of range";
	if (pattern.length > MAX_PATTERN_LENGTH) return `pattern is longer than ${MAX_PATTERN_LENGTH} characters`;
	const screened = screenPattern(pattern);
	if (screened !== null) return screened;
	let regex: RegExp;
	try { regex = new RegExp(pattern, ignoreCase === true ? "gi" : "g"); }
	catch (error) { return `pattern is not a valid regular expression (${error instanceof Error ? error.message : String(error)})`; }
	if (new RegExp(pattern, "").test("")) return "pattern matches the empty text, so it would match everywhere";
	const groups = (new RegExp(`${pattern}|`).exec("") as RegExpExecArray).length - 1;
	const template = parseTemplate(url, groups);
	if (typeof template === "string") return template;
	return { id, pattern, url, ignoreCase: ignoreCase === true, name: typeof name === "string" && name !== "" ? name : null, regex, groups, host: template.host, parts: template.parts };
}

/** The rules of the setting's value: valid ones with their positions as ids, and one problem per refused rule (and for a value that is no list or has too many). */
export function compileLinkRules(raw: unknown): CompiledLinkRules {
	const rules: LinkRule[] = [];
	const problems: LinkRuleProblem[] = [];
	if (raw === undefined || raw === null) return { rules, problems };
	if (!Array.isArray(raw)) return { rules, problems: [{ index: 0, message: "the setting must be a list of rules" }] };
	raw.forEach((entry, index) => {
		if (index >= MAX_LINK_RULES) {
			if (index === MAX_LINK_RULES) problems.push({ index, message: `only the first ${MAX_LINK_RULES} rules are used` });
			return;
		}
		const compiled = compileLinkRule(entry, index);
		if (typeof compiled === "string") problems.push({ index, message: compiled });
		else rules.push(compiled);
	});
	return { rules, problems };
}

/** The entries the page is sent. */
export function linkRuleEntries(rules: readonly LinkRule[]): LinkRuleEntry[] {
	return rules.map(({ id, pattern, url, ignoreCase, name }) => ({ id, pattern, url, ignoreCase, name }));
}

/** The URL `rule` builds for `text` when the rule matches exactly those characters on their own, or `null`. */
export function buildLinkRuleUrl(rule: LinkRule, text: string): string | null {
	if (text === "" || text.length > MAX_MATCH_LENGTH) return null;
	for (const match of text.matchAll(rule.regex)) {
		if (match.index !== 0 || match[0].length !== text.length) return null;
		const url = fill(rule.parts, match);
		if (url.length > MAX_BUILT_URL_LENGTH) return null;
		const safe = webLinkUrl(url);
		return safe !== null && new URL(safe).host === rule.host ? safe : null;
	}
	return null;
}

/**
 * The rule links in `text`, in order and without overlap; where rules overlap the earlier rule of the setting wins. A match counts
 * only when the rule matches those characters on their own ({@link buildLinkRuleUrl}): that is what the host re-runs on a click, so a
 * rule that needs the characters around its match (a look-ahead) links nothing rather than something the host would refuse.
 */
export function findLinkRuleMatches(rules: readonly LinkRule[], text: string): LinkRuleMatch[] {
	if (rules.length === 0 || text === "") return [];
	const found: LinkRuleMatch[] = [];
	for (const chunk of scanChunks(text)) {
		const scanned = text.slice(chunk.start, chunk.end);
		for (const rule of rules) {
			for (const match of scanned.matchAll(rule.regex)) {
				const start = chunk.start + match.index;
				const end = start + match[0].length;
				if (match[0].length === 0 || match[0].length > MAX_MATCH_LENGTH) continue;
				// A match that stops where the scan was cut in the middle of a word might have been longer.
				if (chunk.hard && end === chunk.end) continue;
				if (found.some(other => start < other.end && other.start < end)) continue;
				const url = buildLinkRuleUrl(rule, match[0]);
				if (url === null) continue;
				found.push({ rule, start, end, url });
				if (found.length >= MAX_MATCHES_PER_TEXT) return found.sort((first, second) => first.start - second.start);
			}
		}
	}
	return found.sort((first, second) => first.start - second.start);
}

/**
 * The pieces of `text` a scan reads, none longer than {@link SCAN_CHUNK} and together at most {@link MAX_SCANNED_TEXT} characters from the start.
 * A backtracking pattern costs most on a long run of the same characters, so a text is read in pieces cut at whitespace when there is some in the last
 * part of a piece (a match that has whitespace in it and straddles a cut is lost); `hard` marks a cut in the middle of a word.
 */
function scanChunks(text: string): { start: number; end: number; hard: boolean }[] {
	const limit = Math.min(text.length, MAX_SCANNED_TEXT);
	const chunks: { start: number; end: number; hard: boolean }[] = [];
	let start = 0;
	while (start < limit) {
		let end = Math.min(start + SCAN_CHUNK, limit);
		let hard = false;
		if (end < text.length) {
			let cut = end;
			while (cut >= start + SCAN_CHUNK_MIN && !/\s/.test(text[cut] as string)) cut--;
			if (cut >= start + SCAN_CHUNK_MIN) end = cut;
			else hard = true;
		}
		chunks.push({ start, end, hard });
		start = end;
	}
	return chunks;
}

/** The rule that matches the whole of `content` (an inline code span, surrounding whitespace ignored), with the characters it matched. */
export function matchWholeLinkRule(rules: readonly LinkRule[], content: string): { rule: LinkRule; text: string; url: string } | null {
	const text = content.trim();
	if (text === "") return null;
	for (const rule of rules) {
		const url = buildLinkRuleUrl(rule, text);
		if (url !== null) return { rule, text, url };
	}
	return null;
}

const SCHEME = "link-rule://";
const TARGET = /^link-rule:\/\/(\d{1,3})\/([^]*)$/;

/** What a click sends: the rule's position and the matched characters. The host finds the rule itself and builds the URL itself. */
export function linkRuleTarget(id: number, text: string): string {
	return `${SCHEME}${id}/${encodeURIComponent(wellFormed(text))}`;
}

export function parseLinkRuleTarget(target: string): { id: number; text: string } | null {
	const match = TARGET.exec(target);
	if (match === null) return null;
	let text: string;
	try { text = decodeURIComponent(match[2] as string); }
	catch { return null; }
	const id = Number(match[1]);
	return id <= MAX_RULE_ID && text !== "" && text.length <= MAX_MATCH_LENGTH ? { id, text } : null;
}

/** The hover text of a rule link: the rule's name when it has one, the URL a click opens, and what each gesture does (the same line as every web link). */
export function linkRuleTitle(rule: Pick<LinkRule, "name">, url: string): string {
	return [...(rule.name === null ? [] : [rule.name]), url, WEB_LINK_HINT].join("\n");
}

/** An entry of an `omp:chat-link-rules` message with the fields it declares, or `null`: its shape only; the receiver compiles it ({@link compileLinkRule}). */
export function parseLinkRuleEntry(raw: unknown): LinkRuleEntry | null {
	if (!isObject(raw)) return null;
	const { id, pattern, url, ignoreCase, name } = raw;
	if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 0 || id > MAX_RULE_ID) return null;
	if (typeof pattern !== "string" || pattern === "" || pattern.length > MAX_PATTERN_LENGTH) return null;
	if (typeof url !== "string" || url === "" || url.length > MAX_TEMPLATE_LENGTH || typeof ignoreCase !== "boolean") return null;
	if (name !== null && (typeof name !== "string" || name === "" || name.length > MAX_NAME_LENGTH)) return null;
	return { id, pattern, url, ignoreCase, name };
}
