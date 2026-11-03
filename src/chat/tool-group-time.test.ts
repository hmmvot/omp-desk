import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatToolGroupTime, toolGroupTime, type ObservedSpan } from "./tool-group-time.ts";
import type { OverviewMember, ToolCard } from "./tool-overview.ts";

interface Spec {
	/** When the assistant entry that made the call was recorded. */
	startedAt?: number;
	/** The result's timestamp; absent: no result. */
	endedAt?: number;
	status?: ToolCard["tool"]["status"];
	/** A start the page saw live. */
	seen?: number;
}

function call(id: string, spec: Spec): ToolCard {
	const status = spec.status ?? (spec.endedAt === undefined ? "running" : "complete");
	return {
		kind: "tool", id, sourceIds: [id], ownership: "call",
		tool: {
			entryId: id, call: { type: "toolCall", id, name: "bash", arguments: { command: "x" } }, status, mutable: false, attachments: [],
			...(spec.startedAt === undefined ? {} : { startedAt: spec.startedAt }),
			...(spec.endedAt === undefined ? {} : { result: { role: "toolResult", timestamp: spec.endedAt, toolCallId: id, toolName: "bash", content: [], isError: false } }),
			...(spec.seen === undefined ? {} : { active: { toolCallId: id, toolName: "bash", args: {}, startedAt: spec.seen, startObserved: true } }),
		},
	};
}

const none = (): ObservedSpan | undefined => undefined;
const time = (members: readonly OverviewMember[], observed: (id: string) => ObservedSpan | undefined = none, now = 0): string | null => {
	const result = toolGroupTime(members, observed, now);
	return result === null ? null : formatToolGroupTime(result);
};

describe("a tool group's execution time", () => {
	it("adds calls that ran one after the other", () => {
		assert.equal(time([call("a", { startedAt: 0, endedAt: 3000 }), call("b", { startedAt: 3000, endedAt: 7000 })]), "≈ 7.00 s");
	});

	it("counts calls that ran in parallel once, as the stretch they filled together", () => {
		// Three calls of one message, all finishing within the longest: the clock ran 6 s, a sum of the rows would say 13 s.
		assert.equal(time([call("a", { startedAt: 0, endedAt: 6000 }), call("b", { startedAt: 0, endedAt: 4000 }), call("c", { startedAt: 0, endedAt: 3000 })]), "≈ 6.00 s");
	});

	it("leaves out the pause between two messages, where the model decided on its next call", () => {
		assert.equal(time([call("a", { startedAt: 0, endedAt: 2000 }), call("b", { startedAt: 30_000, endedAt: 33_000 })]), "≈ 5.00 s");
	});

	it("merges overlapping intervals of different messages", () => {
		assert.equal(time([call("a", { startedAt: 0, endedAt: 10_000 }), call("b", { startedAt: 8000, endedAt: 12_000 }), call("c", { startedAt: 20_000, endedAt: 21_000 })]), "≈ 13.0 s");
	});

	it("is exact, with no ≈, when this page watched the calls", () => {
		const watched = new Map<string, ObservedSpan>([["a", { start: 1000, end: 5000 }], ["b", { start: 5000, end: 9200 }]]);
		assert.equal(time([call("a", { startedAt: 0, endedAt: 5100 }), call("b", { startedAt: 0, endedAt: 9300 })], id => watched.get(id)), "8.20 s");
	});

	it("is approximate as soon as one interval is derived", () => {
		const watched = new Map<string, ObservedSpan>([["a", { start: 0, end: 4000 }]]);
		assert.equal(time([call("a", { startedAt: 0, endedAt: 4000 }), call("b", { startedAt: 4000, endedAt: 8000 })], id => watched.get(id)), "≈ 8.00 s");
	});

	it("ticks a running call up to now and takes its start from the page that saw it", () => {
		const members = [call("a", { startedAt: 100, endedAt: 2000 }), call("b", { seen: 10_000 })];
		assert.equal(time(members, none, 14_000), "≈ 5.90 s");
		assert.equal(time(members, none, 16_000), "≈ 7.90 s");
		assert.equal(time([call("b", { seen: 10_000 }), call("c", { seen: 10_000, endedAt: 12_000, status: "complete" })], none, 13_000), "3.00 s", "a call whose start was seen live is exact once its result is in");
	});

	it("shows nothing while a running call's start was not seen", () => {
		assert.equal(time([call("a", { startedAt: 0, endedAt: 5000 }), call("b", {})], none, 99_000), null);
	});

	it("shows nothing when a call that ran has no known interval", () => {
		assert.equal(time([call("a", { startedAt: 0, endedAt: 5000 }), call("b", { endedAt: 9000 })]), null, "no start recorded");
		assert.equal(time([call("a", { startedAt: 0, endedAt: 5000 }), call("b", { startedAt: 6000, status: "complete" })]), null, "completed, but its result was not saved");
		assert.equal(time([call("a", { startedAt: 0, endedAt: 5000 }), call("b", { startedAt: 9000, endedAt: 8000 })]), null, "a result stamped before the call");
	});

	it("adds nothing for calls that never ran", () => {
		const members = [call("a", { startedAt: 0, endedAt: 4000 }), call("queued", { status: "queued" }), call("failed-request", { startedAt: 0, status: "error" }), call("skipped", { status: "skipped" }), call("interrupted", { startedAt: 0, endedAt: 99_000, status: "skipped" })];
		assert.equal(time(members), "≈ 4.00 s");
	});

	it("ignores messages in the group and says nothing for a group without a call that ran", () => {
		const message: OverviewMember = { kind: "entry", id: "m", sourceIds: ["m"], entry: { type: "custom_message", id: "m", parentId: null, timestamp: "2026-10-08T00:00:00Z", customType: "irc:relay", content: "x", display: true } };
		assert.equal(time([call("a", { startedAt: 0, endedAt: 4000 }), message]), "≈ 4.00 s");
		assert.equal(time([message, call("q", { status: "queued" })]), null);
	});

	it("says nothing for a total the rows would not say either (1.5 s or less)", () => {
		assert.equal(time([call("a", { startedAt: 0, endedAt: 900 }), call("b", { startedAt: 900, endedAt: 1500 })]), null);
		assert.equal(time([call("a", { startedAt: 0, endedAt: 1501 }), call("b", { startedAt: 0, endedAt: 100 })]), "≈ 1.50 s");
	});

	it("is written as the rows write a duration", () => {
		assert.equal(time([call("a", { startedAt: 0, endedAt: 41_300 })]), "≈ 41.3 s");
		assert.equal(time([call("a", { startedAt: 0, endedAt: 125_000 })]), "≈ 2m 5s");
	});
});
