import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { FakeRpcChannel } from "../rpc/fake-channel.ts";
import { RpcSession } from "../rpc/session.ts";
import { ManualTimers, tick } from "../rpc/test-support.ts";
import { ContextController } from "./context-controller.ts";
import type { ContextControllerDeps, ContextTarget } from "./context-controller.ts";
import type { ContextViewModel } from "./context-model.ts";

const sessions: RpcSession[] = [];
afterEach(() => { for (const session of sessions.splice(0)) session.dispose(); });

const STATS = { sessionId: "sess-1", sessionFile: null, userMessages: 1, assistantMessages: 1, toolCalls: 0, toolResults: 0, totalMessages: 2, premiumRequests: 0,
	tokens: { input: 100, output: 10, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 110 }, cost: 0.5 };

interface Timer { handler: () => void; live: boolean }

function rig() {
	const channel = new FakeRpcChannel({ sessionFile: null });
	channel.handlers.set("get_session_stats", () => ({ data: STATS }));
	const streaming = { value: false };
	channel.handlers.set("get_state", () => ({ data: { sessionId: "sess-1", isStreaming: streaming.value, isCompacting: false, autoCompactionEnabled: true, systemPrompt: ["x"],
		model: { provider: "p", id: "m", name: "M", contextWindow: 20000 }, contextUsage: { tokens: 2100, contextWindow: 20000, percent: 10.5 } } }));
	const session = new RpcSession({ channel, sessionFile: null, cwd: "D:\\scratch", hostNonce: "host-a", timers: new ManualTimers(), fileExists: async () => true, watchdogIntervalMs: 60 * 60_000 });
	sessions.push(session);
	const state = { published: [] as ContextViewModel[], timers: [] as Timer[] };
	/** The extension's `contextTarget`: the generation carries the session's epoch; running is the live phase. */
	const targetOf = (): ContextTarget => ({ key: session, generation: JSON.stringify([session.epoch, session.sessionFile, session.sessionId]), mode: "chat", running: session.phase === "live", title: "Work", tabId: "tab-1", session });
	const deps: ContextControllerDeps = {
		target: targetOf,
		publish: model => { state.published.push(model); },
		notify: () => {},
		schedule: handler => { const timer: Timer = { handler, live: true }; state.timers.push(timer); return timer; },
		cancel: handle => { for (const timer of state.timers) if (timer === handle) timer.live = false; },
		now: () => 0,
		log: () => {},
	};
	const controller = new ContextController(deps);
	// The extension syncs on the baseline publication that makes the session live.
	session.subscribe(output => { if (output.type === "snapshot" && output.baseline) controller.sync(); });
	const fire = async (): Promise<void> => {
		for (let round = 0; round < 20; round += 1) {
			const timer = state.timers.filter(candidate => candidate.live).at(-1);
			if (timer === undefined) break;
			timer.live = false;
			timer.handler();
			await tick();
		}
	};
	const hasDeep = (): boolean => state.published.at(-1)?.groups.some(group => group.id === "stats") === true;
	return { channel, session, controller, state, fire, hasDeep, streaming };
}

describe("controller with a real session", () => {
	it("reads once a session that was starting when the view opened goes live", async () => {
		const r = rig();
		r.controller.setVisible(true);
		await r.session.start();
		await tick();
		await r.fire();
		assert.equal(r.hasDeep(), true);
	});
	it("reads again after a reconnect", async () => {
		const r = rig();
		await r.session.start();
		await tick();
		r.controller.setVisible(true);
		await r.fire();
		assert.equal(r.hasDeep(), true, "first read");
		r.channel.closeLink("disconnected");
		await tick();
		await r.fire();
		assert.equal(r.session.phase, "live");
		assert.equal(r.hasDeep(), true, "after reconnect");
	});
	it("reads a conversation that is mid-turn when the view opens", async () => {
		const r = rig();
		r.channel.child.isStreaming = true;
		r.streaming.value = true;
		await r.session.start();
		await tick();
		r.channel.emit({ type: "agent_start" });
		await tick();
		assert.equal(r.session.model.working, true);
		r.controller.setVisible(true);
		await r.fire();
		assert.equal(r.hasDeep(), true, "the turn does not keep the deep groups away");
	});
	it("shows the deep groups again after a context-full pass inside a long turn", async () => {
		const r = rig();
		r.streaming.value = true;
		await r.session.start();
		await tick();
		r.channel.emit({ type: "agent_start" });
		await tick();
		r.controller.setVisible(true);
		await r.fire();
		assert.equal(r.hasDeep(), true, "read before the pass");
		r.channel.emit({ type: "auto_compaction_start", action: "context-full", reason: "threshold" });
		await tick();
		r.channel.emit({ type: "auto_compaction_end", action: "context-full", result: undefined, aborted: false, willRetry: false });
		await tick();
		await r.fire();
		assert.equal(r.session.model.working, true, "the turn is still running");
		assert.equal(r.hasDeep(), true, "after the pass");
		assert.equal(r.state.published.at(-1)?.groups.find(group => group.id === "maintenance")?.items.some(row => row.key === "maintenance.pass"), true);
	});
});
