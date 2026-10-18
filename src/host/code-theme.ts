/**
 * Resolves the colour themes Chat may colour fenced code with into bounded TextMate rules.
 *
 * The extension API names only the kind of the active theme, and which theme is active is not reliably
 * derivable from settings (a theme picker preview, an OS scheme change, a fallback). So the host does not
 * guess: it resolves the *candidates* (the themes the settings name, of the active kind) and the page uses
 * the one whose id equals `data-vscode-theme-id`. A theme is found the way the workbench does: from the
 * contributions of the installed extensions, the theme file with its `include` chain, and
 * `editor.tokenColorCustomizations` (see
 * [the design](../../docs/designs/2026-10-13-chat-code-highlighting.md), A1). Everything arrives as plain data
 * and files through ports, so this module imports neither `vscode` nor `node:fs`.
 *
 * Each theme is resolved on its own; one that cannot be resolved with certainty (unreadable, invalid,
 * oversized, a plist) is left out, never sent half.
 */
import {
	MAX_CODE_THEMES,
	MAX_CODE_THEME_JSON_BYTES,
	MAX_CODE_THEME_RULES,
	MAX_CODE_THEME_SCOPES_PER_RULE,
	isHexColor,
	isScopeSelector,
	normalizeFontStyle,
	parseCodeTheme,
} from "../chat/code-theme.ts";
import type { CodeTheme, CodeThemeRule } from "../chat/code-theme.ts";
import { isRecord } from "../shared/guards.ts";
import { parseJsonc } from "../shared/jsonc.ts";

/** The kinds `vscode.ColorThemeKind` has, by the names `uiTheme` uses for them in a manifest. */
export type CodeThemeKind = "light" | "dark" | "hc-dark" | "hc-light";

/** The settings that name a theme; the page decides which of them is shown. */
export interface CodeThemeSettings {
	/** `workbench.colorTheme`. */
	readonly colorTheme?: string;
	/** `workbench.preferredDarkColorTheme`. */
	readonly preferredDark?: string;
	/** `workbench.preferredLightColorTheme`. */
	readonly preferredLight?: string;
	/** `workbench.preferredHighContrastColorTheme`. */
	readonly preferredHighContrast?: string;
	/** `workbench.preferredHighContrastLightColorTheme`. */
	readonly preferredHighContrastLight?: string;
}

/** One entry of an extension's `contributes.themes`. */
export interface CodeThemeContribution {
	readonly extensionPath: string;
	readonly id?: string;
	readonly label?: string;
	readonly uiTheme?: string;
	/** Relative to `extensionPath`. */
	readonly path: string;
}

export interface CodeThemeInput {
	/** The kind of the active theme: only themes of this kind are candidates. */
	readonly kind: CodeThemeKind;
	readonly settings: CodeThemeSettings;
	/** The `editor.tokenColorCustomizations` value, unvalidated. */
	readonly customizations: unknown;
	readonly themes: readonly CodeThemeContribution[];
	/** The file's text, or `null` when it cannot be read. May reject. */
	readFile(path: string): Promise<string | null>;
	/** The file's size, or `null` when it is missing or not a regular file. May reject. */
	fileSize(path: string): Promise<number | null>;
}

const MAX_INCLUDE_DEPTH = 8;
const MAX_THEME_FILE_BYTES = 1024 * 1024;

/** Setting values that name a theme by an older name, mapped to the theme's id. */
const LEGACY_ALIASES: Record<string, string> = {
	"Default Dark Modern": "Dark Modern",
	"Default Light Modern": "Light Modern",
	"Default Dark+": "Dark+",
	"Default Light+": "Light+",
	"Experimental Dark": "Dark 2026",
	"VS Code Dark": "Dark 2026",
	"Experimental Light": "Light 2026",
	"VS Code Light": "Light 2026",
};

const UI_THEME_KINDS: Record<string, CodeThemeKind> = {
	vs: "light",
	"vs-dark": "dark",
	"hc-black": "hc-dark",
	"hc-light": "hc-light",
};

/** Customization group shorthands, in the order VS Code applies them, and the scopes each one expands to. */
const SHORTHAND_GROUPS: readonly (readonly [string, readonly string[]])[] = [
	["comments", ["comment", "punctuation.definition.comment"]],
	["strings", ["string", "meta.embedded.assembly"]],
	["keywords", ["keyword - keyword.operator", "keyword.control", "storage", "storage.type"]],
	["numbers", ["constant.numeric"]],
	["types", ["entity.name.type", "entity.name.class", "support.type", "support.class"]],
	["functions", ["entity.name.function", "support.function"]],
	["variables", ["variable", "entity.name.variable"]],
];

/**
 * The candidate themes: each distinct theme the settings name (`workbench.colorTheme` first) whose contribution
 * is of the active kind and resolves. At most `MAX_CODE_THEMES`. Never throws.
 */
export async function resolveCodeThemes(input: CodeThemeInput): Promise<CodeTheme[]> {
	const { settings } = input;
	const names: string[] = [];
	for (const value of [settings.colorTheme, settings.preferredDark, settings.preferredLight, settings.preferredHighContrast, settings.preferredHighContrastLight]) {
		if (typeof value !== "string" || value === "") continue;
		const id = Object.hasOwn(LEGACY_ALIASES, value) ? LEGACY_ALIASES[value]! : value;
		if (!names.includes(id)) names.push(id);
	}
	// The first contribution of an id wins, as in the workbench's registry.
	const contributions = new Map<string, CodeThemeContribution>();
	for (const contribution of input.themes) {
		if (!Object.hasOwn(UI_THEME_KINDS, contribution.uiTheme ?? "") || UI_THEME_KINDS[contribution.uiTheme!] !== input.kind) continue;
		const id = settingsId(contribution);
		if (!contributions.has(id)) contributions.set(id, contribution);
	}
	const wanted = names.flatMap(id => {
		const contribution = contributions.get(id);
		return contribution === undefined ? [] : [{ id, contribution }];
	});
	const resolved = await Promise.all(wanted.slice(0, MAX_CODE_THEMES).map(({ id, contribution }) => resolveOne(input, id, contribution)));
	return resolved.filter((theme): theme is CodeTheme => theme !== null);
}

/** A contribution's settings id, as the workbench derives it: `id`, else `label`, else the file name with its extension. */
function settingsId(contribution: CodeThemeContribution): string {
	return contribution.id || contribution.label || baseName(contribution.path);
}

async function resolveOne(input: CodeThemeInput, id: string, contribution: CodeThemeContribution): Promise<CodeTheme | null> {
	try {
		const raw = await loadFile(input, joinPath(contribution.extensionPath, contribution.path), 0, new Set());
		if (raw === null) return null;
		const rules: CodeThemeRule[] = [];
		for (const entry of raw) {
			if (isRecord(entry)) appendRule(rules, entry.scope, entry.settings);
		}
		appendCustomizations(rules, input.customizations, id);
		if (rules.length > MAX_CODE_THEME_RULES) return null;
		const theme = parseCodeTheme({ id, rules });
		if (theme === null) return null;
		return Buffer.byteLength(JSON.stringify(theme), "utf8") > MAX_CODE_THEME_JSON_BYTES ? null : theme;
	} catch {
		return null;
	}
}

// --- Files -----------------------------------------------------------------------------------------------

/** One JSONC file: a regular file of at most 1 MiB (checked before it is read) that parses. `null` otherwise. */
async function readJson(input: CodeThemeInput, path: string): Promise<{ value: unknown } | null> {
	const size = await input.fileSize(path);
	if (size === null || size > MAX_THEME_FILE_BYTES) return null;
	const text = await input.readFile(path);
	if (text === null) return null;
	try {
		return { value: parseJsonc(text) };
	} catch {
		return null;
	}
}

/**
 * The raw rule entries of a theme file: its `include` first (a chain of at most `MAX_INCLUDE_DEPTH`, no file
 * twice), then its own. `null` when anything on the way is missing, malformed or too deep, or when a file's
 * `tokenColors` is a string (VS Code reads that as a plist, which is not supported).
 */
async function loadFile(input: CodeThemeInput, path: string, depth: number, chain: Set<string>): Promise<unknown[] | null> {
	if (depth > MAX_INCLUDE_DEPTH || chain.has(path)) return null;
	const json = await readJson(input, path);
	if (json === null || !isRecord(json.value)) return null;
	const doc = json.value;
	chain.add(path);
	try {
		const rules: unknown[] = [];
		if (doc.include !== undefined) {
			if (typeof doc.include !== "string") return null;
			const included = await loadFile(input, joinPath(dirName(path), doc.include), depth + 1, chain);
			if (included === null) return null;
			rules.push(...included);
		}
		// A legacy `settings` array is the file's rules; its own `tokenColors` are then not read, as in the workbench.
		if (Array.isArray(doc.settings)) {
			rules.push(...doc.settings);
		} else if (Array.isArray(doc.tokenColors)) {
			rules.push(...doc.tokenColors);
		} else if (doc.tokenColors !== undefined) {
			return null;
		}
		return rules;
	} finally {
		chain.delete(path);
	}
}

// --- Paths (`/` and `\` alike; the result always uses `/`) -------------------------------------------------

function normalizePath(path: string): string {
	const slashed = path.replaceAll("\\", "/");
	const root = /^(?:[A-Za-z]:\/|\/\/|\/)/.exec(slashed)?.[0] ?? "";
	const segments: string[] = [];
	for (const segment of slashed.slice(root.length).split("/")) {
		if (segment === "" || segment === ".") continue;
		if (segment === "..") {
			if (segments.length > 0 && segments[segments.length - 1] !== "..") segments.pop();
			else if (root === "") segments.push("..");
		} else {
			segments.push(segment);
		}
	}
	return root + segments.join("/");
}

function joinPath(base: string, relative: string): string {
	return normalizePath(`${base}/${relative}`);
}

function dirName(path: string): string {
	const slashed = path.replaceAll("\\", "/");
	const cut = slashed.lastIndexOf("/");
	return cut === -1 ? "." : slashed.slice(0, cut === 0 ? 1 : cut);
}

function baseName(path: string): string {
	return path.replaceAll("\\", "/").split("/").pop() ?? "";
}

// --- Rules -----------------------------------------------------------------------------------------------

/**
 * Append the rule one theme or customization entry describes, if it sets a token colour or a font style. A
 * string scope is split at commas (an array's elements are not); a rule with more than 64 selectors becomes
 * several rules in the same order.
 */
function appendRule(rules: CodeThemeRule[], scope: unknown, settings: unknown): void {
	if (!isRecord(settings)) return;
	const names = typeof scope === "string" ? scope.split(",") : Array.isArray(scope) ? scope.filter((item): item is string => typeof item === "string") : [];
	const scopes = names.map(selector => selector.trim()).filter(isScopeSelector);
	if (scopes.length === 0) return;
	const foreground = isHexColor(settings.foreground) ? settings.foreground : undefined;
	const fontStyle = typeof settings.fontStyle === "string" ? normalizeFontStyle(settings.fontStyle) : undefined;
	if (foreground === undefined && fontStyle === undefined) return;
	for (let start = 0; start < scopes.length; start += MAX_CODE_THEME_SCOPES_PER_RULE) {
		rules.push({
			scopes: scopes.slice(start, start + MAX_CODE_THEME_SCOPES_PER_RULE),
			...(foreground === undefined ? {} : { foreground }),
			...(fontStyle === undefined ? {} : { fontStyle }),
		});
	}
}

/**
 * The customization rules: the global values and those of every `[Theme]` block that names this theme are merged
 * first (an array is concatenated, any other value is replaced by the later one), then the shorthands in VS Code's
 * order, then `textMateRules`. Font family, size and line height are not token colours and are ignored.
 */
function appendCustomizations(rules: CodeThemeRule[], customizations: unknown, themeId: string): void {
	if (!isRecord(customizations)) return;
	const merged: Record<string, unknown> = {};
	const merge = (block: Record<string, unknown>): void => {
		for (const [group] of SHORTHAND_GROUPS) {
			if (block[group] !== undefined) merged[group] = block[group];
		}
		if (Array.isArray(block.textMateRules)) {
			merged.textMateRules = [...(Array.isArray(merged.textMateRules) ? merged.textMateRules : []), ...block.textMateRules];
		}
	};
	merge(customizations);
	for (const [key, value] of Object.entries(customizations)) {
		if (!isRecord(value) || !/^\[.+\]$/.test(key)) continue;
		const groups = [...key.matchAll(/\[(.+?)\]/g)].map(match => match[1]!);
		if (groups.some(group => themeMatches(themeId, group))) merge(value);
	}
	for (const [group, scopes] of SHORTHAND_GROUPS) {
		const value = merged[group];
		if (typeof value === "string") appendRule(rules, scopes, { foreground: value });
		else if (isRecord(value)) appendRule(rules, scopes, value);
	}
	if (!Array.isArray(merged.textMateRules)) return;
	for (const item of merged.textMateRules) {
		if (isRecord(item)) appendRule(rules, item.scope, item.settings);
	}
}

/** A `[…]` group names the theme exactly, or with a `*` at either end (both ends: contained). */
function themeMatches(themeId: string, group: string): boolean {
	if (group.startsWith("*") && group.endsWith("*")) return themeId.includes(group.slice(1, -1));
	if (group.startsWith("*")) return themeId.endsWith(group.slice(1));
	if (group.endsWith("*")) return themeId.startsWith(group.slice(0, -1));
	return themeId === group;
}
