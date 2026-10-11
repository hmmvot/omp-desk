import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DebugCoordinator, OperationCancelledError } from "./coordinator.ts";
import { FakeDebugApi } from "./fake-debug-api.ts";
import { sleep } from "./test-harness.ts";

function make(setup?: (api: FakeDebugApi) => void, limits = { transitionTimeoutMs: 60, requestTimeoutMs: 60 }): { api: FakeDebugApi; coordinator: DebugCoordinator } {
	const api = new FakeDebugApi();
	setup?.(api);
	return { api, coordinator: new DebugCoordinator(api, { limits }) };
}

describe("DebugCoordinator registry", () => {
	it("tracks sessions that start after activation and lists a pre-activation active session as untracked", () => {
		const { api, coordinator } = make(a => { a.addPreexisting({ id: "old" }); });
		api.startSession({ id: "new" });
		const old = coordinator.session("old")!;
		assert.equal(old.tracked, false);
		assert.equal(old.state.kind, "unknown");
		assert.equal(coordinator.session("new")!.tracked, true);
		assert.equal(coordinator.session("new")!.origin, "user");
		coordinator.dispose();
	});

	it("learns of an untracked session through the active-session event", () => {
		const { api, coordinator } = make();
		api.addPreexisting({ id: "late-seen" });
		assert.equal(coordinator.session("late-seen"), undefined);
		api.setActive("late-seen");
		assert.equal(coordinator.session("late-seen")!.tracked, false);
		coordinator.dispose();
	});

	it("marks a session terminated on the terminate event and drops terminated records when the registry is full", () => {
		const api = new FakeDebugApi();
		const coordinator = new DebugCoordinator(api, { limits: { maxSessions: 2 } });
		api.startSession({ id: "a" });
		api.endSession("a");
		assert.equal(coordinator.session("a")!.state.kind, "terminated");
		api.startSession({ id: "b" });
		api.startSession({ id: "c" });
		assert.equal(coordinator.session("a"), undefined);
		assert.ok(coordinator.session("b") && coordinator.session("c"));
		coordinator.dispose();
	});
});

describe("DebugCoordinator state machine", () => {
	it("advances the generation on stopped, continued and terminated events", () => {
		const { api, coordinator } = make();
		api.startSession({ id: "s" });
		const g0 = coordinator.session("s")!.generation;
		api.stop("s");
		const g1 = coordinator.session("s")!.generation;
		api.adapterEvent("s", "continued", { threadId: 1 });
		const g2 = coordinator.session("s")!.generation;
		api.adapterEvent("s", "terminated");
		const g3 = coordinator.session("s")!.generation;
		assert.ok(g0 < g1 && g1 < g2 && g2 < g3);
		assert.equal(coordinator.session("s")!.state.kind, "terminated");
		coordinator.dispose();
	});

	it("observes a user's continue through the tracker: transitioning, then running on the successful response", () => {
		const { api, coordinator } = make();
		api.startSession({ id: "s" });
		api.stop("s");
		api.editorRequest("s", { type: "request", seq: 5, command: "continue", arguments: { threadId: 1 } });
		assert.equal(coordinator.session("s")!.state.kind, "transitioning");
		api.adapterResponse("s", { type: "response", seq: 6, request_seq: 5, command: "continue", success: true });
		assert.equal(coordinator.session("s")!.state.kind, "running");
		coordinator.dispose();
	});

	it("a failed user step restores the stopped state with a newer generation", () => {
		const { api, coordinator } = make();
		api.startSession({ id: "s" });
		api.stop("s");
		const before = coordinator.session("s")!.generation;
		api.editorRequest("s", { type: "request", seq: 5, command: "next", arguments: { threadId: 1 } });
		api.adapterResponse("s", { type: "response", seq: 6, request_seq: 5, command: "next", success: false, message: "busy" });
		const after = coordinator.session("s")!;
		assert.equal(after.state.kind, "stopped");
		assert.ok(after.generation > before);
		coordinator.dispose();
	});

	it("an adapter error leaves the state unknown until the next event", () => {
		const { api, coordinator } = make();
		api.startSession({ id: "s" });
		api.trackers.get("s")!.error!(new Error("pipe closed"));
		assert.equal(coordinator.session("s")!.state.kind, "unknown");
		api.stop("s");
		assert.equal(coordinator.session("s")!.state.kind, "stopped");
		coordinator.dispose();
	});

	it("keeps adapter breakpoint events and capabilities seen by the tracker", () => {
		const { api, coordinator } = make();
		api.startSession({ id: "s" });
		api.adapterEvent("s", "breakpoint", { reason: "changed", breakpoint: { verified: true, line: 4, source: { path: "C:\\a.js" } } });
		assert.deepEqual(coordinator.trackerBreakpoint("s", "C:\\A.js", 4), { verified: true });
		assert.equal(coordinator.capabilities("s").supportsLogPoints, true);
		coordinator.dispose();
	});
});

describe("DebugCoordinator mutate queue", () => {
	it("runs actions of one key strictly one after another and others in parallel", async () => {
		const { coordinator } = make();
		const log: string[] = [];
		const signal = new AbortController().signal;
		const slow = (name: string, ms: number) => async () => {
			log.push(`start ${name}`);
			await sleep(ms);
			log.push(`end ${name}`);
		};
		await Promise.all([
			coordinator.mutate("s1", signal, slow("a", 30)),
			coordinator.mutate("s1", signal, slow("b", 5)),
			coordinator.mutate("s2", signal, slow("c", 5)),
		]);
		assert.ok(log.indexOf("end a") < log.indexOf("start b"));
		assert.ok(log.indexOf("start c") < log.indexOf("end a"));
		coordinator.dispose();
	});

	it("does not run an action whose call was cancelled while queued, and keeps the queue moving", async () => {
		const { coordinator } = make();
		const abort = new AbortController();
		let ran = false;
		const first = coordinator.mutate("s", new AbortController().signal, () => sleep(30));
		const second = coordinator.mutate("s", abort.signal, async () => { ran = true; });
		abort.abort();
		await first;
		await assert.rejects(second, OperationCancelledError);
		assert.equal(ran, false);
		assert.equal(await coordinator.mutate("s", new AbortController().signal, async () => "ok"), "ok");
		coordinator.dispose();
	});
});
