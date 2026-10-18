/**
 * What the session does with the frames OMP's terminal UI shows and Desk used to drop: an extension's failure, an event OMP
 * could not fit into its transport, the goal and the modes `get_state` reports, a failed prompt's details and an `ask`
 * dialog's preview and timeout. Runner: `node --test src/host/rpc/session-host-signals.test.ts`.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { CLEAR_ERROR_PATH } from "../../chat/clear.ts";
import { NAVIGATE_ERROR_PATH } from "../../chat/rewind.ts";
import { recordingLogger, type LoggedLine } from "../../shared/logger.ts";
import { FakeRpcChannel } from "./fake-channel.ts";
import { RpcSession, type RpcSessionOutput } from "./session.ts";
import { ManualTimers, tick } from "./test-support.ts";

const sessions: RpcSession[] = [];
afterEach(() => {
	for (const session of sessions.splice(0)) session.dispose();
});

const GOAL = { id: "g1", objective: "Ship the release", status: "active", tokensUsed: 12_000, tokenBudget: 50_000, timeUsedSeconds: 30, createdAt: 1, updatedAt: 2 };

async function boot(stateExtras: Record<string, unknown> = {}) {
	const channel = new FakeRpcChannel({ sessionFile: null });
	channel.handlers.set("get_state", () => ({
		data: { thinkingLevel: "high", isStreaming: false, isCompacting: false, sessionId: channel.child.sessionId, queuedMessageCount: 0, messageCount: 0, isSettled: true, todoPhases: [], ...stateExtras },
	}));
	const timers = new ManualTimers();
	const lines: LoggedLine[] = [];
	const session = new RpcSession({ channel, sessionFile: null, cwd: "D:\\scratch", hostNonce: "host-a", timers, fileExists: async () => true, watchdogIntervalMs: 60 * 60_000, log: recordingLogger(lines) });
	sessions.push(session);
	const outputs: RpcSessionOutput[] = [];
	session.subscribe(output => outputs.push(output));
	await session.start();
	await tick();
	return { channel, session, outputs, timers, lines };
}

const notices = (session: RpcSession) => session.model.ephemeral.filter(item => item.kind === "notice").map(item => item.payload as { level: string; source: string; message: string });

describe("extension_error", () => {
	it("is a visible error notice in the transcript, and reaches a live page as an event", async () => {
		const { channel, session, outputs } = await boot();
		channel.emit({ type: "extension_error", extensionPath: "/ext/guard.ts", event: "tool_call", error: "boom <b>bold</b>" });
		await tick();
		assert.deepEqual(notices(session), [{ type: "notice", level: "error", source: "Extension error", message: 'Extension "/ext/guard.ts" error (tool_call): boom <b>bold</b>' }]);
		assert.ok(outputs.some(output => output.type === "event" && output.frame.type === "notice"));
	});

	it("says a repeat once", async () => {
		const { channel, session } = await boot();
		for (let index = 0; index < 5; index += 1) channel.emit({ type: "extension_error", extensionPath: "/ext/guard.ts", event: "message_update", error: "same failure" });
		await tick();
		assert.equal(notices(session).length, 1);
	});

	it("stays silent for the rewind and clear commands, with no navigation in flight", async () => {
		const { channel, session, outputs } = await boot();
		const before = session.model;
		const seen = outputs.length;
		for (const extensionPath of [NAVIGATE_ERROR_PATH, CLEAR_ERROR_PATH]) channel.emit({ type: "extension_error", extensionPath, event: "command", error: "omp-desk-clear:busy <script>secret</script>" });
		await tick();
		assert.equal(session.model, before);
		assert.equal(JSON.stringify(outputs.slice(seen)).includes("secret"), false);
	});
});

describe("rpc_frame_error", () => {
	const assistant = { role: "assistant", timestamp: 10, model: "m", provider: "p", stopReason: "stop", content: [{ type: "text", text: "the reply so far" }] };

	it("names the dropped frame, logs it and makes up a lost message_end from the file", async () => {
		const { channel, session, lines } = await boot();
		channel.emit({ type: "message_start", messageId: "m1", message: assistant });
		await tick();
		assert.notEqual(session.model.stream, null);
		const reads = channel.commandsOfType("get_entries").length;
		channel.emit({ type: "rpc_frame_error", originalType: "message_end", error: "RPC frame exceeded the transport limit" });
		await tick();
		const [notice] = notices(session);
		assert.equal(notice?.level, "warning");
		assert.match(notice?.message ?? "", /"message_end"/);
		assert.equal(session.model.stream, null, "the half-finished reply is no longer shown as the live one");
		assert.equal(session.model.pending.size, 1, "and stands as a pending row until the file read confirms it");
		assert.ok(channel.commandsOfType("get_entries").length > reads, "the session file is read again");
		assert.ok(lines.some(line => line.level === "warn" && /message_end/.test(line.message)), "a log line records it");
	});

	it("only warns for a frame the next frame replaces", async () => {
		const { channel, session, lines } = await boot();
		const reads = channel.commandsOfType("get_entries").length;
		channel.emit({ type: "rpc_frame_error", originalType: "message_update", error: "RPC frame exceeded the transport limit" });
		await tick();
		assert.equal(notices(session).length, 1);
		assert.equal(channel.commandsOfType("get_entries").length, reads);
		assert.ok(lines.some(line => /message_update/.test(line.message) && /nothing to recover/.test(line.message)));
	});

	it("does not leave the Chat compacting when the end of the pass was dropped", async () => {
		const { channel, session } = await boot();
		channel.emit({ type: "auto_compaction_start", action: "context-full", reason: "threshold" });
		await tick();
		assert.equal(session.model.maintenance?.status, "working");
		const states = channel.commandsOfType("get_state").length;
		channel.emit({ type: "rpc_frame_error", originalType: "auto_compaction_end", error: "RPC frame exceeded the transport limit" });
		await tick();
		assert.equal(session.model.maintenance, null);
		assert.ok(channel.commandsOfType("get_state").length > states, "the state is read again");
	});

	it("reads the state again for a dropped queue_update", async () => {
		const { channel } = await boot();
		const states = channel.commandsOfType("get_state").length;
		channel.emit({ type: "rpc_frame_error", originalType: "queue_update", error: "RPC frame exceeded the transport limit" });
		await tick();
		assert.ok(channel.commandsOfType("get_state").length > states);
	});

	it("leaves the turn's outcome alone when it makes up a lost message_end", async () => {
		const { channel, session } = await boot();
		channel.emit({ type: "message_start", messageId: "m1", message: assistant });
		await tick();
		const outcome = session.model.lastAgentOutcome;
		channel.emit({ type: "rpc_frame_error", originalType: "message_end", error: "RPC frame exceeded the transport limit" });
		await tick();
		assert.equal(session.model.lastAgentOutcome, outcome);
	});

	it("takes a frame whose type OMP did not name", async () => {
		const { channel, session } = await boot();
		channel.emit({ type: "rpc_frame_error", error: "RPC frame exceeded the transport limit" });
		await tick();
		assert.match(notices(session)[0]?.message ?? "", /^OMP dropped an event/);
	});
});

describe("get_state signals", () => {
	it("seeds the goal and the modes at attach and keeps the goal current through goal_updated", async () => {
		const { channel, session } = await boot({
			goal: { enabled: true, mode: "active", goal: GOAL },
			fastModeEnabled: true, fastModeActive: true,
			slowModeSupported: true, slowModeEnabled: false,
			usageLimit: { stage: "wrap_up", extraUsage: false, resetsAtSec: 1_900_000_000 },
		});
		const state = session.model.state;
		assert.equal(state?.goal?.objective, "Ship the release");
		assert.equal(state?.goal?.tokenBudget, 50_000);
		assert.deepEqual(state?.fastMode, { enabled: true, active: true });
		assert.deepEqual(state?.slowMode, { supported: true, enabled: false });
		assert.equal(state?.usageLimit?.stage, "wrap_up");

		channel.emit({ type: "goal_updated", goal: { ...GOAL, tokensUsed: 50_000, status: "budget-limited" }, state: { enabled: true, mode: "active", goal: GOAL } });
		await tick();
		assert.equal(session.model.state?.goal?.status, "budget-limited");
		assert.equal(session.model.state?.goal?.tokensUsed, 50_000);
		channel.emit({ type: "goal_updated", goal: null });
		await tick();
		assert.equal(session.model.state?.goal, undefined);
		assert.deepEqual(session.model.state?.fastMode, { enabled: true, active: true }, "the other chips are untouched");
	});

	it("shows no chip for a session without goal mode, an older OMP without the fields", async () => {
		const { session } = await boot();
		assert.equal(session.model.state?.goal, undefined);
		assert.equal(session.model.state?.fastMode, undefined);
		assert.equal(session.model.state?.usageLimit, undefined);
	});
});

describe("prompt_result.error", () => {
	it("is kept in the model for the failed turn's message", async () => {
		const { channel, session } = await boot();
		const error = { message: "Provider overloaded", provider: "anthropic", model: "claude", httpStatus: 529, retryable: true };
		channel.emit({ type: "prompt_result", id: "vsc:r1", status: "error", agentInvoked: true, sessionSettled: true, error });
		await tick();
		assert.deepEqual(session.model.lastPromptResult?.error, error);
	});
});

describe("ask dialog", () => {
	it("keeps each option's preview and counts the timeout from the frame's arrival", async () => {
		const { channel, session, outputs, timers } = await boot();
		channel.emit({
			type: "extension_ui_request", id: "a1", method: "ask", timeout: 45_000,
			questions: [{ id: "q", question: "Layout?", multi: false, options: [{ label: "Grid", preview: "```\n+--+--+\n|  |  |\n+--+--+\n```" }, { label: "List" }] }],
		});
		await tick();
		const request = session.model.uiRequest;
		assert.ok(request?.method === "ask");
		assert.equal(request.questions[0]?.options[0]?.preview?.startsWith("```"), true);
		assert.equal(request.timeoutMs, 45_000);
		assert.equal(request.expiresAt, timers.now() + 45_000);
		const forwarded = outputs.find(output => output.type === "ui-request");
		assert.ok(forwarded?.type === "ui-request" && forwarded.request.method === "ask" && forwarded.request.expiresAt === request.expiresAt);
	});

	it("has no expiry when OMP set no timeout", async () => {
		const { channel, session } = await boot();
		channel.emit({ type: "extension_ui_request", id: "a2", method: "ask", questions: [{ id: "q", question: "Layout?", multi: false, options: [{ label: "Grid" }] }] });
		await tick();
		const request = session.model.uiRequest;
		assert.ok(request?.method === "ask");
		assert.equal(request.timeoutMs, undefined);
		assert.equal(request.expiresAt, undefined);
	});

	it("keeps previews only up to a total per dialog", async () => {
		const { channel, session } = await boot();
		const options = Array.from({ length: 12 }, (_, index) => ({ label: `Option ${index}`, preview: "x".repeat(20_000) }));
		channel.emit({ type: "extension_ui_request", id: "a3", method: "ask", questions: [{ id: "q", question: "Layout?", multi: false, options }] });
		await tick();
		const request = session.model.uiRequest;
		assert.ok(request?.method === "ask");
		const total = request.questions[0]?.options.reduce((sum, option) => sum + (option.preview?.length ?? 0), 0) ?? 0;
		assert.ok(total <= 128 * 1024 && total > 100_000, `total ${total}`);
		assert.equal(request.questions[0]?.options[11]?.preview, undefined);
	});
});
