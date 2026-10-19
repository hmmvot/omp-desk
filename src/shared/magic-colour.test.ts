import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
	contrastRatio,
	hexToRgb,
	hslToRgb,
	MAGIC_THEME_DESIGN,
	MAGIC_THEME_KINDS,
	magicGradient,
	magicStopColour,
	relativeLuminance,
	rgbToHex,
	type MagicThemeKind,
	type Rgb,
} from "./magic-colour.ts";
import { MAGIC_GRADIENT_STOPS, MAGIC_KEYWORDS, MAGIC_TUI_LIGHTNESS, MAGIC_TUI_SATURATION, magicStopHue } from "./magic-keywords.ts";

/** OMP's own painting of the gradient, as `src/omp/magic-keywords-recorder.ts` recorded it from the installed OMP. */
const recording = JSON.parse(readFileSync(new URL("../omp/fixtures/omp-magic-keywords.json", import.meta.url), "utf8")) as {
	gradient: { keywords: { word: string; palette: Rgb[] }[] };
};

describe("colour arithmetic", () => {
	it("converts HSL the way CSS does", () => {
		assert.deepEqual(hslToRgb(0, 100, 50).map(Math.round), [255, 0, 0]);
		assert.deepEqual(hslToRgb(120, 100, 50).map(Math.round), [0, 255, 0]);
		assert.deepEqual(hslToRgb(240, 100, 50).map(Math.round), [0, 0, 255]);
		assert.deepEqual(hslToRgb(60, 100, 50).map(Math.round), [255, 255, 0]);
		assert.deepEqual(hslToRgb(0, 0, 100).map(Math.round), [255, 255, 255]);
		assert.deepEqual(hslToRgb(0, 0, 0).map(Math.round), [0, 0, 0]);
		assert.deepEqual(hslToRgb(120, 100, 25).map(Math.round), [0, 128, 0]);
		assert.deepEqual(hslToRgb(360, 100, 50), hslToRgb(0, 100, 50), "a whole turn is no turn");
		assert.deepEqual(hslToRgb(-120, 100, 50), hslToRgb(240, 100, 50), "a negative hue wraps");
	});

	it("reads and writes #rrggbb", () => {
		assert.equal(rgbToHex([255, 128, 0]), "#ff8000");
		assert.equal(rgbToHex([0.4, 254.6, 300]), "#00ffff", "rounded and kept inside the channel");
		assert.deepEqual(hexToRgb("#3C3c3c"), [60, 60, 60]);
		assert.throws(() => hexToRgb("#fff"), /not a #rrggbb colour/);
	});

	it("measures luminance and contrast as WCAG does", () => {
		assert.equal(relativeLuminance([255, 255, 255]), 1);
		assert.equal(relativeLuminance([0, 0, 0]), 0);
		assert.equal(contrastRatio([255, 255, 255], [0, 0, 0]), 21);
		assert.equal(contrastRatio([0, 0, 0], [255, 255, 255]), 21, "symmetric");
		assert.equal(contrastRatio([119, 119, 119], [119, 119, 119]), 1);
		assert.ok(Math.abs(contrastRatio([119, 119, 119], [255, 255, 255]) - 4.48) < 0.01, "#777 on white is the textbook 4.48:1");
	});

	it("paints each stop of OMP's gradient the colour OMP's terminal paints (the recording of the installed OMP)", () => {
		for (const recorded of recording.gradient.keywords) {
			const keyword = MAGIC_KEYWORDS.find(candidate => candidate.word === recorded.word)!;
			assert.equal(recorded.palette.length, MAGIC_GRADIENT_STOPS);
			recorded.palette.forEach((omp, stop) => {
				const ours = hslToRgb(magicStopHue(keyword, stop), MAGIC_TUI_SATURATION, MAGIC_TUI_LIGHTNESS);
				assert.ok(ours.every((channel, index) => Math.abs(channel - omp[index]!) <= 1), `${recorded.word} stop ${stop}: OMP ${JSON.stringify(omp)}, ours ${JSON.stringify(ours.map(Math.round))}`);
			});
		}
	});
});

describe("the gradient on a theme", () => {
	const against = (colour: string, kind: MagicThemeKind): number[] => MAGIC_THEME_DESIGN[kind].surfaces.map(surface => contrastRatio(hexToRgb(colour), hexToRgb(surface)));

	it("keeps every hue readable on every surface its theme kind is designed against: 4.5:1, 7:1 in high contrast", () => {
		assert.deepEqual(MAGIC_THEME_KINDS.map(kind => MAGIC_THEME_DESIGN[kind].ratio), [4.5, 4.5, 7, 7]);
		for (const kind of MAGIC_THEME_KINDS) {
			for (let hue = 0; hue <= 360; hue++) {
				const colour = magicStopColour(hue, kind);
				for (const ratio of against(colour, kind)) assert.ok(ratio >= MAGIC_THEME_DESIGN[kind].ratio, `${kind} hue ${hue}: ${colour} is ${ratio.toFixed(2)}:1`);
			}
		}
	});

	it("keeps OMP's hue and OMP's colour where it already reads, and moves only the lightness otherwise: up on a dark theme, down on a light one", () => {
		// Green at 62 % lightness is bright enough for a dark surface already.
		assert.equal(magicStopColour(120, "dark"), rgbToHex(hslToRgb(120, MAGIC_TUI_SATURATION, MAGIC_TUI_LIGHTNESS)));
		for (const [kind, direction] of [["dark", 1], ["high-contrast", 1], ["light", -1], ["high-contrast-light", -1]] as const) {
			for (const hue of [0, 45, 120, 200, 240, 300]) {
				const colour = hexToRgb(magicStopColour(hue, kind));
				const tui = hslToRgb(hue, MAGIC_TUI_SATURATION, MAGIC_TUI_LIGHTNESS);
				const luminanceChange = relativeLuminance(colour) - relativeLuminance(tui);
				assert.ok(direction * luminanceChange >= -0.002, `${kind} hue ${hue} moved the wrong way`);
				// The hue survives rounding to eight bits per channel.
				const [r, g, b] = colour;
				const max = Math.max(r, g, b);
				const min = Math.min(r, g, b);
				const delta = max - min;
				const measured = delta === 0 ? 0 : ((max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4) * 60 + 360) % 360;
				assert.ok(Math.min(Math.abs(measured - hue), 360 - Math.abs(measured - hue)) <= 3, `${kind} hue ${hue} became ${measured.toFixed(1)}`);
			}
		}
	});

	it("moves the lightness the least that works", () => {
		for (const kind of MAGIC_THEME_KINDS) {
			for (const hue of [0, 30, 60, 150, 210, 240, 300, 330]) {
				const shown = magicStopColour(hue, kind);
				const tui = rgbToHex(hslToRgb(hue, MAGIC_TUI_SATURATION, MAGIC_TUI_LIGHTNESS));
				if (shown === tui) continue;
				// One percent of lightness back towards OMP's colour fails the test the solver applies.
				const [h, s, l] = [hue, MAGIC_TUI_SATURATION, (kind === "dark" || kind === "high-contrast" ? 1 : -1)];
				let lightness = MAGIC_TUI_LIGHTNESS;
				while (rgbToHex(hslToRgb(h, s, lightness)) !== shown) lightness += l;
				const stepBack = hexToRgb(rgbToHex(hslToRgb(h, s, lightness - l)));
				assert.ok(MAGIC_THEME_DESIGN[kind].surfaces.some(surface => contrastRatio(stepBack, hexToRgb(surface)) < MAGIC_THEME_DESIGN[kind].ratio), `${kind} hue ${hue}: one step less would also have read`);
			}
		}
	});

	it("gives a keyword one colour per stop, on the hue its stop has", () => {
		const ultrathink = MAGIC_KEYWORDS[0]!;
		for (const kind of MAGIC_THEME_KINDS) {
			const gradient = magicGradient(ultrathink, kind);
			assert.equal(gradient.length, MAGIC_GRADIENT_STOPS);
			gradient.forEach((colour, stop) => assert.equal(colour, magicStopColour(magicStopHue(ultrathink, stop), kind)));
			assert.equal(new Set(gradient).size, MAGIC_GRADIENT_STOPS, "no two stops of one sweep share a colour");
		}
	});

	it("pins the palette of one keyword per theme kind, so a changed solver shows in review", () => {
		const ultrathink = MAGIC_KEYWORDS[0]!;
		assert.deepEqual(magicGradient(ultrathink, "dark").slice(0, 4), ["#f98686", "#f58d47", "#f5d047", "#d5f547"]);
		assert.deepEqual(magicGradient(ultrathink, "light").slice(0, 4), ["#c20a0a", "#9b4308", "#745c06", "#546605"]);
		assert.deepEqual(magicGradient(ultrathink, "high-contrast").slice(0, 2), ["#f88181", "#f58d47"]);
		assert.deepEqual(magicGradient(ultrathink, "high-contrast-light").slice(0, 2), ["#a50909", "#883b07"]);
	});
});
