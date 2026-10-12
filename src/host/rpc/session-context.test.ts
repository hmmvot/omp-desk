import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { FakeRpcChannel, responseLine } from "./fake-channel.ts";
import { RpcSession, type RpcSessionOutput } from "./session.ts";
import { ManualTimers, ScratchDir, sessionFileText, tick, waitUntil } from "./test-support.ts";

const sessions: RpcSession[] = [];
const scratches: ScratchDir[] = [];
afterEach(async () => {
	for (const session of sessions.splice(0)) session.dispose();
	for (const scratch of scratches.splice(0)) await scratch.remove();
});

const REPORT = [
	"Context window: 20000 tokens (11% used)",
	"  System prompt    [████░░░░░░░░░░░░░░░░░░░░] 15%  2998 tokens",
	"  Free             [██░░░░░░░░░░░░░░░░░░░░░░] 8%  1516 tokens",
].join("\n");
const PROMPT = ["You are an agent.", "<project-context>\n<repo-rules>\nMUST follow these context files for all tasks:\n<file path=\"C:\\proj\\AGENTS.md\">\n# Rules\n</file>\n</repo-rules>\n</project-context>"];
const STATS = { sessionId: "sess-1", sessionFile: null, userMessages: 1, assistantMessages: 1, toolCalls: 0, toolResults: 0, totalMessages: 2, premiumRequests: 0.33,
	tokens: { input: 100, output: 10, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 110 }, cost: 0.5 };

async function boot(options: { catalogue?: boolean | "extension"; file?: string | null } = {}) {
	const channel = new FakeRpcChannel({ sessionFile: options.file ?? null });
	channel.handlers.set("get_available_commands", () => ({ data: { commands: options.catalogue === false ? [] : [{ name: "context", source: options.catalogue === "extension" ? "extension" : "builtin" }] } }));
	channel.handlers.set("get_state", () => ({ data: { sessionId: "sess-1", sessionFile: options.file ?? undefined, isStreaming: false, isCompacting: false, autoCompactionEnabled: true, systemPrompt: PROMPT,
		model: { provider: "p", id: "m", name: "M", contextWindow: 20000 }, contextUsage: { tokens: 2100, contextWindow: 20000, percent: 10.5 } } }));
	channel.handlers.set("get_session_stats", () => ({ data: { ...STATS, sessionFile: options.file ?? null } }));
	const timers = new ManualTimers();
	const session = new RpcSession({ channel, sessionFile: options.file ?? null, cwd: "D:\\scratch", hostNonce: "host-a", timers, fileExists: async () => true, watchdogIntervalMs: 60 * 60_000 });
	sessions.push(session);
	const outputs: RpcSessionOutput[] = [];
	session.subscribe(output => outputs.push(output));
	await session.start();
	await tick();
	return { channel, session, outputs, timers };
}
/** As installed OMP answers a builtin: the output first, then the acknowledgement. */
function answerContext(channel: FakeRpcChannel, text: string | null, data: Record<string, unknown> = { agentInvoked: false }) {
	channel.handlers.set("prompt", () => {
		if (text !== null) channel.emit({ type: "command_output", text });
		return { data };
	});
}
const notices = (outputs: readonly RpcSessionOutput[]) => outputs.filter(output => output.type === "event" && output.frame.type === "command_output").length;

describe("deep read", () => {
	it("reads the state, the stats and the prompt's context files without sending a prompt or touching the conversation", async () => {
		const { session, channel, outputs } = await boot();
		const before = outputs.length;
		const read = await session.readContext();
		assert.equal(read?.autoCompaction, true);
		assert.equal(read?.stats?.premiumRequests, 0.33);
		assert.deepEqual(read?.files, { files: [{ path: "C:\\proj\\AGENTS.md", chars: 7 }], onDemand: [] });
		assert.deepEqual(read?.journal, { cost: 0.5, compactionCount: 0, lastCompaction: null, clearCount: 0, lastClear: null }, "a session without a file answers with the native cost and no boundaries");
		assert.equal(channel.commandsOfType("prompt").length, 0);
		assert.equal(notices(outputs.slice(before)), 0);
		assert.deepEqual(outputs.slice(before).flatMap(output => (output.type === "event" ? [output.frame.type] : [])), ["state_update"], "the fresh state is the only thing the read adds, as for the Chat popover");
	});
	it("reads the boundaries and the whole-file spend from the session file", async () => {
		const scratch = await ScratchDir.create();
		scratches.push(scratch);
		const file = await scratch.file("s.jsonl", `${sessionFileText({ id: "sess-1", entries: [] })}${JSON.stringify({ type: "compaction", id: "c1", parentId: null, timestamp: "2026-01-02T00:00:00.000Z", summary: "s", firstKeptEntryId: "x", tokensBefore: 900, tokensAfter: 300, method: "soft" })}\n`);
		const { session } = await boot({ file });
		const read = await session.readContext();
		assert.equal(read?.journal?.compactionCount, 1);
		assert.equal(read?.journal?.lastCompaction?.tokensAfter, 300);
	});
	it("does not accept statistics that name another session file", async () => {
		const scratch = await ScratchDir.create();
		scratches.push(scratch);
		const file = await scratch.file("s.jsonl", sessionFileText({ id: "sess-1", entries: [] }));
		const { session, channel } = await boot({ file });
		channel.handlers.set("get_session_stats", () => ({ data: { ...STATS, sessionFile: "D:\\elsewhere\\other.jsonl" } }));
		const read = await session.readContext();
		assert.equal(read?.stats, null);
		assert.notEqual(read?.journal, null, "the file the session is bound to is still read");
	});
	it("answers part by part: a stats refusal and an unreadable prompt do not drop the rest", async () => {
		const { session, channel } = await boot();
		channel.handlers.set("get_session_stats", () => ({ success: false, error: "Unsupported command" }));
		channel.handlers.set("get_state", () => ({ data: { sessionId: "sess-1", isStreaming: false, systemPrompt: "not an array" } }));
		const read = await session.readContext();
		assert.equal(read?.stats, null);
		assert.equal(read?.files, null);
		assert.equal(read?.autoCompaction, null);
		assert.equal(read?.journal, null);
	});
	it("refuses when the session is gone or its identity changed while reading", async () => {
		const { session, channel } = await boot();
		channel.handlers.set("get_state", () => ({ data: { sessionId: "another", isStreaming: false } }));
		assert.equal(await session.readContext(), null);
		session.dispose();
		assert.equal(await session.readContext(), null);
	});
});

describe("explicit /context request", () => {
	it("reads the report while the frame still renders as the notice it is", async () => {
		const { session, channel, outputs } = await boot();
		answerContext(channel, REPORT);
		const before = notices(outputs);
		const result = await session.requestContextReport();
		assert.equal(result.status, "ok");
		if (result.status !== "ok") return;
		assert.equal(result.value.report.contextWindow, 20000);
		assert.deepEqual(result.value.report.rows.map(row => row.label), ["System prompt", "Free"]);
		assert.equal(result.value.usageTokensAtRead, 2100);
		assert.equal(notices(outputs) - before, 1, "nothing is hidden: the report is in the conversation");
		assert.deepEqual(channel.commandsOfType("prompt").map(command => command.message), ["/context"]);
		assert.equal(channel.commandsOfType("prompt")[0]!.streamingBehavior, undefined);
	});
	it("reports an acknowledgement without a report as unconfirmed, and ignores another command's output", async () => {
		const { session, channel, timers } = await boot();
		answerContext(channel, "Nothing to shake.");
		const pending = session.requestContextReport();
		await waitUntil(() => channel.commandsOfType("prompt").length === 1);
		await tick();
		timers.advance(1000);
		assert.deepEqual(await pending, { status: "unconfirmed" });
	});
	it("takes the first report observed while the request waits, not an older one that came after a request gave up", async () => {
		const { session, channel, timers } = await boot();
		answerContext(channel, null);
		const pending = session.requestContextReport();
		await waitUntil(() => channel.commandsOfType("prompt").length === 1);
		await tick();
		timers.advance(1000);
		assert.deepEqual(await pending, { status: "unconfirmed" });
		// A late report of the request that gave up arrives while no request waits: it is not kept for the next one.
		channel.emit({ type: "command_output", text: REPORT.replace("20000", "11111") });
		answerContext(channel, REPORT);
		const next = await session.requestContextReport();
		assert.equal(next.status, "ok");
		if (next.status === "ok") assert.equal(next.value.report.contextWindow, 20000);
	});
	it("holds the whole request in flight: a report that arrives before a delayed acknowledgement does not reopen admission", async () => {
		const { session, channel, timers } = await boot();
		let ackId: string | undefined;
		channel.handlers.set("prompt", command => {
			ackId = command.id as string;
			channel.emit({ type: "command_output", text: REPORT });
			return "drop";
		});
		const pending = session.requestContextReport();
		await waitUntil(() => ackId !== undefined);
		await tick();
		assert.deepEqual(await session.requestContextReport(), { status: "refused", reason: "busy" });
		assert.deepEqual(await session.maintain({ kind: "shake", mode: "elide" }), { status: "refused", reason: "busy" });
		assert.deepEqual(await session.clear("c".repeat(32)), { status: "refused", reason: "busy" }, "a clear waits for the request");
		channel.emit(responseLine(ackId, "prompt", true, { data: { agentInvoked: false } }));
		timers.advance(1);
		const result = await pending;
		assert.equal(result.status, "ok");
		assert.deepEqual(channel.commandsOfType("prompt").map(command => command.message), ["/context"]);
		answerContext(channel, REPORT);
		assert.equal((await session.requestContextReport()).status, "ok", "admission is open again once it finished");
	});
	it("returns nothing and sends no abort when the session moved on while the acknowledgement was awaited", async () => {
		const { session, channel } = await boot();
		let ackId: string | undefined;
		channel.handlers.set("prompt", command => { ackId = command.id as string; return "drop"; });
		const pending = session.requestContextReport();
		await waitUntil(() => ackId !== undefined);
		session.dispose();
		channel.emit(responseLine(ackId, "prompt", true, { data: { agentInvoked: true } }));
		assert.notEqual((await pending).status, "ok");
		assert.equal(channel.commandsOfType("abort").length, 0);
	});
	it("takes the time and the usage from the moment the report arrived, not from the acknowledgement", async () => {
		const { session, channel, timers } = await boot();
		let ackId: string | undefined;
		channel.handlers.set("prompt", command => {
			ackId = command.id as string;
			channel.emit({ type: "command_output", text: REPORT });
			return "drop";
		});
		const pending = session.requestContextReport();
		await waitUntil(() => ackId !== undefined);
		const arrived = timers.now();
		timers.advance(3000);
		channel.emit(responseLine(ackId, "prompt", true, { data: { agentInvoked: false } }));
		const result = await pending;
		assert.equal(result.status, "ok");
		if (result.status === "ok") {
			assert.equal(result.value.at, arrived);
			assert.equal(result.value.usageTokensAtRead, 2100);
		}
	});
	it("is not offered by a same-named extension command", async () => {
		const { session, channel } = await boot({ catalogue: "extension" });
		answerContext(channel, REPORT);
		assert.deepEqual(await session.requestContextReport(), { status: "refused", reason: "rejected" });
		assert.equal(channel.commandsOfType("prompt").length, 0);
	});
	it("is refused while OMP works, while a pass runs, while another request waits and when the builtin is not listed", async () => {
		const { session, channel } = await boot();
		answerContext(channel, REPORT);
		channel.emit({ type: "agent_start" });
		await tick();
		assert.deepEqual(await session.requestContextReport(), { status: "refused", reason: "busy" });
		channel.emit({ type: "agent_end" });
		channel.emit({ type: "session_settled" });
		await tick();
		const first = session.requestContextReport();
		assert.deepEqual(await session.requestContextReport(), { status: "refused", reason: "busy" });
		assert.equal((await first).status, "ok");
		assert.equal(channel.commandsOfType("prompt").length, 1);
		const bare = await boot({ catalogue: false });
		answerContext(bare.channel, REPORT);
		assert.deepEqual(await bare.session.requestContextReport(), { status: "refused", reason: "rejected" });
		assert.equal(bare.channel.commandsOfType("prompt").length, 0, "a session without the builtin is never sent the text");
	});
	it("keeps a compaction from starting while a request waits and a request from starting during a pass", async () => {
		const { session, channel } = await boot();
		channel.handlers.set("prompt", () => "drop");
		const request = session.requestContextReport();
		await waitUntil(() => channel.commandsOfType("prompt").length === 1);
		assert.deepEqual(await session.maintain({ kind: "shake", mode: "elide" }), { status: "refused", reason: "busy" });
		session.dispose();
		assert.notEqual((await request).status, "ok");
	});
	it("is refused while a user message is awaiting OMP's acknowledgement", async () => {
		const { session, channel } = await boot();
		channel.handlers.set("prompt", () => "drop");
		const typed = session.prompt({ requestId: "r".repeat(32), text: "hello" });
		await waitUntil(() => channel.commandsOfType("prompt").length === 1);
		assert.deepEqual(await session.requestContextReport(), { status: "refused", reason: "busy" });
		assert.equal(channel.commandsOfType("prompt").length, 1, "nothing was sent for the request");
		session.dispose();
		await typed;
	});
	it("does not abort, and returns nothing, when the input claim was lost and regained while it waited", async () => {
		const { session, channel } = await boot();
		let ackId: string | undefined;
		channel.handlers.set("prompt", command => { ackId = command.id as string; return "drop"; });
		const pending = session.requestContextReport();
		await waitUntil(() => ackId !== undefined);
		channel.setOwned(false);
		channel.setOwned(true);
		channel.emit(responseLine(ackId, "prompt", true, { data: { agentInvoked: true } }));
		const result = await pending;
		assert.equal(result.status, "refused");
		assert.equal(channel.commandsOfType("abort").length, 0, "whoever held the claim meanwhile may have started work");
	});
	it("does not return a report when the claim was lost and not regained", async () => {
		const { session, channel, timers } = await boot();
		let ackId: string | undefined;
		channel.handlers.set("prompt", command => { ackId = command.id as string; channel.emit({ type: "command_output", text: REPORT }); return "drop"; });
		const pending = session.requestContextReport();
		await waitUntil(() => ackId !== undefined);
		channel.setOwned(false);
		channel.emit(responseLine(ackId, "prompt", true, { data: { agentInvoked: false } }));
		timers.advance(1);
		assert.equal((await pending).status, "refused");
	});
	it("applies a model choice made during the request as soon as the request ends", async () => {
		const { session, channel, timers } = await boot();
		let ackId: string | undefined;
		channel.handlers.set("prompt", command => { ackId = command.id as string; channel.emit({ type: "command_output", text: REPORT }); return "drop"; });
		const pending = session.requestContextReport();
		await waitUntil(() => ackId !== undefined);
		assert.equal((await session.chooseModel("prov", "big")).status, "pending");
		assert.equal(channel.commandsOfType("set_model").length, 0);
		channel.emit(responseLine(ackId, "prompt", true, { data: { agentInvoked: false } }));
		timers.advance(1);
		assert.equal((await pending).status, "ok");
		await waitUntil(() => channel.commandsOfType("set_model").length === 1);
	});
	it("aborts the turn and refuses when the text did not run as a command", async () => {
		const { session, channel } = await boot();
		answerContext(channel, null, { agentInvoked: true });
		assert.deepEqual(await session.requestContextReport(), { status: "refused", reason: "rejected" });
		await waitUntil(() => channel.commandsOfType("abort").length === 1);
	});
});
