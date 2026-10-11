import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CLEAR_COMMAND, CLEAR_MARKER_TYPE, encodeClearCommand, type ClearArgs, type ClearMarkerData } from "../chat/clear.ts";
import { registerClearCommand, runClearCommand, type ClearCommandApi, type ClearCommandContext } from "./clear-command.ts";

const REQUEST = "00112233445566778899aabbccddeeff";
const refusal = (code: string) => ({ message: `omp-desk-clear:${code}` });

/** The session manager and reload OMP gives a command, reduced to what the command observes and writes. */
class FakeSession {
	idle = true;
	pending = false;
	mode = "rpc";
	jobs = 0;
	/** `false` models an OMP without the internal member. */
	hasBoundary = true;
	hasReload = true;
	reloadFails = false;
	readonly written: string[] = [];
	readonly appended: Array<{ customType: string; data: ClearMarkerData }> = [];
	readonly pendingClears = new Map<string, ClearMarkerData>();
	delivery = { queued: 0, delivering: false, pendingJobIds: [] as string[] };
	registryBusy: boolean | null = false;

	get context(): ClearCommandContext {
		return {
			mode: this.mode,
			sessionManager: {
				getSessionId: () => "s1",
				...(this.hasBoundary ? { appendResetBoundary: () => { this.written.push("reset_boundary"); return "b1"; } } : {}),
			},
			isIdle: () => this.idle,
			hasPendingMessages: () => this.pending,
			getAsyncJobSnapshot: () => ({ running: Array.from({ length: this.jobs }, () => ({})), delivery: this.delivery }),
			...(this.hasReload ? { reload: async () => { this.written.push("reload"); if (this.reloadFails) throw new Error("Session reload cancelled"); } } : {}),
		};
	}

	run(args: Partial<ClearArgs> = {}): Promise<ClearMarkerData> {
		const request: ClearArgs = { v: 1, requestId: REQUEST, sessionId: "s1", ...args };
		return runClearCommand(encodeClearCommand(request).slice(CLEAR_COMMAND.length + 2), this.context, (customType, data) => {
			this.written.push("marker");
			this.appended.push({ customType, data });
		}, this.pendingClears, () => this.registryBusy);
	}
}

describe("omp-desk-clear command", () => {
	it("writes and reloads without a marker; confirmation after host fresh appends the marker", async () => {
		const session = new FakeSession();
		const prepared = await session.run();
		assert.deepEqual(prepared, { v: 1, requestId: REQUEST, boundaryId: "b1" });
		assert.deepEqual(session.written, ["reset_boundary", "reload"]);
		assert.deepEqual(session.appended, []);
		const marker = await session.run({ phase: "confirm" });
		assert.deepEqual(session.written, ["reset_boundary", "reload", "marker"]);
		assert.deepEqual(session.appended, [{ customType: CLEAR_MARKER_TYPE, data: marker }]);
	});

	it("refuses missing, null, malformed or throwing work snapshots instead of assuming no jobs", async () => {
		for (const accessor of [undefined, () => null, () => ({ running: [] }), () => { throw new Error("unavailable"); }]) {
			const session = new FakeSession();
			const { getAsyncJobSnapshot: _snapshot, ...context } = session.context;
			const unsafe = { ...context, ...(accessor === undefined ? {} : { getAsyncJobSnapshot: accessor }) } as ClearCommandContext;
			await assert.rejects(runClearCommand(encodeClearCommand({ v: 1, requestId: REQUEST, sessionId: "s1" }).slice(CLEAR_COMMAND.length + 2), unsafe, () => {}, session.pendingClears, () => false), refusal("work-unavailable"));
			assert.deepEqual(session.written, []);
		}
	});

	it("rechecks work before confirming and leaves an unmarked boundary when delivery begins", async () => {
		const session = new FakeSession();
		await session.run();
		session.delivery.delivering = true;
		await assert.rejects(session.run({ phase: "confirm" }), refusal("jobs"));
		assert.deepEqual(session.written, ["reset_boundary", "reload"]);
		assert.deepEqual(session.appended, []);
	});

	it("fails closed: an OMP without appendResetBoundary or reload gets a refusal and nothing is written", async () => {
		for (const arrange of [(session: FakeSession) => { session.hasBoundary = false; }, (session: FakeSession) => { session.hasReload = false; }]) {
			const session = new FakeSession();
			arrange(session);
			await assert.rejects(session.run(), refusal("unsupported"));
			assert.deepEqual(session.written, []);
			assert.deepEqual(session.appended, []);
		}
	});

	it("refuses before anything is written: wrong mode, busy, queued input, running jobs, other session, malformed request", async () => {
		const cases: Array<[string, (session: FakeSession) => Partial<ClearArgs>]> = [
			["mode", session => { session.mode = "interactive"; return {}; }],
			["busy", session => { session.idle = false; return {}; }],
			["busy", session => { session.pending = true; return {}; }],
			["jobs", session => { session.jobs = 2; return {}; }],
			["jobs", session => { session.delivery.queued = 1; return {}; }],
			["jobs", session => { session.delivery.delivering = true; return {}; }],
			["jobs", session => { session.delivery.pendingJobIds = ["job"]; return {}; }],
			["jobs", session => { session.registryBusy = true; return {}; }],
			["work-unavailable", session => { session.registryBusy = null; return {}; }],
			["session", () => ({ sessionId: "other" })],
		];
		for (const [code, arrange] of cases) {
			const session = new FakeSession();
			await assert.rejects(session.run(arrange(session)), refusal(code), code);
			assert.deepEqual(session.written, [], code);
		}
		const session = new FakeSession();
		await assert.rejects(runClearCommand("{not json", session.context, () => {}, session.pendingClears, () => false), refusal("bad-request"));
		assert.deepEqual(session.written, []);
	});

	it("reports a failed reload after the boundary was written, without a retry and without a marker", async () => {
		const session = new FakeSession();
		session.reloadFails = true;
		await assert.rejects(session.run(), refusal("reload-failed"));
		assert.deepEqual(session.written, ["reset_boundary", "reload"], "one attempt; no second boundary, no marker");
	});
});

describe("registerClearCommand", () => {
	const fakePi = (withCommands = true) => {
		const handlers = new Map<string, Array<(event: unknown, ctx: { mode?: string }) => unknown>>();
		const commands: string[] = [];
		const pi: ClearCommandApi = {
			on: (event, handler) => { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
			...(withCommands ? { registerCommand: (name: string) => { commands.push(name); }, appendEntry: () => {} } : {}),
		};
		return { pi, commands, emit: (event: string, mode: string) => { for (const handler of handlers.get(event) ?? []) handler({}, { mode }); } };
	};

	it("registers once, only for an RPC-mode session", () => {
		const { pi, commands, emit } = fakePi();
		registerClearCommand(pi);
		emit("session_start", "interactive");
		assert.deepEqual(commands, []);
		emit("session_start", "rpc");
		emit("session_start", "rpc");
		assert.deepEqual(commands, [CLEAR_COMMAND]);
	});

	it("registers nothing on a pi without registerCommand or appendEntry", () => {
		const { pi, commands, emit } = fakePi(false);
		registerClearCommand(pi);
		emit("session_start", "rpc");
		assert.deepEqual(commands, []);
	});
});
