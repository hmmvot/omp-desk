/** Without a Jobs row (a detail tab, a static render) the cards and prose that name background jobs draw plain text: no chip, no Cancel, no link. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import { before, test } from "node:test";
import { build } from "esbuild";
import type { ToolCardProps } from "./components/ToolCard";

interface RendererApi {
	card(props: ToolCardProps): string;
	markdown(text: string): string;
}
let api: RendererApi;
before(async () => {
	const bundled = await build({ stdin: { contents: `
		import { createElement } from "react";
		import { renderToStaticMarkup } from "react-dom/server";
		import { ToolCard } from "./components/ToolCard";
		import { Markdown } from "./components/Markdown";
		export const card = props => renderToStaticMarkup(createElement(ToolCard, props));
		export const markdown = text => renderToStaticMarkup(createElement(Markdown, { text }));
	`, loader: "tsx", resolveDir: join(process.cwd(), "src/webview") }, bundle: true, write: false,
		format: "cjs", platform: "node", packages: "external", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' } });
	const module = { exports: {} };
	new Function("require", "module", "exports", bundled.outputFiles[0]!.text)(createRequire(import.meta.url), module, module.exports);
	// The owned esbuild entry above defines this fixed test interface; no external payload is cast.
	api = module.exports as RendererApi;
});

function result(name: string, callId: string, text: string, details: unknown): NonNullable<ToolCardProps["result"]> {
	return { role: "toolResult", toolCallId: callId, toolName: name, content: [{ type: "text", text }], details, isError: false, timestamp: 1 };
}

function assertPlain(html: string): void {
	assert.doesNotMatch(html, /omp-job-chip/);
	assert.doesNotMatch(html, /omp-job-cancel/);
	assert.doesNotMatch(html, /omp-proc-link/);
	assert.doesNotMatch(html, /data-proc-target/);
}

test("a bash card that started a background job has no chip and no Cancel without a Jobs row", () => {
	const html = api.card({ name: "bash", args: { command: "npm run dev" }, callId: "call-bg", result: result("bash", "call-bg", "Backgrounded as job bg_1", { async: { state: "running", jobId: "bg_1", type: "bash" } }) });
	assert.match(html, /omp-native-tool/);
	assertPlain(html);
	assert.doesNotMatch(html, /omp-native-tool--job-cancel/);
});

test("a read of proc://bg_1 shows the address as plain text", () => {
	const html = api.card({ name: "read", args: { path: "proc://bg_1" }, callId: "call-read", result: result("read", "call-read", "output", { proc: { jobs: [] } }) });
	assert.match(html, /proc:\/\/(<wbr\/>)?bg_1/);
	assertPlain(html);
});

test("a wait card names its job ids as plain text", () => {
	const html = api.card({ name: "wait", args: {}, callId: "call-wait", initiallyExpanded: true, result: result("wait", "call-wait", "bg_1 completed", { jobs: [{ id: "bg_1", type: "bash", status: "completed", label: "npm test", durationMs: 1200 }] }) });
	assert.match(html, /bg_1/);
	assertPlain(html);
});

test("Markdown leaves proc:// addresses as text in prose, inline code and link labels", () => {
	// One address per render: two intraword underscores in one paragraph are read as emphasis by the parser, whatever they spell.
	const prose = api.markdown("See proc://bg_1 for the log.");
	assert.match(prose, /proc:\/\/(<wbr\/>)?bg_1/);
	const code = api.markdown("Run `proc://bg_2`.");
	assert.match(code, /<code>proc:\/\/(<wbr\/>)?bg_2<\/code>/);
	const labelled = api.markdown("Open [the job](proc://bg_3/kill).");
	assert.match(labelled, /the job/);
	for (const html of [prose, code, labelled]) assertPlain(html);
	assert.doesNotMatch(labelled, /href="proc:/);
});
