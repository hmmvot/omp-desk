import assert from "node:assert/strict";
import test from "node:test";
import { BtwChannel, type BtwChannelDeps, type BtwOutput, type BtwReply } from "./btw.ts";

type Command = Parameters<BtwChannelDeps["send"]>[0];

/** An OMP-shaped record: the record is its own first turn. */
const omp = (id: string, patch: Record<string, unknown> = {}) => ({ id, leafId: null, question: "why?", answer: "", status: "running", createdAt: 100, updatedAt: 100, ...patch });

function harness(...replies: BtwReply[]) {
	const sent: Command[] = [];
	const out: BtwOutput[] = [];
	const channel = new BtwChannel({
		send: async command => {
			sent.push(command);
			return replies.shift() ?? { status: "response", success: true, data: {} };
		},
		emit: output => out.push(output),
	});
	return { channel, sent, out };
}

const ok = (data: unknown): BtwReply => ({ status: "response", success: true, data });
const failed = (error: string): BtwReply => ({ status: "response", success: false, error });

test("a record frame is bounded, cached and forwarded; one that is not a record is dropped", () => {
	const { channel, out } = harness();
	channel.onFrame({ type: "btw_record", record: omp("r1") });
	channel.onFrame({ type: "btw_record", record: { id: "../x", question: "q" } });
	channel.onFrame({ type: "btw_record", record: "nope" });
	assert.equal(out.length, 1);
	assert.deepEqual(out[0], { kind: "records", replace: false, omitted: 0, records: [{ id: "r1", turns: [{ question: "why?", answer: "", status: "running", createdAt: 100, updatedAt: 100 }] }] });
	assert.equal(channel.running, true);
});

test("a delta is forwarded with the length it was appended at; one for an unknown record, or with no text, is not", () => {
	const { channel, out } = harness();
	channel.onFrame({ type: "btw_delta", recordId: "r1", delta: "early" });
	channel.onFrame({ type: "btw_record", record: omp("r1") });
	channel.onFrame({ type: "btw_delta", recordId: "r1", delta: "hel" });
	channel.onFrame({ type: "btw_delta", recordId: "r1", delta: "lo" });
	channel.onFrame({ type: "btw_delta", recordId: "r1", delta: 3 });
	channel.onFrame({ type: "btw_delta", recordId: "r1", delta: "" });
	assert.deepEqual(out.slice(1), [{ kind: "delta", recordId: "r1", at: 0, delta: "hel" }, { kind: "delta", recordId: "r1", at: 3, delta: "lo" }]);
	channel.onFrame({ type: "btw_record", record: omp("r1", { answer: "hello", status: "complete", updatedAt: 200 }) });
	assert.equal(channel.running, false);
	assert.equal(channel.snapshot().records[0]!.turns[0]!.answer, "hello", "the terminal record replaces the streamed text");
});

test("ask writes one btw command and starts; the record may come from the response when its frame was missed", async () => {
	const { channel, sent, out } = harness(ok({ record: omp("r9") }));
	assert.deepEqual(await channel.ask("why?"), { status: "started" });
	assert.deepEqual(sent, [{ type: "btw", question: "why?" }]);
	assert.deepEqual(out.map(item => item.kind === "records" && item.records[0]!.id), ["r9"]);

	const second = harness();
	second.channel.onFrame({ type: "btw_record", record: omp("r9") });
	const before = second.out.length;
	await second.channel.ask("again", "r9");
	assert.deepEqual(second.sent, [{ type: "btw", question: "again", recordId: "r9" }]);
	assert.equal(second.out.length, before, "a record the frame already delivered is not sent twice");
});

test("a follow-up's response with one more turn than the cache holds is forwarded", async () => {
	const { channel, out } = harness(ok({ record: omp("r1", { status: "complete", followUps: [{ question: "and?", answer: "", status: "running", createdAt: 300, updatedAt: 300 }] }) }));
	channel.onFrame({ type: "btw_record", record: omp("r1", { status: "complete" }) });
	await channel.ask("and?", "r1");
	const last = out.at(-1);
	assert.ok(last?.kind === "records");
	assert.equal(last.records[0]!.turns.length, 2);
});

test("a refused ask names the reason by OMP's wording; a transport that did not answer is unconfirmed, a lost writer is not-live", async () => {
	const cases: [BtwReply, string][] = [
		[failed("A /btw question is still running; cancel it first"), "busy"],
		[failed("Unknown /btw topic: r1"), "unknown-topic"],
		[failed("No active model available for /btw."), "no-model"],
		[failed("Could not save /btw history: EACCES"), "storage"],
		[failed("Unknown command: btw"), "unsupported"],
		[failed("btw requires a non-empty question"), "failed"],
		[{ status: "unconfirmed" }, "unconfirmed"],
		[{ status: "not-live" }, "not-live"],
		[{ status: "failed" }, "failed"],
	];
	for (const [reply, reason] of cases) {
		const { channel, out } = harness(reply);
		assert.deepEqual(await channel.ask("q"), { status: "refused", reason }, reason);
		assert.deepEqual(out, [], "a refusal changes nothing the pages show");
	}
});

test("cancel reports whether OMP found the question; its visible effect is the terminal record", async () => {
	const { channel, sent, out } = harness(ok({ cancelled: true }), ok({ cancelled: false }), failed("Unknown command: btw_cancel"), { status: "unconfirmed" });
	assert.equal(await channel.cancel("r1"), true);
	assert.equal(await channel.cancel(), false);
	assert.equal(await channel.cancel(), false);
	assert.equal(await channel.cancel(), false);
	assert.deepEqual(sent, [{ type: "btw_cancel", recordId: "r1" }, { type: "btw_cancel" }, { type: "btw_cancel" }, { type: "btw_cancel" }]);
	assert.deepEqual(out, []);
});

test("history replaces the cache, keeps the longer copy of a running record, takes OMP's finished copy over a running one, drops records OMP no longer has, and can ask the pages to open it", async () => {
	const { channel, out } = harness(ok({ records: [
		omp("r2", { createdAt: 300, status: "complete", answer: "two", updatedAt: 310 }),
		omp("r1", { createdAt: 100, answer: "he", updatedAt: 120 }),
		omp("r3", { createdAt: 200, status: "complete", answer: "three", updatedAt: 250 }),
	] }));
	channel.onFrame({ type: "btw_record", record: omp("r1") });
	channel.onFrame({ type: "btw_delta", recordId: "r1", delta: "hello" });
	channel.onFrame({ type: "btw_record", record: omp("r3", { createdAt: 200 }) });
	channel.onFrame({ type: "btw_record", record: omp("gone", { createdAt: 50, status: "complete" }) });
	assert.deepEqual(await channel.history(true), { status: "loaded" });
	const replace = out.at(-1);
	assert.ok(replace?.kind === "records" && replace.replace);
	assert.equal(replace.show, "history");
	assert.deepEqual(replace.records.map(record => record.id), ["r2", "r3", "r1"], "OMP's list is the authority on which records exist");
	assert.equal(replace.omitted, 0);
	assert.equal(replace.records[2]!.turns[0]!.answer, "hello", "the frames are ahead of the history read for a running record");
	assert.equal(replace.records[1]!.turns[0]!.status, "complete", "a missed terminal record is repaired by the history");
	assert.equal(channel.snapshot().records.length, 3);
});

test("history keeps the cached copy of a record when it has more turns than OMP's list", async () => {
	const { channel } = harness(ok({ records: [omp("r1", { status: "complete" })] }));
	channel.onFrame({ type: "btw_record", record: omp("r1", { status: "complete", followUps: [{ question: "and?", answer: "x", status: "running", createdAt: 300, updatedAt: 300 }] }) });
	await channel.history();
	assert.equal(channel.snapshot().records[0]!.turns.length, 2);
});

test("a history that is not a list, or that failed, leaves the cache and tells nobody", async () => {
	const { channel, out } = harness(ok({ records: "x" }), failed("Unknown command: get_btw_history"), { status: "unconfirmed" });
	channel.onFrame({ type: "btw_record", record: omp("r1") });
	out.length = 0;
	assert.deepEqual(await channel.history(), { status: "refused", reason: "failed" });
	assert.deepEqual(await channel.history(), { status: "refused", reason: "failed" });
	assert.deepEqual(await channel.history(), { status: "refused", reason: "unconfirmed" });
	assert.deepEqual(out, []);
	assert.equal(channel.snapshot().records.length, 1);
});

test("the snapshot a page gets carries the newest records within one message and counts the rest", () => {
	const { channel } = harness();
	for (let i = 0; i < 12; i++) channel.onFrame({ type: "btw_record", record: omp(`r${i}`, { createdAt: 1_000 + i, status: "complete", answer: "x".repeat(60_000) }) });
	const { records, omitted } = channel.snapshot();
	assert.ok(records.length < 12 && records.length >= 1);
	assert.equal(records.length + omitted, 12);
	assert.equal(records[0]!.id, "r11");
});

test("the history counts as read only after a successful read, so a recreated session never tells a page that a running question is gone", async () => {
	const { channel } = harness(failed("Unknown command: get_btw_history"), ok({ records: [] }));
	assert.equal(channel.loaded, false);
	await channel.history();
	assert.equal(channel.loaded, false, "a refused read leaves the cache unauthoritative");
	await channel.history();
	assert.equal(channel.loaded, true);
});

test("the frame family is consumed: records, deltas and the history-save notice never reach the transcript; other notices do", () => {
	const { channel, out } = harness();
	assert.equal(channel.onFrame({ type: "btw_record", record: omp("r1") }), true);
	assert.equal(channel.onFrame({ type: "btw_delta", recordId: "r1", delta: "x" }), true);
	assert.equal(channel.onFrame({ type: "btw_delta", recordId: "unknown", delta: "x" }), true);
	assert.equal(channel.onFrame({ type: "notice", level: "error", message: "/btw answer r1 was not saved: EACCES", source: "btw-history" }), true);
	assert.equal(channel.onFrame({ type: "notice", level: "error", message: "something else" }), false);
	assert.equal(channel.onFrame({ type: "message_update" }), false);
	assert.equal(out.length, 2, "only the record and the applied delta were forwarded");
});
