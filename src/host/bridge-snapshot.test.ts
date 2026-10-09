import assert from "node:assert/strict";
import { it } from "node:test";
import { BridgeListener } from "./bridge-listener.ts";
import { BridgeClient } from "../webview/lib/bridge-client.ts";
import { ChatRuntime } from "./chat-runtime.ts";
import { snapshotOf, createChatModel } from "../chat/model.ts";
import { ChatSnapshotAssembler, parseChatHostMessage } from "../webview/chat-messages.ts";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { HistoryReader } from "./rpc/history-reader.ts";

it("restores a >1 MiB snapshot with intact 950 KB tool and 900 KB image rows on a fresh bridge document", { timeout: 15_000 }, async () => {
 const documentId = "c".repeat(32), editorId = "b".repeat(32), workspace = "a".repeat(64), bindingHash = "d".repeat(64);
 const tabId = "tab:11111111-2222-3333-4444-555555555555", origin = "vscode-webview://snapshot-test";
 const secret = new Uint8Array(32).fill(7);
 const payload = snapshotOf(createChatModel(), { nonce: "snapshot-host", counter: 1 });
 payload.entries = Array.from({ length: 80 }, (_, i) => ({ type: "message" as const, id: `entry-${i}`, parentId: i === 0 ? null : `entry-${i - 1}`, timestamp: "2026-10-09T00:00:00Z", message: { role: "user" as const, content: `ROW-${i}:` + "x".repeat(20000), timestamp: i } }));
 payload.entries = [...payload.entries,
  { type: "message", id: "large-tool", parentId: "entry-79", timestamp: "2026-10-09T00:00:00Z", message: {
   role: "toolResult", toolCallId: "large-call", toolName: "read", isError: false, timestamp: 80,
   content: [{ type: "text", text: "TOOL-950K:" + "t".repeat(950 * 1024) }], details: { preserved: true } } },
  { type: "message", id: "large-image", parentId: "large-tool", timestamp: "2026-10-09T00:00:00Z", message: {
   role: "user", timestamp: 81, content: [{ type: "text", text: "IMAGE-900K" },
    { type: "image", mimeType: "image/png", data: "a".repeat(900 * 1024) }] } },
 ];
 assert.ok(Buffer.byteLength(JSON.stringify(payload)) > 1024 * 1024);
 let delivered = Promise.withResolvers<void>();
 const assembler = new ChatSnapshotAssembler();
 let assembled = false;
 const diagnostics: string[] = [];
 const scratch = await mkdtemp(path.join(os.tmpdir(), "omp-snapshot-fixture-"));
 const file = path.join(scratch, "snapshot.jsonl");
 await writeFile(file, JSON.stringify({ type: "session", version: 3, id: "snapshot-test", cwd: scratch, timestamp: "2026-10-09T00:00:00Z" }) + "\n");
 const reader = await HistoryReader.open(file);
 const runtime = new ChatRuntime({ hostNonce: "snapshot-host", onEvent: () => {}, readViewOnly: async () => ({ snapshot: payload, reader }),
  readDisplayPreferences: () => ({ toolCallDetail: "detailed", accessibilitySupport: true }) });
 const listener = new BridgeListener({ origin, requestedPort: null,
  authorize: async hello => ({ secret, bindingHash, workspace, tabId, editorId: Buffer.from(editorId, "hex"), documentId: hello.documentId }),
  onRequest: () => {}, onSessionEnded: () => {}, onDiagnostic: code => { diagnostics.push(code); if (code === "outbound-queue") delivered.reject(new Error("snapshot exceeded outbound-queue")); },
  onSessionAuthenticated: session => session.send("route-offer", { routeGeneration: "e".repeat(32), status: "ready" }),
  onRouteAcknowledged: (session, routeGeneration) => {
   runtime.attachPage(tabId, { id: "bridge-page", maxChunkBytes: 248 * 1024,
    postSnapshot: messages => session.sendSnapshot(routeGeneration, messages) ? "sent" : "dropped",
    post: message => { session.send("terminal", { routeGeneration, payload: message }); return "sent"; } });
   return true;
  },
 });
 const Socket = WebSocket as unknown as new (url: string, options: { headers: Record<string, string> }) => WebSocket;
 let client: BridgeClient | undefined;
 try {
  await runtime.showViewOnly(tabId, { file: "snapshot-test.jsonl", cwd: ".", title: null, reason: "stopped" });
  assert.ok(await listener.listen());
  for (let cycle = 0; cycle < 2; cycle++) {
  delivered = Promise.withResolvers<void>();
  assembler.reset();
  assembled = false;
  client = new BridgeClient({ workspace, tabId, editorId, documentId: cycle === 0 ? documentId : "f".repeat(32), port: listener.port!, origin, bindingHash, secret, connect: url => new Socket(url, { headers: { origin } }) }, {
   onRouteOffer: route => { client!.acknowledgeRoute(route); }, onReply: () => {}, onInvalidate: () => {}, onConnection: () => {},
   onMessage: raw => {
    const message = parseChatHostMessage(raw);
    if (message === null) return;
    const complete = message.type === "omp:chat-snapshot" ? assembler.begin(message) : message.type === "omp:chat-snapshot-chunk" ? assembler.add(message) : null;
    if (complete !== null) { assert.deepEqual(complete.entries, payload.entries); assembled = true; }
    if (message.type === "omp:chat-display-preferences") {
     assert.ok(assembled, "epoch-bound preferences must follow the complete train");
     assert.equal(message.toolCallDetail, "detailed");
     assert.equal(message.accessibilitySupport, true);
     delivered.resolve();
    }
   },
  });
  client.start();
  await delivered.promise;
  client.stop();
  }
 } finally { client?.stop(); listener.close(); runtime.dispose(); await rm(scratch, { recursive: true, force: true }); }
});

it("stops identical immediate authenticated reconnect failures after three attempts", { timeout: 8000 }, async context => {
 context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
 const secret = new Uint8Array(32).fill(7), documentId = "c".repeat(32), editorId = "b".repeat(32);
 const workspace = "a".repeat(64), bindingHash = "d".repeat(64), origin = "vscode-webview://snapshot-test";
 const tabId = "tab:11111111-2222-3333-4444-555555555555";
 let lost = Promise.withResolvers<void>();
 const failed = Promise.withResolvers<void>();
 let attempts = 0;
 const listener = new BridgeListener({ origin, requestedPort: null,
  authorize: async () => ({ secret, bindingHash, workspace, tabId, editorId: Buffer.from(editorId, "hex"), documentId: Buffer.from(documentId, "hex") }),
  onRequest: () => {}, onSessionEnded: () => {},
  onSessionAuthenticated: session => { attempts++; session.send("route-offer", { routeGeneration: "e".repeat(32), status: "ready" }); },
  onRouteAcknowledged: session => { session.close("protocol"); return true; },
 });
 const Socket = WebSocket as unknown as new (url: string, options: { headers: Record<string, string> }) => WebSocket;
 let client: BridgeClient | undefined;
 try {
  assert.ok(await listener.listen());
  client = new BridgeClient({ workspace, tabId, editorId, documentId, port: listener.port!, origin, bindingHash, secret,
   connect: url => new Socket(url, { headers: { origin } }) }, {
   onRouteOffer: route => { client!.acknowledgeRoute(route); }, onReply: () => {}, onInvalidate: () => {},
   onConnection: connected => { if (!connected) lost.resolve(); },
   onRecoveryFailed: () => failed.resolve(),
  });
  client.start();
  for (let index = 0; index < 3; index++) {
   await lost.promise;
   lost = Promise.withResolvers<void>();
   if (index < 2) context.mock.timers.tick(index === 0 ? 1250 : 2250);
  }
  await failed.promise;
  context.mock.timers.tick(60_000);
  assert.equal(attempts, 3);
  assert.equal(client.connected, false);
 } finally { client?.stop(); listener.close(); context.mock.timers.reset(); }
});
