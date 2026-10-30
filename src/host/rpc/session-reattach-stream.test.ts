/**
 * A reattach while OMP streams heavily (the incident where one Chat tab failed with `state-failed` every 30 s for forty minutes):
 * OMP answers a command in the order of its output, so the answer to the attach's `get_state` queues behind a flood it is still
 * producing and arrives long after the 30 s command deadline, while lines keep arriving on the connection. The attach must not
 * read that as a lost child: the read waits as long as lines arrive (up to a cap), the tab shows the conversation live but
 * read-only after a short grace, and everything that needs the session proven (send, Stop, tools) waits for the answer.
 *
 * Runner: `node --test src/host/rpc/session-reattach-stream.test.ts`.
 */
import assert from "node:assert/strict";
import { appendFile } from "node:fs/promises";
import { afterEach, describe, it } from "node:test";
import type { Logger } from "../../shared/logger.ts";
import { FakeRpcChannel, responseLine } from "./fake-channel.ts";
import { RpcSession, type RpcSessionOptions } from "./session.ts";
import { ManualTimers, ScratchDir, assistantMessage, messageEntry, sessionFileText, tick, userMessage, waitUntil } from "./test-support.ts";

const scratches: ScratchDir[] = [];
const sessions: RpcSession[] = [];
afterEach(async () => {
	for (const session of sessions.splice(0)) session.dispose();
	for (const scratch of scratches.splice(0)) await scratch.remove();
});

const u1 = messageEntry("u1", null, userMessage("hi", 1000));
const a1 = messageEntry("a1", "u1", assistantMessage("hello", 2000));
const a2 = messageEntry("a2", "a1", assistantMessage("written while the lines were gone", 3000));

class Lines implements Logger {
	readonly lines: string[] = [];
	error(message: string): void { this.lines.push(`error ${message}`); }
	warn(message: string): void { this.lines.push(`warn ${message}`); }
	info(message: string): void { this.lines.push(`info ${message}`); }
	debug(message: string): void { this.lines.push(`debug ${message}`); }
	trace(message: string): void { this.lines.push(`trace ${message}`); }
	has(pattern: RegExp): boolean { return this.lines.some(line => pattern.test(line)); }
	count(pattern: RegExp): number { return this.lines.filter(line => pattern.test(line)).length; }
}

interface Rig {
	channel: FakeRpcChannel;
	session: RpcSession;
	timers: ManualTimers;
	log: Lines;
	file: string;
	/** The id of the `get_state` OMP has not answered yet: its answer will carry it. */
	waiting: { id: string | null };
	/** OMP's late answer to the read that waited. */
	answerState: (patch?: Record<string, unknown>) => void;
}

async function boot(session: Partial<RpcSessionOptions> = {}): Promise<Rig> {
	const scratch = await ScratchDir.create();
	scratches.push(scratch);
	const file = await scratch.file("s.jsonl", sessionFileText({ id: "sess-1", entries: [u1, a1] }));
	const channel = new FakeRpcChannel({ sessionFile: file, entries: [u1, a1] as never, leafId: "a1" });
	const timers = new ManualTimers();
	const log = new Lines();
	const live = new RpcSession({ channel, sessionFile: file, cwd: "D:\\scratch", hostNonce: "host-a", timers, fileExists: async () => true, log, autoRecoveryDelaysMs: [], ...session });
	sessions.push(live);
	await live.start();
	await tick();
	assert.equal(live.phase, "live", "the first attach answers at once");
	const waiting: { id: string | null } = { id: null };
	return {
		channel, session: live, timers, log, file, waiting,
		answerState: (patch = {}) => {
			const id = waiting.id;
			assert.ok(id !== null, "a get_state is waiting");
			waiting.id = null;
			channel.emit(responseLine(id, "get_state", true, {
				data: { model: channel.child.model, thinkingLevel: "off", isStreaming: true, isCompacting: false, sessionFile: file, sessionId: "sess-1", queuedMessageCount: 0, messageCount: 2, isSettled: false, todoPhases: [], ...patch },
			}));
		},
	};
}

/** OMP's output is a flood: its answer to the next `get_state` is queued behind it and comes only when the test says so. */
function starveState(rig: Rig): void {
	rig.channel.handlers.set("get_state", command => {
		rig.waiting.id = String(command.id);
		return "drop";
	});
}

/** One streamed reply: `seconds` of `message_update` lines, one per `stepMs`, with the clock moving along. */
async function stream(rig: Rig, seconds: number, stepMs = 250): Promise<void> {
	const { channel, timers } = rig;
	for (let at = 0; at < seconds * 1000; at += stepMs) {
		channel.emitMessage("message_update", "m-flood", assistantMessage(`streamed ${at}`, 5000) as never);
		timers.advance(stepMs);
		await tick(2);
	}
}

async function dropLink(rig: Rig): Promise<void> {
	starveState(rig);
	rig.channel.emitMessage("message_start", "m-flood", assistantMessage("", 5000) as never);
	await tick();
	rig.channel.closeLink("disconnected", "the consumer fell behind the retained lines and must reattach");
	await waitUntil(() => rig.channel.attachRequests.length === 2);
	await tick();
}

describe("a reattach while OMP streams heavily", () => {
	it("waits for OMP's late answer instead of failing at the command deadline, and ends live once it comes", async () => {
		const rig = await boot({ resyncLiveAfterMs: 1_000_000 });
		await dropLink(rig);
		await stream(rig, 100);
		assert.equal(rig.session.phase, "resyncing", "100 s of lines, no answer yet: the child is not lost");
		assert.notEqual(rig.session.model.code, "state-failed");
		rig.answerState();
		await waitUntil(() => rig.session.phase === "live");
		assert.equal(rig.session.model.readOnlyReason, null);
		assert.equal(rig.log.has(/reattach failed/), false);
		assert.ok(rig.log.has(/reattach finished/));
	});

	it("shows the conversation live but read-only after a short grace, and refuses what needs the proof", async () => {
		const rig = await boot();
		await dropLink(rig);
		await stream(rig, 1.5);
		assert.equal(rig.session.phase, "resyncing", "an answer that is merely slow keeps the ordinary connecting state");
		await stream(rig, 2);
		assert.equal(rig.session.phase, "live");
		assert.match(rig.session.model.readOnlyReason ?? "", /confirm/i);
		assert.ok(rig.log.has(/has not answered get_state.*lines keep arriving/));
		const outcome = await rig.session.prompt({ requestId: "early-1", text: "too early" });
		assert.deepEqual(outcome, { status: "refused", reason: "not-live" });
		assert.deepEqual(rig.channel.commandsOfType("prompt"), [], "nothing reached OMP before it proved the session");
		const before = rig.channel.commandsOfType("get_state").length;
		await stream(rig, 100);
		assert.equal(rig.session.phase, "live", "still shown live 100 s on, with lines flowing");
		assert.equal(rig.session.model.code, null);
		assert.equal(rig.channel.commandsOfType("get_state").length, before, "the attach's read is the one that waits, no second read is sent");
		rig.answerState();
		await waitUntil(() => rig.session.model.readOnlyReason === null);
		assert.equal(rig.session.phase, "live");
		const accepted = await rig.session.prompt({ requestId: "after-1", text: "now" });
		assert.equal(accepted.status, "accepted");
	});

	it("reads a gap in the broker's ring from the session file before it shows the tab, and only once", async () => {
		const rig = await boot();
		rig.channel.truncatedAttach = true;
		await appendFile(rig.file, `${JSON.stringify(a2)}\n`);
		rig.channel.child.entries.push(a2 as never);
		rig.channel.child.leafId = "a2";
		await dropLink(rig);
		await stream(rig, 3);
		await waitUntil(() => rig.session.phase === "live");
		assert.equal(rig.session.phase, "live");
		assert.ok(rig.session.model.entries.some(entry => entry.id === "a2"), "the file's rows are in the transcript while the answer is still out");
		assert.equal(rig.log.count(/transcript was re-read from the session file/), 1);
		rig.answerState();
		await waitUntil(() => rig.session.model.readOnlyReason === null);
		assert.equal(rig.log.count(/transcript was re-read from the session file/), 1, "the answer does not read the gap again");
	});

	it("still fails a state that stays unanswered once the lines stop (a quiet link is a lost child)", async () => {
		const rig = await boot({ commandTimeoutMs: 10_000 });
		await dropLink(rig);
		await stream(rig, 5);
		assert.equal(rig.session.phase, "live");
		rig.timers.advance(10_000);
		await tick();
		assert.equal(rig.session.phase, "failed");
		assert.equal(rig.session.model.code, "state-failed");
		assert.equal(rig.session.nativeStateUnanswered, true, "a read nothing answered is still evidence for the page's Restart");
	});

	it("fails a state that stays unanswered however many lines arrive, once the cap is spent", async () => {
		const rig = await boot({ commandTimeoutMs: 10_000, starvedReadMs: 40_000, resyncLiveAfterMs: 1_000_000 });
		await dropLink(rig);
		await stream(rig, 39);
		assert.equal(rig.session.phase, "resyncing");
		await stream(rig, 12);
		assert.equal(rig.session.phase, "failed");
		assert.equal(rig.session.model.code, "state-failed");
	});

	it("retries the attach when the broker connection closes while the answer is out, not after the read's deadline", async () => {
		const rig = await boot();
		await dropLink(rig);
		await stream(rig, 3);
		assert.equal(rig.session.phase, "live");
		rig.channel.closeLink("disconnected", "the consumer fell behind the retained lines and must reattach");
		await tick();
		assert.equal(rig.session.phase, "attaching", "a tab on a dead link is not shown live");
		assert.notEqual(rig.session.model.code, "state-failed", "a closed link is not an unanswered read");
		rig.timers.advance(250);
		await waitUntil(() => rig.channel.attachRequests.length === 3);
		assert.equal(rig.log.has(/reattach failed/), false);
	});

	it("fails the tab when the late answer names another session file", async () => {
		const rig = await boot();
		await dropLink(rig);
		await stream(rig, 3);
		assert.equal(rig.session.phase, "live");
		rig.answerState({ sessionFile: "D:\\scratch\\other.jsonl", sessionId: "other" });
		await waitUntil(() => rig.session.phase === "failed");
		assert.equal(rig.session.model.code, "identity-diverged");
	});
});
