/**
 * The transcript with a streaming reply appended to a projection made without it (`appendLive`) must be the transcript
 * projected as a whole: same cards, in the same order, with the same ids, for every shape of session the page can hold,
 * and `null` (project the whole) for every shape where the reply could change a card before it.
 *
 * Runner: `node --test src/chat/live-tail.test.ts`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { WireUsage } from "@oh-my-pi/pi-wire";
import type { AssistantMessage, ChatContent, ChatEntry } from "./messages.ts";
import type { ActiveTool, PendingRow } from "./pending.ts";
import type { EphemeralItem, TranscriptPosition } from "./projection.ts";
import { appendLive, projectStable, projectWhole, type LiveMessage, type ProjectedTranscript, type TranscriptSources } from "./live-tail.ts";

const USAGE: WireUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } };
const at = (id: string, parentId: string | null): { id: string; parentId: string | null; timestamp: string } => ({ id, parentId, timestamp: "2026-09-25T00:00:00.000Z" });
const user = (id: string, parentId: string | null, text = id): ChatEntry => ({ ...at(id, parentId), type: "message", message: { role: "user", content: text, timestamp: 1 } });
const reply = (content: ChatContent[], stopReason: AssistantMessage["stopReason"] = "stop", timestamp = 2): AssistantMessage => ({ role: "assistant", content, model: "m", usage: USAGE, stopReason, timestamp });
const assistant = (id: string, parentId: string | null, content: ChatContent[], stopReason: AssistantMessage["stopReason"] = "stop"): ChatEntry => ({ ...at(id, parentId), type: "message", message: reply(content, stopReason) });
const call = (id: string, name = "read"): ChatContent => ({ type: "toolCall", id, name, arguments: { path: `${id}.ts` } });
const result = (id: string, parentId: string | null, toolCallId: string, toolName = "read"): ChatEntry => ({ ...at(id, parentId), type: "message", message: { role: "toolResult", toolCallId, toolName, content: [{ type: "text", text: "ok" }], isError: false, timestamp: 3 } });

/** A session of `turns` turns: a prompt, a reply with a tool call, its result and a closing reply. */
function session(turns: number): ChatEntry[] {
	const entries: ChatEntry[] = [];
	let parent: string | null = null;
	for (let turn = 0; turn < turns; turn += 1) {
		entries.push(user(`u${turn}`, parent), assistant(`a${turn}`, `u${turn}`, [{ type: "text", text: `step ${turn}` }, call(`c${turn}`)], "toolUse"), result(`r${turn}`, `a${turn}`, `c${turn}`), assistant(`z${turn}`, `r${turn}`, [{ type: "text", text: `done ${turn}` }]));
		parent = `z${turn}`;
	}
	return entries;
}

function sourcesOf(entries: readonly ChatEntry[], extra: Partial<TranscriptSources> = {}): TranscriptSources {
	return { entries, durableCount: entries.length, pending: new Map(), ephemeral: [], olderCount: 0, activeTools: new Map(), working: true, ...extra };
}
const liveAt = (anchorId: string | null, content: ChatContent[], messageId = "m1", seq = 100): LiveMessage => ({ message: reply(content), messageId, position: { anchorId, seq } });

/** What the page does for one frame: the fast answer when there is one, else the whole projection; and the whole projection to compare. */
function both(sources: TranscriptSources, live: LiveMessage): { fast: ProjectedTranscript | null; whole: ProjectedTranscript } {
	return { fast: appendLive(projectStable(sources), sources, live, live.messageId), whole: projectWhole(sources, live, live.message, live.messageId) };
}
const shape = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

describe("a live reply appended to a stable projection", () => {
	it("gives the cards of the whole projection for a reply under the last row, with and without tool calls", () => {
		const entries = session(6);
		const last = entries.at(-1)!.id;
		for (const content of [[], [{ type: "text", text: "" } as ChatContent], [{ type: "text", text: "writing" } as ChatContent], [{ type: "thinking", thinking: "hm" } as ChatContent, { type: "text", text: "and" } as ChatContent], [{ type: "text", text: "see" } as ChatContent, call("live-1", "bash")], [call("live-1"), call("live-2", "edit")]]) {
			const { fast, whole } = both(sourcesOf(entries), liveAt(last, content));
			assert.ok(fast !== null, `the fast path answers for ${JSON.stringify(content)}`);
			assert.deepEqual(shape(fast.canonical), shape(whole.canonical));
			assert.deepEqual(shape(fast.cleared), shape(whole.cleared));
		}
	});

	it("keeps the cards of the rows before the reply as the same objects, frame after frame", () => {
		const entries = session(4);
		const sources = sourcesOf(entries);
		const stable = projectStable(sources);
		const first = appendLive(stable, sources, liveAt(entries.at(-1)!.id, [{ type: "text", text: "a" }]), "m1")!;
		const second = appendLive(stable, sources, liveAt(entries.at(-1)!.id, [{ type: "text", text: "ab" }]), "m1")!;
		assert.equal(first.totals, second.totals);
		for (let index = 0; index < stable.canonical.length; index += 1) assert.equal(first.canonical[index], second.canonical[index], `card ${index}`);
		assert.equal(second.canonical.length, stable.canonical.length + 1);
	});

	it("starts a transcript that has nothing yet", () => {
		const { fast, whole } = both(sourcesOf([]), liveAt(null, [{ type: "text", text: "first words" }]));
		assert.ok(fast !== null);
		assert.deepEqual(shape(fast.canonical), shape(whole.canonical));
	});

	it("agrees after pending rows, notices and positioned durable rows", () => {
		const entries = session(3);
		const pendingUser = { ...user("live:pu", entries.at(-1)!.id, "next"), timestamp: "2026-09-25T00:00:05.000Z" };
		const pending = new Map<string, PendingRow>([["live:pu", { entryId: "live:pu", messageId: "pu", role: "user", timestamp: 1, toolCallId: null, unsaved: false, anchorId: entries.at(-1)!.id, seq: 10 }]]);
		const notice: EphemeralItem = { id: "event:11", seq: 11, anchorId: "live:pu", timestamp: 5, kind: "command_output", payload: { text: "done" } };
		const all = [...entries, pendingUser];
		const sources = sourcesOf(all, { durableCount: entries.length, pending, ephemeral: [notice] });
		// The notice is anchored to the pending prompt, which is not the last row once the notice is placed: the whole is projected.
		const { fast: underNotice } = both(sources, liveAt("live:pu", [{ type: "text", text: "x" }], "m2", 12));
		assert.equal(underNotice, null);
		const quiet = sourcesOf(all, { durableCount: entries.length, pending });
		const { fast, whole } = both(quiet, liveAt("live:pu", [{ type: "text", text: "x" }], "m2", 12));
		assert.ok(fast !== null);
		assert.deepEqual(shape(fast.canonical), shape(whole.canonical));
	});

	it("answers null where the whole projection could differ", () => {
		const entries = session(3);
		const last = entries.at(-1)!.id;
		const sources = sourcesOf(entries);
		const text: ChatContent[] = [{ type: "text", text: "x" }];
		assert.equal(both(sources, liveAt(entries[3]!.id, text)).fast, null, "not under the last row");
		assert.equal(both(sources, liveAt(null, text)).fast, null, "no anchor over a transcript that has rows");
		assert.equal(both(sources, liveAt(last, [call("w1", "wait")])).fast, null, "a wait call may retire an earlier poll");
		assert.equal(both(sources, liveAt(last, [call("t1", "todo")])).fast, null, "a todo call may replace an earlier list");
		assert.equal(both(sources, liveAt(last, [call("c0")])).fast, null, "a call that already has a card");
		const running = new Map<string, ActiveTool>([["run-1", { toolCallId: "run-1", toolName: "bash", args: {}, startedAt: 1 }]]);
		assert.equal(both(sourcesOf(entries, { activeTools: running }), liveAt(last, text)).fast, null, "a running tool has its own card after the reply's");
		assert.equal(both(sourcesOf([...entries, user("live:m1", last)]), liveAt(last, text)).fast, null, "an entry already has the reply's id");
	});

	it("agrees with the whole projection over many sessions of random shape", () => {
		let seed = 20_261_025;
		const random = (): number => { seed = (seed * 1_664_525 + 1_013_904_223) % 4_294_967_296; return seed / 4_294_967_296; };
		let fastAnswers = 0;
		for (let round = 0; round < 300; round += 1) {
			const entries = session(1 + Math.floor(random() * 5));
			if (random() < 0.4) entries.push(assistant("tail", entries.at(-1)!.id, [call("tc"), call("tc2", random() < 0.5 ? "wait" : "bash")], "toolUse"));
			if (random() < 0.3) entries.push(result("tailr", "tail", "tc"));
			const pending = new Map<string, PendingRow>();
			const ephemeral: EphemeralItem[] = [];
			const durablePositions = new Map<string, TranscriptPosition>();
			if (random() < 0.3) ephemeral.push({ id: "event:1", seq: 1, anchorId: entries[Math.floor(random() * entries.length)]!.id, timestamp: 1, kind: "command_output", payload: { text: "x" } });
			if (random() < 0.2) durablePositions.set(entries[entries.length - 1]!.id, { anchorId: entries[0]!.id, seq: 2 });
			const content: ChatContent[] = [];
			if (random() < 0.7) content.push({ type: "text", text: "streaming" });
			if (random() < 0.4) content.push(call(random() < 0.3 ? "c0" : `n${round}`, ["read", "bash", "wait", "todo", "edit"][Math.floor(random() * 5)]!));
			const anchors = [entries.at(-1)!.id, entries[Math.floor(random() * entries.length)]!.id, null, "missing"];
			const live = liveAt(anchors[Math.floor(random() * anchors.length)]!, content, `m${round}`, 50 + Math.floor(random() * 5));
			const sources = sourcesOf(entries, { pending, ephemeral, durablePositions, working: random() < 0.8, olderCount: Math.floor(random() * 3) });
			const { fast, whole } = both(sources, live);
			if (fast === null) continue;
			fastAnswers += 1;
			assert.deepEqual(shape(fast.canonical), shape(whole.canonical), `round ${round}`);
			assert.deepEqual(shape(fast.cleared), shape(whole.cleared), `round ${round}`);
		}
		assert.ok(fastAnswers > 40, `the fast path answered ${fastAnswers} of 300 rounds`);
	});
});
