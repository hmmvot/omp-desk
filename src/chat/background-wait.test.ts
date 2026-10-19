/**
 * What the working row says while only background work keeps the turn open. Jobs are read from the transcript because
 * OMP reports background work over RPC as one boolean. Runner: `node --test src/chat/background-wait.test.ts`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { scanJobs } from "./background-jobs.ts";
import { backgroundWaitOf } from "./background-wait.ts";
import type { ChatEntry, ChatMessage } from "./messages.ts";
import { applyChatEntries, applyChatLiteState, applyChatSnapshot, applyChatUiRequest, chatTurnInProgress, createChatModel, reduceChatFrame, snapshotOf, type ChatModel } from "./model.ts";
import { assistantMessage, messageEntry, toolResultMessage, userMessage } from "../host/rpc/test-support.ts";

const EPOCH = { nonce: "n", counter: 1 };

function toolCalls(timestamp: number, ...calls: { id: string; args: Record<string, unknown> }[]): ChatMessage {
	return { ...assistantMessage("", timestamp), stopReason: "toolUse", completedAt: timestamp + 5, content: calls.map(call => ({ type: "toolCall" as const, id: call.id, name: "bash", arguments: call.args })) } as ChatMessage;
}
const started = (id: string, timestamp: number, jobId: string): ChatMessage => toolResultMessage(id, timestamp, "bash", { async: { state: "running", jobId, type: "bash" } });
const delivered = (timestamp: number, ...jobIds: string[]): ChatEntry => ({
	type: "custom_message", id: `done-${jobIds.join("-")}`, parentId: null, timestamp: new Date(timestamp).toISOString(), customType: "async-result", display: true, content: "result",
	details: { jobs: jobIds.map(jobId => ({ jobId, type: "bash" })) },
});

function chain(...messages: (ChatMessage | ChatEntry)[]): ChatEntry[] {
	let parent: string | null = null;
	return messages.map((item, index) => {
		const entry: ChatEntry = "type" in item ? { ...item, parentId: parent } : messageEntry(`e${index}`, parent, item);
		parent = entry.id;
		return entry;
	});
}

/** A live session whose agent ended but OMP still reports background work. */
function paused(entries: ChatEntry[]): ChatModel {
	let model = applyChatSnapshot(createChatModel(), { ...snapshotOf(createChatModel(), EPOCH), phase: "live", header: { id: "s", cwd: "c", timestamp: "" } }, { now: 1 });
	model = applyChatEntries(model, entries, entries.at(-1)?.id ?? null);
	model = reduceChatFrame(model, { type: "agent_start" }, { now: 10 });
	return reduceChatFrame(model, { type: "agent_end", isTerminal: false, awaitingAsyncWork: true, outcome: "stop" }, { now: 20 });
}

const PUSH = { id: "call-push", args: { i: "Хвост лога push.", command: "git push origin main 2>&1 | tee push.log" } };

describe("background wait", () => {
	it("names the single pending job from the call's intent and times the wait from the agent's last activity", () => {
		const model = paused(chain(userMessage("push it", 1_000), toolCalls(2_000, PUSH), started("call-push", 2_100, "job-1"), assistantMessage("Pushing in the background.", 3_000)));
		const wait = backgroundWaitOf(model);
		assert.equal(chatTurnInProgress(model), true, "the turn is still open");
		assert.equal(wait?.text, "Waiting for background job: Хвост лога push");
		assert.equal(wait?.since, 3_000, "since the agent's last message, not since the turn started");
		assert.deepEqual(wait?.jobs.map(job => ({ id: job.id, label: job.label })), [{ id: "job-1", label: "Хвост лога push" }]);
	});

	it("falls back to the command, then to the job id, when the call has no intent", () => {
		const bare = chain(toolCalls(2_000, { id: "c1", args: { command: "npm test\nnpm run lint" } }), started("c1", 2_100, "job-1"));
		assert.equal(scanJobs(bare)[0]?.label, "npm test", "first line of the command");
		const orphan = chain(started("unseen-call", 2_100, "job-9"));
		assert.equal(scanJobs(orphan)[0]?.label, "job-9");
	});

	it("counts several jobs and drops each one as its result is delivered", () => {
		const two = chain(toolCalls(2_000, PUSH, { id: "call-test", args: { i: "Run tests", command: "npm test" } }), started("call-push", 2_100, "job-1"), started("call-test", 2_200, "job-2"), assistantMessage("Both started.", 3_000));
		assert.equal(backgroundWaitOf(paused(two))?.text, "Waiting for 2 background jobs");
		const oneDone = [...two, ...chain(delivered(4_000, "job-2")).map(entry => ({ ...entry, parentId: two.at(-1)!.id }))];
		assert.equal(backgroundWaitOf(paused(oneDone))?.text, "Waiting for background job: Хвост лога push");
	});

	it("reads a poll's listing: a running job counts with its label, a finished or cancelled one does not", () => {
		const listed = (status: string): ChatMessage => toolResultMessage("poll", 5_000, "job", { jobs: [{ id: "job-1", type: "bash", status, label: "git push" }] });
		assert.equal(backgroundWaitOf(paused(chain(listed("running"))))?.text, "Waiting for background job: git push");
		for (const status of ["completed", "failed", "cancelled"]) assert.equal(backgroundWaitOf(paused(chain(started("c1", 2_000, "job-1"), listed(status))))?.text, "Waiting for background work", status);
	});

	it("says it is waiting for background work when no job can be named, with no time when nothing is known", () => {
		const wait = backgroundWaitOf(paused([]));
		assert.equal(wait?.text, "Waiting for background work");
		assert.equal(wait?.since, null);
	});

	it("applies only while nothing but background work keeps the turn open", () => {
		const entries = chain(toolCalls(2_000, PUSH), started("call-push", 2_100, "job-1"), assistantMessage("Done for now.", 3_000));
		const base = paused(entries);
		assert.ok(backgroundWaitOf(base));
		assert.equal(backgroundWaitOf(reduceChatFrame(base, { type: "agent_start" }, { now: 30 })), null, "the agent works again");
		assert.equal(backgroundWaitOf(applyChatUiRequest(base, { id: "ask", method: "confirm", title: "Continue?", message: "" })), null, "a dialog is open");
		assert.equal(backgroundWaitOf({ ...base, phase: "resyncing" }), null, "the connection is not live");
		assert.equal(backgroundWaitOf({ ...base, maintenance: { action: "compact", status: "working" } }), null, "the context is being compacted");
		assert.equal(backgroundWaitOf({ ...base, stream: assistantMessage("typing", 4_000) as never }), null, "a reply streams");
		assert.equal(backgroundWaitOf({ ...base, asyncPaused: false }), null, "OMP reports nothing pending");
	});

	it("follows OMP's own pending flag: a state read ends the wait, a new agent turn leaves it", () => {
		const base = paused(chain(toolCalls(2_000, PUSH), started("call-push", 2_100, "job-1")));
		const idle = applyChatLiteState(base, { model: null, thinkingLevel: null, isStreaming: false, isCompacting: false, queuedMessageCount: 0, hasPendingAsyncWork: false, isSettled: true }, null, { now: 40 });
		assert.equal(backgroundWaitOf(idle), null);
		const stillPending = applyChatLiteState(base, { model: null, thinkingLevel: null, isStreaming: false, isCompacting: false, queuedMessageCount: 0, hasPendingAsyncWork: true, isSettled: false }, null, { now: 40 });
		assert.equal(backgroundWaitOf(stillPending)?.text, "Waiting for background job: Хвост лога push");
	});
});
