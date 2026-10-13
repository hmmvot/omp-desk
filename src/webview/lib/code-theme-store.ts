/**
 * The page's copy of the editor theme's token rules (`omp:chat-code-theme`), and what hangs on it.
 *
 * The host sends the themes that may be active; which one is active is what VS Code tells the page itself:
 * `data-vscode-theme-id` on `<body>` holds the settings id of the active theme and is rewritten on every
 * theme change. The entry with that id is used; without the attribute the first entry is (the one
 * `workbench.colorTheme` names), and with an id no entry has the code stays plain.
 *
 * Attached to the host transport before the document announces itself, like the session view, so the
 * message the host sends in answer to the announcement is never missed. The themes are validated again
 * here: they are an extension's JSON relayed by the host.
 */
import type { CodeTheme } from "../../chat/code-theme.ts";
import { parseCodeThemes } from "../../chat/code-theme.ts";
import type { GuestHostMessage } from "../../protocol/messages.ts";
import { createCodeThemeStyler, type CodeThemeStyler } from "./code-theme-style.ts";

interface CodeThemeTransport {
	subscribe(listener: (message: GuestHostMessage) => void): () => void;
}

/** What a page colours code with: the matcher of the active theme, or `null` for plain code. */
export interface CodeThemeState {
	readonly theme: CodeTheme | null;
	readonly styler: CodeThemeStyler | null;
}

/** The CSS variable inline code takes its colour from; the string colour of the theme when it has one. */
export const INLINE_CODE_VARIABLE = "--omp-inline-code";
const THEME_ID_ATTRIBUTE = "data-vscode-theme-id";
const NO_THEME: CodeThemeState = { theme: null, styler: null };

let candidates: readonly CodeTheme[] = [];
let candidatesKey = "[]";
let state: CodeThemeState = NO_THEME;
const stylers = new Map<CodeTheme, CodeThemeStyler>();
const listeners = new Set<() => void>();
let detach: (() => void) | null = null;
let observer: MutationObserver | null = null;

function activeThemeId(): string | null {
	if (typeof document === "undefined" || document.body === null) return null;
	const id = document.body.getAttribute(THEME_ID_ATTRIBUTE);
	return id === null || id === "" ? null : id;
}

function applyInlineCodeColor(styler: CodeThemeStyler | null): void {
	if (typeof document === "undefined") return;
	// `string.quoted.double` is what a string is scoped as; a rule for `string` or any prefix of it applies.
	const color = styler?.styleOf(["string.quoted.double"]).color ?? null;
	const root = document.documentElement.style;
	if (color === null) root.removeProperty(INLINE_CODE_VARIABLE);
	else root.setProperty(INLINE_CODE_VARIABLE, color);
}

function pick(): void {
	const id = activeThemeId();
	const theme = id === null ? (candidates[0] ?? null) : (candidates.find(candidate => candidate.id === id) ?? null);
	if (theme === state.theme) return;
	let styler: CodeThemeStyler | null = null;
	if (theme !== null) {
		styler = stylers.get(theme) ?? createCodeThemeStyler(theme.rules);
		stylers.set(theme, styler);
	}
	state = theme === null ? NO_THEME : { theme, styler };
	applyInlineCodeColor(state.styler);
	for (const listener of listeners) listener();
}

/** Replace the candidate themes (tests and the transport share this one path); the same themes again change nothing. */
export function setCodeThemes(value: unknown): void {
	const themes = parseCodeThemes(value) ?? [];
	const key = JSON.stringify(themes);
	if (key === candidatesKey) return;
	candidatesKey = key;
	candidates = themes;
	stylers.clear();
	pick();
}

export function attachCodeTheme(transport: CodeThemeTransport): void {
	detach?.();
	detach = transport.subscribe(message => {
		if (message.type === "omp:chat-code-theme") setCodeThemes(message.themes);
	});
	if (observer === null && typeof MutationObserver !== "undefined" && typeof document !== "undefined" && document.body !== null) {
		observer = new MutationObserver(pick);
		observer.observe(document.body, { attributes: true, attributeFilter: [THEME_ID_ATTRIBUTE] });
	}
}

export function codeThemeSnapshot(): CodeThemeState {
	return state;
}

export function subscribeCodeTheme(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}
