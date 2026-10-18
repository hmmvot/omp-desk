import assert from "node:assert/strict";
import test from "node:test";
import {
	BTW_INITIAL,
	BTW_REFUSALS,
	MAX_BTW_ANSWER_CHARS,
	MAX_BTW_RECORDS,
	MAX_BTW_TURNS,
	appendBtwDelta,
	btwCommand,
	btwCopyText,
	btwRecordFromOmp,
	btwRecordsFromOmp,
	btwRefusalFromOmpError,
	btwShownStatus,
	btwWireBytes,
	fitBtwList,
	fitBtwRecord,
	parseBtwRecordView,
	reduceBtw,
	upsertBtwRecord,
	type BtwRecordView,
	type BtwState,
	type BtwTurnView,
} from "./btw.ts";

const turn = (patch: Partial<BtwTurnView> = {}): BtwTurnView => ({ question: "why?", answer: "", status: "running", createdAt: 1_000, updatedAt: 1_000, ...patch });
const record = (id: string, turns: readonly BtwTurnView[] = [turn()]): BtwRecordView => ({ id, turns });

test("only a leading /btw token is the command; the rest is the question", () => {
	assert.deepEqual(btwCommand("/btw why is it slow?"), { question: "why is it slow?" });
	assert.deepEqual(btwCommand("  /BTW \n  two\nlines  "), { question: "two\nlines" });
	assert.deepEqual(btwCommand("/btw"), { question: "" });
	assert.deepEqual(btwCommand("/btw   "), { question: "" });
	for (const text of ["explain /btw", "/btw-it", "/btwx", "/bt", "btw", "", "/clear"]) assert.equal(btwCommand(text), null, text);
});

test("OMP's record is read as a topic: its own turn first, then its follow-ups, bounded", () => {
	const raw = {
		id: "abc123", leafId: "leaf", question: "q1", answer: "a1", status: "complete", createdAt: 5, updatedAt: 6,
		followUps: [{ question: "q2", answer: "a2", status: "error", createdAt: 7, updatedAt: 8, error: "boom" }],
	};
	assert.deepEqual(btwRecordFromOmp(raw), {
		id: "abc123",
		turns: [
			{ question: "q1", answer: "a1", status: "complete", createdAt: 5, updatedAt: 6 },
			{ question: "q2", answer: "a2", status: "error", createdAt: 7, updatedAt: 8, error: "boom" },
		],
	});
	const long = { ...raw, answer: "x".repeat(MAX_BTW_ANSWER_CHARS + 5), followUps: Array.from({ length: MAX_BTW_TURNS + 4 }, (_, i) => ({ question: `f${i}`, answer: "", status: "complete", createdAt: 10 + i, updatedAt: 10 + i })) };
	const parsed = btwRecordFromOmp(long)!;
	assert.equal(parsed.turns.length, MAX_BTW_TURNS);
	assert.equal(parsed.omitted, 5, "the first turn and four follow-ups are counted, not carried");
	assert.equal(parsed.turns.at(-1)!.question, `f${MAX_BTW_TURNS + 3}`);
	const clipped = btwRecordFromOmp({ ...raw, answer: "x".repeat(MAX_BTW_ANSWER_CHARS + 5), followUps: undefined })!.turns[0]!;
	assert.equal(clipped.answer.length, MAX_BTW_ANSWER_CHARS);
	assert.equal(clipped.clipped, true);
});

test("a record that is not one is refused, never repaired", () => {
	const good = { id: "a1", question: "q", answer: "", status: "running", createdAt: 1, updatedAt: 1 };
	assert.notEqual(btwRecordFromOmp(good), null);
	for (const patch of [{ id: "" }, { id: "../x" }, { id: 3 }, { status: "done" }, { status: "constructor" }, { question: 1 }, { createdAt: -1 }, { updatedAt: Number.NaN }, { followUps: "x" }, { followUps: [null] }]) {
		assert.equal(btwRecordFromOmp({ ...good, ...patch }), null, JSON.stringify(patch));
	}
	assert.equal(btwRecordFromOmp(null), null);
	assert.equal(btwRecordFromOmp([]), null);
	assert.equal(btwRecordsFromOmp("x"), null);
	assert.deepEqual(btwRecordsFromOmp([good, { nope: 1 }])!.map(item => item.id), ["a1"], "a record that does not parse is skipped");
});

test("the wire view round-trips and is validated again by the page", () => {
	const view: BtwRecordView = { id: "r1", turns: [turn({ answer: "hi", status: "complete" }), turn({ question: "more", status: "error", error: "x", clipped: true })], omitted: 2 };
	assert.deepEqual(parseBtwRecordView(JSON.parse(JSON.stringify(view))), view);
	for (const bad of [null, { id: "r1" }, { id: "r1", turns: [] }, { id: "r1", turns: "x" }, { id: "r1", turns: [turn()], omitted: -1 }, { id: "r1", turns: [turn()], omitted: 1.5 }, { id: "bad id", turns: [turn()] }, { id: "r1", turns: Array.from({ length: MAX_BTW_TURNS + 1 }, () => turn()) }]) {
		assert.equal(parseBtwRecordView(bad), null, JSON.stringify(bad));
	}
});

test("a record never ends on half of a surrogate pair when its answer is clipped", () => {
	const raw = { id: "a1", question: "q", answer: `${"x".repeat(MAX_BTW_ANSWER_CHARS - 1)}\u{1F600}`, status: "complete", createdAt: 1, updatedAt: 1 };
	const answer = btwRecordFromOmp(raw)!.turns[0]!.answer;
	assert.equal(answer.length, MAX_BTW_ANSWER_CHARS - 1);
});

test("the list is newest first by the first turn, then by id, and bounded", () => {
	const older = record("b", [turn({ createdAt: 1 })]);
	const newer = record("a", [turn({ createdAt: 2 })]);
	const same = record("c", [turn({ createdAt: 2 })]);
	assert.deepEqual(upsertBtwRecord(upsertBtwRecord([older], newer), same).map(item => item.id), ["a", "c", "b"]);
	const replaced = upsertBtwRecord([older, newer], record("b", [turn({ createdAt: 1, answer: "x", status: "complete" })]));
	assert.equal(replaced.find(item => item.id === "b")!.turns[0]!.answer, "x");
	assert.equal(replaced.length, 2);
	let many: readonly BtwRecordView[] = [];
	for (let i = 0; i < MAX_BTW_RECORDS + 5; i++) many = upsertBtwRecord(many, record(`r${i}`, [turn({ createdAt: i })]));
	assert.equal(many.length, MAX_BTW_RECORDS);
	assert.equal(many[0]!.id, `r${MAX_BTW_RECORDS + 4}`);
});

test("a delta lands only on the latest turn of a known record and only at the length it was sent for", () => {
	const records = [record("r1", [turn({ status: "complete", answer: "old" }), turn({ answer: "ab" })])];
	const first = appendBtwDelta(records, "r1", 2, "cd");
	assert.equal(first.applied, true);
	assert.deepEqual(first.records[0]!.turns.map(item => item.answer), ["old", "abcd"]);
	for (const [id, at] of [["r1", 1], ["r1", 3], ["nope", 2]] as const) assert.equal(appendBtwDelta(records, id, at, "zz").applied, false, `${id}@${at}`);
	assert.equal(appendBtwDelta(records, "r1", 2, "").applied, false);
	const edge = appendBtwDelta([record("r1", [turn({ answer: "x".repeat(MAX_BTW_ANSWER_CHARS - 1) })])], "r1", MAX_BTW_ANSWER_CHARS - 1, "yz");
	assert.equal(edge.applied, true);
	assert.equal(edge.records[0]!.turns[0]!.clipped, true);
	assert.equal(appendBtwDelta(edge.records, "r1", MAX_BTW_ANSWER_CHARS, "more").applied, false, "a clipped turn takes no more text");
});

test("a delta never lands on a turn that is not running, even when the lengths match", () => {
	for (const status of ["cancelled", "error", "complete", "interrupted"] as const) {
		assert.equal(appendBtwDelta([record("r1", [turn({ status })])], "r1", 0, "late").applied, false, status);
	}
});

test("the list budget counts what the bridge measures: every non-ASCII UTF-16 unit costs six bytes", () => {
	assert.equal(btwWireBytes("ab"), 4);
	assert.equal(btwWireBytes("я"), 8);
	const records = [record("r0", [turn({ answer: "я".repeat(100) })]), record("r1", [turn({ answer: "я".repeat(100), createdAt: 1 })])];
	assert.equal(fitBtwList(records, btwWireBytes(records[0]) + 10).records.length, 1, "the same text in Cyrillic is six times the ASCII size");
});

test("a new running record opens the panel; a terminal record and an old topic do not", () => {
	let state: BtwState = BTW_INITIAL;
	state = reduceBtw(state, { type: "records", replace: false, records: [record("r1", [turn({ status: "complete", answer: "done" })])] });
	assert.equal(state.panel, null, "a finished topic that arrives is not shown");
	state = reduceBtw(state, { type: "records", replace: false, records: [record("r2")] });
	assert.deepEqual(state.panel, { kind: "record", id: "r2" });
	state = reduceBtw(state, { type: "close" });
	state = reduceBtw(state, { type: "delta", recordId: "r2", at: 0, delta: "hel" });
	state = reduceBtw(state, { type: "delta", recordId: "r2", at: 3, delta: "lo" });
	state = reduceBtw(state, { type: "records", replace: false, records: [record("r2", [turn({ status: "complete", answer: "hello" })])] });
	assert.equal(state.panel, null, "the terminal record of a topic the reader closed does not reopen it");
	assert.equal(state.records.find(item => item.id === "r2")!.turns[0]!.answer, "hello");
	state = reduceBtw(state, { type: "records", replace: false, records: [record("r2", [turn({ status: "complete", answer: "hello" }), turn({ question: "and?" })])] });
	assert.deepEqual(state.panel, { kind: "record", id: "r2" }, "a follow-up that starts opens its topic");
});

test("a list that replaces everything returns to the running topic or the history, and closes a shown topic that is gone", () => {
	const running = record("r1");
	const finished = record("r2", [turn({ status: "complete", answer: "a", createdAt: 5 })]);
	let state = reduceBtw(BTW_INITIAL, { type: "records", replace: true, records: [finished, running] });
	assert.deepEqual(state.panel, { kind: "record", id: "r1" });
	state = reduceBtw(BTW_INITIAL, { type: "records", replace: true, records: [finished] });
	assert.equal(state.panel, null, "an old finished topic never opens by itself");
	state = reduceBtw(state, { type: "records", replace: true, records: [finished], show: "history", omitted: 3 });
	assert.deepEqual(state.panel, { kind: "history" });
	assert.equal(state.omitted, 3);
	state = reduceBtw(state, { type: "show", recordId: "r2" });
	assert.deepEqual(state.panel, { kind: "record", id: "r2" });
	state = reduceBtw(state, { type: "records", replace: true, records: [] });
	assert.equal(state.panel, null);
	assert.equal(reduceBtw(state, { type: "show", recordId: "unknown" }), state);
	assert.equal(reduceBtw(reduceBtw(state, { type: "history" }), { type: "reset" }), BTW_INITIAL);
});

test("a running turn is shown as interrupted once nothing can answer it", () => {
	assert.equal(btwShownStatus(turn(), true), "running");
	assert.equal(btwShownStatus(turn(), false), "interrupted");
	assert.equal(btwShownStatus(turn({ status: "complete" }), false), "complete");
});

test("Copy takes the latest non-blank answer with its whitespace", () => {
	assert.equal(btwCopyText(record("r", [turn({ answer: "  one\n" }), turn({ answer: " \n" })])), "  one\n");
	assert.equal(btwCopyText(record("r", [turn({ answer: "one" }), turn({ answer: "two" })])), "two");
	assert.equal(btwCopyText(record("r", [turn({ answer: "" })])), undefined);
});

test("a list that does not fit one message carries the newest records and counts the rest", () => {
	const records = Array.from({ length: 6 }, (_, i) => record(`r${i}`, [turn({ answer: "x".repeat(1_000), createdAt: 100 - i })]));
	assert.deepEqual(fitBtwList(records, 1_000_000), { records, omitted: 0 });
	const fit = fitBtwList(records, 2_500);
	assert.deepEqual(fit.records.map(item => item.id), ["r0", "r1"]);
	assert.equal(fit.omitted, 4);
	assert.equal(fitBtwList(records, 10).records.length, 1, "the newest is always carried");
});

test("every failed btw response of OMP 18.11.1 maps to one fixed reason, by its wording, and a new wording is a generic failure", () => {
	assert.equal(btwRefusalFromOmpError("A /btw question is still running; cancel it first"), "busy");
	assert.equal(btwRefusalFromOmpError("Unknown /btw topic: abc"), "unknown-topic");
	assert.equal(btwRefusalFromOmpError("No active model available for /btw."), "no-model");
	assert.equal(btwRefusalFromOmpError("Could not save /btw history: EACCES"), "storage");
	assert.equal(btwRefusalFromOmpError("The /btw question was cancelled before it started"), "cancelled");
	assert.equal(btwRefusalFromOmpError("Unknown command: btw"), "unsupported");
	assert.equal(btwRefusalFromOmpError("btw requires a non-empty question"), "failed");
	assert.equal(btwRefusalFromOmpError("something new"), "failed");
	assert.equal(btwRefusalFromOmpError(undefined), "failed");
	for (const sentence of Object.values(BTW_REFUSALS)) assert.ok(sentence.length > 0 && sentence.length < 200);
});

test("one record too large for a message is sent with its answers cut and flagged; the list carries it alone", () => {
	const big = record("r0", [turn({ status: "complete", answer: "я".repeat(60_000) })]);
	const fitted = fitBtwRecord(big);
	assert.ok(btwWireBytes(fitted) <= 192 * 1024);
	assert.equal(fitted.turns[0]!.clipped, true);
	assert.ok(fitted.turns[0]!.answer.length < 60_000);
	assert.equal(fitBtwRecord(record("small", [turn({ answer: "ok" })])).turns[0]!.clipped, undefined);
	const list = fitBtwList([big, record("r1", [turn({ createdAt: 1 })])]);
	assert.equal(list.records.length, 1);
	assert.equal(list.records[0]!.turns[0]!.clipped, true);
	assert.equal(list.omitted, 1);
});
