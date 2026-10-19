/**
 * A handover request to the window that holds a live session (ADR-0080), against a real temporary directory: it names the
 * exact run it fences, reaches only the window it names, is taken up before it is answered, carries a refusal reason the
 * requester can tell apart, and the requester's wait classifies every way it can end without proving a move.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import {
	HANDOVER_ACCEPT_TIMEOUT_MS,
	HANDOVER_REQUEST_TTL_MS,
	HANDOVER_STALL_GAP_MS,
	HANDOVER_TOTAL_TIMEOUT_MS,
	HANDOVER_WITHDRAW_TIMEOUT_MS,
	STOP_ACCEPTED_SWEEP_MS,
	STOP_STALL_GAP_MS,
	STOP_WITHDRAW_TIMEOUT_MS,
	WINDOW_REQUEST_DIRECTORY,
	awaitHandoverAnswer,
	awaitRequestAnswer,
	postHandoverRequest,
	postSwitchRequest,
	requestTtlMs,
	startRequestWatch,
} from "./window-requests.ts";
import type { HandoverRequest, RefusalReason, RequestWatch, ServeContext, ServeOutcome, WindowRequest } from "./window-requests.ts";

const TAB = "tab:11111111-2222-4333-8444-555555555555";
const INCARNATION = "owner-generation-1_2026-10-20T10:00:00.000Z.4242";
const MOVED: ServeOutcome = { ok: true, focused: false };

describe("handover requests between windows", () => {
	let storage: string;
	let directory: string;
	const watches: RequestWatch[] = [];

	before(() => {
		storage = fs.mkdtempSync(path.join(os.tmpdir(), "omp-handover-requests-"));
		directory = path.join(storage, WINDOW_REQUEST_DIRECTORY);
	});

	afterEach(() => {
		for (const watch of watches.splice(0)) watch.dispose();
		fs.rmSync(directory, { recursive: true, force: true });
	});

	after(() => {
		fs.rmSync(storage, { recursive: true, force: true });
	});

	/** Serve as `holderId`; `answer` decides what the window answers. */
	function owner(
		holderId: string,
		answer: (request: HandoverRequest, context: ServeContext) => Promise<ServeOutcome> = async () => MOVED,
		now?: () => number,
	) {
		const served: HandoverRequest[] = [];
		const errors: string[] = [];
		const watch = startRequestWatch(storage, holderId, async (request: WindowRequest, context) => {
			assert.equal(request.kind, "handover");
			served.push(request as HandoverRequest);
			return await answer(request as HandoverRequest, context);
		}, { debounceMs: 20, onError: detail => errors.push(detail), ...(now === undefined ? {} : { now }) });
		watches.push(watch);
		return { served, errors, watch };
	}

	// Integration tests of the real shared directory, its platform watcher and the bounds in milliseconds that the
	// protocol is made of; fake timers cannot drive a file watcher, so the waits are real and short.
	async function pause(ms: number): Promise<void> {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, ms);
		await promise;
	}

	async function until(predicate: () => boolean): Promise<void> {
		for (let attempt = 0; attempt < 200 && !predicate(); attempt++) await pause(25);
		assert.ok(predicate(), "the awaited condition never came true");
	}

	const files = (suffix: string): string[] => (fs.existsSync(directory) ? fs.readdirSync(directory).filter(name => name.endsWith(suffix)) : []);
	const FAST = { pollMs: 10 } as const;
	const post = (to = "holder-b", binding: string | null = "slot-1.3") => postHandoverRequest(storage, { to, from: "holder-a", tabId: TAB, incarnation: INCARNATION, binding });

	it("keeps its bounds beside the stop ones", () => {
		assert.deepEqual(
			[HANDOVER_REQUEST_TTL_MS, HANDOVER_ACCEPT_TIMEOUT_MS, HANDOVER_TOTAL_TIMEOUT_MS, HANDOVER_WITHDRAW_TIMEOUT_MS, HANDOVER_STALL_GAP_MS],
			[12_000, 8_000, 30_000, STOP_WITHDRAW_TIMEOUT_MS, STOP_STALL_GAP_MS],
		);
		assert.equal(requestTtlMs({ kind: "handover" }), HANDOVER_REQUEST_TTL_MS);
		assert.ok(STOP_ACCEPTED_SWEEP_MS > HANDOVER_TOTAL_TIMEOUT_MS, "take-up evidence outlives the longest wait");
	});

	it("reaches only the window it names, carrying exactly the fenced run, and answers moved", async () => {
		const target = owner("holder-b");
		const bystander = owner("holder-c");
		const id = await post();
		assert.deepEqual(await awaitHandoverAnswer(storage, "holder-b", id, FAST), { kind: "moved" });
		assert.equal(target.served.length, 1);
		assert.deepEqual(
			[target.served[0]?.kind, target.served[0]?.tabId, target.served[0]?.incarnation, target.served[0]?.binding, target.served[0]?.from],
			["handover", TAB, INCARNATION, "slot-1.3", "holder-a"],
		);
		await pause(100);
		assert.deepEqual(bystander.served, [], "a request addressed to another window is none of its business");
		assert.deepEqual(fs.readdirSync(directory), [], "the request, its accepted marker and its response are all cleaned up");
	});

	it("carries no binding when the requester saw none", async () => {
		const target = owner("holder-b");
		const id = await post("holder-b", null);
		assert.deepEqual(await awaitHandoverAnswer(storage, "holder-b", id, FAST), { kind: "moved" });
		assert.equal(target.served[0]?.binding, null);
	});

	it("posts only what a window can validate", async () => {
		const base = { to: "holder-b", from: "holder-a", tabId: TAB, incarnation: INCARNATION, binding: null };
		await assert.rejects(postHandoverRequest(storage, { ...base, to: "../escape" }), TypeError);
		await assert.rejects(postHandoverRequest(storage, { ...base, from: "a b" }), TypeError);
		await assert.rejects(postHandoverRequest(storage, { ...base, tabId: "" }), TypeError);
		await assert.rejects(postHandoverRequest(storage, { ...base, tabId: "x".repeat(201) }), TypeError);
		await assert.rejects(postHandoverRequest(storage, { ...base, incarnation: "two words" }), TypeError);
		await assert.rejects(postHandoverRequest(storage, { ...base, binding: "bad binding!" }), TypeError);
		await postHandoverRequest(storage, base);
	});

	it("ignores forged handover files: a name that disagrees with the body, a bad field, an oversized body", async () => {
		const target = owner("holder-b");
		fs.mkdirSync(directory, { recursive: true });
		const base = { version: 1, kind: "handover", from: "holder-a", createdAt: new Date().toISOString(), tabId: TAB, incarnation: INCARNATION, binding: null };
		const write = (name: string, body: unknown) => fs.writeFileSync(path.join(directory, name), typeof body === "string" ? body : JSON.stringify(body));
		write("holder-b.id-1.request", { ...base, id: "id-1", to: "holder-c" });
		write("holder-b.id-2.request", { ...base, id: "other-id", to: "holder-b" });
		write("holder-b.id-3.request", { ...base, id: "id-3", to: "holder-b", tabId: "" });
		write("holder-b.id-4.request", { ...base, id: "id-4", to: "holder-b", incarnation: "has space" });
		write("holder-b.id-5.request", { ...base, id: "id-5", to: "holder-b", binding: "bad binding" });
		write("holder-b.id-6.request", { ...base, id: "id-6", to: "holder-b", binding: 7 });
		write("holder-b.id-7.request", "x".repeat(64 * 1024));
		const { binding: _binding, ...withoutBinding } = base;
		write("holder-b.id-8.request", { ...withoutBinding, id: "id-8", to: "holder-b" });
		await until(() => files(".request").length === 0);
		assert.deepEqual(target.served, []);
		assert.deepEqual(files(".response"), []);
		assert.deepEqual(files(".accepted"), []);
	});

	it("never serves a handover older than its lifetime", async () => {
		let clock = Date.parse("2026-10-20T10:00:00.000Z");
		await postHandoverRequest(storage, { to: "holder-b", from: "holder-a", tabId: TAB, incarnation: INCARNATION, binding: null }, () => clock);
		clock += HANDOVER_REQUEST_TTL_MS + 1;
		const target = owner("holder-b", undefined, () => clock);
		await until(() => files(".request").length === 0);
		assert.deepEqual(target.served, []);
	});

	it("is taken up before it is answered: a working window is never reported as not having the request", async () => {
		const gate = Promise.withResolvers<void>();
		const target = owner("holder-b", async () => {
			await gate.promise;
			return MOVED;
		});
		const id = await post();
		// An accept bound far shorter than the work: the window took the request up, so the wait goes on.
		const pending = awaitHandoverAnswer(storage, "holder-b", id, { acceptTimeoutMs: 60, ...FAST });
		await until(() => target.served.length === 1);
		assert.deepEqual(files(".request"), [], "taken up: the request file is gone");
		assert.deepEqual(files(".accepted"), [`holder-b.${id}.accepted`]);
		await pause(150);
		gate.resolve();
		assert.deepEqual(await pending, { kind: "moved" });
		await until(() => fs.readdirSync(directory).length === 0);
	});

	it("cannot be withdrawn once taken up, and a withdrawn request is never served late", async () => {
		const gate = Promise.withResolvers<void>();
		const target = owner("holder-b", async (_request, context) => {
			await gate.promise;
			assert.equal(await context.stillWanted(), true, "a taken-up handover stays wanted");
			return MOVED;
		});
		const id = await post();
		await until(() => target.served.length === 1);
		gate.resolve();
		assert.deepEqual(await awaitHandoverAnswer(storage, "holder-b", id, FAST), { kind: "moved" });
		const asleep = await post("holder-asleep");
		assert.deepEqual(await awaitHandoverAnswer(storage, "holder-asleep", asleep, { acceptTimeoutMs: 60, ...FAST }), { kind: "unresponsive" });
		const late = owner("holder-asleep");
		await pause(150);
		assert.deepEqual(late.served, []);
	});

	for (const reason of ["not-holder", "busy", "terminal", "unfinished", "stale-build"] as const satisfies readonly RefusalReason[]) {
		it(`answers a refusal with its reason: ${reason}`, async () => {
			owner("holder-b", async () => ({ ok: false, focused: false, refusal: reason }));
			const id = await post();
			assert.deepEqual(await awaitHandoverAnswer(storage, "holder-b", id, FAST), { kind: "refused", reason });
		});
	}

	it("answers failed for an ok:false with no reason, which is also what a serve that threw becomes", async () => {
		const target = owner("holder-b", async () => { throw new Error("editor exploded"); });
		const id = await post();
		assert.deepEqual(await awaitHandoverAnswer(storage, "holder-b", id, FAST), { kind: "failed" });
		assert.ok(target.errors.some(detail => detail.includes("editor exploded")));
	});

	it("answers 'older build' at once, not after the bound, for a request a window deleted without answering", async () => {
		const id = await post("holder-old");
		const started = Date.now();
		const pending = awaitHandoverAnswer(storage, "holder-old", id, { acceptTimeoutMs: 5_000, ...FAST });
		// A window of a build that does not know the kind deletes the request and writes nothing.
		fs.rmSync(path.join(directory, `holder-old.${id}.request`));
		assert.deepEqual(await pending, { kind: "older-build" });
		assert.ok(Date.now() - started < 2_000, "did not wait for the accept bound");
	});

	it("answers 'unresponsive' for a window that never took the request up, withdrawing it", async () => {
		const id = await post("holder-asleep");
		assert.deepEqual(await awaitHandoverAnswer(storage, "holder-asleep", id, { acceptTimeoutMs: 80, ...FAST }), { kind: "unresponsive" });
		assert.deepEqual(files(".request"), [], "withdrawn");
	});

	it("is uncertain when a window took the request up and did not answer in time", async () => {
		const gate = Promise.withResolvers<void>();
		const target = owner("holder-b", async () => {
			await gate.promise;
			return MOVED;
		});
		const id = await post();
		await until(() => target.served.length === 1);
		const started = Date.now();
		assert.deepEqual(await awaitHandoverAnswer(storage, "holder-b", id, { acceptTimeoutMs: 30, totalTimeoutMs: 200, ...FAST }), { kind: "uncertain" });
		assert.ok(Date.now() - started >= 180, "a taken-up handover writes no progress, so only the total bound ends the wait");
		gate.resolve();
	});

	it("is uncertain, not 'nothing moved', when the window shuts down after taking the request up", async () => {
		const gate = Promise.withResolvers<void>();
		const target = owner("holder-b", async () => {
			await gate.promise;
			return MOVED;
		});
		const id = await post();
		await until(() => target.served.length === 1);
		target.watch.dispose();
		gate.resolve();
		assert.deepEqual(await awaitHandoverAnswer(storage, "holder-b", id, { totalTimeoutMs: 150, ...FAST }), { kind: "uncertain" });
	});

	it("is uncertain when this requester was not running between two looks and no evidence is left", async () => {
		const id = await post("holder-old");
		let clock = 1_000;
		const pending = awaitHandoverAnswer(storage, "holder-old", id, { acceptTimeoutMs: 5_000, stallGapMs: 1_000, now: () => clock, ...FAST });
		await pause(50);
		fs.rmSync(path.join(directory, `holder-old.${id}.request`));
		clock += 10_000;
		assert.deepEqual(await pending, { kind: "uncertain" });
	});

	it("does not take an uncorrelated, malformed or unknown-reason response for the answer, and says uncertain", async () => {
		fs.mkdirSync(directory, { recursive: true });
		const id = "id-forged";
		fs.writeFileSync(path.join(directory, `holder-b.${id}.accepted`), JSON.stringify({ version: 1, id, done: 0 }));
		const response = path.join(directory, `holder-b.${id}.response`);
		const pending = awaitHandoverAnswer(storage, "holder-b", id, { totalTimeoutMs: 500, ...FAST });
		const bad: unknown[] = [
			{ version: 1, id: "someone-elses", ok: true, focused: false },
			{ version: 1, id, ok: true, focused: false, refusal: "busy" },
			{ version: 1, id, ok: true, focused: false, refusal: "stale-build" },
			{ version: 1, id, ok: false, focused: false, refusal: "who-knows" },
			{ version: 2, id, ok: true, focused: false },
			{ version: 1, id, ok: "yes", focused: false },
			"x".repeat(64 * 1024),
		];
		for (const body of bad) {
			fs.writeFileSync(response, typeof body === "string" ? body : JSON.stringify(body));
			await pause(40);
		}
		assert.deepEqual(await pending, { kind: "uncertain" }, "none of those is an answer");
	});

	it("is read by the generic waiter of a select request as a plain refusal, and a reason on its answer never reads as stale-build", async () => {
		owner("holder-b", async () => ({ ok: false, focused: false, refusal: "busy" }));
		const id = await post();
		// A handover answer read through the select waiter is a refusal, not "stale-build".
		assert.equal(await awaitRequestAnswer(storage, "holder-b", id, { timeoutMs: 5_000, pollMs: 20 }), "refused");
	});

	it("still serves a select request without taking it up", async () => {
		const kinds: string[] = [];
		startWatch("holder-b", kinds);
		const id = await postSwitchRequest(storage, { to: "holder-b", from: "holder-a", tabId: TAB, incarnation: INCARNATION, binding: null });
		assert.equal(await awaitRequestAnswer(storage, "holder-b", id, { timeoutMs: 5_000, pollMs: 20 }), "served");
		assert.deepEqual(kinds, ["select"]);
		assert.deepEqual(files(".accepted"), [], "a select request is not taken up");
	});

	function startWatch(holderId: string, kinds: string[]): void {
		watches.push(startRequestWatch(storage, holderId, async request => {
			kinds.push(request.kind);
			return { ok: true, focused: true };
		}, { debounceMs: 20 }));
	}
});
