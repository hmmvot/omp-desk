/**
 * Colour of a token: the editor theme's TextMate rules matched against a token's scope stack.
 *
 * This follows `vscode-textmate`'s theme matching, the code VS Code's own editor colours tokens with, so a
 * token gets what the same scopes get in the editor:
 *
 * - a rule applies to a scope when its selector's last segment is that scope or a dotted prefix of it
 *   (`keyword.control` applies to `keyword.control.ts`);
 * - a selector with several segments (`source.css variable`, `a > b`) also needs its other segments among
 *   the enclosing scopes, nearest first; `>` requires the next enclosing scope to match directly;
 * - among the applicable rules the one with the longer selector scope wins, then the one with more
 *   enclosing segments; rules without enclosing segments of one scope merge in theme order (a later
 *   rule overrides the fields it sets), and a more specific scope starts from the less specific rules;
 * - a token's style is its innermost scope's rule laid over the style of the scopes around it, field by field.
 */
import type { CodeThemeRule } from "../../chat/code-theme.ts";

export const FONT_ITALIC = 1;
export const FONT_BOLD = 2;
export const FONT_UNDERLINE = 4;
export const FONT_STRIKETHROUGH = 8;

const FONT_BITS: Record<string, number> = { italic: FONT_ITALIC, bold: FONT_BOLD, underline: FONT_UNDERLINE, strikethrough: FONT_STRIKETHROUGH };

/** What a token is drawn with; `null` fields mean the block's own default. */
export interface TokenStyle {
	readonly color: string | null;
	/** `FONT_*` bits. */
	readonly fontStyle: number;
}

export const PLAIN_STYLE: TokenStyle = { color: null, fontStyle: 0 };

/** One rule's fields; `undefined` is "not set by this rule". */
interface Fields { color?: string; fontStyle?: number }

interface ScopedRule extends Fields {
	readonly scope: string;
	/** Enclosing segments, nearest first; `>` items mark "directly enclosing". */
	readonly parents: readonly string[];
	readonly depth: number;
}

function fontBits(value: string): number {
	let bits = 0;
	for (const word of value.split(/\s+/)) bits |= FONT_BITS[word] ?? 0;
	return bits;
}

function scopeMatches(scope: string, pattern: string): boolean {
	return scope === pattern || (scope.startsWith(pattern) && scope.charCodeAt(pattern.length) === 46);
}

/** vscode-textmate's `_scopePathMatchesParentScopes`: `stack` is outermost first, `end` the index of the nearest enclosing scope. */
function parentsMatch(parents: readonly string[], stack: readonly string[], end: number): boolean {
	let at = end;
	for (let index = 0; index < parents.length; index++) {
		let pattern = parents[index] as string;
		let mustMatchHere = false;
		if (pattern === ">") {
			if (index === parents.length - 1) return false;
			pattern = parents[++index] as string;
			mustMatchHere = true;
		}
		while (at >= 0) {
			if (scopeMatches(stack[at] as string, pattern)) break;
			if (mustMatchHere) return false;
			at--;
		}
		if (at < 0) return false;
		at--;
	}
	return true;
}

/** vscode-textmate's `_cmpBySpecificity`: negative when `a` is the more specific. */
function bySpecificity(a: ScopedRule, b: ScopedRule): number {
	if (a.depth !== b.depth) return b.depth - a.depth;
	let ai = 0;
	let bi = 0;
	for (;;) {
		if (a.parents[ai] === ">") ai++;
		if (b.parents[bi] === ">") bi++;
		if (ai >= a.parents.length || bi >= b.parents.length) return b.parents.length - a.parents.length;
		const diff = (b.parents[bi] as string).length - (a.parents[ai] as string).length;
		if (diff !== 0) return diff;
		ai++;
		bi++;
	}
}

function overlay(base: Fields, over: Fields): Fields {
	const merged: Fields = { ...base };
	if (over.color !== undefined) merged.color = over.color;
	if (over.fontStyle !== undefined) merged.fontStyle = over.fontStyle;
	return merged;
}

/** Resolves a token's scope stack (outermost first) to a style; results are cached per stack. */
export interface CodeThemeStyler {
	styleOf(stack: readonly string[]): TokenStyle;
}

export function createCodeThemeStyler(rules: readonly CodeThemeRule[]): CodeThemeStyler {
	// Rules that apply without enclosing segments, by scope; the ones with enclosing segments, by last segment.
	const plain = new Map<string, Fields[]>();
	const scoped = new Map<string, ScopedRule[]>();
	for (const rule of rules) {
		const fields: Fields = {};
		if (rule.foreground !== undefined) fields.color = rule.foreground;
		if (rule.fontStyle !== undefined) fields.fontStyle = fontBits(rule.fontStyle);
		for (const selector of rule.scopes) {
			const segments = selector.split(" ").filter(segment => segment !== "");
			const scope = segments.pop();
			if (scope === undefined) continue;
			if (segments.length === 0) {
				const list = plain.get(scope);
				if (list === undefined) plain.set(scope, [fields]);
				else list.push(fields);
			} else {
				const parents = segments.reverse();
				const list = scoped.get(scope);
				// The same scope with the same enclosing segments is one rule: a later one overrides the fields it sets.
				const same = list?.findIndex(entry => entry.parents.join(" ") === parents.join(" ")) ?? -1;
				if (list !== undefined && same >= 0) list[same] = { ...overlay(list[same] as ScopedRule, fields), scope, parents, depth: (list[same] as ScopedRule).depth };
				else {
					const entry: ScopedRule = { ...fields, scope, parents, depth: scope.split(".").length };
					if (list === undefined) scoped.set(scope, [entry]);
					else list.push(entry);
				}
			}
		}
	}

	/** The rule of the scope at `index` of the stack, or `null` when no rule applies. */
	const match = (stack: readonly string[], index: number): Fields | null => {
		const scope = stack[index] as string;
		const parts = scope.split(".");
		let main: Fields | null = null;
		let mainDepth = 0;
		const candidates: ScopedRule[] = [];
		let prefix = "";
		for (const part of parts) {
			prefix = prefix === "" ? part : `${prefix}.${part}`;
			const fieldsHere = plain.get(prefix);
			if (fieldsHere !== undefined) {
				for (const fields of fieldsHere) main = overlay(main ?? {}, fields);
				mainDepth = prefix.split(".").length;
			}
			for (const rule of scoped.get(prefix) ?? []) candidates.push(rule);
		}
		const ranked = candidates.sort(bySpecificity);
		for (const rule of ranked) {
			if (rule.depth < mainDepth) break;
			if (parentsMatch(rule.parents, stack, index - 1)) return rule;
		}
		return main;
	};

	const cache = new Map<string, TokenStyle>();
	return {
		styleOf(stack) {
			const key = stack.join(" ");
			const cached = cache.get(key);
			if (cached !== undefined) return cached;
			let state: Fields = {};
			for (let index = 0; index < stack.length; index++) {
				const rule = match(stack, index);
				if (rule !== null) state = overlay(state, rule);
			}
			const style: TokenStyle = { color: state.color ?? null, fontStyle: state.fontStyle ?? 0 };
			cache.set(key, style);
			return style;
		},
	};
}
