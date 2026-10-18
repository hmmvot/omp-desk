/**
 * A skill invoked while a turn runs. OMP 18.11.1's rpc mode (`dispatchOrderedUserInput`) expands `/skill:<name>` only in a
 * `prompt` (`dispatchRpcSkillPrompt`, which queues the expanded skill under `streamingBehavior`); `steer` and `follow_up` queue
 * the text as typed, so the model would receive the literal `/skill:x`. The session therefore sends a listed skill as a `prompt`
 * with the queue the user chose, accounted like any prompt, and leaves every other message on its own command.
 * Runner: `node --test src/host/rpc/session-skill-queue.test.ts`.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { FakeRpcChannel } from "./fake-channel.ts";
import { RpcSession, type RpcSessionOutput } from "./session.ts";
import { ManualTimers, tick } from "./test-support.ts";

const sessions: RpcSession[] = [];
afterEach(() => {
	for (const session of sessions.splice(0)) session.dispose();
});

async function running() {
	const channel = new FakeRpcChannel({ sessionFile: null });
	channel.handlers.set("get_available_commands", () => ({ data: { commands: [
		{ name: "skill:review", description: "Review code", input: { hint: "arguments" }, source: "skill" },
		{ name: "skill:agents/tracker", input: { hint: "arguments" }, source: "skill" },
		{ name: "compact", source: "builtin" },
	] } }));
	const session = new RpcSession({ channel, sessionFile: null, cwd: "D:\\scratch", hostNonce: "host-a", timers: new ManualTimers(), fileExists: async () => true, watchdogIntervalMs: 60 * 60_000 });
	sessions.push(session);
	const outputs: RpcSessionOutput[] = [];
	session.subscribe(output => outputs.push(output));
	await session.start();
	await tick();
	channel.emit({ type: "agent_start" });
	await tick();
	assert.equal(session.model.working, true);
	return { channel, session, outputs };
}

describe("a message that invokes a listed skill while a turn runs", () => {
	it("goes as a prompt with the queue the user chose, never as a steer or follow_up that OMP would not expand", async () => {
		const { channel, session } = await running();
		assert.equal((await session.steer({ requestId: "s1", text: "/skill:review src/a.ts" })).status, "accepted");
		assert.equal((await session.followUp({ requestId: "f1", text: "later /skill:agents/tracker please" })).status, "accepted");
		assert.deepEqual(channel.commandsOfType("prompt").map(({ id, message, streamingBehavior }) => ({ id, message, streamingBehavior })), [
			{ id: "vsc:s1", message: "/skill:review src/a.ts", streamingBehavior: "steer" },
			{ id: "vsc:f1", message: "later /skill:agents/tracker please", streamingBehavior: "followUp" },
		]);
		assert.equal(channel.commandsOfType("steer").length + channel.commandsOfType("follow_up").length, 0);
	});

	it("carries its images, is exactly-once per request id and is owed a prompt_result like a prompt", async () => {
		const { channel, session, outputs } = await running();
		const image = { type: "image" as const, mimeType: "image/png", data: "AA==" };
		const first = await session.steer({ requestId: "s2", text: "/skill:review", images: [image] });
		assert.deepEqual(await session.steer({ requestId: "s2", text: "/skill:review", images: [image] }), first, "a repeat returns the first outcome");
		assert.equal(channel.commandsOfType("prompt").length, 1);
		assert.deepEqual(channel.commandsOfType("prompt")[0]!.images, [image]);
		channel.emit({ type: "prompt_result", id: "vsc:s2", agentInvoked: true, status: "completed", sessionSettled: false });
		await tick();
		assert.ok(outputs.some(output => output.type === "prompt-result" && output.requestId === "s2"), "the result is correlated with the request");
	});

});

describe("every other message keeps its own command", () => {
	it("a plain steer and follow-up, an unlisted skill, a builtin and a skill inside another command are unchanged", async () => {
		const { channel, session } = await running();
		for (const [index, text] of ["keep going", "/skill:unknown x", "/compact now", "/compact /skill:review x", "!ls /skill:review"].entries()) {
			await session.steer({ requestId: `p${index}`, text });
		}
		await session.followUp({ requestId: "pf", text: "afterwards" });
		assert.deepEqual(channel.commandsOfType("steer").map(command => command.message), ["keep going", "/skill:unknown x", "/compact now", "/compact /skill:review x", "!ls /skill:review"]);
		assert.deepEqual(channel.commandsOfType("follow_up").map(command => command.message), ["afterwards"]);
		assert.equal(channel.commandsOfType("prompt").length, 0);
	});
});
