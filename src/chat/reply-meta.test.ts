/** What the full transcript says of a turn: usage over every request, and the served-model candidates. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assistantPersistenceKey, type AssistantMessage, type ChatEntry, type ChatMessage } from "./messages.ts";
import type { DisplayTurn } from "./model.ts";
import { replyFooters, turnMeta, type ReplyTurnOptions } from "./reply-turns.ts";
import { projectTranscript } from "./transcript.ts";

const entry = (id: string, message: ChatMessage): ChatEntry => ({ type: "message", id, parentId: null, timestamp: new Date(message.timestamp).toISOString(), message });
const user = (timestamp = 1000): ChatMessage => ({ role: "user", content: "Request", timestamp });
const usage = (input: number, output: number, cost = 0, extra: Partial<NonNullable<AssistantMessage["usage"]>> = {}): AssistantMessage["usage"] => ({ input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output, cost: { total: cost }, ...extra });
const assistant = (text: string, patch: Partial<AssistantMessage> = {}): AssistantMessage => ({ role: "assistant", timestamp: 2000, model: "m", stopReason: "stop", content: text === "" ? [] : [{ type: "text", text }], ...patch });
const toolCall = (id: string): AssistantMessage["content"][number] => ({ type: "toolCall", id, name: "read", arguments: { path: "a.ts" } });
const idle: ReplyTurnOptions = { phase: "live", working: false, asyncPaused: false, settled: true };

/** The footers of `entries` as the transcript computes them: footers over (a window of) the cards, totals over all entries. */
function footers(entries: ChatEntry[], options: { displayTurns?: DisplayTurn[]; window?: number } = {}) {
	const cards = projectTranscript(entries);
	const meta = turnMeta(entries, options.displayTurns);
	const rows = options.window === undefined ? cards : cards.slice(-options.window);
	return { footers: [...replyFooters(rows, { ...idle, displayTurns: options.displayTurns, meta: meta.byEntry }).values()], meta };
}

describe("turn totals", () => {
	it("sum the tool-use requests of the turn, including one that left no row of its own", () => {
		const toolOnly = assistant("", { stopReason: "toolUse", content: [toolCall("t1")], timestamp: 1500, usage: usage(1000, 50, 0.01, { cacheRead: 200 }) });
		const withText = assistant("Reading", { stopReason: "toolUse", content: [{ type: "text", text: "Reading" }, toolCall("t2")], timestamp: 1600, usage: usage(1100, 80, 0.012) });
		const usageOnly = assistant("", { timestamp: 1700, content: [{ type: "redactedThinking", data: "x" }], usage: usage(50, 0, 0.001) });
		const last = assistant("Done", { timestamp: 2000, usage: usage(1200, 300, 0.02, { cacheWrite: 100 }) });
		const result = footers([
			entry("u", user()), entry("a1", toolOnly),
			entry("r1", { role: "toolResult", toolCallId: "t1", toolName: "read", timestamp: 1550, isError: false, content: [{ type: "text", text: "out" }] }),
			entry("a2", withText),
			entry("r2", { role: "toolResult", toolCallId: "t2", toolName: "read", timestamp: 1650, isError: false, content: [{ type: "text", text: "out" }] }),
			entry("a3", usageOnly), entry("a4", last),
		]).footers;
		assert.equal(result.length, 1);
		assert.deepEqual(result[0]!.usage, { input: 3450, output: 430, cacheWrite: 100, cacheRead: 200, cost: 0.043, requests: 4 });
		assert.deepEqual(result[0]!.entryIds, ["a1", "a2", "a3", "a4"]);
	});

	it("belong to their own turn: a second prompt starts a new total", () => {
		const result = footers([
			entry("u1", user(1000)), entry("a1", assistant("One", { timestamp: 2000, usage: usage(100, 10, 0.001) })),
			entry("u2", user(3000)), entry("a2", assistant("Two", { timestamp: 4000, usage: usage(500, 50, 0.01) })),
		]).footers;
		assert.deepEqual(result.map(footer => [footer.hostId, footer.usage?.input, footer.usage?.output]), [["a1", 100, 10], ["a2", 500, 50]]);
	});

	it("show no total for a reply without usage or with nothing spent, and keep the footer", () => {
		const none = footers([entry("u", user()), entry("a", assistant("No usage"))]).footers[0]!;
		assert.equal(none.usage, null);
		const zero = footers([entry("u", user()), entry("a", assistant("Free", { usage: usage(0, 0, 0) }))]).footers[0]!;
		assert.equal(zero.usage, null);
		const costOnly = footers([entry("u", user()), entry("a", assistant("Billed", { usage: usage(0, 0, 0.03) }))]).footers[0]!;
		assert.equal(costOnly.usage?.cost, 0.03);
	});

	it("count the whole turn when the window cut its start away", () => {
		const entries = [
			entry("u", user()), entry("a1", assistant("", { stopReason: "toolUse", content: [toolCall("t1")], timestamp: 1500, usage: usage(1000, 50, 0.01) })),
			entry("r1", { role: "toolResult", toolCallId: "t1", toolName: "read", timestamp: 1550, isError: false, content: [{ type: "text", text: "out" }] }),
			entry("a2", assistant("Answer", { timestamp: 2000, usage: usage(1200, 300, 0.02) })),
		];
		const windowed = footers(entries, { window: 1 }).footers;
		assert.equal(windowed.length, 1);
		assert.deepEqual([windowed[0]!.usage?.input, windowed[0]!.usage?.output, windowed[0]!.usage?.requests], [2200, 350, 2]);
	});

	it("follow an observed invocation across steered prompts", () => {
		const first = assistant("First", { stopReason: "toolUse", timestamp: 2000, usage: usage(100, 10, 0.001), content: [{ type: "text", text: "First" }, toolCall("t1")] });
		const last = assistant("Last", { timestamp: 3000, completedAt: 4000, usage: usage(200, 20, 0.002) });
		const turn: DisplayTurn = { id: 1, startedAt: 1100, completedAt: 4200, complete: true, memberKeys: [assistantPersistenceKey(first), assistantPersistenceKey(last)] };
		const result = footers([
			entry("u", user()), entry("first", first), entry("steer", user(2500)),
			entry("result", { role: "toolResult", toolCallId: "t1", toolName: "read", timestamp: 2600, isError: false, content: [{ type: "text", text: "out" }] }), entry("last", last),
		], { displayTurns: [turn] }).footers;
		assert.equal(result.length, 1);
		assert.deepEqual([result[0]!.usage?.input, result[0]!.usage?.output], [300, 30]);
	});

	it("leave out a recovered request, as the footer's own text does", () => {
		const recovered = assistant("Err", { stopReason: "error", usage: usage(900, 0, 0.5), retryRecovery: { kind: "auto-retry", status: "recovered", attempt: 1, recovery: "plain", note: "Recovered" } });
		const result = footers([entry("u", user()), entry("bad", recovered), entry("ok", assistant("Fine", { timestamp: 3000, usage: usage(100, 10, 0.001) }))]).footers[0]!;
		assert.deepEqual(result.entryIds, ["ok"]);
		assert.equal(result.usage?.input, 100);
	});
});

describe("served-model candidates", () => {
	it("list each request whose served model differs textually, in order, with the router's upstream", () => {
		const meta = turnMeta([
			entry("u", user()),
			entry("a1", assistant("One", { provider: "openrouter", model: "anthropic/claude-opus-5", upstreamModel: "anthropic/claude-haiku-4-5", upstreamProvider: "Amazon Bedrock" })),
			entry("a2", assistant("Two", { timestamp: 2100, provider: "anthropic", model: "claude-opus-5", upstreamModel: "claude-opus-5" })),
			entry("a3", assistant("Three", { timestamp: 2200, provider: "anthropic", model: "claude-haiku-4-5", upstreamModel: "claude-haiku-4-5-20251001" })),
			entry("a4", assistant("Four", { timestamp: 2300, model: "claude-haiku-4-5", upstreamModel: "claude-opus-5" })),
		]).served;
		assert.deepEqual(meta, [
			{ entryId: "a1", pair: { provider: "openrouter", requested: "anthropic/claude-opus-5", served: "anthropic/claude-haiku-4-5" }, upstreamProvider: "Amazon Bedrock" },
			{ entryId: "a3", pair: { provider: "anthropic", requested: "claude-haiku-4-5", served: "claude-haiku-4-5-20251001" } },
		]);
	});
});
