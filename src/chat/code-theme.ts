/**
 * The colour themes of fenced code, as the host sends them and the page matches them.
 *
 * A Webview receives no token colours from VS Code (only `--vscode-*` workbench colours), so the host
 * resolves the TextMate rules of the colour themes that may be active (`src/host/code-theme.ts`) and sends
 * them as plain, bounded data (`omp:chat-code-theme`). Which of them is active is not the host's guess: the
 * page knows the exact theme id (`data-vscode-theme-id` on `<body>`) and picks the entry with that id. The
 * page matches the rules against the scopes its tokenizer reports (`src/webview/lib/code-theme-style.ts`).
 * Rules keep VS Code's order: a later rule of the same specificity wins.
 *
 * A theme is untrusted data (an extension's JSON): every field is validated here, on the host before it is
 * sent and on the page when it arrives, and a colour is only ever a hex literal.
 */
import { isRecord } from "../shared/guards.ts";

/** One rule of the theme: the selectors it applies to and the style it sets. */
export interface CodeThemeRule {
	/** TextMate scope selectors: a scope name, or descendant scopes separated by spaces (`source.css variable`). */
	readonly scopes: readonly string[];
	/** `#RGB`, `#RGBA`, `#RRGGBB` or `#RRGGBBAA`; absent leaves the colour to an outer scope. */
	readonly foreground?: string;
	/** Space-separated `italic`, `bold`, `underline`, `strikethrough`; `""` clears them; absent leaves them to an outer scope. */
	readonly fontStyle?: string;
}

export interface CodeTheme {
	/** The theme's settings id (what `workbench.colorTheme` holds and `data-vscode-theme-id` shows). */
	readonly id: string;
	readonly rules: readonly CodeThemeRule[];
}

export const MAX_CODE_THEME_RULES = 1_500;
export const MAX_CODE_THEME_SCOPES_PER_RULE = 64;
export const MAX_CODE_THEME_SCOPE_LENGTH = 200;
export const MAX_CODE_THEME_ID_LENGTH = 200;
/** One theme is at most this large serialised. */
export const MAX_CODE_THEME_JSON_BYTES = 96 * 1024;
/** The themes of one message: the one `workbench.colorTheme` names and the preferred ones of the active kind. */
export const MAX_CODE_THEMES = 3;

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const FONT_STYLES = ["italic", "bold", "underline", "strikethrough"];
/** A scope selector: scope names (letters, digits and the punctuation real scope names use), descendants separated by single spaces, `>` as the child combinator. */
const SCOPE_SELECTOR = /^[A-Za-z0-9_.+#$@*!?~:/<>=|&^%-]+(?: [A-Za-z0-9_.+#$@*!?~:/<>=|&^%-]+)*$/;

export function isHexColor(value: unknown): value is string {
	return typeof value === "string" && HEX_COLOR.test(value);
}

/**
 * `"italic  bold"` as the canonical `"italic bold"`. Words that are not font styles are dropped, as VS Code
 * does (`"normal"` and `""` both clear the style, and the rule still sets it).
 */
export function normalizeFontStyle(value: string): string {
	const words = value.split(/\s+/).filter(word => word !== "");
	return FONT_STYLES.filter(style => words.includes(style)).join(" ");
}

export function isScopeSelector(value: unknown): value is string {
	return typeof value === "string" && value.length <= MAX_CODE_THEME_SCOPE_LENGTH && SCOPE_SELECTOR.test(value);
}

function parseRule(value: unknown): CodeThemeRule | null {
	if (!isRecord(value) || !Array.isArray(value.scopes) || value.scopes.length === 0 || value.scopes.length > MAX_CODE_THEME_SCOPES_PER_RULE) return null;
	if (!value.scopes.every(isScopeSelector)) return null;
	const { foreground, fontStyle } = value;
	if (foreground !== undefined && !isHexColor(foreground)) return null;
	if (fontStyle !== undefined && (typeof fontStyle !== "string" || normalizeFontStyle(fontStyle) !== fontStyle)) return null;
	if (foreground === undefined && fontStyle === undefined) return null;
	return {
		scopes: value.scopes as string[],
		...(foreground === undefined ? {} : { foreground }),
		...(fontStyle === undefined ? {} : { fontStyle }),
	};
}

/** Validate one untrusted theme; `null` when its shape, a bound or any rule is wrong (a half-valid theme is not used). */
export function parseCodeTheme(value: unknown): CodeTheme | null {
	if (!isRecord(value) || typeof value.id !== "string" || value.id === "" || value.id.length > MAX_CODE_THEME_ID_LENGTH) return null;
	if (!Array.isArray(value.rules) || value.rules.length > MAX_CODE_THEME_RULES) return null;
	const rules: CodeThemeRule[] = [];
	for (const raw of value.rules) {
		const rule = parseRule(raw);
		if (rule === null) return null;
		rules.push(rule);
	}
	return { id: value.id, rules };
}

/** Validate the themes of one message: at most {@link MAX_CODE_THEMES}, each valid, ids distinct. `null` on any doubt. */
export function parseCodeThemes(value: unknown): CodeTheme[] | null {
	if (!Array.isArray(value) || value.length > MAX_CODE_THEMES) return null;
	const themes: CodeTheme[] = [];
	for (const raw of value) {
		const theme = parseCodeTheme(raw);
		if (theme === null || themes.some(known => known.id === theme.id)) return null;
		themes.push(theme);
	}
	return themes;
}
