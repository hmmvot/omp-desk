import assert from "node:assert/strict";
import { it } from "node:test";
import { agentRow } from "./hud-summary.ts";
import { applyChatEntries, applyChatSnapshot, createChatModel, reduceChatFrame, snapshotOf } from "./model.ts";
import type { ChatEntry } from "./messages.ts";
import type { ChatModel } from "./model.ts";

const WAKE = "New assignment (lead), task 7: Chat ask dialog layout. Repo C:/src/sample-app, branch master.";
const owner = { parentToolCallId: "call-1" };
const started = { id: "AskDialogRefresh", index: 0, agent: "implementer", agentSource: "bundled", ...owner, status: "started" as const };
const row = (model: ChatModel) => agentRow(model.agents.get("AskDialogRefresh")!, undefined);

/** The spawn: an assignment, a late tiny-model label, then the native roster drops the agent when it parks. */
function spawnedAndParked(): ChatModel {
	let model = reduceChatFrame(createChatModel(), { type: "subagent_lifecycle", payload: started });
	model = reduceChatFrame(model, { type: "subagent_progress", payload: { ...started, task: "# wrapped template\nImplement the ask dialog", assignment: "Implement the ask dialog\nsecond line", progress: { id: "AskDialogRefresh", status: "running" } } });
	model = reduceChatFrame(model, { type: "subagent_progress", payload: { ...started, task: "# wrapped template\nImplement the ask dialog", assignment: "Implement the ask dialog\nsecond line", progress: { id: "AskDialogRefresh", status: "running", description: "Ask dialog layout" } } });
	return reduceChatFrame(model, { type: "subagent_lifecycle", payload: { ...started, status: "completed" } });
}

it("a revived agent keeps the id, type badge and spawn description instead of the IRC message that woke it", () => {
	let model = spawnedAndParked();
	assert.equal(model.agents.size, 0);
	// The wake frames: same id and type, no label, the message as `task`, no `assignment`.
	model = reduceChatFrame(model, { type: "subagent_lifecycle", payload: started });
	model = reduceChatFrame(model, { type: "subagent_progress", payload: { ...started, task: WAKE, progress: { id: "AskDialogRefresh", status: "running", currentTool: "wait" } } });
	const revived = row(model);
	assert.deepEqual([revived.id, revived.badge, revived.description], ["AskDialogRefresh", "implementer", "Ask dialog layout"]);
	assert.doesNotMatch(JSON.stringify(revived), /New assignment/);
});

it("a cold revive reports its own id as the type; the remembered type wins and the id never becomes a badge", () => {
	let model = spawnedAndParked();
	const cold = { ...started, agent: "AskDialogRefresh", agentSource: "user" };
	model = reduceChatFrame(model, { type: "subagent_lifecycle", payload: cold });
	model = reduceChatFrame(model, { type: "subagent_progress", payload: { ...cold, task: WAKE, progress: { id: "AskDialogRefresh", status: "running" } } });
	assert.deepEqual([row(model).badge, row(model).description], ["implementer", "Ask dialog layout"]);
	// A model that never saw the spawn (the host restarted): no badge rather than the id, and no message text.
	let unknown = reduceChatFrame(createChatModel(), { type: "subagent_lifecycle", payload: cold });
	unknown = reduceChatFrame(unknown, { type: "subagent_progress", payload: { ...cold, task: WAKE, progress: { id: "AskDialogRefresh", status: "running" } } });
	assert.deepEqual([row(unknown).description, row(unknown).badge], ["", ""]);
});

it("the transcript's own task call supplies the type and assignment when nothing was remembered", () => {
	const call: ChatEntry = { type: "message", id: "call", parentId: null, timestamp: "2026-10-07T00:00:00Z", message: { role: "assistant", timestamp: 1, model: "m", provider: "p", stopReason: "toolUse", content: [{ type: "toolCall", id: "call-1", name: "task", arguments: { tasks: [{ name: "AskDialogRefresh", agent: "implementer", task: "Fix the composer menu\nrest" }] } }] } };
	let model = applyChatEntries(createChatModel(), [call], "call");
	const cold = { ...started, agent: "AskDialogRefresh", agentSource: "user" };
	model = reduceChatFrame(model, { type: "subagent_lifecycle", payload: cold });
	model = reduceChatFrame(model, { type: "subagent_progress", payload: { ...cold, task: WAKE, progress: { id: "AskDialogRefresh", status: "running" } } });
	assert.deepEqual([row(model).badge, row(model).description], ["implementer", "Fix the composer menu"]);
});

it("a genuinely new spawn of a remembered id inherits nothing from the old one", () => {
	let model = spawnedAndParked();
	const fresh = { ...started, agent: "scout" };
	model = reduceChatFrame(model, { type: "subagent_lifecycle", payload: fresh });
	model = reduceChatFrame(model, { type: "subagent_progress", payload: { ...fresh, task: "wrapped", assignment: "Inspect something else", progress: { id: "AskDialogRefresh", status: "running" } } });
	assert.deepEqual([row(model).badge, row(model).description], ["scout", "Inspect something else"]);
});

it("the identity memory survives a snapshot to a reattached page, and a roster refresh enriches a cold agent", () => {
	const memory = applyChatSnapshot(createChatModel(), snapshotOf(spawnedAndParked(), { nonce: "host", counter: 1 }));
	const refreshed = reduceChatFrame(memory, { type: "agents_snapshot", availability: "available", agents: [{ id: "AskDialogRefresh", index: 0, agent: "AskDialogRefresh", agentSource: "user", status: "running", lastUpdate: 1, task: WAKE }] });
	assert.deepEqual([row(refreshed).badge, row(refreshed).description], ["implementer", "Ask dialog layout"]);
});
