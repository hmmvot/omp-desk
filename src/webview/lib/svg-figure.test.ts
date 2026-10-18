import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { prepareSvgFigure, svgDataUrl, type FigurePalette, type PreparedFigure } from "./svg-figure.ts";

const PALETTE: FigurePalette = {
	fg: "#111111", muted: "#222222", border: "#333333", accent: "#444444", success: "#555555", warning: "#666666", error: "#777777", surface: "#888888",
	c1: "#aa0000", c2: "#00aa00", c3: "#0000aa", c4: "#a0a000", c5: "#a000a0", c6: "#00a0a0", fontFamily: "'Segoe UI', sans-serif",
};

const prepare = (source: string): PreparedFigure => prepareSvgFigure(source, PALETTE);

/** The root start tag the sanitizer writes for a figure of this size and viewBox, with `extra` before the defaults. */
const rootTag = (width: number, height: number, viewBox: string, extra = "", xlink = false): string =>
	`<svg xmlns="http://www.w3.org/2000/svg"${xlink ? ' xmlns:xlink="http://www.w3.org/1999/xlink"' : ""} width="${width}" height="${height}" viewBox="${viewBox}"${extra} color="#111111" font-family="'Segoe UI', sans-serif">`;
const figure = (inner: string, viewBox = "0 0 10 10"): string => `${rootTag(10, 10, viewBox)}${inner}</svg>`;
const BARE = `${rootTag(10, 10, "0 0 10 10").slice(0, -1)}/>`;

function drawn(source: string): Extract<PreparedFigure, { ok: true }> {
	const result = prepare(source);
	assert.ok(result.ok, result.ok ? "" : result.reason);
	return result;
}

function refused(source: string): string {
	const result = prepare(source);
	assert.equal(result.ok, false, "refused");
	return result.ok ? "" : result.reason;
}

/** What no output may hold, whatever the input was. */
function assertClean(svg: string): void {
	for (const needle of ["<script", "onload", "onclick", "javascript:", "foreignobject", "<!", "<iframe", "<image", "<animate", "<set"]) assert.ok(!svg.toLowerCase().includes(needle), `${needle} in ${svg}`);
	assert.doesNotMatch(svg, /\son\w+\s*=/i);
	assert.doesNotMatch(svg, /(?:href|src)\s*=\s*"(?!#)/i, "an external href");
	assert.doesNotMatch(svg, /url\((?!#)/i, "an external url()");
	assert.doesNotMatch(svg, /https?:\/\/(?!www\.w3\.org\/)/, "an external address");
}

/** A malicious source: its output is exactly `expected`, flagged as stripped, and clean. */
function sanitizedTo(source: string, expected: string): void {
	const result = drawn(source);
	assert.equal(result.svg, expected);
	assert.equal(result.stripped, true);
	assertClean(result.svg);
}

describe("a valid figure", () => {
	it("gets its theme tokens, root attributes and size from the viewBox", () => {
		const result = drawn(`<svg viewBox="0 0 400 200"><title>Revenue</title><rect x="0" y="0" width="40" height="20" fill="var(--c1)" stroke="var(--border)"/><text x="5" y="5" fill="var(--fg)" style="fill: var(--muted); stroke: var(--c2, red)">Hi &amp; bye</text></svg>`);
		assert.deepEqual(result, {
			ok: true,
			svg: `${rootTag(400, 200, "0 0 400 200")}<title>Revenue</title><rect x="0" y="0" width="40" height="20" fill="#aa0000" stroke="#333333"/><text x="5" y="5" fill="#111111" style="fill: #222222;stroke: #00aa00;">Hi &amp; bye</text></svg>`,
			width: 400,
			height: 200,
			title: "Revenue",
			stripped: false,
		});
	});

	it("resolves an unknown token to its fallback, else to the text colour, wherever it is written", () => {
		const result = drawn(`<svg viewBox="0 0 10 10"><rect fill="var(--nope, #123456)" stroke="var(--nope)" stop-color="VAR( --c3 )" color="var(--nope, rgb(1, 2, 3))" opacity="var(--a, var(--b, var(--c6)))"/><style>rect { fill: var(--accent); } g { stroke: var(--zzz, rgb(9,9,9)); }</style></svg>`);
		assert.equal(result.svg, figure(`<rect fill="#123456" stroke="#111111" stop-color="#0000aa" color="rgb(1, 2, 3)" opacity="#00a0a0"/><style>rect{fill: #444444;}g{stroke: rgb(9,9,9);}</style>`));
		assert.equal(result.stripped, false);
	});

	it("takes its size from a unitless or pixel width and height when it has no viewBox, and drops other root sizes", () => {
		assert.deepEqual(drawn(`<svg width="300" height="150px"><rect/></svg>`), { ok: true, svg: `${rootTag(300, 150, "0 0 300 150")}<rect/></svg>`, width: 300, height: 150, title: "", stripped: false });
		const percent = drawn(`<svg width="100%" height="auto" viewBox="0 0 20 10"/>`);
		assert.equal(percent.svg, `${rootTag(20, 10, "0 0 20 10").slice(0, -1)}/>`);
		assert.deepEqual([percent.width, percent.height], [20, 10]);
	});

	it("uses the viewBox over a width and height that disagree, and keeps its origin and a comma form", () => {
		const result = drawn(`<svg width="900" height="900" viewBox="-5,-5,100,50"/>`);
		assert.equal(result.svg, `${rootTag(100, 50, "-5 -5 100 50").slice(0, -1)}/>`);
		assert.deepEqual([result.width, result.height], [100, 50]);
	});

	it("scales an oversized figure down to 4096 on the longer edge and never scales one up", () => {
		const wide = drawn(`<svg viewBox="0 0 10000 5000"/>`);
		assert.deepEqual([wide.width, wide.height], [4096, 2048]);
		assert.ok(wide.svg.includes('width="4096" height="2048" viewBox="0 0 10000 5000"'));
		const tall = drawn(`<svg viewBox="0 0 100 40960"/>`);
		assert.deepEqual([tall.width, tall.height], [10, 4096]);
		const thin = drawn(`<svg viewBox="0 0 50000 1"/>`);
		assert.deepEqual([thin.width, thin.height], [4096, 1]);
		const small = drawn(`<svg viewBox="0 0 3 2"/>`);
		assert.deepEqual([small.width, small.height], [3, 2]);
	});

	it("keeps its own color and font-family, adds xmlns:xlink when xlink is used, and rebuilds the namespaces", () => {
		const result = drawn(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10" color="red" font-family="serif"><defs><circle id="a" r="1"/></defs><use xlink:href="#a"/></svg>`);
		assert.equal(result.svg, `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="10" height="10" viewBox="0 0 10 10" color="red" font-family="serif"><defs><circle id="a" r="1"/></defs><use xlink:href="#a"/></svg>`);
		assert.equal(result.stripped, false, "the standard namespace declarations are not an unsafe part");
	});

	it("accepts an XML declaration, comments, a BOM and whitespace around the root, and CDATA and numeric references in text", () => {
		const result = drawn(`\uFEFF<?xml version="1.0" encoding="UTF-8"?>\n<!-- a chart -->\n<svg viewBox="0 0 10 10"><!-- inside --><text><![CDATA[a < b]]> &#65;&#x42; &#x1F600; &lt;&gt;&quot;&apos;</text></svg>\n<!-- after -->\n`);
		assert.equal(result.svg, figure("<text>a &lt; b AB \u{1F600} &lt;&gt;\"'</text>"));
		assert.equal(result.stripped, false);
	});

	it("takes the alt text from the root's own title only, collapsed and capped", () => {
		assert.equal(drawn(`<svg viewBox="0 0 1 1"><g><title>Inner</title></g><title>  Two\n lines  </title></svg>`).title, "Two lines");
		assert.equal(drawn(`<svg viewBox="0 0 1 1"><g><title>Inner</title></g></svg>`).title, "");
		assert.equal(drawn(`<svg viewBox="0 0 1 1"><title>${"x".repeat(500)}</title></svg>`).title.length, 120);
	});

	it("keeps local url() references and same-document hrefs", () => {
		const result = drawn(`<svg viewBox="0 0 10 10"><defs><linearGradient id="g"><stop offset="0" stop-color="var(--c1)"/></linearGradient><clipPath id="c"><rect/></clipPath></defs><rect fill="url( '#g' )" clip-path="url(#c)" style="stroke:url(#g)"/><use href=" #c "/></svg>`);
		assert.equal(result.svg, figure(`<defs><linearGradient id="g"><stop offset="0" stop-color="#aa0000"/></linearGradient><clipPath id="c"><rect/></clipPath></defs><rect fill="url(#g)" clip-path="url(#c)" style="stroke:url(#g);"/><use href="#c"/>`));
		assert.equal(result.stripped, false);
	});

	it("drops whitespace-only text between structural elements and keeps it in text", () => {
		const result = drawn(`<svg viewBox="0 0 10 10">\n  <g>\n    <text> a  b </text>\n  </g>\n</svg>`);
		assert.equal(result.svg, figure(`<g><text> a  b </text></g>`));
	});
});

describe("HTML entity names models write in SVG text", () => {
	it("are decoded, and re-escaped on output", () => {
		const result = drawn(`<svg viewBox="0 0 10 10"><text>a&nbsp;b &mdash; c &times; d</text></svg>`);
		assert.match(result.svg, /a\u00a0b \u2014 c \u00d7 d/);
		assert.doesNotMatch(result.svg, /&nbsp;|&mdash;/);
	});
});

describe("a source that is not a figure", () => {
	it("is refused with a reason when it is not one well-formed svg element", () => {
		assert.match(refused(""), /empty/);
		assert.match(refused("  \n "), /empty/);
		assert.match(refused("<!-- nothing -->"), /no svg element/);
		assert.match(refused(`<svg viewBox="0 0 1 1"><g></svg>`), /Mismatched closing tag <\/svg> \(expected <\/g>\)/);
		assert.match(refused(`<svg viewBox="0 0 1 1"><g>`), /Unclosed tag <g>/);
		assert.match(refused(`<svg viewBox="0 0 1 1"></svg></svg>`), /Unexpected closing tag/);
		assert.match(refused(`<svg viewBox="0 0 1 1" viewBox="0 0 2 2"/>`), /Duplicate attribute viewBox/);
		assert.match(refused(`<svg viewBox="0 0 1 1"/> trailing`), /text after the svg/);
		assert.match(refused(`leading <svg viewBox="0 0 1 1"/>`), /text before the svg/);
		assert.match(refused(`<svg viewBox="0 0 1 1"/><svg viewBox="0 0 1 1"/>`), /exactly one svg/);
		assert.match(refused(`<g/>`), /not <svg>/);
		assert.match(refused(`<svg:svg viewBox="0 0 1 1"/>`), /not <svg>/);
		assert.match(refused(`<svg viewBox="0 0 1 1" a=b/>`), /not quoted/);
		assert.match(refused(`<svg viewBox="0 0 1 1" a/>`), /no value/);
		assert.match(refused(`<svg viewBox="0 0 1 1" a="x/>`), /Unclosed value/);
		assert.match(refused(`<svg viewBox="0 0 1 1"`), /Unclosed tag/);
		assert.match(refused(`<svg viewBox="0 0 1 1"><text>a < b</text></svg>`), /malformed tag/i);
		assert.match(refused(`<svg viewBox="0 0 1 1"><text>a & b</text></svg>`), /entity/);
		assert.match(refused(`<svg viewBox="0 0 1 1"><text>&bogus;</text></svg>`), /entity/);
		assert.match(refused(`<svg viewBox="0 0 1 1"><text>&lt;!DOCTYPE;</text><text>&custom;</text></svg>`), /entity/);
		assert.match(refused(`<svg viewBox="0 0 1 1"><text>&#0;</text></svg>`), /character reference/);
		assert.match(refused(`<svg viewBox="0 0 1 1"><text>&#xD800;</text></svg>`), /character reference/);
		assert.match(refused(`<svg viewBox="0 0 1 1"><text>\u0001</text></svg>`), /character XML does not allow/);
		assert.match(refused(`<svg viewBox="0 0 1 1"><!-- open`), /unclosed comment/);
		assert.match(refused(`<svg viewBox="0 0 1 1"><![CDATA[ open`), /CDATA/);
		assert.match(refused(`<svg viewBox="0 0 1 1"/><?xml-stylesheet href="https://evil/s.css"?>`), /processing instruction/);
		assert.match(refused(`<?xml-stylesheet href="https://evil/s.css"?><svg viewBox="0 0 1 1"/>`), /processing instruction/);
		assert.match(refused(`<svg viewBox="0 0 1 1"><svg:g/ ></svg>`), /malformed tag/i);
		assert.match(refused(`<svg viewBox="0 0 1 1"><é/></svg>`), /malformed tag/i);
	});

	it("is refused without a viewBox or a pixel size, and with a viewBox that cannot be drawn", () => {
		assert.equal(refused(`<svg><rect width="1" height="1"/></svg>`), "The figure has no viewBox or size");
		assert.equal(refused(`<svg width="100"/>`), "The figure has no viewBox or size");
		assert.equal(refused(`<svg width="10em" height="5em"/>`), "The figure has no viewBox or size");
		assert.equal(refused(`<svg width="100%" height="100%"/>`), "The figure has no viewBox or size");
		for (const box of ["0 0 0 10", "0 0 10 0", "0 0 -5 10", "0 0 10 -5", "0 0 NaN 1", "0 0 1e999 10", "0 0 10", "0 0 1 1 1", "a b c d", "", "0 0 0x10 1"]) {
			assert.equal(prepare(`<svg viewBox="${box}"/>`).ok, false, `viewBox "${box}"`);
		}
		assert.equal(refused(`<svg width="0" height="10"/>`), "The figure's viewBox is empty");
	});

	it("is refused when it holds a DOCTYPE or an entity declaration, including a billion-laughs payload", () => {
		const lol = `<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;"><!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">]><svg viewBox="0 0 10 10"><text>&lol3;</text></svg>`;
		assert.match(refused(lol), /DOCTYPE or entity/);
		assert.match(refused(`<svg viewBox="0 0 10 10"><!ENTITY a "b"></svg>`), /DOCTYPE or entity/);
		assert.match(refused(`<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "https://evil/x.dtd"><svg viewBox="0 0 10 10"/>`), /DOCTYPE or entity/);
		assert.match(refused(`<svg viewBox="0 0 10 10"><text>&lol;</text></svg>`), /entity/);
	});

	it("is refused above the limits of size, element count and depth", () => {
		assert.match(refused(`<svg viewBox="0 0 10 10">${"<g/>".repeat(6_000)}</svg>`), /more than 6000 elements/);
		assert.equal(prepare(`<svg viewBox="0 0 10 10">${"<g/>".repeat(5_999)}</svg>`).ok, true);
		const nested = (levels: number): string => `<svg viewBox="0 0 10 10">${"<g>".repeat(levels - 1)}${"</g>".repeat(levels - 1)}</svg>`;
		assert.equal(prepare(nested(40)).ok, true, "forty levels, the root included");
		assert.match(refused(nested(41)), /deeper than 40 levels/);
		assert.match(refused(`<svg viewBox="0 0 10 10">${"x".repeat(400_000)}</svg>`), /larger than 400,000 characters/);
		assert.equal(prepare(`<svg viewBox="0 0 10 10"><text>${"x".repeat(399_000)}</text></svg>`).ok, true);
	});

	it("is refused when its use elements lead back to themselves or expand beyond a bound", () => {
		assert.match(refused(`<svg viewBox="0 0 10 10"><g id="a"><use href="#a"/></g></svg>`), /refers back to itself/);
		assert.match(refused(`<svg viewBox="0 0 10 10"><use id="a" href="#b"/><use id="b" href="#a"/></svg>`), /refers back to itself/);
		// Each level draws the next one twice: 2^30 shapes from sixty elements.
		let bomb = `<g id="l0"><rect width="1" height="1"/></g>`;
		for (let level = 1; level <= 30; level++) bomb += `<g id="l${level}"><use href="#l${level - 1}"/><use href="#l${level - 1}"/></g>`;
		assert.match(refused(`<svg viewBox="0 0 10 10"><defs>${bomb}</defs><use href="#l30"/></svg>`), /expand to too many shapes/);
		const modest = drawn(`<svg viewBox="0 0 10 10"><defs><circle id="d" r="1"/></defs><use href="#d"/><use href="#d" x="3"/></svg>`);
		assert.equal(modest.stripped, false);
	});
});

describe("a malicious figure", () => {
	it("loses a script element and its content", () => {
		sanitizedTo(`<svg viewBox="0 0 10 10"><script>alert(1)</script><rect width="1" height="1"/><script type="text/javascript"><![CDATA[ alert(2) ]]></script></svg>`, figure(`<rect width="1" height="1"/>`));
	});

	it("loses an event handler on the root and on any element, whatever its case", () => {
		sanitizedTo(`<svg viewBox="0 0 10 10" onload="alert(1)"/>`, BARE);
		sanitizedTo(`<svg viewBox="0 0 10 10"><rect onclick="alert(1)" ONMOUSEOVER="x()" width="1"/></svg>`, figure(`<rect width="1"/>`));
	});

	it("loses a link element with its content, including a javascript: href", () => {
		sanitizedTo(`<svg viewBox="0 0 10 10"><a href="javascript:alert(1)"><text>click</text></a><rect/></svg>`, figure(`<rect/>`));
		sanitizedTo(`<svg viewBox="0 0 10 10"><a xlink:href="https://evil/x"><rect/></a></svg>`, BARE);
	});

	it("loses an external use reference but keeps the element", () => {
		sanitizedTo(`<svg viewBox="0 0 10 10"><use href="https://evil/x.svg#a"/><use xlink:href="//evil/x.svg#a"/></svg>`, figure(`<use/><use/>`));
	});

	it("loses an image element, whatever it points at", () => {
		sanitizedTo(`<svg viewBox="0 0 10 10"><image href="https://evil/p.png"/><image href="data:image/png;base64,AAAA"/><feImage href="https://evil/p.png"/></svg>`, BARE);
	});

	it("loses a style declaration that points outside the document, and the attribute when nothing is left", () => {
		sanitizedTo(`<svg viewBox="0 0 10 10"><rect style="fill:url(https://evil/x)"/><rect style="fill:red; stroke:url(&quot;https://evil/y&quot;); opacity:.5"/></svg>`, figure(`<rect/><rect style="fill:red;opacity:.5;"/>`));
		sanitizedTo(`<svg viewBox="0 0 10 10"><rect fill="url(https://evil/x)" stroke="url(data:image/svg+xml,%3Csvg/%3E)" mask="url(#ok)"/></svg>`, figure(`<rect mask="url(#ok)"/>`));
	});

	it("loses an @import and an external url in a style element, keeping the other rules", () => {
		sanitizedTo(`<svg viewBox="0 0 10 10"><style>@import url(https://evil/c.css);</style></svg>`, figure(`<style/>`));
		sanitizedTo(`<svg viewBox="0 0 10 10"><style>@import "https://evil/c.css"; rect { fill: red; background: url(//evil/b.png); stroke: blue } a[href^="javascript:"] { fill: green } @media (min-width: 1px) { g { fill: var(--c1); filter: url(#f) } }</style></svg>`, figure(`<style>rect{fill: red;stroke: blue;}@media (min-width: 1px){g{fill: #aa0000;filter: url(#f);}}</style>`));
		sanitizedTo(`<svg viewBox="0 0 10 10"><style>rect{fill:red;behavior:url(x.htc);width:expression(alert(1));-moz-binding:url(x.xml#b);background:image-set("https://evil/i.png" 1x);fill:\\75rl(https://evil/z)}</style></svg>`, figure(`<style>rect{fill:red;}</style>`));
	});

	it("loses a style that hides its words in CSS escapes or comments", () => {
		sanitizedTo(`<svg viewBox="0 0 10 10"><rect style="fill:\\75 rl(https://evil/x); stroke:ur/**/l(https://evil/y); opacity:.5"/></svg>`, figure(`<rect style="opacity:.5;"/>`));
	});

	it("loses a foreignObject and the HTML inside it", () => {
		sanitizedTo(`<svg viewBox="0 0 10 10"><foreignObject width="10" height="10"><iframe src="https://evil/"/><div xmlns="http://www.w3.org/1999/xhtml"><script>alert(1)</script></div></foreignObject><rect/></svg>`, figure(`<rect/>`));
		sanitizedTo(`<svg viewBox="0 0 10 10"><foreignObject><iframe/></foreignObject></svg>`, BARE);
	});

	it("loses animation elements, including one that rewrites an href", () => {
		sanitizedTo(`<svg viewBox="0 0 10 10"><a><animate attributeName="href" to="javascript:alert(1)"/></a><rect><set attributeName="onclick" to="alert(1)"/><animate attributeName="x" to="5"/><animateTransform attributeName="transform" type="rotate" to="90"/></rect></svg>`, figure(`<rect/>`));
	});

	it("sees a javascript: scheme however it is spelled with character references", () => {
		sanitizedTo(`<svg viewBox="0 0 10 10"><use href="&#106;avascript:alert(1)"/><use xlink:href="&#x6A;&#97;vascript&#58;alert(1)"/><rect fill="&#106;avascript:x" style="fill:&#106;avascript:x"/><a href="&#106;avascript:alert(1)"><rect/></a></svg>`, figure(`<use/><use/><rect/>`));
		// As text it is harmless; its colon is written as a reference so that the output holds none.
		const text = drawn(`<svg viewBox="0 0 10 10"><text>&#106;avascript:alert(1) and javascript:x</text></svg>`);
		assert.equal(text.svg, figure(`<text>javascript&#58;alert(1) and javascript&#58;x</text>`));
		assertClean(text.svg);
	});

	it("writes a value with quotes, angle brackets, ampersands and line breaks back escaped", () => {
		const result = drawn(`<svg viewBox="0 0 10 10"><text data-a='say "hi" &lt;b&gt; &amp; more' data-b="a<b" data-c="x&#10;y&#9;z">1 &lt; 2 &amp;&amp; 3 &gt; 2 &lt;/text&gt;&lt;script&gt;</text></svg>`);
		assert.equal(result.svg, figure(`<text data-a="say &quot;hi&quot; &lt;b&gt; &amp; more" data-b="a&lt;b" data-c="x&#10;y&#9;z">1 &lt; 2 &amp;&amp; 3 &gt; 2 &lt;/text&gt;&lt;script&gt;</text>`));
		assertClean(result.svg);
		assert.equal(result.stripped, false);
	});

	it("loses prefixed elements and attributes, namespace redefinitions, and xlink:href that is not a same-document reference", () => {
		sanitizedTo(`<svg viewBox="0 0 10 10"><svg:script>alert(1)</svg:script><svg:rect width="1"/><rect/></svg>`, figure(`<rect/>`));
		sanitizedTo(`<svg viewBox="0 0 10 10"><g xmlns="http://www.w3.org/1999/xhtml"><rect/></g><g xmlns:x="http://evil/ns" x:onload="alert(1)" evil:thing="1"/></svg>`, figure(`<g><rect/></g><g/>`));
		sanitizedTo(`<svg xmlns="http://evil/ns" xmlns:xlink="http://evil/xlink" viewBox="0 0 10 10"/>`, BARE);
		sanitizedTo(`<svg viewBox="0 0 10 10"><use xlink:href="data:text/html,&lt;script&gt;alert(1)&lt;/script&gt;"/><use xlink:href="#ok"/></svg>`, `${rootTag(10, 10, "0 0 10 10", "", true)}<use/><use xlink:href="#ok"/></svg>`);
	});

	it("loses CDATA in a style element the same way as plain text", () => {
		sanitizedTo(`<svg viewBox="0 0 10 10"><style><![CDATA[ @import url(https://evil/c.css); rect > g { fill: red; } .x { background: url("https://evil/x") } ]]></style></svg>`, figure(`<style>rect &gt; g{fill: red;}.x{}</style>`));
		assertClean(drawn(`<svg viewBox="0 0 10 10"><style><![CDATA[</style><script>alert(1)</script>]]></style></svg>`).svg);
	});

	it("keeps markup that CDATA hides from the reader as inert, escaped text", () => {
		const result = drawn(`<svg viewBox="0 0 10 10"><text><![CDATA[</text><script>alert(1)</script><text>]]></text></svg>`);
		assert.equal(result.svg, figure(`<text>&lt;/text&gt;&lt;script&gt;alert(1)&lt;/script&gt;&lt;text&gt;</text>`));
		assertClean(result.svg);
	});

	it("handles a 2 MB source, 10 000 nested groups and 100 000 attributes without hanging", () => {
		const started = performance.now();
		assert.match(refused(`<svg viewBox="0 0 10 10">${"<script>alert(1)</script>".repeat(80_000)}</svg>`), /larger than/);
		assert.match(refused(`<svg viewBox="0 0 10 10">${"<g>".repeat(10_000)}${"</g>".repeat(10_000)}</svg>`), /deeper than 40/);
		assert.match(refused(`<svg viewBox="0 0 10 10">${"<g>".repeat(10_000)}`), /deeper than 40/);
		let attributes = "";
		for (let at = 0; at < 100_000; at++) attributes += ` a${at}="1"`;
		assert.match(refused(`<svg viewBox="0 0 10 10"${attributes}/>`), /larger than/);
		assert.match(refused(`<svg viewBox="0 0 10 10"${attributes.slice(0, 40)}${" b=\"1\"".repeat(100_000)}/>`), /Duplicate attribute|larger than/);
		assert.ok(performance.now() - started < 5_000, "refused quickly");
	});

	it("handles tens of thousands of attributes that fit the size limit, linearly", () => {
		let attributes = "";
		for (let at = 0; at < 30_000; at++) attributes += ` a${at}="1"`;
		const started = performance.now();
		const result = drawn(`<svg viewBox="0 0 10 10"><g${attributes} onclick="x()"/></svg>`);
		assert.ok(performance.now() - started < 5_000);
		assert.equal(result.stripped, true);
		assertClean(result.svg);
	});

	it("never reports ok with an unsafe string, over a catalogue of hostile fragments", () => {
		const fragments = [
			`<script/>`, `<script>1</script>`, `<a href="javascript:1"><text>x</text></a>`, `<use href="https://evil/x"/>`, `<image href="x"/>`, `<foreignObject/>`, `<iframe/>`, `<animate/>`, `<set/>`,
			`<g onclick="1"/>`, `<rect style="fill:url(//evil)"/>`, `<style>@import "x";</style>`, `<rect fill="url(http://evil/x)"/>`, `<text>&lt;script&gt;</text>`, `<html:body xmlns:html="http://www.w3.org/1999/xhtml"/>`,
			`<switch><foreignObject/></switch>`, `<view/>`, `<metadata><x/></metadata>`, `<g xml:base="https://evil/"/>`, `<rect href="javascript:1"/>`, `<text onload="1">a</text>`,
		];
		for (const fragment of fragments) for (const rootAttributes of ["", ` onload="1"`, ` xml:base="https://evil/"`]) {
			const result = prepare(`<svg viewBox="0 0 10 10"${rootAttributes}>${fragment}</svg>`);
			if (result.ok) assertClean(result.svg);
		}
	});
});

describe("the data URL", () => {
	it("percent-encodes the svg so that it cannot end the attribute it is put in", () => {
		const url = svgDataUrl(`<svg a="1 & 2">'"<>#%</svg>`);
		assert.match(url, /^data:image\/svg\+xml;charset=utf-8,[A-Za-z0-9%._~!*()'-]*$/);
		assert.equal(decodeURIComponent(url.slice(url.indexOf(",") + 1)), `<svg a="1 & 2">'"<>#%</svg>`);
	});

	it("does not throw on a lone surrogate", () => {
		assert.equal(decodeURIComponent(svgDataUrl("a\uD800b").split(",")[1] ?? ""), "a\uFFFDb");
	});
});
