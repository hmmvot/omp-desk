import assert from "node:assert/strict";
import test, { mock } from "node:test";
import type { ChatEpoch } from "../../chat/model.ts";
import { BTW_REFUSALS, type BtwRecordView, type BtwTurnView } from "../../chat/btw.ts";
import type { ChatBtwRequestMessage } from "../../protocol/btw-messages.ts";
import { BtwClient, type BtwClientDeps } from "./btw-client.ts";

const EPOCH: ChatEpoch = { nonce: "host-a", counter: 1 };
const OTHER: ChatEpoch = { nonce: "host-a", counter: 2 };
const turn = (patch: Partial<BtwTurnView> = {}): BtwTurnView => ({ question: "why?", answer: "", status: "running", createdAt: 1, updatedAt: 1, ...patch });
const record = (id: string, turns: readonly BtwTurnView[] = [turn()]): BtwRecordView => ({ id, turns });

function make(options: { writable?: boolean; post?: (message: ChatBtwRequestMessage) => boolean | void } = {}) {
	const sent: ChatBtwRequestMessage[] = [];
	let counter = 0;
	const deps: BtwClientDeps = {
		post: message => { sent.push(message); return options.post?.(message); },
		epoch: () => EPOCH,
		writable: () => options.writable ?? true,
		newRequestId: () => (++counter).toString(16).padStart(32, "0"),
		unreachable: "cannot reach the host",
	};
	return { client: new BtwClient(deps), sent };
}

test("records, deltas and results of the adopted epoch fold into the view; another epoch's are dropped", () => {
	const { client } = make();
	let notified = 0;
	client.subscribe(() => notified++);
	client.handle({ type: "omp:chat-btw", epoch: OTHER, replace: false, records: [record("r1")] });
	assert.equal(client.getSnapshot().records.length, 0);
	assert.equal(notified, 0);
	client.handle({ type: "omp:chat-btw", epoch: EPOCH, replace: false, records: [record("r1")] });
	client.handle({ type: "omp:chat-btw-delta", epoch: EPOCH, recordId: "r1", at: 0, delta: "hel" });
	client.handle({ type: "omp:chat-btw-delta", epoch: OTHER, recordId: "r1", at: 3, delta: "XX" });
	client.handle({ type: "omp:chat-btw-delta", epoch: EPOCH, recordId: "r1", at: 3, delta: "lo" });
	const view = client.getSnapshot();
	assert.equal(view.records[0]!.turns[0]!.answer, "hello");
	assert.deepEqual(view.panel, { kind: "record", id: "r1" }, "a question that just started opens the panel");
	assert.ok(notified > 0);
});

test("a delta that does not continue the text is ignored and the terminal record repairs the answer", () => {
	const { client } = make();
	client.handle({ type: "omp:chat-btw", epoch: EPOCH, replace: false, records: [record("r1")] });
	client.handle({ type: "omp:chat-btw-delta", epoch: EPOCH, recordId: "r1", at: 0, delta: "ab" });
	client.handle({ type: "omp:chat-btw-delta", epoch: EPOCH, recordId: "r1", at: 5, delta: "lost-gap" });
	assert.equal(client.getSnapshot().records[0]!.turns[0]!.answer, "ab");
	client.handle({ type: "omp:chat-btw", epoch: EPOCH, replace: false, records: [record("r1", [turn({ status: "complete", answer: "abcdef" })])] });
	assert.equal(client.getSnapshot().records[0]!.turns[0]!.answer, "abcdef");
});

test("a new epoch starts the store empty and ends what was waiting", async () => {
	const { client } = make();
	client.handle({ type: "omp:chat-btw", epoch: EPOCH, replace: true, records: [record("r1")] });
	const waiting = client.ask("again?");
	client.reset();
	assert.deepEqual(await waiting, { ok: false, reason: BTW_REFUSALS.unconfirmed });
	assert.equal(client.getSnapshot().records.length, 0);
	assert.equal(client.getSnapshot().panel, null);
	assert.equal(client.getSnapshot().pending, false);
});

test("a request is minted once, carries the epoch, and is settled by its own result only", async () => {
	const { client, sent } = make();
	const asked = client.ask("why?", "r1");
	assert.deepEqual(sent.map(({ type, epoch, op, question, recordId }) => ({ type, epoch, op, question, recordId })), [{ type: "omp:chat-btw-request", epoch: EPOCH, op: "ask", question: "why?", recordId: "r1" }]);
	assert.equal(client.getSnapshot().pending, true);
	const requestId = sent[0]!.requestId;
	let settled = false;
	void asked.then(() => { settled = true; });
	client.handle({ type: "omp:chat-btw-result", epoch: EPOCH, requestId: "f".repeat(32), status: "accepted" });
	await Promise.resolve();
	assert.equal(settled, false, "another request's answer settles nothing");
	client.handle({ type: "omp:chat-btw-result", epoch: EPOCH, requestId, status: "refused", reason: "busy" });
	assert.deepEqual(await asked, { ok: false, reason: BTW_REFUSALS.busy });
	assert.equal(client.getSnapshot().notice, BTW_REFUSALS.busy);
	assert.equal(client.getSnapshot().pending, false);
	client.handle({ type: "omp:chat-btw-result", epoch: EPOCH, requestId, status: "accepted" });
	assert.equal(client.getSnapshot().notice, BTW_REFUSALS.busy, "a repeat changes nothing");
	client.dismissNotice();
	assert.equal(client.getSnapshot().notice, null);
});

test("cancel and refresh are requests too, and an accepted answer clears the notice", async () => {
	const { client, sent } = make();
	const cancelled = client.cancel("r1");
	const refreshed = client.refresh();
	assert.deepEqual(sent.map(message => message.op), ["cancel", "history"]);
	assert.equal(sent[0]!.recordId, "r1");
	for (const message of sent) client.handle({ type: "omp:chat-btw-result", epoch: EPOCH, requestId: message.requestId, status: "accepted" });
	assert.deepEqual(await Promise.all([cancelled, refreshed]), [{ ok: true }, { ok: true }]);
});

test("a conversation that cannot take input refuses a request without sending it; reading is not refused", async () => {
	const { client, sent } = make({ writable: false });
	client.handle({ type: "omp:chat-btw", epoch: EPOCH, replace: true, records: [record("r1", [turn({ status: "complete", answer: "a" })])], show: "history" });
	assert.deepEqual(await client.ask("q"), { ok: false, reason: BTW_REFUSALS["not-live"] });
	assert.deepEqual(await client.cancel(), { ok: false, reason: BTW_REFUSALS["not-live"] });
	assert.equal(sent.length, 0);
	client.show("r1");
	assert.deepEqual(client.getSnapshot().panel, { kind: "record", id: "r1" });
	client.showHistory();
	assert.deepEqual(client.getSnapshot().panel, { kind: "history" });
	client.close();
	assert.equal(client.getSnapshot().panel, null);
});

test("a transport that provably sent nothing refuses at once; one that throws is waited for, not retried", async () => {
	const lost = make({ post: () => false });
	assert.deepEqual(await lost.client.ask("q"), { ok: false, reason: "cannot reach the host" });
	assert.equal(lost.client.getSnapshot().pending, false);

	mock.timers.enable({ apis: ["setTimeout"] });
	try {
		const throwing = make({ post: () => { throw new Error("route gone"); } });
		const waiting = throwing.client.ask("q");
		assert.equal(throwing.sent.length, 1);
		mock.timers.tick(45_000);
		assert.deepEqual(await waiting, { ok: false, reason: BTW_REFUSALS.unconfirmed });
		assert.equal(throwing.sent.length, 1, "never resent automatically");
	} finally {
		mock.timers.reset();
	}
});

test("an answer that never comes ends as unconfirmed after the deadline, and a late answer settles nothing", async () => {
	mock.timers.enable({ apis: ["setTimeout"] });
	try {
		const { client, sent } = make();
		const asked = client.ask("q");
		mock.timers.tick(44_999);
		assert.equal(client.getSnapshot().pending, true);
		mock.timers.tick(1);
		assert.deepEqual(await asked, { ok: false, reason: BTW_REFUSALS.unconfirmed });
		client.handle({ type: "omp:chat-btw-result", epoch: EPOCH, requestId: sent[0]!.requestId, status: "accepted" });
		assert.equal(client.getSnapshot().notice, BTW_REFUSALS.unconfirmed);
	} finally {
		mock.timers.reset();
	}
});

test("the view keeps the same object while nothing changed, so a store subscriber does not re-render", () => {
	const { client } = make();
	const before = client.getSnapshot();
	client.close();
	client.dismissNotice();
	client.show("unknown");
	client.handle({ type: "omp:chat-btw-delta", epoch: EPOCH, recordId: "unknown", at: 0, delta: "x" });
	assert.equal(client.getSnapshot(), before);
});
