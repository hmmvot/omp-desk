import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MermaidTheme } from "../mermaid/contract.ts";
import { THEMES } from "../theme-ui-fixtures.ts";
import { figurePaletteFrom } from "./figure-palette.ts";
import { mermaidThemeFrom } from "./mermaid-theme.ts";

/** The theme of one captured VS Code theme, with the font variables the page's own document always has. */
function themeOf(name: string): MermaidTheme {
	const captured = THEMES.find(candidate => candidate.name === name);
	assert.ok(captured, name);
	const table: Record<string, string> = { ...captured.tokens, "--vscode-font-family": '"Segoe WPC", "Segoe UI", sans-serif', "--vscode-font-size": "13px" };
	return mermaidThemeFrom(variable => table[variable] ?? "", captured.bodyClass.includes("high-contrast"));
}

const HEX = /^#[0-9a-f]{6}$/;

describe("the palette of a figure", () => {
	it("is made of hex colours and the sanitised font in every captured theme", () => {
		for (const { name } of THEMES) {
			const palette = figurePaletteFrom(themeOf(name));
			for (const [token, value] of Object.entries(palette)) if (token !== "fontFamily") assert.match(value, HEX, `${name}: ${token}`);
			assert.equal(palette.fontFamily, "'Segoe WPC', 'Segoe UI', sans-serif");
		}
	});

	it("takes the text, border and surface colours of the diagram theme in Dark Modern and Light Modern", () => {
		for (const name of ["Dark Modern", "Light Modern"]) {
			const theme = themeOf(name);
			const palette = figurePaletteFrom(theme);
			assert.equal(palette.fg, theme.variables.textColor, name);
			assert.equal(palette.border, theme.variables.nodeBorder, name);
			assert.equal(palette.surface, theme.variables.primaryColor, name);
			assert.notEqual(palette.fg, theme.variables.background, `${name}: text reads on the page`);
			assert.notEqual(palette.border, theme.variables.background, `${name}: border shows`);
		}
		assert.equal(figurePaletteFrom(themeOf("Dark Modern")).fg, "#cccccc");
		assert.equal(figurePaletteFrom(themeOf("Light Modern")).fg, "#3b3b3b");
	});

	it("puts the muted colour between the text and the background, and has six distinct series colours led by the accent", () => {
		for (const name of ["Dark Modern", "Light Modern"]) {
			const theme = themeOf(name);
			const palette = figurePaletteFrom(theme);
			assert.notEqual(palette.muted, palette.fg, name);
			assert.notEqual(palette.muted, theme.variables.background, name);
			const channel = (hex: string): number => Number.parseInt(hex.slice(1, 3), 16);
			const [low, high] = [channel(palette.fg), channel(theme.variables.background ?? "")].sort((a, b) => a - b);
			assert.ok(channel(palette.muted) > (low ?? 0) && channel(palette.muted) < (high ?? 0), `${name}: muted is a mix`);
			const series = [palette.c1, palette.c2, palette.c3, palette.c4, palette.c5, palette.c6];
			assert.equal(new Set(series).size, 6, `${name}: series`);
			assert.equal(palette.accent, palette.c1, name);
			assert.deepEqual(series, ["pie1", "pie2", "pie3", "pie4", "pie5", "pie6"].map(key => theme.variables[key]));
			assert.deepEqual([palette.success, palette.warning, palette.error], [palette.c2, palette.c3, palette.c5], `${name}: green, orange, red`);
		}
	});

	it("differs between a dark and a light theme", () => {
		const dark = figurePaletteFrom(themeOf("Dark Modern"));
		const light = figurePaletteFrom(themeOf("Light Modern"));
		assert.notEqual(dark.fg, light.fg);
		assert.notEqual(dark.surface, light.surface);
		assert.notEqual(dark.c1, light.c1);
	});

	it("tints no surface in a High Contrast theme", () => {
		const theme = themeOf("High Contrast");
		assert.equal(figurePaletteFrom(theme).surface, theme.variables.background);
	});

	it("falls back to the built-in colours where a theme names none", () => {
		const empty: MermaidTheme = { darkMode: true, fontFamily: "sans-serif", fontSize: "13px", reducedMotion: false, variables: { textColor: "not a colour" } };
		const palette = figurePaletteFrom(empty);
		for (const [token, value] of Object.entries(palette)) if (token !== "fontFamily") assert.match(value, HEX, token);
		assert.deepEqual(palette, figurePaletteFrom(mermaidThemeFrom(() => "", false)));
	});
});
