import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import { before, test } from "node:test";
import { build } from "esbuild";
import type { ToolCardProps } from "./components/ToolCard";
import type { ToolRenderContext } from "./components/tool-renderers";
import type { NativeMessageProps } from "./components/NativeMessage";
import type { AgentProgressViewProps } from "./components/AgentProgress";

interface RendererApi {
	view(context: ToolRenderContext): string;
	card(props: ToolCardProps): string;
	native(props: NativeMessageProps): string;
	progress(props: AgentProgressViewProps): string;
}
let api: RendererApi;
before(async () => {
	const bundled = await build({ stdin: { contents: `
		import { createElement } from "react";
		import { renderToStaticMarkup } from "react-dom/server";
		import { describeTool } from "./components/tool-renderers";
		import { ToolCard } from "./components/ToolCard";
		import { NativeMessage } from "./components/NativeMessage";
		import { AgentProgressView } from "./components/AgentProgress";
		export const view = context => renderToStaticMarkup(describeTool(context).body);
		export const card = props => renderToStaticMarkup(createElement(ToolCard, props));
		export const native = props => renderToStaticMarkup(createElement(NativeMessage, props));
		export const progress = props => renderToStaticMarkup(createElement(AgentProgressView, props));
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


test("settled Ask uses native singular answers ahead of input questions and marks only the chosen options", () => {
	const question = { id: "color", question: "Which color?", options: [{ label: "Red" }, { label: "Green" }, { label: "Blue" }] };
	const html = api.card({ name: "ask", args: { questions: [question] }, initiallyExpanded: true,
		result: result("ask", "User selected: Green", { question: question.question, options: ["Red", "Green", "Blue"], multi: false, selectedOptions: ["Green"] }) });
	assert.equal((html.match(/omp-native-selected/g) ?? []).length, 1);
	assert.match(html, /omp-native-selected[^<]*><span class="omp-ask-option-marker codicon codicon-circle-large-filled"/);
	assert.equal((html.match(/codicon-circle-large-outline/g) ?? []).length, 2);
	assert.doesNotMatch(html, /Cancelled|Waiting for your answer/);
	const custom = api.card({ name: "ask", args: { questions: [question] }, initiallyExpanded: true,
		result: result("ask", "User provided custom input: Violet", { question: question.question, options: ["Red", "Green", "Blue"], multi: false, selectedOptions: [], customInput: "Violet" }) });
	assert.match(custom, /Violet/);
	assert.doesNotMatch(custom, /Cancelled|omp-native-selected/);
});

test("settled Ask distinguishes an unanswered single choice from a valid empty multi-selection", () => {
	const html = api.view(context("ask", { details: { results: [
		{ id: "empty", question: "Single?", options: ["A"], multi: false, selectedOptions: [] },
		{ id: "none", question: "Multi?", options: ["B"], multi: true, selectedOptions: [] },
		{ id: "some", question: "Multi?", options: ["C", "D"], multi: true, selectedOptions: ["D"] },
	] } }));
	assert.equal((html.match(/Cancelled/g) ?? []).length, 1);
	assert.equal((html.match(/omp-native-selected/g) ?? []).length, 1);
	assert.match(html, /codicon-check/);
	assert.match(html, /codicon-blank/);
});

test("native EditPreviewBatch renders every file diff and per-file error while running", () => {
	const html = api.card({ name: "edit", args: {}, running: true, streamUpdate: { generation: 7, streaming: true, files: [
		{ path: "src/a.ts", op: "update", diff: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new", firstChangedLine: 1 },
		{ path: "src/b.ts", error: "Cannot preview missing file" },
	] } });
	assert.match(html, /data-tool-status="running"/);
	assert.match(html, /src\/a.ts · line 1/);
	assert.match(html, /src\/b.ts/);
	assert.match(html, /omp-native-diff-file">--- a\/src\/a.ts/);
	assert.match(html, /omp-native-diff-remove">-old/);
	assert.match(html, /omp-native-diff-add">\+new/);
	assert.match(html, /Cannot preview missing file/);
});

test("native numbered diff rows render sign and original-number gutters separately", () => {
	// Row format as OMP's editDiffString produces it for ('alpha\nbeta\ngamma\n', 'alpha\nBETA\ngamma\n').
	const html = api.view(context("edit", { details: { path: "sample.ts", diff: " 1|alpha\n-2|beta\n+2|BETA\n 3|gamma", firstChangedLine: 2 } }));
	assert.match(html, /omp-native-diff-remove"><span class="omp-native-diff-sign">-<\/span><span class="omp-native-line-number">2<\/span>beta/);
	assert.match(html, /omp-native-diff-add"><span class="omp-native-diff-sign">\+<\/span><span class="omp-native-line-number">2<\/span>BETA/);
	assert.match(html, /omp-native-line-number">3<\/span>gamma/);
});

test("final edit result displaces stale streaming preview for a delete or no-op", () => {
	const html = api.view(context("edit", { details: { path: "removed.ts", op: "delete", diff: "" }, text: "Deleted removed.ts", stream: { files: [{ path: "stale.ts", diff: "+stale-change" }] } }));
	assert.match(html, /Deleted removed.ts/);
	assert.doesNotMatch(html, /stale-change|stale.ts/);
});

test("diff previews cap at forty lines and eight hunks, then expansion exposes everything", () => {
	const lines = Array.from({ length: 41 }, (_, index) => `+change-${index}`);
	const closed = api.view(context("edit", { details: { diff: lines.join("\n") } }));
	assert.match(closed, /change-39/); assert.doesNotMatch(closed, /change-40/); assert.match(closed, /1 more diff lines/);
	assert.match(api.view(context("edit", { details: { diff: lines.join("\n") }, expanded: true })), /change-40/);
	const hunks = Array.from({ length: 9 }, (_, index) => `@@ -${index + 1} +${index + 1} @@\n+block-${index}`).join("\n");
	const limited = api.view(context("edit", { details: { diff: hunks } }));
	assert.match(limited, /block-7/); assert.doesNotMatch(limited, /block-8/);
	assert.match(api.view(context("edit", { details: { diff: hunks }, expanded: true })), /block-8/);
	const exact = api.view(context("edit", { details: { diff: lines.slice(0, 40).join("\n") } }));
	assert.doesNotMatch(exact, /more diff lines/);
});

test("closed flat tool rows do not mount output; disclosure exposes complete output", () => {
	const text = Array.from({ length: 11 }, (_, index) => `row-${index}`).join("\n");
	const closed = api.card({ name: "bash", args: { command: "print rows" }, result: result("bash", text) });
	assert.doesNotMatch(closed, /row-0|row-10|omp-tool-body/);
	assert.match(closed, /aria-expanded="false"/);
	const open = api.card({ name: "bash", args: { command: "print rows" }, initiallyExpanded: true, result: result("bash", text) });
	assert.match(open, /row-0\n/); assert.match(open, /row-10/); assert.match(open, /aria-expanded="true"/);
});

test("Bash previews contain command output and recovery hints, not generated model notices", () => {
	const notice = "Backgrounded as job INTERNAL_JOB; its output is injected into the conversation as a follow-up the moment it finishes. Do NOT poll for it (no `sleep`, `ps`, `pgrep`, `top`, `pidwait`, log tailing): every poll is a wasted turn. Do other work, or end your reply and wait to be woken.";
	const output = `Visible command output\n${notice}\nCommand exited with code 0\nWall time: 1.23 seconds\n[raw output: artifact://812]`;
	for (const initiallyExpanded of [false, true]) {
		const html = api.view(context("bash", { args: { command: "print output" }, expanded: initiallyExpanded, text: output, details: { async: { state: "running", jobId: "INTERNAL_JOB" }, exitCode: 0, wallTimeMs: 1234, meta: { artifactId: "812" } } }));
		assert.match(html, /Visible command output/); assert.match(html, /Read artifact:\/\/812 for full output/);
		assert.doesNotMatch(html, /INTERNAL_JOB|Do NOT poll|Command exited with code|Wall time:|\[raw output:/);
	}
});

test("Bash exposes command and full output but not private execution payloads", () => {
	const html = api.card({ name: "bash", args: { command: "printf native-output" }, initiallyExpanded: true,
		result: result("bash", "native-output", { exitCode: 0, terminalId: "INTERNAL_TERMINAL", privateField: "INTERNAL_RESULT" }) });
	assert.match(html, /printf native-output/); assert.match(html, /native-output/);
	assert.doesNotMatch(html, /INTERNAL_TERMINAL|INTERNAL_RESULT/);
	const command = api.card({ name: "bash", args: { command: "printenv MODE", cwd: "D:/work/src", env: { MODE: "test", UNUSED: null } }, cwd: "D:/work", initiallyExpanded: true, result: result("bash", "test") });
	assert.match(command, /cd src &amp;&amp; MODE=&quot;test&quot; printenv MODE/);
	assert.doesNotMatch(command, /UNUSED|null/);
	const sameDirectory = api.card({ name: "bash", args: { command: "pwd", cwd: "D:/work" }, cwd: "D:/work", initiallyExpanded: true, result: result("bash", "D:/work") });
	assert.doesNotMatch(sameDirectory, /cd D:\/work/);
	const timeout = api.card({ name: "bash", args: { command: "long-command", timeout: 30 }, initiallyExpanded: true, result: result("bash", "partial-output", { timedOut: true, timeoutSeconds: 30 }, true) });
	assert.match(timeout, /timed out/);
	assert.match(timeout, /partial-output/);
	assert.doesNotMatch(timeout, /timeoutSeconds|<dt>/);
	const fallback = api.card({ name: "extension-tool", args: { query: "Visible request", optional: null, nested: { path: "visible.ts", absent: null } }, initiallyExpanded: true, result: result("extension-tool", "Visible result") });
	assert.match(fallback, /Visible request/);
	assert.match(fallback, /visible.ts/);
	assert.match(fallback, /Visible result/);
	assert.doesNotMatch(fallback, /optional|absent|null|undefined/);
});


test("native interrupted waits are absent but returned job snapshots and real failures remain visible", () => {
	const placeholder = result("wait", "MODEL_ONLY_RETRY_GUIDANCE", { source: "interrupt_skipped", __interrupted: true, execution: "started" }, true);
	assert.equal(api.card({ name: "wait", args: {}, result: placeholder }), "");
	assert.equal(api.card({ name: "wait", args: {}, result: result("wait", "MODEL_ONLY_RETRY_GUIDANCE", { source: "interrupt_skipped", __synthetic: true }, true) }), "");
	const snapshot = api.view(context("wait", { details: { interrupted: true, jobs: [{ id: "Worker", type: "task", status: "completed", resultText: "Visible worker result" }] } }));
	assert.match(snapshot, /Worker/);
	assert.doesNotMatch(snapshot, /Visible worker result/);
	assert.match(api.card({ name: "wait", args: {}, initiallyExpanded: true, result: result("wait", "", { interrupted: true, jobs: [{ id: "Worker", type: "task", status: "completed", resultText: "Visible worker result" }] }) }), /Visible worker result/);
	const failure = api.card({ name: "wait", args: {}, initiallyExpanded: true, result: result("wait", "Actual wait failure", { __interrupted: true }, true) });
	assert.match(failure, /Actual wait failure/);
	assert.match(failure, /omp-tool--error/);
});

test("read source retains original numbers and elisions, malformed numbering uses sequential fallback", () => {
	const details = { displayContent: { text: "first\n…\nlast", startLine: 20, lineNumbers: [20, null, 99] } };
	const html = api.view(context("read", { details }));
	assert.match(html, /omp-native-line-number">20/); assert.match(html, /omp-native-line-number"><\/span> …/); assert.match(html, /omp-native-line-number">99/);
	const malformed = api.view(context("read", { details: { displayContent: { ...details.displayContent, lineNumbers: [20] } } }));
	assert.match(malformed, /omp-native-line-number">21/); assert.match(malformed, /omp-native-line-number">22/);
});

test("AST edit converts numbered change groups to hunks and keeps whole first group", () => {
	const displayContent = "# src/\n## one.ts (2 replacements)\n-12│old\n+12│new\n-99│second-old\n+99│second-new\n## two.ts\n-1│third-old\n+1│third-new";
	const closed = api.view(context("ast_edit", { details: { displayContent, totalReplacements: 3 } }));
	assert.match(closed, /src\/one.ts/); assert.match(closed, /@@ -12 \+12 @@/); assert.match(closed, /omp-native-diff-add">\+new/);
	assert.match(closed, /2 more changes/); assert.doesNotMatch(closed, /third-new/);
	assert.match(api.view(context("ast_edit", { details: { displayContent }, expanded: true })), /third-new/);
});


test("read previews follow native twelve-line code-cell boundary", () => {
	const text = Array.from({ length: 13 }, (_, index) => `source-${index}`).join("\n");
	const closed = api.view(context("read", { text }));
	assert.match(closed, /source-11/); assert.doesNotMatch(closed, /source-12/); assert.match(closed, /1 more lines/);
	assert.match(api.view(context("read", { text, expanded: true })), /source-12/);
});
test("Task review stays expansion-only and retains full native findings and locations", () => {
	const findings = [3, 0, 2, 1].map(priority => ({ title: `finding-${priority}`, body: `explanation-${priority}`, priority, confidence: .9, file_path: "src/client.ts", line_start: 41, line_end: 43 }));
	const details = { results: [{ id: "Reviewer", agent: "reviewer", exitCode: 0, structuredOutput: { source: "yield", status: "success", data: { findings, summary: { overall_correctness: "incorrect", explanation: "Fix required", confidence: .95 } } } }] };
	const closed = api.view(context("task", { details }));
	assert.match(closed, /Reviewer/); assert.match(closed, /completed/);
	assert.doesNotMatch(closed, /finding-|Patch is|client.ts|explanation-|95% confidence/);
	const open = api.card({ name: "task", args: {}, result: result("task", "", details), initiallyExpanded: true });
	assert.ok(open.indexOf("finding-3") < open.indexOf("finding-0")); assert.match(open, /explanation-3/); assert.match(open, /client.ts:41–43/);
	assert.match(open, /Patch is incorrect/); assert.match(open, /95% confidence/);
});

test("task review assembles incremental yields and narrows malformed optional fields", () => {
	const details = { progress: [{ id: "Reviewer", currentTool: { arbitrary: true }, extractedToolData: { yield: [
		{ type: ["overall_correctness"], data: "correct" }, { type: ["explanation"], data: "Verified" }, { type: ["confidence"], data: .8 },
		{ type: ["findings"], data: [{ invalid: true }] },
	] } }] };
	const html = api.view(context("task", { details, expanded: true }));
	assert.match(html, /Patch is correct/); assert.match(html, /80% confidence/); assert.match(html, /Findings: none/); assert.doesNotMatch(html, /\[object Object\]/);
});

test("LSP references collapse by three files and one location, expand to three locations per file", () => {
	const text = "7 reference(s)\na.ts:1:1\na.ts:2:1\na.ts:3:1\na.ts:4:1\nb.ts:1:1\nc.ts:1:1\nd.ts:1:1";
	const closed = api.view(context("lsp", { args: { action: "references" }, text }));
	assert.match(closed, /a.ts · 4 references/); assert.match(closed, /line 1, col 1/); assert.doesNotMatch(closed, /line 2, col 1|d.ts/); assert.match(closed, /1 more items/);
	const open = api.view(context("lsp", { args: { action: "references" }, text, expanded: true }));
	assert.match(open, /d.ts/); assert.match(open, /line 3, col 1/); assert.doesNotMatch(open, /line 4, col 1/);
});

test("xd write dispatch uses inner device semantics, help and unknown safe fallback", () => {
	const inner = { xdev: { tool: "bash", mode: "execute", args: { command: "echo hello" }, inner: { exitCode: 0 } } };
	const html = api.card({ name: "write", args: { path: "xd://bash" }, initiallyExpanded: true, result: result("write", "hello", inner) });
	assert.match(html, /data-tool-family="bash"/); assert.match(html, /codicon-terminal/); assert.match(html, /echo hello/); assert.match(html, /hello/);
	for (const tool of ["custom-device", "toString"]) {
		const fallback = api.view(context("write", { args: { path: `xd://${tool}` }, text: "Visible custom output", expanded: true, details: { xdev: { tool, args: { query: "Visible custom request" }, inner: { privateField: "INTERNAL_METADATA" } } } }));
		assert.match(fallback, /Visible custom output/);
		assert.match(fallback, /Visible custom request/);
		assert.doesNotMatch(fallback, /INTERNAL_METADATA/);
	}
	const help = api.card({ name: "write", args: { path: "xd://bash" }, initiallyExpanded: true, result: result("write", "Native bash help", { xdev: { tool: "bash", mode: "help", args: { command: "INTERNAL_EXECUTION_COMMAND" } } }) });
	assert.match(help, /Native bash help/);
	assert.doesNotMatch(help, /INTERNAL_EXECUTION_COMMAND/);
});

test("native output notices retain recovery/counts without exposing internal metadata records", () => {
	const html = api.card({ name: "read", args: { path: "source.ts" }, initiallyExpanded: true, result: result("read", "Visible source", { meta: {
		truncation: { direction: "middle", totalLines: 100, totalBytes: 1000, outputLines: 4, outputBytes: 40, headRange: { start: 1, end: 2 }, tailRange: { start: 99, end: 100 }, artifactId: "captured-output", privateField: "INTERNAL_TRUNCATION" },
		limits: { resultLimit: { reached: 10, suggestion: 20, privateField: "INTERNAL_LIMIT" } }, artifactError: "write", privateField: "INTERNAL_META",
	} }) });
	assert.match(html, /Visible source/);
	assert.match(html, /1–2.*99–100.*100/);
	assert.match(html, /96 middle lines.*960 bytes/);
	assert.match(html, /artifact:\/\/captured-output/);
	assert.match(html, /limit=20/);
	assert.match(html, /artifact write failed/);
	assert.doesNotMatch(html, /INTERNAL_|<dt>direction|<details>/);
});

test("failed closed rows retain an error status without mounting details; skipped failures are neutral", () => {
	const failed = result("read", "Permission denied", {}, true);
	const html = api.card({ name: "read", args: { path: "secret.ts" }, result: failed });
	assert.match(html, /data-tool-status="error"/); assert.match(html, /aria-expanded="false"/);
	assert.doesNotMatch(html, /Permission denied/);
	assert.match(api.card({ name: "read", args: { path: "secret.ts" }, result: failed, initiallyExpanded: true }), /Permission denied/);
	const skipped = api.card({ name: "read", args: {}, status: "skipped", result: failed });
	assert.match(skipped, /data-tool-status="skipped"/); assert.doesNotMatch(skipped, /omp-tool--error/);
});

test("Task compact rows hide context, progress and coordination details until expansion", () => {
	const async = { results: [], async: { state: "running", jobId: "INTERNAL_JOB_ID", type: "task" }, totalDurationMs: 5, privateField: "INTERNAL_PAYLOAD" };
	for (const expanded of [false, true]) {
		const html = api.view(context("task", { args: { context: "# Goal\nShared context details", tasks: [{ name: "ReaderOne", agent: "scout", task: "Inspect source" }] }, expanded, text: "INTERNAL_MODEL_ACK", details: async }));
		assert.match(html, /ReaderOne/); assert.match(html, /scout/); assert.doesNotMatch(html, /Background task started|0ms/);
		assert.equal(html.includes("Shared context details"), expanded);
		assert.doesNotMatch(html, /INTERNAL_|jobId|privateField|totalDurationMs|5ms|<dl|<dt/);
		const running = api.view(context("task", { args: {}, expanded, details: { results: [], progress: [{ id: "ReaderOne", agent: "scout", status: "running", description: "Inspect source", task: "A meaningful expanded assignment", currentTool: "read", lastIntent: "Inspecting source", durationMs: 12345, tokens: 4800, cost: 0.07, agentSource: "INTERNAL_SOURCE", index: 99, parentToolCallId: "INTERNAL_PARENT", outputPath: "INTERNAL_OUTPUT", currentToolArgs: "INTERNAL_TOOL_ARGS", extractedToolData: { privateTool: [{ privateField: "INTERNAL_NESTED" }] } }] } }));
		assert.match(running, /ReaderOne/); assert.match(running, /scout.*running/);
		for (const content of ["Inspecting source", "12.3s", "4.8k tokens", "A meaningful expanded assignment"]) assert.equal(running.includes(content), expanded, content);
		assert.doesNotMatch(running, /INTERNAL_|agentSource|parentToolCallId|outputPath|<dl|<dt/);
	}
	const settled = api.view(context("task", { expanded: true, details: { results: [{ id: "ReaderOne", agent: "scout", exitCode: 0, assignment: "Meaningful assignment", structuredOutput: { status: "success", data: { summary: "Visible structured result" }, privateField: "INTERNAL_WRAPPER" }, usage: { cost: { total: 0.07 } }, outputPath: "INTERNAL_OUTPUT", parentToolCallId: "INTERNAL_PARENT" }] } }));
	assert.match(settled, /Meaningful assignment/); assert.match(settled, /Visible structured result/); assert.match(settled, /\$0\.07/);
	assert.doesNotMatch(settled, /INTERNAL_|outputPath|parentToolCallId|<dl|<dt/);
});

test("Wait orders native job rows and summarizes results without model or ownership payloads", () => {
	const details = { jobs: [
		{ id: "FinishedReader", type: "task", status: "completed", label: "Completed analysis", durationMs: 12000, resultText: '<task-result id="INTERNAL_ENVELOPE"><output>\nVisible result one\nVisible result two\nVisible result three\nVisible result four\nHidden fifth line\n</output></task-result>', resolvedModelIdentity: "INTERNAL_MODEL_ID", resolvedModel: "INTERNAL_MODEL", resolvedThinkingLevel: "INTERNAL_THINKING", agentUrlId: "INTERNAL_AGENT_URL", structured: { privateField: "INTERNAL_RESULT_PAYLOAD" } },
		{ id: "ActiveReader", type: "task", status: "running", label: "Reading source", durationMs: 3000, parentId: "INTERNAL_PARENT" },
	], agents: [{ id: "Peer", activity: "Inspecting source", live: true, ageMs: 2000, parentId: "INTERNAL_PARENT", acceptedAt: 1790907963935 }], cancelled: [{ id: "OldReader", status: "cancelled", message: "Cancellation completed", privateField: "INTERNAL_CANCEL" }] };
	for (const expanded of [false, true]) {
		const html = api.view(context("wait", { expanded, details, text: "INTERNAL_TOP_LEVEL_PAYLOAD" }));
		assert.ok(html.indexOf("ActiveReader") < html.indexOf("FinishedReader"));
		for (const text of ["task", "running", "completed", "12s", "Inspecting source", "Cancellation completed"]) assert.ok(html.includes(text), text);
		assert.equal(html.includes("Visible result one"), expanded);
		assert.doesNotMatch(html, /INTERNAL_|resolvedModel|resolvedThinkingLevel|agentUrlId|acceptedAt|1790907963935|<dl|<dt|Hidden fifth line/);
		assert.equal(html.includes("Visible result four"), expanded);
	}
});

// One header line, nothing beneath it: either a disclosure button or, when expanding would only repeat the line, a plain row.
const oneLine = (html: string): void => {
	assert.equal(html.match(/<button/g)?.length, 1, "one header, nothing beneath it");
	assert.doesNotMatch(html, /omp-wait-rows|data-job-id|omp-tool-body/);
};
const plainRow = (html: string): void => {
	assert.doesNotMatch(html, /<button|aria-expanded|aria-controls|codicon-chevron|omp-tool-body|data-job-id/, "no toggle, chevron or body");
};
const elapsed = (html: string): string | undefined => /omp-tool-elapsed[^>]*>([^<]+)<\/span><\/div>|omp-tool-elapsed[^>]*>([^<]+)<\/span><\/button>/.exec(html)?.slice(1).find(Boolean);
const progress = (...jobs: unknown[]) => ({ content: [{ type: "text", text: "" }], details: { op: "wait", jobs } });
test("a running wait on one plain job is a non-expandable line: spinner, name and a ticking clock in the right slot, no badge", () => {
	const label = "npm run typecheck --silent && npm test";
	const one = api.card({ name: "wait", args: {}, status: "running", partialResult: progress({ id: "bg_21", type: "bash", status: "running", label, durationMs: 113000 }) });
	plainRow(one);
	assert.match(one, /codicon-loading/); assert.match(one, /Waiting on 1 job/); assert.match(one, /bg_21/);
	assert.doesNotMatch(one, /omp-chip/, "the spinner already says it is running");
	assert.equal(elapsed(one), "1m 53s");
	assert.ok(one.includes(`bg_21 · bash · running · 1m 53s · ${label.replaceAll("&", "&amp;")}`), "the tooltip names the job, status, clock and full command");
});

test("a wait stays a disclosure only where expanding adds something the line and tooltip lack", () => {
	const multiline = api.card({ name: "wait", args: {}, status: "running", partialResult: progress({ id: "bg_22", type: "task", status: "running", label: "Reviewer\nsecond line", durationMs: 4000 }) });
	oneLine(multiline);
	assert.match(multiline, /aria-expanded="false"/); assert.doesNotMatch(multiline, /second line/);
	assert.match(api.card({ name: "wait", args: {}, status: "running", initiallyExpanded: true, partialResult: progress({ id: "bg_22", type: "task", status: "running", label: "Reviewer\nsecond line", durationMs: 4000 }) }), /second line/);
	const two = api.card({ name: "wait", args: {}, status: "running", partialResult: progress({ id: "bg_21", type: "bash", status: "running", label: "x", durationMs: 113000 }, { id: "bg_22", type: "task", status: "running", label: "y", durationMs: 4000 }) });
	oneLine(two);
	assert.match(two, /Waiting on 2 jobs/); assert.match(two, /omp-wait-names">bg_21, bg_22</); assert.doesNotMatch(two, /omp-chip/);
	assert.equal(elapsed(two), "1m 53s", "several jobs show the longest clock");
	const mixed = api.card({ name: "wait", args: {}, status: "running", partialResult: progress({ id: "a", type: "bash", status: "running", label: "x", durationMs: 1 }, { id: "b", type: "bash", status: "completed", label: "y", durationMs: 2 }) });
	assert.match(mixed, /Waiting on 1 of 2 jobs/);
	const empty = api.card({ name: "wait", args: {}, status: "running", partialResult: progress() });
	assert.doesNotMatch(empty, /Waiting on/); plainRow(empty);
	const agentOnly = api.card({ name: "wait", args: {}, status: "running", partialResult: { details: { op: "wait", agents: [{ id: "Peer", activity: "Inspecting source", live: true, ageMs: 2000 }] } } });
	plainRow(agentOnly); assert.equal(elapsed(agentOnly), "2s"); assert.ok(agentOnly.includes("Peer · agent · Inspecting source · 2s"));
	const failed = api.card({ name: "wait", args: {}, result: result("wait", "Actual wait failure", { op: "wait", jobs: [{ id: "bg_21", type: "bash", status: "completed", label: "x", durationMs: 1 }] }, true) });
	assert.match(failed, /<button/); assert.match(failed, /omp-tool--error/);
});

test("a finished wait keeps its duration in the right slot: plain when nothing more to show, a disclosure for results, errors and several jobs", () => {
	const job = { id: "FoldersRivals", type: "task", status: "completed", label: "FoldersRivals", durationMs: 1900000 };
	const plain = api.card({ name: "wait", args: {}, intent: "Wait for the rival folders agent", result: result("wait", "", { op: "wait", jobs: [job] }) });
	plainRow(plain);
	assert.match(plain, /FoldersRivals settled/);
	assert.equal(elapsed(plain), "31m 40s");
	assert.ok(plain.lastIndexOf("31m 40s") > plain.lastIndexOf("Wait for the rival folders agent"), "target, intent, then the clock at the right edge");
	assert.doesNotMatch(plain, /1 job settled|1 done|omp-chip/);
	const withResult = api.card({ name: "wait", args: {}, result: result("wait", "", { op: "wait", jobs: [{ ...job, resultText: "VISIBLE_RESULT" }] }) });
	oneLine(withResult); assert.doesNotMatch(withResult, /VISIBLE_RESULT/); assert.equal(elapsed(withResult), "31m 40s");
	assert.match(api.card({ name: "wait", args: {}, initiallyExpanded: true, result: result("wait", "", { op: "wait", jobs: [{ ...job, resultText: "VISIBLE_RESULT" }] }) }), /VISIBLE_RESULT/);
	const jobs = [
		{ id: "bg_21", type: "bash", status: "completed", label: "npm test", durationMs: 125000, exitCode: 0, resultText: "VISIBLE_RESULT" },
		{ id: "bg_22", type: "bash", status: "failed", label: "npm run lint", durationMs: 3000, exitCode: 2, errorText: "VISIBLE_FAILURE" },
		{ id: "bg_23", type: "bash", status: "running", label: "sleep 900", durationMs: 9000 },
	];
	const several = api.card({ name: "wait", args: {}, result: result("wait", "", { op: "wait", jobs }) });
	oneLine(several);
	assert.match(several, /2 jobs settled/); assert.match(several, /1 done/); assert.match(several, /1 failed/);
	assert.match(several, /omp-wait-names">bg_21, bg_22</); assert.equal(elapsed(several), "2m 05s");
	assert.ok(several.includes("bg_22 · bash · failed · 3s · exit 2 · npm run lint"), "every job's status, clock and exit code stay in the tooltip");
	assert.doesNotMatch(several, /bg_23|sleep 900|VISIBLE_RESULT|VISIBLE_FAILURE/);
	const open = api.card({ name: "wait", args: {}, initiallyExpanded: true, result: result("wait", "", { op: "wait", jobs }) });
	assert.match(open, /VISIBLE_RESULT/); assert.match(open, /VISIBLE_FAILURE/); assert.match(open, /data-job-id="bg_21"/);
});

test("running and failed tools have one status icon rather than a repeated badge, while skipped calls remain explicit", () => {
	const running = api.card({ name: "bash", args: { command: "sleep 5" }, status: "running" });
	assert.match(running, /data-tool-status="running"/); assert.match(running, /codicon-loading/); assert.doesNotMatch(running, /omp-chip/);
	const failed = api.card({ name: "bash", args: { command: "false" }, status: "error", result: result("bash", "boom", { exitCode: 1 }, true), initiallyExpanded: true });
	assert.equal((failed.match(/codicon-error/g) ?? []).length, 1);
	assert.doesNotMatch(failed, /omp-chip--err/);
	assert.equal((failed.match(/boom/g) ?? []).length, 1, "stderr is not repeated in an Error block");
	assert.match(api.card({ name: "bash", args: { command: "x" }, status: "skipped" }), /omp-chip">skipped</);
});

test("normal semantic families ignore arbitrary detail trees but retain their native user content", () => {
	const cases: [string, Partial<ToolRenderContext>, string][] = [
		["debug", { details: { snapshot: { status: "stopped", program: "sample.exe", id: "INTERNAL_SESSION", instructionPointerReference: "INTERNAL_IP", privateField: "INTERNAL_SNAPSHOT" } }, text: "Visible debugger output" }, "Visible debugger output"],
		["eval", { details: { statusEvents: [{ op: "log", message: "Visible evaluation status", privateField: "INTERNAL_EVENT" }], jsonOutputs: [{ answer: "Visible display output" }], async: { jobId: "INTERNAL_EVAL_JOB" } }, text: "Visible evaluation output" }, "Visible evaluation status"],
		["write", { args: { path: "cfg://thinking", content: "high" }, details: { cfg: { path: "thinking", previous: "low", value: "high", privateField: "INTERNAL_CFG" } } }, "high"],
		["read", { args: { path: "proc://service" }, details: { proc: { daemons: [{ name: "DevService", state: "running", id: "INTERNAL_DAEMON", privateField: "INTERNAL_PROC" }], log: "Visible service log" } } }, "Visible service log"],
		["read", { args: { path: "https://example.test" }, details: { contentType: "text/plain", displayContent: { text: "Visible page content" }, method: "INTERNAL_METHOD", notes: { privateField: "INTERNAL_HTTP" } } }, "Visible page content"],
		["lsp", { args: { action: "hover", file: "sample.ts" }, details: { serverName: "INTERNAL_SERVER", privateField: "INTERNAL_LSP" }, text: "Visible symbol documentation" }, "Visible symbol documentation"],
		["todo", { details: { phases: [{ name: "Ship", tasks: [{ content: "Visible task", status: "pending" }] }], storage: { path: "INTERNAL_STORAGE" }, completedTasks: [{ privateField: "INTERNAL_TRANSITION" }] } }, "Visible task"],
		["goal", { details: { goal: { objective: "Visible objective", status: "active", tokensUsed: 20, tokenBudget: 100, timeUsedSeconds: 12, privateField: "INTERNAL_GOAL" } } }, "Visible objective"],
		["github", { details: { repo: "INTERNAL_REPO", checkouts: [{ privateField: "INTERNAL_CHECKOUT" }] }, text: "Visible GitHub output" }, "Visible GitHub output"],
		["vibe_spawn", { args: { name: "ShellWorker", prompt: "Visible worker prompt" }, details: { spawned: { id: "ShellWorker", cli: "native", jobId: "INTERNAL_VIBE_JOB" } } }, "Turn started"],
		["write", { args: { path: "agent://Peer", content: "Visible peer message" }, details: { message: { to: "Peer", receipts: [{ to: "Peer", outcome: "delivered", privateField: "INTERNAL_RECEIPT" }] } } }, "Visible peer message"],
		["extension-tool", { args: { query: "Visible request" }, details: { privateField: "INTERNAL_UNKNOWN" }, text: '{"answer":"Visible native JSON result"}' }, "Visible native JSON result"],
	];
	for (const [name, patch, expected] of cases) for (const expanded of [false, true]) {
		const html = api.view(context(name, { ...patch, expanded }));
		assert.ok(html.includes(expected), `${name}: ${expected}`);
		assert.doesNotMatch(html, /INTERNAL_|privateField|<dl|<dt/, name);
	}
});

test("live edit content is exposed immediately but empty preparation and terminal results collapse", () => {
	assert.match(api.card({ name: "write", args: { path: "live.ts", content: "const livePreview = 1;" }, running: true }), /const livePreview/);
	assert.doesNotMatch(api.card({ name: "edit", args: { path: "live.ts" }, running: true }), /omp-tool-body/);
	assert.doesNotMatch(api.card({ name: "write", args: { path: "live.ts", content: "const livePreview = 1;" }, result: result("write", "Written") }), /const livePreview|omp-tool-body/);
});

test("a pending Ask names the user wait, not execution, with a question icon and no spinner or status pill", () => {
	for (const initiallyExpanded of [false, true]) {
		const html = api.card({ name: "ask", status: "running", args: { questions: [{ id: "scope", question: "Which scope?", options: ["Whole repository", "One file"] }] }, initiallyExpanded });
		assert.match(html, /codicon-question/);
		assert.match(html, /Waiting for your answer/);
		assert.doesNotMatch(html, /codicon-loading|codicon-modifier-spin|omp-chip|role="status">running/);
		assert.equal(html.includes("Whole repository"), initiallyExpanded, "details remain lazy");
	}
	const answered = api.card({ name: "ask", args: { question: "Which scope?" }, result: result("ask", "Whole repository") });
	assert.doesNotMatch(answered, /Waiting for your answer/);
});

test("change events prefer the known model display name and readable thinking labels", () => {
	const base = { id: "change", parentId: null, timestamp: "2026-10-08T00:00:00Z" };
	const named = api.native({ entry: { ...base, type: "model_change", model: "native-model-id" }, model: { id: "native-model-id", name: "Friendly Model" } });
	assert.match(named, /Friendly Model/);
	assert.doesNotMatch(named, /native-model-id/);
	const qualified = api.native({ entry: { ...base, type: "model_change", model: "native/native-model-id" }, model: { provider: "native", id: "native-model-id", name: "Friendly Model" } });
	assert.match(qualified, /Friendly Model/);
	assert.doesNotMatch(qualified, /native-model-id/);
	assert.match(api.native({ entry: { ...base, type: "thinking_level_change", thinkingLevel: "xhigh" } }), /Extra high/);
	const reminder = api.native({ entry: { ...base, type: "custom_message", customType: "native:todo_reminder", content: [], display: true, details: { attempt: 1, maxAttempts: 3, todos: [{ content: "Finish implementation", status: "in_progress", blocker: "Need access" }] } } });
	assert.match(reminder, /Finish implementation.*in progress/);
	assert.match(reminder, /Need access/);
	assert.doesNotMatch(reminder, /in_progress|omp-warning/);
});

test("agent stats share compact token units, pluralize tools and can omit elapsed already shown by the parent", () => {
	const progress = { toolCount: 1, tokens: 1_000_000, contextTokens: 307_000, contextWindow: 1_000_000, durationMs: 145_000 };
	const shown = api.progress({ progress });
	assert.match(shown, /1 tool · 1M tokens · context 307k\/1M · 2m 25s/);
	assert.doesNotMatch(shown, /1 tools/);
	assert.doesNotMatch(api.progress({ progress, showElapsed: false }), /2m 25s/);
});

test("goal and workflow statistics reuse the same token and duration units", () => {
	const goal = api.view(context("goal", { details: { goal: { objective: "Finish the change", tokensUsed: 307_000, tokenBudget: 1_000_000, timeUsedSeconds: 145 } } }));
	assert.match(goal, /307k \/ 1M tokens \(693k left\).*2m 25s/);
	const workflow = api.view(context("github", { details: { watch: { mode: "watch", runs: [{ workflowName: "Checks", jobs: [{ name: "Compile", status: "completed", durationSeconds: 3720 }] }] } } }));
	assert.match(workflow, /1h 02m/);
});

test("diagnostic warning chips carry a decorative warning codicon instead of colored text alone", () => {
	const html = api.card({ name: "edit", args: {}, result: result("edit", "Updated"), attachments: [{ role: "custom", customType: "native:late_diagnostics", display: true, content: "", timestamp: 1, details: { files: [{ path: "src/app.ts", messages: ["Review the changed expression"] }] } }] });
	assert.match(html, /class="omp-chip omp-chip--warn"><span class="codicon codicon-warning" aria-hidden="true"/);
});
