/** The page's side of {@link ./mermaid-theme.ts}: reading the VS Code theme from the document, and noticing when it changes. Shared by the chat page and the diagram tab. */
import type { MermaidTheme } from "../mermaid/contract.ts";
import { mermaidThemeFrom, themeKey } from "./mermaid-theme.ts";

export interface PageTheme {
	readonly theme: MermaidTheme;
	readonly key: string;
}

/** The theme the page is in now. `<body>` inherits the variables VS Code sets on `<html>`, so reading them there sees both. */
export function readPageTheme(): PageTheme {
	const styles = getComputedStyle(document.body);
	const highContrast = document.body.classList.contains("vscode-high-contrast") || document.body.classList.contains("vscode-high-contrast-light");
	const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
	const theme = mermaidThemeFrom(name => styles.getPropertyValue(name), highContrast, reducedMotion);
	return { theme, key: themeKey(theme) };
}

/**
 * Call `onChange` with the new theme whenever it is not the one `current` names. VS Code rewrites `<html>`'s variables and
 * `<body>`'s classes on a theme change; both are watched, and so is the motion preference.
 * @returns stops watching
 */
export function watchPageTheme(current: () => PageTheme | null, onChange: (next: PageTheme) => void): () => void {
	if (typeof MutationObserver === "undefined") return () => {};
	const check = (): void => {
		const next = readPageTheme();
		if (next.key !== current()?.key) onChange(next);
	};
	const observer = new MutationObserver(check);
	observer.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "class"] });
	observer.observe(document.body, { attributes: true, attributeFilter: ["class", "data-vscode-theme-id", "data-vscode-theme-name"] });
	const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
	motion.addEventListener("change", check);
	return () => {
		observer.disconnect();
		motion.removeEventListener("change", check);
	};
}
