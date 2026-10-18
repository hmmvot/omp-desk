/** The chart under a table (`components/TableChart.tsx`), rendered to static markup the way `markdown.test.ts` renders Markdown. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import { afterEach, before, test } from "node:test";
import { build } from "esbuild";

type Rows = readonly (readonly string[])[];
interface Options {
	readonly followedByContent?: boolean;
	readonly assistant?: boolean;
}
let render: (header: readonly string[], rows: Rows, options?: Options) => string;
let setChartsHidden: (hidden: boolean) => void;
let getChartsHidden: () => boolean;
let settleMs: number;

before(async () => {
	const bundled = await build({
		stdin: {
			contents: `
		import { createElement } from "react";
		import { renderToStaticMarkup } from "react-dom/server";
		import { TableChart, setChartsHidden, getChartsHidden, CHART_SETTLE_MS } from "./components/TableChart";
		import { AssistantReplyContext } from "./components/FileLinks";
		export { setChartsHidden, getChartsHidden };
		export const settleMs = CHART_SETTLE_MS;
		export const render = (header, rows, { followedByContent = true, assistant = true } = {}) =>
			renderToStaticMarkup(createElement(AssistantReplyContext.Provider, { value: assistant }, createElement(TableChart, { header, rows, followedByContent })));
	`,
			loader: "tsx",
			resolveDir: join(process.cwd(), "src/webview"),
		},
		bundle: true,
		write: false,
		format: "cjs",
		platform: "node",
		packages: "external",
		jsx: "automatic",
		define: { "process.env.NODE_ENV": '"production"' },
	});
	const module = { exports: {} as { render: typeof render; setChartsHidden: typeof setChartsHidden; getChartsHidden: typeof getChartsHidden; settleMs: number } };
	new Function("require", "module", "exports", bundled.outputFiles[0]!.text)(createRequire(import.meta.url), module, module.exports);
	({ render, setChartsHidden, getChartsHidden, settleMs } = module.exports);
});

afterEach(() => setChartsHidden(false));

const TOKENS = { header: ["Model", "Tokens"], rows: [["A", "1,200"], ["B", "3,400"], ["C", "2,100"], ["D", "5,600"], ["E", "900"]] } as const;
const count = (html: string, needle: string): number => html.split(needle).length - 1;

test("a table that is followed by content gets its chart at once: an image figure with the description, a hidden SVG, the title and one bar per row", () => {
	const html = render(TOKENS.header, TOKENS.rows);
	assert.match(html, /<figure class="omp-chart-figure" role="img" aria-label="bar chart of Tokens by Model">/);
	assert.match(html, /<svg class="omp-chart-svg" viewBox="0 0 720 \d+(?:\.\d+)?" width="100%" aria-hidden="true" focusable="false">/);
	assert.match(html, /<span class="omp-chart-title">Tokens by Model<\/span>/);
	assert.equal(count(html, '<rect class="omp-chart-bar omp-chart-c1"'), 5);
	assert.match(html, />5,600<\/text>/, "the value is written at the bar's end");
	assert.match(html, /<button type="button" class="omp-chart-toggle" aria-pressed="false">Hide chart<\/button>/);
	assert.equal(html.includes("dangerouslySetInnerHTML") || html.includes("data:image"), false);
});

test("the button toolbar is outside the image figure, so assistive technology still reaches it", () => {
	const html = render(TOKENS.header, TOKENS.rows);
	const figure = html.slice(html.indexOf("<figure"), html.indexOf("</figure>"));
	assert.equal(figure.includes("<button"), false);
	assert.ok(html.indexOf("<button") < html.indexOf("<figure"));
});

test("the last table of a reply is not charted while it may still be streaming: a static render has no chart", () => {
	assert.equal(render(TOKENS.header, TOKENS.rows, { followedByContent: false }), "");
	assert.equal(settleMs, 600);
});

test("a table outside the assistant's reply text gets no chart", () => {
	assert.equal(render(TOKENS.header, TOKENS.rows, { assistant: false }), "");
});

test("a table the planner declines renders nothing, whatever the preference", () => {
	const prose = { header: ["Name", "Notes"], rows: [["a", "x"], ["b", "y"], ["c", "z"], ["d", "w"]] };
	assert.equal(render(prose.header, prose.rows), "");
	setChartsHidden(true);
	assert.equal(render(prose.header, prose.rows), "");
});

test("with charts hidden a charted table shows one muted Show chart button and no drawing", () => {
	setChartsHidden(true);
	assert.equal(getChartsHidden(), true);
	const html = render(TOKENS.header, TOKENS.rows);
	assert.equal(html, '<div class="omp-chart omp-chart-collapsed"><button type="button" class="omp-chart-toggle" aria-pressed="true">Show chart</button></div>');
	setChartsHidden(false);
	assert.equal(getChartsHidden(), false);
	assert.match(render(TOKENS.header, TOKENS.rows), /Hide chart/);
});

test("category names reach the page as text, never as markup", () => {
	const html = render(["Name", "V"], [["<script>alert(1)</script>", "4000"], ["a&b", "10"], ["\"quoted\" 'x'", "300"], ["<img src=x onerror=1>", "20"], ["plain", "5"]]);
	assert.equal(html.includes("<script"), false);
	assert.equal(html.includes("<img"), false);
	assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
	assert.match(html, /a&amp;b/);
	assert.match(html, /&lt;img src=x onerror=1&gt;/);
});

test("a long category is cut with an ellipsis and its full text stays in the tooltip", () => {
	const long = "a very long category name that cannot fit the label";
	const html = render(["Name", "V"], [[long, "4000"], ["b", "10"], ["c", "300"], ["d", "20"], ["e", "5"]]);
	assert.match(html, /<title>a very long category name that cannot fit the label: 4,000<\/title>/);
	assert.match(html, /<text class="omp-chart-label"[^>]*>[^<]*…<\/text>/);
});

test("several series get a legend and no value labels; each series has its colour class", () => {
	const html = render(["Region", "Q1", "Q2"], [["North", "10", "12"], ["South", "20", "25"], ["East", "15", "11"], ["West", "8", "14"], ["Mid", "9", "30"]]);
	assert.equal(count(html, 'class="omp-chart-swatch omp-chart-c1"'), 1);
	assert.equal(count(html, 'class="omp-chart-swatch omp-chart-c2"'), 1);
	assert.equal(count(html, '<rect class="omp-chart-bar omp-chart-c2"'), 5);
	assert.equal(html.includes("omp-chart-value"), false);
	assert.match(html, /aria-label="grouped bar chart of Q1 and Q2 by Region"/);
});

test("a line chart draws one polyline per run of points, a dot for every point and gaps for missing cells", () => {
	const html = render(["Day", "A"], [["Day 1", "1"], ["Day 2", "-"], ["Day 3", "3"], ["Day 4", "7"], ["Day 5", "20"]]);
	assert.match(html, /aria-label="line chart of A by Day"/);
	assert.equal(count(html, "<polyline"), 1, "the first point is alone and has no line");
	assert.equal(count(html, "<circle"), 4);
	assert.equal(count(html, 'class="omp-chart-grid"') > 1, true);
});
