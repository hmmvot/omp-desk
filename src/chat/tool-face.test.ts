import assert from "node:assert/strict";
import { it } from "node:test";
import { diffStats, editDiffStats } from "./diff-stats.ts";
import { todoCounter, todoOperationText } from "./todos.ts";
import { toolPresentation } from "./tool-presentation.ts";
import type { ProjectedTool } from "./transcript.ts";

const call = (name: string, args: Record<string, unknown>, details?: Record<string, unknown>, status: ProjectedTool["status"] = "complete"): ProjectedTool => ({
	entryId: "e", call: { type: "toolCall", id: "c", name, arguments: args },
	result: details === undefined ? undefined : { role: "toolResult", timestamp: 1, toolCallId: "c", toolName: name, content: [], isError: false, details },
	status, mutable: false, attachments: [],
});

it("counts content lines of unified diffs and ignores the file headers", () => {
	assert.deepEqual(diffStats(["--- a/x\n+++ b/x\n@@ -1,2 +1,3 @@\n-old\n+new\n+more\n context", undefined, "+solo"]), { added: 3, removed: 1 });
	assert.deepEqual(diffStats([]), { added: 0, removed: 0 });
});

it("sums the per-file diffs of an edit call and stays empty while no diff is known", () => {
	const settled = { args: {}, stream: {}, settled: true };
	assert.deepEqual(editDiffStats({ ...settled, details: { perFileResults: [{ diff: "+a\n+b" }, { diff: "-c" }] } }), { added: 2, removed: 1 });
	assert.deepEqual(editDiffStats({ ...settled, details: { diff: "-x\n+y" } }), { added: 1, removed: 1 });
	assert.equal(editDiffStats({ args: {}, details: {}, stream: {}, settled: false }), null);
	assert.deepEqual(editDiffStats({ args: {}, details: {}, stream: { files: [{ diff: "+live" }] }, settled: false }), { added: 1, removed: 0 });
});

it("an edit call's presentation carries its workspace-relative path and its added and removed counts", () => {
	const presentation = toolPresentation(call("edit", { path: "C:\\repo\\src\\a.ts" }, { path: "C:\\repo\\src\\a.ts", diff: "-a\n+b\n+c" }), "C:/repo");
	assert.equal(presentation.target, "src/a.ts");
	assert.deepEqual(presentation.stats, { added: 2, removed: 1 });
	assert.equal(toolPresentation(call("read", { path: "a.ts" }, {}), "C:/repo").stats, null);
});

it("titles an eval call by the language it runs: Python, JavaScript, and a neutral Eval when unknown or mixed", () => {
	const title = (args: Record<string, unknown>, details?: Record<string, unknown>) => toolPresentation(call("eval", args, details, details === undefined ? "running" : "complete")).title;
	assert.equal(title({ language: "py", code: "print(1)" }), "Python");
	assert.equal(title({ language: "js", code: "1" }), "JavaScript");
	assert.equal(title({ language: "js", code: "1" }, { language: "javascript", cells: [{ language: "javascript", code: "1" }] }), "JavaScript", "OMP's result names the language in full");
	assert.equal(title({ code: "1" }, { cells: [{ language: "python", code: "1" }] }), "Python");
	assert.equal(title({ cells: [{ language: "js", code: "1" }] }), "JavaScript", "cells still being streamed");
	assert.equal(title({}), "Eval", "arguments still streaming");
	assert.equal(title({ language: "ruby", code: "1" }), "Eval");
	assert.equal(title({ language: "constructor", code: "1" }), "Eval");
	assert.equal(title({}, { cells: [{ language: "python", code: "1" }, { language: "javascript", code: "2" }] }), "Eval", "mixed languages");
	assert.equal(toolPresentation(call("python", { code: "1" })).title, "Python");
	assert.equal(toolPresentation(call("eval", { language: "js", code: "1" }, {})).category, "command");
});

it("names what a todo call did and to which task", () => {
	assert.equal(todoOperationText({ ops: [{ op: "start", task: "Write tests" }] }, ""), "Started “Write tests”");
	assert.equal(todoOperationText({ ops: [{ op: "done", task: "Write tests" }, { op: "start", task: "Ship" }] }, ""), "Done “Write tests”, Started “Ship”");
	assert.equal(todoOperationText({ ops: [{ op: "init", list: [{ items: ["a", "b"] }, { items: ["c"] }] }] }, ""), "Planned 3 tasks");
	assert.equal(todoOperationText({ ops: [{ op: "append", items: ["a"] }] }, ""), "Added 1 task");
	assert.equal(todoOperationText({ op: "view" }, ""), "Viewed list");
	assert.equal(todoOperationText({}, "view"), "Viewed list");
	assert.equal(todoOperationText({ ops: [{ op: "drop", phase: "Later" }] }, ""), "Dropped phase “Later”");
	assert.equal(todoOperationText({}, ""), "");
});

it("counts closed tasks over every phase of a todo result", () => {
	const phases = [{ name: "A", tasks: [{ content: "1", status: "completed" }, { content: "2", status: "abandoned" }] }, { name: "B", tasks: [{ content: "3", status: "pending" }, { content: "4", status: "in_progress" }] }];
	assert.equal(todoCounter(phases), "2/4");
	assert.equal(todoCounter([]), null);
	assert.equal(todoCounter("not phases"), null);
	const presentation = toolPresentation(call("todo", { ops: [{ op: "done", task: "1" }] }, { phases }));
	assert.equal(presentation.target, "Done “1”");
	assert.equal(presentation.counter, "2/4");
});
