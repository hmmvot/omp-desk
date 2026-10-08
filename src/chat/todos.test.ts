import assert from "node:assert/strict";
import { it } from "node:test";
import { latestTodoFromEntries, parseTodoPhases, todoHudSelection, todoMatchesDescriptions, todoPhasesFromToolResult } from "./todos.ts";
import type { TodoPhase } from "./todos.ts";

it("selects current phase independently from the first in-progress task and counts abandoned as closed", () => {
 const phases: TodoPhase[] = [
  { name: "First", tasks: [{ content: "Done", status: "completed" }, { content: "Dropped", status: "abandoned" }, { content: "Waiting", status: "blocked", blocker: "CI" }, { content: "Next", status: "pending" }] },
  { name: "Second", tasks: [{ content: "Current", status: "in_progress", details: "Details", notes: ["Note"] }] },
 ];
 const selected = todoHudSelection(phases);
 assert.equal(selected.phase?.name, "First");
 assert.equal(selected.task?.content, "Current");
 assert.deepEqual([selected.phaseClosed, selected.phaseTotal, selected.closed, selected.total], [2, 4, 2, 5]);
 assert.equal(todoHudSelection([{ name: "Blocked", tasks: [{ content: "Wait", status: "blocked" }] }]).task, null);
 assert.equal(todoHudSelection([{ name: "Empty", tasks: [] }, { name: "Closed", tasks: [{ content: "Finished", status: "abandoned" }] }]).phase?.name, "Closed");
});

it("does not replace canonical todos with errors, views or malformed partial phases", () => {
 const phases = [{ name: "Work", tasks: [{ content: "Task", status: "pending", blocker: "CI", details: "More", notes: ["Note"] }] }];
 assert.deepEqual(todoPhasesFromToolResult({ details: { op: "update", phases } }), phases);
 assert.equal(todoPhasesFromToolResult({ isError: true, details: { op: "update", phases } }), null);
 assert.equal(todoPhasesFromToolResult({ details: { op: "view", phases } }), null);
 assert.equal(parseTodoPhases([...phases, { name: "Bad", tasks: [{ content: "Invalid", status: "later" }] }]), null);
 assert.deepEqual(latestTodoFromEntries([{ type: "custom", id: "edit", parentId: null, timestamp: "2026-10-02T00:00:00Z", customType: "user_todo_edit", data: { phases: [] } }]), { phases: [], entryId: "edit" });
});

it("matches live descriptions using native Unicode and six-character containment rules", () => {
 assert.equal(todoMatchesDescriptions("Review: αβγδεζη", ["review αβγδεζη now"]), true);
 assert.equal(todoMatchesDescriptions("API", ["API"]), true);
 assert.equal(todoMatchesDescriptions("API", ["fix API"]), false);
 assert.equal(todoMatchesDescriptions("!!!", ["!!!"]), false);
});
