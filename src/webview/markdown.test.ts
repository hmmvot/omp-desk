import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import { before, test } from "node:test";
import { build } from "esbuild";

type Provide = (text: string, existing: readonly string[]) => Promise<string>;
let render: (text: string) => string;
/** Renders with a link context whose host has proven exactly `existing`, as the page does once validations are answered. */
let renderLinked: Provide;
/** Renders with the host answering each token of `symbols` with its target, its number of definitions or (`{ files }`) its number of same-named files (others none) and no path existing; `asked` is what the page asked the host. */
type RenderSymbols = (text: string, options: { paths?: string[]; symbols?: Record<string, string | number | { files: number }>; eligible?: boolean; provider?: boolean }) => Promise<{ html: string; asked: string[] }>;
let renderSymbols: RenderSymbols;
/** Parses every prefix of `text` of the given lengths in turn, each from the previous parse, and reports each step's markup and how many leading blocks it kept as the same element. */
type RenderStreamed = (text: string, lengths: readonly number[]) => { html: string; kept: number }[];
let renderStreamed: RenderStreamed;
/** Renders as it is, line-break points included. */
let renderBreaks: (text: string) => string;
/** The number of top-level blocks of a fresh parse. */
let blockCount: (text: string) => number;
before(async () => {
	const bundled = await build({ stdin: { contents: `
		import { createElement } from "react";
		import { renderToStaticMarkup } from "react-dom/server";
		import { Markdown, parseMarkdown } from "./components/Markdown";
		import { FileLinksContext } from "./components/FileLinks";
		import { WebLinksContext } from "./components/WebLinks";
		import { ChatFileLinks } from "./lib/chat-file-links";
		import { TerminalLinkClient } from "./lib/terminal-link-client";
		import { SymbolLinksContext, AssistantReplyContext } from "./components/FileLinks";
		import { ChatSymbolLinks } from "./lib/chat-symbol-links";
		/** The line-break points (a wbr) add no character: every comparison of characters ignores them, and renderBreaks keeps them. */
		const characters = html => html.replaceAll("<wbr/>", "");
		export const renderBreaks = text => renderToStaticMarkup(createElement(Markdown, { text }));
		export const render = text => characters(renderBreaks(text));
		export const renderLinked = async (text, existing) => {
			const listeners = new Set();
			const transport = { post(message) { if (message.type === "omp:terminal-link-validate") queueMicrotask(() => { for (const listener of listeners) listener({ type: "omp:terminal-link-validation", requestId: message.requestId, valid: existing.includes(message.target) }); }); return true; }, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
			const links = new ChatFileLinks(transport);
			const web = new TerminalLinkClient(transport);
			for (const target of existing) await links.resolve(target);
			const html = characters(renderToStaticMarkup(createElement(WebLinksContext.Provider, { value: web }, createElement(FileLinksContext.Provider, { value: links }, createElement(Markdown, { text })))));
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
					reply({ type: "omp:terminal-link-symbol-resolution", requestId: message.requestId, results: message.tokens.map(token => symbols[token] === undefined ? { token, status: "none" } : typeof symbols[token] === "number" ? { token, status: "ambiguous", definitions: symbols[token] } : typeof symbols[token] === "object" ? { token, status: "ambiguous", definitions: symbols[token].files, files: true } : { token, status: "found", target: symbols[token] }) });
				}
				return true;
			}, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
			const links = new ChatFileLinks(transport);
			const symbolLinks = new ChatSymbolLinks(transport, { batchMs: 0 });
			for (const path of paths) await links.resolve(path);
			for (const token of Object.keys(symbols)) await symbolLinks.resolve(token);
			const inner = createElement(Markdown, { text });
			const eligibility = createElement(AssistantReplyContext.Provider, { value: eligible }, inner);
			const html = provider
				? characters(renderToStaticMarkup(createElement(FileLinksContext.Provider, { value: links }, createElement(SymbolLinksContext.Provider, { value: symbolLinks }, eligibility))))
				: characters(renderToStaticMarkup(eligibility));
			links.dispose();
			symbolLinks.dispose();
			return { html, asked };
		};
		export const blockCount = text => parseMarkdown(text, null).blocks.length;
		export const renderStreamed = (text, lengths) => {
			const steps = [];
			let previous = null;
			for (const length of lengths) {
				const parsed = parseMarkdown(text.slice(0, length), previous);
				let kept = 0;
				while (previous !== null && kept < previous.blocks.length && parsed.blocks[kept] === previous.blocks[kept]) kept += 1;
				steps.push({ html: characters(renderToStaticMarkup(createElement("div", { className: "omp-md" }, parsed.blocks))), kept });
				previous = parsed;
			}
			return steps;
		};
	`, loader: "tsx", resolveDir: join(process.cwd(), "src/webview") }, bundle: true, write: false,
		format: "cjs", platform: "node", packages: "external", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' } });
	const module = { exports: {} as { render: typeof render; renderBreaks: typeof renderBreaks; renderLinked: Provide; renderSymbols: RenderSymbols; renderStreamed: RenderStreamed; blockCount: (text: string) => number } };
	new Function("require", "module", "exports", bundled.outputFiles[0]!.text)(createRequire(import.meta.url), module, module.exports);
	render = module.exports.render;
	renderBreaks = module.exports.renderBreaks;
	renderLinked = module.exports.renderLinked;
	renderSymbols = module.exports.renderSymbols;
	renderStreamed = module.exports.renderStreamed;
	blockCount = module.exports.blockCount;
});

test("inline code and link text break after path separators with a wbr that adds no character; prose and fenced code get none", () => {
	const raw = renderBreaks("`src/webview/a.ts` and [`x/y.ts`](https://example.com/a/b) and <https://example.com/p/q> and src/plain/text.ts and a/b\n\n```\nsrc/fence/x.ts\n```");
	assert.match(raw, /<code>src\/<wbr\/>webview\/<wbr\/>a\.ts<\/code>/);
	assert.match(raw, /<code>x\/<wbr\/>y\.ts<\/code>/);
	assert.match(raw, /https:\/\/<wbr\/>example\.com\/<wbr\/>p\/<wbr\/>q/);
	assert.ok(raw.includes("src/plain/text.ts and a/b"), "text outside code and links is left alone");
	assert.ok(raw.includes("src/fence/x.ts</code>"), "a fenced block is left alone");
	assert.equal(raw.replaceAll("<wbr/>", ""), render("`src/webview/a.ts` and [`x/y.ts`](https://example.com/a/b) and <https://example.com/p/q> and src/plain/text.ts and a/b\n\n```\nsrc/fence/x.ts\n```"));
	assert.equal(raw.replaceAll(/<[^>]*>/g, "").includes("src/webview/a.ts"), true, "the text, markup removed, is the characters as written");
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

const SYMBOL_PROSE = "`Session` and `SessionData.Load()` and `SessionStoreBase<T>` and `[Tracked]` and `Ambiguous` and `Unknown`, but `two words`, `a + b` and `src/gone.ts`.";
const SYMBOL_TARGETS = { Session: "src/Session.cs:12:5", "SessionData.Load()": "src/SessionData.cs:40:9", "SessionStoreBase<T>": "src/SessionStoreBase.cs:3:1", "[Tracked]": "src/Tracked.cs:7:3" };

test("an inline code span the host found one definition of renders as a code-path link to it; every other span stays code", async () => {
	const { html, asked } = await renderSymbols(SYMBOL_PROSE, { symbols: SYMBOL_TARGETS, paths: ["SessionData.Load()", "src/gone.ts"] });
	const targets = [...html.matchAll(/data-file-target="([^"]*)"/g)].map(match => match[1]);
	assert.deepEqual(targets, ["src/Session.cs:12:5", "src/SessionData.cs:40:9", "src/SessionStoreBase.cs:3:1", "src/Tracked.cs:7:3"]);
	assert.match(html, /<code><span class="omp-file-link" role="link" tabindex="0" data-file-target="src\/Session\.cs:12:5"[^>]*>Session<\/span><\/code>/, "underlined code like a path link: the anchor inside the code element");
	assert.match(html, /<code><span class="omp-file-link"[^>]*data-file-target="src\/SessionData\.cs:40:9"[^>]*>SessionData\.Load\(\)<\/span><\/code>/, "a dotted call is a symbol once its path-shaped reading is refused");
	assert.match(html, /<code><span class="omp-file-link"[^>]*>SessionStoreBase&lt;T&gt;<\/span><\/code>/, "the characters are the model's, not the normalized name");
	assert.match(html, /<code><span class="omp-file-link"[^>]*>\[Tracked\]<\/span><\/code>/);
	assert.match(html, /<code>Ambiguous<\/code>/);
	assert.match(html, /<code>Unknown<\/code>/);
	assert.match(html, /<code>two words<\/code>, <code>a \+ b<\/code> and <code>src\/gone\.ts<\/code>/);
	assert.equal(html.replace(/<[^>]*>/g, ""), (await renderSymbols(SYMBOL_PROSE, { symbols: {}, provider: false })).html.replace(/<[^>]*>/g, ""), "linking never changes the characters on screen");
	assert.deepEqual([...new Set(asked)].sort(), Object.keys(SYMBOL_TARGETS).sort(), "only symbol-shaped spans were asked about");
});

test("a symbol is linked in assistant text only, and without a link context it is plain code", async () => {
	const plain = await renderSymbols("`Session`", { symbols: { Session: "src/Session.cs:12:5" }, eligible: false });
	assert.doesNotMatch(plain.html, /omp-file-link/, "user text, tool output and thinking do not opt in");
	const bare = await renderSymbols("`Session`", { symbols: { Session: "src/Session.cs:12:5" }, provider: false });
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
	const { html } = await renderSymbols("```ts\nSession\n```\n\n[`Session`](docs/a.md)", { symbols: { Session: "src/Session.cs:12:5" } });
	assert.doesNotMatch(html, /<pre><code[^>]*><span/);
	assert.equal([...html.matchAll(/data-file-target="src\/Session\.cs/g)].length, 0);
	const emphasized = await renderSymbols("**`Session`** and *`Session`* and ~~`Session`~~", { symbols: { Session: "src/Session.cs:12:5" } });
	assert.equal([...emphasized.html.matchAll(/<(strong|em|s)><code><span class="omp-file-link"[^>]*data-file-target="src\/Session\.cs:12:5"/g)].length, 3, "bold, italic and strike each link their code span");
});

test("a symbol with several definitions renders as a dotted search link with its count, never as a file link, in text and in emphasis", async () => {
	const { html } = await renderSymbols("`Twin` and **`Twin`** and `Twin.Run()` and `Plain`", { symbols: { Twin: 3, "Twin.Run()": 2 } });
	assert.equal([...html.matchAll(/<span class="omp-symbol-search"[^>]*data-symbol-search="Twin"[^>]*title="3 definitions — click to choose"/g)].length, 2);
	assert.match(html, /data-symbol-search="Twin\.Run\(\)"[^>]*title="2 definitions — click to choose"/);
	assert.doesNotMatch(html, /omp-file-link/);
	assert.doesNotMatch(html, /data-symbol-search="Plain"/);
	assert.doesNotMatch(html, /data-vscode-context="[^"]*Twin/, "no file menu for a search link");
});

test("a bare file name the host found one file of is a link to it, several files are a dotted choice, none stays code; it is asked about only after its path was refused", async () => {
	const source = "`session-index.ts:849` and `Loader.cs(12)` and `Settings.cs:3` and `Missing.cs:1` and `@lib/c.ts` and `Util.Run` and **`session-index.ts:849`**";
	const { html, asked } = await renderSymbols(source, { paths: ["session-index.ts:849", "Settings.cs:3", "Missing.cs:1"], symbols: { "session-index.ts:849": "src/session-index.ts:849", "Loader.cs(12)": "Assets/Loader.cs:12", "Settings.cs:3": { files: 3 } } });
	assert.deepEqual([...html.matchAll(/data-file-target="([^"]*)"/g)].map(match => match[1]), ["src/session-index.ts:849", "Assets/Loader.cs:12", "src/session-index.ts:849"]);
	assert.match(html, /<code><span class="omp-file-link"[^>]*data-file-target="src\/session-index\.ts:849"[^>]*>session-index\.ts:849<\/span><\/code>/, "the span's own characters, as a file link");
	assert.match(html, /<code><span class="omp-file-link"[^>]*data-file-target="Assets\/Loader\.cs:12"[^>]*>Loader\.cs\(12\)<\/span><\/code>/, "the MSBuild form links without being a path");
	assert.match(html, /<code><span class="omp-symbol-search"[^>]*data-symbol-search="Settings\.cs:3"[^>]*title="3 files — click to choose"/, "several files are a choice, said in files");
	assert.match(html, /<code>Missing\.cs:1<\/code>/);
	assert.match(html, /<strong><code><span class="omp-file-link"[^>]*>session-index\.ts:849<\/span><\/code><\/strong>/);
	assert.doesNotMatch(html, /data-vscode-context="[^"]*Settings/, "no file menu for a choice");
	assert.deepEqual([...new Set(asked)].sort(), ["Loader.cs(12)", "Settings.cs:3", "session-index.ts:849"], "a refused path or a span with no path shape is asked about; a mention and a mixed-case dotted name are not file names");
});

test("the tail of a path that the session's folder does not have is asked about once its path was refused, and links to the file the host found, or lets the user choose", async () => {
	const source = "tools (`host/session-index.ts:579`, `shared\\code-symbols.ts`, `Dup/Settings.cs:3`, `Nope/Missing.cs:1`, `./session-index.ts`, `../session-index.ts:2`)";
	const { html, asked } = await renderSymbols(source, {
		paths: ["host/session-index.ts:579", "shared\\code-symbols.ts", "Dup/Settings.cs:3", "Nope/Missing.cs:1", "./session-index.ts", "../session-index.ts:2"],
		symbols: { "host/session-index.ts:579": "omp-vscode/src/host/session-index.ts:579", "shared\\code-symbols.ts": "omp-vscode/src/shared/code-symbols.ts", "Dup/Settings.cs:3": { files: 2 } },
	});
	assert.deepEqual([...html.matchAll(/data-file-target="([^"]*)"/g)].map(match => match[1]), ["omp-vscode/src/host/session-index.ts:579", "omp-vscode/src/shared/code-symbols.ts"]);
	assert.match(html, /<code><span class="omp-file-link"[^>]*data-file-target="omp-vscode\/src\/host\/session-index\.ts:579"[^>]*>host\/session-index\.ts:579<\/span><\/code>/, "the span's own characters, as a file link");
	assert.match(html, /<code><span class="omp-symbol-search"[^>]*data-symbol-search="Dup\/Settings\.cs:3"[^>]*title="2 files — click to choose"/);
	assert.match(html, /<code>Nope\/Missing\.cs:1<\/code>/);
	assert.deepEqual([...new Set(asked)].sort(), ["Dup/Settings.cs:3", "host/session-index.ts:579", "shared\\code-symbols.ts"], "the host is asked about the tails whose path was refused (the harness asks the tokens it has answers for)");
});

test("a bare file name is linked in assistant text only, and where nothing links it renders as before", async () => {
	const off = await renderSymbols("`session-index.ts:849` and `Loader.cs(12)`", { paths: ["session-index.ts:849"], symbols: { "session-index.ts:849": "src/session-index.ts:849", "Loader.cs(12)": "Assets/Loader.cs:12" }, eligible: false });
	assert.doesNotMatch(off.html, /omp-file-link|omp-symbol-search/);
	assert.match(off.html, /<code>session-index\.ts:849<\/code> and <code>Loader\.cs\(12\)<\/code>/);
	const linked = await renderLinked("`session-index.ts:849` and `Loader.cs`", ["session-index.ts:849", "Loader.cs"]);
	assert.match(linked, /<code><span class="omp-file-link"[^>]*data-file-target="session-index\.ts:849"/, "a file the cwd has keeps the path link, in any text");
	assert.match(linked, /<code><span class="omp-file-link"[^>]*data-file-target="Loader\.cs"/);
});

const STREAMED = [
	"# Plan",
	"",
	"First `a.ts` paragraph that goes",
	"on for two lines.",
	"",
	"- one",
	"",
	"- two after a blank joins the same loose list",
	"  with a continuation",
	"- three",
	"",
	"col | val",
	"--- | ---",
	"a | 1",
	"",
	"> quoted",
	"",
	"```ts",
	"const x = 1;",
	"```",
	"",
	"tail -",
	"- not a rule",
].join("\n");

test("a streamed reply parsed prefix by prefix renders exactly as a fresh parse at every length, keeping the finished blocks", () => {
	const lengths = Array.from({ length: STREAMED.length }, (_, index) => index + 1);
	const steps = renderStreamed(STREAMED, lengths);
	for (const [index, step] of steps.entries()) {
		assert.equal(step.html, render(STREAMED.slice(0, lengths[index])), `prefix of ${lengths[index]} characters`);
	}
	assert.equal(steps.at(-1)?.kept, 6, "the heading, paragraph, list, table, quote and fence are reused while the tail streams");
	assert.ok(steps.every(step => step.kept <= 6));
});

test("a block that may still be joined by what follows is parsed again, and a text that does not extend the previous one reuses nothing", () => {
	const open = renderStreamed("a\n\nb", [1, 4]);
	assert.equal(open[1]?.kept, 0, "the only block ends on the last line, so it is parsed again");
	const closed = renderStreamed("a\n\nb\n\nc", [5, 9]);
	assert.equal(closed[1]?.kept, 1, "a block followed by a line break is final");
	const replaced = renderStreamed("a\n\nb\n\nc", [9, 1]);
	assert.equal(replaced[1]?.kept, 0);
	assert.equal(replaced[1]?.html, render("a"));
});

const unescapeHtml = (html: string): string => html.replaceAll("&gt;", ">").replaceAll("&lt;", "<").replaceAll("&quot;", '"').replaceAll("&#x27;", "'").replaceAll("&amp;", "&");

test("a list-like line that is not a list item is one paragraph and the parse ends (it used to loop forever on a line the paragraph rule and the list rule read differently)", () => {
	for (const line of ["1234567890. x", "\u00a0- x", "-\u00a0x", "*\u3000x", "- \u00a0x\u00a0"]) {
		assert.equal(blockCount(line), 1, JSON.stringify(line));
	}
	for (const line of ["1234567890. x", "\u00a0- x", "-\u00a0x", "*\u3000x"]) {
		assert.equal(unescapeHtml(text(render(line))), line, `the text of ${JSON.stringify(line)} is shown as written`);
		assert.match(render(line), /^<div class="omp-md"><p>/, "a paragraph, not a list");
	}
	assert.equal(blockCount("> 1234567890. x"), 1);
	assert.match(render("> 1234567890. x"), /<blockquote>.*1234567890\. x/);
	// After a paragraph line the same lines are text of that paragraph; a real item still interrupts it.
	assert.equal(render("a\n1234567890. x"), '<div class="omp-md"><p>a<br/>1234567890. x</p></div>');
	assert.equal(render("a\n- b"), '<div class="omp-md"><p>a</p><ul><li><span>b</span></li></ul></div>');
});

test("the parse terminates for every short string over the 17 symbols that open blocks or break lines, with at most one block per line", () => {
	const symbols = ["-", "*", "+", ">", "#", "|", "`", "1", "0", ".", ")", " ", "\t", "\u00a0", "\u3000", "x", "\n"];
	const check = (value: string): void => {
		const lines = value.split(/\r?\n/).length;
		assert.ok(blockCount(value) <= lines, `${JSON.stringify(value)} has more blocks than lines`);
	};
	let count = 0;
	const walk = (prefix: string, left: number): void => {
		check(prefix);
		count++;
		if (left === 0) return;
		for (const symbol of symbols) walk(prefix + symbol, left - 1);
	};
	walk("", 4);
	assert.ok(count > 70_000);
	// A seeded sample of longer strings, with line breaks among the symbols.
	let state = 0x2545f491;
	const next = (): number => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state;
	};
	for (let sample = 0; sample < 2000; sample++) {
		const length = 5 + (next() % 8);
		let value = "";
		for (let at = 0; at < length; at++) value += symbols[next() % symbols.length];
		check(value);
	}
	const lines = ["1234567890. x", "- x", "-\u00a0x", "> x", "```", "# h", "| a |", "|---|", "1. x", "   ", "x"];
	for (const first of lines) for (const second of lines) check(`${first}\n${second}`);
});

/** The code blocks of a rendering as language and source; the source is unescaped. */
const codeBlocks = (html: string): { language: string; source: string }[] =>
	[...html.matchAll(/<code data-language="([^"]*)">([\s\S]*?)<\/code>/g)].map(match => ({ language: match[1] as string, source: unescapeHtml(match[2] as string) }));

test("a fence is closed only by a run at least as long as its opening run, as in the composer", () => {
	// A four-backtick fence shows a three-backtick fence and a bare three-backtick line as its content.
	const html = render("````md\n```ts\nconst x = 1;\n```\n```\nafter\n````\ntail");
	assert.deepEqual(codeBlocks(html), [{ language: "md", source: "```ts\nconst x = 1;\n```\n```\nafter" }]);
	assert.ok(html.endsWith("<p>tail</p></div>"), "the text after the closing run is a paragraph");
	// A closing run longer than the opening one closes it.
	assert.deepEqual(codeBlocks(render("```\na\n`````\nb")), [{ language: "", source: "a" }]);
	assert.match(render("```\na\n`````\nb"), /<p>b<\/p><\/div>$/);
	// A shorter run does not close it, and an unclosed fence runs to the end.
	assert.deepEqual(codeBlocks(render("````\na\n```\nb")), [{ language: "", source: "a\n```\nb" }]);
	// Three-backtick fences are unchanged.
	assert.deepEqual(codeBlocks(render("```ts\nx\n```")), [{ language: "ts", source: "x" }]);
	assert.deepEqual(codeBlocks(render("  ```ts\n  x\n  ```")), [{ language: "ts", source: "  x" }]);
});

test("an info string with spaces opens a fence with its first token as the language; backticks in the info string do not open one", () => {
	assert.deepEqual(codeBlocks(render("```ts title=x\nconst a = 1;\n```")), [{ language: "ts", source: "const a = 1;" }]);
	assert.deepEqual(codeBlocks(render("```  \na\n```")), [{ language: "", source: "a" }]);
	assert.deepEqual(codeBlocks(render("```ts```")), [], "a line of inline code is not a fence");
});

test("an unclosed four-backtick fence streamed prefix by prefix renders as a fresh parse and never ends early on a three-backtick line", () => {
	const source = "intro\n\n````md\n```ts\nx\n```\nmore\n````\n\ntail";
	const lengths = Array.from({ length: source.length }, (_, index) => index + 1);
	for (const [index, step] of renderStreamed(source, lengths).entries()) {
		assert.equal(step.html, render(source.slice(0, lengths[index])), `prefix of ${lengths[index]} characters`);
	}
	const unclosed = render(source.slice(0, source.indexOf("\nmore") + 5));
	assert.deepEqual(codeBlocks(unclosed), [{ language: "md", source: "```ts\nx\n```\nmore" }]);
});
