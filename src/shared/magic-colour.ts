/**
 * The colours of the magic keyword gradient on a VS Code theme.
 *
 * OMP's terminal paints every stop of the gradient as `hsl(hue, 90%, 62%)`, a colour made for a dark terminal. A VS Code theme can
 * be light, or high-contrast, and on a dark theme a blue at 62 % lightness is only about 2.7:1 against the input background, so the
 * hue sweep is kept and the lightness of each stop is moved until the word is as readable as ordinary text: 4.5:1 for the
 * dark and the light themes, 7:1 for the high-contrast ones (WCAG 2.1, 1.4.3 and 1.4.6).
 *
 * A word is painted on two surfaces: the composer's input background and a sent message's bubble. A theme's exact colours are not
 * known when the stylesheet is built, so each theme kind is designed against the hardest surface it can have: the lightest dark
 * surface, the darkest light one. A stop that passes there passes on every surface that is easier.
 *
 * Pure: no DOM, no theme variables.
 */
import { MAGIC_GRADIENT_STOPS, MAGIC_TUI_LIGHTNESS, MAGIC_TUI_SATURATION, magicStopHue, type MagicKeyword } from "./magic-keywords.ts";

/** The theme kinds VS Code's body classes name: `vscode-dark`, `vscode-light`, `vscode-high-contrast`, `vscode-high-contrast-light`. */
export type MagicThemeKind = "dark" | "light" | "high-contrast" | "high-contrast-light";

export const MAGIC_THEME_KINDS: readonly MagicThemeKind[] = ["dark", "light", "high-contrast", "high-contrast-light"];

/** What a theme kind is designed against: the surfaces the word can sit on and the contrast ratio it must keep with every one of them. */
export interface MagicThemeDesign {
	readonly surfaces: readonly string[];
	readonly ratio: number;
}

export const MAGIC_THEME_DESIGN: Readonly<Record<MagicThemeKind, MagicThemeDesign>> = {
	// Dark+'s input background is the lightest input of the built-in dark themes; a sent message's bubble is darker.
	dark: { surfaces: ["#3c3c3c"], ratio: 4.5 },
	// A message's bubble is the editor background with a tint of the focus border over it: about #d1e2f2 on Light Modern.
	light: { surfaces: ["#cddcec"], ratio: 4.5 },
	"high-contrast": { surfaces: ["#000000", "#1a1a1a"], ratio: 7 },
	"high-contrast-light": { surfaces: ["#ffffff", "#f2f2f2"], ratio: 7 },
};

export type Rgb = readonly [number, number, number];

/** sRGB (each channel 0 to 255, not rounded) of an HSL colour: `hue` in degrees, `saturation` and `lightness` in percent (CSS Color 4). */
export function hslToRgb(hue: number, saturation: number, lightness: number): Rgb {
	const s = saturation / 100;
	const l = lightness / 100;
	const h = ((hue % 360) + 360) % 360;
	const a = s * Math.min(l, 1 - l);
	const channel = (n: number): number => {
		const k = (n + h / 30) % 12;
		return (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255;
	};
	return [channel(0), channel(8), channel(4)];
}

/** `#rrggbb` of a colour, each channel rounded. */
export function rgbToHex(rgb: Rgb): string {
	return `#${rgb.map(value => Math.round(Math.min(255, Math.max(0, value))).toString(16).padStart(2, "0")).join("")}`;
}

/** The colour of a `#rrggbb` string. */
export function hexToRgb(hex: string): Rgb {
	const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
	if (match === null) throw new Error(`not a #rrggbb colour: ${hex}`);
	return [parseInt(match[1]!, 16), parseInt(match[2]!, 16), parseInt(match[3]!, 16)];
}

/** WCAG relative luminance of an sRGB colour (channels 0 to 255). */
export function relativeLuminance(rgb: Rgb): number {
	const [r, g, b] = rgb.map(value => {
		const unit = value / 255;
		return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
	}) as [number, number, number];
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio of two colours, from 1 to 21. */
export function contrastRatio(a: Rgb, b: Rgb): number {
	const first = relativeLuminance(a);
	const second = relativeLuminance(b);
	return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

/**
 * The colour of one stop of a gradient on a theme kind, `#rrggbb`: OMP's colour (`hue` at 90 % saturation and 62 % lightness) when
 * that is readable on the kind's surfaces, otherwise the same hue with the lightness moved, the least that makes it so: lighter on
 * a dark kind, darker on a light one. The hue is OMP's, rounded as OMP rounds it, so only the lightness is Chat's.
 */
export function magicStopColour(hue: number, kind: MagicThemeKind): string {
	const { surfaces, ratio } = MAGIC_THEME_DESIGN[kind];
	const backgrounds = surfaces.map(hexToRgb);
	const lighter = kind === "dark" || kind === "high-contrast";
	const readable = (lightness: number): boolean => {
		// The colour that is painted is the one rounded to eight bits per channel, so that is the one that must read.
		const text = hexToRgb(rgbToHex(hslToRgb(hue, MAGIC_TUI_SATURATION, lightness)));
		return backgrounds.every(background => contrastRatio(text, background) >= ratio);
	};
	let lightness = MAGIC_TUI_LIGHTNESS;
	while (!readable(lightness) && lightness > 0 && lightness < 100) lightness += lighter ? 1 : -1;
	return rgbToHex(hslToRgb(hue, MAGIC_TUI_SATURATION, lightness));
}

/** The `MAGIC_GRADIENT_STOPS` colours of a keyword's gradient on a theme kind, in stop order. */
export function magicGradient(keyword: Pick<MagicKeyword, "hue">, kind: MagicThemeKind): string[] {
	return Array.from({ length: MAGIC_GRADIENT_STOPS }, (_, stop) => magicStopColour(magicStopHue(keyword, stop), kind));
}
