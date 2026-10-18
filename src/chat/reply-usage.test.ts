/** Turn totals under a reply: the TUI's sums and words (`pi-tui` overlays/usage-row.ts), verified against OMP 18.11.1. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AssistantMessage } from "./messages.ts";
import { TurnUsageTally, formatTokenCount, formatTurnCost, formatTurnUsage, requestUsage } from "./reply-usage.ts";

const message = (usage: Partial<AssistantMessage["usage"]> & { orchestration?: { input?: number; output?: number } } | undefined, patch: Partial<AssistantMessage> = {}): AssistantMessage => ({
	role: "assistant", timestamp: 1, model: "m", stopReason: "stop", content: [],
	...(usage === undefined ? {} : { usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 }, ...usage } }),
	...patch,
});

describe("one request's usage", () => {
	it("counts input, cache writes and orchestration input as prompt, and leaves cache reads out of it", () => {
		assert.deepEqual(requestUsage(message({ input: 1000, output: 200, cacheRead: 40_000, cacheWrite: 300, cost: { total: 0.012 }, orchestration: { input: 50, output: 7 } })), {
			input: 1350, output: 207, cacheWrite: 300, cacheRead: 40_000, cost: 0.012,
		});
	});

	it("reports nothing for a message without usage, and treats damaged numbers as zero", () => {
		assert.equal(requestUsage(message(undefined)), null);
		assert.deepEqual(requestUsage(message({ input: Number.NaN, output: -5, cost: { total: Number.POSITIVE_INFINITY } })), { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 });
	});
});

describe("a turn's total", () => {
	it("sums every request of the turn, tool-use requests included", () => {
		const tally = new TurnUsageTally();
		tally.add(message({ input: 1000, output: 100, cost: { total: 0.01 }, cacheRead: 500 }, { stopReason: "toolUse" }));
		tally.add(message({ input: 1200, output: 300, cost: { total: 0.015 }, cacheRead: 700, cacheWrite: 100 }));
		assert.deepEqual(tally.total(), { input: 2300, output: 400, cacheWrite: 100, cacheRead: 1200, cost: 0.025, requests: 2 });
	});

	it("has no total when nothing was spent, and ignores a request without usage", () => {
		const tally = new TurnUsageTally();
		assert.equal(tally.total(), null);
		tally.add(message(undefined));
		tally.add(message({ cacheRead: 9000 }));
		assert.equal(tally.total(), null, "cache reads alone are not a spend");
		tally.add(message({ cost: { total: 0.001 } }));
		assert.equal(tally.total()?.requests, 2);
	});
});

describe("the words", () => {
	it("compacts token counts like OMP", () => {
		assert.deepEqual([999, 1000, 1500, 9999, 10_000, 25_400, 1_000_000, 1_500_000, 25_000_000, 1_500_000_000].map(formatTokenCount), ["999", "1K", "1.5K", "10K", "10K", "25K", "1M", "1.5M", "25M", "1.5B"]);
	});

	it("words the cost: nothing for zero, <$0.01 below half a cent, cents otherwise", () => {
		assert.equal(formatTurnCost(0), undefined);
		assert.equal(formatTurnCost(0.004), "<$0.01");
		assert.equal(formatTurnCost(0.005), "$0.01");
		assert.equal(formatTurnCost(0.0249), "$0.02");
		assert.equal(formatTurnCost(12.345), "$12.35");
	});

	it("drops the cost when nothing was billed and names exact counts in the tooltip", () => {
		const usage = { input: 15_000, output: 4_000, cacheWrite: 3_000, cacheRead: 40_000, cost: 0.0234, requests: 3 };
		assert.deepEqual(formatTurnUsage(usage, "12s"), {
			text: "19K tok · $0.02 this turn",
			title: "This turn: 12s · 19,000 tokens (15,000 in, 3,000 of them cache write · 4,000 out) · 40,000 cache read · 3 requests · $0.02",
		});
		assert.deepEqual(formatTurnUsage({ input: 120, output: 30, cacheWrite: 0, cacheRead: 0, cost: 0, requests: 1 }), { text: "150 tok this turn", title: "This turn: 150 tokens (120 in · 30 out)" });
		assert.equal(formatTurnUsage({ input: 120, output: 30, cacheWrite: 0, cacheRead: 0, cost: 0.0021, requests: 1 }).text, "150 tok · <$0.01 this turn");
		assert.match(formatTurnUsage({ input: 120, output: 30, cacheWrite: 0, cacheRead: 0, cost: 0.0021, requests: 1 }).title, /\$0\.0021$/);
	});
});
