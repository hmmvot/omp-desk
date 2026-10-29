/**
 * What the host does when the broker link stalls or the broker closes it (the incident where a long Chat showed no replies):
 * every close and reattach is logged with its reason, a silent link is measured, probed and shown to the page, a prompt
 * whose answer never came is looked up in the session file instead of being re-sent, and a reattach after a close by the
 * broker reads only what came after its cursor, never the whole transcript.
 *
 * Runner: `node --test src/host/rpc/session-stall.test.ts`.
 */
import assert from "node:assert/strict";
import { appendFile } from "node:fs/promises";
import { afterEach, describe, it } from "node:test";
import type { Logger } from "../../shared/logger.ts";
import { toChatEventFrame } from "../../protocol/rpc.ts";
import { FakeRpcChannel } from "./fake-channel.ts";
import { RpcSession, type RpcSessionOptions, type RpcSessionOutput } from "./session.ts";
import { ManualTimers, ScratchDir, assistantMessage, jsonl, messageEntry, sessionFileText, tick, userMessage, waitUntil } from "./test-support.ts";

const scratches: ScratchDir[] = [];
const sessions: RpcSession[] = [];
afterEach(async () => {
	for (const session of sessions.splice(0)) session.dispose();
	for (const scratch of scratches.splice(0)) await scratch.remove();
});

const u1 = messageEntry("u1", null, userMessage("hi", 1000));
const a1 = messageEntry("a1", "u1", assistantMessage("hello", 2000));

class Lines implements Logger {
	readonly lines: string[] = [];
	error(message: string): void { this.lines.push(`error ${message}`); }
	warn(message: string): void { this.lines.push(`warn ${message}`); }
	info(message: string): void { this.lines.push(`info ${message}`); }
	debug(message: string): void { this.lines.push(`debug ${message}`); }
	trace(message: string): void { this.lines.push(`trace ${message}`); }
	has(pattern: RegExp): boolean { return this.lines.some(line => pattern.test(line)); }
}

interface Rig {
	channel: FakeRpcChannel;
	session: RpcSession;
	timers: ManualTimers;
	outputs: RpcSessionOutput[];
	log: Lines;
	file: string;
}

async function boot(options: { session?: Partial<RpcSessionOptions>; setup?: (channel: FakeRpcChannel) => void } = {}): Promise<Rig> {
	const scratch = await ScratchDir.create();
	scratches.push(scratch);
	const file = await scratch.file("s.jsonl", sessionFileText({ id: "sess-1", entries: [u1, a1] }));
	const channel = new FakeRpcChannel({ sessionFile: file, entries: [u1, a1] as never, leafId: "a1" });
	options.setup?.(channel);
	const timers = new ManualTimers();
	const log = new Lines();
	const session = new RpcSession({ channel, sessionFile: file, cwd: "D:\\scratch", hostNonce: "host-a", timers, fileExists: async () => true, log, ...options.session });
	sessions.push(session);
	const outputs: RpcSessionOutput[] = [];
	session.subscribe(output => outputs.push(output));
	await session.start();
	await tick();
	return { channel, session, timers, outputs, log, file };
}

describe("a close by the broker", () => {
	it("is logged with its reason, and the reattach that follows with its start, outcome and what the broker closed", async () => {
		const { channel, session, log } = await boot();
		const seqBefore = session.lastSeq;
		channel.forcedClose = { reason: "fell-behind", ageMs: 1_500 };
		channel.closeLink("disconnected", "the consumer fell behind the retained lines and must reattach");
		await waitUntil(() => log.has(/reattach finished/));
		assert.ok(log.has(/info the broker connection closed: the consumer fell behind the retained lines and must reattach; last seq \d+/));
		assert.ok(log.has(new RegExp(`info reattach started: last seq ${seqBefore} \\(the broker connection ended on its own\\)`)));
		assert.ok(log.has(/info reattach finished in \d+ ms after 1 attempt: last seq \d+ to \d+, \d+ lines received, phase live/));
		assert.ok(log.has(/info reattached: .*the broker \(any window\) closed a consumer as fallen behind its retained lines 2 s earlier/));
		assert.equal(session.phase, "live");
	});

	it("says when it was this window that replaced the connection, by the typed flag and not by its words", async () => {
		const { channel, log } = await boot();
		channel.closeLink("disconnected", "detached by the client", true);
		await tick();
		assert.ok(log.has(/the broker connection closed: detached by the client \(this window replaced it\)/));
		const other = await boot();
		other.channel.closeLink("disconnected", "detached by the client");
		await tick();
		assert.equal(other.log.has(/this window replaced it/), false, "words alone say nothing");
	});

	it("names a paced close as one whose socket did not drain", async () => {
		const { channel, log } = await boot();
		channel.forcedClose = { reason: "paced", ageMs: 200 };
		channel.closeLink("disconnected", "the consumer's socket did not drain for 10 s and must reattach");
		await waitUntil(() => log.has(/reattached:/));
		assert.ok(log.has(/closed a consumer as paced \(its socket did not drain\)/));
	});
});

describe("the stall monitor", () => {
	it("logs a command that waits while the link delivers nothing, then the frames coming back", async () => {
		const { channel, session, timers, log } = await boot();
		channel.autoRespond = false;
		void session.prompt({ requestId: "wait-1", text: "waits" });
		await tick();
		timers.advance(6_000);
		await tick();
		assert.ok(log.has(/info the link has delivered nothing for \d+ ms while prompt waits for its answer \(\d+ ms\); last seq \d+/));
		assert.equal(channel.linkProbes.length, 1, "the broker is asked once");
		channel.emit({ type: "agent_start" });
		assert.ok(log.has(/info frames resumed after \d+ ms without one/));
	});

	it("tells the page the link is stalled while a command is unanswered, and clears it when frames resume", async () => {
		const { channel, session, timers, outputs } = await boot();
		channel.linkProbe = "hang";
		channel.autoRespond = false;
		const outcome = session.prompt({ requestId: "slow-1", text: "wait for me" });
		await tick();
		timers.advance(8_000);
		await tick();
		assert.equal(session.model.linkStalled, true);
		assert.equal(session.snapshot().linkStalled, true);
		channel.emit({ type: "agent_start" });
		assert.equal(session.model.linkStalled, false);
		const stalls = outputs.flatMap(output => (output.type === "event" && output.frame.type === "link_stalled" ? [output.frame.stalled] : []));
		assert.deepEqual(stalls, [true, false], "the page was told, then told it was over");
		channel.autoRespond = true;
		session.dispose();
		await outcome;
	});

	it("does not tell the page when the broker answers a status request: the stall is OMP holding the command", async () => {
		const { channel, session, timers, log } = await boot();
		channel.linkProbe = 3;
		channel.autoRespond = false;
		void session.prompt({ requestId: "busy-1", text: "omp is busy" });
		await tick();
		timers.advance(9_000);
		await tick();
		assert.equal(channel.linkProbes.length, 1, "one probe per stall");
		assert.ok(log.has(/info the broker answered a status request in 3 ms: the link carries traffic, so the stall is OMP holding the command/));
		assert.equal(session.model.linkStalled, false);
	});

	it("tells the page and warns when the broker does not answer a status request", async () => {
		const { channel, session, timers, log } = await boot();
		channel.linkProbe = null;
		channel.autoRespond = false;
		void session.prompt({ requestId: "dead-1", text: "no link" });
		await tick();
		timers.advance(6_000);
		await tick();
		assert.ok(log.has(/warn the broker did not answer a status request within \d+ ms: the broker or the link is stalled/));
		assert.equal(session.model.linkStalled, true);
	});

	it("does not call a link stalled while frames arrive, however long a command waits behind them", async () => {
		const { channel, session, timers, log } = await boot();
		channel.autoRespond = false;
		void session.prompt({ requestId: "behind-1", text: "queued behind frames" });
		await tick();
		for (let second = 0; second < 8; second += 1) {
			channel.emit({ type: "agent_start" });
			timers.advance(1_000);
		}
		assert.equal(session.model.linkStalled, false);
		assert.ok(log.has(/the answer to prompt has not come for \d+ ms, but frames are still arriving/));
		assert.equal(log.has(/has delivered nothing/), false);
	});

	it("does not wait on a maintenance command that legitimately takes long", async () => {
		const { channel, session, timers } = await boot();
		channel.autoRespond = false;
		void session.prompt({ requestId: "slash-1", text: "/compact" });
		await tick();
		timers.advance(8_000);
		await tick();
		assert.equal(session.model.linkStalled, false);
	});

	it("never replaces the connection for a starved command, however long the broker stays unanswered, and writes the stall line once", async () => {
		const { channel, session, timers, log } = await boot({ session: { probeTimeoutMs: 2_000 } });
		channel.linkProbe = "hang";
		const attaches = channel.attachRequests.length;
		channel.autoRespond = false;
		void session.prompt({ requestId: "probe-1", text: "waits" });
		await tick();
		timers.advance(25_000);
		await tick();
		assert.equal(channel.attachRequests.length, attaches, "an unanswered probe is not a reason to replace the connection");
		assert.equal(log.lines.filter(line => /the link has delivered nothing/.test(line)).length, 1, "one stall line per stall");
		assert.equal(log.has(/but frames are still arriving/), false, "the stall is not reported as candidate 1");
	});

	it("reports a working session that says nothing once, without probing or telling the page, and not at all while a dialog is open", async () => {
		const { channel, session, timers, log } = await boot();
		channel.emit({ type: "agent_start" });
		await tick();
		const probes = channel.linkProbes.length;
		timers.advance(30_000);
		await tick();
		assert.equal(log.lines.filter(line => /OMP is working but has sent nothing/.test(line)).length, 1, "one line per silence");
		assert.equal(channel.linkProbes.length, probes, "no probe for a quiet session");
		assert.equal(session.model.linkStalled, false);
		const dialog = await boot();
		dialog.channel.emit({ type: "agent_start" });
		dialog.channel.emit({ type: "extension_ui_request", id: "d1", method: "select", title: "Approve?", options: ["Yes", "No"] });
		await tick();
		dialog.timers.advance(60_000);
		await tick();
		assert.equal(dialog.log.has(/OMP is working but has sent nothing/), false);
	});
});

describe("a prompt whose answer did not come", () => {
	it("is delivered when the session file holds its message: no re-send, and the transcript shows it", async () => {
		const { channel, session, timers, file, outputs } = await boot({ session: { commandTimeoutMs: 2_000, stallAfterMs: 1_000 } });
		channel.autoRespond = false;
		const outcome = session.prompt({ requestId: "p-file", text: "please continue" });
		await tick();
		const when = timers.now() + 10;
		await appendFile(file, `${JSON.stringify(messageEntry("u2", "a1", userMessage("please continue", when)))}\n`);
		timers.advance(2_500);
		assert.deepEqual(await outcome, { status: "accepted", agentInvoked: null });
		await tick();
		assert.equal(outputs.some(output => output.type === "prompt-lost" && output.requestId === "p-file"), false);
		assert.ok(session.model.entries.some(entry => entry.id === "u2"), "the row comes from the file");
	});

	it("stays unconfirmed when the file does not hold it", async () => {
		const { channel, session, timers } = await boot({ session: { commandTimeoutMs: 2_000 } });
		channel.autoRespond = false;
		const outcome = session.prompt({ requestId: "p-none", text: "never written" });
		await tick();
		timers.advance(2_500);
		assert.deepEqual(await outcome, { status: "unconfirmed" });
	});

	it("ignores an older message with the same text", async () => {
		const { channel, session, timers } = await boot({ session: { commandTimeoutMs: 2_000 } });
		channel.autoRespond = false;
		const outcome = session.prompt({ requestId: "p-old", text: "hi" });
		await tick();
		timers.advance(2_500);
		assert.deepEqual(await outcome, { status: "unconfirmed" }, "u1 says \"hi\" but long before this send");
	});

	it("keeps reading the file while the link stays stalled, so the reply shows without the stream", async () => {
		const { channel, session, timers, file } = await boot({ session: { commandTimeoutMs: 6_000 } });
		channel.autoRespond = false;
		const outcome = session.prompt({ requestId: "p-follow", text: "answer me" });
		await tick();
		const when = timers.now() + 10;
		await appendFile(file, `${JSON.stringify(messageEntry("u2", "a1", userMessage("answer me", when)))}\n`);
		timers.advance(5_500);
		await tick();
		timers.advance(1_000);
		assert.deepEqual(await outcome, { status: "accepted", agentInvoked: null });
		await appendFile(file, `${JSON.stringify(messageEntry("a2", "u2", assistantMessage("here is the reply", when + 3_000)))}\n`);
		timers.advance(2_100);
		await waitUntil(() => session.model.entries.some(entry => entry.id === "a2"));
	});
});

describe("a reattach after the broker closed the consumer", () => {
	const fullReads = (channel: FakeRpcChannel): number => channel.commandsOfType("get_entries").filter(command => command.since === undefined).length;

	it("reads only what came after its cursor, never the whole transcript, however large the session file is", async () => {
		const { channel, session, log } = await boot({ session: { largeSessionBytes: 1 } });
		const reads = fullReads(channel);
		channel.forcedClose = { reason: "paced", ageMs: 100 };
		channel.closeLink("disconnected", "the peer closed the connection");
		await waitUntil(() => log.has(/reattach finished/));
		assert.equal(fullReads(channel), reads, "no full read of the transcript");
		assert.equal(session.phase, "live");
		assert.deepEqual(session.model.entries.map(entry => entry.id), ["u1", "a1"]);
	});

	it("says when the broker's lines in between are gone", async () => {
		const { channel, log } = await boot();
		channel.truncatedAttach = true;
		channel.closeLink("disconnected", "the peer closed the connection");
		await waitUntil(() => log.has(/reattach finished/));
		assert.ok(log.has(/the lines in between are gone/));
	});

	it("reports the link's traffic in the close line when the channel measures it", async () => {
		const { channel, log } = await boot();
		channel.trafficReading = { frames: 311, chars: 3_400_000, chunks: 40, busyMs: 220, maxChunkMs: 40, maxFrameMs: 9, lastFrameAt: Date.now(), socketBytesRead: 3_500_000, readableBytes: 0, pendingBytes: 0 };
		channel.closeLink("disconnected", "the peer closed the connection");
		await waitUntil(() => log.has(/reattach finished/));
		assert.ok(log.has(/the broker connection closed: the peer closed the connection; .*read 311 frames in 40 reads/));
	});
});

describe("a reattach whose attach never gets an answer", () => {
	/** One reattach attempt's whole life on the manual clock: it waits out the attach deadline, then the backoff. */
	const settings = { attachTimeoutMs: 1_000, reattachDelaysMs: [10, 10], autoRecoveryDelaysMs: [] as number[] };

	it("abandons the attempt at the attach deadline, says so with its reason, tries again and goes live", async () => {
		const { channel, session, timers, log } = await boot({ session: settings });
		channel.forcedClose = { reason: "paced", ageMs: 100 };
		channel.attachHangs = 1;
		channel.closeLink("disconnected", "the peer closed the connection");
		await waitUntil(() => channel.attachRequests.length === 2);
		assert.equal(session.phase, "attaching", "the tab shows that it is connecting while the attempt waits");
		timers.advance(1_000);
		await waitUntil(() => log.has(/reattach attempt 1 failed after 1000 ms \(the broker did not complete the attach within 1000 ms\); trying again in 10 ms/));
		timers.advance(10);
		await waitUntil(() => log.has(/reattach finished in \d+ ms after 2 attempts/));
		assert.equal(session.phase, "live");
		assert.ok(log.has(/info reattached:/), "the attach that finally answered is logged as before");
	});

	it("ends in the failed state with its reason in the log, so the tab offers Reconnect, and Reconnect recovers", async () => {
		const { channel, session, timers, log } = await boot({ session: settings });
		channel.attachHangs = 99;
		channel.closeLink("disconnected", "the peer closed the connection");
		for (let round = 0; round < 3; round += 1) {
			await waitUntil(() => channel.attachRequests.length === round + 2);
			timers.advance(1_000);
			await tick();
			timers.advance(10);
		}
		await waitUntil(() => session.phase === "failed");
		assert.equal(session.model.code, "attach-failed");
		assert.ok(log.has(/warn reattach failed after \d+ ms and 3 attempts: attach-failed \(the broker did not complete the attach within 1000 ms\)/));
		channel.attachHangs = 0;
		assert.equal(session.reconnect(), "started");
		await waitUntil(() => session.phase === "live");
		assert.equal(session.phase, "live");
	});

	it("gives up when its budget is spent, before the attempt list is", async () => {
		const { channel, session, timers, log } = await boot({ session: { ...settings, reattachBudgetMs: 1_500, reattachDelaysMs: [10, 10, 10, 10, 10] } });
		channel.attachHangs = 99;
		channel.closeLink("disconnected", "the peer closed the connection");
		for (let round = 0; round < 2; round += 1) {
			await waitUntil(() => channel.attachRequests.length === round + 2);
			timers.advance(1_000);
			await tick();
			timers.advance(10);
		}
		await waitUntil(() => session.phase === "failed");
		assert.ok(log.has(/warn reattach failed after 2\d{3} ms and 2 attempts: attach-failed/), "two attempts and no third: the budget ended it");
		assert.equal(channel.attachRequests.length, 3, "the boot's attach and two reattaches");
	});

	it("names the broker's refusal on every attempt, not only on the last", async () => {
		const { channel, session, timers, log } = await boot({ session: settings });
		channel.attachError = true;
		channel.closeLink("disconnected", "the peer closed the connection");
		await waitUntil(() => log.has(/reattach attempt 1 failed after \d+ ms \(attach refused\); trying again in 10 ms/));
		timers.advance(10);
		await waitUntil(() => log.has(/reattach attempt 2 failed/));
		timers.advance(10);
		await waitUntil(() => session.phase === "failed");
		assert.ok(log.has(/warn reattach failed after \d+ ms and 3 attempts: attach-failed \(attach refused\)/));
	});

	it("logs a first attach that fails with its reason too", async () => {
		const scratch = await ScratchDir.create();
		scratches.push(scratch);
		const file = await scratch.file("s.jsonl", sessionFileText({ id: "sess-1", entries: [u1, a1] }));
		const channel = new FakeRpcChannel({ sessionFile: file, entries: [u1, a1] as never, leafId: "a1" });
		channel.attachError = true;
		const log = new Lines();
		const session = new RpcSession({ channel, sessionFile: file, cwd: "D:\\scratch", hostNonce: "host-a", timers: new ManualTimers(), fileExists: async () => true, log, autoRecoveryDelaysMs: [] });
		sessions.push(session);
		await session.start();
		await waitUntil(() => session.phase === "failed");
		assert.ok(log.has(/warn the first attach failed: attach-failed \(attach refused\)/));
	});
});

describe("a reattach after the broker's ring dropped the lines past the cursor", () => {
	const u2 = messageEntry("u2", "a1", userMessage("work", 3000));
	const a2 = messageEntry("a2", "u2", assistantMessage("done", 4000));
	const sinceOf = (channel: FakeRpcChannel): unknown[] => channel.commandsOfType("get_entries").map(command => command.since);

	/** The turn went on while the window could not read: OMP and the session file hold two more entries. */
	async function grown(rig: Rig): Promise<void> {
		rig.channel.child.entries = [u1, a1, u2, a2] as never;
		rig.channel.child.leafId = "a2";
		await appendFile(rig.file, jsonl([u2, a2]));
	}

	it("re-reads the transcript from the session file, asks OMP only for what the file trails by, and says so", async () => {
		const rig = await boot();
		const { channel, session, log } = rig;
		await grown(rig);
		const asked = sinceOf(channel).length;
		channel.forcedClose = { reason: "paced", ageMs: 100 };
		channel.truncatedAttach = true;
		channel.closeLink("disconnected", "the peer closed the connection");
		await waitUntil(() => log.has(/reattach finished/));
		assert.equal(session.phase, "live");
		assert.ok(log.has(/the broker's lines in between are gone: the transcript was re-read from the session file \(last entry a2\)/));
		assert.deepEqual(session.model.entries.map(entry => entry.id), ["u1", "a1", "u2", "a2"]);
		assert.deepEqual(sinceOf(channel).slice(asked), ["a2"], "OMP is asked for the entries after the file's last one, not after the stale cursor");
	});

	it("keeps asking OMP for the delta after its cursor when the ring still holds every line", async () => {
		const rig = await boot();
		const { channel, session, log } = rig;
		await grown(rig);
		const asked = sinceOf(channel).length;
		channel.closeLink("disconnected", "the peer closed the connection");
		await waitUntil(() => log.has(/reattach finished/));
		assert.deepEqual(sinceOf(channel).slice(asked), ["a1"]);
		assert.equal(log.has(/re-read from the session file/), false);
		assert.deepEqual(session.model.entries.map(entry => entry.id), ["u1", "a1", "u2", "a2"]);
	});

	it("asks OMP for the entries after the cursor when the session file cannot serve, and says that", async () => {
		const rig = await boot({ session: { openHistory: async () => { throw new Error("no file"); } } });
		const { channel, session, log } = rig;
		channel.child.entries = [u1, a1, u2, a2] as never;
		channel.child.leafId = "a2";
		channel.truncatedAttach = true;
		channel.closeLink("disconnected", "the peer closed the connection");
		await waitUntil(() => log.has(/reattach finished/));
		assert.ok(log.has(/the session file could not serve the transcript: OMP is asked for the entries after the cursor instead/));
		assert.deepEqual(session.model.entries.map(entry => entry.id), ["u1", "a1", "u2", "a2"]);
	});
});

describe("a large session after unknown_since", () => {
	it("is read by the process, which is the authority on the cursor it refused", async () => {
		const c1 = messageEntry("c1", null, userMessage("other", 100));
		const c2 = messageEntry("c2", "c1", assistantMessage("branch", 200));
		const { channel, session } = await boot({
			session: { largeSessionBytes: 1 },
			setup: ch => {
				ch.child.entries = [c1, c2] as never;
				ch.child.leafId = "c2";
			},
		});
		assert.equal(channel.commandsOfType("get_entries").length, 2, "the since read and one full read");
		assert.deepEqual(session.model.entries.map(entry => entry.id), ["c1", "c2"]);
	});
});

describe("link_stalled", () => {
	it("a child can never produce the frame", () => {
		assert.equal(toChatEventFrame({ type: "link_stalled", stalled: true }), null);
	});
});
