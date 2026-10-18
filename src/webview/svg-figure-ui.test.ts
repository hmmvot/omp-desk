/** The `svg` block of a reply (`components/SvgFigureBlock.tsx`), rendered to markup as the page would render it, with no page theme around it. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import { before, test } from "node:test";
import { build, type Plugin } from "esbuild";

type Render = (source: string, options?: { closed?: boolean; leaf?: number; eligible?: boolean }) => string;

const LONG_REASON = "r".repeat(500);

/** The component bundled for Node; `stubFigure` replaces the sanitizer's module with that source. */
async function load(stubFigure?: string): Promise<Render> {
	const stub: Plugin = {
		name: "figure-stub",
		setup(builder) {
			builder.onResolve({ filter: /svg-figure\.ts$/ }, () => ({ path: "svg-figure-stub", namespace: "figure-stub" }));
			builder.onLoad({ filter: /.*/, namespace: "figure-stub" }, () => ({ contents: stubFigure ?? "", loader: "ts" }));
		},
	};
	const bundled = await build({
		stdin: {
			contents: `
				import { createElement } from "react";
				import { renderToStaticMarkup } from "react-dom/server";
				import { SvgFigureBlock } from "./components/SvgFigureBlock";
				import { AssistantReplyContext } from "./components/FileLinks";
				export const render = (source, { closed = true, leaf, eligible = true } = {}) => {
					const block = createElement(SvgFigureBlock, { source, closed, leaf });
					return renderToStaticMarkup(eligible ? createElement(AssistantReplyContext.Provider, { value: true }, block) : block);
				};
			`,
			loader: "tsx",
			resolveDir: join(process.cwd(), "src/webview"),
		},
		bundle: true, write: false, format: "cjs", platform: "node", packages: "external", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' },
		plugins: stubFigure === undefined ? [] : [stub],
	});
	const module = { exports: {} as { render: Render } };
	new Function("require", "module", "exports", bundled.outputFiles[0]!.text)(createRequire(import.meta.url), module, module.exports);
	return module.exports.render;
}

let render: Render;
let renderWithLongReason: Render;
before(async () => {
	render = await load();
	renderWithLongReason = await load(`export const prepareSvgFigure = () => ({ ok: false, reason: ${JSON.stringify(LONG_REASON)} }); export const svgDataUrl = () => "";`);
});

const CHART = `<svg viewBox="0 0 120 60"><title>Sales by quarter</title><rect x="0" y="0" width="40" height="30" fill="var(--c1)"/><text x="5" y="50" fill="var(--fg)">Q1 &amp; Q2</text></svg>`;

/** The SVG text inside the image's data URL, as the browser would read it. */
function imageSvg(markup: string): string {
	const match = /<img src="(data:image\/svg\+xml;charset=utf-8,[^"]*)"/.exec(markup);
	assert.ok(match, markup);
	const attribute = (match[1] ?? "").replaceAll("&#x27;", "'").replaceAll("&amp;", "&");
	return decodeURIComponent(attribute.slice(attribute.indexOf(",") + 1));
}

test("a user message, a tool result or thinking keeps the plain code block", () => {
	const html = render(CHART, { eligible: false, leaf: 4 });
	assert.match(html, /^<div class="omp-code-block" data-md-leaf="4">/);
	assert.match(html, /<code data-language="svg">/);
	assert.ok(!html.includes("<img") && !html.includes("omp-mermaid"), html);
});

test("a fence that is still open stays code, with nothing said about it", () => {
	const html = render(CHART.slice(0, 40), { closed: false, leaf: 2 });
	assert.match(html, /^<div class="omp-mermaid"><div class="omp-code-block" data-md-leaf="2">/);
	assert.ok(!html.includes("<img") && !html.includes("omp-mermaid-note") && !html.includes("omp-mermaid-bar"), html);
});

test("a complete figure is drawn as an image of its safe, themed SVG, with the toolbar", () => {
	const html = render(CHART, { leaf: 3 });
	assert.match(html, /^<div class="omp-mermaid omp-mermaid--drawn"><div class="omp-figure-frame"><img /);
	assert.match(html, / width="120" height="60" alt="Sales by quarter" draggable="false"\/>/);
	assert.ok(!html.includes("data-md-leaf"), "a drawn figure carries no quote record");
	assert.ok(!html.includes("omp-code-block"), "the code is not shown beside the drawing");
	const svg = imageSvg(html);
	assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="120" height="60" viewBox="0 0 120 60" color="#[0-9a-f]{6}" font-family="[^"]+">/);
	assert.match(svg, /<rect x="0" y="0" width="40" height="30" fill="#[0-9a-f]{6}"\/>/);
	assert.match(svg, /<text x="5" y="50" fill="#[0-9a-f]{6}">Q1 &amp; Q2<\/text>/);
	assert.ok(!svg.includes("var("), svg);
	assert.match(html, /<div class="omp-mermaid-bar" role="toolbar" aria-label="Figure view">/);
	assert.match(html, /<button type="button" class="omp-mermaid-tab" aria-pressed="true">Figure<\/button>/);
	assert.match(html, /<button type="button" class="omp-mermaid-tab" aria-pressed="false">Source<\/button>/);
	assert.match(html, /aria-label="Copy SVG source"/);
	assert.ok(!html.includes("omp-mermaid-note"), "nothing was removed, so nothing is said");
});

test("a figure without a title is described as an SVG figure", () => {
	assert.match(render(`<svg viewBox="0 0 10 10"><rect width="5" height="5"/></svg>`), / alt="SVG figure" /);
});

test("a figure that cannot be drawn is code under one muted line saying why, and keeps its quote record", () => {
	const html = render(`<svg><rect/></svg>`, { leaf: 7 });
	assert.match(html, /^<div class="omp-mermaid"><div class="omp-code-block" data-md-leaf="7">/);
	assert.match(html, /<div class="omp-mermaid-note"><span>Figure not drawn: The figure has no viewBox or size<\/span><\/div><\/div>$/);
	assert.ok(!html.includes("<img"), html);
	assert.match(render(`<svg viewBox="0 0 1 1"><g></svg>`), /Figure not drawn: Mismatched closing tag/);
	assert.match(render(`<!DOCTYPE svg><svg viewBox="0 0 1 1"/>`), /Figure not drawn: The figure has a DOCTYPE or entity declaration/);
});

test("a figure with unsafe parts removed is drawn with a muted note under it", () => {
	const html = render(`<svg viewBox="0 0 10 10" onload="alert(1)"><script>alert(2)</script><rect width="5" height="5"/></svg>`);
	assert.match(html, /<img /);
	assert.match(html, /<div class="omp-mermaid-note"><span>Unsafe or unsupported parts were removed\.<\/span><\/div>/);
	const svg = imageSvg(html);
	assert.ok(!/script|onload/.test(svg), svg);
	assert.ok(!html.includes("Figure not drawn"));
});

test("a long reason is cut to 160 characters", () => {
	const html = renderWithLongReason(CHART);
	const note = /Figure not drawn: (r+)…<\/span>/.exec(html);
	assert.ok(note, html);
	assert.equal(note[1]?.length, 159);
	assert.ok(!html.includes("r".repeat(160)));
});
