/**
 * Behavioral tests for `RpcSession` over an in-memory channel and a scripted child.
 *
 * Pinned behavior: the resync sequence (disk paint, replay into the shadow model only, delta since the disk cursor,
 * one authoritative snapshot, forwarding only afterwards), persistence lag and pending-row reconciliation, command
 * correlation by id and exactly-once prompts, the identity-changing slash deny-list and its backstop, the identity
 * binding before any `set_model`, `unknown_since`, `message_update` coalescing, reattach with the last seq, and dialog
 * routing.
 *
 * Runner: `node --test src/host/rpc/session.test.ts`.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { ChatModel, ChatSnapshotPayload } from "../../chat/model.ts";
import { FakeRpcChannel, responseLine, type FakeChildModel } from "./fake-channel.ts";
import { RpcSession, type RpcSessionOptions, type RpcSessionOutput } from "./session.ts";
import { turnActivity } from "../../webview/lib/activity.ts";
import { TurnActivityLedger, type TurnNotice } from "../notifications.ts";
import {
	ManualTimers,
	ScratchDir,
	assistantMessage,
	messageEntry,
	sessionFileText,
	tick,
	toolResultMessage,
	userMessage,
	waitUntil,
} from "./test-support.ts";

const scratches: ScratchDir[] = [];
afterEach(async () => {
	for (const scratch of scratches.splice(0)) await scratch.remove();
});

interface Rig {
	channel: FakeRpcChannel;
	session: RpcSession;
	timers: ManualTimers;
	outputs: RpcSessionOutput[];
}

interface BootOptions {
	file?: string | null;
	child?: Partial<FakeChildModel>;
	setup?: (channel: FakeRpcChannel) => void;
	session?: Partial<RpcSessionOptions>;
	/** Do not await `start()`; the caller drives the session to `live`. */
	noWait?: boolean;
}

async function boot(options: BootOptions = {}): Promise<Rig> {
	const channel = new FakeRpcChannel({ sessionFile: options.file ?? null, ...options.child });
	options.setup?.(channel);
	const timers = new ManualTimers();
	const session = new RpcSession({
		channel,
		sessionFile: options.file ?? null,
		cwd: "D:\\scratch",
		hostNonce: "host-a",
		timers,
		fileExists: async () => true,
		...options.session,
	});
	const outputs: RpcSessionOutput[] = [];
	session.subscribe(output => outputs.push(output));
	const started = session.start();
	if (options.noWait !== true) await started;
	await tick();
	return { channel, session, timers, outputs };
}

async function scratchFile(name: string, entries: readonly unknown[], id = "sess-1"): Promise<string> {
	const scratch = await ScratchDir.create();
	scratches.push(scratch);
	return scratch.file(name, sessionFileText({ id, entries }));
}

const u1 = messageEntry("u1", null, userMessage("hi", 1000));
const a1 = messageEntry("a1", "u1", assistantMessage("hello", 2000));
const u2 = messageEntry("u2", "a1", userMessage("again", 3000));
const a2 = messageEntry("a2", "u2", assistantMessage("sure", 4000));

function ids(model: ChatModel): string[] {
	return model.entries.map(entry => entry.id);
}

function snapshots(outputs: readonly RpcSessionOutput[]): ChatSnapshotPayload[] {
	return outputs.flatMap(output => (output.type === "snapshot" ? [output.payload] : []));
}

describe("resync sequence", () => {
	it("paints the disk tail first, keeps replay in the shadow, sends only the delta, then goes live once", async () => {
		const file = await scratchFile("s1.jsonl", [u1, a1]);
		const { channel, session, outputs } = await boot({
			file,
			child: { sessionFile: file, entries: [u1, a1, u2, a2] as never, leafId: "a2" },
			setup: ch => {
				// Retained before the attach: a1 is already durable on disk; u2/a2 are durable in the child only.
				ch.emitMessage("message_end", "msg-1", a1.type === "message" ? (a1.message as never) : {});
				ch.emitMessage("message_end", "msg-2", u2.type === "message" ? (u2.message as never) : {});
				ch.emitMessage("message_end", "msg-3", a2.type === "message" ? (a2.message as never) : {});
				ch.emit({ type: "extension_ui_request", id: "ui-1", method: "select", title: "Approve?", options: ["Approve", "Deny"] });
			},
		});

		assert.equal(session.phase, "live");
		assert.deepEqual(ids(session.model), ["u1", "a1", "u2", "a2"], "replayed message_end of a durable row does not duplicate; delta replaces pending rows");
		assert.equal(session.model.pending.size, 0);
		assert.equal(session.model.uiRequest?.id, "ui-1", "an unanswered dialog is rebuilt from the replay");

		const entries = channel.commandsOfType("get_entries");
		assert.equal(entries.length, 1);
		assert.equal(entries[0]?.since, "a1", "only the delta since the disk cursor crosses the pipe");

		const live = outputs.findIndex(output => output.type === "snapshot" && output.payload.phase === "live");
		assert.ok(live >= 0);
		assert.equal(
			outputs.slice(0, live).filter(output => output.type === "event").length,
			0,
			"nothing reaches a page before the authoritative snapshot",
		);
		const painted = snapshots(outputs.slice(0, live));
		assert.ok(
			painted.some(snapshot => snapshot.entries.map(entry => entry.id).join() === "u1,a1"),
			"disk paint published before live, holding the durable tail only",
		);
		const liveSnapshot = snapshots(outputs).find(snapshot => snapshot.phase === "live");
		assert.equal(liveSnapshot?.uiRequests[0]?.id, "ui-1");

		channel.emitMessage("message_end", "msg-4", assistantMessage("later", 5000) as never);
		await tick();
		const forwarded = outputs.slice(live + 1).find(output => output.type === "event");
		assert.ok(forwarded !== undefined && forwarded.type === "event");
		assert.equal(forwarded.epoch.counter, liveSnapshot?.epoch.counter, "events carry the snapshot's epoch");
		assert.equal(forwarded.epoch.nonce, "host-a");
	});

	it("reconciles a message that ended live during the resync with its entry in the delta", async () => {
		const file = await scratchFile("s2.jsonl", [u1, a1]);
		const a3 = messageEntry("a3", "a1", assistantMessage("in flight", 6000));
		const { session } = await boot({
			file,
			child: { sessionFile: file, entries: [u1, a1, a3] as never, leafId: "a3" },
			setup: ch => {
				ch.handlers.set("get_entries", () => {
					// The live frame lands between get_state and the get_entries response.
					ch.emitMessage("message_end", "msg-9", a3.type === "message" ? (a3.message as never) : {});
					return undefined;
				});
			},
		});
		assert.deepEqual(ids(session.model), ["u1", "a1", "a3"]);
		assert.equal(session.model.pending.size, 0);
	});

	it("takes one full read after unknown_since and never sends since again", async () => {
		const file = await scratchFile("s3.jsonl", [u1, a1]);
		const c1 = messageEntry("c1", null, userMessage("other", 100));
		const c2 = messageEntry("c2", "c1", assistantMessage("branch", 200));
		const { channel, session } = await boot({
			file,
			child: { sessionFile: file, entries: [c1, c2] as never, leafId: "c2" },
		});
		const reads = channel.commandsOfType("get_entries");
		assert.equal(reads.length, 2);
		assert.equal(reads[0]?.since, "a1");
		assert.equal("since" in (reads[1] ?? {}), false);
		assert.deepEqual(ids(session.model), ["c1", "c2"]);
		assert.equal(session.phase, "live");
	});

	it("defers a full read while a turn streams and does it at settle", async () => {
		const file = await scratchFile("s4.jsonl", [u1, a1]);
		const c1 = messageEntry("c1", null, userMessage("other", 100));
		const { channel, session } = await boot({
			file,
			child: { sessionFile: file, entries: [c1] as never, leafId: "c1", isStreaming: true },
		});
		assert.equal(channel.commandsOfType("get_entries").length, 1, "only the since read; the full read waits for the turn");
		assert.deepEqual(ids(session.model), ["u1", "a1"]);
		channel.child.isStreaming = false;
		channel.emit({ type: "session_settled" });
		await tick();
		assert.deepEqual(ids(session.model), ["c1"]);
	});

	it("shows history from disk and refuses chat control when the process runs protocol v1", async () => {
		const file = await scratchFile("s5.jsonl", [u1, a1]);
		const { channel, session } = await boot({
			file,
			child: { sessionFile: file, entries: [u1, a1] as never, leafId: "a1" },
			setup: ch => {
				ch.rpcProtocol = 1;
			},
		});
		assert.equal(session.phase, "failed");
		assert.equal(session.model.code, "state-unavailable");
		assert.deepEqual(ids(session.model), ["u1", "a1"]);
		assert.equal(channel.commandsOfType("get_state").length, 0);
		assert.deepEqual(await session.prompt({ requestId: "r1", text: "hi" }), { status: "refused", reason: "not-live" });
	});

	it("waits for ready when the child has not produced it, and fails after the deadline", async () => {
		const rig = await boot({
			noWait: true,
			setup: ch => {
				ch.ready = null;
			},
		});
		await tick();
		assert.equal(rig.session.phase, "attaching");
		rig.timers.advance(120_001);
		await tick();
		assert.equal(rig.session.phase, "failed");
		assert.equal(rig.session.model.code, "ready-timeout");
	});

	it("goes live when `ready` arrives after the attach answered, whatever the last folded line seq is", async () => {
		for (const earlier of [0, 3]) {
			const rig = await boot({
				noWait: true,
				setup: ch => {
					ch.ready = null;
					// Lines the session already folded before the child became ready (seq 1..earlier).
					for (let i = 0; i < earlier; i += 1) ch.emit({ type: "agent_start" });
				},
			});
			await tick();
			assert.equal(rig.session.phase, "attaching", `still waiting (earlier=${earlier})`);
			rig.channel.ready = JSON.stringify({ type: "ready", protocolVersion: 2, supportedProtocolVersions: [1, 2] });
			rig.channel.emitLateReady(2);
			await waitUntil(() => (rig.session.phase as string) === "live");
			assert.equal(rig.session.phase as string, "live", `ready without a seq is not dropped (earlier=${earlier})`);
		}
	});
});

describe("identity", () => {
	it("refuses to bind when get_state names another file, and never sends set_model", async () => {
		const file = await scratchFile("i1.jsonl", [u1]);
		const { channel, session } = await boot({
			file,
			child: { sessionFile: `${file}.other`, entries: [u1] as never, leafId: "u1" },
		});
		assert.equal(session.phase, "failed");
		assert.equal(session.model.code, "identity-mismatch");
		assert.equal(channel.commandsOfType("get_entries").length, 0);
		assert.deepEqual(await session.setModel("p", "m"), { status: "refused", reason: "not-live" });
		assert.equal(channel.commandsOfType("set_model").length, 0);
	});

	it("refuses when get_state carries another session id than the file header", async () => {
		const file = await scratchFile("i2.jsonl", [u1], "header-id");
		const { session } = await boot({
			file,
			child: { sessionFile: file, sessionId: "different", entries: [u1] as never, leafId: "u1" },
		});
		assert.equal(session.model.code, "identity-mismatch");
	});

	it("learns the exact file and id of a new session from get_state and announces them once", async () => {
		const { session, outputs } = await boot({
			child: { sessionFile: "D:\\scratch\\new.jsonl", sessionId: "new-id", entries: [], leafId: null },
		});
		assert.equal(session.phase, "live");
		assert.equal(session.sessionFile, "D:\\scratch\\new.jsonl");
		assert.equal(session.sessionId, "new-id");
		assert.deepEqual(
			outputs.filter(output => output.type === "identity"),
			[{ type: "identity", sessionFile: "D:\\scratch\\new.jsonl", sessionId: "new-id" }],
		);
	});

	it("sets a model only after the identity is bound and reads the answer back", async () => {
		const { session, channel } = await boot({
			child: { sessionFile: "D:\\scratch\\n.jsonl", entries: [], leafId: null },
		});
		const outcome = await session.setModel("prov", "big");
		assert.equal(outcome.status, "accepted");
		assert.deepEqual(channel.commandsOfType("set_model").map(command => [command.provider, command.modelId]), [["prov", "big"]]);
		assert.equal(session.model.state?.model?.id, "big");
	});

	it("preserves OMP's effective clamped thinking level instead of the requested one", async () => {
		const { session, channel } = await boot({ child: { sessionFile: "D:\\scratch\\thinking.jsonl", entries: [], leafId: null } });
		channel.handlers.set("set_thinking_level", () => {
			channel.emit({ type: "thinking_level_changed", thinkingLevel: "high" });
			return {};
		});
		assert.equal((await session.setThinkingLevel("xhigh")).status, "accepted");
		assert.equal(session.model.state?.thinkingLevel, "high");
		channel.handlers.set("set_thinking_level", () => ({}));
		assert.equal((await session.setThinkingLevel("high")).status, "accepted");
		assert.equal(session.model.state?.thinkingLevel, "high");
	});

	it("does not invent model readback from a successful response with no usable model", async () => {
		const { session, channel } = await boot({ child: { sessionFile: "D:\\scratch\\model.jsonl", entries: [], leafId: null } });
		const before = session.model.state?.model;
		channel.handlers.set("set_model", () => ({}));
		assert.equal((await session.setModel("provider", "requested-model")).status, "unconfirmed");
		assert.deepEqual(session.model.state?.model, before);
	});
});

describe("persistence lag", () => {
	it("keeps an unmatched pending row visible, flags it after three attempts and a settle, then replaces it in place", async () => {
		const m0 = { type: "model_change", id: "m0", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", model: "p/m" };
		const { session, channel, timers, outputs } = await boot({
			child: { sessionFile: "D:\\scratch\\lag.jsonl", entries: [m0], leafId: "m0" },
		});
		assert.deepEqual(ids(session.model), ["m0"]);

		channel.emit({ type: "agent_start" });
		channel.emitMessage("message_end", "msg-1", userMessage("q", 5000) as never);
		channel.emit({ type: "agent_end" });
		await tick();
		assert.deepEqual(ids(session.model), ["m0", "live:msg-1"]);

		timers.advance(500);
		await tick();
		timers.advance(500);
		await tick();
		assert.equal(session.model.pending.get("live:msg-1")?.unsaved, false, "not flagged before the settle");
		channel.emit({ type: "session_settled" });
		await tick();
		assert.equal(session.model.pending.get("live:msg-1")?.unsaved, true, "flagged after three attempts and one settle");
		assert.deepEqual(ids(session.model), ["m0", "live:msg-1"], "still visible, never dropped or duplicated");
		const last = snapshots(outputs).at(-1);
		assert.equal(last?.pending[0]?.unsaved, true);

		channel.child.entries.push(messageEntry("d1", "m0", userMessage("q", 5000)) as never);
		channel.child.leafId = "d1";
		channel.emit({ type: "agent_end" });
		await tick();
		assert.deepEqual(ids(session.model), ["m0", "d1"], "the durable entry replaces the pending row");
		assert.equal(session.model.pending.size, 0);
		assert.ok(outputs.some(output => output.type === "entries" && output.payload.entries.some(entry => entry.id === "d1")));
	});

	it("matches a tool result by role, timestamp and toolCallId, not by timestamp alone", async () => {
		const m0 = { type: "model_change", id: "m0", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", model: "p/m" };
		const { session, channel } = await boot({
			child: { sessionFile: "D:\\scratch\\tr.jsonl", entries: [m0], leafId: "m0" },
		});
		channel.emit({ type: "agent_start" });
		channel.emitMessage("message_end", "msg-1", toolResultMessage("call-a", 7000) as never);
		channel.emitMessage("message_end", "msg-2", toolResultMessage("call-b", 7000) as never);
		await tick();
		assert.equal(session.model.pending.size, 2);
		channel.child.entries.push(messageEntry("da", "m0", toolResultMessage("call-b", 7000)) as never);
		channel.child.leafId = "da";
		channel.emit({ type: "agent_end" });
		await tick();
		assert.deepEqual([...session.model.pending.values()].map(row => row.toolCallId), ["call-a"]);
	});
});

describe("command correlation", () => {
	it("resolves out-of-order responses by id", async () => {
		const { session, channel } = await boot({ child: { sessionFile: "D:\\scratch\\c.jsonl", entries: [], leafId: null } });
		channel.autoRespond = false;
		const thinking = session.setThinkingLevel("high");
		const models = session.getAvailableModels();
		await tick();
		const sent = channel.written.slice(-2);
		const thinkingId = sent.find(command => command.type === "set_thinking_level")?.id as string;
		const modelsId = sent.find(command => command.type === "get_available_models")?.id as string;
		assert.notEqual(thinkingId, modelsId);
		channel.emit(responseLine(modelsId, "get_available_models", true, { data: { models: [{ provider: "p", id: "z", name: "Z", contextWindow: 5 }] } }));
		channel.emit({ type: "thinking_level_changed", thinkingLevel: "high" });
		channel.emit(responseLine(thinkingId, "set_thinking_level", true, {}));
		assert.equal((await thinking).status, "accepted");
		const result = await models;
		assert.equal(result.status === "ok" && result.models[0]?.id, "z");
		assert.equal(session.model.state?.thinkingLevel, "high");
	});

	it("sends a prompt exactly once per requestId and correlates prompt_result by id", async () => {
		const { session, channel, outputs } = await boot({ child: { sessionFile: "D:\\scratch\\p.jsonl", entries: [], leafId: null } });
		const first = session.prompt({ requestId: "req-1", text: "hello" });
		const second = session.prompt({ requestId: "req-1", text: "hello" });
		assert.equal(first, second, "a repeat returns the first outcome");
		assert.deepEqual(await first, { status: "accepted", agentInvoked: true });
		const prompts = channel.commandsOfType("prompt");
		assert.equal(prompts.length, 1);
		assert.equal(prompts[0]?.id, "vsc:req-1");
		assert.equal(prompts[0]?.streamingBehavior, "steer");

		channel.emit({ type: "prompt_result", id: "vsc:req-1", agentInvoked: true, status: "completed", sessionSettled: false });
		await tick();
		const result = outputs.find(output => output.type === "prompt-result");
		assert.ok(result !== undefined && result.type === "prompt-result");
		assert.equal(result.requestId, "req-1");
		assert.equal(session.model.lastPromptResult?.status, "completed");
	});

	it("reports a refusal from OMP with its code and a retained late response after a restart", async () => {
		const { session, channel, outputs } = await boot({ child: { sessionFile: "D:\\scratch\\r.jsonl", entries: [], leafId: null } });
		channel.handlers.set("prompt", () => ({ success: false, error: "busy", code: "session_busy" }));
		assert.deepEqual(await session.prompt({ requestId: "req-2", text: "x" }), { status: "refused", reason: "rejected", code: "session_busy" });
		channel.emit(responseLine("vsc:zzz", "prompt", false, { error: "refused", code: "session_busy" }));
		await tick();
		assert.ok(outputs.some(output => output.type === "late-response" && output.requestId === "zzz" && output.success === false));
	});

	it("rejects a request id it cannot put on the wire", async () => {
		const { session, channel } = await boot({ child: { sessionFile: "D:\\scratch\\b.jsonl", entries: [], leafId: null } });
		assert.deepEqual(await session.prompt({ requestId: "bad id\n", text: "x" }), { status: "refused", reason: "bad-request-id" });
		assert.equal(channel.commandsOfType("prompt").length, 0);
	});

	it("refuses model listing while a turn streams (it would queue ahead of abort)", async () => {
		const { session, channel } = await boot({ child: { sessionFile: "D:\\scratch\\w.jsonl", entries: [], leafId: null } });
		channel.emit({ type: "agent_start" });
		await tick();
		assert.deepEqual(await session.getAvailableModels(), { status: "refused", reason: "busy" });
	});

	it("ends outstanding commands when the child exits", async () => {
		const { session, channel } = await boot({ child: { sessionFile: "D:\\scratch\\x.jsonl", entries: [], leafId: null } });
		channel.autoRespond = false;
		const pending = session.abort("req-abort");
		await tick();
		channel.exitChild();
		assert.deepEqual(await pending, { status: "refused", reason: "not-live" });
		assert.equal(session.phase, "stopped");
		assert.equal(session.model.code, "child-exited");
	});
});

describe("authoritative session cost", () => {
	it("reads the native total even when the extension history window is empty", async () => {
		const { session, channel } = await boot();
		channel.handlers.set("get_session_stats", () => ({ data: { sessionId: "sess-1", sessionFile: null, cost: 12.345 } }));
		assert.equal(await session.readSessionCost(), 12.345);
	});

	it("omits unsupported, unpriced and malformed native totals", async () => {
		const { session, channel } = await boot();
		channel.handlers.set("get_session_stats", () => ({ success: false, error: "Unsupported command" }));
		assert.equal(await session.readSessionCost(), null);
		for (const cost of [undefined, 0, "12.34", Infinity]) {
			channel.handlers.set("get_session_stats", () => ({ data: { sessionId: "sess-1", sessionFile: null, cost } }));
			assert.equal(await session.readSessionCost(), null);
		}
	});

	it("rejects totals attributed to another session id or file", async () => {
		const file = await scratchFile("cost.jsonl", []);
		const { session, channel } = await boot({ file });
		channel.handlers.set("get_session_stats", () => ({ data: { sessionId: "other", sessionFile: file, cost: 9 } }));
		assert.equal(await session.readSessionCost(), null);
		channel.handlers.set("get_session_stats", () => ({ data: { sessionId: "sess-1", sessionFile: `${file}.other`, cost: 9 } }));
		assert.equal(await session.readSessionCost(), null);
	});

	it("discards cost readback from an interrupted connection rather than carrying it into the new epoch", async () => {
		const { session, channel } = await boot();
		channel.handlers.set("get_session_stats", () => "drop");
		const epoch = session.epoch.counter;
		const pending = session.readSessionCost();
		await tick();
		const command = channel.commandsOfType("get_session_stats").at(-1);
		assert.ok(command && typeof command.id === "string");
		channel.closeLink("disconnected");
		await tick();
		channel.emit(responseLine(command.id, "get_session_stats", true, { data: { sessionId: "sess-1", sessionFile: null, cost: 9 } }));
		assert.equal(await pending, null);
		assert.ok(session.epoch.counter > epoch);
		channel.handlers.set("get_session_stats", () => ({ data: { sessionId: "sess-1", sessionFile: null, cost: 0.42 } }));
		assert.equal(await session.readSessionCost(), 0.42);
		session.dispose();
		assert.equal(await session.readSessionCost(), null);
	});
});

describe("slash deny-list backstop", () => {
	it("refuses a denied builtin locally without writing anything", async () => {
		const { session, channel } = await boot({ child: { sessionFile: "D:\\scratch\\d.jsonl", entries: [], leafId: null } });
		assert.deepEqual(await session.prompt({ requestId: "d1", text: "/new" }), { status: "refused", reason: "slash-denied", command: "new" });
		assert.equal(channel.commandsOfType("prompt").length, 0);
		assert.deepEqual(await session.prompt({ requestId: "d2", text: "/session delete" }), { status: "refused", reason: "slash-denied", command: "session" });
	});

	it("passes unknown slash text through and fails the tab when the session identity diverged", async () => {
		const file = await scratchFile("d2.jsonl", [u1]);
		const { session, channel } = await boot({ file, child: { sessionFile: file, entries: [u1] as never, leafId: "u1" } });
		assert.equal((await session.prompt({ requestId: "d3", text: "/usr/bin/x fails" })).status, "accepted");
		assert.equal(channel.commandsOfType("prompt").length, 1);
		// An extension command moved the session inside the process.
		channel.child.sessionFile = `${file}.moved`;
		channel.emit({ type: "prompt_result", id: "vsc:d3", agentInvoked: false, status: "completed", sessionSettled: true });
		await tick();
		assert.equal(session.phase, "failed");
		assert.equal(session.model.code, "identity-diverged");
		assert.deepEqual(await session.prompt({ requestId: "d4", text: "hello" }), { status: "refused", reason: "not-live" });
		assert.deepEqual(await session.setModel("p", "m"), { status: "refused", reason: "not-live" });
	});

	it("fails the tab when the bound file disappears after a slash prompt", async () => {
		const file = await scratchFile("d3.jsonl", [u1]);
		const { session, channel } = await boot({
			file,
			child: { sessionFile: file, entries: [u1] as never, leafId: "u1" },
			session: { fileExists: async () => false },
		});
		await session.prompt({ requestId: "d5", text: "/foo" });
		channel.emit({ type: "session_info_update", title: "x" });
		await tick();
		assert.equal(session.model.code, "identity-diverged");
	});
});

describe("message_update coalescing", () => {
	it("parses and forwards only the latest update per messageId in one burst", async () => {
		const { session, channel, outputs } = await boot({ child: { sessionFile: "D:\\scratch\\u.jsonl", entries: [], leafId: null } });
		outputs.length = 0;
		for (let index = 1; index <= 50; index += 1) {
			channel.emitMessage("message_update", "msg-1", assistantMessage("x".repeat(index), 9000) as never);
		}
		channel.emitMessage("message_update", "msg-2", assistantMessage("other", 9001) as never);
		await tick();
		const updates = outputs.filter(output => output.type === "event" && output.frame.type === "message_update");
		assert.equal(updates.length, 2);
		const streamed = session.model.stream;
		assert.equal(streamed?.role, "assistant");
		const first = updates.find(update => update.type === "event" && update.frame.type === "message_update" && update.frame.messageId === "msg-1");
		assert.ok(first !== undefined && first.type === "event" && first.frame.type === "message_update");
		const forwarded = first.frame.message;
		assert.ok(forwarded.role === "assistant");
		const block = forwarded.content[0];
		assert.ok(block !== undefined && block.type === "text");
		assert.equal(block.text.length, 50);
	});

	it("flushes a pending update before a later non-update frame so order is kept", async () => {
		const { session, channel } = await boot({ child: { sessionFile: "D:\\scratch\\o.jsonl", entries: [], leafId: null } });
		channel.emitMessage("message_update", "msg-1", assistantMessage("partial", 9000) as never);
		channel.emitMessage("message_end", "msg-1", assistantMessage("final", 9000) as never);
		await tick();
		assert.equal(session.model.stream, null, "the end frame is applied after the update, so the ghost is gone");
		assert.equal(session.model.pending.size, 1);
	});
});

describe("reattach", () => {
	it("re-attaches with the last seq after the link drops and applies what happened meanwhile", async () => {
		const m0 = { type: "model_change", id: "m0", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", model: "p/m" };
		const { session, channel } = await boot({ child: { sessionFile: "D:\\scratch\\ra.jsonl", entries: [m0], leafId: "m0" } });
		const seqBefore = session.lastSeq;
		channel.closeLink("disconnected");
		channel.emitMessage("message_end", "msg-1", assistantMessage("while away", 8000) as never);
		await tick();
		assert.equal(channel.attachRequests.at(-1), seqBefore, "the cursor is the last folded seq, not 0");
		assert.equal(session.phase, "live");
		assert.deepEqual(ids(session.model), ["m0", "live:msg-1"]);
	});

	it("gives up after the attempt budget", async () => {
		const { session, channel, timers } = await boot({
			child: { sessionFile: "D:\\scratch\\rb.jsonl", entries: [], leafId: null },
			session: { reattachDelaysMs: [10, 10] },
		});
		channel.attachError = true;
		channel.closeLink("disconnected");
		for (let index = 0; index < 4; index += 1) {
			await tick();
			timers.advance(10);
		}
		await tick();
		assert.equal(session.phase, "failed");
		assert.equal(session.model.code, "attach-failed");
	});

	it("reports a prompt sent, unconfirmed across a drop, as lost when no user row ever appears", async () => {
		const { session, channel, outputs } = await boot({ child: { sessionFile: "D:\\scratch\\rc.jsonl", entries: [], leafId: null } });
		channel.autoRespond = false;
		const outcome = session.prompt({ requestId: "lost-1", text: "never arrives" });
		await tick();
		channel.autoRespond = true;
		channel.closeLink("disconnected");
		assert.deepEqual(await outcome, { status: "unconfirmed" });
		await tick();
		assert.ok(outputs.some(output => output.type === "prompt-lost" && output.requestId === "lost-1"));
	});

	it("does not report a prompt lost when its user message shows up after the reattach", async () => {
		const { session, channel, outputs, timers } = await boot({ child: { sessionFile: "D:\\scratch\\rd.jsonl", entries: [], leafId: null } });
		channel.autoRespond = false;
		const outcome = session.prompt({ requestId: "kept-1", text: "arrives" });
		await tick();
		channel.autoRespond = true;
		channel.closeLink("disconnected");
		channel.emitMessage("message_end", "msg-1", userMessage("arrives", timers.now() + 10) as never);
		assert.deepEqual(await outcome, { status: "unconfirmed" });
		await tick();
		assert.equal(outputs.some(output => output.type === "prompt-lost"), false);
	});
});

describe("dialogs and presentation", () => {
	it("queues dialogs FIFO, answers by id, and drops one the child cancels", async () => {
		const { session, channel, outputs } = await boot({ child: { sessionFile: "D:\\scratch\\ui.jsonl", entries: [], leafId: null } });
		channel.emit({
			type: "extension_ui_request",
			id: "a",
			method: "select",
			title: "Run bash?",
			options: ["Approve", "Deny"],
			optionDetails: [{ description: "runs it" }, {}],
		});
		channel.emit({ type: "extension_ui_request", id: "b", method: "confirm", title: "Sure?", message: "really" });
		channel.emit({ type: "extension_ui_request", id: "c", method: "input", title: "Name" });
		await tick();
		assert.equal(session.model.uiRequest?.id, "a");
		assert.deepEqual(session.model.uiQueue.map(request => request.id), ["b", "c"]);
		const head = session.model.uiRequest;
		assert.ok(head !== null && head.method === "select");
		assert.deepEqual(head.options, [{ label: "Approve", description: "runs it" }, { label: "Deny" }]);

		channel.emit({ type: "extension_ui_request", id: "x", method: "cancel", targetId: "b" });
		await tick();
		assert.deepEqual(session.model.uiQueue.map(request => request.id), ["c"]);
		assert.ok(outputs.some(output => output.type === "ui-cancel" && output.targetId === "b"));

		assert.equal(await session.respondUi({ id: "a", value: "Approve" }), true);
		assert.deepEqual(channel.written.at(-1), { type: "extension_ui_response", id: "a", value: "Approve" });
		assert.equal(session.model.uiRequest?.id, "c");
		assert.equal(await session.respondUi({ id: "a", value: "again" }), false, "an answered dialog cannot be answered twice");
	});

	it("opts in to the rich ask dialog on attach, shows one request for every question and writes all answers in one response", async () => {
		const { session, channel } = await boot({ child: { sessionFile: "D:\\scratch\\ask.jsonl", entries: [], leafId: null } });
		assert.deepEqual(channel.commandsOfType("set_ask_dialog").map(command => command.enabled), [true]);
		const questions = [
			{ id: "scope", question: "Scope?", header: "Scope", options: [{ label: "Narrow" }, { label: "Wide", description: "all of it" }], recommended: 1 },
			{ id: "checks", question: "Checks?", multi: true, options: [{ label: "Typecheck" }, { label: "Unit" }] },
		];
		channel.emit({ type: "extension_ui_request", id: "ask-1", method: "ask", questions, timeout: 60000 });
		await tick();
		const head = session.model.uiRequest;
		assert.ok(head !== null && head.method === "ask");
		assert.deepEqual(head.questions.map(question => [question.id, question.multi]), [["scope", false], ["checks", true]]);
		assert.equal(head.title, "Scope? (+1 more)");

		// An answer the child would refuse (wrong count, unknown label) never leaves the extension, and the dialog stays open.
		const before = channel.written.length;
		assert.equal(await session.respondUi({ id: "ask-1", answers: [{ id: "scope", selectedOptions: ["Narrow"] }] }), false);
		assert.equal(await session.respondUi({ id: "ask-1", answers: [{ id: "scope", selectedOptions: ["Huge"] }, { id: "checks", selectedOptions: [] }] }), false);
		assert.equal(channel.written.length, before);
		assert.equal(session.model.uiRequest?.id, "ask-1");

		const answers = [{ id: "scope", selectedOptions: ["Wide"] }, { id: "checks", selectedOptions: ["Typecheck", "Unit"], customInput: "docs too" }];
		assert.equal(await session.respondUi({ id: "ask-1", answers }), true);
		assert.deepEqual(channel.written.at(-1), { type: "extension_ui_response", id: "ask-1", answers });
		assert.equal(session.model.uiRequest, null);
	});

	it("sends a single-choice custom answer as empty selectedOptions plus customInput, not cancellation", async () => {
		const { session, channel } = await boot({ child: { sessionFile: "D:\\scratch\\ask-custom.jsonl", entries: [], leafId: null } });
		channel.emit({ type: "extension_ui_request", id: "ask-custom", method: "ask",
			questions: [{ id: "color", question: "Which color?", options: [{ label: "Red" }, { label: "Green" }] }] });
		await tick();
		const answers = [{ id: "color", selectedOptions: [], customInput: "Violet" }];
		assert.equal(await session.respondUi({ id: "ask-custom", answers }), true);
		assert.deepEqual(channel.written.at(-1), { type: "extension_ui_response", id: "ask-custom", answers });
		assert.equal(session.model.uiRequest, null);
		assert.equal(await session.respondUi({ id: "ask-custom", answers }), false);
	});

	it("cancels an ask it cannot render and keeps working when the child lacks set_ask_dialog", async () => {
		const { session, channel } = await boot({
			child: { sessionFile: "D:\\scratch\\ask2.jsonl", entries: [], leafId: null },
			setup: fake => fake.handlers.set("set_ask_dialog", () => ({ success: false, error: "unknown command", code: "unknown_command" })),
		});
		assert.equal(session.model.phase, "live", "a refused opt-in is not a failure; the child keeps asking through select");
		channel.emit({ type: "extension_ui_request", id: "ask-bad", method: "ask", questions: [{ id: "q", question: "x", options: [{ label: "A\u0000" }] }] });
		await tick();
		assert.equal(session.model.uiRequest, null);
		assert.deepEqual(channel.written.at(-1), { type: "extension_ui_response", id: "ask-bad", cancelled: true });
	});

	it("cancels a dialog it cannot render instead of leaving OMP waiting", async () => {
		const { session, channel } = await boot({ child: { sessionFile: "D:\\scratch\\ui2.jsonl", entries: [], leafId: null } });
		channel.emit({ type: "extension_ui_request", id: "bad", method: "select", title: "t", options: [1, 2] });
		await tick();
		assert.equal(session.model.uiRequest, null);
		assert.deepEqual(channel.written.at(-1), { type: "extension_ui_response", id: "bad", cancelled: true });
		assert.equal(session.diagnostics().unrenderableDialogs, 1);
	});

	it("maps status, composer text and open-url presentation requests", async () => {
		const { session, channel, outputs } = await boot({ child: { sessionFile: "D:\\scratch\\ui3.jsonl", entries: [], leafId: null } });
		channel.emit({ type: "extension_ui_request", id: "s", method: "setStatus", statusKey: "k", statusText: "busy…" });
		channel.emit({ type: "extension_ui_request", id: "e", method: "set_editor_text", text: "prefill" });
		channel.emit({ type: "extension_ui_request", id: "t", method: "setTitle", title: "ignored" });
		channel.emit({ type: "extension_ui_request", id: "o", method: "open_url", url: "https://example.test/x", instructions: "sign in" });
		await tick();
		assert.equal(session.model.statusLine, "busy…");
		assert.equal(session.model.pendingEditorText?.text, "prefill");
		assert.ok(outputs.some(output => output.type === "open-url" && output.url === "https://example.test/x"));
		assert.equal(session.model.header?.title ?? null, null, "setTitle does not rename the tab");
	});

	it("does not forward agent_end.messages or assistantMessageEvent", async () => {
		const { channel, outputs } = await boot({ child: { sessionFile: "D:\\scratch\\st.jsonl", entries: [], leafId: null } });
		outputs.length = 0;
		channel.emit({ type: "agent_end", isTerminal: true, messages: [assistantMessage("dup", 1)] });
		channel.emit(
			`{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"x","partial":{"role":"assistant"}},"message":${JSON.stringify(assistantMessage("x", 10))},"messageId":"msg-7"}`,
		);
		await tick();
		const text = JSON.stringify(outputs.filter(output => output.type === "event"));
		assert.equal(text.includes("assistantMessageEvent"), false);
		assert.equal(text.includes("dup"), false);
	});
});

describe("protocol errors", () => {
	it("counts a broken line, resyncs, and keeps the session live", async () => {
		const { session, channel } = await boot({ child: { sessionFile: "D:\\scratch\\pe.jsonl", entries: [], leafId: null } });
		const before = session.diagnostics().resyncs;
		channel.emit("{this is not json");
		channel.emit("stray stdout from an extension");
		await tick();
		const diagnostics = session.diagnostics();
		assert.equal(diagnostics.frames.parseErrors, 1);
		assert.equal(diagnostics.frames.strayLines, 1);
		assert.equal(diagnostics.resyncs, before + 1);
		assert.equal(session.phase, "live");
	});
});

describe("native authority cuts and child reads", () => {
	it("applies roster and todo snapshots before a later line in the same synchronous stdout burst", async () => {
		const current = [{ name: "Work", tasks: [{ content: "After cut", status: "in_progress" }] }];
		const { session } = await boot({
			setup: channel => {
				channel.handlers.set("get_state", command => {
					channel.emit(responseLine(command.id as string, "get_state", true, { data: { sessionId: "sess-1", isStreaming: false, isSettled: true, todoPhases: [] } }));
					channel.emit({ type: "tool_execution_end", toolCallId: "todo", toolName: "todo", result: { details: { op: "update", phases: current } } });
					return "drop";
				});
				channel.handlers.set("get_subagents", command => {
					channel.emit(responseLine(command.id as string, "get_subagents", true, { data: { subagents: [{ id: "child", index: 0, agent: "scout", agentSource: "builtin", status: "running", lastUpdate: 1, parentToolCallId: "owner" }] } }));
					channel.emit({ type: "subagent_progress", payload: { index: 0, agent: "scout", agentSource: "builtin", task: "Newest progress", parentToolCallId: "owner", progress: { id: "child", status: "completed" } } });
					return "drop";
				});
			},
		});
		assert.deepEqual(session.model.todo?.phases, current);
		assert.equal(session.model.agents.get("child")?.task, "Newest progress");
		assert.equal(session.model.agents.get("child")?.status, "completed", "membership persists until its lifecycle removal");
		session.dispose();
	});

	it("reports a unavailable roster without taking otherwise healthy chat control down", async () => {
		const { session } = await boot({ setup: channel => channel.handlers.set("get_subagents", () => ({ success: false, code: "unsupported", error: "Child prose is not a connection label" })) });
		assert.equal(session.phase, "live");
		assert.equal(session.model.agentAvailability, "unavailable");
		assert.equal((await session.prompt({ requestId: "still-works", text: "Hello" })).status, "accepted");
		session.dispose();
	});

	it("refreshes canonical todos after a non-agent slash completion without a streamed todo result", async () => {
		const { session, channel } = await boot();
		await session.prompt({ requestId: "todo-edit", text: "/todo" });
		channel.child.todoPhases = [{ name: "Edited", tasks: [{ content: "User edited task", status: "blocked", blocker: "Approval" }] }];
		channel.emit({ type: "prompt_result", id: "vsc:todo-edit", status: "completed", agentInvoked: false, sessionSettled: true });
		await tick();
		assert.deepEqual(session.model.todo?.phases, channel.child.todoPhases);
		session.dispose();
	});

	it("never gives an unobserved page identifier filesystem authority and pages an observed child's real history", async () => {
		const childRows = Array.from({ length: 205 }, (_, index) => messageEntry(`child-${index}`, index === 0 ? null : `child-${index - 1}`, userMessage(`Child message ${index}`, index + 1)));
		const { session, channel } = await boot({ setup: ch => ch.handlers.set("get_subagent_messages", () => ({ data: { sessionFile: "D:\\scratch\\child.jsonl", fromByte: 0, nextByte: 9000, reset: false, entries: childRows, messages: [] } })) });
		assert.deepEqual(await session.subagentMessages("D:\\private\\secrets.jsonl", 0), { status: "unavailable", reason: "unknown" });
		assert.equal(channel.commandsOfType("get_subagent_messages").length, 0);
		channel.emit({ type: "subagent_lifecycle", payload: { id: "child", index: 0, agent: "scout", agentSource: "builtin", status: "started", parentToolCallId: "owner" } });
		const page = await session.subagentMessages("child", 0);
		assert.equal(page.status, "available");
		if (page.status !== "available") throw new Error("Expected child history");
		assert.equal(page.entries[0]?.id, "child-5");
		assert.equal(page.entries.at(-1)?.id, "child-204");
		assert.equal(page.olderCount, 5);
		const older = await session.subagentMessages("child", page.nextByte, "child-5");
		assert.equal(older.status, "available");
		if (older.status !== "available") throw new Error("Expected older child history");
		assert.deepEqual(older.entries.map(row => row.id), ["child-0", "child-1", "child-2", "child-3", "child-4"]);
		assert.equal(session.model.entries.length, 0, "child history does not append to its parent");
		channel.handlers.set("get_subagent_messages", () => ({ success: false, code: "not_found", error: "Retained reference pruned" }));
		assert.deepEqual(await session.subagentMessages("child", 0), { status: "unavailable", reason: "read-failed" });
		session.dispose();
	});

	it("allows a nested native child identity only after its containing task history was observed", async () => {
		const taskRow = messageEntry("nested-task", null, toolResultMessage("task-call", 1, "task", { results: [{ id: "nested", sessionFile: "D:\\scratch\\nested.jsonl" }] }));
		const { session, channel } = await boot({ setup: ch => ch.handlers.set("get_subagent_messages", () => ({ data: { sessionFile: "D:\\scratch\\child.jsonl", fromByte: 0, nextByte: 400, reset: false, entries: [taskRow], messages: [] } })) });
		assert.deepEqual(await session.subagentMessages("nested", 0), { status: "unavailable", reason: "unknown" });
		channel.emit({ type: "subagent_lifecycle", payload: { id: "child", index: 0, agent: "implementer", agentSource: "builtin", status: "started" } });
		assert.equal((await session.subagentMessages("child", 0)).status, "available");
		assert.equal((await session.subagentMessages("nested", 0)).status, "available");
		assert.equal(channel.commandsOfType("get_subagent_messages").at(-1)?.subagentId, "nested");
		assert.equal(channel.commandsOfType("get_subagent_messages").at(-1)?.sessionFile, undefined, "page ids never become path selectors");
		session.dispose();
	});
});

describe("mode-transition admission and settlement", () => {
	it("fences every mutating entry point and restores ordinary admission on cancellation", async () => {
		const { session, channel } = await boot();
		channel.emit({ type: "extension_ui_request", id: "approve", method: "confirm", title: "Approve?" });
		await tick();
		session.setMutationFence("Changing session view.");
		const before = channel.written.length;
		const outcomes = await Promise.all([
			session.prompt({ requestId: "fenced-prompt", text: "hello" }),
			session.steer({ requestId: "fenced-steer", text: "hello" }),
			session.followUp({ requestId: "fenced-follow", text: "hello" }),
			session.abort("fenced-abort"),
			session.setModel("p", "m"),
			session.setThinkingLevel("high"),
			session.setSessionName("Do not rename"),
		]);
		assert.ok(outcomes.every(outcome => outcome.status === "refused"));
		assert.equal(await session.respondUi({ id: "approve", confirmed: true }), false);
		assert.equal(channel.written.length, before, "fenced input must not reach the old writer");
		assert.equal(session.model.uiRequest?.id, "approve", "a fenced answer remains unanswered");
		assert.equal((await session.abortForShutdown()).status, "accepted", "the owning lifecycle can abort after consent");
		session.setMutationFence(null);
		assert.equal((await session.prompt({ requestId: "after-cancel", text: "hello" })).status, "accepted");
		assert.equal(await session.respondUi({ id: "approve", confirmed: true }), true);
		session.dispose();
	});

	it("reads fresh settlement/content and refuses a changed native identity", async () => {
		const { session, channel } = await boot({ child: { sessionId: "settlement-session" } });
		assert.deepEqual(await session.readSettlement(), { sessionFile: null, sessionId: "settlement-session", settled: true, hasContent: false });
		channel.handlers.set("get_state", () => ({ data: { sessionId: "settlement-session", isStreaming: false, isSettled: true, isCompacting: true, messageCount: 1 } }));
		assert.deepEqual(await session.readSettlement(), { sessionFile: null, sessionId: "settlement-session", settled: false, hasContent: true });
		channel.handlers.set("get_state", () => ({ data: { sessionId: "settlement-session", isStreaming: false, isSettled: false } }));
		assert.deepEqual(await session.readSettlement(), { sessionFile: null, sessionId: "settlement-session", settled: false, hasContent: null });
		channel.handlers.set("get_state", () => ({ data: { sessionId: "another-session", isStreaming: false, isSettled: true, messageCount: 0 } }));
		assert.equal(await session.readSettlement(), null, "an idle snapshot of another conversation cannot authorize shutdown");
		session.dispose();
		assert.equal(await session.readSettlement(), null);
	});
});

describe("initial slash catalogue", () => {
	it("hydrates pre-existing commands without waiting for another catalogue change", async () => {
		const { session } = await boot({ setup: channel => channel.handlers.set("get_available_commands", () => ({ data: { commands: [{ name: "skill:review", input: { hint: "file" }, aliases: ["review"] }] } })) });
		assert.equal(session.model.commands[0]?.name, "skill:review");
		assert.equal(session.model.commands[0]?.inputHint, "file");
		session.dispose();
	});

	it("never lets a slow initial response overwrite a newer pushed catalogue", async () => {
		const { session, channel } = await boot({ setup: channel => channel.handlers.set("get_available_commands", () => "drop") });
		const query = channel.commandsOfType("get_available_commands")[0]!;
		channel.emit({ type: "available_commands_update", commands: [{ name: "newer" }] });
		channel.emit(responseLine(typeof query.id === "string" ? query.id : undefined, "get_available_commands", true, { data: { commands: [{ name: "stale" }] } }));
		await tick();
		assert.deepEqual(session.model.commands.map(command => command.name), ["newer"]);
		session.dispose();
	});
});

describe("authoritative async pause readback", () => {
	it("waits through pending delivery and earns one finish on a no-wake drain, without idle polling", async () => {
		let pending = false;
		const { session, channel, timers } = await boot({ setup: channel => channel.handlers.set("get_state", () => ({ data: { sessionId: "sess-1", sessionFile: null, isStreaming: false, hasPendingAsyncWork: pending, isSettled: !pending } })) });
		const ledger = new TurnActivityLedger();
		const notices: TurnNotice[] = [];
		ledger.baseline("s", turnActivity(session.model)!);
		session.subscribe(output => {
			if (output.type !== "model") return;
			const activity = turnActivity(output.model);
			if (activity !== null) notices.push(...ledger.observe("s", activity, null));
		});
		channel.emit({ type: "agent_start" });
		channel.emit({ type: "message_end", messageId: "paused", message: assistantMessage("Main finished; waiting for delivery", timers.now()) });
		pending = true;
		channel.emit({ type: "agent_end", isTerminal: false, awaitingAsyncWork: true, outcome: "stop" });
		assert.equal(turnActivity(session.model)?.backgroundWork, true);
		assert.equal(session.model.displayTurns[0]?.complete, false);
		timers.advance(1000);
		await tick();
		assert.deepEqual(notices, []);
		assert.equal(session.model.settled, false, "a completed job with pending delivery still cannot finish");
		pending = false;
		timers.advance(1000);
		await tick();
		assert.deepEqual(notices, [{ kind: "turn-complete", outcome: "stop" }]);
		assert.equal(turnActivity(session.model)?.backgroundWork, false);
		assert.equal(session.model.displayTurns[0]?.completedAt, timers.now());
		const idleReads = channel.commandsOfType("get_state").length;
		timers.advance(5000);
		await tick();
		assert.equal(channel.commandsOfType("get_state").length, idleReads, "ordinary idle does not poll");
		assert.deepEqual(notices, [{ kind: "turn-complete", outcome: "stop" }]);
		session.dispose();
	});

	it("reattach restores actual background status but never recreates a historical finish candidate", async () => {
		let pending = true;
		const { session, channel, timers } = await boot({ setup: channel => channel.handlers.set("get_state", () => ({ data: { sessionId: "sess-1", sessionFile: null, isStreaming: false, hasPendingAsyncWork: pending, isSettled: !pending } })) });
		assert.equal(turnActivity(session.model)?.backgroundWork, true);
		assert.equal(session.model.settled, false);
		channel.emit({ type: "agent_start" });
		channel.emit({ type: "agent_end", isTerminal: false, awaitingAsyncWork: true, outcome: "stop" });
		channel.closeLink("disconnected");
		await tick();
		assert.equal(session.phase, "live");
		assert.equal(session.model.asyncPaused, true);
		assert.equal(session.model.lastAgentOutcome, null);
		const ledger = new TurnActivityLedger();
		ledger.baseline("s", turnActivity(session.model)!);
		pending = false;
		timers.advance(1000);
		await tick();
		assert.equal(session.model.settled, true);
		assert.deepEqual(ledger.observe("s", turnActivity(session.model)!, null), []);
		session.dispose();
	});

	it("a terminal child requests state immediately but cannot outrun pending background delivery", async () => {
		let pending = true;
		const { session, channel } = await boot({ setup: channel => channel.handlers.set("get_state", () => ({ data: { sessionId: "sess-1", sessionFile: null, isStreaming: false, hasPendingAsyncWork: pending, isSettled: !pending } })) });
		channel.emit({ type: "agent_start" });
		channel.emit({ type: "subagent_lifecycle", payload: { id: "child", index: 0, agent: "scout", agentSource: "builtin", status: "started" } });
		channel.emit({ type: "agent_end", isTerminal: false, awaitingAsyncWork: true, outcome: "stop" });
		channel.emit({ type: "subagent_lifecycle", payload: { id: "child", index: 0, agent: "scout", agentSource: "builtin", status: "completed" } });
		await tick();
		assert.equal(session.model.state?.hasPendingAsyncWork, true);
		assert.equal(session.model.settled, false);
		pending = false;
		// A second genuine child transition tests the event-driven readback rather than a timer.
		channel.emit({ type: "subagent_lifecycle", payload: { id: "other", index: 1, agent: "scout", agentSource: "builtin", status: "started" } });
		channel.emit({ type: "subagent_lifecycle", payload: { id: "other", index: 1, agent: "scout", agentSource: "builtin", status: "aborted" } });
		await tick();
		assert.equal(session.model.asyncPaused, false);
		assert.equal(session.model.settled, true);
		session.dispose();
	});

	it("keeps a user's abort veto across reattach and a late completed prompt result", async () => {
		let pending = true;
		const { session, channel, timers } = await boot({ setup: channel => channel.handlers.set("get_state", () => ({ data: { sessionId: "sess-1", sessionFile: null, isStreaming: false, hasPendingAsyncWork: pending, isSettled: !pending } })) });
		const ledger = new TurnActivityLedger();
		const notices: TurnNotice[] = [];
		let baseline = false;
		ledger.baseline("s", turnActivity(session.model)!);
		session.subscribe(output => {
			if (output.type === "snapshot" && output.baseline) baseline = true;
			if (output.type !== "model") return;
			const activity = turnActivity(output.model);
			if (activity === null) return;
			if (baseline) { ledger.baseline("s", activity); baseline = false; }
			else notices.push(...ledger.observe("s", activity, null));
		});
		channel.emit({ type: "agent_start" });
		channel.emit({ type: "agent_end", isTerminal: false, awaitingAsyncWork: true, outcome: "stop" });
		await session.abort("cancel-paused");
		channel.closeLink("disconnected");
		await tick();
		assert.equal(session.model.abortRequested, true);
		channel.emit({ type: "prompt_result", status: "completed", agentInvoked: true, sessionSettled: false });
		pending = false;
		timers.advance(1000);
		await tick();
		assert.equal(session.model.settled, true);
		assert.deepEqual(notices, []);
		session.dispose();
	});
});

/** A clock whose `now()` throws on its second call after `armFailure()`: the throw lands inside frame folding. */
class FoldFailureTimers extends ManualTimers {
	#calls = -1;
	armFailure(): void {
		this.#calls = 0;
	}
	override now(): number {
		if (this.#calls >= 0) {
			this.#calls += 1;
			if (this.#calls === 2) {
				this.#calls = -1;
				throw new Error("the fold failed");
			}
		}
		return super.now();
	}
}

describe("connection loss and recovery", () => {
	const watchdog = { watchdogIntervalMs: 1_000, workingSilenceMs: 5_000, idleSilenceMs: 5_000, probeTimeoutMs: 2_000 };
	const child = { sessionFile: "D:\\scratch\\loss.jsonl", entries: [], leafId: null };

	function recoveries(outputs: readonly RpcSessionOutput[]): string[] {
		return outputs.flatMap(output => (output.type === "recovery" ? [output.reason] : []));
	}

	async function lose(rig: Rig, budgetTicks = 4): Promise<void> {
		rig.channel.attachError = true;
		rig.channel.closeLink("disconnected");
		for (let index = 0; index < budgetTicks; index += 1) {
			await tick();
			rig.timers.advance(10);
		}
		await tick();
	}

	it("replaces a connection that stops answering instead of waiting on it", async () => {
		const { session, channel, timers, outputs } = await boot({ child, session: { ...watchdog, autoRecoveryDelaysMs: [] } });
		const attaches = channel.attachRequests.length;
		channel.handlers.set("get_state", () => "drop");
		timers.advance(5_000);
		await tick();
		const probes = channel.commandsOfType("get_state").length;
		assert.equal(session.diagnostics().watchdogProbes, 1, "a silent live connection is probed once, not hammered");
		timers.advance(2_000);
		// The child answers again by the time the replacement connection asks for its state.
		channel.handlers.delete("get_state");
		await tick();
		assert.equal(channel.disconnects, 1, "the unresponsive connection is dropped");
		assert.equal(channel.attachRequests.length, attaches + 1, "and the same process is attached to again");
		assert.ok(channel.commandsOfType("get_state").length > probes, "identity is proved again over the new connection");
		assert.equal(session.phase, "live");
		assert.deepEqual(recoveries(outputs), ["probe-timeout"]);
		session.dispose();
	});

	it("never leaves a turn the child already finished showing as working", async () => {
		const { session, channel, timers, outputs } = await boot({ child, session: { ...watchdog, autoRecoveryDelaysMs: [] } });
		channel.emit({ type: "agent_start" });
		await tick();
		assert.equal(session.model.working, true);
		// The end of the turn never reached the host; the child is idle.
		channel.child.isStreaming = false;
		const entries = channel.commandsOfType("get_entries").length;
		const attaches = channel.attachRequests.length;
		timers.advance(5_000);
		await tick();
		assert.equal(session.model.working, false);
		assert.equal(channel.attachRequests.length, attaches, "an answering child needs no new connection");
		assert.ok(channel.commandsOfType("get_entries").length > entries, "what the missed end produced is read from the child");
		assert.deepEqual(recoveries(outputs), ["stale-working"]);
		session.dispose();
	});

	it("does not probe a connection that keeps delivering", async () => {
		const { session, channel, timers, outputs } = await boot({ child, session: { ...watchdog, autoRecoveryDelaysMs: [] } });
		const states = channel.commandsOfType("get_state").length;
		for (let second = 0; second < 20; second += 1) {
			channel.emit({ type: "agent_start" });
			timers.advance(1_000);
			await tick(2);
		}
		assert.equal(channel.commandsOfType("get_state").length, states);
		assert.equal(session.diagnostics().watchdogProbes, 0);
		assert.deepEqual(recoveries(outputs), []);
		session.dispose();
	});

	it("heals a frame that cannot be folded with an authoritative rebuild instead of stranding the stream", async () => {
		const timers = new FoldFailureTimers();
		const channel = new FakeRpcChannel(child);
		const session = new RpcSession({ channel, sessionFile: null, cwd: "D:\\scratch", hostNonce: "host-a", timers, fileExists: async () => true });
		const outputs: RpcSessionOutput[] = [];
		session.subscribe(output => outputs.push(output));
		await session.start();
		await tick();
		const states = channel.commandsOfType("get_state").length;
		timers.armFailure();
		channel.emit({ type: "agent_start" });
		await tick();
		assert.equal(session.diagnostics().frameFailures, 1);
		assert.deepEqual(recoveries(outputs), ["frame-failure"]);
		assert.ok(channel.commandsOfType("get_state").length > states, "state is read back from the child");
		assert.equal(session.phase, "live");
		// The stream keeps folding afterwards.
		channel.emit({ type: "agent_start" });
		await tick();
		assert.equal(session.model.working, true);
		session.dispose();
	});

	it("retains unanswered-state evidence across same-process attach and events, clearing it only on native state readback", async () => {
		const { session, channel, timers } = await boot({
			child, noWait: true,
			setup: channel => channel.handlers.set("get_state", () => "drop"),
			session: { commandTimeoutMs: 10, autoRecoveryDelaysMs: [] },
		});
		try {
			timers.advance(10); await tick();
			assert.equal(session.model.code, "state-failed");
			assert.equal(session.nativeStateUnanswered, true);
			const nonce = session.epoch.nonce;
			assert.equal(session.reconnect(), "started");
			await tick();
			assert.equal(session.phase, "resyncing");
			channel.emit({ type: "agent_start" }); await tick();
			assert.equal(session.nativeStateUnanswered, true, "attach and transcript activity are not command responsiveness");
			assert.equal(session.epoch.nonce, nonce, "Reconnect retains the native generation");
			timers.advance(10); await tick();
			assert.equal(session.model.code, "state-failed");
			channel.handlers.delete("get_state");
			assert.equal(session.reconnect(), "started");
			await tick();
			assert.equal(session.phase, "live");
			assert.equal(session.nativeStateUnanswered, false);
			assert.deepEqual(channel.commandsOfType("prompt"), [], "recovery cannot replay input");
		} finally { session.dispose(); }
	});

	it("does not revive older unanswered-read evidence after a newer authoritative answer", async () => {
		const { session, channel, timers } = await boot({ child, session: { commandTimeoutMs: 10, autoRecoveryDelaysMs: [] } });
		try {
			channel.handlers.set("get_state", () => "drop");
			const old = session.readSettlement(); await tick();
			channel.handlers.delete("get_state");
			assert.ok(await session.readSettlement());
			timers.advance(10); await tick();
			assert.equal(await old, null);
			assert.equal(session.nativeStateUnanswered, false);
		} finally { session.dispose(); }
	});

	it("reconnects a failed session in place on request, to the same process, with nothing launched", async () => {
		const rig = await boot({ child, session: { reattachDelaysMs: [10], autoRecoveryDelaysMs: [] } });
		const { session, channel, outputs } = rig;
		channel.emit({ type: "agent_start" });
		await tick();
		await lose(rig);
		assert.equal(session.phase, "failed");
		assert.equal(session.model.code, "attach-failed");
		assert.equal(session.model.working, false, "a failed connection keeps no stale spinner");
		channel.attachError = false;
		assert.equal(session.reconnect(), "started");
		await tick();
		assert.equal(session.phase, "live");
		assert.equal(session.model.code, null);
		assert.deepEqual(channel.commandsOfType("prompt"), []);
		assert.ok(recoveries(outputs).includes("manual-reconnect"));
		session.dispose();
	});

	it("retries a recoverable failure on its own with a growing delay", async () => {
		const rig = await boot({ child, session: { reattachDelaysMs: [10], autoRecoveryDelaysMs: [100, 200] } });
		const { session, channel, timers, outputs } = rig;
		await lose(rig);
		assert.equal(session.phase, "failed");
		timers.advance(100);
		await tick();
		for (let index = 0; index < 4; index += 1) {
			await tick();
			timers.advance(10);
		}
		assert.equal(session.phase, "failed", "the first retry still finds the process unreachable");
		channel.attachError = false;
		timers.advance(200);
		await tick();
		assert.equal(session.phase, "live");
		assert.deepEqual(recoveries(outputs), ["auto-retry", "auto-retry"]);
		session.dispose();
	});

	it("refuses to reconnect a session whose identity diverged or whose process exited", async () => {
		const file = await scratchFile("rc-id.jsonl", [u1]);
		const mismatched = await boot({ file, child: { sessionFile: `${file}.other`, entries: [u1] as never, leafId: "u1" } });
		assert.equal(mismatched.session.model.code, "identity-mismatch");
		assert.equal(mismatched.session.reconnect(), "refused");
		assert.equal(mismatched.channel.disconnects, 0, "a refusal touches nothing");

		const exited = await boot({ child });
		exited.channel.exitChild();
		await tick();
		assert.equal(exited.session.phase, "stopped");
		assert.equal(exited.session.reconnect(), "refused");
		mismatched.session.dispose();
		exited.session.dispose();
	});
});
