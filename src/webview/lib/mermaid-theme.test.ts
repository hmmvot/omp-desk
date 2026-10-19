import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { THEMES } from "../theme-ui-fixtures.ts";
import { mermaidThemeFrom, mix, parseColor, safeFontFamily, safeFontSize, themeKey, toHex } from "./mermaid-theme.ts";

/** A reader over one captured VS Code theme, with the variables the page's own document always has. */
function reader(name: string): (variable: string) => string {
	const theme = THEMES.find(candidate => candidate.name === name);
	assert.ok(theme, name);
	const table: Record<string, string> = { ...theme.tokens, "--vscode-font-family": '"Segoe WPC", "Segoe UI", sans-serif', "--vscode-font-size": "13px" };
	return variable => table[variable] ?? "";
}

describe("mermaid theme colours", () => {
	it("parses hex and rgb forms and reports the alpha", () => {
		assert.deepEqual(parseColor("#1f1f1f"), { rgb: { r: 31, g: 31, b: 31 }, alpha: 1 });
		assert.deepEqual(parseColor("#fff"), { rgb: { r: 255, g: 255, b: 255 }, alpha: 1 });
		assert.deepEqual(parseColor("rgba(255, 255, 255, 0.7)"), { rgb: { r: 255, g: 255, b: 255 }, alpha: 0.7 });
		assert.equal(parseColor("#00000080")?.alpha.toFixed(2), "0.50");
		assert.equal(parseColor("color-mix(in srgb, red 10%, blue)"), null, "a computed color-mix is not a colour this reader can use");
		assert.equal(parseColor("var(--x)"), null);
		assert.equal(parseColor(""), null);
	});

	it("mixes toward the second colour and prints hex", () => {
		assert.equal(toHex(mix({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 }, 0.5)), "#808080");
		assert.equal(toHex(mix({ r: 10, g: 20, b: 30 }, { r: 200, g: 200, b: 200 }, 0)), "#0a141e");
	});

	it("keeps a font stack and a size to characters that cannot end a declaration", () => {
		assert.equal(safeFontFamily('"Segoe WPC", "Segoe UI", sans-serif'), "'Segoe WPC', 'Segoe UI', sans-serif");
		assert.equal(safeFontFamily("x; } body { background: url(//evil)"), "x body background urlevil");
		assert.equal(safeFontFamily(""), "sans-serif");
		assert.equal(safeFontSize("13px"), "13px");
		assert.equal(safeFontSize("40px"), "20px");
		assert.equal(safeFontSize("nonsense"), "13px");
	});
});

describe("the theme a diagram is drawn in", () => {
	it("is dark in Dark Modern and light in Light Modern, with every variable a hex colour", () => {
		const dark = mermaidThemeFrom(reader("Dark Modern"), false);
		const light = mermaidThemeFrom(reader("Light Modern"), false);
		assert.equal(dark.darkMode, true);
		assert.equal(light.darkMode, false);
		for (const theme of [dark, light]) for (const [name, value] of Object.entries(theme.variables)) assert.match(value, /^(#[0-9a-f]{6}|1)$/, name);
		assert.equal(dark.variables.background, "#1f1f1f");
		assert.equal(dark.variables.textColor, "#cccccc");
		assert.equal(light.variables.background, "#ffffff");
		assert.equal(light.variables.textColor, "#3b3b3b");
		assert.equal(dark.fontFamily, "'Segoe WPC', 'Segoe UI', sans-serif");
		assert.equal(dark.fontSize, "13px");
	});

	it("separates nodes from the background in both, even where the theme's border is nearly the background", () => {
		for (const name of ["Dark Modern", "Light Modern"]) {
			const theme = mermaidThemeFrom(reader(name), false);
			assert.notEqual(theme.variables.primaryColor, theme.variables.background, `${name}: node fill`);
			assert.notEqual(theme.variables.nodeBorder, theme.variables.background, `${name}: node border`);
			assert.notEqual(theme.variables.lineColor, theme.variables.background, `${name}: lines`);
		}
	});

	it("takes a chart hue at full strength when the theme gives it an overlay alpha, as Dark Modern's charts.orange", () => {
		const base = reader("Dark Modern");
		const theme = mermaidThemeFrom(variable => (variable === "--vscode-charts-orange" ? "#EA5C0055" : base(variable)), false);
		const background = parseColor(theme.variables.background!)!.rgb;
		assert.equal(theme.variables.pie3, toHex(mix(background, { r: 0xea, g: 0x5c, b: 0 }, 0.75)));
	});

	it("draws High Contrast on its own background with the theme's contrast border and full-strength lines", () => {
		const theme = mermaidThemeFrom(reader("High Contrast"), true);
		assert.equal(theme.darkMode, true);
		assert.equal(theme.variables.primaryColor, "#000000", "no tinted fill");
		assert.equal(theme.variables.nodeBorder, "#6fc3df", "the contrast border");
		assert.equal(theme.variables.lineColor, "#ffffff");
		const light = mermaidThemeFrom(reader("High Contrast Light"), true);
		assert.equal(light.darkMode, false);
		assert.equal(light.variables.nodeBorder, "#0f4a85");
		assert.equal(light.variables.lineColor, "#292929");
	});

	it("draws a different theme with a different key, and the same theme with the same key", () => {
		const dark = themeKey(mermaidThemeFrom(reader("Dark Modern"), false));
		assert.equal(dark, themeKey(mermaidThemeFrom(reader("Dark Modern"), false)));
		assert.notEqual(dark, themeKey(mermaidThemeFrom(reader("Light Modern"), false)));
		assert.notEqual(dark, themeKey(mermaidThemeFrom(reader("High Contrast"), true)));
	});

	it("falls back to a dark palette when the document defines no theme variable", () => {
		const theme = mermaidThemeFrom(() => "", false);
		assert.equal(theme.darkMode, true);
		assert.equal(theme.variables.background, "#1f1f1f");
		assert.equal(theme.fontFamily, "sans-serif");
		assert.equal(theme.fontSize, "13px");
	});
});
