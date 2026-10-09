import assert from "node:assert/strict";
import { it } from "node:test";
import { applyChatEntries, applyChatLiteState, applyChatOlder, applyChatRewrite, applyChatSnapshot, createChatModel, markPendingUnsaved, reduceChatFrame, setChatPhase, snapshotOf } from "./model.ts";
import { positionTranscript } from "./projection.ts";
import type { AssistantMessage, ChatEntry, ChatMessage } from "./messages.ts";
import type { ChatModel } from "./model.ts";

const phases = (content: string) => [{ name: "Work", tasks: [{ content, status: "pending" as const }] }];
const user = (timestamp: number): ChatMessage => ({ role: "user", timestamp, content: `User ${timestamp}` });
const entry = (id: string, message: ChatMessage): ChatEntry => ({ type: "message", id, parentId: null, timestamp: new Date(message.timestamp).toISOString(), message });
const state = { model: null, thinkingLevel: null, isStreaming: false, isCompacting: false, queuedMessageCount: 0 };
const end = (model: ChatModel, id: string, message: ChatMessage) => reduceChatFrame(model, { type: "message_end", messageId: id, message });
const visibleIds = (model: ChatModel) => positionTranscript(model.entries, model.durableCount, model.pending, model.ephemeral).map(row => row.id);

it("keeps a live notice between messages as both messages become durable and across a page reset", () => {
	let model = end(createChatModel(), "first", user(1));
	model = reduceChatFrame(model, { type: "notice", level: "warning", message: "Between" }, { now: 2 });
	model = end(model, "second", user(3));
	model = applyChatEntries(model, [entry("saved-first", user(1)), entry("saved-second", user(3))], "saved-second");
	assert.deepEqual(visibleIds(model), ["saved-first", "event:2", "saved-second"]);
	assert.equal(model.durableCount, 2);
	const restored = applyChatSnapshot(createChatModel(), snapshotOf(model, { nonce: "host", counter: 1 }));
	assert.deepEqual(visibleIds(restored), visibleIds(model));
	model = applyChatRewrite(model, [entry("saved-second", user(3))], 0, "saved-second");
	assert.deepEqual(visibleIds(model), ["saved-second"], "a native rebuild drops a notification whose anchor disappeared");
});

it("hides OMP's xd:// mount announcement but keeps other notices, including xdev warnings", () => {
	let model = reduceChatFrame(createChatModel(), { type: "notice", level: "info", message: "xd://: mounted mcp_a, mcp_b", source: "xdev" }, { now: 1 });
	assert.deepEqual(model.ephemeral, []);
	model = reduceChatFrame(model, { type: "notice", level: "warning", message: "xd://: mount failed", source: "xdev" }, { now: 2 });
	model = reduceChatFrame(model, { type: "notice", level: "info", message: "Plan autosaved.", source: "plan-yolo" }, { now: 3 });
	assert.deepEqual(model.ephemeral.map(item => item.payload), [
		{ type: "notice", level: "warning", message: "xd://: mount failed", source: "xdev" },
		{ type: "notice", level: "info", message: "Plan autosaved.", source: "plan-yolo" },
	]);
});

it("merges only adjacent TTSR notices, not notices separated by a message", () => {
	let model = reduceChatFrame(createChatModel(), { type: "ttsr_triggered", rules: [{ name: "a" }] });
	model = reduceChatFrame(model, { type: "ttsr_triggered", rules: [{ name: "b" }] });
	assert.deepEqual(model.ephemeral[0]!.payload, { type: "ttsr_triggered", rules: [{ name: "a" }, { name: "b" }] });
	model = end(model, "separator", user(1));
	model = reduceChatFrame(model, { type: "ttsr_triggered", rules: [{ name: "c" }] });
	assert.deepEqual(visibleIds(model), ["event:1", "live:separator", "event:3"]);
});

it("reconciles saved custom messages while transient/hidden context never becomes an unsaved warning", () => {
	const custom: ChatMessage = { role: "custom", timestamp: 10, customType: "extension-note", content: "Note", display: true };
	let model = end(createChatModel(), "note", custom);
	model = applyChatEntries(model, [{ type: "custom_message", id: "saved", parentId: null, timestamp: new Date(10).toISOString(), customType: "extension-note", content: "Note", display: true }], "saved");
	assert.equal(model.pending.size, 0);
	model = end(model, "hidden", { ...custom, customType: "hidden", timestamp: 11, display: false });
	model = end(model, "vibe", { ...custom, customType: "vibe-mode-context", timestamp: 12, display: false });
	model = markPendingUnsaved(model);
	assert.deepEqual([...model.pending.keys()], ["live:hidden"]);
	assert.equal(model.pending.get("live:hidden")!.unsaved, false);
});

it("state cuts and explicit empty clears beat delayed history, while successful non-view live todo changes still apply", () => {
	const todo = (id: string, content: string): ChatEntry => entry(id, { role: "toolResult", timestamp: 1, toolCallId: id, toolName: "todo", content: [], isError: false, details: { op: "update", phases: phases(content) } });
	let model = applyChatEntries(createChatModel(), [todo("old", "Old")], "old");
	model = applyChatLiteState(model, state, phases("Current"));
	model = applyChatEntries(model, [todo("delayed", "Delayed")], "delayed");
	model = applyChatOlder(model, [todo("older", "Older")], 0);
	model = reduceChatFrame(model, { type: "todo_auto_clear" });
	assert.equal(model.todo!.phases[0]!.tasks[0]!.content, "Current");
	model = reduceChatFrame(model, { type: "tool_execution_end", toolCallId: "new", toolName: "todo", result: { details: { op: "update", phases: phases("Live") } } });
	assert.equal(model.todo!.phases[0]!.tasks[0]!.content, "Live");
	model = reduceChatFrame(model, { type: "tool_execution_end", toolCallId: "view", toolName: "todo", result: { details: { op: "view", phases: [] } } });
	assert.equal(model.todo!.phases[0]!.tasks[0]!.content, "Live");
	model = applyChatLiteState(model, state, []);
	assert.deepEqual(model.todo!.phases, []);
});

it("keeps detached roster membership after the root settles and ignores unknown/conflicting progress", () => {
	const payload = { id: "child", index: 0, agent: "scout", agentSource: "builtin", parentToolCallId: "owner", status: "started" as const };
	let model = reduceChatFrame(createChatModel(), { type: "subagent_lifecycle", payload });
	model = reduceChatFrame(model, { type: "subagent_progress", payload: { ...payload, task: "Work", progress: { id: "unknown", status: "running" } } });
	model = reduceChatFrame(model, { type: "subagent_progress", payload: { ...payload, parentToolCallId: "other", task: "Conflict", progress: { id: "child", status: "completed" } } });
	model = reduceChatFrame(model, { type: "agent_end" });
	model = reduceChatFrame(model, { type: "session_settled" });
	assert.equal(model.agents.size, 1);
	assert.equal(model.agents.get("child")!.status, "running");
	model = reduceChatFrame(model, { type: "subagent_lifecycle", payload: { ...payload, status: "completed" } });
	assert.equal(model.agents.size, 0);
	model = reduceChatFrame(model, { type: "subagent_lifecycle", payload });
	assert.equal(setChatPhase(model, "stopped", null).agents.size, 0);
});

it("patches retry recovery on held durable and pending errors and retracts only synthetic work", () => {
	const assistant: AssistantMessage = { role: "assistant", timestamp: 10, model: "m", provider: "p", stopReason: "error", content: [{ type: "toolCall", id: "synthetic", name: "read", arguments: {} }, { type: "toolCall", id: "real", name: "read", arguments: {} }], errorMessage: "Provider failed" };
	let model = applyChatEntries(createChatModel(), [entry("error", assistant), entry("skip", { role: "toolResult", timestamp: 11, toolCallId: "synthetic", toolName: "read", content: [], isError: true, details: { source: "interrupt_skipped", __synthetic: true } }), entry("real", { role: "toolResult", timestamp: 12, toolCallId: "real", toolName: "read", content: [{ type: "text", text: "Real work" }], isError: false })], "real");
	model = end(model, "pending-error", { ...assistant, timestamp: 20 });
	model = reduceChatFrame(model, { type: "auto_retry_end", success: true, attempt: 2, retryErrors: [
		{ entryId: "error", note: "Superseded", retryRecovery: { kind: "auto-retry", status: "superseded", attempt: 2, recovery: "wait", note: "Superseded" } },
		{ entryId: "not-loaded", persistenceKey: "assistant:20:p:m::error", note: "Recovered", retryRecovery: { kind: "auto-retry", status: "recovered", attempt: 2, recovery: "wait", note: "Recovered" } },
	] });
	const pending = model.entries.at(-1)!;
	assert.equal(pending.type === "message" && pending.message.role === "assistant" && pending.message.retryRecovery?.status, "recovered");
	assert.deepEqual(model.retrySuppressedIds, ["synthetic"]);
	assert.equal(model.entries.find(row => row.id === "real")?.type, "message");
});

it("holds a streaming assistant before notices through completion, snapshot restoration and durable reconciliation", () => {
	const assistant: AssistantMessage = { role: "assistant", timestamp: 10, model: "m", stopReason: "stop", content: [{ type: "text", text: "Streaming answer" }] };
	let model = reduceChatFrame(createChatModel(), { type: "ttsr_triggered", rules: [{ name: "before" }] });
	model = reduceChatFrame(model, { type: "message_start", messageId: "stream", message: assistant });
	model = reduceChatFrame(model, { type: "ttsr_triggered", rules: [{ name: "after" }] });
	assert.equal(model.ephemeral.length, 2, "a live message seals consecutive TTSR coalescing");
	const positioned = () => positionTranscript(model.entries, model.durableCount, model.pending, model.ephemeral, model.stream && model.streamId && model.streamPosition ? { message: model.stream, messageId: model.streamId, position: model.streamPosition } : null, model.durablePositions).map(row => row.id);
	assert.deepEqual(positioned(), ["event:1", "live:stream", "event:3"]);
	model = applyChatSnapshot(createChatModel(), snapshotOf(model, { nonce: "host", counter: 1 }));
	assert.deepEqual(positioned(), ["event:1", "live:stream", "event:3"]);
	model = end(model, "stream", assistant);
	assert.deepEqual(positioned(), ["event:1", "live:stream", "event:3"]);
	model = applyChatEntries(model, [entry("saved", assistant)], "saved");
	assert.deepEqual(positioned(), ["event:1", "saved", "event:3"]);
	model = applyChatSnapshot(createChatModel(), snapshotOf(model, { nonce: "host", counter: 2 }));
	assert.deepEqual(positioned(), ["event:1", "saved", "event:3"]);
});
