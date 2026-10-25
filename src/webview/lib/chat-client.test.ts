/**
 * Tests for the chat page's store: the rules that hold on the page whatever the host does.
 *
 * What is defended is what a user or the session would otherwise pay for silently: a dialog
 * (a tool approval among them) answered twice or answered while it was not the one on
 * screen, an event of another host generation changing what is shown, a transcript applied
 * before it is whole, and a message sent into a session that cannot take it. The host
 * re-checks every one of these; the page must not depend on that.
 *
 * Runner: `node --test src/webview/lib/chat-client.test.ts`.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import type { SessionEntry } from "@oh-my-pi/pi-wire";
import { createChatModel, snapshotOf } from "../../chat/model.ts";
import type { ChatEpoch, ChatPhase, ChatSnapshotPayload, ChatUiRequest } from "../../chat/model.ts";
import { REWIND_ARGUMENTS_SENTENCE, SLASH_DENIED_SENTENCE } from "../../protocol/rpc.ts";
import { splitChatSnapshot } from "../../protocol/chat-messages.ts";
import type { GuestHostMessage, GuestWebviewMessage } from "../../protocol/messages.ts";
import { ChatClient, LIVE_LOAD_FACTOR, LIVE_PACE_MAX_MS, LIVE_PACE_WHILE_TYPING_MS } from "./chat-client.ts";

const EPOCH: ChatEpoch = { nonce: "host-a", counter: 1 };
const OTHER_EPOCH: ChatEpoch = { nonce: "host-b", counter: 1 };

const APPROVE: ChatUiRequest = { id: "d1", method: "confirm", title: "Run rm?", message: "rm -rf build" };
const PICK: ChatUiRequest = { id: "d2", method: "select", title: "Pick", options: [{ label: "a" }, { label: "b" }] };

function entry(id: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-09-29T00:00:00.000Z",
		message: { role: "user", content: id, timestamp: 1_700_000_000_000 },
	};
}

function payload(patch: Partial<ChatSnapshotPayload> = {}, epoch: ChatEpoch = EPOCH): ChatSnapshotPayload {
	return { ...snapshotOf(createChatModel(), epoch), phase: "live", ...patch };
}

/** A snapshot message that needs no chunks. */
function snapshotMessage(patch: Partial<ChatSnapshotPayload> = {}, epoch: ChatEpoch = EPOCH): GuestHostMessage {
	return splitChatSnapshot(payload({ ...patch, entries: [] }, epoch), "snap").snapshot;
}

interface Harness {
	client: ChatClient;
	sent: GuestWebviewMessage[];
	/** Make the transport report that a message went nowhere (a lost route). */
	setReachable(value: boolean): void;
}

function harness(acceptText = true): Harness {
	const sent: GuestWebviewMessage[] = [];
	let reachable = true;
	let counter = 0;
	const client = new ChatClient(
		{
			post: message => {
				if (!reachable) return false;
				sent.push(message);
				if (acceptText && (message.type === "omp:chat-prompt" || message.type === "omp:chat-steer" || message.type === "omp:chat-follow-up")) {
					queueMicrotask(() => client.handle({ type: "omp:chat-send-result", epoch: EPOCH, requestId: message.requestId, status: "accepted" }));
				}
				return true;
			},
		},
		{ now: () => 1_700_000_000_000, newRequestId: () => (++counter).toString(16).padStart(32, "0") },
	);
	return { client, sent, setReachable: (value: boolean) => (reachable = value) };
}

/** A client that holds a live conversation, optionally with dialogs pending. */
function live(patch: Partial<ChatSnapshotPayload> = {}, acceptText = true): Harness {
	const built = harness(acceptText);
	built.client.handle(snapshotMessage(patch));
	return built;
}

function inPhase(phase: ChatPhase, patch: Partial<ChatSnapshotPayload> = {}): Harness {
	return live({ phase, readOnlyReason: phase === "live" ? null : "not running", ...patch });
}

describe("a send the transport could not deliver", () => {
	it("is refused with a reason, so the composer keeps the draft, and nothing is recorded as sent", async () => {
		const { client, sent, setReachable } = live();
		setReachable(false);
		for (const result of await Promise.all([client.sendPrompt("hello"), client.sendSteer("hello"), client.sendFollowUp("hello")])) {
			assert.equal(result.ok, false);
			if (!result.ok) assert.match(result.reason, /cannot reach its session host/);
		}
		assert.equal(sent.length, 0);

		setReachable(true);
		assert.equal((await client.sendPrompt("hello")).ok, true);
		assert.equal(sent.length, 1);
	});
});

describe("a complete draft capture", () => {
	it("freezes input and dialog or queue mutation, but retains Stop, and releases without consuming the dialog", async () => {
		const { client, sent } = live({ uiRequests: [APPROVE] });
		client.setDraftHandoffLocked(true);
		assert.equal((await client.sendPrompt("held")).ok, false);
		assert.equal((await client.sendSteer("held")).ok, false);
		assert.equal((await client.sendFollowUp("held")).ok, false);
		assert.equal(client.answerUi({ id: APPROVE.id, confirmed: true }).ok, false);
		assert.equal((await client.removeQueued("edit", [{ queue: "steering", text: "held" }])).ok, false);
		assert.equal(sent.length, 0);
		assert.equal(client.sendAbort().ok, true);
		assert.equal(sent.at(-1)?.type, "omp:chat-abort");
		client.setDraftHandoffLocked(false);
		assert.equal(client.answerUi({ id: APPROVE.id, confirmed: true }).ok, true);
		assert.equal(sent.at(-1)?.type, "omp:chat-ui-response");
	});
});

function textRequestId(message: GuestWebviewMessage | undefined): string {
	assert.ok(message !== undefined && (message.type === "omp:chat-prompt" || message.type === "omp:chat-steer" || message.type === "omp:chat-follow-up"));
	return message.requestId;
}

describe("text admission receipts", () => {
	it("waits for the matching native outcome, without inventing turn or queue state", async () => {
		const { client, sent } = live({}, false);
		const before = client.getSnapshot();
		const pending = client.sendSteer("keep this draft");
		const requestId = textRequestId(sent[0]);
		let settled = false;
		void pending.then(() => { settled = true; });
		await Promise.resolve();
		assert.equal(settled, false, "posting to a transport does not prove admission");
		client.handle({ type: "omp:chat-send-result", epoch: EPOCH, requestId: "0".repeat(32), status: "accepted" });
		await Promise.resolve();
		assert.equal(settled, false, "another request cannot clear this draft");
		assert.equal(client.getSnapshot(), before, "a receipt does not manufacture native state");
		client.handle(snapshotMessage({}, OTHER_EPOCH));
		client.handle({ type: "omp:chat-send-result", epoch: EPOCH, requestId, status: "accepted" });
		assert.deepEqual(await pending, { ok: true }, "admission remains authoritative across reconciliation");
		client.handle({ type: "omp:chat-send-result", epoch: EPOCH, requestId, status: "refused" });
		assert.deepEqual(await pending, { ok: true }, "a duplicate cannot change the settled result");
		assert.equal(sent.length, 1);
	});

	it("keeps refusal distinct from uncertain delivery and never retries either", async () => {
		for (const status of ["refused", "unconfirmed"] as const) {
			const { client, sent } = live({}, false);
			const pending = client.sendFollowUp("recover this input");
			client.handle({ type: "omp:chat-send-result", epoch: EPOCH, requestId: textRequestId(sent[0]), status });
			const result = await pending;
			assert.equal(result.ok, false);
			if (!result.ok) {
				assert.equal(result.unconfirmed === true, status === "unconfirmed");
				assert.ok(result.reason.length > 0);
			}
			await Promise.resolve();
			assert.equal(sent.length, 1);
		}
	});

	it("bounds a lost receipt without resending an uncertain message", async t => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const { client, sent } = live({}, false);
		const pending = client.sendPrompt("no acknowledgement arrived");
		let settled = false;
		void pending.then(() => { settled = true; });
		t.mock.timers.tick(44_999);
		await Promise.resolve();
		assert.equal(settled, false);
		t.mock.timers.tick(1);
		const result = await pending;
		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.unconfirmed, true);
		t.mock.timers.tick(90_000);
		assert.equal(sent.length, 1, "uncertainty is reported, not automatically retried");
		client.handle({ type: "omp:chat-send-result", epoch: EPOCH, requestId: textRequestId(sent[0]), status: "accepted" });
		assert.deepEqual(await pending, result);
	});

	it("does not bound the receipt while a dialog is open, and bounds it again from the moment the dialog settles", async t => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const { client, sent } = live({}, false);
		const pending = client.sendPrompt("/review");
		let settled = false;
		void pending.then(() => { settled = true; });
		t.mock.timers.tick(20_000);
		client.handle({ type: "omp:chat-ui-request", epoch: EPOCH, request: PICK });
		t.mock.timers.tick(10 * 45_000);
		await Promise.resolve();
		assert.equal(settled, false, "OMP waits for the user: the command is not acknowledged yet, and the message is not lost");
		assert.equal(client.answerUi({ id: PICK.id, value: "a" }).ok, true);
		t.mock.timers.tick(44_999);
		await Promise.resolve();
		assert.equal(settled, false, "the whole deadline starts over at the answer");
		client.handle({ type: "omp:chat-send-result", epoch: EPOCH, requestId: textRequestId(sent[0]), status: "accepted" });
		assert.deepEqual(await pending, { ok: true });

		const lost = client.sendPrompt("/review again");
		client.handle({ type: "omp:chat-ui-request", epoch: EPOCH, request: APPROVE });
		t.mock.timers.tick(3 * 45_000);
		client.handle({ type: "omp:chat-ui-cancel", epoch: EPOCH, targetId: APPROVE.id });
		t.mock.timers.tick(45_000);
		const result = await lost;
		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.unconfirmed, true, "a command that never answers after its dialog is still reported, one deadline later");
	});

	it("registers correlation before posting, even for a synchronous reply", async () => {
		let client: ChatClient;
		client = new ChatClient({ post: message => {
			if (message.type === "omp:chat-steer") client.handle({ type: "omp:chat-send-result", epoch: EPOCH, requestId: message.requestId, status: "accepted" });
			return true;
		} });
		client.handle(snapshotMessage());
		assert.deepEqual(await client.sendSteer("synchronous admission"), { ok: true });
	});

	it("does not mistake a throwing transport for proof that nothing was delivered", async () => {
		let attempts = 0;
		const client = new ChatClient({ post: () => { attempts++; throw new Error("delivery result lost"); } });
		client.handle(snapshotMessage());
		const result = await client.sendPrompt("retain this input");
		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.unconfirmed, true);
		assert.equal(attempts, 1);
	});
});

describe("a dialog is answered at most once", () => {
	it("sends one answer and refuses a repeat, a stale card and an answer out of order", () => {
		const { client, sent } = live({ uiRequests: [APPROVE, PICK] });

		// Only the dialog on screen can be answered: answering the one behind it would
		// settle a question the user has not seen.
		const early = client.answerUi({ id: "d2", value: "a" });
		assert.equal(early.ok, false);
		assert.equal(sent.length, 0);

		assert.deepEqual(client.answerUi({ id: "d1", confirmed: true }), { ok: true });
		assert.equal(sent.length, 1);
		assert.deepEqual(sent[0]?.type === "omp:chat-ui-response" ? sent[0].response : null, { id: "d1", confirmed: true });

		// A double click and a card that stayed on screen for a frame: no second answer.
		assert.equal(client.answerUi({ id: "d1", confirmed: true }).ok, false);
		assert.equal(client.answerUi({ id: "d1", cancelled: true }).ok, false);
		assert.equal(sent.length, 1);
	});

	it("shows the next queued dialog at once, and answers it in turn", () => {
		const { client, sent } = live({ uiRequests: [APPROVE, PICK] });
		client.answerUi({ id: "d1", confirmed: false });
		assert.equal(client.getSnapshot().uiRequest?.id, "d2");
		assert.deepEqual(client.answerUi({ id: "d2", value: "b" }), { ok: true });
		assert.equal(client.getSnapshot().uiRequest, null);
		assert.equal(sent.length, 2);
	});

	it("does not resurrect an answered dialog when the host re-delivers it", () => {
		const { client, sent } = live({ uiRequests: [APPROVE] });
		client.answerUi({ id: "d1", confirmed: true });
		client.handle({ type: "omp:chat-ui-request", epoch: EPOCH, request: APPROVE });
		assert.equal(client.getSnapshot().uiRequest, null);
		assert.equal(client.answerUi({ id: "d1", confirmed: true }).ok, false);
		assert.equal(sent.length, 1);
	});

	it("drops a dialog the child withdrew, so a late click answers nothing", () => {
		const { client, sent } = live({ uiRequests: [APPROVE] });
		client.handle({ type: "omp:chat-ui-cancel", epoch: EPOCH, targetId: "d1" });
		assert.equal(client.getSnapshot().uiRequest, null);
		assert.equal(client.answerUi({ id: "d1", confirmed: true }).ok, false);
		assert.equal(sent.length, 0);
	});

	it("forgets its answers at a new snapshot, whose dialogs the host guarantees are still unanswered", () => {
		const { client, sent } = live({ uiRequests: [APPROVE] });
		client.answerUi({ id: "d1", confirmed: true });
		client.handle(snapshotMessage({ uiRequests: [APPROVE] }, OTHER_EPOCH));
		assert.equal(client.getSnapshot().uiRequest?.id, "d1");
		assert.deepEqual(client.answerUi({ id: "d1", confirmed: false }), { ok: true });
		assert.equal(sent.length, 2);
	});

	it("names each answer with a fresh request id, so the host can dedupe a re-posted one", () => {
		const { client, sent } = live({ uiRequests: [APPROVE, PICK] });
		client.answerUi({ id: "d1", confirmed: true });
		client.answerUi({ id: "d2", value: "a" });
		const ids = sent.map(message => ("requestId" in message ? message.requestId : ""));
		assert.equal(new Set(ids).size, 2);
	});

	it("refuses to answer while the session cannot take it", () => {
		const { client, sent } = inPhase("stopped", { uiRequests: [APPROVE] });
		assert.equal(client.answerUi({ id: "d1", confirmed: true }).ok, false);
		assert.equal(sent.length, 0);
		assert.equal(client.getSnapshot().uiRequest?.id, "d1", "the dialog stays for the host to settle");
	});
});

describe("epochs", () => {
	it("drops events, rows and dialogs of another generation than the last snapshot's", () => {
		const { client } = live();
		client.handle({ type: "omp:chat-event", epoch: OTHER_EPOCH, frame: { type: "agent_start" } });
		assert.equal(client.getSnapshot().working, false);
		client.handle({ type: "omp:chat-entries", epoch: OTHER_EPOCH, entries: [entry("e1")], leafId: "e1" });
		assert.equal(client.getSnapshot().entries.length, 0);
		client.handle({ type: "omp:chat-ui-request", epoch: OTHER_EPOCH, request: APPROVE });
		assert.equal(client.getSnapshot().uiRequest, null);

		client.handle({ type: "omp:chat-event", epoch: EPOCH, frame: { type: "agent_start" } });
		assert.equal(client.getSnapshot().working, true);
	});

	it("adopts a restarted host's snapshot even when its counter is lower than the retained one", () => {
		const { client } = live();
		client.handle({ type: "omp:chat-event", epoch: { nonce: "host-a", counter: 1 }, frame: { type: "agent_start" } });
		client.handle(snapshotMessage({ header: { id: "s2", cwd: "D:/w", timestamp: "t" } }, { nonce: "host-c", counter: 0 }));
		assert.equal(client.getSnapshot().header?.id, "s2");
		assert.equal(client.getSnapshot().working, false, "the reset replaced the old generation's state");
		client.handle({ type: "omp:chat-event", epoch: { nonce: "host-a", counter: 9 }, frame: { type: "agent_start" } });
		assert.equal(client.getSnapshot().working, false, "the old host's frames stay dropped");
	});

	it("drops a late state of the same host, and follows a restarted host's state ahead of its snapshot", () => {
		const { client } = harness();
		client.handle(snapshotMessage({}, { nonce: "host-a", counter: 5 }));
		const state = (epoch: ChatEpoch, phase: ChatPhase) => ({
			type: "omp:chat-state" as const,
			epoch,
			phase,
			code: null,
			sessionId: null,
			cwd: null,
			title: null,
			readOnlyReason: null,
		});
		client.handle(state({ nonce: "host-a", counter: 4 }, "failed"));
		assert.equal(client.getSnapshot().phase, "live", "an older state of the same host is late");
		// A restarted host announces its phase before its first snapshot exists.
		client.handle(state({ nonce: "host-c", counter: 0 }, "resyncing"));
		assert.equal(client.getSnapshot().phase, "resyncing");
	});
});

describe("a snapshot is atomic", () => {
	const rows = Array.from({ length: 6 }, (_, index) => entry(`e${index}`));

	it("changes nothing until every announced chunk has arrived", () => {
		const { client } = live();
		const { snapshot, chunks } = splitChatSnapshot(payload({ entries: rows }, OTHER_EPOCH), "snap-x", 300);
		assert.ok(chunks.length > 1);
		let notified = 0;
		client.subscribe(() => {
			notified += 1;
		});

		client.handle(snapshot);
		for (const chunk of chunks.slice(0, -1)) client.handle(chunk);
		assert.equal(client.getSnapshot().entries.length, 0, "half a transcript is never shown");
		assert.equal(notified, 0);

		client.handle(chunks.at(-1)!);
		assert.equal(client.getSnapshot().entries.length, rows.length);
		assert.equal(notified, 1);
	});
});

describe("writing needs a live, unlocked session", () => {
	it("refuses every mutation in a phase that cannot take it, and posts nothing", async () => {
		for (const phase of ["starting", "attaching", "resyncing", "stopped", "failed", "view-only", "legacy"] as const) {
			const { client, sent } = inPhase(phase);
			assert.equal(client.writable, false, phase);
			assert.equal((await client.sendPrompt("hi")).ok, false, phase);
			assert.equal((await client.sendSteer("hi")).ok, false, phase);
			assert.equal((await client.sendFollowUp("hi")).ok, false, phase);
			assert.equal(client.sendAbort().ok, false, phase);
			assert.equal(sent.length, 0, phase);
		}
	});

	it("refuses when the host locked a live session read-only", async () => {
		const { client, sent } = live({ readOnlyReason: "another window controls this session" });
		assert.equal(client.writable, false);
		assert.equal((await client.sendPrompt("hi")).ok, false);
		assert.equal(sent.length, 0);
	});

	it("posts each delivery as its own message type with a minted request id", async () => {
		const { client, sent } = live();
		assert.deepEqual(await client.sendPrompt("one"), { ok: true });
		assert.deepEqual(await client.sendSteer("two"), { ok: true });
		assert.deepEqual(await client.sendFollowUp("three"), { ok: true });
		assert.deepEqual(client.sendAbort(), { ok: true });
		assert.deepEqual(
			sent.map(message => message.type),
			["omp:chat-prompt", "omp:chat-steer", "omp:chat-follow-up", "omp:chat-abort"],
		);
		assert.equal(new Set(sent.map(message => ("requestId" in message ? message.requestId : ""))).size, 4);
	});

	it("carries images only when there are some", () => {
		const { client, sent } = live();
		client.sendPrompt("plain");
		client.sendPrompt("empty", []);
		client.sendPrompt("shot", [{ type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" }]);
		const withImages = sent.map(message => ("images" in message ? message.images?.length : undefined));
		assert.deepEqual(withImages, [undefined, undefined, 1]);
	});

	it("refuses a message a route cannot carry whole, with its own reason, text-only ones too, and sends it when it can", async () => {
		const sent: GuestWebviewMessage[] = [];
		let carries = false;
		const client = new ChatClient(
			{ post: message => void sent.push(message), carries: () => carries },
			{ now: () => 1_700_000_000_000, newRequestId: () => "1".repeat(32) },
		);
		client.handle(snapshotMessage());
		const image = [{ type: "image" as const, mimeType: "image/png", data: "iVBORw0KGgo=" }];
		const refused = await client.sendPrompt("shot", image);
		assert.equal(refused.ok, false);
		if (!refused.ok) assert.match(refused.reason, /fallback connection.*cannot carry a message this large/);
		assert.equal(sent.length, 0, "nothing reached the route");
		// The route is asked for every send: a text with files can be as large as one with images.
		const text = await client.sendPrompt("plain");
		assert.equal(text.ok, false);
		assert.equal(sent.length, 0);
		carries = true;
		void client.sendPrompt("plain");
		void client.sendPrompt("shot", image);
		assert.equal(sent.length, 2);
	});

	it("refuses a builtin that changes the session's identity or file, and passes ordinary text", async () => {
		const { client, sent } = live();
		for (const denied of ["  /resume 3", "/session delete", "/quit", "/omp-desk-clear {}"]) {
			assert.deepEqual(await client.sendPrompt(denied), { ok: false, reason: SLASH_DENIED_SENTENCE }, denied);
		}
		assert.deepEqual(await client.sendPrompt("/branch 3"), { ok: false, reason: REWIND_ARGUMENTS_SENTENCE }, "Rewind's alias with arguments says how to rewind");
		assert.equal(sent.length, 0);
		// An unknown command and a pasted path are ordinary text to OMP, so they are sent.
		assert.equal((await client.sendPrompt("/usr/bin/x fails")).ok, true);
		assert.equal((await client.sendPrompt("/review the diff")).ok, true);
		assert.equal(sent.length, 2);
	});

	it("passes /clear, /new, /delete and /fresh to the host, which answers them itself (ADR-0059)", async () => {
		const { client, sent } = live();
		for (const command of ["/clear", " /NEW ", "/delete", "/new with arguments", "/fresh"]) assert.equal((await client.sendPrompt(command)).ok, true, command);
		assert.equal(sent.length, 5);
	});
});

describe("reading older rows and resuming", () => {
	it("asks for the rows above the oldest one held, also from a view-only page", () => {
		const built = harness();
		const { snapshot, chunks } = splitChatSnapshot(payload({ phase: "view-only", readOnlyReason: "stopped", entries: [entry("e5")], olderCount: 5 }), "s");
		built.client.handle(snapshot);
		for (const chunk of chunks) built.client.handle(chunk);

		assert.equal(built.client.loadOlder(), true);
		const asked = built.sent.at(-1);
		assert.equal(asked?.type === "omp:chat-load-older" ? asked.beforeId : null, "e5");
	});

	it("asks for nothing when no older rows exist", () => {
		const { client, sent } = live();
		assert.equal(client.loadOlder(), false);
		assert.equal(sent.length, 0);
	});

	it("resumes only a conversation that is not running", () => {
		const running = live();
		assert.equal(running.client.resume(), false);
		assert.equal(running.sent.length, 0);

		const stopped = inPhase("view-only");
		assert.equal(stopped.client.resume(), true);
		assert.equal(stopped.sent.at(-1)?.type, "omp:chat-resume");
	});

	it("binds Restart to the native generation and refuses it during a draft capture or unreachable route", () => {
		const { client, sent, setReachable } = inPhase("failed", { code: "state-failed" });
		assert.equal(client.restart(), true);
		assert.deepEqual(sent.at(-1), { type: "omp:chat-restart", requestId: "1".padStart(32, "0"), epoch: EPOCH });
		client.setDraftHandoffLocked(true);
		assert.equal(client.restart(), false);
		assert.equal(sent.length, 1);
		client.setDraftHandoffLocked(false);
		setReachable(false);
		assert.equal(client.restart(), false);
	});
});

describe("chat quick actions", () => {
	it("settles a terminal-UI command the host answered itself as handled, never as a sent turn or a refusal", async () => {
		const { client, sent } = harness(false);
		client.handle(snapshotMessage());
		const pending = client.sendPrompt("/hotkeys");
		const prompt = sent[0];
		assert.ok(prompt?.type === "omp:chat-prompt");
		client.handle({ type: "omp:chat-send-result", epoch: EPOCH, requestId: prompt.requestId, status: "explained" });
		assert.deepEqual(await pending, { ok: true, explained: true });
	});

	it("hands a Stop's withdrawn queue to the page that stopped, once, whatever the epoch did meanwhile", () => {
		const { client, sent } = harness();
		client.handle(snapshotMessage());
		const answers: unknown[] = [];
		assert.deepEqual(client.sendAbort(answer => answers.push(answer)), { ok: true });
		const abort = sent.at(-1);
		assert.ok(abort?.type === "omp:chat-abort");
		const requestId = abort.requestId;
		client.handle(snapshotMessage({}, OTHER_EPOCH));
		const result = { type: "omp:chat-abort-result" as const, epoch: EPOCH, requestId, status: "accepted" as const, entries: [{ text: "queued steer" }], imagesDropped: true as const };
		client.handle(result);
		client.handle(result);
		client.handle({ ...result, requestId: "f".repeat(32) });
		assert.deepEqual(answers, [{ status: "accepted", entries: [{ text: "queued steer" }], imagesDropped: true }]);
	});

	it("asks a Stop to take the message back and hands the withdrawn draft or the kept flag to the answer", () => {
		const { client, sent } = harness();
		client.handle(snapshotMessage());
		const answers: unknown[] = [];
		assert.deepEqual(client.sendAbort(answer => answers.push(answer)), { ok: true });
		const abort = sent.at(-1);
		assert.ok(abort?.type === "omp:chat-abort");
		assert.deepEqual(abort, { type: "omp:chat-abort", requestId: abort.requestId, takeBack: true });
		const withdrawn = { text: "fix the typo", unavailableImages: 1, unconfirmed: true as const };
		client.handle({ type: "omp:chat-abort-result", epoch: EPOCH, requestId: abort.requestId, status: "accepted", entries: [], withdrawn });
		assert.deepEqual([...answers], [{ status: "accepted", entries: [], withdrawn }]);

		const second = client.sendAbort(answer => answers.push(answer));
		assert.deepEqual(second, { ok: true });
		const again = sent.at(-1);
		assert.ok(again?.type === "omp:chat-abort");
		client.handle({ type: "omp:chat-abort-result", epoch: EPOCH, requestId: again.requestId, status: "accepted", entries: [], kept: true });
		assert.deepEqual(answers.at(-1), { status: "accepted", entries: [], kept: true });
	});

	it("forgets a Stop the route never carried", () => {
		const { client, sent, setReachable } = harness();
		client.handle(snapshotMessage());
		setReachable(false);
		const answers: unknown[] = [];
		assert.equal(client.sendAbort(answer => answers.push(answer)).ok, false);
		client.handle({ type: "omp:chat-abort-result", epoch: EPOCH, requestId: "1".padStart(32, "0"), status: "accepted", entries: [{ text: "x" }] });
		assert.deepEqual(answers, []);
		assert.equal(sent.length, 0);
	});

	it("promotes queued follow-ups through the same correlated queue request", async () => {
		const { client, sent } = harness();
		client.handle(snapshotMessage());
		const pending = client.removeQueued("promote", [{ queue: "followUp", text: "later" }]);
		const request = sent.at(-1);
		assert.ok(request?.type === "omp:chat-queue-remove");
		assert.equal(request.purpose, "promote");
		client.handle({ type: "omp:chat-queue-result", epoch: EPOCH, requestId: request.requestId, purpose: "promote", results: [{ status: "removed" }] });
		assert.deepEqual(await pending, { ok: true, results: [{ queue: "followUp", text: "later", status: "removed" }] });
	});

	it("adopts the host's remembered thinking and tool defaults", () => {
		const { client } = harness();
		client.handle(snapshotMessage());
		client.handle({ type: "omp:chat-display-preferences", epoch: EPOCH, toolCallDetail: "overview", accessibilitySupport: false, thinkingExpanded: true, toolsMode: "groups" });
		assert.deepEqual(client.getDisplayPreferences(), { toolCallDetail: "overview", accessibilitySupport: false, thinkingExpanded: true, toolsMode: "groups" });
	});
});

describe("an action the page asked for is acknowledged in the page", () => {
	const ASK = "1".padStart(32, "0");

	it("makes Resume pending in the click, posts it once, and lets the host's step replace the acknowledgement", () => {
		const { client, sent } = inPhase("view-only");
		assert.equal(client.getOperationState().operation, null);
		assert.equal(client.resume(), true);
		assert.deepEqual(client.getOperationState().operation, { kind: "resume", step: null, elapsedMs: 0, still: false, requestId: ASK });
		assert.equal(client.resume(), false, "a second click while pending sends nothing");
		assert.equal(sent.filter(message => message.type === "omp:chat-resume").length, 1);
		client.handle({ type: "omp:chat-operation", operation: { kind: "resume", step: "ownership", elapsedMs: 800, requestId: ASK, still: false } });
		assert.equal(client.getOperationState().operation?.step, "ownership");
		client.handle({ type: "omp:chat-operation", operation: null, ended: { kind: "resume", requestId: ASK, status: "refused" } });
		assert.equal(client.getOperationState().operation, null);
		assert.equal(client.resume(), true, "after a refusal the button works again");
	});

	it("survives the epoch swap a resume causes and ends when the conversation goes live", () => {
		const { client } = inPhase("view-only");
		client.resume();
		client.handle(snapshotMessage({ phase: "view-only", readOnlyReason: "not running" }, OTHER_EPOCH));
		assert.equal(client.getOperationState().operation?.kind, "resume", "a new epoch's snapshot does not erase the acknowledgement");
		client.handle(snapshotMessage({ phase: "live" }, OTHER_EPOCH));
		assert.equal(client.getOperationState().operation, null);
	});

	it("leaves nothing pending when the message went nowhere, and tells subscribers about every change", () => {
		const { client, setReachable } = inPhase("view-only");
		let notified = 0;
		client.subscribeOperations(() => { notified += 1; });
		setReachable(false);
		assert.equal(client.resume(), false);
		assert.equal(client.getOperationState().operation, null);
		setReachable(true);
		const before = notified;
		client.resume();
		assert.ok(notified > before);
		client.resetOperations();
		assert.equal(client.getOperationState().operation, null);
	});

	it("keeps Restart and Reconnect pending until the host takes over", () => {
		const restart = inPhase("failed", { code: "state-failed" });
		restart.client.restart();
		assert.equal(restart.client.getOperationState().operation?.kind, "restart");
		restart.client.handle(snapshotMessage({ phase: "attaching", readOnlyReason: "not running" }));
		assert.equal(restart.client.getOperationState().operation, null);

		const reconnect = inPhase("failed", { code: "state-failed" });
		reconnect.client.reconnect();
		assert.equal(reconnect.client.getOperationState().operation?.kind, "reconnect");
		assert.equal(reconnect.client.reconnect(), false);
	});

	it("shows Stop as pending until its abort result, sends it once, and refuses a Stop that cannot be sent", () => {
		const { client, sent, setReachable } = live({ working: true });
		let answered = 0;
		assert.deepEqual(client.sendAbort(() => { answered += 1; }), { ok: true });
		assert.equal(client.getOperationState().operation?.kind, "stop");
		assert.deepEqual(client.sendAbort(), { ok: true });
		assert.equal(sent.filter(message => message.type === "omp:chat-abort").length, 1, "a repeat is not sent");
		client.handle({ type: "omp:chat-abort-result", epoch: EPOCH, requestId: ASK, status: "accepted", entries: [] });
		assert.equal(answered, 1);
		assert.equal(client.getOperationState().operation, null);

		setReachable(false);
		assert.equal(client.sendAbort().ok, false);
		assert.equal(client.getOperationState().operation, null, "a Stop that went nowhere is not pending");
	});
});

describe("a running reply while the user types", () => {
	const update = (text: string): GuestHostMessage => ({
		type: "omp:chat-event",
		epoch: EPOCH,
		frame: { type: "message_update", messageId: "live", message: { role: "assistant", model: "m", timestamp: 1, stopReason: "stop", content: [{ type: "text", text }] } as never },
	});

	function pacedClient(): { client: ChatClient; notified: () => number; elapsed: () => number; setTyping(value: boolean): void; setDrawMs(value: number): void; advance(ms: number): void } {
		let typing = false;
		let drawMs = 0;
		const origin = 1_700_000_000_000;
		let clock = origin;
		const client = new ChatClient({ post: () => true }, { now: () => clock, typing: () => typing });
		client.handle(snapshotMessage({ working: true }));
		let count = 0;
		// What drawing a notification costs the page is time that passes inside its subscribers.
		client.subscribe(() => { count += 1; clock += drawMs; });
		return {
			client, notified: () => count, elapsed: () => clock - origin, setTyping: value => { typing = value; }, setDrawMs: value => { drawMs = value; },
			advance: ms => { clock += ms; mock.timers.tick(ms); },
		};
	}

	beforeEach(() => mock.timers.enable({ apis: ["setTimeout"] }));
	afterEach(() => mock.timers.reset());

	it("tells subscribers about every frame while the user is not typing", () => {
		const { client, notified, advance } = pacedClient();
		for (let index = 1; index <= 10; index++) { client.handle(update("x".repeat(index))); advance(33); }
		assert.equal(notified(), 10);
	});

	it("tells subscribers at most once per pace while the user types, with the latest text, and the first frame at once", () => {
		const { client, notified, setTyping, advance } = pacedClient();
		setTyping(true);
		advance(LIVE_PACE_WHILE_TYPING_MS);
		client.handle(update("x"));
		assert.equal(notified(), 1, "the first frame after a pause is not held");
		for (let index = 2; index <= 10; index++) { advance(10); client.handle(update("x".repeat(index))); }
		assert.equal(notified(), 1, "frames inside the pace are held");
		assert.equal(client.getSnapshot().stream?.role, "assistant", "the model already holds the latest frame");
		advance(LIVE_PACE_WHILE_TYPING_MS);
		assert.equal(notified(), 2, "one notification carries everything held");
		advance(LIVE_PACE_WHILE_TYPING_MS * 3);
		assert.equal(notified(), 2, "nothing is announced twice");
	});

	it("tells subscribers of any other change at once, and that carries the held frames", () => {
		const { client, notified, setTyping, advance } = pacedClient();
		setTyping(true);
		advance(LIVE_PACE_WHILE_TYPING_MS);
		client.handle(update("x"));
		advance(10);
		client.handle(update("xx"));
		assert.equal(notified(), 1);
		client.handle({ type: "omp:chat-event", epoch: EPOCH, frame: { type: "turn_end" } });
		assert.equal(notified(), 2, "a state change is not paced");
		advance(LIVE_PACE_WHILE_TYPING_MS * 2);
		assert.equal(notified(), 2, "the held notice was delivered by the state change, not again later");
	});

	it("holds the frames of a page that is slow to draw them, to a share of its time, and keeps up when it is not", async () => {
		const { client, notified, elapsed, setDrawMs, advance } = pacedClient();
		setDrawMs(60);
		advance(1000);
		client.handle(update("x"));
		assert.equal(notified(), 1, "the first frame is drawn at once");
		await Promise.resolve();
		const from = elapsed();
		let frames = 1;
		while (elapsed() - from < 2000) { frames += 1; client.handle(update("x".repeat(frames))); await Promise.resolve(); advance(33); }
		const share = (notified() - 1) * 60 / (elapsed() - from);
		assert.ok(share <= 1 / (1 + LIVE_LOAD_FACTOR) + 0.05, `drawing took ${Math.round(share * 100)}% of the page's time`);
		assert.ok(notified() >= 5, "the stream still advances");
		advance(LIVE_PACE_MAX_MS * 2);
		const drawn = notified();
		assert.equal(client.getSnapshot().stream?.content[0]?.type, "text");
		assert.equal(drawn, notified(), "nothing is announced twice");
		setDrawMs(0);
		for (let index = 0; index < 60; index++) { client.handle(update("y".repeat(index + 1))); await Promise.resolve(); advance(33); }
		const before = notified();
		for (let index = 0; index < 10; index++) { client.handle(update("z".repeat(index + 1))); await Promise.resolve(); advance(33); }
		assert.equal(notified() - before, 10, "once drawing is cheap again, every frame is drawn");
	});

	it("never holds a frame longer than the cap, whatever the cost, and the last frame is always drawn", async () => {
		const { client, notified, setDrawMs, advance } = pacedClient();
		setDrawMs(400);
		advance(1000);
		client.handle(update("a"));
		await Promise.resolve();
		client.handle(update("ab"));
		const held = notified();
		assert.equal(held, 1, "the second frame is held: 2 x 400 ms is over the cap, so it waits the cap, counted from the first");
		advance(LIVE_PACE_MAX_MS);
		assert.equal(notified(), held + 1, "the held frame arrives within the cap");
	});

	it("goes back to every frame when the user stops typing", () => {
		const { client, notified, setTyping, advance } = pacedClient();
		setTyping(true);
		advance(LIVE_PACE_WHILE_TYPING_MS);
		client.handle(update("x"));
		advance(10);
		client.handle(update("xx"));
		setTyping(false);
		advance(LIVE_PACE_WHILE_TYPING_MS);
		assert.equal(notified(), 2);
		client.handle(update("xxx"));
		assert.equal(notified(), 3);
	});
});
