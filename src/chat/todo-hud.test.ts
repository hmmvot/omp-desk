/** When the Chat's TODO row shows (`src/chat/todo-hud.ts`) and how the model carries a cleared row. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ChatSnapshotAssembler, parseChatHostMessage, splitChatSnapshot } from "../protocol/chat-messages.ts";
import { applyChatLiteState, applyChatSnapshot, createChatModel, reduceChatFrame, snapshotOf, type ChatLiteState, type ChatModel } from "./model.ts";
import { DEFAULT_TODO_CLEAR_DELAY_SECONDS, todoClearDelayMs, todoFingerprint, todoListClosed, todoRowShown } from "./todo-hud.ts";
import { projectTodo, sameTodoPhases, type TodoPhase, type TodoStatus } from "./todos.ts";

const EPOCH = { nonce: "todo-hud", counter: 1 };
const LITE: ChatLiteState = { model: null, thinkingLevel: null, isStreaming: false, isCompacting: false, queuedMessageCount: 0 };

function phases(...statuses: readonly TodoStatus[]): TodoPhase[] {
	return [{ name: "Work", tasks: statuses.map((status, index) => ({ content: `Task ${index}`, status })) }];
}

/** A model that holds `list` the way a live todo result puts it there. */
function holding(list: readonly TodoPhase[]): ChatModel {
	return reduceChatFrame(createChatModel(), { type: "tool_execution_end", toolCallId: "t", toolName: "todo", result: { details: { op: "update", phases: list } } });
}

describe("todoFingerprint", () => {
	it("is OMP's list identity: names, task text, statuses and blockers, and nothing else", () => {
		const list: TodoPhase[] = [{ name: "P", tasks: [{ content: "a", status: "completed", notes: ["n"], details: "d" }, { content: "b", status: "blocked", blocker: "CI" }] }];
		assert.equal(todoFingerprint(list), '[{"name":"P","tasks":[{"content":"a","status":"completed"},{"content":"b","status":"blocked","blocker":"CI"}]}]');
		assert.equal(todoFingerprint([{ name: "P", tasks: [{ content: "a", status: "completed" }, { content: "b", status: "blocked", blocker: "CI" }] }]), todoFingerprint(list), "notes and details are not part of it");
	});
});

describe("todoListClosed", () => {
	it("holds only for a list with tasks of which every one is completed or abandoned", () => {
		assert.equal(todoListClosed(phases("completed", "abandoned")), true);
		assert.equal(todoListClosed([...phases("completed"), { name: "Empty", tasks: [] }, ...phases("abandoned")]), true);
		for (const open of ["pending", "in_progress", "blocked"] as const) assert.equal(todoListClosed(phases("completed", open)), false, open);
		assert.equal(todoListClosed([]), false);
		assert.equal(todoListClosed([{ name: "Empty", tasks: [] }]), false);
	});
});

describe("todoClearDelayMs", () => {
	it("judges the setting as OMP does and takes the default only for a setting that could not be read", () => {
		assert.equal(DEFAULT_TODO_CLEAR_DELAY_SECONDS, 60);
		assert.equal(todoClearDelayMs(undefined), 60_000);
		assert.equal(todoClearDelayMs(0), 0);
		assert.equal(todoClearDelayMs(300), 300_000);
		for (const never of [-1, -0.5, Number.NaN, Number.POSITIVE_INFINITY, "60", null, true, 3_000_000]) assert.equal(todoClearDelayMs(never), null, String(never));
	});
});

describe("projectTodo", () => {
	it("keeps the cleared row for the same list and shows any other list", () => {
		const cleared = { phases: phases("completed"), entryId: "a", hidden: true };
		assert.equal(projectTodo(cleared, phases("completed"), "a"), cleared, "the very same projection when nothing changed");
		assert.deepEqual(projectTodo(cleared, phases("completed"), "b"), { phases: phases("completed"), entryId: "b", hidden: true });
		assert.deepEqual(projectTodo(cleared, phases("completed", "pending"), "a"), { phases: phases("completed", "pending"), entryId: "a", hidden: false });
		assert.deepEqual(projectTodo(null, phases("completed"), null), { phases: phases("completed"), entryId: null, hidden: false });
		assert.equal(sameTodoPhases([{ name: "P", tasks: [{ content: "a", status: "pending" }] }], [{ name: "P", tasks: [{ content: "a", status: "pending", notes: ["x"] }] }]), false, "a note is a change, as in the terminal UI");
	});
});

describe("the model's cleared row", () => {
	it("hides on the host's frame, keeps the list for every other reader, and shows again when the list changes", () => {
		let model = holding(phases("completed", "abandoned"));
		assert.equal(todoRowShown(model.todo), true);
		model = reduceChatFrame(model, { type: "todo_hud_hide" });
		assert.equal(model.todo?.hidden, true);
		assert.equal(todoRowShown(model.todo), false);
		assert.deepEqual(model.todo?.phases, phases("completed", "abandoned"), "the list is untouched: the TODO tab still reads it");
		assert.equal(reduceChatFrame(model, { type: "todo_hud_hide" }), model, "a second frame changes nothing");
		const same = reduceChatFrame(model, { type: "tool_execution_end", toolCallId: "t2", toolName: "todo", result: { details: { op: "update", phases: phases("completed", "abandoned") } } });
		assert.equal(same.todo?.hidden, true, "the same list stays cleared");
		const changed = reduceChatFrame(model, { type: "tool_execution_end", toolCallId: "t3", toolName: "todo", result: { details: { op: "update", phases: phases("completed", "abandoned", "pending") } } });
		assert.equal(changed.todo?.hidden, false);
		assert.equal(todoRowShown(changed.todo), true);
		assert.equal(reduceChatFrame(createChatModel(), { type: "todo_hud_hide" }).todo, null, "no list, nothing to hide");
	});

	it("keeps the cleared row through a state cut that reports the same list and drops it for another", () => {
		const cleared = reduceChatFrame(holding(phases("completed")), { type: "todo_hud_hide" });
		assert.equal(applyChatLiteState(cleared, LITE, phases("completed")).todo?.hidden, true);
		assert.equal(applyChatLiteState(cleared, LITE, phases("completed", "completed")).todo?.hidden, false);
		assert.equal(applyChatLiteState(cleared, LITE, []).todo?.hidden, false, "an emptied list leaves nothing to hide");
	});

	it("crosses host to page in a snapshot, whole or in chunks, and the page's list is cleared too", () => {
		const cleared = reduceChatFrame(holding(phases("completed")), { type: "todo_hud_hide" });
		const payload = snapshotOf(cleared, EPOCH);
		assert.equal(payload.todoHidden, true);
		assert.equal(applyChatSnapshot(createChatModel(), payload).todo?.hidden, true);
		const parts = splitChatSnapshot(payload, "s1");
		const head = parseChatHostMessage(parts.snapshot);
		assert.ok(head !== null && head.type === "omp:chat-snapshot");
		const assembled = new ChatSnapshotAssembler().begin(head.type === "omp:chat-snapshot" ? head : parts.snapshot);
		assert.equal(assembled?.todoHidden, true);
		assert.equal(snapshotOf(holding(phases("completed")), EPOCH).todoHidden, false);
		assert.equal(snapshotOf(createChatModel(), EPOCH).todoHidden, false);
		const refused = { ...parts.snapshot, head: { ...parts.snapshot.head, todoHidden: "yes" } };
		assert.equal(parseChatHostMessage(refused), null, "a snapshot whose flag is not a boolean is refused");
	});

	it("accepts the host's frame on the wire", () => {
		const event = parseChatHostMessage({ type: "omp:chat-event", epoch: EPOCH, frame: { type: "todo_hud_hide" } });
		assert.ok(event !== null && event.type === "omp:chat-event");
		assert.equal(reduceChatFrame(holding(phases("completed")), event.frame).todo?.hidden, true);
	});
});
