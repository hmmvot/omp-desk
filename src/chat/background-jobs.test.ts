/** What the transcript and the live frames say of OMP's background jobs. Runner: `node --test src/chat/background-jobs.test.ts`. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { jobFrameOf, jobsViewOf, MAX_JOB_FRAMES, parseJobFrames, sameJobsView, scanJobs, withJobFrame, type JobFrame, type JobsSource } from "./background-jobs.ts";
import type { ChatEntry, ChatMessage } from "./messages.ts";
import { assistantMessage, messageEntry, toolResultMessage } from "../host/rpc/test-support.ts";

function toolCalls(timestamp: number, ...calls: { id: string; args: Record<string, unknown>; intent?: string }[]): ChatMessage {
	return { ...assistantMessage("", timestamp), stopReason: "toolUse", completedAt: timestamp + 5, content: calls.map(call => ({ type: "toolCall" as const, id: call.id, name: "bash", arguments: call.args, ...(call.intent === undefined ? {} : { intent: call.intent }) })) } as ChatMessage;
}
const started = (callId: string, timestamp: number, jobId: string, type = "bash", state = "running"): ChatMessage => toolResultMessage(callId, timestamp, "bash", { async: { state, jobId, type } });
const polled = (timestamp: number, ...rows: Record<string, unknown>[]): ChatMessage => toolResultMessage(`poll-${timestamp}`, timestamp, "job", { jobs: rows });
const delivered = (timestamp: number, ...jobIds: string[]): ChatEntry => ({
	type: "custom_message", id: `done-${timestamp}`, parentId: null, timestamp: new Date(timestamp).toISOString(), customType: "async-result", display: true, content: "result",
	details: { jobs: jobIds.map(jobId => ({ jobId, type: "bash" })) },
});

function chain(...messages: (ChatMessage | ChatEntry)[]): ChatEntry[] {
	let parent: string | null = null;
	return messages.map((item, index) => {
		const entry: ChatEntry = "type" in item ? { ...item, id: `${item.id}-${index}`, parentId: parent } : messageEntry(`e${index}`, parent, item);
		parent = entry.id;
		return entry;
	});
}
const only = (entries: ChatEntry[], frames?: ReadonlyMap<string, JobFrame>, gone?: Map<string, string | null>) => {
	const jobs = scanJobs(entries, frames, gone);
	assert.equal(jobs.length, 1);
	return jobs[0]!;
};

describe("scanJobs", () => {
	it("reads a start result: type, call, start time, running, not live", () => {
		const job = only(chain(toolCalls(1_000, { id: "c1", args: { command: "npm run dev" } }), started("c1", 1_100, "bg_1")));
		assert.deepEqual(job, { id: "bg_1", type: "bash", label: "npm run dev", state: "running", startedAt: 1_100, endedAt: null, durationMs: null, callId: "c1", live: false, gone: false });
	});

	it("labels from the call's intent argument, then the call intent, then the first command line, then the id", () => {
		const label = (call: { args: Record<string, unknown>; intent?: string }): string => only(chain(toolCalls(1_000, { id: "c1", ...call }), started("c1", 1_100, "bg_1"))).label;
		assert.equal(label({ args: { i: "Watch the build.", command: "x" }, intent: "other" }), "Watch the build");
		assert.equal(label({ args: { command: "x" }, intent: "Tail the log" }), "Tail the log");
		assert.equal(label({ args: { command: "\n  npm   test \nnpm run lint" } }), "npm test");
		assert.equal(only(chain(started("unseen", 1_100, "bg_1"))).label, "bg_1");
	});

	it("reads a poll: running rows give the start from their duration, finished rows settle with it", () => {
		const running = only(chain(polled(10_000, { id: "bg_1", type: "bash", status: "running", label: "serve", durationMs: 4_000 })));
		assert.equal(running.state, "running");
		assert.equal(running.startedAt, 6_000);
		assert.equal(running.label, "serve");
		const done = only(chain(started("c1", 1_000, "bg_1"), polled(10_000, { id: "bg_1", status: "failed", durationMs: 3_000 })));
		assert.equal(done.state, "failed");
		assert.equal(done.durationMs, 3_000);
		assert.equal(done.endedAt, 10_000);
	});

	it("reads cancel rows from details.cancelled and details.proc.cancelled; other statuses say nothing", () => {
		const cancelled = (details: unknown): ChatMessage => toolResultMessage("k", 5_000, "job", details);
		assert.equal(only(chain(started("c1", 1_000, "bg_1"), cancelled({ cancelled: [{ id: "bg_1", status: "cancelled" }] }))).state, "cancelled");
		const viaProc = only(chain(started("c1", 1_000, "bg_1"), cancelled({ proc: { cancelled: [{ id: "bg_1", status: "cancelled" }] } })));
		assert.equal(viaProc.state, "cancelled");
		assert.equal(viaProc.durationMs, 4_000, "from the start to the cancel");
		for (const status of ["already_completed", "not_found"]) assert.equal(only(chain(started("c1", 1_000, "bg_1"), cancelled({ cancelled: [{ id: "bg_1", status }] }))).state, "running", status);
	});

	it("ends a job when its result is delivered, even without a status row", () => {
		const job = only(chain(started("c1", 1_000, "bg_1"), delivered(4_000, "bg_1")));
		assert.equal(job.state, "completed");
		assert.equal(job.endedAt, 4_000);
	});

	it("never reopens a settled job: a later running poll or start of the same call is ignored", () => {
		const job = only(chain(started("c1", 1_000, "bg_1"), delivered(4_000, "bg_1"), polled(5_000, { id: "bg_1", status: "running" }), started("c1", 6_000, "bg_1")));
		assert.equal(job.state, "completed");
		assert.equal(job.endedAt, 4_000);
	});

	it("lets the latest start win when an id is reused by another call", () => {
		const entries = chain(toolCalls(1_000, { id: "c1", args: { command: "old" } }), started("c1", 1_100, "bg_1"), delivered(2_000, "bg_1"),
			toolCalls(3_000, { id: "c2", args: { command: "new" } }), started("c2", 3_100, "bg_1"));
		const job = only(entries);
		assert.equal(job.callId, "c2");
		assert.equal(job.label, "new");
		assert.equal(job.state, "running");
		assert.equal(job.startedAt, 3_100);
	});

	it("lets a live frame of another call replace the transcript record, and marks a frame's job live", () => {
		const entries = chain(toolCalls(1_000, { id: "c1", args: { command: "old" } }), started("c1", 1_100, "bg_1"));
		const replaced = only(entries, new Map([["bg_1", { state: "running", type: "bash", callId: "c9", at: 9_000 }]]));
		assert.deepEqual({ callId: replaced.callId, live: replaced.live, startedAt: replaced.startedAt, label: replaced.label }, { callId: "c9", live: true, startedAt: 9_000, label: "bg_1" });
		const same = only(entries, new Map([["bg_1", { state: "running", type: "bash", callId: "c1", at: 9_000 }]]));
		assert.deepEqual({ callId: same.callId, live: same.live, startedAt: same.startedAt, label: same.label }, { callId: "c1", live: true, startedAt: 1_100, label: "old" });
		assert.equal(only(entries).live, false);
	});

	it("settles a job from its frame when the transcript has no row, with the duration since its start", () => {
		const entries = chain(started("c1", 1_000, "bg_1"));
		const job = only(entries, new Map([["bg_1", { state: "completed", type: "bash", callId: "c1", at: 5_000 }]]));
		assert.equal(job.state, "completed");
		assert.equal(job.durationMs, 4_000);
		assert.equal(only([], new Map([["bg_7", { state: "running", type: "eval", callId: "c7", at: 2_000 }]])).type, "eval");
	});

	it("turns a running job into completed+gone only for the call the page was told about", () => {
		const entries = chain(started("c1", 1_000, "bg_1"));
		const gone = only(entries, undefined, new Map([["bg_1", "c1"]]));
		assert.deepEqual({ state: gone.state, gone: gone.gone }, { state: "completed", gone: true });
		const later = only(entries, undefined, new Map([["bg_1", "other-call"]]));
		assert.deepEqual({ state: later.state, gone: later.gone }, { state: "running", gone: false });
		const settled = only(chain(started("c1", 1_000, "bg_1"), delivered(2_000, "bg_1")), undefined, new Map([["bg_1", "c1"]]));
		assert.equal(settled.gone, false, "a job that ended in the transcript is not 'gone'");
	});
});

describe("scanJobs: id reuse across OMP processes", () => {
	it("does not let a start of a new call inherit the settled state of an old call's rows with no start in the window", () => {
		const old = [polled(1_000, { id: "bg_1", type: "bash", status: "completed", durationMs: 10 }), delivered(1_500, "bg_1")];
		const job = only(chain(...old, toolCalls(3_000, { id: "c2", args: { command: "new" } }), started("c2", 3_100, "bg_1")));
		assert.deepEqual({ state: job.state, callId: job.callId, label: job.label, startedAt: job.startedAt, endedAt: job.endedAt, durationMs: job.durationMs }, { state: "running", callId: "c2", label: "new", startedAt: 3_100, endedAt: null, durationMs: null });
	});

	it("lets a live frame of a call replace a transcript record that names no call", () => {
		const entries = chain(polled(1_000, { id: "bg_1", type: "bash", status: "completed", durationMs: 10 }));
		const job = only(entries, new Map([["bg_1", { state: "running", type: "bash", callId: "c9", at: 9_000 }]]));
		assert.deepEqual({ state: job.state, callId: job.callId, live: job.live, startedAt: job.startedAt }, { state: "running", callId: "c9", live: true, startedAt: 9_000 });
	});
});

describe("scanJobs: task jobs", () => {
	const task = (state: string): ReadonlyMap<string, JobFrame> => new Map([["bg_1", { state: state as JobFrame["state"], type: "task", callId: "c1", at: 9_000 }]]);
	const entries = chain(started("c1", 1_000, "bg_1", "task"));

	it("marks the primary live on a running start or frame, and a running frame ends nothing", () => {
		const job = only(entries, task("running"));
		assert.deepEqual({ type: job.type, state: job.state, live: job.live }, { type: "task", state: "running", live: true });
		assert.equal(only([], task("running")).live, true);
	});

	it("settles the primary on an aggregate terminal frame", () => {
		assert.equal(only(entries, task("completed")).state, "completed");
		assert.equal(only(entries, task("failed")).state, "failed");
	});
});

describe("jobFrameOf", () => {
	it("reads details.async with a job id and a state, and nothing else", () => {
		assert.deepEqual(jobFrameOf({ details: { async: { jobId: "bg_1", state: "running", type: "task" } } }), { id: "bg_1", state: "running", type: "task" });
		assert.equal(jobFrameOf({ details: { async: { jobId: "bg_1", state: "running", type: "weird" } } })?.type, null);
		for (const bad of [undefined, null, "x", {}, { details: {} }, { details: { async: { state: "running" } } }, { details: { async: { jobId: "bg_1", state: "paused" } } }, { details: { async: { jobId: "", state: "running" } } }]) assert.equal(jobFrameOf(bad), null);
	});
});

describe("withJobFrame", () => {
	const frame = (state: JobFrame["state"], callId = "c1", at = 1): JobFrame => ({ state, type: "bash", callId, at });

	it("returns the same map when the frame says nothing new, a new one when the state changes", () => {
		const first = withJobFrame(new Map(), "bg_1", frame("running"));
		assert.equal(withJobFrame(first, "bg_1", frame("running", "c1", 99)), first);
		const settled = withJobFrame(first, "bg_1", frame("completed"));
		assert.notEqual(settled, first);
		assert.equal(settled.get("bg_1")?.state, "completed");
	});

	it("keeps a settled job settled for its own call, and replaces it for a different call", () => {
		const settled = withJobFrame(new Map(), "bg_1", frame("failed"));
		assert.equal(withJobFrame(settled, "bg_1", frame("running")).get("bg_1")?.state, "failed");
		const reused = withJobFrame(settled, "bg_1", frame("running", "c2", 5));
		assert.deepEqual(reused.get("bg_1"), frame("running", "c2", 5));
	});

	it("drops the oldest frames past the cap", () => {
		let frames: ReadonlyMap<string, JobFrame> = new Map();
		for (let index = 0; index <= MAX_JOB_FRAMES; index += 1) frames = withJobFrame(frames, `bg_${index}`, frame("running", `c${index}`));
		assert.equal(frames.size, MAX_JOB_FRAMES);
		assert.equal(frames.has("bg_0"), false);
		assert.equal(frames.has(`bg_${MAX_JOB_FRAMES}`), true);
	});
});

describe("parseJobFrames", () => {
	const row = { id: "bg_1", state: "running", type: "bash", callId: "c1", at: 5 };

	it("accepts absent as none and valid rows (type may be null)", () => {
		assert.deepEqual(parseJobFrames(undefined), []);
		assert.deepEqual(parseJobFrames([row, { ...row, id: "bg_2", type: null }]), [row, { ...row, id: "bg_2", type: null }]);
	});

	it("refuses the whole list when one row is malformed", () => {
		for (const bad of [null, "x", {}, [row, 1], [{ ...row, state: "paused" }], [{ ...row, id: "" }], [{ ...row, at: -1 }], [{ ...row, at: "1" }], [{ ...row, callId: "" }], [{ ...row, type: "weird" }], [{ ...row, type: undefined }], Array.from({ length: MAX_JOB_FRAMES + 1 }, () => row)]) {
			assert.equal(parseJobFrames(bad), null, JSON.stringify(bad)?.slice(0, 60));
		}
	});
});

function source(entries: ChatEntry[], patch: Partial<JobsSource> = {}): JobsSource {
	return { phase: "live", asyncPaused: false, settled: false, state: null, entries, olderCount: 0, activeTools: new Map(), jobFrames: new Map(), ...patch };
}

describe("jobsViewOf", () => {
	const two = chain(started("c1", 1_000, "bg_1"), started("c2", 2_000, "bg_2"));

	it("lists running jobs newest first and every job by id", () => {
		const view = jobsViewOf(source(chain(started("c1", 1_000, "bg_1"), started("c2", 2_000, "bg_2"), delivered(3_000, "bg_1"))));
		assert.deepEqual(view.running.map(job => job.id), ["bg_2"]);
		assert.deepEqual([...view.byId.keys()], ["bg_1", "bg_2"]);
		assert.equal(jobsViewOf(source(two)).running[0]?.id, "bg_2");
	});

	it("is shown while OMP reports pending work, or a job runs and the session is not settled, and only when live", () => {
		assert.equal(jobsViewOf(source(two)).shown, true);
		assert.equal(jobsViewOf(source(two, { settled: true })).shown, false, "unsettled running is the rule; a settled session with no pending flag hides it");
		assert.equal(jobsViewOf(source([], { asyncPaused: true })).shown, true);
		assert.equal(jobsViewOf(source([], { state: { hasPendingAsyncWork: true }, settled: true })).shown, true);
		assert.equal(jobsViewOf(source([])).shown, false);
		assert.equal(jobsViewOf(source(two, { phase: "resyncing" })).shown, false);
		assert.equal(jobsViewOf(source([], { asyncPaused: true })).pending, true);
	});

	it("is incomplete only when older history is unloaded", () => {
		assert.equal(jobsViewOf(source(two)).incomplete, false);
		assert.equal(jobsViewOf(source(two, { olderCount: 3 })).incomplete, true);
		assert.equal(jobsViewOf(source(chain(started("c1", 1_000, "bg_1", "task")))).incomplete, false, "an agent is the Agents row's, not an unknown job");
	});

	it("leaves a running agent (a task job) to the Agents row, and shows no row when the pending work may be the agent alone", () => {
		const agent = chain(started("c1", 1_000, "bg_1", "task"));
		const alone = jobsViewOf(source(agent, { state: { hasPendingAsyncWork: true } }));
		assert.deepEqual(alone.running, []);
		assert.equal(alone.agentsRunning, true);
		assert.equal(alone.shown, false);
		assert.equal(alone.byId.get("bg_1")?.type, "task", "the agent's card still reads its job");
		const mixed = jobsViewOf(source(chain(started("c1", 1_000, "bg_1", "task"), started("c2", 2_000, "bg_2")), { state: { hasPendingAsyncWork: true } }));
		assert.deepEqual(mixed.running.map(job => job.id), ["bg_2"]);
		assert.equal(mixed.shown, true);
		assert.equal(jobsViewOf(source(chain(started("c1", 1_000, "bg_1", "task"), delivered(2_000, "bg_1")), { state: { hasPendingAsyncWork: true } })).shown, true, "with the agent ended, unnamed pending work is shown again");
	});

	it("shows no row for pending work no job names while any tool call of the turn is still executing, and the warning once nothing is", () => {
		const pending = { state: { hasPendingAsyncWork: true } };
		const settledJobs = chain(started("c1", 1_000, "bg_1"), started("c2", 2_000, "bg_2"), delivered(3_000, "bg_1", "bg_2"));
		for (const toolName of ["eval", "bash", "task"]) {
			const view = jobsViewOf(source(settledJobs, { ...pending, activeTools: new Map([["c9", { toolName }]]) }));
			assert.equal(view.toolsRunning, true, toolName);
			assert.equal(view.shown, false, `${toolName} running, its job not named yet`);
		}
		const quiet = jobsViewOf(source(settledJobs, pending));
		assert.equal(quiet.toolsRunning, false);
		assert.equal(quiet.shown, true, "nothing executes: the warning");
		assert.equal(jobsViewOf(source(settledJobs, { asyncPaused: true, activeTools: new Map([["c9", {}]]) })).shown, false, "a paused turn counts as pending too");
		assert.equal(jobsViewOf(source(two, { ...pending, activeTools: new Map([["c9", { toolName: "eval" }]]) })).shown, true, "a named running job is shown whatever else runs");
	});

	it("reads the gone map", () => {
		const view = jobsViewOf(source(two), new Map([["bg_1", "c1"]]));
		assert.deepEqual(view.running.map(job => job.id), ["bg_2"]);
		assert.equal(view.byId.get("bg_1")?.gone, true);
	});
});

describe("sameJobsView", () => {
	const entries = chain(started("c1", 1_000, "bg_1"), started("c2", 2_000, "bg_2"));

	it("holds for separately computed equal views and fails when a job, flag or order changes", () => {
		const view = jobsViewOf(source(entries));
		assert.equal(sameJobsView(view, jobsViewOf(source([...entries]))), true);
		assert.equal(sameJobsView(view, jobsViewOf(source(entries, { asyncPaused: true }))), false, "pending flag");
		assert.equal(sameJobsView(view, jobsViewOf(source(entries, { olderCount: 1 }))), false, "incomplete");
		assert.equal(sameJobsView(view, jobsViewOf(source(chain(started("c1", 1_000, "bg_1"), started("c2", 2_000, "bg_2"), delivered(3_000, "bg_2"))))), false, "a job ended");
		assert.equal(sameJobsView(view, jobsViewOf(source(entries), new Map([["bg_2", "c2"]]))), false, "a job is gone");
		assert.equal(sameJobsView(view, jobsViewOf(source(entries, { jobFrames: new Map([["bg_1", { state: "running", type: "bash", callId: "c1", at: 1 }]]) }))), false, "a job became live");
	});
});

describe("transcript scan cache", () => {
	it("scans one entries array once however often frames change, and rescans a new array", () => {
		const entries = chain(started("c1", 1_000, "bg_1"));
		let passes = 0;
		const iterate = entries[Symbol.iterator].bind(entries);
		entries[Symbol.iterator] = () => {
			passes += 1;
			return iterate();
		};
		scanJobs(entries);
		for (let at = 1; at <= 5; at += 1) scanJobs(entries, new Map([["bg_1", { state: "running", type: "bash", callId: "c1", at }]]));
		jobsViewOf(source(entries));
		assert.equal(passes, 1);
		const copy = [...entries];
		scanJobs(copy);
		assert.equal(scanJobs(copy).length, 1);
	});

	it("never lets a caller's change to a returned record leak into the next result", () => {
		const entries = chain(started("c1", 1_000, "bg_1"));
		scanJobs(entries)[0]!.state = "failed";
		assert.equal(scanJobs(entries)[0]?.state, "running");
	});
});
