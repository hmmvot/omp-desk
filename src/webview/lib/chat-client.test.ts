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
import { describe, it } from "node:test";
import type { SessionEntry } from "@oh-my-pi/pi-wire";
import { createChatModel, snapshotOf } from "../../chat/model.ts";
import type { ChatEpoch, ChatPhase, ChatSnapshotPayload, ChatUiRequest } from "../../chat/model.ts";
import { REWIND_ARGUMENTS_SENTENCE, SLASH_DENIED_SENTENCE } from "../../host/rpc/protocol.ts";
import { splitChatSnapshot } from "../chat-messages.ts";
import type { GuestHostMessage, GuestWebviewMessage } from "../messages.ts";
import { ChatClient } from "./chat-client.ts";

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

	it("refuses a builtin that changes the session's identity or file, and passes ordinary text", async () => {
		const { client, sent } = live();
		for (const denied of ["/new", "  /resume 3", "/session delete", "/quit"]) {
			assert.deepEqual(await client.sendPrompt(denied), { ok: false, reason: SLASH_DENIED_SENTENCE }, denied);
		}
		assert.deepEqual(await client.sendPrompt("/branch 3"), { ok: false, reason: REWIND_ARGUMENTS_SENTENCE }, "Rewind's alias with arguments says how to rewind");
		assert.equal(sent.length, 0);
		// An unknown command and a pasted path are ordinary text to OMP, so they are sent.
		assert.equal((await client.sendPrompt("/usr/bin/x fails")).ok, true);
		assert.equal((await client.sendPrompt("/review the diff")).ok, true);
		assert.equal(sent.length, 2);
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
		client.handle({ type: "omp:chat-display-preferences", epoch: EPOCH, toolCallDetail: "overview", accessibilitySupport: false, thinkingExpanded: true, toolsExpanded: true });
		assert.deepEqual(client.getDisplayPreferences(), { toolCallDetail: "overview", accessibilitySupport: false, thinkingExpanded: true, toolsExpanded: true });
	});
});
