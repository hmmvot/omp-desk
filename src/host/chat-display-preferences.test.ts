import assert from "node:assert/strict";
import { test } from "node:test";
import { ChatRuntime, type ChatPage } from "./chat-runtime.ts";
import { RpcSession } from "./rpc/session.ts";
import { FakeRpcChannel } from "./rpc/fake-channel.ts";
import { ManualTimers, tick, messageEntry, userMessage, waitUntil } from "./rpc/test-support.ts";
import { ChatClient } from "../webview/lib/chat-client.ts";
import { parseChatHostMessage, type ChatDisplayPreferences } from "../protocol/chat-messages.ts";

 test("a changed density reaches both live replicas without losing history or gaining session write authority", async () => {
 let preferences: ChatDisplayPreferences = { toolCallDetail: "overview", accessibilitySupport: false };
 const timers = new ManualTimers();
 const runtime = new ChatRuntime({ hostNonce: "display-test", onEvent() {},
  createSession: options => new RpcSession({ ...options, timers, fileExists: async () => true }),
  readDisplayPreferences: () => preferences,
 });
 const channels = [0, 1].map(index => new FakeRpcChannel({ sessionFile: `D:/scratch/preferences-${index}.jsonl`, entries: [{ ...messageEntry(`u${index}`, null, userMessage(`draft source ${index}`, 1000)) }] }));
 const sessions = channels.map((channel, index) => runtime.startLive(`chat${index}`, { channel, sessionFile: null, cwd: "D:/scratch", title: null }));
 await waitUntil(() => sessions.every(session => session.phase === "live"));
 assert.ok(sessions.every(session => session.phase === "live"));
 const clients = channels.map((_, index) => {
  const client = new ChatClient({ post(message) {
   if (message.type.startsWith("omp:chat-")) throw new Error("presentation gained session mutation authority");
   return false;
  } });
  const page: ChatPage = { id: `page${index}`, readOnlyReason: () => "Non-controlling replica", post(message) {
   const parsed = parseChatHostMessage(message); assert.ok(parsed); client.handle(parsed); return "sent";
  } };
  runtime.attachPage(`chat${index}`, page); return client;
 });
 const models = clients.map(client => client.getSnapshot());
 for (const density of ["detailed", "overview"] as const) {
  preferences = { ...preferences, toolCallDetail: density };
  runtime.refreshDisplayPreferences();
  for (const [index, client] of clients.entries()) {
   assert.equal(client.getDisplayPreferences().toolCallDetail, density);
   assert.equal(client.getSnapshot(), models[index], "density must not replace or drop canonical data");
   assert.equal(client.writable, false);
  }
 }
 const before = clients[0]!.getDisplayPreferences();
 clients[0]!.handle({ type: "omp:chat-display-preferences", epoch: { nonce: "abandoned", counter: 1 }, toolCallDetail: "detailed", accessibilitySupport: true });
 assert.equal(clients[0]!.getDisplayPreferences(), before, "stale route cannot overwrite preferences");
 preferences = { ...preferences, accessibilitySupport: true }; runtime.refreshDisplayPreferences();
 assert.ok(clients.every(client => client.getDisplayPreferences().accessibilitySupport));
 runtime.dispose();
 });
