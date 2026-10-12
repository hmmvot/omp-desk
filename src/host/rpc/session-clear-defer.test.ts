/**
 * `/clear` right after an interrupted turn (ADR-0059 amendment): the refusal names what is in the way, and a clear that
 * is only waiting for OMP to finish waits instead of refusing. Runner: `node --test src/host/rpc/session-clear-defer.test.ts`.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { CLEAR_COMMAND, CLEAR_DEFER_MS, CLEAR_MARKER_TYPE, CLEAR_REFUSAL_SENTENCES, parseClearArgs, type ClearArgs, type ClearDeferrable } from "../../chat/clear.ts";
import { FakeRpcChannel } from "./fake-channel.ts";
import { RpcSession, type ClearOutcome } from "./session.ts";
import { ManualTimers, assistantMessage, isoOf, messageEntry, tick, userMessage } from "./test-support.ts";

const sessions: RpcSession[] = [];
afterEach(() => { for (const session of sessions.splice(0)) session.dispose(); });
const PREFIX = `/${CLEAR_COMMAND} `;
const u1 = messageEntry("u1", null, userMessage("hi", 1000));
const a1 = messageEntry("a1", "u1", assistantMessage("hello", 2000));
let seq = 0;
const rid = () => (++seq).toString(16).padStart(32, "0");

async function boot() {
	const channel = new FakeRpcChannel({ sessionFile: null, entries: [u1, a1] as never, leafId: "a1" });
	channel.handlers.set("get_available_commands", () => ({ data: { commands: [{ name: CLEAR_COMMAND, source: "extension" }] } }));
	const timers = new ManualTimers();
	const session = new RpcSession({ channel, sessionFile: null, cwd: "D:\\scratch", hostNonce: "host-a", timers, watchdogIntervalMs: 60 * 60_000 });
	sessions.push(session);
	await session.start(); await tick();
	return { channel, session, timers };
}

/** OMP 18.8.5's clear command: boundary and reload, builtin fresh, marker; the extension acknowledges early and reports completion in `prompt_result`. */
function install(channel: FakeRpcChannel): ClearArgs[] {
	const calls: ClearArgs[] = [];
	channel.handlers.set("prompt", command => {
		if (command.message === "/fresh") {
			channel.child.sessionId += "-fresh";
			setImmediate(() => channel.emit({ type: "prompt_result", id: command.id, agentInvoked: true, status: "aborted", sessionSettled: true }));
			return {};
		}
		if (!String(command.message).startsWith(PREFIX)) return {};
		const args = parseClearArgs(String(command.message).slice(PREFIX.length)); assert.ok(args);
		calls.push(args);
		if (args.phase === "confirm") {
			channel.child.entries.push({ type: "custom", customType: CLEAR_MARKER_TYPE, id: `m-${args.requestId}`, parentId: channel.child.leafId, timestamp: isoOf(50_001), data: { v: 1, requestId: args.requestId, boundaryId: `b-${args.requestId}` } });
			channel.child.leafId = `m-${args.requestId}`;
		} else {
			channel.child.entries.push({ type: "reset_boundary", id: `b-${args.requestId}`, parentId: channel.child.leafId, timestamp: isoOf(50_000) });
			channel.child.leafId = `b-${args.requestId}`;
		}
		setImmediate(() => channel.emit({ type: "prompt_result", id: command.id, agentInvoked: false, status: "completed", sessionSettled: true }));
		return {};
	});
	return calls;
}

/** An aborted turn: the agent ended but OMP has not reported the session settled. */
async function interrupted(channel: FakeRpcChannel): Promise<void> {
	channel.emit({ type: "agent_start" });
	channel.emit({ type: "agent_end", messages: [] });
	await tick();
}

describe("clear refusals name what is in the way", () => {
	const cases: [string, (channel: FakeRpcChannel) => unknown, string][] = [
		["a response is streaming", channel => channel.emit({ type: "agent_start" }), "busy"],
		["OMP has not settled after the interrupted turn", interrupted, "unsettled"],
		["a message waits in OMP's queue", channel => channel.emit({ type: "queue_update", steering: ["later"], followUp: [] }), "queued"],
		["a dialog is open", channel => channel.emit({ type: "extension_ui_request", id: "ui-1", method: "confirm", title: "Sure?", message: "?" }), "dialog"],
		["a sent message is not confirmed yet", channel => channel.emitMessage("message_end", "m-1", userMessage("typed", 9_000) as never), "unconfirmed-send"],
	];
	for (const [name, setup, reason] of cases) {
		it(`says ${reason} while ${name}, and writes nothing`, async () => {
			const { channel, session } = await boot();
			await setup(channel); await tick();
			assert.deepEqual(await session.clear(rid()), { status: "refused", reason });
			assert.equal(channel.commandsOfType("prompt").length, 0);
			assert.ok(CLEAR_REFUSAL_SENTENCES[reason as keyof typeof CLEAR_REFUSAL_SENTENCES].length > 0);
		});
	}
	it("keeps jobs as it was", async () => {
		const { channel, session } = await boot();
		channel.emit({ type: "agent_start" }); channel.emit({ type: "agent_end", messages: [], isTerminal: false }); await tick();
		assert.deepEqual(await session.clear(rid()), { status: "refused", reason: "jobs" });
	});
	it("gives each reason its own sentence, none of them the streaming one but streaming itself", () => {
		const sentences = (["busy", "unsettled", "queued", "dialog", "unconfirmed-send"] as const).map(reason => CLEAR_REFUSAL_SENTENCES[reason]);
		assert.equal(new Set(sentences).size, sentences.length);
	});
});

describe("a clear that only waits for OMP", () => {
	it("runs once OMP settles the interrupted turn, through the same three prompts as an immediate clear", async () => {
		const { channel, session } = await boot(); const calls = install(channel);
		await interrupted(channel);
		const deferred: ClearDeferrable[] = [];
		const requestId = rid();
		const outcome = session.clear(requestId, reason => deferred.push(reason));
		assert.deepEqual(deferred, ["unsettled"], "the caller is told at once what it waits for");
		assert.equal(session.model.clearPending, "unsettled", "and the page can see it");
		await tick();
		assert.equal(channel.commandsOfType("prompt").length, 0, "nothing reaches OMP while it finishes");
		channel.emit({ type: "session_settled" });
		assert.deepEqual(await outcome, { status: "done" });
		assert.equal(session.model.clearPending, null);
		assert.deepEqual(calls, [{ v: 1, requestId, sessionId: "sess-1" }, { v: 1, requestId, sessionId: "sess-1", phase: "confirm" }]);
		assert.equal(channel.commandsOfType("prompt")[1]!.message, "/fresh");
		assert.ok(session.model.entries.some(entry => entry.type === "reset_boundary"));
	});

	it("waits for a queued message to be taken, and for a sent message to be reconciled", async () => {
		const queued = await boot(); install(queued.channel);
		queued.channel.emit({ type: "queue_update", steering: ["later"], followUp: [] }); await tick();
		const first = queued.session.clear(rid(), () => {}); await tick();
		assert.equal(queued.session.model.clearPending, "queued");
		queued.channel.emit({ type: "queue_update", steering: [], followUp: [] });
		assert.deepEqual(await first, { status: "done" });

		const sent = await boot(); install(sent.channel);
		sent.channel.emitMessage("message_end", "m-1", userMessage("typed", 9_000) as never); await tick();
		const second = sent.session.clear(rid(), () => {}); await tick();
		assert.equal(sent.session.model.clearPending, "unconfirmed-send");
		sent.channel.child.entries.push(messageEntry("u2", "a1", userMessage("typed", 9_000)) as never); sent.channel.child.leafId = "u2";
		sent.channel.emit({ type: "prompt_result", id: "vsc:none", agentInvoked: false, status: "completed", sessionSettled: true });
		assert.deepEqual(await second, { status: "done" });
	});

	it("follows what is in the way while it waits, and runs only when everything has passed", async () => {
		const { channel, session } = await boot(); install(channel);
		let queued = 0;
		channel.handlers.set("get_state", () => ({ data: { sessionId: channel.child.sessionId, sessionFile: null, isStreaming: false, isCompacting: false, queuedMessageCount: queued, isSettled: true } }));
		await interrupted(channel);
		const outcome = session.clear(rid(), () => {}); await tick();
		queued = 1;
		channel.emit({ type: "queue_update", steering: ["later"], followUp: [] });
		assert.equal(session.model.clearPending, "queued", "the page's reason follows the blocker that is in the way now");
		channel.emit({ type: "session_settled" }); await tick();
		assert.equal(channel.commandsOfType("prompt").length, 0, "settled, but the message is still queued");
		queued = 0;
		channel.emit({ type: "queue_update", steering: [], followUp: [] });
		assert.deepEqual(await outcome, { status: "done" });
	});

	it("is never offered for a streaming response or an open dialog, and needs a caller that shows the wait", async () => {
		const streaming = await boot(); streaming.channel.emit({ type: "agent_start" }); await tick();
		let told = false;
		assert.deepEqual(await streaming.session.clear(rid(), () => { told = true; }), { status: "refused", reason: "busy" });
		assert.equal(told, false);
		const dialog = await boot();
		dialog.channel.emit({ type: "extension_ui_request", id: "ui-1", method: "confirm", title: "Sure?", message: "?" }); await tick();
		assert.deepEqual(await dialog.session.clear(rid(), () => { told = true; }), { status: "refused", reason: "dialog" });
		const silent = await boot(); await interrupted(silent.channel);
		assert.deepEqual(await silent.session.clear(rid()), { status: "refused", reason: "unsettled" }, "no caller to show a wait: refused as before");
		assert.equal(told, false);
	});

	it("allows one waiting clear: a second says so and neither doubles nor cancels the first", async () => {
		const { channel, session } = await boot(); const calls = install(channel);
		await interrupted(channel);
		const first = session.clear(rid(), () => {});
		let again = false;
		assert.deepEqual(await session.clear(rid(), () => { again = true; }), { status: "refused", reason: "clear-pending" });
		assert.equal(again, false);
		channel.emit({ type: "session_settled" });
		assert.deepEqual(await first, { status: "done" });
		assert.equal(calls.length, 2, "one clear ran: prepare and confirm");
	});

	it("is cancelled by a user message or another command, and nothing was written for it", async () => {
		const sendCancels: [string, (session: RpcSession) => Promise<unknown>][] = [
			["a prompt", session => session.prompt({ requestId: "p1", text: "never mind" })],
			["a steer", session => session.steer({ requestId: "p2", text: "never mind" })],
			["a follow-up", session => session.followUp({ requestId: "p3", text: "never mind" })],
			["/fresh", session => session.fresh(rid())],
			["a rewind", session => session.navigate({ requestId: rid(), kind: "rewind", targetId: "u1", expectedLeafId: "a1", summarize: false })],
		];
		for (const [name, act] of sendCancels) {
			const { channel, session } = await boot(); const calls = install(channel);
			await interrupted(channel);
			const outcome = session.clear(rid(), () => {}); await tick();
			await act(session);
			assert.deepEqual(await outcome, { status: "refused", reason: "cancelled" }, name);
			assert.equal(session.model.clearPending, null, name);
			channel.emit({ type: "session_settled" }); await tick();
			assert.deepEqual(calls, [], `${name}: the cancelled clear never runs when OMP settles`);
		}
	});

	it("is not cancelled by an abort, which is what the user does to finish the turn", async () => {
		const { channel, session } = await boot(); install(channel);
		await interrupted(channel);
		const outcome = session.clear(rid(), () => {}); await tick();
		await session.abortAndRestore(rid());
		channel.emit({ type: "session_settled" });
		assert.deepEqual(await outcome, { status: "done" });
	});

	it(`gives up after ${CLEAR_DEFER_MS / 1000} s with the precise reason, then a new /clear is accepted`, async () => {
		const { channel, session, timers } = await boot(); install(channel);
		await interrupted(channel);
		const outcome = session.clear(rid(), () => {}); await tick();
		timers.advance(CLEAR_DEFER_MS - 1);
		assert.equal(session.model.clearPending, "unsettled", "still waiting just before the limit");
		timers.advance(1);
		assert.deepEqual(await outcome, { status: "refused", reason: "unsettled" });
		assert.equal(session.model.clearPending, null);
		channel.emit({ type: "session_settled" }); await tick();
		assert.equal(channel.commandsOfType("prompt").length, 0, "a timed-out clear does not run later");
		assert.deepEqual(await session.clear(rid(), () => {}), { status: "done" });
	});

	it("ends with the session: a stopped child or a disposed session never runs it", async () => {
		const stopped = await boot(); const calls = install(stopped.channel);
		await interrupted(stopped.channel);
		const outcome: Promise<ClearOutcome> = stopped.session.clear(rid(), () => {}); await tick();
		stopped.channel.exitChild(1); await tick();
		assert.deepEqual(await outcome, { status: "refused", reason: "not-live" });
		assert.equal(stopped.session.model.clearPending, null);
		const disposed = await boot(); install(disposed.channel);
		await interrupted(disposed.channel);
		const pending = disposed.session.clear(rid(), () => {}); await tick();
		disposed.session.dispose();
		assert.deepEqual(await pending, { status: "refused", reason: "not-live" });
		assert.deepEqual(calls, []);
	});

	it("an exactly-once request id returns the same waiting outcome", async () => {
		const { channel, session } = await boot(); install(channel);
		await interrupted(channel);
		const requestId = rid();
		const first = session.clear(requestId, () => {});
		assert.equal(session.clear(requestId, () => {}), first);
		channel.emit({ type: "session_settled" });
		assert.deepEqual(await first, { status: "done" });
	});
});
