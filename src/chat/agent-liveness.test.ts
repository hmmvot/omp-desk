import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AgentLivenessGuard, MAX_AGENT_LIVENESS_CHARS, MAX_LIVE_AGENTS, decodeAgentLiveness, encodeAgentLiveness, parseLiveAgents, type LiveAgent } from "./agent-liveness.ts";
import { agentRow, agentsSummary } from "./hud-summary.ts";
import { applyChatSnapshot, createChatModel, reduceChatFrame, snapshotOf, type ChatModel } from "./model.ts";
import { parseAgentRoster } from "./agents.ts";
import { parseChatHostMessage } from "../webview/chat-messages.ts";

const INSTANCE = "0123456789abcdef0123456789abcdef";
const owner = { sessionFile: "C:\\s\\Worker.jsonl" };
const started = { id: "Worker", index: 0, agent: "implementer", agentSource: "bundled", description: "Fix the parser", ...owner, status: "started" as const };
const resumed: LiveAgent = { id: "Worker", agent: "Worker", state: "idle", ...owner, tool: "bash", intent: "Sleeping 45 s" };

function text(seq: number, agents: readonly LiveAgent[], sessionId = "S1", instance = INSTANCE): string {
	return encodeAgentLiveness({ v: 1, instance, seq, sessionId, agents });
}

/** The spawn, one progress report with its description, then the native roster's completion. */
function spawnedAndCompleted(): ChatModel {
	let model = reduceChatFrame(createChatModel(), { type: "subagent_lifecycle", payload: started });
	model = reduceChatFrame(model, { type: "subagent_progress", payload: { ...started, task: "Fix it", assignment: "Fix the parser", progress: { id: "Worker", status: "running" } } });
	return reduceChatFrame(model, { type: "subagent_lifecycle", payload: { ...started, status: "completed" } });
}

describe("agent liveness signal: identity guard", () => {
	it("accepts only the bound session's publications, in sequence per publisher", () => {
		const guard = new AgentLivenessGuard();
		assert.equal(guard.accept(text(1, [resumed]), null), null, "nothing before the host bound its session");
		assert.equal(guard.accept(text(1, [resumed], "S2"), "S1"), null, "another session's signal");
		assert.deepEqual(guard.accept(text(2, [resumed]), "S1"), [resumed]);
		assert.equal(guard.accept(text(2, []), "S1"), null, "a replayed publication");
		assert.equal(guard.accept(text(1, []), "S1"), null, "an older publication");
		assert.deepEqual(guard.accept(text(3, []), "S1"), []);
		assert.deepEqual(guard.accept(text(1, [resumed], "S1", "f".repeat(32)), "S1"), [resumed], "a restarted publisher starts a new sequence");
	});

	it("refuses malformed or over-bound publications", () => {
		const guard = new AgentLivenessGuard();
		for (const bad of [
			"not json", JSON.stringify({ v: 2, instance: INSTANCE, seq: 1, sessionId: "S1", agents: [] }),
			JSON.stringify({ v: 1, instance: "NOT-HEX", seq: 1, sessionId: "S1", agents: [] }),
			JSON.stringify({ v: 1, instance: INSTANCE, seq: 0, sessionId: "S1", agents: [] }),
			JSON.stringify({ v: 1, instance: INSTANCE, seq: 1, sessionId: "S1", agents: [{ id: "", state: "idle" }] }),
			JSON.stringify({ v: 1, instance: INSTANCE, seq: 1, sessionId: "S1", agents: [{ id: "a", state: "idle" }, { id: "a", state: "idle" }] }),
			JSON.stringify({ v: 1, instance: INSTANCE, seq: 1, sessionId: "S1", agents: [{ id: "a", state: "idle", tool: 7 }] }),
			JSON.stringify({ v: 1, instance: INSTANCE, seq: 1, sessionId: "S1", agents: [{ id: "a", state: "parked" }] }),
			JSON.stringify({ v: 1, instance: INSTANCE, seq: 1, sessionId: "S1", agents: [{ id: "a\u0007b", state: "idle" }] }),
			JSON.stringify({ v: 1, instance: INSTANCE, seq: 1, sessionId: "S1", agents: [{ id: "a", state: "idle", sessionFile: "C:\\s\n.jsonl" }] }),
			"x".repeat(MAX_AGENT_LIVENESS_CHARS + 1), undefined,
		]) assert.equal(guard.accept(bad, "S1"), null, String(bad).slice(0, 80));
		assert.equal(parseLiveAgents(Array.from({ length: MAX_LIVE_AGENTS + 1 }, (_, index) => ({ id: `a${index}`, state: "running" }))), null);
		const decoded = decodeAgentLiveness(text(1, [{ id: "a", agent: "task", state: "running", intent: "line\u0007break" }]));
		assert.equal(decoded?.agents[0]?.intent, "line break", "control characters never reach a row");
	});

	it("sheds detail, never membership first, to stay within the bound", () => {
		const many: LiveAgent[] = Array.from({ length: MAX_LIVE_AGENTS }, (_, index) => ({ id: `${"x".repeat(200)}${index}`, agent: "task", state: "running", sessionFile: `C:\\${"s".repeat(400)}\\${index}.jsonl`, tool: "bash", intent: "i".repeat(200) }));
		const encoded = text(1, many);
		assert.ok(encoded.length <= MAX_AGENT_LIVENESS_CHARS);
		const decoded = decodeAgentLiveness(encoded);
		assert.ok(decoded !== null && decoded.agents.length > 0);
		assert.equal(decoded.agents.some(agent => agent.intent !== undefined), false, "intents go first");
		const guard = new AgentLivenessGuard();
		guard.accept(text(1, [resumed]), "S1");
		assert.deepEqual(guard.last, [resumed], "the newest accepted list is kept for a resync");
		guard.forgetLast();
		assert.equal(guard.last, null);
	});
});

describe("agent liveness signal: merge with the RPC roster", () => {
	it("shows a resumed agent the RPC roster missed as running with its activity and spawn identity", () => {
		let model = spawnedAndCompleted();
		assert.equal(model.agents.size, 0);
		model = reduceChatFrame(model, { type: "agents_liveness", agents: [resumed] });
		const row = model.agents.get("Worker");
		assert.equal(row?.origin, "registry");
		const shown = agentRow(row!, model.agentActivity.get("Worker"));
		assert.deepEqual([shown.status, shown.badge, shown.description, shown.activity], ["running", "implementer", "Fix the parser", "bash · Sleeping 45 s"]);
		assert.match(agentsSummary(model).text, /^1 running · Worker: bash · Sleeping 45 s$/);
	});

	it("never duplicates an agent the RPC roster lists, and never removes its row", () => {
		let model = reduceChatFrame(createChatModel(), { type: "subagent_lifecycle", payload: started });
		model = reduceChatFrame(model, { type: "agents_liveness", agents: [resumed] });
		assert.equal(model.agents.size, 1);
		assert.equal(model.agents.get("Worker")?.origin, undefined, "the RPC row stays authoritative");
		model = reduceChatFrame(model, { type: "agents_liveness", agents: [] });
		assert.equal(model.agents.get("Worker")?.origin, undefined, "a publication never removes an RPC row");
	});

	it("follows a running → idle → running cycle", () => {
		let model = spawnedAndCompleted();
		model = reduceChatFrame(model, { type: "agents_liveness", agents: [resumed] });
		assert.equal(model.agents.get("Worker")?.status, "running");
		model = reduceChatFrame(model, { type: "agents_liveness", agents: [] });
		assert.equal(model.agents.has("Worker"), false);
		assert.equal(model.agentActivity.has("Worker"), false);
		model = reduceChatFrame(model, { type: "agents_liveness", agents: [{ ...resumed, tool: "edit", intent: "Second pass" }] });
		assert.equal(agentRow(model.agents.get("Worker")!, model.agentActivity.get("Worker")).activity, "edit · Second pass");
		assert.equal(model.agents.size, 1);
	});

	it("lets OMP's own frames take over or remove a registry row", () => {
		let model = reduceChatFrame(spawnedAndCompleted(), { type: "agents_liveness", agents: [resumed] });
		model = reduceChatFrame(model, { type: "subagent_lifecycle", payload: { ...started, sessionFile: "C:\\s\\other.jsonl" } });
		assert.equal(model.agents.get("Worker")?.origin, undefined, "a later started frame owns the row, whatever the registry row said");
		model = reduceChatFrame(spawnedAndCompleted(), { type: "agents_liveness", agents: [{ ...resumed, state: "running" }] });
		model = reduceChatFrame(model, { type: "subagent_lifecycle", payload: { ...started, status: "completed" } });
		assert.equal(model.agents.has("Worker"), false, "a terminal frame removes a registry row the registry reported running");
		model = reduceChatFrame(model, { type: "agents_liveness", agents: [resumed] });
		assert.equal(model.agents.get("Worker")?.origin, "registry", "only a later publication shows it again");
	});

	it("keeps a resumed agent when OMP's terminal frame arrives after the publication saw it resumed", () => {
		// Publication first: the RPC row is annotated idle-live, so the late terminal frame converts it.
		let model = reduceChatFrame(createChatModel(), { type: "subagent_lifecycle", payload: started });
		model = reduceChatFrame(model, { type: "agents_liveness", agents: [resumed] });
		assert.equal(model.agents.get("Worker")?.liveState, "idle");
		model = reduceChatFrame(model, { type: "subagent_event", payload: { id: "Worker", event: { type: "tool_execution_start", tool: "yield", timestamp: 1 } } });
		assert.equal(model.agentActivity.get("Worker")?.tool, "yield");
		model = reduceChatFrame(model, { type: "subagent_lifecycle", payload: { ...started, status: "completed" } });
		assert.equal(model.agents.get("Worker")?.origin, "registry", "the terminal frame converts the row instead of removing it");
		assert.equal(model.agents.get("Worker")?.status, "running");
		assert.equal(model.agentActivity.has("Worker"), false, "the finished run's activity does not label the resumed one");
		assert.equal(model.agents.size, 1);
		// Terminal frame first: the row goes, and the next publication shows it again.
		model = reduceChatFrame(createChatModel(), { type: "subagent_lifecycle", payload: started });
		model = reduceChatFrame(model, { type: "agents_liveness", agents: [{ ...resumed, state: "running" }] });
		model = reduceChatFrame(model, { type: "subagent_lifecycle", payload: { ...started, status: "completed" } });
		assert.equal(model.agents.has("Worker"), false, "a run OMP saw end is gone until a publication says otherwise");
		model = reduceChatFrame(model, { type: "agents_liveness", agents: [resumed] });
		assert.equal(model.agents.get("Worker")?.origin, "registry");
		model = reduceChatFrame(model, { type: "agents_liveness", agents: [] });
		assert.equal(model.agents.has("Worker"), false, "removed when it stops");
	});

	it("keeps registry rows across a get_subagents snapshot, and across the host → page snapshot", () => {
		let model = reduceChatFrame(spawnedAndCompleted(), { type: "agents_liveness", agents: [resumed] });
		model = reduceChatFrame(model, { type: "agents_snapshot", availability: "available", agents: [{ id: "Other", index: 1, agent: "task", agentSource: "bundled", status: "running", lastUpdate: 1 }] });
		assert.deepEqual([...model.agents.keys()].sort(), ["Other", "Worker"]);
		assert.equal(model.agentActivity.get("Worker")?.tool, "bash");
		const pageRows = parseAgentRoster(JSON.parse(JSON.stringify(snapshotOf(model, { nonce: "h", counter: 1 }).agents)));
		assert.equal(pageRows?.find(row => row.id === "Worker")?.origin, "registry", "the page validator keeps the origin");
		assert.deepEqual(parseAgentRoster([{ ...pageRows![0], origin: "forged" }]), [], "an unknown origin is refused");
		const page = applyChatSnapshot(createChatModel(), snapshotOf(model, { nonce: "h", counter: 1 }));
		assert.equal(page.agents.get("Worker")?.origin, "registry");
		const event = parseChatHostMessage({ type: "omp:chat-event", epoch: { nonce: "h", counter: 1 }, frame: { type: "agents_liveness", agents: [] } });
		assert.ok(event !== null && event.type === "omp:chat-event");
		assert.equal(reduceChatFrame(page, event.frame).agents.has("Worker"), false);
	});
});
