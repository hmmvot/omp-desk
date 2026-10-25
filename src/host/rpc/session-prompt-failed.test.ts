/**
 * A prompt OMP acknowledges and then fails on before it writes the user message (no API key, an OAuth refresh the network refused)
 * leaves nothing in the transcript: the composer already cleared, so the message used to vanish without a word. The session hands
 * such a message back (`prompt-failed`) once a reconcile pass has read the file and found no row for it.
 * Runner: `node --test src/host/rpc/session-prompt-failed.test.ts`.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { FakeRpcChannel } from "./fake-channel.ts";
import { RpcSession, type RpcSessionOutput } from "./session.ts";
import { ManualTimers, tick, userMessage } from "./test-support.ts";

const sessions: RpcSession[] = [];
afterEach(() => {
	for (const session of sessions.splice(0)) session.dispose();
});

const IMAGE = { type: "image" as const, mimeType: "image/png", data: "iVBORw0KGgo=" };
const NO_KEY = { message: "No API key found for anthropic.\n\nUse /login, set an API key environment variable", retryable: false };

async function boot() {
	const channel = new FakeRpcChannel({ sessionFile: "D:\\scratch\\pf.jsonl", entries: [], leafId: null });
	const timers = new ManualTimers();
	const session = new RpcSession({ channel, sessionFile: "D:\\scratch\\pf.jsonl", cwd: "D:\\scratch", hostNonce: "host-a", timers, fileExists: async () => true, watchdogIntervalMs: 60 * 60_000 });
	sessions.push(session);
	const outputs: RpcSessionOutput[] = [];
	session.subscribe(output => outputs.push(output));
	await session.start();
	await tick();
	return { channel, session, timers, outputs };
}

const failures = (outputs: readonly RpcSessionOutput[]) => outputs.flatMap(output => output.type === "prompt-failed" ? [output] : []);

function fail(channel: FakeRpcChannel, requestId: string, status: "error" | "aborted" = "error"): void {
	channel.emit({ type: "prompt_result", id: `vsc:${requestId}`, status, agentInvoked: true, sessionSettled: true, ...(status === "error" ? { error: NO_KEY } : {}) });
}

describe("a prompt OMP accepted and then failed on", () => {
	it("is handed back with its text, images and OMP's reason when no user message was ever written", async () => {
		const { session, channel, outputs } = await boot();
		assert.deepEqual(await session.prompt({ requestId: "pf-1", text: "look at this picture", images: [IMAGE] }), { status: "accepted", agentInvoked: true });
		fail(channel, "pf-1");
		await tick();
		const [failed, ...rest] = failures(outputs);
		assert.equal(rest.length, 0);
		assert.equal(failed?.requestId, "pf-1");
		assert.equal(failed?.text, "look at this picture");
		assert.deepEqual(failed?.images, [IMAGE]);
		assert.equal(failed?.error?.message, NO_KEY.message);
	});

	it("is not handed back once its user message is on the branch (the provider failed mid-turn)", async () => {
		const { session, channel, outputs, timers } = await boot();
		await session.prompt({ requestId: "pf-2", text: "answer me" });
		channel.emitMessage("message_end", "m1", userMessage("answer me", timers.now() + 10) as never);
		fail(channel, "pf-2");
		await tick();
		assert.equal(failures(outputs).length, 0);
	});

	it("is not handed back while the message still waits in OMP's queue", async () => {
		const { session, channel, outputs } = await boot();
		await session.prompt({ requestId: "pf-3", text: "queued behind a turn" });
		channel.emit({ type: "queue_update", steering: ["queued behind a turn"], followUp: [] });
		fail(channel, "pf-3");
		await tick();
		assert.equal(failures(outputs).length, 0);
	});

	it("is not handed back for a stop, which has its own restore", async () => {
		const { session, channel, outputs } = await boot();
		await session.prompt({ requestId: "pf-4", text: "stopped early" });
		fail(channel, "pf-4", "aborted");
		await tick();
		assert.equal(failures(outputs).length, 0);
	});

	it("is not handed back for a local command, which writes no user message by design", async () => {
		const { session, channel, outputs } = await boot();
		await session.prompt({ requestId: "pf-5", text: "!ls" });
		fail(channel, "pf-5");
		await tick();
		assert.equal(failures(outputs).length, 0);
	});

	it("is handed back once even when OMP repeats the result, and each failed prompt separately", async () => {
		const { session, channel, outputs } = await boot();
		await session.prompt({ requestId: "pf-6", text: "first" });
		fail(channel, "pf-6");
		fail(channel, "pf-6");
		await tick();
		await session.prompt({ requestId: "pf-7", text: "second" });
		fail(channel, "pf-7");
		await tick();
		assert.deepEqual(failures(outputs).map(item => item.text), ["first", "second"]);
	});
});
