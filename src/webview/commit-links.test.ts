import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import { before, test } from "node:test";
import { build } from "esbuild";

/** Renders `text` as an assistant reply (or not) once the host has answered exactly the targets of `commits` (found) and `missing` (none); the rest has not been asked. */
type RenderCommits = (text: string, options: { commits?: string[]; missing?: string[]; eligible?: boolean; provider?: boolean }) => Promise<string>;
let renderCommits: RenderCommits;
/** The messages a click on a proven commit target posts. */
let clickMessages: (target: string) => Promise<Record<string, unknown>[]>;

before(async () => {
	const bundled = await build({ stdin: { contents: `
		import { createElement } from "react";
		import { renderToStaticMarkup } from "react-dom/server";
		import { Markdown } from "./components/Markdown";
		import { FileLinksContext, AssistantReplyContext } from "./components/FileLinks";
		import { ChatFileLinks } from "./lib/chat-file-links";
		const fixture = (known) => {
			const listeners = new Set();
			const sent = [];
			const transport = { post(message) {
				sent.push(message);
				if (message.type === "omp:terminal-link-validate") queueMicrotask(() => { for (const listener of listeners) listener({ type: "omp:terminal-link-validation", requestId: message.requestId, valid: known.includes(message.target) }); });
				return true;
			}, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
			return { sent, transport };
		};
		export const renderCommits = async (text, { commits = [], missing = [], eligible = true, provider = true }) => {
			const { transport } = fixture(commits);
			const links = new ChatFileLinks(transport);
			for (const target of [...commits, ...missing]) await links.resolve(target);
			const inner = createElement(AssistantReplyContext.Provider, { value: eligible }, createElement(Markdown, { text }));
			const html = renderToStaticMarkup(provider ? createElement(FileLinksContext.Provider, { value: links }, inner) : inner).replaceAll("<wbr/>", "");
			links.dispose();
			return html;
		};
		export const clickMessages = async (target) => {
			const { sent, transport } = fixture([target]);
			const links = new ChatFileLinks(transport);
			await links.resolve(target);
			links.open(target);
			links.open(target, "os");
			links.dispose();
			return sent.filter(message => message.type === "omp:terminal-link-open").map(({ requestId, ...rest }) => rest);
		};
	`, loader: "tsx", resolveDir: join(process.cwd(), "src/webview") }, bundle: true, write: false,
		format: "cjs", platform: "node", packages: "external", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' } });
	const module = { exports: {} as { renderCommits: RenderCommits; clickMessages: typeof clickMessages } };
	new Function("require", "module", "exports", bundled.outputFiles[0]!.text)(createRequire(import.meta.url), module, module.exports);
	renderCommits = module.exports.renderCommits;
	clickMessages = module.exports.clickMessages;
});

const REPLY = "Done in `c7398070` and also a1b2c3d4e5, see **5f3a9b2e1d**. Not `1234567`, deadbeef-rc, https://x.test/commit/c7398070 or:\n\n```\nc7398070 stays code\n```";

test("a hash in an assistant reply, in a code span and in prose, is a link once the host proves the commit, and the characters never change", async () => {
	const proven = ["commit://c7398070", "commit://a1b2c3d4e5", "commit://5f3a9b2e1d"];
	const plain = await renderCommits(REPLY, { eligible: false });
	assert.doesNotMatch(plain, /omp-commit-link/, "text that is not the assistant's reply never asks");
	const linked = await renderCommits(REPLY, { commits: proven, missing: ["commit://1234567"] });
	assert.equal(linked.replace(/<[^>]*>/g, ""), plain.replace(/<[^>]*>/g, ""), "linking never changes the characters on screen");
	assert.deepEqual([...linked.matchAll(/data-commit-target="([^"]*)"/g)].map(match => match[1]), ["commit://c7398070", "commit://a1b2c3d4e5", "commit://5f3a9b2e1d"]);
	assert.match(linked, /<code><span class="omp-file-link omp-commit-link" role="link" tabindex="0" data-commit-target="commit:\/\/c7398070" title="Commit c7398070\nShow in Source Control">c7398070<\/span><\/code>/, "a code span is one link inside the code element");
	assert.match(linked, /<strong><span[^>]*data-commit-target="commit:\/\/5f3a9b2e1d"[^>]*>5f3a9b2e1d<\/span><\/strong>/);
	assert.match(linked, /<code>1234567<\/code>/, "a span the host says is no commit is the code it was");
	assert.doesNotMatch(linked, /<pre><code[^>]*><span/, "fenced code stays text");
	assert.equal([...linked.matchAll(/data-commit-target="commit:\/\/c7398070"/g)].length, 1, "a hash in a web address belongs to the address");
	assert.doesNotMatch(linked, /data-file-target="commit:/, "a commit is never offered to the file proof");
	assert.doesNotMatch(linked, /ompFileLinkTarget/, "no file menu: there is no path");
});

test("without a link context, or before the host has answered, a hash is plain text", async () => {
	assert.doesNotMatch(await renderCommits(REPLY, { commits: ["commit://c7398070"], provider: false }), /omp-commit-link/);
	const unanswered = await renderCommits("`c7398070` and a1b2c3d4e5", {});
	assert.doesNotMatch(unanswered, /omp-commit-link/);
	assert.match(unanswered, /<code>c7398070<\/code>/);
});

test("a mixed-case hash that reads as a code symbol is a commit link first, and the symbol span it would have been where the host knows no such commit", async () => {
	const found = await renderCommits("`BadFace1`", { commits: ["commit://badface1"] });
	assert.match(found, /<code><span[^>]*data-commit-target="commit:\/\/badface1"[^>]*>BadFace1<\/span><\/code>/);
	const none = await renderCommits("`FaceBead1`", { missing: ["commit://facebead1"] });
	assert.doesNotMatch(none, /omp-commit-link/);
	assert.match(none, /<code>FaceBead1<\/code>/);
});

test("a click posts a plain open request for the canonical target; the modifier adds nothing", async () => {
	assert.deepEqual(await clickMessages("commit://c7398070"), [
		{ type: "omp:terminal-link-open", target: "commit://c7398070" },
		{ type: "omp:terminal-link-open", target: "commit://c7398070" },
	], "the host decides the repository and the view, so the request names neither a folder nor an action");
});
