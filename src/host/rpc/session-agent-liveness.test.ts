/** The host's handling of the Desk liveness signal (ADR-0053) on a real `RpcSession` over the fake child. */
import assert from "node:assert/strict";
import { it } from "node:test";
import { AGENT_LIVENESS_STATUS_KEY, encodeAgentLiveness, type LiveAgent } from "../../chat/agent-liveness.ts";
import { FakeRpcChannel } from "./fake-channel.ts";
import { RpcSession, type RpcSessionOutput } from "./session.ts";
import { ManualTimers, tick } from "./test-support.ts";

const INSTANCE = "0123456789abcdef0123456789abcdef";
const worker: LiveAgent = { id: "Worker", agent: "task", state: "idle", tool: "bash", intent: "Sleeping" };

function status(seq: number, agents: readonly LiveAgent[], sessionId = "sess-1"): Record<string, unknown> {
	return { type: "extension_ui_request", id: `s${seq}`, method: "setStatus", statusKey: AGENT_LIVENESS_STATUS_KEY, statusText: encodeAgentLiveness({ v: 1, instance: INSTANCE, seq, sessionId, agents }) };
}

it("folds the bound session's liveness signal into the Agents roster and never into the status line", async () => {
	const channel = new FakeRpcChannel({ sessionFile: "D:\\scratch\\live.jsonl", entries: [], leafId: null });
	const session = new RpcSession({ channel, sessionFile: null, cwd: "D:\\scratch", hostNonce: "host-a", timers: new ManualTimers(), fileExists: async () => true });
	const outputs: RpcSessionOutput[] = [];
	session.subscribe(output => outputs.push(output));
	await session.start();
	await tick();
	channel.emit(status(1, [worker], "another-session"));
	await tick();
	assert.equal(session.model.agents.size, 0, "another session's signal is dropped");
	channel.emit(status(2, [worker]));
	await tick();
	assert.equal(session.model.agents.get("Worker")?.origin, "registry");
	assert.equal(session.model.statusLine, null);
	assert.equal(session.model.statusEntries.size, 0);
	assert.ok(outputs.some(output => output.type === "event" && output.frame.type === "agents_liveness"), "the page receives the same frame");
	channel.closeLink("disconnected");
	for (let index = 0; index < 6; index += 1) await tick();
	assert.equal(session.phase, "live");
	assert.equal(session.model.agents.get("Worker")?.origin, "registry", "a reattach restores the newest accepted publication");
	channel.emit(status(2, []));
	await tick();
	assert.equal(session.model.agents.has("Worker"), true, "a replayed sequence number is ignored");
	channel.emit(status(3, []));
	await tick();
	assert.equal(session.model.agents.has("Worker"), false);
	channel.emit({ type: "extension_ui_request", id: "bad", method: "setStatus", statusKey: AGENT_LIVENESS_STATUS_KEY, statusText: "not json" });
	await tick();
	assert.equal(session.model.statusEntries.size, 0, "a malformed signal is not shown either");
	session.dispose();
});
