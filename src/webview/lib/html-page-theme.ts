/** The theme an HTML page is given, from the theme the Chat is in now; changes with it. */
import { useMemo } from "react";
import { HTML_PAGE_FRAME_META, HTML_PAGE_FRAME_PATH } from "../../shared/html-page-frame.ts";
import { figurePaletteFrom, useFigurePalette } from "./figure-palette.ts";
import { htmlPageTheme, type HtmlPageTheme } from "./html-page.ts";
import { mermaidThemeFrom } from "./mermaid-theme.ts";
import { readPageTheme } from "./mermaid-theme-dom.ts";

const FALLBACK_MONO = "monospace";

/** What a render without a page (the server, a test) gets: the built-in dark theme. */
function fallbackTheme(): HtmlPageTheme {
	const theme = mermaidThemeFrom(() => "", false);
	return htmlPageTheme(theme, figurePaletteFrom(theme), FALLBACK_MONO);
}

export function useHtmlPageTheme(): HtmlPageTheme {
	const palette = useFigurePalette();
	// `palette` is the same object until the theme changes, which is when the page's variables must be read again.
	return useMemo(() => {
		if (typeof document === "undefined" || typeof getComputedStyle !== "function") return fallbackTheme();
		const page = readPageTheme();
		const mono = getComputedStyle(document.body).getPropertyValue("--vscode-editor-font-family").trim();
		return htmlPageTheme(page.theme, palette, mono.length > 0 ? mono : FALLBACK_MONO);
	}, [palette]);
}

const FRAME_URL = new RegExp(`^http://127\\.0\\.0\\.1:[0-9]{1,5}${HTML_PAGE_FRAME_PATH}$`);

/**
 * The address of this window's HTML page frame server, from the document the host built, or `null` when the document names none
 * (the setting was off or the listener could not be bound when it was built). Only the exact loopback shape the host writes is
 * taken, so the document's own policy (`frame-src`) and this value cannot disagree.
 */
export function htmlPageFrameUrl(): string | null {
	if (typeof document === "undefined") return null;
	const content = document.querySelector(`meta[name="${HTML_PAGE_FRAME_META}"]`)?.getAttribute("content") ?? "";
	return FRAME_URL.test(content) ? content : null;
}
