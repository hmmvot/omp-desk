import assert from "node:assert/strict";
import { it } from "node:test";
import { assistantPersistenceKey, type AssistantMessage, type ChatEntry, type ChatMessage } from "./messages.ts";
import { applyChatSnapshot, createChatModel, reduceChatFrame, snapshotOf, type DisplayTurn } from "./model.ts";
import { replyFooters, type ReplyTurnOptions } from "./reply-turns.ts";
import { projectTranscript } from "./transcript.ts";
import { ChatSnapshotAssembler, parseChatHostMessage, splitChatSnapshot } from "../webview/chat-messages.ts";

const entry = (id: string, message: ChatMessage): ChatEntry => ({ type: "message", id, parentId: null, timestamp: new Date(message.timestamp).toISOString(), message });
const user = (timestamp = 1000): ChatMessage => ({ role: "user", content: "Request", timestamp });
const assistant = (text: string, patch: Partial<AssistantMessage> = {}): AssistantMessage => ({ role: "assistant", timestamp: 2000, model: "m", stopReason: "stop", content: [{ type: "text", text }], ...patch });
const idle: ReplyTurnOptions = { phase: "live", working: false, asyncPaused: false, settled: true };
const footers = (entries: ChatEntry[], patch: Partial<ReplyTurnOptions> = {}) => [...replyFooters(projectTranscript(entries), { ...idle, ...patch }).values()];

it("hosts one finished invocation footer despite a steer and copies only chronological canonical prose", () => {
	const first = assistant("**First**", { stopReason: "toolUse", content: [{ type: "text", text: "**First**" }, { type: "thinking", thinking: "Private reasoning" }, { type: "toolCall", id: "read", name: "read", arguments: { path: "file.ts" } }] });
	const last = assistant("Last", { timestamp: 3000, completedAt: 4000 });
	const turn: DisplayTurn = { id: 1, startedAt: 1100, completedAt: 4200, complete: true, memberKeys: [assistantPersistenceKey(first), assistantPersistenceKey(last)] };
	const result = footers([entry("u", user()), entry("first", first), entry("steer", user(2500)), entry("result", { role: "toolResult", toolCallId: "read", toolName: "read", timestamp: 2600, isError: false, content: [{ type: "text", text: "Tool output" }] }), entry("last", last)], { displayTurns: [turn] });
	assert.equal(result.length, 1);
	assert.equal(result[0]!.hostId, "last");
	assert.equal(result[0]!.text, "**First**\n\nLast");
	assert.equal(result[0]!.durationMs, 2900);
	assert.equal(result[0]!.durationKind, "turn");
});

it("history uses completion time rather than request start and distinguishes response-only or unknown timing", () => {
	const complete = footers([entry("u", user()), entry("a", assistant("Finished", { timestamp: 2000, completedAt: 6000, duration: 4000 }))])[0]!;
	assert.equal(complete.durationMs, 5000);
	assert.equal(complete.durationKind, "history");
	assert.equal(complete.endTime, 6000);
	const response = footers([entry("a", assistant("Truncated history", { duration: 1200 }))])[0]!;
	assert.equal(response.durationMs, 1200);
	assert.equal(response.durationKind, "response");
	assert.equal(response.endTime, null);
	assert.equal(response.startedTime, 2000);
	const unknown = footers([entry("u", user()), entry("a", assistant("Unknown timing"))])[0]!;
	assert.equal(unknown.durationMs, null);
	assert.equal(unknown.durationKind, "unavailable");
});

it("proven user skills start a history interval but advisor and async events do not", () => {
	const skill: ChatMessage = { role: "custom", customType: "skill-prompt", display: true, attribution: "user", timestamp: 1500, content: "Expanded skill", details: { name: "review" } };
	const advisor: ChatMessage = { role: "custom", customType: "advisor", display: true, timestamp: 2500, content: "Advice" };
	const async: ChatMessage = { role: "custom", customType: "async-result", display: true, timestamp: 2600, content: "Worker output" };
	const result = footers([entry("skill", skill), entry("first", assistant("Earlier prose", { stopReason: "toolUse" })), entry("advisor", advisor), entry("async", async), entry("last", assistant("Final prose", { completedAt: 3500 }))]);
	assert.equal(result.length, 1);
	assert.equal(result[0]!.durationMs, 2000);
	assert.equal(result[0]!.text, "Earlier prose\n\nFinal prose");
});

it("tool-only, reasoning-only and recovery records cannot own a reply footer", () => {
	for (const message of [
		assistant("", { content: [{ type: "thinking", thinking: "Reasoning" }] }),
		assistant("Tool prose", { stopReason: "toolUse" }),
		assistant("Recovered error", { stopReason: "error", retryRecovery: { kind: "auto-retry", status: "recovered", attempt: 1, recovery: "plain", note: "Recovered" } }),
	]) assert.deepEqual(footers([entry("u", user()), entry("a", message)]), []);
});

it("image-only finished replies explain the absence of copy text", () => {
	const result = footers([entry("a", assistant("", { content: [{ type: "image", data: "AA==", mimeType: "image/png" }] }))]);
	assert.equal(result[0]!.hostId, "a");
	assert.equal(result[0]!.imageOnly, true);
	assert.equal(result[0]!.text, "");
});

it("async pause and reconnect cannot complete a reply; continuation retains one observed invocation", () => {
	const message = assistant("Paused response");
	let model = reduceChatFrame(createChatModel(), { type: "agent_start" }, { now: 1000 });
	model = reduceChatFrame(model, { type: "message_end", messageId: "a", message }, { now: 2000 });
	model = reduceChatFrame(model, { type: "agent_end", isTerminal: false, awaitingAsyncWork: true }, { now: 3000 });
	model = reduceChatFrame(model, { type: "session_settled" }, { now: 4000 });
	assert.equal(model.displayTurns[0]!.completedAt, null);
	assert.deepEqual(footers([entry("a", message)], { displayTurns: model.displayTurns, asyncPaused: model.asyncPaused, settled: model.settled }), []);
	const wire = splitChatSnapshot(snapshotOf(model, { nonce: "reconnect", counter: 1 }), "footer-reconnect");
	const parsed = parseChatHostMessage(wire.snapshot);
	assert.ok(parsed?.type === "omp:chat-snapshot");
	const assembler = new ChatSnapshotAssembler();
	let snapshot = assembler.begin(parsed);
	for (const chunk of wire.chunks) {
		const parsedChunk = parseChatHostMessage(chunk);
		assert.ok(parsedChunk?.type === "omp:chat-snapshot-chunk");
		snapshot = assembler.add(parsedChunk);
	}
	assert.ok(snapshot);
	model = applyChatSnapshot(createChatModel(), snapshot);
	assert.equal(model.displayTurns[0]!.completedAt, null);
	model = reduceChatFrame(model, { type: "agent_start" }, { now: 5000 });
	assert.equal(model.displayTurns.length, 1);
	model = reduceChatFrame(model, { type: "agent_end", isTerminal: true }, { now: 6000 });
	model = reduceChatFrame(model, { type: "session_settled" }, { now: 6500 });
	const result = footers([entry("a", message)], { displayTurns: model.displayTurns, settled: model.settled });
	assert.equal(result[0]!.durationMs, 5500);
	assert.equal(result[0]!.endTime, 6500);
});
