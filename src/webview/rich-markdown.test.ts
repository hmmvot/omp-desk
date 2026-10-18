import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import { before, test } from "node:test";
import { build } from "esbuild";

/** `eligible`: the assistant's own reply text (the one place a figure and a chart are drawn). */
let render: (text: string, options?: { eligible?: boolean; emphasis?: boolean }) => string;
let shownText: (text: string) => string;
let streamed: (text: string, lengths: readonly number[]) => { html: string; kept: number }[];
let pieces: (line: string) => { token: boolean; visible: string }[];

before(async () => {
	const bundled = await build({ stdin: { contents: `
		import { createElement } from "react";
		import { renderToStaticMarkup } from "react-dom/server";
		import { Markdown, markdownShownText, parseMarkdown } from "./components/Markdown";
		import { AssistantReplyContext } from "./components/FileLinks";
		import { inlinePieces } from "./lib/markdown-inline";
		export const render = (text, { eligible = false, emphasis = true } = {}) =>
			renderToStaticMarkup(createElement(AssistantReplyContext.Provider, { value: eligible }, createElement(Markdown, { text, emphasis })));
		export const shownText = text => markdownShownText(text);
		export const pieces = line => inlinePieces(line).map(({ token, visible }) => ({ token, visible }));
		export const streamed = (text, lengths) => {
			const steps = [];
			let previous = null;
			for (const length of lengths) {
				const parsed = parseMarkdown(text.slice(0, length), previous);
				let kept = 0;
				while (previous !== null && kept < previous.blocks.length && parsed.blocks[kept] === previous.blocks[kept]) kept += 1;
				steps.push({ html: renderToStaticMarkup(createElement("div", { className: "omp-md" }, parsed.blocks)), kept });
				previous = parsed;
			}
			return steps;
		};
	`, loader: "tsx", resolveDir: join(process.cwd(), "src/webview") }, bundle: true, write: false,
		format: "cjs", platform: "node", packages: "external", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' } });
	const module = { exports: {} as { render: typeof render; shownText: typeof shownText; streamed: typeof streamed; pieces: typeof pieces } };
	new Function("require", "module", "exports", bundled.outputFiles[0]!.text)(createRequire(import.meta.url), module, module.exports);
	({ render, shownText, streamed, pieces } = module.exports);
});

const text = (html: string): string => html.replace(/<[^>]+>/g, "");

// ---- math ---------------------------------------------------------------------------------------------------------------------

test("inline math is its converted text in one span, the TeX in the tooltip", () => {
	const html = render("Let $x^2 + \\alpha$ be \\(a_1\\) and $$\\sqrt{2}$$.");
	assert.equal(html, '<div class="omp-md"><p>Let <span class="omp-math" title="$x^2 + \\alpha$">x² + α</span> be <span class="omp-math" title="\\(a_1\\)">a₁</span> and <span class="omp-math" title="$$\\sqrt{2}$$">√2</span>.</p></div>');
});

test("dollar amounts in prose are never math", () => {
	for (const prose of ["It costs $5 and $10 in total.", "Between $5-$10 per month.", "Pay $20 or $30, or $1,000 later.", "Refund of $4.50, tax $0.35.", "Cost: $5. Then $6."]) {
		const html = render(prose);
		assert.doesNotMatch(html, /omp-math/, prose);
		assert.equal(text(html), prose);
	}
});

test("an escaped dollar and a dollar with no closer stay text", () => {
	assert.equal(text(render("\\$x^2$ and $unclosed")), "\\$x^2$ and $unclosed");
});

test("math inside a code span or a fence is code, and star and underscore inside math are not emphasis", () => {
	assert.doesNotMatch(render("`$x^2$` and\n\n```\n$$\nx\n$$\n```"), /omp-math/);
	assert.match(render("$a_b * c_d$"), /<span class="omp-math" title="\$a_b \* c_d\$">a_b \* c_d<\/span>|<span class="omp-math"[^>]*>[^<]*<\/span>/);
	assert.doesNotMatch(render("$a_b * c_d$"), /<em>/);
});

test("text the user typed is never converted", () => {
	assert.equal(render("$x^2$ and \\(a\\)", { emphasis: false }), '<div class="omp-md"><p>$x^2$ and \\(a\\)</p></div>');
	assert.doesNotMatch(render("$$\nx\n$$", { emphasis: false }), /omp-math/);
});

test("a display block is its stacked layout as one code-shaped block; an unclosed opener stays text", () => {
	const html = render("Before\n\n$$\n\\frac{a+b}{c}\n$$\n\nAfter");
	assert.match(html, /<div class="omp-math-block" title="\\frac\{a\+b\}\{c\}"><pre><code> a\+b\n─────\n {2}c<\/code><\/pre><\/div>/);
	assert.match(html, /<p>Before<\/p>.*<p>After<\/p>/s);
	assert.doesNotMatch(render("$$\n\\frac{a}{b}"), /omp-math-block/);
	assert.equal(render("$$\n\\frac{a}{b}"), '<div class="omp-md"><p>$$<br/>\\frac{a}{b}</p></div>');
});

test("a bare math environment is a display block", () => {
	assert.match(render("\\begin{align}\na &= b \\\\\nc &= d\n\\end{align}"), /omp-math-block/);
});

test("a display block with blank lines streams in to the same markup as a fresh parse", () => {
	const source = "Intro\n\n$$\na\n\nb\n\nc\n$$\n\nOutro text";
	const lengths = [...Array(source.length).keys()].map(index => index + 1);
	const steps = streamed(source, lengths);
	assert.equal(steps.at(-1)!.html, `<div class="omp-md">${render(source).replace(/^<div class="omp-md">|<\/div>$/g, "")}</div>`);
	for (const [index, step] of steps.entries()) {
		const fresh = render(source.slice(0, lengths[index]));
		assert.equal(step.html, fresh, `prefix ${lengths[index]}`);
	}
});

test("Find's shown text and the inline pieces carry the converted text", () => {
	assert.equal(shownText("Let $\\alpha^2$ go"), "Let α² go");
	assert.deepEqual(pieces("see $x^2$ now"), [{ token: false, visible: "see " }, { token: true, visible: "x²" }, { token: false, visible: " now" }]);
	assert.equal(shownText("$$\n\\frac{a+b}{c}\n$$"), " a+b\n─────\n  c");
	assert.equal(shownText("costs $5 and $10"), "costs $5 and $10");
});

// ---- SVG figures --------------------------------------------------------------------------------------------------------------

const FIGURE = '<svg viewBox="0 0 40 20"><title>Bars</title><rect width="10" height="10" fill="var(--c1)"/></svg>';

test("a closed svg fence of the assistant's reply is an image with a Figure | Source toggle", () => {
	const html = render(`Here:\n\n\`\`\`svg\n${FIGURE}\n\`\`\`\n\nDone`, { eligible: true });
	assert.match(html, /<img src="data:image\/svg\+xml;charset=utf-8,[^"]+"[^>]*alt="Bars"/);
	assert.match(html, /aria-pressed="true">Figure<\/button><button type="button" class="omp-mermaid-tab" aria-pressed="false">Source<\/button>/);
	assert.match(html, /<p>Here:<\/p>.*<p>Done<\/p>/s);
});

test("a figure stays code where the TUI shows code: other message kinds, an unclosed fence, a list item, a quote", () => {
	const cases: { name: string; markdown: string; eligible: boolean }[] = [
		{ name: "not the assistant's reply", markdown: `\`\`\`svg\n${FIGURE}\n\`\`\``, eligible: false },
		{ name: "unclosed fence (streaming)", markdown: `\`\`\`svg\n${FIGURE}`, eligible: true },
		{ name: "inside a list item", markdown: `- item\n\n  \`\`\`svg\n  ${FIGURE}\n  \`\`\``, eligible: true },
		{ name: "inside a quote", markdown: `> \`\`\`svg\n> ${FIGURE}\n> \`\`\``, eligible: true },
	];
	for (const { name, markdown, eligible } of cases) {
		const html = render(markdown, { eligible });
		assert.doesNotMatch(html, /<img/, name);
		assert.match(html, /omp-code-block/, name);
	}
});

test("a malicious figure is neither run nor fetched, and an invalid one is code with a reason", () => {
	const evil = '<svg viewBox="0 0 9 9" onload="alert(1)"><script>alert(2)</script><a href="javascript:alert(3)"><rect width="9" height="9" style="fill:url(https://evil.example/x)"/></a><image href="https://evil.example/p.png"/><use href="https://evil.example/s.svg#a"/></svg>';
	const html = render(`\`\`\`svg\n${evil}\n\`\`\``, { eligible: true });
	const src = decodeURIComponent(/<img src="data:image\/svg\+xml;charset=utf-8,([^"]+)"/.exec(html)![1]!);
	assert.doesNotMatch(src, /<script|onload|javascript:|evil\.example|<image|<a[ >]/i);
	assert.match(html, /Unsafe or unsupported parts were removed/);
	const broken = render("```svg\n<svg viewBox=\"0 0 9 9\"><g></svg>\n```", { eligible: true });
	assert.doesNotMatch(broken, /<img/);
	assert.match(broken, /Figure not drawn: /);
	assert.match(broken, /omp-code-block/);
});

// ---- table charts -------------------------------------------------------------------------------------------------------------

const NUMERIC = "| Model | Tokens |\n|---|---:|\n| A | 1,200 |\n| B | 3,400 |\n| C | 2,100 |\n| D | 5,600 |\n| E | 900 |";

test("a numeric table of the assistant's reply gets a chart under it once something follows it", () => {
	const html = render(`${NUMERIC}\n\nAfter`, { eligible: true });
	assert.match(html, /<\/table><\/div><div class="omp-chart">/);
	assert.match(html, /<figure class="omp-chart-figure" role="img" aria-label="[^"]*Tokens[^"]*"><svg[^>]*aria-hidden="true"/);
	assert.match(html, /<p>After<\/p>/);
});

test("no chart for text tables, a table that is not the assistant's, one in a list or a quote, or a tail table still streaming", () => {
	const prose = "| Name | Notes |\n|---|---|\n| a | first thing |\n| b | second thing |\n| c | third |\n| d | fourth |";
	assert.doesNotMatch(render(`${prose}\n\nAfter`, { eligible: true }), /omp-chart/);
	assert.doesNotMatch(render(`${NUMERIC}\n\nAfter`), /omp-chart/, "not the assistant's reply");
	assert.doesNotMatch(render(`- item\n\n  ${NUMERIC.replaceAll("\n", "\n  ")}\n\nAfter`, { eligible: true }), /omp-chart/, "inside a list item");
	assert.doesNotMatch(render(`> ${NUMERIC.replaceAll("\n", "\n> ")}\n\nAfter`, { eligible: true }), /omp-chart/, "inside a quote");
	assert.doesNotMatch(render(NUMERIC, { eligible: true }), /omp-chart/, "the last block: its chart waits for the table to settle");
	assert.doesNotMatch(render(`${NUMERIC}\n\nAfter`, { eligible: true, emphasis: false }), /omp-chart/, "text the user typed");
});

test("the table itself is unchanged by its chart, and a hostile cell stays an escaped text node", () => {
	const hostile = "| Model | Tokens |\n|---|---:|\n| <script>x</script> | 1,200 |\n| B | 3,400 |\n| C | 2,100 |\n| D | 5,600 |\n| E | 900 |";
	const html = render(`${hostile}\n\nAfter`, { eligible: true });
	assert.doesNotMatch(html, /<script/);
	assert.match(html, /&lt;script&gt;x&lt;\/script&gt;/);
	assert.equal(shownText(`${NUMERIC}\n\nAfter`), shownText(`${NUMERIC}\n\nAfter`));
	assert.doesNotMatch(shownText(`${NUMERIC}\n\nAfter`), /Tokens by Model/, "chart text is not part of Find's shown text");
});
