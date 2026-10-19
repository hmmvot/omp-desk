import assert from "node:assert/strict";
import { test } from "node:test";
import { figurePaletteFrom } from "./figure-palette.ts";
import {
	HTML_PAGE_MAX_CONTENT_HEIGHT,
	HTML_PAGE_MIN_HEIGHT,
	MAX_HTML_PAGE_CHARS,
	htmlPageMessage,
	htmlPageTheme,
	htmlPageThemeMessage,
	isHtmlPageReady,
	parseHtmlPageSize,
	prepareHtmlPage,
} from "./html-page.ts";
import { mermaidThemeFrom } from "./mermaid-theme.ts";

const mermaid = mermaidThemeFrom(() => "", false);
const theme = htmlPageTheme(mermaid, figurePaletteFrom(mermaid), "Consolas, monospace");

test("a page that cannot be shown says why", () => {
	assert.deepEqual(prepareHtmlPage("  \n"), { ok: false, reason: "The page is empty" });
	const big = prepareHtmlPage("x".repeat(MAX_HTML_PAGE_CHARS + 1));
	assert.equal(big.ok, false);
	assert.match(big.ok ? "" : big.reason, /larger than 200,000 characters/);
	assert.equal(prepareHtmlPage("a\u0000b").ok, false);
	assert.equal(prepareHtmlPage("a\uD800b").ok, false, "an unpaired surrogate");
	assert.equal(prepareHtmlPage("😀").ok, true, "a paired one is text");
	assert.deepEqual(prepareHtmlPage("<p>x</p>"), { ok: true });
});

test("the theme gives the page the figure tokens, the background and the fonts", () => {
	assert.equal(theme.dark, true);
	for (const name of ["--bg", "--fg", "--muted", "--border", "--surface", "--accent", "--success", "--warning", "--error", "--c1", "--c2", "--c3", "--c4", "--c5", "--c6", "--font", "--font-size", "--font-mono"]) {
		assert.ok(typeof theme.variables[name] === "string" && theme.variables[name]!.length > 0, name);
	}
	assert.match(theme.variables["--bg"]!, /^#[0-9a-f]{6}$/i);
});

test("a theme value that could end a declaration is dropped, not sent", () => {
	const hostile = htmlPageTheme({ ...mermaid, fontFamily: "x}</style><script>alert(1)</script>", variables: { ...mermaid.variables, background: "red;}</style>" } }, figurePaletteFrom(mermaid), "a;b");
	assert.equal(hostile.variables["--bg"], undefined);
	for (const value of Object.values(hostile.variables)) assert.match(value, /^[#A-Za-z0-9 ,.'_()%-]+$/);
});

test("the page message carries the source, the scheme and the variables, nothing else", () => {
	assert.deepEqual(htmlPageMessage("<p>x</p>", theme), { ompHtmlPage: "page", html: "<p>x</p>", dark: true, variables: theme.variables });
	assert.deepEqual(Object.keys(htmlPageThemeMessage(theme)).sort(), ["dark", "ompHtmlPage", "variables"]);
});

test("a size report is read only from a frame message and is clamped", () => {
	assert.equal(parseHtmlPageSize({ ompHtmlPage: "size", height: 300.2 }), 301);
	assert.equal(parseHtmlPageSize({ ompHtmlPage: "size", height: 1 }), HTML_PAGE_MIN_HEIGHT);
	assert.equal(parseHtmlPageSize({ ompHtmlPage: "size", height: 1e9 }), HTML_PAGE_MAX_CONTENT_HEIGHT);
	assert.equal(parseHtmlPageSize({ ompHtmlPage: "size", height: 1200 }), 1200, "a tall page's own height is kept: the block decides how much to show");
	for (const data of [null, "size", 3, {}, { ompHtmlPage: "theme", height: 100 }, { ompHtmlPage: "size" }, { ompHtmlPage: "size", height: "100" }, { ompHtmlPage: "size", height: Number.NaN }, { ompHtmlPage: "size", height: Infinity }, { type: "omp:chat-state" }]) {
		assert.equal(parseHtmlPageSize(data), null, JSON.stringify(data));
	}
});

test("only the exact ready report is a ready report", () => {
	assert.equal(isHtmlPageReady({ ompHtmlPage: "ready" }), true);
	for (const data of [null, "ready", {}, { ompHtmlPage: "size", height: 10 }, { ompHtmlPage: "page" }, { type: "omp:ready" }]) assert.equal(isHtmlPageReady(data), false, JSON.stringify(data));
});
