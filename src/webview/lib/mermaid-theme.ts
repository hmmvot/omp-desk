/**
 * The colours and font a diagram is drawn with, from the VS Code theme the page is in.
 *
 * Mermaid's `themeVariables` take concrete colours (its colour library cannot read `var(…)` or the
 * `color(srgb …)` a computed `color-mix()` returns), so the page reads the theme's variables, parses them and
 * does the mixing itself. Everything here is pure: the page passes a reader, tests pass a table.
 */
import type { MermaidTheme } from "../mermaid/contract.ts";

interface Rgb {
	readonly r: number;
	readonly g: number;
	readonly b: number;
}

/** The theme variables read; the first one that parses wins where a fallback is listed. */
const VARIABLES = {
	background: ["--vscode-editor-background"],
	foreground: ["--vscode-editor-foreground", "--vscode-foreground"],
	border: ["--vscode-panel-border", "--vscode-editorWidget-border", "--vscode-widget-border"],
	contrastBorder: ["--vscode-contrastBorder"],
	link: ["--vscode-textLink-foreground"],
	red: ["--vscode-charts-red"],
	orange: ["--vscode-charts-orange"],
	yellow: ["--vscode-charts-yellow"],
	green: ["--vscode-charts-green"],
	blue: ["--vscode-charts-blue"],
	purple: ["--vscode-charts-purple"],
} as const;

/** Where a theme names no colour: the Dark Modern / Light Modern values, chosen by the background's lightness. */
const DARK_DEFAULTS = { background: "#1f1f1f", foreground: "#cccccc", red: "#f14c4c", orange: "#d18616", yellow: "#cca700", green: "#89d185", blue: "#3794ff", purple: "#b180d7" };
const LIGHT_DEFAULTS = { background: "#ffffff", foreground: "#3b3b3b", red: "#e51400", orange: "#d18616", yellow: "#bf8803", green: "#388a34", blue: "#1a85ff", purple: "#652d90" };

const FALLBACK_FONT = "sans-serif";

/** `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()` and `rgba()`; alpha is returned for the caller to flatten. */
export function parseColor(value: string): { readonly rgb: Rgb; readonly alpha: number } | null {
	const text = value.trim().toLowerCase();
	const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(text)?.[1];
	if (hex !== undefined) {
		const full = hex.length <= 4 ? [...hex].map(digit => digit + digit).join("") : hex;
		const channel = (at: number): number => Number.parseInt(full.slice(at, at + 2), 16);
		return { rgb: { r: channel(0), g: channel(2), b: channel(4) }, alpha: full.length === 8 ? channel(6) / 255 : 1 };
	}
	const call = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+)(%?))?\s*\)$/.exec(text);
	if (call !== null) {
		const [r, g, b] = [Number(call[1]), Number(call[2]), Number(call[3])];
		const alpha = call[4] === undefined ? 1 : call[5] === "%" ? Number(call[4]) / 100 : Number(call[4]);
		if ([r, g, b, alpha].some(part => !Number.isFinite(part))) return null;
		return { rgb: { r: clamp(r), g: clamp(g), b: clamp(b) }, alpha: Math.min(1, Math.max(0, alpha)) };
	}
	return null;
}

function clamp(channel: number): number {
	return Math.min(255, Math.max(0, Math.round(channel)));
}

/** `amount` of `to` over `from` (0 gives `from`, 1 gives `to`). */
export function mix(from: Rgb, to: Rgb, amount: number): Rgb {
	return { r: clamp(from.r + (to.r - from.r) * amount), g: clamp(from.g + (to.g - from.g) * amount), b: clamp(from.b + (to.b - from.b) * amount) };
}

export function toHex(color: Rgb): string {
	return `#${[color.r, color.g, color.b].map(channel => channel.toString(16).padStart(2, "0")).join("")}`;
}

/** Relative luminance, 0 (black) to 1 (white). */
function luminance(color: Rgb): number {
	const linear = (channel: number): number => {
		const value = channel / 255;
		return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * linear(color.r) + 0.7152 * linear(color.g) + 0.0722 * linear(color.b);
}

function distance(a: Rgb, b: Rgb): number {
	return Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b);
}

/** The font stack with only characters that cannot end a CSS declaration or an attribute; quotes become apostrophes. */
export function safeFontFamily(value: string): string {
	const cleaned = value.replace(/"/g, "'").replace(/[^A-Za-z0-9 ,'._-]/g, "").replace(/\s+/g, " ").trim().slice(0, 200);
	return cleaned === "" ? FALLBACK_FONT : cleaned;
}

/** A pixel font size between 11 and 20, from `13px` or a bare number; 13 when unreadable. */
export function safeFontSize(value: string): string {
	const size = Number.parseFloat(value);
	return `${Number.isFinite(size) ? Math.min(20, Math.max(11, Math.round(size))) : 13}px`;
}

/**
 * The mermaid theme for the page's current VS Code theme.
 *
 * @param read the value of a CSS variable on the document (`""` when unset)
 * @param highContrast the page is in a High Contrast or High Contrast Light theme
 * @param reducedMotion the reader asked for less motion
 */
export function mermaidThemeFrom(read: (name: string) => string, highContrast: boolean, reducedMotion = false): MermaidTheme {
	const first = (names: readonly string[]): { rgb: Rgb; alpha: number } | null => {
		for (const name of names) {
			const parsed = parseColor(read(name));
			if (parsed !== null) return parsed;
		}
		return null;
	};
	const rawBackground = first(VARIABLES.background);
	const darkMode = rawBackground === null ? true : luminance(rawBackground.rgb) < 0.4;
	const defaults = darkMode ? DARK_DEFAULTS : LIGHT_DEFAULTS;
	const rgbOf = (hex: string): Rgb => {
		const parsed = parseColor(hex);
		if (parsed === null) throw new Error(`Invalid built-in colour ${hex}`);
		return parsed.rgb;
	};
	const background = rawBackground?.rgb ?? rgbOf(defaults.background);
	/** A colour with its alpha flattened onto the background, or the named default. */
	const solid = (names: readonly string[], fallbackHex: string): Rgb => {
		const color = first(names);
		return color === null ? rgbOf(fallbackHex) : mix(background, color.rgb, color.alpha);
	};
	const foreground = solid(VARIABLES.foreground, defaults.foreground);
	const accent = solid(VARIABLES.link, defaults.blue);
	const chart = (key: "red" | "orange" | "yellow" | "green" | "blue" | "purple"): Rgb => solid(VARIABLES[key], defaults[key]);

	// A High Contrast theme draws on its own background with strong edges: no tinted fills, full-strength lines.
	const surface = highContrast ? background : mix(background, foreground, 0.1);
	const panel = highContrast ? background : mix(background, foreground, 0.05);
	const themeBorder = highContrast ? solid(VARIABLES.contrastBorder, toHex(foreground)) : solid(VARIABLES.border, toHex(mix(background, foreground, 0.35)));
	// The theme's panel border is a hairline between panels (Light Modern: #e5e5e5 on white); a node outline has to stand out more.
	const border = distance(themeBorder, background) < (highContrast ? 45 : 120) ? mix(background, foreground, highContrast ? 1 : 0.35) : themeBorder;
	const line = highContrast ? foreground : mix(background, foreground, 0.7);
	const note = highContrast ? background : mix(background, chart("yellow"), 0.22);
	const palette = [chart("blue"), chart("green"), chart("orange"), chart("purple"), chart("red"), chart("yellow")].map(color => (highContrast ? color : mix(background, color, darkMode ? 0.75 : 0.85)));

	const variables: Record<string, string> = {
		background: toHex(background),
		primaryColor: toHex(surface),
		primaryTextColor: toHex(foreground),
		primaryBorderColor: toHex(border),
		secondaryColor: toHex(highContrast ? background : mix(background, accent, 0.2)),
		secondaryTextColor: toHex(foreground),
		secondaryBorderColor: toHex(border),
		tertiaryColor: toHex(panel),
		tertiaryTextColor: toHex(foreground),
		tertiaryBorderColor: toHex(border),
		textColor: toHex(foreground),
		lineColor: toHex(line),
		mainBkg: toHex(surface),
		nodeBorder: toHex(border),
		nodeTextColor: toHex(foreground),
		clusterBkg: toHex(panel),
		clusterBorder: toHex(border),
		titleColor: toHex(foreground),
		edgeLabelBackground: toHex(background),
		noteBkgColor: toHex(note),
		noteTextColor: toHex(foreground),
		noteBorderColor: toHex(border),
		actorBkg: toHex(surface),
		actorBorder: toHex(border),
		actorTextColor: toHex(foreground),
		actorLineColor: toHex(line),
		signalColor: toHex(line),
		signalTextColor: toHex(foreground),
		labelBoxBkgColor: toHex(surface),
		labelBoxBorderColor: toHex(border),
		labelTextColor: toHex(foreground),
		loopTextColor: toHex(foreground),
		activationBkgColor: toHex(highContrast ? background : mix(background, accent, 0.25)),
		activationBorderColor: toHex(border),
		sequenceNumberColor: toHex(background),
		pieTitleTextColor: toHex(foreground),
		// The slices are mid-tones in every theme, so the background's own colour (black or white in High Contrast) reads on all of them.
		pieSectionTextColor: toHex(background),
		pieLegendTextColor: toHex(foreground),
		pieStrokeColor: toHex(background),
		pieOuterStrokeColor: toHex(border),
		pieOpacity: "1",
	};
	palette.forEach((color, index) => {
		variables[`pie${index + 1}`] = toHex(color);
	});
	return {
		darkMode,
		fontFamily: safeFontFamily(read("--vscode-font-family")),
		fontSize: safeFontSize(read("--vscode-font-size")),
		reducedMotion,
		variables,
	};
}

/** The identity of a theme for caches: equal keys draw equal diagrams. */
export function themeKey(theme: MermaidTheme): string {
	return JSON.stringify([theme.darkMode, theme.fontFamily, theme.fontSize, theme.reducedMotion, Object.entries(theme.variables)]);
}
