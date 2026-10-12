import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import { before, test } from "node:test";
import { build } from "esbuild";
import type { ToolCardProps } from "./components/ToolCard";
import type { ToolRenderContext } from "./components/tool-render-types";
import { toolPresentation } from "../chat/tool-presentation.ts";
import type { ProjectedTool } from "../chat/transcript.ts";

interface RendererApi {
	card(props: ToolCardProps): string;
	describe(context: ToolRenderContext): { title: string; target?: string; icon?: string; tone?: string };
}
let api: RendererApi;
before(async () => {
	const bundled = await build({ stdin: { contents: `
		import { createElement } from "react";
		import { renderToStaticMarkup } from "react-dom/server";
		import { describeTool } from "./components/tool-renderers";
		import { ToolCard } from "./components/ToolCard";
		export const card = props => renderToStaticMarkup(createElement(ToolCard, props));
		export const describe = context => { const { body, ...rest } = describeTool(context); return rest; };
	`, loader: "tsx", resolveDir: join(process.cwd(), "src/webview") }, bundle: true, write: false,
		format: "cjs", platform: "node", packages: "external", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' } });
	const module = { exports: {} };
	new Function("require", "module", "exports", bundled.outputFiles[0]!.text)(createRequire(import.meta.url), module, module.exports);
	// The owned esbuild entry above defines this fixed test interface; no external payload is cast.
	api = module.exports as RendererApi;
});

function context(name: string, patch: Partial<ToolRenderContext> = {}): ToolRenderContext {
	return { name, args: {}, details: {}, stream: {}, text: "", expanded: false, partial: false, hasResult: true, isError: false, ...patch };
}
function result(name: string, text: string, details: unknown = {}, isError = false): ToolCardProps["result"] {
	return { role: "toolResult", toolCallId: `call-${name}`, toolName: name, content: [{ type: "text", text }], details, isError, timestamp: 1 };
}

test("a settled wait is one Overview line: title, outcome and elapsed time", () => {
	const html = api.card({ name: "vscode_debug_wait", args: { sessionId: "s1" }, result: result("vscode_debug_wait", "Session s1 stopped: breakpoint", { outcome: "stopped", reason: "breakpoint", generation: 4, elapsedMs: 133_000 }) });
	assert.match(html, /Wait for stop/);
	assert.match(html, /stopped · breakpoint/);
	assert.match(html, /2m 13s/);
	assert.doesNotMatch(html, /Arguments/);
});

test("a running wait shows 'waiting' and the clock from the first progress update", () => {
	const view = api.describe(context("vscode_debug_wait", { partial: true, hasResult: false, details: { waiting: true, elapsedMs: 0 } }));
	assert.equal(view.title, "Wait for stop");
	assert.equal(view.target, "waiting");
	const html = api.card({ name: "vscode_debug_wait", args: { sessionId: "s1" }, running: true, streamUpdate: undefined, partialResult: { content: [{ type: "text", text: "Waiting" }], details: { waiting: true, elapsedMs: 5000 } } } as ToolCardProps);
	assert.match(html, /Wait for stop/);
});

test("timeouts are warnings and failed starts are errors", () => {
	assert.equal(api.describe(context("vscode_debug_wait", { details: { outcome: "timeout" } })).tone, "warning");
	const start = api.describe(context("vscode_debug_start", { args: { name: "Run app" }, details: { outcome: "refused" }, isError: true }));
	assert.equal(start.tone, "error");
	assert.equal(start.target, "Run app");
	assert.equal(api.describe(context("vscode_debug_start", { args: { preset: "unity-attach" }, details: { outcome: "started" } })).tone, undefined);
});

test("Detailed shows the arguments and the result text", () => {
	const html = api.card({ name: "vscode_debug_inspect", args: { sessionId: "s1", what: "evaluate", expression: "n * 10" }, initiallyExpanded: true, result: result("vscode_debug_inspect", "n * 10 = 0 (number)\nGeneration 2.", { what: "evaluate" }) });
	assert.match(html, /Arguments/);
	assert.match(html, /n \* 10/);
	assert.match(html, /Result/);
	assert.match(html, /Generation 2/);
});

test("every debug tool has a title, an icon and a one-line target", () => {
	const cases: [string, Record<string, unknown>, Record<string, unknown>, string, string][] = [
		["vscode_debug_configs", {}, { folders: [{}], sessions: [{}, {}] }, "Debug setup", "1 folder · 2 sessions"],
		["vscode_debug_breakpoints", { action: "add", file: "C:\\x\\a.js", line: 3 }, {}, "Breakpoints", "add · a.js:3"],
		["vscode_debug_control", { sessionId: "s", action: "next", threadId: 1 }, {}, "Debug step over", "thread 1"],
		["vscode_debug_control", { sessionId: "s", action: "stop" }, {}, "Stop debugging", ""],
		["vscode_debug_inspect", { sessionId: "s", what: "stack" }, {}, "Debug inspect", "stack"],
		["vscode_debug_handoff", { sessionId: "s", message: "Look at x" }, {}, "Hand off to you", "Look at x"],
	];
	for (const [name, args, details, title, target] of cases) {
		const view = api.describe(context(name, { args, details }));
		assert.equal(view.title, title, name);
		assert.equal(view.target ?? "", target, name);
		assert.ok(view.icon && view.icon !== "tools", name);
	}
});

test("Overview groups use the debug titles and keep a pending wait out of the group", () => {
	const tool = (status: string, name: string): ProjectedTool => ({ call: { type: "toolCall", id: "c1", name, arguments: { sessionId: "s" } }, status, attachments: [] } as unknown as ProjectedTool);
	assert.equal(toolPresentation(tool("complete", "vscode_debug_control")).title, "Debug control");
	assert.equal(toolPresentation(tool("running", "vscode_debug_wait")).eligible, false);
	assert.equal(toolPresentation(tool("complete", "vscode_debug_wait")).eligible, true);
});
