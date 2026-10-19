/** The Jobs row's pure view-model. Runner: `node --test src/chat/jobs-hud.test.ts`. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { JobRecord, JobsView } from "./background-jobs.ts";
import { HUD_ROW_LIMIT } from "./hud-summary.ts";
import { classifyJobsReply, isJobsKillReply, JOBS_BLOCKED_NO_COMMAND, JOBS_BLOCKED_NOT_WRITABLE, JOBS_NOTE, jobAgeMs, jobsCancelBlocked, jobsKillCommand, jobsSummary, jobsWindow, jobStateWord } from "./jobs-hud.ts";

function job(id: string, patch: Partial<JobRecord> = {}): JobRecord {
	return { id, type: "bash", label: "x", state: "running", startedAt: null, endedAt: null, durationMs: null, callId: "c", live: true, gone: false, ...patch };
}
function view(running: JobRecord[], patch: Partial<JobsView> = {}): JobsView {
	return { shown: true, pending: running.length > 0, running, byId: new Map(running.map(item => [item.id, item])), incomplete: false, ...patch };
}
const MINUTE = 60_000;

describe("jobsSummary", () => {
	it("names the count, the newest job and its age", () => {
		assert.deepEqual(jobsSummary(view([job("bg_1", { startedAt: 0 })]), 3 * MINUTE), { text: "1 background job · bash: x · 3m 00s", warn: false });
		assert.equal(jobsSummary(view([job("bg_2", { startedAt: 0 }), job("bg_1", { startedAt: 0 })]), 3 * MINUTE).text, "2 background jobs · bash: x · 3m 00s");
	});

	it("leaves the age out when it is unknown and shows only the id for an untyped job", () => {
		assert.equal(jobsSummary(view([job("bg_1", { type: null, label: "bg_1" })]), 5).text, "1 background job · bg_1");
	});

	it("says `at least` for an incomplete list, with the reason in the detail", () => {
		const incomplete = jobsSummary(view([job("bg_1")], { incomplete: true }), 0);
		assert.equal(incomplete.text, "at least 1 background job · bash: x");
		assert.match(incomplete.detail ?? "", /lower bound/);
		assert.equal(jobsSummary(view([job("a"), job("b")], { incomplete: true }), 0).text, "at least 2 background jobs · bash: x");
	});

	it("warns when OMP reports pending work no job names, and is quiet when nothing runs", () => {
		assert.deepEqual(jobsSummary(view([], { pending: true }), 0), { text: "Background work is pending · no job is named in this chat", detail: JOBS_NOTE, warn: true });
		assert.deepEqual(jobsSummary(view([], { pending: false }), 0), { text: "No background jobs running", warn: false });
	});
});

describe("jobsWindow", () => {
	const rows = (count: number): JobRecord[] => Array.from({ length: count }, (_, index) => job(`bg_${index}`));

	it("shows every row when they fit", () => {
		const fits = rows(3);
		assert.deepEqual(jobsWindow(fits, 20, 1), { rows: fits, hidden: 0 });
	});

	it("caps at the HUD row limit and spends a line on `+N more`", () => {
		const many = rows(HUD_ROW_LIMIT + 5);
		const window = jobsWindow(many, 50, 0);
		assert.equal(window.rows.length, HUD_ROW_LIMIT - 1);
		assert.equal(window.hidden, 6);
		assert.deepEqual(window.rows, many.slice(0, HUD_ROW_LIMIT - 1));
	});

	it("gives way to the note and feedback lines, but always shows at least one row", () => {
		const window = jobsWindow(rows(6), 6, 2);
		assert.equal(window.rows.length + 1, 4, "four lines: three rows and the +N more");
		assert.equal(window.hidden, 3);
		const tight = jobsWindow(rows(4), 1, 5);
		assert.deepEqual({ rows: tight.rows.length, hidden: tight.hidden }, { rows: 1, hidden: 3 });
		assert.deepEqual({ rows: jobsWindow(rows(1), 1, 5).rows.length, hidden: jobsWindow(rows(1), 1, 5).hidden }, { rows: 1, hidden: 0 });
	});
});

describe("classifyJobsReply", () => {
	it("reads the sentences of OMP's handleJobsKillCommand", () => {
		const kinds: [string, string][] = [
			["Cancelled background job bg_1.", "cancelled"],
			["Cancelled 3 background jobs.", "cancelled"],
			["No running background job with id \"bg_9\".", "gone"],
			["No running background jobs to cancel.", "gone"],
			["Could not cancel background job bg_1.", "failed"],
			["Async background jobs are unavailable in this session.", "failed"],
			["Usage: /jobs kill <id>|all", "unknown"],
		];
		for (const [reply, kind] of kinds) assert.equal(classifyJobsReply(reply).kind, kind, reply);
	});

	it("strips colour codes and whitespace, and never counts an unknown wording as a success", () => {
		assert.deepEqual(classifyJobsReply("\u001b[32mCancelled\u001b[0m  background\njob bg_1."), { kind: "cancelled", text: "Cancelled background job bg_1." });
		assert.equal(classifyJobsReply("Everything stopped.").kind, "unknown");
		assert.equal(classifyJobsReply("It was Cancelled").kind, "unknown");
		assert.equal(classifyJobsReply("x".repeat(500)).text.length, 300);
	});
});

describe("isJobsKillReply", () => {
	it("matches the sentences that name this id", () => {
		for (const reply of ["Cancelled background job bg_1.", "Could not cancel background job bg_1.", "No running background job with id \"bg_1\"."]) assert.equal(isJobsKillReply("bg_1", reply), true, reply);
		assert.equal(isJobsKillReply("bg_1", "\u001b[1mCancelled background job bg_1.\u001b[0m"), true, "colour codes are stripped");
	});

	it("rejects another id, the `all` sentences, and other commands' output", () => {
		for (const reply of ["Cancelled background job bg_2.", "Cancelled 1 background job.", "No running background jobs to cancel.", "Usage: /jobs kill <id>|all", "Slash command output", ""]) assert.equal(isJobsKillReply("bg_1", reply), false, reply);
		for (const reply of ["Cancelled background job bg_10.", "Could not cancel background job bg_1x.", "No running background job with id \"bg_10\"."]) assert.equal(isJobsKillReply("bg_1", reply), false, reply);
		for (const reply of ["Cancelled background job bg_1.", "No running background job with id \"bg_1\"."]) assert.equal(isJobsKillReply("bg_1", reply), true, reply);
	});

	it("matches the fixed sentences for `all` only", () => {
		for (const reply of ["Cancelled 2 background jobs.", "Cancelled 1 background job.", "No running background jobs to cancel."]) assert.equal(isJobsKillReply("all", reply), true, reply);
		for (const reply of ["Cancelled background job bg_1.", "No running background job with id \"all\"."]) assert.equal(isJobsKillReply("all", reply), false, reply);
	});

	it("takes the unavailable sentence as the answer to any target", () => {
		assert.equal(isJobsKillReply("bg_1", "Async background jobs are unavailable in this session."), true);
		assert.equal(isJobsKillReply("all", "Async background jobs are unavailable in this session."), true);
	});

	it("compares only the 50-character prefix of a long id, which OMP echoes up to 60", () => {
		const id = "a".repeat(80);
		assert.equal(isJobsKillReply(id, `Cancelled background job ${"a".repeat(60)}.`), true);
		assert.equal(isJobsKillReply(id, `Cancelled background job ${"a".repeat(49)}b.`), false);
		assert.equal(isJobsKillReply(id, `Cancelled background job ${"a".repeat(60)}`), true, "the prefix alone matches for an id past 50");
	});

	it("does not read regex characters of an id as a pattern", () => {
		assert.equal(isJobsKillReply("a.c", "Cancelled background job abc."), false);
		assert.equal(isJobsKillReply("a.c", "Cancelled background job a.c."), true);
	});
});

describe("jobsKillCommand", () => {
	it("is OMP's own command", () => {
		assert.equal(jobsKillCommand("bg_1"), "/jobs kill bg_1");
		assert.equal(jobsKillCommand("all"), "/jobs kill all");
	});
});

describe("jobsCancelBlocked", () => {
	const withKill = [{ name: "jobs", subcommands: [{ name: "full" }, { name: "kill" }] }];

	it("allows Cancel only when the session is writable and OMP lists /jobs kill", () => {
		assert.equal(jobsCancelBlocked(withKill as never, true), null);
		assert.equal(jobsCancelBlocked(withKill as never, false), JOBS_BLOCKED_NOT_WRITABLE);
		assert.equal(jobsCancelBlocked([], true), JOBS_BLOCKED_NO_COMMAND);
		assert.equal(jobsCancelBlocked([{ name: "jobs" }] as never, true), JOBS_BLOCKED_NO_COMMAND);
		assert.equal(jobsCancelBlocked([{ name: "jobs", subcommands: [{ name: "full" }] }] as never, true), JOBS_BLOCKED_NO_COMMAND);
		assert.equal(jobsCancelBlocked([{ name: "other", subcommands: [{ name: "kill" }] }] as never, true), JOBS_BLOCKED_NO_COMMAND);
	});
});

describe("jobStateWord", () => {
	it("says done for completed, ended for a job nothing says how it ended", () => {
		assert.equal(jobStateWord({ state: "running", gone: false }), "running");
		assert.equal(jobStateWord({ state: "completed", gone: false }), "done");
		assert.equal(jobStateWord({ state: "failed", gone: false }), "failed");
		assert.equal(jobStateWord({ state: "cancelled", gone: false }), "cancelled");
		assert.equal(jobStateWord({ state: "completed", gone: true }), "ended");
	});
});

describe("jobAgeMs", () => {
	it("is the time since the start for a running job, null when the start is unknown, never negative", () => {
		assert.equal(jobAgeMs(job("a", { startedAt: 1_000 }), 4_000), 3_000);
		assert.equal(jobAgeMs(job("a"), 4_000), null);
		assert.equal(jobAgeMs(job("a", { startedAt: 5_000 }), 4_000), 0);
	});

	it("is the reported duration for an ended job, else end minus start, else null", () => {
		assert.equal(jobAgeMs(job("a", { state: "completed", durationMs: 700, startedAt: 0, endedAt: 9_000 }), 99_000), 700);
		assert.equal(jobAgeMs(job("a", { state: "failed", startedAt: 1_000, endedAt: 3_000 }), 99_000), 2_000);
		assert.equal(jobAgeMs(job("a", { state: "failed" }), 99_000), null);
	});
});
