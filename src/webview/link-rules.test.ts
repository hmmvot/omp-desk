import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import { before, test } from "node:test";
import { build } from "esbuild";

type Entry = { id: number; pattern: string; url: string; ignoreCase: boolean; name: string | null };
/** Renders `text` as an assistant reply (or not) with the given rules and, unless `provider` is false, a page that can open links. */
type Render = (text: string, options: { rules?: Entry[]; eligible?: boolean; provider?: boolean }) => string;
let render: Render;
/** The messages a click on the rule target posts. */
let clickMessages: (target: string) => Record<string, unknown>[];

before(async () => {
	const bundled = await build({ stdin: { contents: `
		import { createElement } from "react";
		import { renderToStaticMarkup } from "react-dom/server";
		import { Markdown } from "./components/Markdown";
		import { AssistantReplyContext } from "./components/FileLinks";
		import { WebLinksContext } from "./components/WebLinks";
		import { TerminalLinkClient } from "./lib/terminal-link-client";
		import { setLinkRules } from "./lib/link-rules-store";
		const fixture = () => {
			const sent = [];
			const transport = { post(message) { sent.push(message); return true; }, subscribe() { return () => {}; } };
			return { sent, client: new TerminalLinkClient(transport) };
		};
		export const render = (text, { rules = [], eligible = true, provider = true }) => {
			setLinkRules(rules);
			const { client } = fixture();
			const inner = createElement(AssistantReplyContext.Provider, { value: eligible }, createElement(Markdown, { text }));
			const html = renderToStaticMarkup(provider ? createElement(WebLinksContext.Provider, { value: client }, inner) : inner).replaceAll("<wbr/>", "");
			client.dispose();
			setLinkRules([]);
			return html;
		};
		export const clickMessages = target => {
			const { sent, client } = fixture();
			client.openLinkRule(target);
			client.dispose();
			return sent.map(({ requestId, ...rest }) => rest);
		};
	`, loader: "tsx", resolveDir: join(process.cwd(), "src/webview") }, bundle: true, write: false,
		format: "cjs", platform: "node", packages: "external", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' } });
	const module = { exports: {} as { render: Render; clickMessages: typeof clickMessages } };
	new Function("require", "module", "exports", bundled.outputFiles[0]!.text)(createRequire(import.meta.url), module, module.exports);
	render = module.exports.render;
	clickMessages = module.exports.clickMessages;
});

const TICKET: Entry = { id: 0, pattern: "\\bPROJ-(\\d+)\\b", url: "https://example.test/browse/$1", ignoreCase: false, name: "Tracker" };
const ISSUE: Entry = { id: 1, pattern: "#(\\d+)\\b", url: "https://example.test/issues/$1", ignoreCase: false, name: null };
const textOf = (html: string): string => html.replace(/<[^>]*>/g, "");
const linked = (html: string): string[] => [...html.matchAll(/<span class="omp-web-link omp-rule-link"[^>]*>(.*?)<\/span>/g)].map(match => textOf(match[1] ?? ""));

test("matching text of an assistant reply is a link: in prose, emphasis, lists, tables and headings, and a code span that is one match", () => {
	const reply = "Fixed PROJ-12 and #3.\n\n**PROJ-4** and _#5_, `PROJ-6` and `see PROJ-7` and `x`.\n\n- item PROJ-8\n\n| a | b |\n| - | - |\n| PROJ-9 | #10 |\n\n## Heading PROJ-11";
	const html = render(reply, { rules: [TICKET, ISSUE] });
	assert.deepEqual(linked(html), ["PROJ-12", "#3", "PROJ-4", "#5", "PROJ-6", "PROJ-8", "PROJ-9", "#10", "PROJ-11"], "`see PROJ-7` is code with more than one match in it: it stays code");
	assert.equal(textOf(html), textOf(render(reply, { rules: [] })), "linking never changes the characters on screen");
	assert.match(html, /<span class="omp-web-link omp-rule-link" role="link" tabindex="0" data-rule-target="link-rule:\/\/0\/PROJ-12" title="Tracker\nhttps:\/\/example\.test\/browse\/12\nClick to open in your browser">PROJ-12<\/span>/);
	assert.match(html, /<span[^>]*data-rule-target="link-rule:\/\/0\/PROJ-6"[^>]*><code>PROJ-6<\/code><\/span>/, "the code element stays inside the link");
	assert.match(html, /<code>see PROJ-7<\/code>/);
	assert.match(html, /<strong><span[^>]*data-rule-target="link-rule:\/\/0\/PROJ-4"/);
});

test("the title and the target carry the encoded URL the host will build and the characters the rule matched, nothing else", () => {
	const html = render("see #34", { rules: [ISSUE] });
	assert.match(html, /data-rule-target="link-rule:\/\/1\/%2334" title="https:\/\/example\.test\/issues\/34\nClick to open in your browser"/);
	assert.doesNotMatch(html, /href|data-web-url|data-vscode-context/, "no anchor, and no right-click menu that would carry a URL");
});

test("text that is not the assistant's reply, a page that cannot open links, and a fenced block stay text", () => {
	assert.deepEqual(linked(render("PROJ-1 and `PROJ-2`", { rules: [TICKET], eligible: false })), []);
	assert.match(render("`PROJ-2`", { rules: [TICKET], eligible: false }), /<code>PROJ-2<\/code>/);
	assert.deepEqual(linked(render("PROJ-1", { rules: [TICKET], provider: false })), []);
	assert.deepEqual(linked(render("```\nPROJ-3\n```", { rules: [TICKET] })), []);
	assert.deepEqual(linked(render("PROJ-1", { rules: [] })), []);
});

test("a rule never splits a web address, a path or a link label, and beats a commit hash", () => {
	const html = render("see https://example.test/PROJ-1 and src/PROJ-9/a.ts and [PROJ-2](https://example.test/x) and PROJ-3.", { rules: [TICKET] });
	assert.deepEqual(linked(html), ["PROJ-3"], "a key inside a URL, a path-shaped token or a link label belongs to that");
	assert.match(html, /<span class="omp-web-link" role="link"[^>]*data-web-url="https:\/\/example\.test\/PROJ-1"/, "the address is still its own web link");
	const hash = render("fixed in c7398070 and `c7398071`", { rules: [{ ...ISSUE, id: 0, pattern: "c\\d{7}\\b", url: "https://example.test/commit/$0" }] });
	assert.deepEqual(linked(hash), ["c7398070", "c7398071"]);
	assert.doesNotMatch(hash, /omp-commit-link/);
});

test("the earlier rule wins an overlap, and a rule that matches letters of either case says so", () => {
	const html = render("PROJ-12", { rules: [{ ...TICKET, id: 0, url: "https://example.test/first/$1" }, { ...ISSUE, id: 1, pattern: "PROJ-\\d", url: "https://example.test/second/$0" }] });
	assert.match(html, /link-rule:\/\/0\/PROJ-12/);
	assert.doesNotMatch(html, /link-rule:\/\/1\//);
	assert.deepEqual(linked(render("proj-1 PROJ-2", { rules: [{ ...TICKET, pattern: "proj-(\\d+)", ignoreCase: true }] })), ["proj-1", "PROJ-2"]);
});

test("a rule the page's own check refuses is not drawn, whatever the host sent", () => {
	assert.deepEqual(linked(render("PROJ-1", { rules: [{ ...TICKET, pattern: "(PROJ-\\d+)+" }] })), []);
	assert.deepEqual(linked(render("PROJ-1", { rules: [{ ...TICKET, url: "https://$1.example.test/" }] })), []);
	assert.deepEqual(linked(render("PROJ-1", { rules: [{ ...TICKET, url: "javascript:alert(1)" }] })), []);
});

test("a click posts a plain open request for the target only, with no URL, mode or action", () => {
	assert.deepEqual(clickMessages("link-rule://0/PROJ-12"), [{ type: "omp:terminal-link-open", target: "link-rule://0/PROJ-12" }]);
});
