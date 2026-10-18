/**
 * What a fork of a live session starts from (`RpcSession.forkSource`): ready with the file, id and folder, or the host's
 * refusal. Runner: `node --test src/host/rpc/session-fork.test.ts`.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { FORK_REFUSAL_SENTENCES } from "../../chat/fork.ts";
import { FakeRpcChannel } from "./fake-channel.ts";
import { RpcSession } from "./session.ts";
import { ManualTimers, assistantMessage, messageEntry, tick, userMessage } from "./test-support.ts";

const sessions: RpcSession[] = [];
afterEach(() => { for (const session of sessions.splice(0)) session.dispose(); });
const FILE = "D:\\scratch\\2026-10-18T10-00-00_sess-1.jsonl";
const CWD = "D:\\scratch\\project";
const u1 = messageEntry("u1", null, userMessage("hi", 1000)) as never as Record<string, unknown>;
const a1 = messageEntry("a1", "u1", assistantMessage("hello", 2000)) as never as Record<string, unknown>;

function rig(entries: Record<string, unknown>[] = [u1, a1]) {
	const last = entries.at(-1)?.id;
	const channel = new FakeRpcChannel({ sessionFile: FILE, entries, leafId: typeof last === "string" ? last : null });
	const session = new RpcSession({ channel, sessionFile: null, cwd: CWD, hostNonce: "host-a", timers: new ManualTimers(), watchdogIntervalMs: 60 * 60_000 });
	sessions.push(session);
	return { channel, session };
}

async function booted(entries?: Record<string, unknown>[]) {
	const made = rig(entries);
	await made.session.start(); await tick();
	return made;
}

describe("RpcSession.forkSource", () => {
	it("is ready with the file, the session id and the folder for an idle live session with saved entries", async () => {
		const { session } = await booted();
		assert.deepEqual(session.forkSource(), { status: "ready", file: FILE, sessionId: "sess-1", cwd: CWD });
	});

	it("never fences or writes: asking twice answers the same and sends nothing", async () => {
		const { channel, session } = await booted();
		const before = channel.written.length;
		assert.deepEqual(session.forkSource(), session.forkSource());
		assert.equal(channel.written.length, before);
		assert.equal(channel.commandsOfType("prompt").length, 0);
	});

	it("is not-live before the identity is known", async () => {
		const { session } = rig();
		assert.deepEqual(session.forkSource(), { status: "refused", reason: "not-live" });
	});

	it("is busy while a response streams", async () => {
		const { channel, session } = await booted();
		channel.emit({ type: "agent_start" }); await tick();
		assert.deepEqual(session.forkSource(), { status: "refused", reason: "busy" });
		assert.equal(FORK_REFUSAL_SENTENCES.busy, "Wait for the current response to finish or abort it before forking.");
	});

	it("is busy while a message waits in OMP's queue", async () => {
		const { channel, session } = await booted();
		channel.emit({ type: "queue_update", steering: ["later"], followUp: [] }); await tick();
		assert.deepEqual(session.forkSource(), { status: "refused", reason: "busy" });
		channel.emit({ type: "queue_update", steering: [], followUp: [] }); await tick();
		assert.equal(session.forkSource().status, "ready", "ready again once the queue is empty");
	});

	it("is busy while a dialog is open", async () => {
		const { channel, session } = await booted();
		channel.emit({ type: "extension_ui_request", id: "ui-1", method: "confirm", title: "Sure?", message: "?" }); await tick();
		assert.deepEqual(session.forkSource(), { status: "refused", reason: "busy" });
	});

	it("is busy while a sent message is not confirmed yet", async () => {
		const { channel, session } = await booted();
		channel.emitMessage("message_end", "m-1", userMessage("typed", 9_000) as never); await tick();
		assert.deepEqual(session.forkSource(), { status: "refused", reason: "busy" });
	});

	it("is busy while OMP has not settled an interrupted turn", async () => {
		const { channel, session } = await booted();
		channel.emit({ type: "agent_start" });
		channel.emit({ type: "agent_end", messages: [] });
		await tick();
		assert.deepEqual(session.forkSource(), { status: "refused", reason: "busy" });
	});

	it("is empty for a session with no durable entry", async () => {
		const { session } = await booted([]);
		assert.deepEqual(session.forkSource(), { status: "refused", reason: "empty" });
	});
});
