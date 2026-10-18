import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import { before, test } from "node:test";
import { build } from "esbuild";
import type { ToolCardProps } from "./components/ToolCard";
import type { ToolRenderContext } from "./components/tool-render-types";

/**
 * The yield, MCP and autoresearch cards. Fixtures have the shapes OMP 18.11.1 produces: `YieldDetails`
 * (`pi-coding-agent/src/tools/yield.ts`), `MCPToolDetails` (`pi-tui/src/tools/mcp.ts`, minted names from
 * `mcp/tool-bridge.ts`), and the autoresearch tools' `InitExperimentDetails`, `LogDetails`, `RunDetails`,
 * `RunExperimentProgressDetails` and `UpdateNotesDetails` (`pi-tui/src/tools/autoresearch.ts`).
 */
interface RendererApi {
	card(props: ToolCardProps): string;
	view(context: ToolRenderContext): string;
	describe(context: ToolRenderContext): { title: string; target?: string; icon?: string; tone?: string; meta?: string[]; family: string; output?: { structured?: string } };
}
let api: RendererApi;
before(async () => {
	const bundled = await build({ stdin: { contents: `
		import { createElement } from "react";
		import { renderToStaticMarkup } from "react-dom/server";
		import { describeTool } from "./components/tool-renderers";
		import { ToolCard } from "./components/ToolCard";
		export const card = props => renderToStaticMarkup(createElement(ToolCard, props));
		export const view = context => renderToStaticMarkup(describeTool(context).body);
		export const describe = context => { const { body, inline, ...rest } = describeTool(context); return rest; };
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
/** The text of the card's head: what a reader sees while the call is closed. */
function head(html: string): string {
	const match = /<button type="button" class="omp-tool-head[^"]*"[^>]*>(.*?)<\/button>/s.exec(html);
	assert.ok(match, "the card has a head");
	return match[1]!.replace(/<span class="omp-sr-only"[^>]*>.*?<\/span>/s, "").replace(/<[^>]+>/g, " ").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
}

// ---- yield ----

test("a yield of data is a Submit Result card that shows its data as a tree, with the size in the head", () => {
	const data = { summary: { overall_correctness: "correct", explanation: "ok", confidence: 0.9 }, findings: [] };
	const html = api.card({ name: "yield", args: { data }, callId: "y1", initiallyExpanded: true,
		result: result("yield", "Result submitted.", { data, status: "success", error: undefined }) });
	assert.match(head(html), /^Submit Result 2 fields$/);
	assert.match(html, /omp-json/, "an object is a folding tree");
	assert.match(html, /overall_correctness/);
	assert.doesNotMatch(html, /Result submitted/, "the tool's acknowledgement is not the card's output");
	assert.doesNotMatch(html, /omp-native-error/);
});

test("a yield names the section it fills, or the workpool item", () => {
	const section = api.describe(context("yield", { args: { type: ["findings"], data: [{ title: "a" }, { title: "b" }] }, details: { type: ["findings"], data: [{ title: "a" }, { title: "b" }], status: "success" } }));
	assert.equal(section.title, "Submit Result");
	assert.equal(section.target, "findings");
	const several = api.describe(context("yield", { args: { type: ["summary", "findings"], data: { summary: 1, findings: 2 } } }));
	assert.equal(several.target, "summary, findings");
	const item = api.describe(context("yield", { args: { key: 3, data: { verdict: "ok" } }, details: { type: ["item-9"], data: { verdict: "ok" }, status: "success" } }));
	assert.equal(item.target, "item 3", "a workpool call is its item number, not the item's internal id");
	const whole = api.describe(context("yield", { args: { data: { a: 1 } }, details: { type: "result", data: { a: 1 }, status: "success" } }));
	assert.equal(whole.target, undefined, "a terminal result has no section");
});

test("the accepted data wins over the data as sent, a count of items says its size", () => {
	const view = api.describe(context("yield", { args: { type: ["findings"], data: [1] }, details: { type: ["findings"], data: [1, 2, 3], status: "success" } }));
	assert.deepEqual(view.meta, ["3 items"]);
	assert.deepEqual(api.describe(context("yield", { args: { data: { a: 1 } } })).meta, ["1 field"]);
	assert.deepEqual(api.describe(context("yield", { args: { data: "report" } })).meta, []);
});

test("a string yield is a report: Markdown prose, and an empty one says so", () => {
	const report = api.view(context("yield", { args: { data: "## Findings\n\nNothing **wrong**." }, details: { data: "## Findings\n\nNothing **wrong**.", status: "success" } }));
	assert.match(report, /Findings/);
	assert.doesNotMatch(report, /omp-json/);
	assert.match(api.view(context("yield", { args: { data: "  " }, details: { data: "  ", status: "success" } })), /\(empty\)/);
});

test("a yield accepted although it failed the schema says so in the head and keeps its data", () => {
	const data = { score: "high" };
	const html = api.card({ name: "yield", args: { data }, callId: "y2",
		result: result("yield", "Result submitted (schema validation overridden after 3 failed attempt(s)).", { data, status: "success", schemaOverridden: true }) });
	assert.match(head(html), /schema overridden/);
	assert.match(html, /omp-chip omp-chip--warn/);
	assert.doesNotMatch(html, /omp-tool--error/, "a warning is not a failure");
});

test("an aborted yield shows the error in full and fails the card", () => {
	const error = "the build could not start: missing tsconfig.json";
	const html = api.card({ name: "yield", args: { error }, callId: "y3", initiallyExpanded: true,
		result: result("yield", `Task aborted: ${error}`, { data: undefined, status: "aborted", error, type: undefined }) });
	assert.match(html, /omp-tool--error/);
	assert.match(html, /class="omp-native-error omp-tool-wrap">the build could not start: missing tsconfig\.json</);
	assert.match(head(html), /aborted/);
	assert.doesNotMatch(html, /Ends with the sections submitted earlier/);
});

test("a yield the tool rejects shows its validation message, every offending field included", () => {
	const message = "Output does not match schema: /findings/0/priority: expected number; /summary: required. Call yield again with the corrected shape — 2 retry attempt(s) remain before the schema constraint is dropped.";
	const html = api.card({ name: "yield", args: { data: { findings: [{ priority: "P0" }] } }, callId: "y4", initiallyExpanded: true, result: result("yield", message, {}, true) });
	assert.match(html, /omp-tool--error/);
	assert.match(html, /\/findings\/0\/priority: expected number; \/summary: required\./);
	assert.match(html, /omp-json/, "the data as sent stays visible beside the rejection");
});

test("a yield without data takes the last message, and says which section", () => {
	const terminal = api.view(context("yield", { args: {}, details: { status: "success", useLastTurn: true } }));
	assert.match(terminal, /Ends with the sections submitted earlier, or the last message/);
	const section = api.view(context("yield", { args: { type: ["summary"] }, details: { status: "success", type: ["summary"], useLastTurn: true } }));
	assert.match(section, /Takes the last message as this section/);
	assert.doesNotMatch(api.view(context("yield", { args: { type: ["summary"] }, hasResult: false })), /Takes the last message/, "nothing is promised before the call settles");
});

test("a yield with a null error and null data (strict-mode providers) is a plain call", () => {
	const view = api.describe(context("yield", { args: { type: null, data: { a: 1 }, error: null, key: null } }));
	assert.equal(view.target, undefined);
	assert.equal(view.tone, undefined);
});

test("a task row's reviewer still reads its findings from the extracted yield data", () => {
	const row = { id: "0-Review", index: 0, agent: "reviewer", exitCode: 0, extractedToolData: { yield: [
		{ type: ["findings"], data: { title: "Race", body: "A **race**.", priority: 1, confidence: 0.8, file_path: "src/a.ts", line_start: 3, line_end: 4 }, status: "success" },
		{ type: ["summary"], data: { overall_correctness: "incorrect", explanation: "One race.", confidence: 0.8 }, status: "success" },
	] } };
	const html = api.view(context("task", { args: { tasks: [{ id: "0-Review", agent: "reviewer", assignment: "Review." }] }, details: { results: [row] } }));
	assert.match(html, /Patch is incorrect/);
	assert.match(html, /P1: 1/, "the extracted findings section is counted");
	assert.match(html, /Race<\/strong>/);
});

// ---- MCP ----

const MCP_NAME = "mcp__klyaksa_add_image_from_url";
function mcpDetails(patch: Record<string, unknown> = {}): Record<string, unknown> {
	return { serverName: "klyaksa", mcpToolName: "add_image_from_url", isError: false, provider: "mcp-json", providerName: "MCP Config", ...patch };
}

test("an MCP call is titled server/tool with its arguments summarised, while it is still pending", () => {
	const view = api.describe(context(MCP_NAME, { hasResult: false, args: { canvasId: "c-7", url: "https://example.com/pictures/a-very-long-picture-name.png", width: 320, tags: ["a", "b", "c"], style: { bold: true }, note: null, i: "Add the picture" } }));
	assert.equal(view.title, "klyaksa/add_image_from_url", "the minted name is split at its first underscore until the result names the server");
	assert.equal(view.icon, "plug");
	assert.equal(view.target, 'canvasId="c-7", url="https://example.com/pic…", width=320, tags=[3 items], style={1 keys}');
	assert.doesNotMatch(view.target ?? "", /Add the picture/, "the intent field is not an argument");
});

test("the result's details name the real server and tool, not the sanitised minted name", () => {
	const view = api.describe(context("mcp__my_server_run_query", { details: { serverName: "my_server", mcpToolName: "Run-Query" }, text: "ok" }));
	assert.equal(view.title, "my_server/Run-Query");
	assert.equal(api.describe(context("mcp__figma_get_node", {})).title, "figma/get_node");
	assert.equal(api.describe(context("mcp__oddname", {})).title, "mcp__oddname", "a name that does not split is shown whole");
});

test("the arguments summary stops at 160 characters with an ellipsis", () => {
	const args = Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`argument${index}`, `value-${index}`]));
	const target = api.describe(context(MCP_NAME, { args })).target ?? "";
	assert.ok(target.endsWith(", …"));
	assert.ok(target.length <= 165, `${target.length}`);
	assert.ok(target.startsWith('argument0="value-0", argument1="value-1"'));
});

test("a JSON result of an MCP call is a folding tree, the arguments a section above it", () => {
	const text = JSON.stringify({ ok: true, elementId: "el-1", bounds: { x: 1, y: 2 } }, null, 2);
	const html = api.card({ name: MCP_NAME, args: { canvasId: "c-7", url: "https://example.com/a.png" }, callId: "m1", initiallyExpanded: true, result: result(MCP_NAME, text, mcpDetails()) });
	assert.match(head(html), /^klyaksa\/add_image_from_url canvasId="c-7", url="https:\/\/example\.com\/a\.p…" JSON$/, "the head's gist says JSON, as for any JSON result");
	assert.match(html, /omp-tool-section-title">Args</);
	assert.match(html, /omp-format-badge/, "the card detected JSON in the output");
	assert.match(html, /omp-json/);
	assert.match(html, /elementId/);
	assert.doesNotMatch(html, /omp-tool--error/);
});

test("a plain-text result of an MCP call is text, an empty one says so", () => {
	const plain = api.view(context(MCP_NAME, { text: "Image placed at (10, 20)" }));
	assert.match(plain, /Image placed at \(10, 20\)/);
	assert.doesNotMatch(plain, /omp-json/);
	assert.match(api.view(context(MCP_NAME, { text: "" })), /\(no output\)/);
	assert.doesNotMatch(api.view(context(MCP_NAME, { hasResult: false, args: {} })), /no output/, "a pending call has no output yet");
});

test("an MCP error is red text, whether the result flag or only the details say it", () => {
	const flagged = api.card({ name: MCP_NAME, args: { url: "x" }, callId: "m2", initiallyExpanded: true, result: result(MCP_NAME, 'MCP error: {"code":-32602,"message":"url must be https"}', mcpDetails({ isError: true }), true) });
	assert.match(flagged, /omp-tool--error/);
	assert.match(flagged, /omp-native-error/);
	assert.match(flagged, /url must be https/);
	assert.equal(api.describe(context(MCP_NAME, { text: "connecting", details: { serverName: "klyaksa", mcpToolName: "add_image_from_url", isError: true } })).tone, "error");
});

test("a truncated MCP result keeps its JSON a tree and the card footer carries the notice once", () => {
	const meta = { truncation: { direction: "head", truncatedBy: "lines", totalLines: 400, totalBytes: 90_000, outputLines: 3, outputBytes: 40, shownRange: { start: 1, end: 3 }, artifactId: "7" } };
	const notice = "[Showing lines 1-3 of 400. Read artifact://7 for full output]";
	const html = api.card({ name: MCP_NAME, args: {}, callId: "m3", initiallyExpanded: true, result: result(MCP_NAME, `{\n  "rows": [1, 2, 3]\n}\n\n${notice}`, mcpDetails({ meta })) });
	assert.match(html, /omp-json/);
	assert.equal((html.match(/Output truncated/g) ?? []).length, 1);
	assert.match(html, /full output/);
	assert.doesNotMatch(html, /Showing lines 1-3 of 400\. Read artifact/, "the notice is not repeated in the output");
	// A notice the text rules do not recognise is cut by the result's own metadata.
	const middle = "[Showing head and tail bytes of 900 lines; 40.0KB elided. Read artifact://7 for full output]";
	const cut = api.view(context(MCP_NAME, { text: `[1, 2]\n\n${middle}`, details: mcpDetails({ meta: { truncation: { ...meta.truncation, direction: "middle", truncatedBy: "middle" } } }) }));
	assert.doesNotMatch(cut, /elided/);
});

test("no native tool, and no look-alike name, is taken for an MCP tool", () => {
	for (const name of ["read", "bash", "task", "web_search", "mcp", "mcp_server_tool", "mcp__", "my_mcp__tool", "xmcp__a_b"]) {
		const view = api.describe(context(name, { details: mcpDetails() }));
		assert.notEqual(view.family, "mcp", name);
	}
	assert.equal(api.describe(context("read", { details: mcpDetails() })).family, "read");
	assert.equal(api.describe(context("mcp__a_b", {})).family, "mcp");
});

test("an MCP tool called through a write to an xd:// device wears the same card", () => {
	const view = api.describe(context("write", { args: { path: `xd://${MCP_NAME}`, content: '{"canvasId":"c-7"}' }, details: { xdev: { tool: MCP_NAME, args: { canvasId: "c-7" }, inner: mcpDetails() } }, text: "{}" }));
	assert.equal(view.title, "klyaksa/add_image_from_url");
	assert.equal(view.target, 'canvasId="c-7"');
	assert.equal(view.icon, "plug");
});

// ---- autoresearch ----

const experiment = { runNumber: 4, commit: "9f2c1ab", metric: 1234.5, metrics: { memory: 88 }, status: "keep", description: "inline the hot loop\nand drop the bounds check", timestamp: 1, segment: 1, confidence: 2.3, modifiedPaths: ["src/loop.ts"], scopeDeviations: [], justification: null, flagged: false, flaggedReason: null };
const state = { results: [experiment], bestMetric: 1500, bestDirection: "lower", metricName: "total_ms", metricUnit: "ms", secondaryMetrics: [], name: "loop speed", goal: "faster loop", currentSegment: 1, maxExperiments: null, confidence: 2.3, scopePaths: ["src"], offLimits: [], constraints: [], notes: "", branch: "autoresearch/loop", baselineCommit: "abc1234", sessionId: 1 };
function logDetails(patch: Record<string, unknown> = {}, over: Record<string, unknown> = {}): Record<string, unknown> {
	return { experiment: { ...experiment, ...patch }, state, wallClockSeconds: 12, scopeDeviations: [], justification: null, flaggedRuns: [], ...over };
}

test("log_experiment is its disposition, description and metric against the baseline", () => {
	const args = { metric: 1234.5, status: "keep", description: "inline the hot loop\nand drop the bounds check", asi: { hypothesis: "bounds checks dominate" } };
	const html = api.card({ name: "log_experiment", args, callId: "a1", initiallyExpanded: true, result: result("log_experiment", "Logged run #4: keep", logDetails()) });
	assert.match(head(html), /^Log experiment · keep inline the hot loop total_ms=1,234\.50ms baseline 1,500ms conf 2\.3x$/);
	assert.match(html, /omp-native-selected">KEEP</);
	assert.match(html, /<dt>total_ms<\/dt><dd>1,234\.50ms<\/dd>/);
	assert.match(html, /<dt>baseline<\/dt><dd>1,500ms<\/dd>/);
	assert.match(html, /<dt>confidence<\/dt><dd>2\.3x<\/dd>/);
	assert.doesNotMatch(html, /deviations/);
	assert.match(html, /bounds checks dominate/, "the call's structured metadata is in its args section");
	assert.doesNotMatch(html, /omp-tool--error/);
});

test("log_experiment tones: discard warns, crash and failed checks fail the card, scope deviations are counted and listed", () => {
	const discard = api.card({ name: "log_experiment", args: { status: "discard", description: "no gain" }, callId: "a2", initiallyExpanded: true, result: result("log_experiment", "Logged run #5: discard", logDetails({ status: "discard", description: "no gain" })) });
	assert.match(discard, /omp-native-warning">DISCARD</);
	assert.doesNotMatch(discard, /omp-tool--error/);
	const crash = api.card({ name: "log_experiment", args: { status: "crash", description: "oom" }, callId: "a3", result: result("log_experiment", "Logged run #6: crash", logDetails({ status: "crash", description: "oom" })) });
	assert.match(crash, /omp-tool--error/);
	const deviating = api.card({ name: "log_experiment", args: { status: "keep", description: "touched extras" }, callId: "a4", initiallyExpanded: true, result: result("log_experiment", "Logged run #7: keep", logDetails({ description: "touched extras", scopeDeviations: ["docs/x.md"] }, { scopeDeviations: ["docs/x.md"] })) });
	assert.match(head(deviating), /deviations:1/);
	assert.match(deviating, /<dt>deviations<\/dt><dd class="omp-native-warning">1<\/dd>/);
	assert.match(deviating, /Scope deviations/);
	assert.match(deviating, /docs\/x\.md/);
});

test("log_experiment without usable details shows the text, an error in red", () => {
	const text = api.view(context("log_experiment", { args: { status: "keep", description: "d" }, text: "Error: run_experiment has not run", details: {} }));
	assert.match(text, /Error: run_experiment has not run/);
	const failed = api.view(context("log_experiment", { args: { status: "keep", description: "d" }, text: "Error: boom", isError: true, details: logDetails() }));
	assert.match(failed, /omp-native-error omp-tool-wrap">Error: boom</);
	assert.doesNotMatch(failed, /KEEP/);
	assert.equal(api.describe(context("log_experiment", { args: { status: "crash", description: "d" }, hasResult: false })).tone, undefined, "nothing is judged before the result");
});

const runDetails = { runNumber: 4, runDirectory: "C:/repo/.omp/autoresearch/runs/0004", benchmarkLogPath: "C:/repo/.omp/autoresearch/runs/0004/benchmark.log", command: "bash autoresearch.sh", exitCode: 0, durationSeconds: 12.34, passed: true, crashed: false, timedOut: false, tailOutput: "warmup done\nMETRIC total_ms=1234.5\n", parsedMetrics: { total_ms: 1234.5 }, parsedPrimary: 1234.5, parsedAsi: null, metricName: "total_ms", metricUnit: "ms", preRunDirtyPaths: [], abandonedPriorRun: null };

test("run_experiment is PASS, FAIL or TIMEOUT with the duration, the metric and the tail of the output", () => {
	const pass = api.card({ name: "run_experiment", args: { timeout_seconds: 300 }, callId: "r1", initiallyExpanded: true, result: result("run_experiment", "tail", runDetails) });
	assert.match(head(pass), /^Run experiment bash autoresearch\.sh PASS 12\.3s total_ms=1,234\.50ms$/);
	assert.match(pass, /METRIC total_ms=1234\.5/);
	assert.doesNotMatch(pass, /omp-tool--error/);
	const fail = api.card({ name: "run_experiment", args: {}, callId: "r2", result: result("run_experiment", "tail", { ...runDetails, exitCode: 2, passed: false, tailOutput: "boom" }) });
	assert.match(head(fail), /FAIL exit=2 12\.3s/);
	assert.match(fail, /omp-tool--error/);
	const timeout = api.card({ name: "run_experiment", args: {}, callId: "r3", result: result("run_experiment", "tail", { ...runDetails, exitCode: null, timedOut: true, passed: false }) });
	assert.match(head(timeout), /TIMEOUT 12\.3s/);
	assert.match(timeout, /omp-tool--error/);
});

test("a running run_experiment shows its elapsed time and the output so far; a truncated run names its full output", () => {
	const progress = { phase: "running", elapsed: "1m 05s", runDirectory: "C:/repo/.omp/autoresearch/runs/0005" };
	const running = api.card({ name: "run_experiment", args: {}, callId: "r4", running: true, initiallyExpanded: true, partialResult: { content: [{ type: "text", text: "compiling…" }], details: progress } } as ToolCardProps);
	assert.match(head(running), /Running 1m 05s…/);
	assert.match(running, /codicon-modifier-spin/);
	assert.match(running, /compiling…/);
	const truncated = api.view(context("run_experiment", { details: { ...runDetails, truncation: { truncated: true, totalLines: 5000 }, fullOutputPath: "C:/repo/.omp/autoresearch/runs/0004/benchmark.log" } }));
	assert.match(truncated, /Full output: /);
	assert.match(truncated, /benchmark\.log/);
});

test("a run_experiment result without run details (no active session) is its text", () => {
	const html = api.view(context("run_experiment", { text: "Error: no active autoresearch session for the current branch. Call init_experiment first.", details: {} }));
	assert.match(html, /no active autoresearch session/);
	assert.doesNotMatch(html, /PASS|FAIL/);
});

test("init_experiment names the experiment, its arguments under the result text", () => {
	const args = { name: "loop speed", goal: "make the loop faster", primary_metric: "total_ms", metric_unit: "ms", direction: "lower", scope_paths: ["src"] };
	const html = api.card({ name: "init_experiment", args, callId: "i1", initiallyExpanded: true, result: result("init_experiment", "Initialized experiment 'loop speed' on branch autoresearch/loop.", { state, createdSession: true, bumpedSegment: false, abandonedRuns: 0, harnessCommitted: true, baselineCommit: "abc1234" }) });
	assert.match(head(html), /^Init experiment loop speed$/);
	assert.match(html, /Initialized experiment &#x27;loop speed&#x27; on branch autoresearch\/loop\./);
	assert.match(html, /primary_metric/);
});

test("update_notes shows the idea it appends, or the notes it replaces, and what OMP answered", () => {
	const idea = api.card({ name: "update_notes", args: { body: "ignored when an idea is appended", append_idea: "try SIMD\nfor the inner loop" }, callId: "n1", initiallyExpanded: true, result: result("update_notes", "Appended idea (120 chars total).", { notes: "## Ideas\n- try SIMD\n" }) });
	assert.match(head(idea), /^Update notes try SIMD$/);
	assert.match(idea, /Idea/);
	assert.match(idea, /for the inner loop/);
	assert.doesNotMatch(idea, /ignored when an idea is appended/, "OMP ignores body when an idea is appended");
	assert.match(idea, /Appended idea \(120 chars total\)\./);
	const notes = api.card({ name: "update_notes", args: { body: "# Goal\nFaster loop.\n" }, callId: "n2", initiallyExpanded: true, result: result("update_notes", "Notes updated (20 chars).", { notes: "# Goal\nFaster loop.\n" }) });
	assert.match(head(notes), /^Update notes # Goal$/);
	assert.match(notes, /Notes updated \(20 chars\)\./);
});

test("autoresearch cards are not taken for tools that merely carry similar names or details", () => {
	assert.equal(api.describe(context("log_experiment_extra", { details: logDetails() })).family, "unknown");
	assert.equal(api.describe(context("bash", { details: logDetails() })).family, "bash");
});
