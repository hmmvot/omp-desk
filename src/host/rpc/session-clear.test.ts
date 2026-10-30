import type { ChatEntry } from "../../chat/messages.ts";
import { positionTranscript } from "../../chat/projection.ts";
import { appendFileSync } from "node:fs";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { CLEAR_COMMAND, CLEAR_ERROR_PATH, CLEAR_MARKER_TYPE, parseClearArgs, type ClearArgs } from "../../chat/clear.ts";
import { splitClearedHistory } from "../../chat/cleared-history.ts";
import { rewindTargets } from "../../chat/rewind.ts";
import { AGENT_LIVENESS_STATUS_KEY } from "../../chat/agent-liveness.ts";
import { FakeRpcChannel } from "./fake-channel.ts";
import { RpcSession, type RpcSessionOptions } from "./session.ts";
import { ManualTimers, ScratchDir, assistantMessage, isoOf, messageEntry, sessionFileText, tick, userMessage, waitUntil } from "./test-support.ts";

const sessions: RpcSession[] = [];
const scratches: ScratchDir[] = [];
afterEach(async () => {
 for (const session of sessions.splice(0)) session.dispose();
 for (const scratch of scratches.splice(0)) await scratch.remove();
});
const PREFIX = `/${CLEAR_COMMAND} `;
const LOCAL = { data: { agentInvoked: false } };
const u1 = messageEntry("u1", null, userMessage("hi", 1000));
const a1 = messageEntry("a1", "u1", assistantMessage("hello", 2000));
let seq = 0;
const rid = () => (++seq).toString(16).padStart(32, "0");

async function boot(catalog = true, options: Partial<RpcSessionOptions> = {}, beforeStart?: (channel: FakeRpcChannel) => void) {
 const channel = new FakeRpcChannel({ sessionFile: options.sessionFile ?? null, entries: [u1, a1] as never, leafId: "a1", ...(options.expectedProviderSessionId === undefined ? {} : { sessionId: options.expectedProviderSessionId }) });
 channel.handlers.set("get_available_commands", () => ({ data: { commands: catalog ? [{ name: CLEAR_COMMAND, source: "extension" }] : [] } }));
 beforeStart?.(channel);
 const timers = new ManualTimers();
 const session = new RpcSession({ channel, sessionFile: null, cwd: "D:\\scratch", hostNonce: "host-a", timers, watchdogIntervalMs: 60 * 60_000, ...options });
 sessions.push(session);
 await session.start(); await tick();
 return { channel, session, timers };
}

function appendBoundary(channel: FakeRpcChannel, args: ClearArgs) {
 const id = `b-${args.requestId}`;
 channel.child.entries.push({ type: "reset_boundary", id, parentId: channel.child.leafId, timestamp: isoOf(50_000) });
 channel.child.leafId = id;
}
function appendMarker(channel: FakeRpcChannel, args: ClearArgs) {
 const id = `m-${args.requestId}`;
 channel.child.entries.push({ type: "custom", customType: CLEAR_MARKER_TYPE, id, parentId: channel.child.leafId, timestamp: isoOf(50_001), data: { v: 1, requestId: args.requestId, boundaryId: `b-${args.requestId}` } });
 channel.child.leafId = id;
}
function install(channel: FakeRpcChannel) {
 const calls: ClearArgs[] = [];
 channel.handlers.set("prompt", command => {
  assert.equal(command.streamingBehavior, undefined);
  if (command.message === "/fresh") {
   channel.child.sessionId += "-fresh";
   // rpc-mode cancelled admission after isCurrent sees the changed provider id.
   setImmediate(() => channel.emit({ type: "prompt_result", id: command.id, agentInvoked: true, status: "aborted", sessionSettled: true }));
   return {};
  }
  const args = parseClearArgs(String(command.message).slice(PREFIX.length)); assert.ok(args);
  calls.push(args);
  if (args.phase === "confirm") appendMarker(channel, args); else appendBoundary(channel, args);
  setImmediate(() => channel.emit({ type: "prompt_result", id: command.id, agentInvoked: false, status: "completed", sessionSettled: true }));
  return {}; // Extension prompt acknowledgement is admission, not handler completion.
 });
 return calls;
}

describe("combined clear", () => {
 it("runs boundary/reload, builtin fresh, then confirmation; rotates provider id but keeps durable command identity", async () => {
  const { channel, session } = await boot(); const calls = install(channel);
  const requestId = rid(); assert.deepEqual(await session.clear(requestId), { status: "done" });
  assert.equal(session.sessionId, "sess-1-fresh");
  assert.deepEqual(calls, [{ v: 1, requestId, sessionId: "sess-1" }, { v: 1, requestId, sessionId: "sess-1", phase: "confirm" }]);
  assert.equal(channel.commandsOfType("prompt")[1]!.message, "/fresh");
  assert.ok(splitClearedHistory(session.model.entries, 0));
  assert.deepEqual(rewindTargets(session.model.entries), []);
  assert.deepEqual(await session.clear(rid()), { status: "done" });
  assert.equal(calls[2]!.sessionId, "sess-1", "the journal header does not rotate with provider identity");
 });
 it("shows nothing of the turn the broker replayed, nor of OMP's fresh report, below the divider", async () => {
  // The window reloaded after the turn: the session file is read for the history, the broker replays the turn's lines, and the clear follows.
  const scratch = await ScratchDir.create(); scratches.push(scratch);
  const u3 = messageEntry("u3", "a1", userMessage("push", 5000));
  const a3 = messageEntry("a3", "u3", assistantMessage("pushed", 6000));
  const usage = { type: "model_usage", id: "mu3", parentId: "a3", timestamp: isoOf(9_000), purpose: "memory" };
  const file = await scratch.file("replayed-turn.jsonl", sessionFileText({ entries: [u1, a1, u3, a3, usage] }));
  const { channel, session } = await boot(true, { sessionFile: file }, rig => {
   rig.child.entries = [u1, a1, u3, a3, usage] as never;
   rig.child.leafId = "mu3";
   rig.emitMessage("message_end", "msg-1", userMessage("push", 5000) as never);
   rig.emitMessage("message_end", "msg-2", assistantMessage("pushed", 6000) as never);
   rig.emit({ type: "agent_end" });
  });
  await tick();
  // The clear's own entries follow the usage row; the file reader sees them as OMP writes them.
  install(channel);
  const installed = channel.handlers.get("prompt")!;
  channel.handlers.set("prompt", command => {
   const before = channel.child.entries.length;
   const answer = installed(command);
   appendFileSync(file, channel.child.entries.slice(before).map(row => `${JSON.stringify(row)}\n`).join(""));
   // OMP's builtin /fresh prints its report whenever it runs, also as the middle phase of a clear.
   if (command.message === "/fresh") channel.emit({ type: "command_output", text: "Fresh provider session started (1 provider state pruned)." });
   return answer;
  });
  assert.deepEqual(await session.clear(rid()), { status: "done" });
  const model = session.model;
  assert.deepEqual(model.ephemeral, [], "the report of the provider reset inside a clear is not a transcript row");
  const positioned = positionTranscript(model.entries, model.durableCount, model.pending, model.ephemeral, null, model.durablePositions);
  const split = splitClearedHistory(positioned, model.olderCount)!;
  assert.ok(split, "the confirmed boundary is found");
  const turns = (rows: readonly ChatEntry[]) => rows.filter(row => row.type === "message").map(row => row.id);
  assert.deepEqual(turns(split.before), ["u1", "a1", "u3", "a3"], "the whole turn is cleared history");
  assert.deepEqual(turns(split.after), [], "nothing of it stays below the divider");
  assert.ok(split.messages >= 4, "the divider counts the messages it hides");
  assert.deepEqual(positioned.slice(positioned.findIndex(row => row.id === split.boundary.id)).map(row => row.type), ["reset_boundary", "custom"], "the divider is followed by its marker only");
 });
 it("does not show a fresh report the broker replays after a reattach, and still shows one typed live and other replayed output", async () => {
  const report = (count: number) => `Fresh provider session started (${count} provider ${count === 1 ? "state" : "states"} pruned).`;
  const { channel, session } = await boot(true, {}, rig => {
   rig.emit({ type: "command_output", text: report(1) });
   rig.emit({ type: "command_output", text: "Shook 3 tool results." });
   rig.emit({ type: "command_output", text: report(2) });
  });
  assert.deepEqual(session.model.ephemeral.map(item => item.payload), [{ text: "Shook 3 tool results." }], "the replayed reports of a clear's (or a typed) /fresh are not rows; other replayed output is");
  channel.emit({ type: "command_output", text: report(1) });
  await tick();
  assert.deepEqual(session.model.ephemeral.map(item => item.payload), [{ text: "Shook 3 tool results." }, { text: report(1) }], "a report that arrives live outside a clear is OMP's answer to a typed /fresh");
 });
 it("is exactly once and does not put internal commands in the user ledger", async () => {
  const { channel, session } = await boot(); install(channel); const requestId = rid();
  const first = session.clear(requestId); assert.equal(session.clear(requestId), first); await first;
  assert.equal(channel.commandsOfType("prompt").length, 3); assert.equal(session.model.pending.size, 0);
 });
 it("refuses wrong request, unsupported catalog, and running work without a prompt", async () => {
  const rig = await boot(false);
  assert.deepEqual(await rig.session.clear("bad"), { status: "refused", reason: "bad-request-id" });
  assert.deepEqual(await rig.session.clear(rid()), { status: "refused", reason: "restart-needed" });
  const busy = await boot(); busy.channel.emit({ type: "agent_start" }); await tick();
  assert.deepEqual(await busy.session.clear(rid()), { status: "refused", reason: "busy" });
  assert.equal(busy.channel.commandsOfType("prompt").length, 0);
 });
 it("bare boundary and reload failure never collapse history; no fresh or automatic retry", async () => {
  const { channel, session } = await boot();
  channel.handlers.set("prompt", command => {
   const args = parseClearArgs(String(command.message).slice(PREFIX.length)); assert.ok(args); appendBoundary(channel, args);
   channel.emit({ type: "extension_error", extensionPath: CLEAR_ERROR_PATH, error: "omp-desk-clear:reload-failed" }); return LOCAL;
  });
  assert.deepEqual(await session.clear(rid()), { status: "refused", reason: "reload-failed" });
  assert.equal(splitClearedHistory(session.model.entries, 0), null);
  assert.equal(channel.commandsOfType("prompt").length, 1);
  assert.equal(session.model.unconfirmedClearBoundaryId, session.model.entries.at(-1)?.id);
 });
 it("detach-induced prompt_result never completes or releases the operation; only final correlated acknowledgement does", async () => {
  const { channel, session, timers } = await boot();
  channel.handlers.set("prompt", () => "drop"); const pending = session.clear(rid());
  await waitUntil(() => channel.commandsOfType("prompt").length === 1);
  const id = String(channel.commandsOfType("prompt")[0]!.id);
  channel.emit({ type: "prompt_result", id, agentInvoked: false, status: "aborted", sessionSettled: true }); await tick();
  assert.deepEqual(await session.prompt({ requestId: "blocked", text: "still fenced" }), { status: "refused", reason: "busy" });
  timers.advance(30_000); assert.deepEqual(await pending, { status: "unconfirmed" });
  channel.emit({ type: "prompt_result", id, agentInvoked: false, status: "completed", sessionSettled: true }); await tick();
  assert.deepEqual(await session.prompt({ requestId: "blocked2", text: "still fenced" }), { status: "refused", reason: "busy" });
  channel.emit({ type: "response", id, command: "prompt", success: true, data: { agentInvoked: false } }); await tick();
  channel.handlers.delete("prompt");
  assert.equal((await session.prompt({ requestId: "free", text: "free" })).status, "accepted");
 });
 it("unconfirmed fresh leaves no marker and keeps admission fenced until its correlated acknowledgement", async () => {
  const { channel, session, timers } = await boot();
  channel.handlers.set("prompt", command => {
   if (command.message === "/fresh") return "drop";
   const args = parseClearArgs(String(command.message).slice(PREFIX.length)); assert.ok(args); appendBoundary(channel, args); return LOCAL;
  });
  const pending = session.clear(rid()); await waitUntil(() => channel.commandsOfType("prompt").length === 2);
  timers.advance(30_000); assert.deepEqual(await pending, { status: "unconfirmed" });
  assert.equal(splitClearedHistory(session.model.entries, 0), null);
  assert.deepEqual(await session.prompt({ requestId: "blocked", text: "blocked" }), { status: "refused", reason: "busy" });
 });
 it("plain fresh preserves messages and accepts only operation-scoped rotation", async () => {
  const { channel, session } = await boot(); install(channel);
  assert.deepEqual(await session.fresh(rid()), { status: "done" });
  assert.equal(session.sessionId, "sess-1-fresh"); assert.deepEqual(session.model.entries.map(entry => entry.id), ["u1", "a1"]);
  channel.child.sessionId = "unexpected"; await session.readSettingsState();
  assert.equal(session.model.phase, "failed"); assert.equal(session.model.code, "identity-diverged");
 });
 it("awaits accepted provider identity persistence under the fence and reattaches with the unchanged durable header", async () => {
  const scratch = await ScratchDir.create(); scratches.push(scratch);
  const file = await scratch.file("identity.jsonl", sessionFileText({ entries: [u1, a1] }));
  let finish!: () => void;
  const recorded = new Promise<void>(resolve => { finish = resolve; });
  const identities: string[][] = [];
  const { channel, session } = await boot(true, { sessionFile: file, acceptProviderIdentity: async (...identity) => { identities.push(identity); await recorded; } });
  install(channel);
  const pending = session.fresh(rid()); await waitUntil(() => identities.length === 1);
  assert.deepEqual(identities[0], [file, "sess-1-fresh", "sess-1"]);
  assert.deepEqual(await session.prompt({ requestId: "blocked", text: "blocked" }), { status: "refused", reason: "busy" });
  finish(); assert.deepEqual(await pending, { status: "done" });
  const attached = await boot(true, { sessionFile: file, expectedProviderSessionId: "sess-1-fresh" });
  assert.equal(attached.session.model.phase, "live");
  assert.equal(attached.session.sessionId, "sess-1-fresh");
  assert.equal(attached.session.model.header?.id, "sess-1");
  install(attached.channel);
  assert.deepEqual(await attached.session.fresh(rid()), { status: "done" });
 });
 it("fails closed when accepted identity persistence fails", async () => {
  const scratch = await ScratchDir.create(); scratches.push(scratch);
  const file = await scratch.file("identity-failed.jsonl", sessionFileText({ entries: [u1, a1] }));
  const { channel, session } = await boot(true, { sessionFile: file, acceptProviderIdentity: async () => { throw new Error("identity store changed"); } });
  install(channel);
  assert.deepEqual(await session.fresh(rid()), { status: "unconfirmed" });
  assert.equal(session.model.phase, "failed");
  assert.equal(session.model.code, "identity-diverged");
 });
 it("never accepts a fresh rotation to another file", async () => {
  const { channel, session } = await boot(true, { sessionFile: "D:\\scratch\\bound.jsonl" });
  channel.handlers.set("prompt", () => { channel.child.sessionId += "-fresh"; channel.child.sessionFile = "D:\\scratch\\other.jsonl"; return LOCAL; });
  assert.deepEqual(await session.fresh(rid()), { status: "unconfirmed" });
  assert.equal(session.model.code, "identity-diverged");
 });
 it("shared replacement admission rejects concurrent clear and prompt before any await", async () => {
  const { session } = await boot(); assert.equal(session.admitReplacement(), true); assert.equal(session.admitReplacement(), false);
  assert.deepEqual(await session.clear(rid()), { status: "refused", reason: "busy" });
  assert.deepEqual(await session.prompt({ requestId: "blocked", text: "blocked" }), { status: "refused", reason: "busy" });
  session.setMutationFence(null);
 });
 for (const phase of ["prepare", "confirm"] as const) {
  it(`records a late ${phase} acknowledgement while timeout reconciliation is waiting`, async () => {
   const { channel, session, timers } = await boot();
   install(channel); const regular = channel.handlers.get("prompt")!;
   let held: Record<string, unknown> | null = null;
   let dispatched = false;
   channel.handlers.set("prompt", command => {
    const args = command.message === "/fresh" ? null : parseClearArgs(String(command.message).slice(PREFIX.length));
    if (args && (args.phase ?? "prepare") === phase) {
     dispatched = true;
     if (phase === "prepare") appendBoundary(channel, args);
     return "drop";
    }
    return regular(command);
   });
   channel.handlers.set("get_entries", command => {
    if (!dispatched) return undefined;
    held = command; return "drop";
   });
   const pending = session.clear(rid());
   await waitUntil(() => dispatched);
   const command = channel.commandsOfType("prompt").at(-1)!;
   timers.advance(30_000);
   await waitUntil(() => held !== null);
   channel.emit({ type: "response", id: command.id, command: "prompt", success: true });
   channel.emit({ type: "prompt_result", id: command.id, agentInvoked: false, status: "completed", sessionSettled: true });
   channel.handlers.delete("get_entries");
   const query = held as unknown as Record<string, unknown>;
   const since = channel.child.entries.findIndex(entry => entry.id === query.since);
   channel.emit({ type: "response", id: query.id, command: "get_entries", success: true, data: { entries: typeof query.since === "string" ? channel.child.entries.slice(since + 1) : channel.child.entries, leafId: channel.child.leafId } });
   assert.deepEqual(await pending, { status: "unconfirmed" });
   channel.handlers.delete("prompt");
   assert.equal((await session.prompt({ requestId: `after-${phase}`, text: "now admitted" })).status, "accepted");
  });
 }
 for (const phase of ["prepare", "fresh", "confirm"] as const) {
  it(`aborts ${phase} model fall-through without confirming clear`, async () => {
   const { channel, session } = await boot();
   install(channel); const regular = channel.handlers.get("prompt")!;
   channel.handlers.set("prompt", command => {
    const args = command.message === "/fresh" ? null : parseClearArgs(String(command.message).slice(PREFIX.length));
    const kind = command.message === "/fresh" ? "fresh" : args?.phase ?? "prepare";
    if (kind !== phase) return regular(command);
    channel.emit({ type: "message_start", messageId: "rewritten", message: userMessage("input hook rewrote the command", 55_000) });
    return { data: { agentInvoked: true } };
   });
   assert.notEqual((await session.clear(rid())).status, "done");
   assert.equal(channel.commandsOfType("abort").length, 1);
   assert.equal(splitClearedHistory(session.model.entries, 0), null);
  });
 }
 it("accepts registry-only activity under the durable identity after provider rotation", async () => {
  const { channel, session } = await boot(); install(channel);
  assert.deepEqual(await session.fresh(rid()), { status: "done" });
  channel.emit({ type: "extension_ui_request", method: "setStatus", statusKey: AGENT_LIVENESS_STATUS_KEY,
   statusText: JSON.stringify({ v: 1, instance: "a".repeat(32), seq: 1, sessionId: "sess-1", agents: [{ id: "registry-only", agent: "task", state: "running" }] }) });
  await tick();
  assert.equal(session.model.agents.has("registry-only"), true);
  assert.deepEqual(await session.clear(rid()), { status: "refused", reason: "jobs" });
  assert.equal(session.admitReplacement(), false);
 });
 it("does not assign failed Desk provenance to a markerless boundary loaded from native history", async () => {
  const { channel, session } = await boot();
  channel.child.entries.push({ type: "reset_boundary", id: "native-clear", parentId: "a1", timestamp: isoOf(60_000) });
  channel.child.leafId = "native-clear";
  assert.equal(session.reconnect(), "started");
  await waitUntil(() => session.model.phase === "live" && session.model.entries.some(entry => entry.id === "native-clear"));
  assert.equal(session.model.unconfirmedClearBoundaryId, null);
  assert.equal(session.snapshot().unconfirmedClearBoundaryId, null);
  assert.equal(splitClearedHistory(session.model.entries, 0), null);
 });
 it("awaits an already-started acceptance even when the following state read fails", async () => {
  const scratch = await ScratchDir.create(); scratches.push(scratch);
  const file = await scratch.file("acceptance-read-failed.jsonl", sessionFileText({ entries: [u1, a1] }));
  const committed = Promise.withResolvers<void>();
  let started = false;
  let finished = false;
  const { channel, session } = await boot(true, { sessionFile: file, acceptProviderIdentity: async () => { started = true; await committed.promise; } });
  install(channel); const regular = channel.handlers.get("prompt")!;
  let reads = 0;
  channel.handlers.set("get_state", () => ++reads === 1 ? undefined : { data: null });
  channel.handlers.set("prompt", command => {
   const answer = regular(command);
   if (command.message === "/fresh") channel.emit({ type: "command_output", text: "provider session refreshed" });
   return answer;
  });
  const pending = session.fresh(rid()).then(outcome => { finished = true; return outcome; });
  await waitUntil(() => started && reads >= 2);
  assert.equal(finished, false);
  assert.deepEqual(await session.prompt({ requestId: "persistence-still-pending", text: "blocked" }), { status: "refused", reason: "busy" });
  committed.resolve();
  assert.deepEqual(await pending, { status: "done" });
 });
 it("fails reattach closed if rotation happened before its durable acceptance commit", async () => {
  const scratch = await ScratchDir.create(); scratches.push(scratch);
  const file = await scratch.file("rotation-not-committed.jsonl", sessionFileText({ entries: [u1, a1] }));
  const channel = new FakeRpcChannel({ sessionFile: file, sessionId: "rotated-before-commit", entries: [u1, a1] as never, leafId: "a1" });
  const session = new RpcSession({ channel, sessionFile: file, expectedProviderSessionId: "sess-1", cwd: scratch.dir, hostNonce: "replacement-host" });
  sessions.push(session); await session.start();
  assert.equal(session.model.phase, "failed");
  assert.equal(session.model.code, "identity-mismatch");
 });
 it("waits for native extension handler completion, not its admission acknowledgement or detach result", async () => {
  const { channel, session } = await boot();
  install(channel); const regular = channel.handlers.get("prompt")!;
  let prepareId: unknown;
  channel.handlers.set("prompt", command => {
   const args = command.message === "/fresh" ? null : parseClearArgs(String(command.message).slice(PREFIX.length));
   if (args && args.phase !== "confirm") {
    prepareId = command.id; appendBoundary(channel, args);
    return {};
   }
   return regular(command);
  });
  const pending = session.clear(rid());
  await waitUntil(() => prepareId !== undefined);
  channel.emit({ type: "prompt_result", id: prepareId, agentInvoked: false, status: "aborted", sessionSettled: true });
  await tick();
  assert.equal(channel.commandsOfType("prompt").length, 1, "native admission and aborted detach cannot advance preparation");
  channel.emit({ type: "prompt_result", id: prepareId, agentInvoked: false, status: "completed", sessionSettled: true });
  assert.deepEqual(await pending, { status: "done" });
  assert.equal(channel.commandsOfType("prompt").length, 3);
 });
});
