/**
 * What the host does when the broker link stalls or the broker closes it (the incident where a long Chat showed no replies):
 * every close and reattach is logged with its reason, a silent link is measured, probed and shown to the page, a prompt
 * whose answer never came is looked up in the session file instead of being re-sent, and a large session is rebuilt from
 * its file after a lossy close instead of by a full `get_entries`.
 *
 * Runner: `node --test src/host/rpc/session-stall.test.ts`.
 */
import assert from "node:assert/strict";
import { appendFile } from "node:fs/promises";
import { afterEach, describe, it } from "node:test";
import type { Logger } from "../../shared/logger.ts";
import { FakeRpcChannel } from "./fake-channel.ts";
import { RpcSession, type RpcSessionOptions, type RpcSessionOutput } from "./session.ts";
import { ManualTimers, ScratchDir, assistantMessage, messageEntry, sessionFileText, tick, userMessage, waitUntil } from "./test-support.ts";

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
		assert.ok(log.has(/info reattached: .*the broker closed a consumer as fallen behind its retained lines 2 s earlier/));
		assert.equal(session.phase, "live");
	});

	it("says when it was this window that replaced the connection", async () => {
		const { channel, log } = await boot();
		channel.closeLink("disconnected", "replaced-by-new-attach");
		await tick();
		assert.ok(log.has(/the broker connection closed: replaced-by-new-attach/));
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
		assert.ok(channel.commandsOfType("get_state").length >= 2, "the link is probed");
		channel.emit({ type: "agent_start" });
		assert.ok(log.has(/info frames resumed after \d+ ms without one/));
	});

	it("tells the page the link is stalled while a command is unanswered, and clears it when frames resume", async () => {
		const { channel, session, timers, outputs } = await boot();
		channel.autoRespond = false;
		const outcome = session.prompt({ requestId: "slow-1", text: "wait for me" });
		await tick();
		timers.advance(6_000);
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

	it("sends a probe for a starved command, warns when it is unanswered, and keeps the connection", async () => {
		const { channel, session, timers, log } = await boot({ session: { probeTimeoutMs: 2_000 } });
		const attaches = channel.attachRequests.length;
		channel.autoRespond = false;
		void session.prompt({ requestId: "probe-1", text: "waits" });
		await tick();
		timers.advance(8_000);
		await tick();
		assert.ok(log.has(/warn the stall probe was not answered within 2000 ms/));
		assert.equal(channel.attachRequests.length, attaches, "a probe OMP holds is not a reason to replace the connection");
	});

	it("reports a working session that says nothing once, without probing or telling the page, and not at all while a dialog is open", async () => {
		const { channel, session, timers, log } = await boot();
		channel.emit({ type: "agent_start" });
		await tick();
		const probes = channel.commandsOfType("get_state").length;
		timers.advance(30_000);
		await tick();
		assert.equal(log.lines.filter(line => /OMP is working but has sent nothing/.test(line)).length, 1, "one line per silence");
		assert.equal(channel.commandsOfType("get_state").length, probes, "no probe for a quiet session");
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
