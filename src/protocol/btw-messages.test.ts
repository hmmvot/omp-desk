import assert from "node:assert/strict";
import test from "node:test";
import { MAX_BTW_QUESTION_CHARS, MAX_BTW_RECORDS } from "../chat/btw.ts";
import { parseBtwHostMessage, parseBtwRequest } from "./btw-messages.ts";

const epoch = { nonce: "n", counter: 3 };
const RID = "a".repeat(32);
const turn = { question: "why?", answer: "because", status: "complete", createdAt: 1, updatedAt: 2 };
const record = { id: "r1", turns: [turn] };

test("a records message round-trips and carries only what it declares", () => {
	assert.deepEqual(parseBtwHostMessage({ type: "omp:chat-btw", records: [record], replace: true, omitted: 2, show: "history", extra: 1 }, epoch), { type: "omp:chat-btw", epoch, records: [record], replace: true, omitted: 2, show: "history" });
	assert.deepEqual(parseBtwHostMessage({ type: "omp:chat-btw", records: [], replace: false, omitted: 0 }, epoch), { type: "omp:chat-btw", epoch, records: [], replace: false });
});

test("every malformed records message is refused", () => {
	const bad: Record<string, unknown>[] = [
		{ records: "x", replace: true },
		{ records: [], replace: "yes" },
		{ records: [{ id: "../x", turns: [turn] }], replace: true },
		{ records: [{ id: "r1", turns: [] }], replace: true },
		{ records: [record], replace: true, omitted: -1 },
		{ records: [record], replace: true, omitted: 1.5 },
		{ records: [record], replace: true, show: "record" },
		{ records: Array.from({ length: MAX_BTW_RECORDS + 1 }, (_, i) => ({ id: `r${i}`, turns: [turn] })), replace: true },
	];
	for (const value of bad) assert.equal(parseBtwHostMessage({ type: "omp:chat-btw", ...value }, epoch), null, JSON.stringify(value).slice(0, 80));
});

test("a delta needs a record id, a count and non-empty bounded text", () => {
	assert.deepEqual(parseBtwHostMessage({ type: "omp:chat-btw-delta", recordId: "r1", at: 0, delta: "x" }, epoch), { type: "omp:chat-btw-delta", epoch, recordId: "r1", at: 0, delta: "x" });
	for (const value of [{ recordId: "..", at: 0, delta: "x" }, { recordId: "r1", at: -1, delta: "x" }, { recordId: "r1", at: 0.5, delta: "x" }, { recordId: "r1", at: 0, delta: "" }, { recordId: "r1", at: 0, delta: 3 }, { recordId: "r1", at: 0, delta: "x".repeat(64_001) }]) {
		assert.equal(parseBtwHostMessage({ type: "omp:chat-btw-delta", ...value }, epoch), null, JSON.stringify(value).slice(0, 60));
	}
});

test("a result is accepted, or refused with a reason of the fixed vocabulary", () => {
	assert.deepEqual(parseBtwHostMessage({ type: "omp:chat-btw-result", requestId: RID, status: "accepted" }, epoch), { type: "omp:chat-btw-result", epoch, requestId: RID, status: "accepted" });
	assert.deepEqual(parseBtwHostMessage({ type: "omp:chat-btw-result", requestId: RID, status: "refused", reason: "busy" }, epoch), { type: "omp:chat-btw-result", epoch, requestId: RID, status: "refused", reason: "busy" });
	for (const value of [{ requestId: RID, status: "refused" }, { requestId: RID, status: "refused", reason: "OMP exploded" }, { requestId: "short", status: "accepted" }, { requestId: RID, status: "started" }]) {
		assert.equal(parseBtwHostMessage({ type: "omp:chat-btw-result", ...value }, epoch), null, JSON.stringify(value));
	}
	assert.equal(parseBtwHostMessage({ type: "omp:chat-btw-other" }, epoch), null);
});

test("a request names one op with exactly the fields it takes", () => {
	assert.deepEqual(parseBtwRequest({ op: "ask", question: " why? " }, RID, epoch), { type: "omp:chat-btw-request", requestId: RID, epoch, op: "ask", question: " why? " });
	assert.deepEqual(parseBtwRequest({ op: "ask", question: "and?", recordId: "r1" }, RID, epoch), { type: "omp:chat-btw-request", requestId: RID, epoch, op: "ask", question: "and?", recordId: "r1" });
	assert.deepEqual(parseBtwRequest({ op: "cancel" }, RID, epoch), { type: "omp:chat-btw-request", requestId: RID, epoch, op: "cancel" });
	assert.deepEqual(parseBtwRequest({ op: "cancel", recordId: "r1" }, RID, epoch), { type: "omp:chat-btw-request", requestId: RID, epoch, op: "cancel", recordId: "r1" });
	assert.deepEqual(parseBtwRequest({ op: "history" }, RID, epoch), { type: "omp:chat-btw-request", requestId: RID, epoch, op: "history" });
	const bad: Record<string, unknown>[] = [
		{ op: "ask" },
		{ op: "ask", question: "   " },
		{ op: "ask", question: 5 },
		{ op: "ask", question: "x".repeat(MAX_BTW_QUESTION_CHARS + 1) },
		{ op: "ask", question: "x", recordId: "../x" },
		{ op: "cancel", question: "x" },
		{ op: "history", question: "x" },
		{ op: "history", recordId: "r1" },
		{ op: "branch" },
		{},
	];
	for (const value of bad) assert.equal(parseBtwRequest(value, RID, epoch), null, JSON.stringify(value));
});
