import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import { before, test } from "node:test";
import { build } from "esbuild";

type Provide = (text: string, existing: readonly string[]) => Promise<string>;
let render: (text: string) => string;
/** Renders with a link context whose host has proven exactly `existing`, as the page does once validations are answered. */
let renderLinked: Provide;
before(async () => {
	const bundled = await build({ stdin: { contents: `
		import { createElement } from "react";
		import { renderToStaticMarkup } from "react-dom/server";
		import { Markdown } from "./components/Markdown";
		import { FileLinksContext } from "./components/FileLinks";
		import { WebLinksContext } from "./components/WebLinks";
		import { ChatFileLinks } from "./lib/chat-file-links";
		import { TerminalLinkClient } from "./lib/terminal-link-client";
		export const render = text => renderToStaticMarkup(createElement(Markdown, { text }));
		export const renderLinked = async (text, existing) => {
			const listeners = new Set();
			const transport = { post(message) { if (message.type === "omp:terminal-link-validate") queueMicrotask(() => { for (const listener of listeners) listener({ type: "omp:terminal-link-validation", requestId: message.requestId, valid: existing.includes(message.target) }); }); return true; }, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
			const links = new ChatFileLinks(transport);
			const web = new TerminalLinkClient(transport);
			for (const target of existing) await links.resolve(target);
			const html = renderToStaticMarkup(createElement(WebLinksContext.Provider, { value: web }, createElement(FileLinksContext.Provider, { value: links }, createElement(Markdown, { text }))));
			links.dispose();
			web.dispose();
			return html;
		};
	`, loader: "tsx", resolveDir: join(process.cwd(), "src/webview") }, bundle: true, write: false,
		format: "cjs", platform: "node", packages: "external", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' } });
	const module = { exports: {} as { render: typeof render; renderLinked: Provide } };
	new Function("require", "module", "exports", bundled.outputFiles[0]!.text)(createRequire(import.meta.url), module, module.exports);
	render = module.exports.render;
	renderLinked = module.exports.renderLinked;
});

test("bullets indented under a numbered item nest inside it instead of continuing the numbering", () => {
	const html = render([
		"1. **Logs.** Read them.",
		"2. **Suspects:**",
		"   - sync reads of big files;",
		"   - periodic status checks;",
		"3. **Measure** in the test window.",
	].join("\n"));
	assert.equal(html, '<div class="omp-md"><ol><li><span><strong>Logs.</strong> Read them.</span></li><li><span><strong>Suspects:</strong></span><ul><li><span>sync reads of big files;</span></li><li><span>periodic status checks;</span></li></ul></li><li><span><strong>Measure</strong> in the test window.</span></li></ol></div>');
});

test("two-space nesting, deeper levels and continuation lines stay with their item", () => {
	const html = render("- a\n  - b\n    - c\n  continued b\n- d");
	assert.equal(html, '<div class="omp-md"><ul><li><span>a</span><ul><li><span>b</span><ul><li><span>c<br/>continued b</span></li></ul></li></ul></li><li><span>d</span></li></ul></div>');
});

test("a different marker type starts a new list and an ordered list keeps its start number", () => {
	const html = render("3. three\n4. four\n- bullet");
	assert.equal(html, '<div class="omp-md"><ol start="3"><li><span>three</span></li><li><span>four</span></li></ol><ul><li><span>bullet</span></li></ul></div>');
});

test("blank-separated items form a loose list with paragraphs; code fences inside items survive", () => {
	const html = render("1. first\n\n   ```ts\n   const x = 1;\n   ```\n\n2. second\n\nafter");
	const codeBlock = '<div class="omp-code-block"><pre><code data-language="ts">const x = 1;</code></pre><button type="button" class="omp-copy-button omp-code-copy" aria-label="Copy code" title="Copy code"><span class="codicon codicon-copy" aria-hidden="true"></span></button></div>';
	assert.equal(html, `<div class="omp-md"><ol><li><p>first</p>${codeBlock}</li><li><p>second</p></li></ol><p>after</p></div>`);
});

const text = (html: string): string => html.replace(/<[^>]+>/g, "");
const EXISTING = ["src/a.ts:12:4", "src/a.ts", "./docs/my notes.md", "docs/guide.md#L7", "D:\\Work Space\\b.ts:3", "src/a.ts:9", "lib/c.ts"];
const PROSE = [
	"Fixed src/a.ts:12:4, see `./docs/my notes.md`, [the guide](docs/guide.md#L7) and **lib/c.ts** but not src/missing.ts.",
	"Also `D:\\Work Space\\b.ts:3` and @src/a.ts [lines 9-20].",
	"",
	"```",
	"src/a.ts:12:4 stays code",
	"```",
].join("\n");

test("file references only become links once the host proves them, with the rendered text unchanged", async () => {
	const plain = render(PROSE);
	assert.doesNotMatch(plain, /omp-file-link|<a /, "no link context, no links");
	const linked = await renderLinked(PROSE, EXISTING);
	assert.equal(text(linked), text(plain), "linking never changes the characters on screen");
	const targets = [...linked.matchAll(/data-file-target="([^"]*)"/g)].map(match => match[1]);
	assert.deepEqual(targets, ["src/a.ts:12:4", "./docs/my notes.md", "docs/guide.md#L7", "lib/c.ts", "D:\\Work Space\\b.ts:3", "src/a.ts:9"]);
	assert.match(linked, /<span class="omp-file-link" role="link" tabindex="0" data-file-target="src\/a\.ts:12:4"[^>]*>src\/a\.ts:12:4<\/span>/);
	const menuTargets = [...linked.matchAll(/data-vscode-context="([^"]*)"/g)].map(match => JSON.parse(match[1]!.replaceAll("&quot;", "\"")).ompFileLinkTarget);
	assert.deepEqual(menuTargets, targets, "the right-click menu acts on the same target a click opens");
	assert.match(linked, /<code><span class="omp-file-link"[^>]*data-file-target="\.\/docs\/my notes\.md"[^>]*>\.\/docs\/my notes\.md<\/span><\/code>/, "an inline code span is one link, inside the code element");
	assert.match(linked, /<strong><span class="omp-file-link"[^>]*data-file-target="lib\/c\.ts"[^>]*>lib\/c\.ts<\/span><\/strong>/);
	assert.match(linked, /<span class="omp-file-link"[^>]*data-file-target="docs\/guide\.md#L7"[^>]*>the guide<\/span>/, "a Markdown link to a file keeps its label");
	assert.match(linked, /<span[^>]*data-file-target="src\/a\.ts:9"[^>]*>@src\/a\.ts \[lines 9-20\]<\/span>/, "a mention opens at the first line of its note");
	assert.doesNotMatch(linked, /data-file-target="src\/missing\.ts"/, "an unproven path stays text");
	assert.doesNotMatch(linked, /<pre><code[^>]*><span/, "fenced code stays text");
});

test("an @ mention in inline code links like the same mention in prose", async () => {
	const linked = await renderLinked("See `@lib/c.ts` and @lib/c.ts.", EXISTING);
	assert.deepEqual([...linked.matchAll(/data-file-target="([^"]*)"/g)].map(match => match[1]), ["lib/c.ts", "lib/c.ts"]);
	assert.match(linked, /<code><span class="omp-file-link"[^>]*>@lib\/c\.ts<\/span><\/code>/);
});

test("file links add no URL scheme: only http(s) destinations become web links and every other destination renders as its label", async () => {
	const source = "[web](https://example.test/a.ts) [mail](mailto:a@b.test) [bad](javascript:alert(1)) [data](data:text/html,x) [cmd](command:workbench.action.reloadWindow) [vs](vscode://file/D:/x.ts) [file](file:///D:/repo/a.ts#L3)";
	const linked = await renderLinked(source, ["file:///D:/repo/a.ts#L3"]);
	assert.equal(text(linked), "web mail bad data cmd vs file");
	assert.doesNotMatch(linked, /<a /, "the page never renders a navigating anchor");
	assert.deepEqual([...linked.matchAll(/data-web-url="([^"]*)"/g)].map(match => match[1]), ["https://example.test/a.ts"]);
	assert.deepEqual([...linked.matchAll(/data-vscode-context="(\{&quot;webviewSection&quot;:&quot;ompWebLink[^"]*)"/g)].map(match => JSON.parse(match[1]!.replaceAll("&quot;", "\"")).ompWebLinkUrl), ["https://example.test/a.ts"], "the right-click menu opens the URL a click opens");
	assert.match(linked, /<span class="omp-web-link" role="link" tabindex="0" data-web-url="https:\/\/example\.test\/a\.ts"[^>]*>web<\/span>/);
	assert.deepEqual([...linked.matchAll(/data-file-target="([^"]*)"/g)].map(match => match[1]), ["file:///D:/repo/a.ts#L3"], "a file: URL is a file reference, nothing else is");
	assert.doesNotMatch(linked, /javascript:|data:text|command:|vscode:|mailto:/);
});

test("bare URLs in prose become web links without their trailing punctuation, and the characters stay the same", async () => {
	const source = [
		"See https://example.com. Or (https://en.wikipedia.org/wiki/Foo_(bar)), https://a.test/x_y_z?q=1&r=2#frag, and <https://auto.test/path>!",
		"**https://bold.test/b** then xhttps://not.test and http:not-a-url and `https://code.test/c`.",
		"",
		"```",
		"https://fenced.test/stays",
		"```",
	].join("\n");
	const plain = render(source);
	assert.doesNotMatch(plain, /omp-web-link/, "no link context, no links");
	const linked = await renderLinked(source, []);
	assert.equal(text(linked), text(plain), "linking never changes the characters on screen");
	assert.deepEqual([...linked.matchAll(/<span class="omp-web-link"[^>]*data-web-url="([^"]*)"[^>]*>([^<]*)<\/span>/g)].map(match => [match[1], match[2]]), [
		["https://example.com/", "https://example.com"],
		["https://en.wikipedia.org/wiki/Foo_(bar)", "https://en.wikipedia.org/wiki/Foo_(bar)"],
		["https://a.test/x_y_z?q=1&amp;r=2#frag", "https://a.test/x_y_z?q=1&amp;r=2#frag"],
		["https://auto.test/path", "https://auto.test/path"],
		["https://bold.test/b", "https://bold.test/b"],
	]);
	assert.match(linked, /<strong><span class="omp-web-link"/, "a URL inside emphasis is still one link");
	assert.doesNotMatch(linked, /<em>/, "underscores inside a URL never start emphasis");
	assert.match(linked, /<code>https:\/\/code\.test\/c<\/code>/, "a URL in inline code stays code");
	assert.match(linked, /<pre><code[^>]*>https:\/\/fenced\.test\/stays<\/code><\/pre>/, "fenced code stays text");
});
