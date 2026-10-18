/**
 * The colours an `svg` figure's `var(--fg)`-style tokens resolve to, taken from the theme the diagrams are already drawn in.
 *
 * An SVG shown as an image cannot see the page's custom properties, so the page hands the sanitizer ({@link ./svg-figure.ts})
 * these values and the tokens are written into the figure as plain colours. The pure half is {@link figurePaletteFrom};
 * {@link useFigurePalette} is the page's one live copy of it, and follows theme changes.
 */
import { useSyncExternalStore } from "react";
import type { MermaidTheme } from "../mermaid/contract.ts";
import { mermaidThemeFrom, mix, parseColor, toHex } from "./mermaid-theme.ts";
import { readPageTheme, watchPageTheme, type PageTheme } from "./mermaid-theme-dom.ts";
import type { FigurePalette } from "./svg-figure.ts";

/** Where the theme's table misses a colour: the built-in dark theme's own value. */
const DEFAULT_THEME: MermaidTheme = mermaidThemeFrom(() => "", false);

/** A `#rrggbb` variable of the theme, or the same variable of the built-in theme. */
function colour(theme: MermaidTheme, name: string): string {
	const value = theme.variables[name];
	if (value !== undefined && parseColor(value) !== null) return value;
	return DEFAULT_THEME.variables[name] ?? "#cccccc";
}

/**
 * The figure palette of one theme. `fg` is the text colour, `border` a node outline, `surface` a node fill, `accent` and
 * the series `c1`…`c6` the theme's six chart hues (blue leads, as the accent does), `success`, `warning` and `error` the
 * green, orange and red among them, and `muted` the text colour a third of the way back to the background.
 */
export function figurePaletteFrom(theme: MermaidTheme): FigurePalette {
	const foreground = colour(theme, "textColor");
	const background = colour(theme, "background");
	const foregroundRgb = parseColor(foreground)?.rgb;
	const backgroundRgb = parseColor(background)?.rgb;
	const muted = foregroundRgb !== undefined && backgroundRgb !== undefined ? toHex(mix(foregroundRgb, backgroundRgb, 0.35)) : foreground;
	return {
		fg: foreground,
		muted,
		border: colour(theme, "nodeBorder"),
		accent: colour(theme, "pie1"),
		success: colour(theme, "pie2"),
		warning: colour(theme, "pie3"),
		error: colour(theme, "pie5"),
		surface: colour(theme, "primaryColor"),
		c1: colour(theme, "pie1"),
		c2: colour(theme, "pie2"),
		c3: colour(theme, "pie3"),
		c4: colour(theme, "pie4"),
		c5: colour(theme, "pie5"),
		c6: colour(theme, "pie6"),
		fontFamily: theme.fontFamily,
	};
}

// ---- the page's live palette --------------------------------------------------------------------------

/** What a render without a page (the server, a test) gets: the built-in dark theme. */
const DEFAULT_PALETTE: FigurePalette = figurePaletteFrom(DEFAULT_THEME);

interface Snapshot {
	readonly page: PageTheme;
	readonly palette: FigurePalette;
}

let snapshot: Snapshot | null = null;
let stopWatching: (() => void) | null = null;
const listeners = new Set<() => void>();

function adopt(page: PageTheme): void {
	if (snapshot?.page.key !== page.key) snapshot = { page, palette: figurePaletteFrom(page.theme) };
}

/** The same object for as long as the theme is the same: React compares snapshots by identity. */
function currentPalette(): FigurePalette {
	if (typeof document === "undefined") return DEFAULT_PALETTE;
	// While nobody watches, the theme may have changed unseen; read it again (a watched snapshot is kept current).
	if (stopWatching === null || snapshot === null) adopt(readPageTheme());
	return snapshot?.palette ?? DEFAULT_PALETTE;
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	if (stopWatching === null) {
		// One observer for every figure on the page; it stops with the last of them.
		stopWatching = watchPageTheme(
			() => snapshot?.page ?? null,
			next => {
				adopt(next);
				for (const notify of listeners) notify();
			},
		);
		// The theme may have changed between the render that read it and this subscription.
		const page = readPageTheme();
		if (page.key !== snapshot?.page.key) {
			adopt(page);
			listener();
		}
	}
	return () => {
		listeners.delete(listener);
		if (listeners.size === 0 && stopWatching !== null) {
			stopWatching();
			stopWatching = null;
		}
	};
}

/** The figure palette of the page's current theme; changes with it. */
export function useFigurePalette(): FigurePalette {
	return useSyncExternalStore(subscribe, currentPalette, () => DEFAULT_PALETTE);
}
