import assert from "node:assert/strict";
import { it } from "node:test";
import type { AssistantMessage, ChatEntry, ChatMessage, ToolResultMessage } from "./messages.ts";
import { isInterruptedToolResult, parseChatEntry } from "./messages.ts";
import { createChatModel, reduceChatFrame, windowOf } from "./model.ts";
import { projectTranscript } from "./transcript.ts";
import { windowTranscriptCards } from "../webview/lib/transcript-window.ts";
const entry = (id: string, message: ChatMessage): ChatEntry => ({ type: "message", id, parentId: null, timestamp: new Date(message.timestamp).toISOString(), message });
const call = (id: string, name: string, path: string): AssistantMessage => ({ role: "assistant", timestamp: 1, model: "m", stopReason: "toolUse", content: [{ type: "toolCall", id, name, arguments: { path } }] });

it("preserves individual call identities across invisible blocks and visible reasoning boundaries", () => {
 const rows = [entry("first", call("one", "read", "one.ts")), entry("empty", { ...call("none", "read", "none.ts"), content: [{ type: "thinking", thinking: "  " }] }), entry("second", call("two", "read", "two.ts")), entry("reason", { ...call("three", "read", "three.ts"), content: [{ type: "thinking", thinking: "Visible reasoning" }] }), entry("third", call("three", "read", "three.ts"))];
 const cards = windowTranscriptCards(projectTranscript(rows), 100, null).rows;
 assert.deepEqual(cards.map(card => card.kind), ["tool", "tool", "assistant", "tool"]);
 assert.deepEqual(cards.filter(card => card.kind === "tool").map(card => card.tool.call.id), ["one", "two", "three"]);
});

it("routes late diagnostics to the latest matching edit while retaining unmatched files and result-arrival cards", () => {
 const rows: ChatEntry[] = [entry("old", call("old-edit", "edit", "src/file.ts")), entry("latest", call("new-edit", "write", "D:/work/src/file.ts")), entry("result", { role: "toolResult", timestamp: 2, toolCallId: "new-edit", toolName: "write", isError: false, content: [] }), entry("diagnostics", { role: "custom", timestamp: 3, customType: "lsp-late-diagnostic", display: true, content: [], details: { files: [{ path: "src/file.ts", messages: ["Actual diagnostic"] }, { path: "other.ts", messages: ["Unmatched diagnostic"] }] } })];
 const cards = projectTranscript(rows, { cwd: "D:/work" });
 const tools = cards.filter(card => card.kind === "tool");
 assert.equal(tools[0]!.tool.attachments.length, 0);
 assert.equal(tools[1]!.tool.attachments.length, 1);
 const arrival = cards.find(card => card.kind === "results");
 assert.ok(arrival && arrival.kind === "results");
 assert.equal(arrival.tools[0]!.attachments.length, 1);
 const remainder = cards.find(card => card.kind === "entry");
 assert.ok(remainder && remainder.kind === "entry" && remainder.entry.type === "message");
 assert.equal(remainder.entry.message.role, "custom");
 if (remainder.entry.message.role === "custom") assert.deepEqual(remainder.entry.message.details, { files: [{ path: "other.ts", messages: ["Unmatched diagnostic"] }] });
});

it("never displaces a mutable todo from an earlier sealed turn", () => {
 let model = reduceChatFrame(createChatModel(), { type: "agent_start" });
 for (const id of ["first", "second"]) {
  model = reduceChatFrame(model, { type: "message_end", messageId: id, message: call(id, "todo", "") });
  model = reduceChatFrame(model, { type: "message_end", messageId: `result-${id}`, message: { role: "toolResult", timestamp: id === "first" ? 2 : 3, toolCallId: id, toolName: "todo", content: [], isError: false, details: { op: "update", phases: [{ name: "Work", tasks: [{ content: id, status: "pending" }] }] } } });
  if (id === "first") model = reduceChatFrame(model, { type: "turn_end" });
 }
 assert.deepEqual(windowOf(model, 100, null).rows.filter(card => card.kind === "tool").map(card => card.tool.call.id), ["first", "second"]);
});

it("internal entry kinds and usage-only provider blocks do not consume canonical history", () => {
 const internal = ["model_usage", "credential_pin", "unrecognized_internal_kind"].map((type, index) => {
  const parsed = parseChatEntry({ type, id: `internal-${index}`, parentId: null, timestamp: "2026-10-02T00:00:00Z", data: { privateField: "INTERNAL" } });
  assert.ok(parsed);
  return parsed;
 });
 const usageOnly: AssistantMessage = { role: "assistant", timestamp: 2, model: "internal-model", stopReason: "stop", usage: { input: 50, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 50, cost: { total: 0 } }, content: [{ type: "redactedThinking", data: "INTERNAL_REDACTED" }, { type: "anthropicServerTool", block: { type: "INTERNAL_SERVER" } }] };
 const projected = projectTranscript([entry("first", call("one", "read", "one.ts")), ...internal, entry("usage-only", usageOnly), entry("second", call("two", "read", "two.ts"))]);
 const window = windowTranscriptCards(projected, 1, null);
 assert.equal(window.rows.length, 1);
 assert.equal(window.olderRows, 1);
 assert.equal(window.rows[0]!.kind, "tool");
 if (window.rows[0]!.kind === "tool") assert.equal(window.rows[0]!.tool.call.id, "two");
});

it("native benign wait placeholders cost no cards, while ordinary waits and unrelated errors remain", () => {
 const waitCall = entry("wait-call", call("call_wait|fc_native", "wait", ""));
 const result: ToolResultMessage = { role: "toolResult", timestamp: 2, toolCallId: "call_wait|fc_native", toolName: "wait", content: [{ type: "text", text: "MODEL_ONLY_RETRY_GUIDANCE" }], isError: true, details: { source: "interrupt_skipped", __interrupted: true, execution: "started" } };
 const completion = entry("completion", { role: "custom", timestamp: 3, customType: "async-result", display: true, content: "MODEL_ONLY_JOB_RESULT", details: { jobs: [{ jobId: "Worker", type: "task" }] } });
 assert.deepEqual(projectTranscript([waitCall, entry("placeholder", result), completion]).map(card => card.id), ["completion"]);
 assert.deepEqual(projectTranscript([entry("orphan", result)]), []);
 const ordinary = { ...result, isError: false, content: [], details: { interrupted: true, jobs: [{ id: "Worker", type: "task", status: "completed", resultText: "Visible worker result" }] } };
 const shown = projectTranscript([waitCall, entry("snapshot", ordinary)]);
 assert.equal(shown[0]!.kind, "tool");
 if (shown[0]!.kind === "tool") assert.equal(shown[0]!.tool.status, "complete");
 for (const details of [{ __interrupted: true }, { source: "interrupt_skipped" }, { source: "interrupt_skipped", __interrupted: true, execution: "not-started" }]) {
  const failure = { ...result, details };
  assert.equal(isInterruptedToolResult(failure), false, "only the native placeholder contract may neutralize a failure");
  const cards = projectTranscript([waitCall, entry("failure", failure)]);
  if (cards[0]!.kind === "tool") assert.equal(cards[0]!.tool.status, "error");
  else assert.fail("real wait failure disappeared");
 }
});

it("a following wait retires a still-running wait snapshot, live or reloaded, only with no visible item between", () => {
 const wait = (id: string, statuses: string[], extra: Partial<ToolResultMessage> = {}) => [
  entry(`${id}-call`, call(id, "wait", "")),
  entry(`${id}-result`, { role: "toolResult", timestamp: 2, toolCallId: id, toolName: "wait", isError: false, content: [], details: { op: "wait", jobs: statuses.map((status, index) => ({ id: `bg_${index}`, type: "bash", status, label: "x", durationMs: 1 })) }, ...extra }),
 ];
 const ids = (rows: ChatEntry[], options = {}) => projectTranscript(rows, options).filter(card => card.kind === "tool").map(card => card.kind === "tool" ? card.tool.call.id : "");
 // Durable history applies the same rule as the live transcript.
 assert.deepEqual(ids([...wait("w1", ["running"]), ...wait("w2", ["running"]), ...wait("w3", ["completed"])]), ["w3"]);
 assert.deepEqual(ids([...wait("w1", ["running"]), ...wait("w2", ["running", "completed"])]), ["w2"]);
 // A settled poll is truthful history and is never displaced.
 assert.deepEqual(ids([...wait("w1", ["completed"]), ...wait("w2", ["running"])]), ["w1", "w2"]);
 assert.deepEqual(ids([...wait("w1", ["running"], { isError: true }), ...wait("w2", ["running"])]), ["w1", "w2"]);
 // Any other visible item between two waits seals the earlier one.
 const between = entry("text", { role: "assistant", timestamp: 3, model: "m", stopReason: "stop", content: [{ type: "text", text: "still waiting" }] });
 assert.deepEqual(ids([...wait("w1", ["running"]), between, ...wait("w2", ["running"])]), ["w1", "w2"]);
 assert.deepEqual(ids([...wait("w1", ["running"]), entry("bash-call", call("b1", "bash", "")), ...wait("w2", ["running"])]), ["w1", "b1", "w2"]);
 assert.deepEqual(ids([...wait("w1", ["running"]), entry("u", { role: "user", timestamp: 3, content: "go on" }), ...wait("w2", ["running"])]), ["w1", "w2"]);
 // A live wait without a result yet displaces the previous running poll.
 assert.deepEqual(ids([...wait("w1", ["running"]), entry("w2-call", call("w2", "wait", ""))]), ["w2"]);
});

it("initial configuration costs no cards, while real changes survive live and saved projections", () => {
 const base = { parentId: null, timestamp: "2026-10-08T00:00:00Z" };
 const rows: ChatEntry[] = [
  { ...base, type: "model_change", id: "initial-model", model: "original" },
  { ...base, type: "thinking_level_change", id: "initial-thinking", thinkingLevel: "low" },
  { ...base, type: "model_change", id: "initial-role", model: "advisor", role: "advisor" },
  { ...base, type: "model_change", id: "real-before-prompt", model: "next" },
  entry("prompt", { role: "user", timestamp: 1, content: "Inspect the code" }),
  { ...base, type: "thinking_level_change", id: "real-thinking", thinkingLevel: "high" },
  { ...base, type: "model_change", id: "duplicate", model: "next" },
  { ...base, type: "model_change", id: "role-change", model: "new-advisor", role: "advisor" },
 ];
 const ids = (working: boolean) => projectTranscript(rows, { working }).map(card => card.id);
 assert.deepEqual(ids(true), ["real-before-prompt", "prompt", "real-thinking", "role-change"]);
 assert.deepEqual(ids(false), ids(true));
 const cropped = { ...rows[3]!, parentId: "outside-the-page" };
 assert.equal(projectTranscript([cropped])[0]?.id, "real-before-prompt", "a cropped page does not reinterpret a real change as initialization");
});
