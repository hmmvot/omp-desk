/**
 * Kill All's request to another window (ADR-0060), against a real temporary directory: a stop request names
 * rows by exact identity and nothing else, reaches only the window it names, is taken up (claimed) before it is
 * answered so a requester can tell a window that never saw it from one that is working, reports progress,
 * answers per row, and is bounded in size and time.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import type { RowIdentity } from "./broker-processes.ts";
import {
	MAX_STOP_ROWS,
	STOP_ACCEPTED_SWEEP_MS,
	STOP_REQUEST_TTL_MS,
	WINDOW_REQUEST_DIRECTORY,
	askWindowToStop,
	awaitStopAnswer,
	postStopRequest,
	postSwitchRequest,
	requestTtlMs,
	startRequestWatch,
} from "./window-requests.ts";
import type { RequestWatch, ServeContext, ServeOutcome, StopRequest, StopRowAnswer, WindowRequest } from "./window-requests.ts";

const STOPPED: StopRowAnswer = { state: "stopped", reason: "" };

function identity(at: number, overrides: Partial<RowIdentity> = {}): RowIdentity {
	return {
		slot: `tab:${at}`,
		brokerId: `pty-00000000-0000-4000-8000-${String(at).padStart(12, "0")}`,
		generation: `gen-00000000-0000-4000-8000-${String(at).padStart(12, "0")}`,
		ptyKind: "managed-rpc",
		tabId: `conversation-${at}`,
		...overrides,
	};
}

describe("stop requests between windows", () => {
	let storage: string;
	let directory: string;
	const watches: RequestWatch[] = [];

	before(() => {
		storage = fs.mkdtempSync(path.join(os.tmpdir(), "omp-stop-requests-"));
		directory = path.join(storage, WINDOW_REQUEST_DIRECTORY);
	});

	afterEach(() => {
		for (const watch of watches.splice(0)) watch.dispose();
		fs.rmSync(directory, { recursive: true, force: true });
	});

	after(() => {
		fs.rmSync(storage, { recursive: true, force: true });
	});

	/** Serve as `holderId`; `answer` decides what the window answers per row. */
	function owner(
		holderId: string,
		answer: (request: StopRequest, context: ServeContext) => Promise<ServeOutcome> = async request => ({ ok: true, focused: false, rows: request.rows.map(() => STOPPED) }),
		now?: () => number,
	) {
		const served: StopRequest[] = [];
		const errors: string[] = [];
		const watch = startRequestWatch(storage, holderId, async (request: WindowRequest, context) => {
			assert.equal(request.kind, "stop");
			served.push(request as StopRequest);
			return await answer(request as StopRequest, context);
		}, { debounceMs: 20, onError: detail => errors.push(detail), ...(now === undefined ? {} : { now }) });
		watches.push(watch);
		return { served, errors, watch };
	}

	// These are integration tests of the real shared directory, its platform watcher and the bounds in milliseconds
	// that the protocol is made of; fake timers cannot drive a file watcher, so the waits are real and short.
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

	it("reaches only the window it names, carrying exactly the identities and nothing else, and answers per row in order", async () => {
		const target = owner("holder-b", async request => ({
			ok: true,
			focused: false,
			rows: request.rows.map((_row, at) => ({ state: at === 0 ? "stopped" : at === 1 ? "unconfirmed" : "refused", reason: at === 1 ? "it did not exit" : "" })),
		}));
		const bystander = owner("holder-c");
		const rows = [identity(1), identity(2), identity(3, { ptyKind: "folder-shell", tabId: null })];
		const id = await postStopRequest(storage, { to: "holder-b", from: "holder-a", rows });
		const answer = await awaitStopAnswer(storage, "holder-b", id, rows.length, FAST);
		assert.deepEqual(answer, {
			kind: "answered",
			rows: [{ state: "stopped", reason: "" }, { state: "unconfirmed", reason: "it did not exit" }, { state: "refused", reason: "" }],
		});
		assert.equal(target.served.length, 1);
		assert.deepEqual(target.served[0]?.rows, rows);
		assert.equal(target.served[0]?.from, "holder-a");
		await pause(100);
		assert.deepEqual(bystander.served, [], "a request addressed to another window is none of its business");
		assert.deepEqual(fs.readdirSync(directory), [], "the request, its accepted marker and its response are all cleaned up");
	});

	it("posts only what a window can validate: bounded, distinct, well-formed identities", async () => {
		const post = (rows: readonly RowIdentity[]) => postStopRequest(storage, { to: "holder-b", from: "holder-a", rows });
		await assert.rejects(post([]), TypeError);
		await assert.rejects(post(Array.from({ length: MAX_STOP_ROWS + 1 }, (_unused, at) => identity(at))), TypeError);
		await assert.rejects(post([identity(1), identity(1)]), TypeError, "the same broker twice");
		await assert.rejects(post([identity(1, { slot: "tab:1 && rm -rf" })]), TypeError);
		await assert.rejects(post([identity(1, { slot: "x".repeat(257) })]), TypeError);
		await assert.rejects(post([identity(1, { brokerId: "not a broker id!" })]), TypeError);
		await assert.rejects(post([identity(1, { ptyKind: "something-else" as never })]), TypeError);
		await assert.rejects(post([identity(1, { tabId: "" })]), TypeError);
		await assert.rejects(postStopRequest(storage, { to: "../escape", from: "holder-a", rows: [identity(1)] }), TypeError);
		await post(Array.from({ length: MAX_STOP_ROWS }, (_unused, at) => identity(at)));
	});

	it("ignores forged stop files: a name that disagrees with the body, a bad shape, a repeated row, an oversized body", async () => {
		const target = owner("holder-b");
		fs.mkdirSync(directory, { recursive: true });
		const base = { version: 1, kind: "stop", from: "holder-a", createdAt: new Date().toISOString(), rows: [identity(1)] };
		const write = (name: string, body: unknown) => fs.writeFileSync(path.join(directory, name), typeof body === "string" ? body : JSON.stringify(body));
		write("holder-b.id-1.request", { ...base, id: "id-1", to: "holder-c" });
		write("holder-b.id-2.request", { ...base, id: "other-id", to: "holder-b" });
		write("holder-b.id-3.request", { ...base, id: "id-3", to: "holder-b", rows: [] });
		write("holder-b.id-4.request", { ...base, id: "id-4", to: "holder-b", rows: [identity(1), identity(1)] });
		write("holder-b.id-5.request", { ...base, id: "id-5", to: "holder-b", rows: [{ slot: "tab:1" }] });
		write("holder-b.id-6.request", { ...base, id: "id-6", to: "holder-b", rows: [{ ...identity(1), pid: 4242, extra: "x" }, identity(2, { ptyKind: "nonsense" as never })] });
		write("holder-b.id-7.request", "x".repeat(64 * 1024));
		write("holder-b.id-8.request", { ...base, id: "id-8", to: "holder-b", rows: "all of them" });
		await until(() => files(".request").length === 0);
		assert.deepEqual(target.served, []);
		assert.deepEqual(files(".response"), []);
		assert.deepEqual(files(".accepted"), []);
	});

	it("never stops anything for a stop request older than its lifetime", async () => {
		let clock = Date.parse("2026-10-11T10:00:00.000Z");
		await postStopRequest(storage, { to: "holder-b", from: "holder-a", rows: [identity(1)] }, () => clock);
		clock += STOP_REQUEST_TTL_MS + 1;
		const target = owner("holder-b", undefined, () => clock);
		await until(() => files(".request").length === 0);
		assert.deepEqual(target.served, []);
		assert.equal(requestTtlMs({ kind: "stop" }), STOP_REQUEST_TTL_MS);
	});

	it("is taken up before it is answered: a working window shows progress and is never reported as not having the request", async () => {
		const gate = Promise.withResolvers<void>();
		const target = owner("holder-b", async (request, context) => {
			await context.progress(0);
			await gate.promise;
			await context.progress(1);
			return { ok: true, focused: false, rows: request.rows.map(() => STOPPED) };
		});
		const id = await postStopRequest(storage, { to: "holder-b", from: "holder-a", rows: [identity(1)] });
		// An accept bound far shorter than the work: the window took the request up, so the wait goes on.
		const pending = awaitStopAnswer(storage, "holder-b", id, 1, { acceptTimeoutMs: 60, progressTimeoutMs: 5_000, pollMs: 10 });
		await until(() => target.served.length === 1);
		assert.deepEqual(files(".request"), [], "taken up: the request file is gone");
		assert.deepEqual(files(".accepted"), [`holder-b.${id}.accepted`]);
		await pause(150);
		gate.resolve();
		assert.deepEqual(await pending, { kind: "answered", rows: [STOPPED] });
		await until(() => fs.readdirSync(directory).length === 0);
	});

	it("tells a window that never took the request up from one that is working: withdrawn at the bound, and a late window never acts", async () => {
		const id = await postStopRequest(storage, { to: "holder-asleep", from: "holder-a", rows: [identity(1)] });
		assert.deepEqual(await awaitStopAnswer(storage, "holder-asleep", id, 1, { acceptTimeoutMs: 80, ...FAST }), { kind: "not-accepted" });
		assert.deepEqual(files(".request"), [], "withdrawn");
		const late = owner("holder-asleep");
		await pause(150);
		assert.deepEqual(late.served, []);
	});

	it("answers 'not accepted' at once, not after the bound, for a request a window deleted without answering", async () => {
		const id = await postStopRequest(storage, { to: "holder-old", from: "holder-a", rows: [identity(1)] });
		const started = Date.now();
		const pending = awaitStopAnswer(storage, "holder-old", id, 1, { acceptTimeoutMs: 5_000, ...FAST });
		// A window of a build that does not know the kind deletes the request and writes nothing.
		fs.rmSync(path.join(directory, `holder-old.${id}.request`));
		assert.deepEqual(await pending, { kind: "not-accepted" });
		assert.ok(Date.now() - started < 2_000, "did not wait for the accept bound");
	});

	it("goes silent, not 'not accepted', when a window took the request up and then stopped reporting", async () => {
		const gate = Promise.withResolvers<void>();
		const target = owner("holder-b", async request => {
			await gate.promise;
			return { ok: true, focused: false, rows: request.rows.map(() => STOPPED) };
		});
		const id = await postStopRequest(storage, { to: "holder-b", from: "holder-a", rows: [identity(1)] });
		await until(() => target.served.length === 1);
		const answer = await awaitStopAnswer(storage, "holder-b", id, 1, { acceptTimeoutMs: 30, progressTimeoutMs: 120, ...FAST });
		assert.equal(answer.kind, "silent");
		gate.resolve();
	});

	it("keeps waiting while progress keeps changing, but not for ever", async () => {
		let stop = false;
		const target = owner("holder-b", async (request, context) => {
			for (let done = 0; !stop; done++) {
				await context.progress(done);
				await pause(40);
			}
			return { ok: true, focused: false, rows: request.rows.map(() => STOPPED) };
		});
		const id = await postStopRequest(storage, { to: "holder-b", from: "holder-a", rows: [identity(1)] });
		await until(() => target.served.length === 1);
		const started = Date.now();
		// Progress every 40 ms against an idle bound of 150 ms: not silent for 200 ms of steady work, silent at the total bound.
		const answer = await awaitStopAnswer(storage, "holder-b", id, 1, { progressTimeoutMs: 150, totalTimeoutMs: 300, ...FAST });
		assert.equal(answer.kind, "silent");
		assert.ok(Date.now() - started >= 280, "steady progress held the wait until the total bound");
		stop = true;
	});

	it("does not take an uncorrelated, malformed or oversized response for the answer", async () => {
		fs.mkdirSync(directory, { recursive: true });
		const id = "id-forged";
		fs.writeFileSync(path.join(directory, `holder-b.${id}.accepted`), JSON.stringify({ version: 1, id, done: 0 }));
		const response = path.join(directory, `holder-b.${id}.response`);
		const pending = awaitStopAnswer(storage, "holder-b", id, 2, { progressTimeoutMs: 600, ...FAST });
		const bad: unknown[] = [
			{ version: 1, id: "someone-elses", ok: true, focused: false, rows: [STOPPED, STOPPED] },
			{ version: 1, id, ok: true, focused: false, rows: [STOPPED] },
			{ version: 1, id, ok: true, focused: false, rows: [STOPPED, { state: "obliterated", reason: "" }] },
			{ version: 1, id, ok: true, focused: false, rows: [STOPPED, { state: "stopped", reason: "x".repeat(300) }] },
			"x".repeat(64 * 1024),
		];
		for (const body of bad) {
			fs.writeFileSync(response, typeof body === "string" ? body : JSON.stringify(body));
			await pause(40);
		}
		assert.equal((await pending).kind, "silent", "none of those is an answer");
	});

	it("reports a window whose serving failed as silent, never as having stopped anything", async () => {
		const target = owner("holder-b", async () => { throw new Error("editor exploded"); });
		const id = await postStopRequest(storage, { to: "holder-b", from: "holder-a", rows: [identity(1)] });
		assert.equal((await awaitStopAnswer(storage, "holder-b", id, 1, FAST)).kind, "silent");
		assert.ok(target.errors.some(detail => detail.includes("editor exploded")));
	});

	it("leaves a stop that was taken up unanswered when its window shuts down, so the requester sees silence", async () => {
		const gate = Promise.withResolvers<void>();
		const target = owner("holder-b", async request => {
			await gate.promise;
			return { ok: true, focused: false, rows: request.rows.map(() => STOPPED) };
		});
		const id = await postStopRequest(storage, { to: "holder-b", from: "holder-a", rows: [identity(1)] });
		await until(() => target.served.length === 1);
		target.watch.dispose();
		gate.resolve();
		assert.equal((await awaitStopAnswer(storage, "holder-b", id, 1, { progressTimeoutMs: 120, ...FAST })).kind, "silent");
	});

	it("asks a window about any number of rows in requests of at most the bound, and answers every row in order", async () => {
		const target = owner("holder-b", async request => ({
			ok: true,
			focused: false,
			rows: request.rows.map(row => ({ state: "stopped" as const, reason: row.slot })),
		}));
		const rows = Array.from({ length: MAX_STOP_ROWS * 2 + 6 }, (_unused, at) => identity(at));
		const answers = await askWindowToStop(storage, { to: "holder-b", from: "holder-a", rows }, FAST);
		assert.deepEqual(answers.map(answer => answer.reason), rows.map(row => row.slot));
		assert.deepEqual(target.served.map(request => request.rows.length), [MAX_STOP_ROWS, MAX_STOP_ROWS, 6]);
	});

	it("stops asking a window that went silent, answering the rows it was not asked 'silent' too", async () => {
		const target = owner("holder-b", async () => Promise.withResolvers<ServeOutcome>().promise);
		const rows = Array.from({ length: MAX_STOP_ROWS + 3 }, (_unused, at) => identity(at));
		const answers = await askWindowToStop(storage, { to: "holder-b", from: "holder-a", rows }, { progressTimeoutMs: 100, ...FAST });
		assert.equal(answers.length, rows.length);
		assert.ok(answers.every(answer => answer.state === "silent"));
		assert.equal(target.served.length, 1, "no second request to a window that has not answered the first");
	});

	it("answers 'not accepted' for every row of a window nobody is serving, after one wait", async () => {
		const rows = Array.from({ length: MAX_STOP_ROWS + 1 }, (_unused, at) => identity(at));
		const started = Date.now();
		const answers = await askWindowToStop(storage, { to: "holder-asleep", from: "holder-a", rows }, { acceptTimeoutMs: 100, ...FAST });
		assert.ok(answers.every(answer => answer.state === "not-accepted"));
		assert.equal(answers.length, rows.length);
		assert.ok(Date.now() - started < 1_000, "one accept wait, not one per request");
		assert.deepEqual(files(".request"), []);
	});

	it("answers 'not accepted' rather than throwing when the request cannot be posted", async () => {
		const answers = await askWindowToStop(storage, { to: "../escape", from: "holder-a", rows: [identity(1)] }, FAST);
		assert.deepEqual(answers.map(answer => answer.state), ["not-accepted"]);
		assert.match(answers[0]?.reason ?? "", /could not be posted/);
	});

	it("sweeps accepted and response files nobody finished", async () => {
		fs.mkdirSync(directory, { recursive: true });
		const old = ["holder-x.old-1.accepted", "holder-x.old-1.response"];
		for (const name of old) {
			const file = path.join(directory, name);
			fs.writeFileSync(file, "{}");
			const past = new Date(Date.now() - 3_600_000);
			fs.utimesSync(file, past, past);
		}
		await postStopRequest(storage, { to: "holder-y", from: "holder-a", rows: [identity(1)] });
		assert.deepEqual(files(".accepted"), []);
		assert.deepEqual(files(".response"), []);
	});

	it("ends a wait for a request that cannot be withdrawn as uncertain, never as 'not accepted', and never waits for ever", async () => {
		// A request file that cannot be deleted (here: a directory of that name, which unlink refuses) stays servable.
		fs.mkdirSync(path.join(directory, "holder-b.id-locked.request"), { recursive: true });
		const started = Date.now();
		const answer = await awaitStopAnswer(storage, "holder-b", "id-locked", 1, { acceptTimeoutMs: 30, withdrawTimeoutMs: 120, ...FAST });
		assert.equal(answer.kind, "silent");
		assert.match(answer.kind === "silent" ? answer.reason : "", /could not be withdrawn/);
		assert.ok(Date.now() - started < 3_000, "the pre-acceptance loop is bounded");
	});

	it("bounds the whole wait, before a window takes the request up as well as after", async () => {
		fs.mkdirSync(path.join(directory, "holder-b.id-locked.request"), { recursive: true });
		const started = Date.now();
		const answer = await awaitStopAnswer(storage, "holder-b", "id-locked", 1, { acceptTimeoutMs: 60_000, withdrawTimeoutMs: 60_000, totalTimeoutMs: 150, ...FAST });
		assert.equal(answer.kind, "silent");
		assert.ok(Date.now() - started < 3_000);
	});

	it("does not let another window's sweep erase the take-up evidence of a stop that is still active", async () => {
		const gate = Promise.withResolvers<void>();
		const target = owner("holder-b", async request => {
			await gate.promise;
			return { ok: true, focused: false, rows: request.rows.map(() => STOPPED) };
		});
		const id = await postStopRequest(storage, { to: "holder-b", from: "holder-a", rows: [identity(1)] });
		await until(() => target.served.length === 1);
		const accepted = path.join(directory, `holder-b.${id}.accepted`);
		// The owner has been working for ten minutes (far past the ordinary sweep, inside the stop's own lifetime).
		const past = new Date(Date.now() - 600_000);
		fs.utimesSync(accepted, past, past);
		// A third window posts any request: its sweep runs.
		await postSwitchRequest(storage, { to: "holder-z", from: "holder-c", tabId: "tab:1", incarnation: "1" });
		assert.ok(fs.existsSync(accepted), "the accepted marker survived the sweep");
		// A requester that only now looks (after being suspended) sees the take-up, so the window is working, not absent.
		let calls = 0;
		const delayed = await awaitStopAnswer(storage, "holder-b", id, 1, { progressTimeoutMs: 120, now: () => (calls++ === 0 ? Date.now() : Date.now() + 10_000), ...FAST });
		assert.equal(delayed.kind, "silent");
		assert.match(delayed.kind === "silent" ? delayed.reason : "", /took the request up/);
		gate.resolve();
		assert.ok(STOP_ACCEPTED_SWEEP_MS > 600_000, "take-up evidence outlives the requester's total wait");
	});

	it("does not read the absence of every file as 'never taken up' when the requester was not running meanwhile", async () => {
		// Nothing is left: the request is gone, there is no accepted marker and no response (swept while this requester was suspended).
		let calls = 0;
		const jumped = await awaitStopAnswer(storage, "holder-b", "id-vanished", 1, { now: () => (calls++ === 0 ? 0 : 10_000), ...FAST });
		assert.equal(jumped.kind, "silent");
		assert.match(jumped.kind === "silent" ? jumped.reason : "", /not known whether/);
		// A requester that kept watching proves a deletion without a trace: the old build case.
		assert.deepEqual(await awaitStopAnswer(storage, "holder-b", "id-vanished-2", 1, FAST), { kind: "not-accepted" });
	});
});
