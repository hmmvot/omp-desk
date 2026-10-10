import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import { before, test } from "node:test";
import { build } from "esbuild";

type Provide = (text: string, existing: readonly string[]) => Promise<string>;
let render: (text: string) => string;
/** Renders with a link context whose host has proven exactly `existing`, as the page does once validations are answered. */
let renderLinked: Provide;
/** Renders with the host answering each token of `symbols` with its target (others none) and no path existing; `asked` is what the page asked the host. */
type RenderSymbols = (text: string, options: { paths?: string[]; symbols?: Record<string, string | number>; eligible?: boolean; provider?: boolean }) => Promise<{ html: string; asked: string[] }>;
let renderSymbols: RenderSymbols;
before(async () => {
	const bundled = await build({ stdin: { contents: `
		import { createElement } from "react";
		import { renderToStaticMarkup } from "react-dom/server";
		import { Markdown } from "./components/Markdown";
		import { FileLinksContext } from "./components/FileLinks";
		import { WebLinksContext } from "./components/WebLinks";
		import { ChatFileLinks } from "./lib/chat-file-links";
		import { TerminalLinkClient } from "./lib/terminal-link-client";
		import { SymbolLinksContext, SymbolLinksEligibleContext } from "./components/FileLinks";
		import { ChatSymbolLinks } from "./lib/chat-symbol-links";
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
		export const renderSymbols = async (text, { paths = [], symbols = {}, eligible = true, provider = true }) => {
			const listeners = new Set();
			const asked = [];
			const reply = message => queueMicrotask(() => { for (const listener of listeners) listener(message); });
			const transport = { post(message) {
				if (message.type === "omp:terminal-link-validate") reply({ type: "omp:terminal-link-validation", requestId: message.requestId, valid: false });
				if (message.type === "omp:terminal-link-symbols") {
					asked.push(...message.tokens);
					reply({ type: "omp:terminal-link-symbol-resolution", requestId: message.requestId, results: message.tokens.map(token => symbols[token] === undefined ? { token, status: "none" } : typeof symbols[token] === "number" ? { token, status: "ambiguous", definitions: symbols[token] } : { token, status: "found", target: symbols[token] }) });
				}
				return true;
			}, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
			const links = new ChatFileLinks(transport);
			const symbolLinks = new ChatSymbolLinks(transport, { batchMs: 0 });
			for (const path of paths) await links.resolve(path);
			for (const token of Object.keys(symbols)) await symbolLinks.resolve(token);
			const inner = createElement(Markdown, { text });
			const eligibility = createElement(SymbolLinksEligibleContext.Provider, { value: eligible }, inner);
			const html = provider
				? renderToStaticMarkup(createElement(FileLinksContext.Provider, { value: links }, createElement(SymbolLinksContext.Provider, { value: symbolLinks }, eligibility)))
				: renderToStaticMarkup(eligibility);
			links.dispose();
			symbolLinks.dispose();
			return { html, asked };
		};
	`, loader: "tsx", resolveDir: join(process.cwd(), "src/webview") }, bundle: true, write: false,
		format: "cjs", platform: "node", packages: "external", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' } });
	const module = { exports: {} as { render: typeof render; renderLinked: Provide; renderSymbols: RenderSymbols } };
	new Function("require", "module", "exports", bundled.outputFiles[0]!.text)(createRequire(import.meta.url), module, module.exports);
	render = module.exports.render;
	renderLinked = module.exports.renderLinked;
	renderSymbols = module.exports.renderSymbols;
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

test("a code symbol linked to its definition line opens that file, and an unproven target stays inline code", async () => {
	const linked = await renderLinked("[`World.Current`](src/a.ts:12:4) and [`Missing.Thing`](src/missing.ts:3)", EXISTING);
	assert.deepEqual([...linked.matchAll(/data-file-target="([^"]*)"/g)].map(match => match[1]), ["src/a.ts:12:4"]);
	assert.match(linked, /<span class="omp-file-link"[^>]*data-file-target="src\/a\.ts:12:4"[^>]*><code>World\.Current<\/code><\/span> and <code>Missing\.Thing<\/code>/);
});

test("emphasis content goes through the inline pipeline: a code-label link and a code span inside bold", async () => {
	const linked = await renderLinked("**Decides [`World.Current`](src/a.ts:12:4)** and **a `plain` span** and *[`World.Current`](src/a.ts:12:4)*", EXISTING);
	assert.match(linked, /<strong>Decides <span class="omp-file-link"[^>]*data-file-target="src\/a\.ts:12:4"[^>]*><code>World\.Current<\/code><\/span><\/strong>/);
	assert.match(linked, /<strong>a <code>plain<\/code> span<\/strong>/);
	assert.match(linked, /<em><span class="omp-file-link"[^>]*><code>World\.Current<\/code><\/span><\/em>/);
	assert.doesNotMatch(text(linked), /[`\]\[]/, "no raw backticks or link syntax on screen");
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

const SYMBOL_PROSE = "`Ability` and `AbilityData.Cast()` and `UnitUseAbilityAbstract<T>` and `[AllowedOn]` and `Ambiguous` and `Unknown`, but `two words`, `a + b` and `src/gone.ts`.";
const SYMBOL_TARGETS = { Ability: "src/Ability.cs:12:5", "AbilityData.Cast()": "src/AbilityData.cs:40:9", "UnitUseAbilityAbstract<T>": "src/Unit.cs:3:1", "[AllowedOn]": "src/AllowedOn.cs:7:3" };

test("an inline code span the host found one definition of renders as a code-path link to it; every other span stays code", async () => {
	const { html, asked } = await renderSymbols(SYMBOL_PROSE, { symbols: SYMBOL_TARGETS, paths: ["AbilityData.Cast()", "src/gone.ts"] });
	const targets = [...html.matchAll(/data-file-target="([^"]*)"/g)].map(match => match[1]);
	assert.deepEqual(targets, ["src/Ability.cs:12:5", "src/AbilityData.cs:40:9", "src/Unit.cs:3:1", "src/AllowedOn.cs:7:3"]);
	assert.match(html, /<code><span class="omp-file-link" role="link" tabindex="0" data-file-target="src\/Ability\.cs:12:5"[^>]*>Ability<\/span><\/code>/, "underlined code like a path link: the anchor inside the code element");
	assert.match(html, /<code><span class="omp-file-link"[^>]*data-file-target="src\/AbilityData\.cs:40:9"[^>]*>AbilityData\.Cast\(\)<\/span><\/code>/, "a dotted call is a symbol once its path-shaped reading is refused");
	assert.match(html, /<code><span class="omp-file-link"[^>]*>UnitUseAbilityAbstract&lt;T&gt;<\/span><\/code>/, "the characters are the model's, not the normalized name");
	assert.match(html, /<code><span class="omp-file-link"[^>]*>\[AllowedOn\]<\/span><\/code>/);
	assert.match(html, /<code>Ambiguous<\/code>/);
	assert.match(html, /<code>Unknown<\/code>/);
	assert.match(html, /<code>two words<\/code>, <code>a \+ b<\/code> and <code>src\/gone\.ts<\/code>/);
	assert.equal(html.replace(/<[^>]*>/g, ""), (await renderSymbols(SYMBOL_PROSE, { symbols: {}, provider: false })).html.replace(/<[^>]*>/g, ""), "linking never changes the characters on screen");
	assert.deepEqual([...new Set(asked)].sort(), Object.keys(SYMBOL_TARGETS).sort(), "only symbol-shaped spans were asked about");
});

test("a symbol is linked in assistant text only, and without a link context it is plain code", async () => {
	const plain = await renderSymbols("`Ability`", { symbols: { Ability: "src/Ability.cs:12:5" }, eligible: false });
	assert.doesNotMatch(plain.html, /omp-file-link/, "user text, tool output and thinking do not opt in");
	const bare = await renderSymbols("`Ability`", { symbols: { Ability: "src/Ability.cs:12:5" }, provider: false });
	assert.doesNotMatch(bare.html, /omp-file-link/);
});

test("a span that is a path the host proves stays a file link and the symbol is not asked; a refused path reads as a symbol", async () => {
	const proven = await renderLinked("`Util.Helper`", ["Util.Helper"]);
	assert.match(proven, /<code><span class="omp-file-link"[^>]*data-file-target="Util\.Helper"/, "a file named like a dotted symbol is the file");
	const { html, asked } = await renderSymbols("`Util.Helper`", { symbols: { "Util.Helper": "src/Util.cs:2:1" }, paths: ["Util.Helper"] });
	assert.match(html, /data-file-target="src\/Util\.cs:2:1"/);
	assert.deepEqual(asked, ["Util.Helper"]);
	const unproven = await renderSymbols("`Util.Helper`", { symbols: { "Util.Helper": "src/Util.cs:2:1" } });
	assert.doesNotMatch(unproven.html, /omp-file-link/, "the path's own verdict is awaited first, and until then the span is plain");
});

test("code blocks and link labels never ask about symbols; a code span inside emphasis is a candidate like any other", async () => {
	const { html } = await renderSymbols("```ts\nAbility\n```\n\n[`Ability`](docs/a.md)", { symbols: { Ability: "src/Ability.cs:12:5" } });
	assert.doesNotMatch(html, /<pre><code[^>]*><span/);
	assert.equal([...html.matchAll(/data-file-target="src\/Ability\.cs/g)].length, 0);
	const emphasized = await renderSymbols("**`Ability`** and *`Ability`* and ~~`Ability`~~", { symbols: { Ability: "src/Ability.cs:12:5" } });
	assert.equal([...emphasized.html.matchAll(/<(strong|em|s)><code><span class="omp-file-link"[^>]*data-file-target="src\/Ability\.cs:12:5"/g)].length, 3, "bold, italic and strike each link their code span");
});

test("a symbol with several definitions renders as a dotted search link with its count, never as a file link, in text and in emphasis", async () => {
	const { html } = await renderSymbols("`Twin` and **`Twin`** and `Twin.Run()` and `Plain`", { symbols: { Twin: 3, "Twin.Run()": 2 } });
	assert.equal([...html.matchAll(/<span class="omp-symbol-search"[^>]*data-symbol-search="Twin"[^>]*title="3 definitions — click to choose"/g)].length, 2);
	assert.match(html, /data-symbol-search="Twin\.Run\(\)"[^>]*title="2 definitions — click to choose"/);
	assert.doesNotMatch(html, /omp-file-link/);
	assert.doesNotMatch(html, /data-symbol-search="Plain"/);
	assert.doesNotMatch(html, /data-vscode-context="[^"]*Twin/, "no file menu for a search link");
});
