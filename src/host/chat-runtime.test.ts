/**
 * The host chat runtime: what a page is told, what a command may do, and what the extension
 * hears about a conversation, over the real `RpcSession` on an in-memory channel.
 *
 * Pinned behavior: a page attached to a live conversation receives its state and one
 * authoritative snapshot (reassembling to the conversation's rows, in the conversation's epoch);
 * a command while the conversation cannot accept input is refused with the fixed sentence and
 * never reaches the child; a view-only conversation is read from history and asks the extension
 * to resume on the page's request; a route that refuses a message for its size is re-sent an
 * authoritative snapshot in chunks that fit; identity, `open_url` and state reach the extension;
 * and a detached route stops receiving while the others and the conversation carry on.
 *
 * Runner: `node --test src/host/chat-runtime.test.ts`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createChatModel, setChatPhase, snapshotOf } from "../chat/model.ts";
import type { ChatEpoch } from "../chat/model.ts";
import { ChatSnapshotAssembler } from "../webview/chat-messages.ts";
import type { ChatHostMessage, ChatSnapshotChunkMessage, ChatSnapshotMessage } from "../webview/chat-messages.ts";
import { ChatClient } from "../webview/lib/chat-client.ts";
import { CHAT_ALREADY_RUNNING_SENTENCE, CHAT_NOT_LIVE_SENTENCE, ChatRuntime } from "./chat-runtime.ts";
import type { ChatPage, ChatRuntimeEvent, ChatRuntimeOptions } from "./chat-runtime.ts";
import { settingsSessionApply } from "./omp-settings-apply.ts";
import { FakeRpcChannel } from "./rpc/fake-channel.ts";
import type { FakeChildModel } from "./rpc/fake-channel.ts";
import type { HistoryReader } from "./rpc/history-reader.ts";
import { RpcSession } from "./rpc/session.ts";
import type { readViewOnlySnapshot } from "./rpc/session.ts";
import { ManualTimers, assistantMessage, messageEntry, tick, userMessage, waitUntil } from "./rpc/test-support.ts";

const TAB = "tab:one";
const SESSION_FILE = "D:\\scratch\\chat.jsonl";

/** A route that records what it is sent; `refuse` decides what the route answers per message. */
class RecordingPage implements ChatPage {
	readonly messages: ChatHostMessage[] = [];
	refuse: (message: ChatHostMessage) => "sent" | "too-large" | "dropped" = () => "sent";
	readonly id: string;
	readonly maxChunkBytes?: number;
	/** Set by a test before attaching to make the route read-only. */
	readOnlyReason?: () => string | null;
	constructor(id: string, maxChunkBytes?: number) {
		this.id = id;
		if (maxChunkBytes !== undefined) this.maxChunkBytes = maxChunkBytes;
	}

	post(message: ChatHostMessage): "sent" | "too-large" | "dropped" {
		const answer = this.refuse(message);
		if (answer === "sent") this.messages.push(message);
		return answer;
	}

	ofType<T extends ChatHostMessage["type"]>(type: T): Extract<ChatHostMessage, { type: T }>[] {
		return this.messages.filter((message): message is Extract<ChatHostMessage, { type: T }> => message.type === type);
	}

	/** The notice sentences this route was shown. */
	notices(): string[] {
		return this.ofType("omp:chat-event").flatMap(message => (message.frame.type === "command_feedback" ? [message.frame.message] : []));
	}
}


interface Rig {
	runtime: ChatRuntime;
	channel: FakeRpcChannel;
	events: ChatRuntimeEvent[];
}

const rows = (count: number, size = 1): ReturnType<typeof messageEntry>[] =>
	Array.from({ length: count }, (_, index) => {
		const id = `r${index}`;
		const text = `${id}:${"x".repeat(size)}`;
		return index % 2 === 0
			? messageEntry(id, index === 0 ? null : `r${index - 1}`, userMessage(text, 1000 + index * 10))
			: messageEntry(id, `r${index - 1}`, assistantMessage(text, 1000 + index * 10));
	});

function newRuntime(events: ChatRuntimeEvent[], extra: Pick<ChatRuntimeOptions, "readViewOnly" | "openSettings"> = {}): ChatRuntime {
	let snapshotIds = 0;
	const timers = new ManualTimers();
	return new ChatRuntime({
		hostNonce: "host-a",
		onEvent: (tabId, event) => {
			assert.equal(tabId, TAB);
			events.push(event);
		},
		newSnapshotId: () => `snap-${++snapshotIds}`,
		createSession: options => new RpcSession({ ...options, timers, fileExists: async () => true }),
		...extra,
	});
}

/** A live conversation of a *new* session over a scripted child, driven to `live`. */
async function liveRig(child: Partial<FakeChildModel> = {}, extra: Pick<ChatRuntimeOptions, "openSettings"> = {}): Promise<Rig> {
	const events: ChatRuntimeEvent[] = [];
	const runtime = newRuntime(events, extra);
	const channel = new FakeRpcChannel({ sessionFile: SESSION_FILE, ...child });
	const session = runtime.startLive(TAB, { channel, sessionFile: null, cwd: "D:\\scratch", title: null });
	await waitUntil(() => session.phase === "live");
	assert.equal(session.phase, "live");
	await tick();
	return { runtime, channel, events };
}

/** What a route's snapshot messages reassemble to, or `null` when none completed. */
function assembled(page: RecordingPage) {
	const assembler = new ChatSnapshotAssembler();
	let last: ReturnType<ChatSnapshotAssembler["begin"]> = null;
	for (const message of page.messages) {
		if (message.type === "omp:chat-snapshot") last = assembler.begin(message) ?? last;
		else if (message.type === "omp:chat-snapshot-chunk") last = assembler.add(message) ?? last;
	}
	return last;
}

describe("attaching a page to a live conversation", () => {
	it("sends the state and one authoritative snapshot in the conversation's epoch", async () => {
		const entries = rows(4);
		const { runtime } = await liveRig({ entries: entries as never, leafId: "r3" });
		const page = new RecordingPage("editor");
		runtime.attachPage(TAB, page);

		const states = page.ofType("omp:chat-state");
		assert.equal(states.length, 1);
		assert.equal(states[0]?.phase, "live");
		assert.equal(page.ofType("omp:chat-snapshot").length, 1);

		const snapshot = assembled(page);
		assert.ok(snapshot !== null, "the snapshot completed");
		assert.equal(snapshot.phase, "live");
		assert.deepEqual(
			snapshot.entries.map(entry => entry.id),
			["r0", "r1", "r2", "r3"],
		);
		assert.deepEqual(snapshot.epoch, states[0]?.epoch, "state and snapshot name the same epoch");
		assert.equal(snapshot.epoch.nonce.startsWith("host-a"), true);
	});

	it("re-sends both to a route that attaches again under the same id", async () => {
		const { runtime } = await liveRig({ entries: rows(2) as never, leafId: "r1" });
		const first = new RecordingPage("editor");
		runtime.attachPage(TAB, first);
		const reloaded = new RecordingPage("editor");
		runtime.attachPage(TAB, reloaded);
		assert.equal(reloaded.ofType("omp:chat-state").length, 1);
		assert.equal(assembled(reloaded)?.entries.length, 2);
		assert.equal(runtime.hasPage(TAB), true);
	});
});

describe("the composer's authoritative queue count", () => {
	it("follows enqueue and delivery while streaming, then reconciles footer state at settle", async () => {
		const { runtime, channel } = await liveRig({ isStreaming: true });
		const client = new ChatClient({ post: () => true });
		runtime.attachPage(TAB, { id: "editor", post: message => { client.handle(message); return "sent"; } });
		channel.emit({ type: "queue_update", steering: [], followUp: ["later"] });
		await tick();
		assert.equal(client.getSnapshot().state?.queuedMessageCount, 1);
		assert.equal(client.getSnapshot().working, true, "queue updates must not reset the running turn");
		channel.emit({ type: "queue_update", steering: ["steer"], followUp: ["later", "another"] });
		await tick();
		assert.equal(client.getSnapshot().state?.queuedMessageCount, 3);
		channel.emit({ type: "queue_update", steering: [], followUp: [] });
		await tick();
		assert.equal(client.getSnapshot().state?.queuedMessageCount, 0, "delivery clears the chip before settle");
		channel.child.isStreaming = false;
		channel.child.thinkingLevel = "high";
		channel.emit({ type: "session_settled" });
		await tick();
		assert.equal(client.getSnapshot().state?.thinkingLevel, "high", "get_state's footer refresh reaches the page too");
		assert.equal(client.getSnapshot().working, false);
		runtime.dispose();
	});
});

describe("a route that is read-only (a non-controlling editor of the conversation)", () => {
	const REASON = "Another editor controls this session.";

	it("is shown the conversation with its reason, while a controlling route shows none", async () => {
		const { runtime } = await liveRig({ entries: rows(2) as never, leafId: "r1" });
		const controlling = new RecordingPage("editor-a");
		const passive = new RecordingPage("editor-b");
		passive.readOnlyReason = () => REASON;
		runtime.attachPage(TAB, controlling);
		runtime.attachPage(TAB, passive);

		assert.equal(controlling.ofType("omp:chat-state")[0]?.readOnlyReason, null);
		assert.equal(passive.ofType("omp:chat-state")[0]?.readOnlyReason, REASON);
		assert.equal(passive.ofType("omp:chat-state")[0]?.phase, "live", "the conversation itself is unchanged");
		assert.equal(assembled(passive)?.readOnlyReason, REASON);
		assert.equal(assembled(controlling)?.readOnlyReason, null);
		assert.equal(assembled(passive)?.entries.length, 2, "it still shows the whole history");
	});

	it("is refused every write, with its reason, and nothing is written to the channel", async () => {
		const { runtime, channel } = await liveRig();
		const passive = new RecordingPage("editor-b");
		passive.readOnlyReason = () => REASON;
		runtime.attachPage(TAB, passive);
		const before = channel.written.length;

		for (const message of [
			{ type: "omp:chat-prompt", requestId: "r1", text: "hi" },
			{ type: "omp:chat-steer", requestId: "r2", text: "hi" },
			{ type: "omp:chat-follow-up", requestId: "r3", text: "hi" },
			{ type: "omp:chat-abort", requestId: "r4" },
		] as const) {
			assert.equal(await runtime.handleMessage(TAB, message, passive), "refused");
		}
		assert.equal(channel.written.length, before);
		assert.deepEqual(new Set(passive.notices()), new Set([REASON]));
	});

	it("applies a role change on the next command without re-attaching", async () => {
		const { runtime, channel } = await liveRig();
		let reason: string | null = REASON;
		const page = new RecordingPage("editor-a");
		page.readOnlyReason = () => reason;
		runtime.attachPage(TAB, page);
		assert.equal(await runtime.handleMessage(TAB, { type: "omp:chat-prompt", requestId: "r1", text: "hi" }, page), "refused");
		reason = null;
		assert.equal(await runtime.handleMessage(TAB, { type: "omp:chat-prompt", requestId: "r2", text: "hi" }, page), "accepted");
		assert.equal(channel.commandsOfType("prompt").length, 1);
	});
});

describe("a page command while the conversation is not live", () => {
	async function prompt(runtime: ChatRuntime, page: RecordingPage, requestId = "req-1") {
		return await runtime.handleMessage(TAB, { type: "omp:chat-prompt", requestId, text: "hello" }, page);
	}

	it("is written to the channel while live (the control for the cases below)", async () => {
		const { runtime, channel } = await liveRig();
		const page = new RecordingPage("editor");
		runtime.attachPage(TAB, page);
		assert.equal(await prompt(runtime, page), "accepted");
		assert.equal(channel.commandsOfType("prompt").length, 1);
		assert.equal(page.notices().length, 0);
	});

	it("is refused with the not-live sentence, and never written, once the session has failed", async () => {
		const events: ChatRuntimeEvent[] = [];
		const runtime = newRuntime(events);
		// The process serves another file than the one this conversation must resume: identity mismatch.
		const channel = new FakeRpcChannel({ sessionFile: "D:\\scratch\\another.jsonl" });
		const session = runtime.startLive(TAB, { channel, sessionFile: SESSION_FILE, cwd: "D:\\scratch", title: null });
		await waitUntil(() => session.phase === "failed");
		assert.equal(session.phase, "failed");
		const page = new RecordingPage("editor");
		runtime.attachPage(TAB, page);
		const writtenBefore = channel.written.length;

		assert.equal(await prompt(runtime, page), "refused");
		assert.deepEqual(page.notices(), [CHAT_NOT_LIVE_SENTENCE]);
		assert.equal(channel.commandsOfType("prompt").length, 0);
		assert.equal(channel.written.length, writtenBefore, "nothing at all was written for the refused command");
	});

	it("writes a stop to the channel at once, even while the prompt that started the turn is still unanswered", async () => {
		const { runtime, channel } = await liveRig();
		const page = new RecordingPage("editor");
		runtime.attachPage(TAB, page);
		channel.handlers.set("prompt", () => "drop");
		const prompting = runtime.handleMessage(TAB, { type: "omp:chat-prompt", requestId: "req-p", text: "essay" }, page);
		await tick(2);
		assert.equal(channel.commandsOfType("prompt").length, 1);

		assert.equal(await runtime.handleMessage(TAB, { type: "omp:chat-abort", requestId: "req-a" }, page), "accepted");
		assert.equal(channel.commandsOfType("abort").length, 1, "the stop was written while the prompt was pending");
		assert.equal(page.notices().length, 0);
		void prompting;
	});

	it("is refused with the not-live sentence for a view-only conversation, which has no channel to write to", async () => {
		const events: ChatRuntimeEvent[] = [];
		const runtime = newRuntime(events, { readViewOnly: viewOnlyStub });
		await runtime.showViewOnly(TAB, { file: SESSION_FILE, cwd: "D:\\scratch", title: null, reason: "stopped" });
		const page = new RecordingPage("editor");
		runtime.attachPage(TAB, page);

		assert.equal(await prompt(runtime, page), "refused");
		assert.deepEqual(page.notices(), [CHAT_NOT_LIVE_SENTENCE]);
		assert.equal(runtime.sessionOf(TAB), null);
	});

	it("is ignored for a tab that has no conversation", async () => {
		const runtime = newRuntime([]);
		assert.equal(await runtime.handleMessage(TAB, { type: "omp:chat-prompt", requestId: "req-1", text: "x" }, null), "ignored");
	});
});

describe("a page asking to reconnect", () => {
	it("reattaches a failed conversation to its process, and is told why when nothing can be reconnected", async () => {
		const { runtime, channel } = await liveRig();
		const session = runtime.sessionOf(TAB);
		assert.ok(session !== null);
		const page = new RecordingPage("editor");
		runtime.attachPage(TAB, page);
		// Live: the request replaces the connection (a fresh attach), it is not ignored.
		const disconnectsBefore = channel.disconnects;
		await runtime.handleMessage(TAB, { type: "omp:chat-reconnect", requestId: "rc-0" }, page);
		assert.equal(channel.disconnects, disconnectsBefore + 1);

		const events: ChatRuntimeEvent[] = [];
		const refusedRuntime = newRuntime(events);
		const mismatched = new FakeRpcChannel({ sessionFile: "D:\\scratch\\another.jsonl" });
		const failed = refusedRuntime.startLive(TAB, { channel: mismatched, sessionFile: SESSION_FILE, cwd: "D:\\scratch", title: null });
		await waitUntil(() => failed.phase === "failed");
		assert.equal(failed.phase, "failed");
		const failedPage = new RecordingPage("editor");
		refusedRuntime.attachPage(TAB, failedPage);
		assert.equal(await refusedRuntime.handleMessage(TAB, { type: "omp:chat-reconnect", requestId: "rc-1" }, failedPage), "refused");
		assert.deepEqual(failedPage.notices(), [CHAT_NOT_LIVE_SENTENCE]);
		assert.equal(mismatched.disconnects, 0, "a refused reconnect touches nothing");
		runtime.dispose();
		refusedRuntime.dispose();
	});

	it("admits Restart only for unanswered state in the same native generation and a writable editor route", async () => {
		const timers = new ManualTimers();
		const events: ChatRuntimeEvent[] = [];
		const runtime = new ChatRuntime({
			hostNonce: "restart-host", onEvent: (_tab, event) => events.push(event),
			createSession: options => new RpcSession({ ...options, timers, commandTimeoutMs: 10, autoRecoveryDelaysMs: [] }),
		});
		const channel = new FakeRpcChannel();
		const session = runtime.startLive(TAB, { channel, sessionFile: null, cwd: "D:\\scratch", title: null });
		try {
			await session.start();
			const page = new RecordingPage("editor");
			runtime.attachPage(TAB, page);
			const request = { type: "omp:chat-restart" as const, requestId: "restart-1", epoch: session.epoch };
			assert.equal(await runtime.handleMessage(TAB, request, page), "refused");
			channel.handlers.set("get_state", () => "drop");
			session.reconnect(); await tick();
			timers.advance(10); await tick();
			assert.equal(session.nativeStateUnanswered, true);
			page.readOnlyReason = () => "Passive editor";
			assert.equal(await runtime.handleMessage(TAB, request, page), "refused");
			page.readOnlyReason = () => null;
			assert.equal(await runtime.handleMessage(TAB, { ...request, epoch: { nonce: "old-native", counter: 1 } }, page), "refused");
			const commands = channel.written.length;
			assert.equal(await runtime.handleMessage(TAB, request, page), "accepted");
			assert.deepEqual(events.filter(event => event.type === "restart-requested"), [{ type: "restart-requested", nativeNonce: session.epoch.nonce }]);
			assert.equal(channel.written.length, commands, "the lifecycle coordinator, not RPC, owns the recovery operation");
		} finally { runtime.dispose(); }
	});
});

/** A view-only history read that never touches the disk. */
const viewOnlyStub: typeof readViewOnlySnapshot = async (_file, epoch: ChatEpoch, reason) => ({
	snapshot: snapshotOf(setChatPhase(createChatModel(), "view-only", null, reason ?? null), epoch),
	reader: {} as HistoryReader,
});

describe("a view-only conversation", () => {
	it("mounts in the view-only phase with its reason, and asks to resume only on the page's request", async () => {
		const events: ChatRuntimeEvent[] = [];
		const runtime = newRuntime(events, { readViewOnly: viewOnlyStub });
		await runtime.showViewOnly(TAB, { file: SESSION_FILE, cwd: "D:\\scratch", title: "Old", reason: "stopped" });
		const page = new RecordingPage("editor");
		runtime.attachPage(TAB, page);

		assert.equal(runtime.kindOf(TAB), "view-only");
		const state = page.ofType("omp:chat-state")[0];
		assert.equal(state?.phase, "view-only");
		assert.equal(state?.readOnlyReason, "stopped");
		assert.equal(assembled(page)?.phase, "view-only");
		assert.equal(events.some(event => event.type === "resume-requested"), false, "mounting alone resumes nothing");

		assert.equal(await runtime.handleMessage(TAB, { type: "omp:chat-resume", requestId: "req-2" }, page), "accepted");
		assert.equal(events.filter(event => event.type === "resume-requested").length, 1);
	});

	it("allows a stopped editor with no writer authority to request Resume, but still refuses prompts", async () => {
		const events: ChatRuntimeEvent[] = [];
		const runtime = newRuntime(events, { readViewOnly: viewOnlyStub });
		await runtime.showViewOnly(TAB, { file: SESSION_FILE, cwd: "D:\\scratch", title: null, reason: "stopped" });
		const page = new RecordingPage("stopped-editor");
		page.readOnlyReason = () => "This window holds no writer for this stopped session.";
		runtime.attachPage(TAB, page);

		assert.equal(await runtime.handleMessage(TAB, { type: "omp:chat-prompt", requestId: "p", text: "no" }, page), "refused");
		assert.equal(await runtime.handleMessage(TAB, { type: "omp:chat-resume", requestId: "r" }, page), "accepted");
		assert.equal(events.filter(event => event.type === "resume-requested").length, 1);
		assert.equal(runtime.sessionOf(TAB), null, "the request itself grants no writer or channel");
		runtime.dispose();
	});

	it("shows an unreadable history as a failed state, never as a shortened transcript", async () => {
		const events: ChatRuntimeEvent[] = [];
		const runtime = newRuntime(events, {
			readViewOnly: async () => {
				throw new Error("EACCES");
			},
		});
		await runtime.showViewOnly(TAB, { file: SESSION_FILE, cwd: "D:\\scratch", title: null, reason: "stopped" });
		const page = new RecordingPage("editor");
		runtime.attachPage(TAB, page);
		assert.equal(page.ofType("omp:chat-state")[0]?.phase, "failed");
		assert.deepEqual(assembled(page)?.entries, []);
	});

	it("tells a page whose session is running that there is nothing to resume, instead of ignoring it", async () => {
		const { runtime, events } = await liveRig();
		const page = new RecordingPage("editor");
		runtime.attachPage(TAB, page);
		assert.equal(await runtime.handleMessage(TAB, { type: "omp:chat-resume", requestId: "req-3" }, page), "refused");
		assert.equal(events.some(event => event.type === "resume-requested"), false);
		assert.deepEqual(page.notices(), [CHAT_ALREADY_RUNNING_SENTENCE]);
		runtime.dispose();
	});
});

describe("a conversation whose process stopped", () => {
	it("asks the extension to resume when the page's Resume button is used", async () => {
		const { runtime, channel, events } = await liveRig();
		const page = new RecordingPage("editor");
		page.readOnlyReason = () => "This editor is not controlling its session.";
		runtime.attachPage(TAB, page);
		channel.closeLink("child-exited");
		await tick();
		assert.equal(runtime.stateOf(TAB)?.phase, "stopped");
		assert.equal(runtime.kindOf(TAB), "live", "the stopped session is still the live conversation object");

		assert.equal(await runtime.handleMessage(TAB, { type: "omp:chat-resume", requestId: "req-4" }, page), "accepted");
		assert.equal(events.filter(event => event.type === "resume-requested").length, 1);
		assert.deepEqual(page.notices(), [], "an accepted request is not answered with a refusal");
		runtime.dispose();
	});

	it("still asks the extension to resume after the stopped conversation was released", async () => {
		const { runtime, events } = await liveRig();
		const page = new RecordingPage("editor");
		runtime.attachPage(TAB, page);
		runtime.release(TAB);
		assert.equal(await runtime.handleMessage(TAB, { type: "omp:chat-resume", requestId: "req-5" }, page), "accepted");
		assert.equal(events.filter(event => event.type === "resume-requested").length, 1);
		runtime.dispose();
	});

	it("tells every route one sentence when the extension reports why it could not resume", async () => {
		const { runtime } = await liveRig();
		const page = new RecordingPage("editor");
		runtime.attachPage(TAB, page);
		assert.equal(runtime.notify(TAB, "Another live window holds this session."), true);
		assert.deepEqual(page.notices(), ["Another live window holds this session."]);
		runtime.release(TAB);
		assert.equal(runtime.notify(TAB, "no conversation"), false);
		runtime.dispose();
	});
});

describe("a route that refuses a message for its size", () => {
	const CHUNK_BUDGET = 3_000;

	it("is re-sent an authoritative snapshot in chunks that fit, and only that route", async () => {
		const entries = rows(12, 700);
		const { runtime, channel } = await liveRig({ entries: entries as never, leafId: "r11" });
		const small = new RecordingPage("bridge", CHUNK_BUDGET);
		const other = new RecordingPage("editor");
		runtime.attachPage(TAB, small);
		runtime.attachPage(TAB, other);
		const snapshotsBefore = small.ofType("omp:chat-snapshot").length;
		const otherBefore = other.ofType("omp:chat-snapshot").length;

		// The bridge cannot carry this handled-command output as one message.
		small.refuse = message => (message.type === "omp:chat-event" && JSON.stringify(message).length > CHUNK_BUDGET ? "too-large" : "sent");
		channel.emit({ type: "command_output", text: "n".repeat(CHUNK_BUDGET * 2) });
		await tick();

		const snapshots = small.ofType("omp:chat-snapshot");
		assert.equal(snapshots.length, snapshotsBefore + 1, "one resend for the refused message");
		assert.equal(other.ofType("omp:chat-snapshot").length, otherBefore, "a route that carried the message needs no resend");

		const resent = snapshots[snapshots.length - 1] as ChatSnapshotMessage;
		const chunks = small
			.ofType("omp:chat-snapshot-chunk")
			.filter((chunk): chunk is ChatSnapshotChunkMessage => chunk.snapshotId === resent.snapshotId);
		assert.equal(chunks.length, resent.chunks);
		assert.ok(chunks.length > 1, "the rows did not fit in one chunk");
		for (const chunk of chunks) {
			const oversized = JSON.stringify(chunk.entries).length > CHUNK_BUDGET && chunk.entries.length > 1;
			assert.equal(oversized, false, "a chunk holds more than one row beyond the route's budget");
		}
		assert.deepEqual(
			assembled(small)?.entries.map(entry => entry.id),
			entries.map(entry => entry.id),
			"the reassembled snapshot holds every row",
		);
	});
});

describe("what the extension is told", () => {
	it("hears the identity a new session serves, once, and the live state", async () => {
		const { events } = await liveRig({ sessionId: "sess-new" });
		assert.deepEqual(
			events.filter(event => event.type === "identity"),
			[{ type: "identity", sessionFile: SESSION_FILE, sessionId: "sess-new" }],
		);
		const phases = events.flatMap(event => (event.type === "state" ? [event.payload.phase] : []));
		assert.equal(phases.at(-1), "live");
	});

	it("hears an open_url request with its instructions, without any page being attached", async () => {
		const { channel, events, runtime } = await liveRig();
		assert.equal(runtime.hasPage(TAB), false);
		channel.emit({ type: "extension_ui_request", id: "o1", method: "open_url", url: "https://example.test/login", instructions: "sign in" });
		await tick();
		const opened = events.filter(event => event.type === "open-url");
		assert.equal(opened.length, 1);
		assert.equal(opened[0]?.type === "open-url" && opened[0].url, "https://example.test/login");
		assert.equal(opened[0]?.type === "open-url" && opened[0].instructions, "sign in");
	});

	it("reports the first model after a live snapshot as the baseline, and later ones as changes", async () => {
		const { channel, events } = await liveRig();
		const models = () => events.flatMap(event => (event.type === "model" ? [event.baseline] : []));
		assert.equal(models().filter(baseline => baseline).length, 1);
		channel.emitMessage("message_end", "m-1", assistantMessage("later", 5000) as never);
		await tick();
		assert.equal(models().filter(baseline => baseline).length, 1, "only one baseline per snapshot");
		assert.equal(models().at(-1), false);
	});

	it("a live history rewrite preserves fresh completion notification eligibility instead of becoming an attach baseline", async () => {
		const { channel, events, runtime } = await liveRig();
		const page = new RecordingPage("live-history");
		runtime.attachPage(TAB, page);
		channel.child.entries = [messageEntry("history-reply", null, assistantMessage("Durable reply", 6000))] as never;
		channel.child.leafId = "history-reply";
		channel.emit({ type: "session_settled" });
		await tick(20);
		assert.deepEqual(assembled(page)?.entries.map(entry => entry.id), ["history-reply"]);
		const models = events.filter((event): event is Extract<ChatRuntimeEvent, { type: "model" }> => event.type === "model");
		assert.equal(models.filter(event => event.baseline).length, 1);
		assert.equal(models.at(-1)?.baseline, false);
		runtime.dispose();
	});
});

describe("detaching a page", () => {
	it("stops delivery to that route only, while the conversation and the other route carry on", async () => {
		const { runtime, channel } = await liveRig();
		const leaving = new RecordingPage("leaving");
		const staying = new RecordingPage("staying");
		const detach = runtime.attachPage(TAB, leaving);
		runtime.attachPage(TAB, staying);

		detach();
		const before = { leaving: leaving.messages.length, staying: staying.messages.length };
		channel.emit({ type: "command_output", text: "after detach" });
		await tick();

		assert.equal(leaving.messages.length, before.leaving);
		const shown = staying.ofType("omp:chat-event").flatMap(message => (message.frame.type === "command_output" ? [message.frame.text] : []));
		assert.deepEqual(shown, ["after detach"]);
		assert.equal(runtime.hasPage(TAB), true);
		assert.equal(runtime.kindOf(TAB), "live");
	});

	it("does not detach a route that replaced the one whose detach function is called late", async () => {
		const { runtime } = await liveRig();
		const stale = runtime.attachPage(TAB, new RecordingPage("editor"));
		const current = new RecordingPage("editor");
		runtime.attachPage(TAB, current);
		stale();
		assert.equal(runtime.hasPage(TAB), true, "the reloaded document's route is still attached");
	});
});

describe("native Models and Agents settings", () => {
	it("opens from prompt, steering and follow-up routes without sending an OMP prompt, even on read-only routes", async () => {
		const opened: string[] = [];
		const { runtime, channel } = await liveRig({}, { openSettings: async (kind, tabId) => { opened.push(`${tabId}:${kind}`); } });
		const page = new RecordingPage("settings-source");
		page.readOnlyReason = () => "view-only route";
		runtime.attachPage(TAB, page);
		for (const [index, type] of ["omp:chat-prompt", "omp:chat-steer", "omp:chat-follow-up"].entries()) {
			assert.equal(await runtime.handleMessage(TAB, { type: type as "omp:chat-prompt", requestId: `settings-${index}`, text: index === 1 ? "/agents ignored" : "/models" }, page), "accepted");
		}
		assert.deepEqual(opened, [`${TAB}:models`, `${TAB}:agents`, `${TAB}:models`]);
		for (const type of ["prompt", "steer", "follow_up"]) assert.equal(channel.commandsOfType(type).length, 0);
	});
	it("opens once across duplicate routes and passes model selector arguments through unchanged", async () => {
		let opened = 0;
		const { runtime, channel } = await liveRig({}, { openSettings: async () => { opened += 1; } });
		const first = new RecordingPage("one"); const second = new RecordingPage("two");
		runtime.attachPage(TAB, first); runtime.attachPage(TAB, second);
		const request = { type: "omp:chat-prompt" as const, requestId: "settings-once", text: "/model" };
		await Promise.all([runtime.handleMessage(TAB, request, first), runtime.handleMessage(TAB, request, second)]);
		assert.equal(opened, 1);
		assert.equal(await runtime.handleMessage(TAB, { ...request, requestId: "model-argument", text: "/models p/m" }, first), "accepted");
		assert.equal(channel.commandsOfType("prompt")[0]?.message, "/models p/m");
	});
	it("failed native opening never falls back to model prompting", async () => {
		const { runtime, channel } = await liveRig({}, { openSettings: async () => { throw new Error("unavailable"); } });
		assert.equal(await runtime.handleMessage(TAB, { type: "omp:chat-prompt", requestId: "settings-failure", text: "/agents" }, new RecordingPage("failure")), "refused");
		assert.equal(channel.commandsOfType("prompt").length, 0);
	});
	it("applies only to the bound live idle session and confirms actual model/thinking by get_state", async () => {
		const { runtime, channel } = await liveRig();
		const session = runtime.sessionOf(TAB); assert.ok(session);
		let current = true;
		const apply = settingsSessionApply(session, () => current);
		channel.handlers.set("get_available_models", () => ({ data: { models: [{ provider: "p", id: "target", name: "Target" }] } }));
		channel.handlers.set("set_model", command => { channel.child.model = { provider: command.provider, id: command.modelId, name: "Target" }; return { data: channel.child.model }; });
		channel.handlers.set("set_thinking_level", command => { channel.child.thinkingLevel = String(command.level); return {}; });
		assert.match(await apply({ provider: "p", id: "target", thinking: "high" }), /confirmed by OMP readback/);
		assert.equal(channel.child.model?.id, "target"); assert.equal(channel.child.thinkingLevel, "high");
		const writes = channel.commandsOfType("set_model").length;
		assert.match(await apply({ provider: "p", id: "target", thinking: "auto" }), /Not applied/);
		current = false;
		await apply({ provider: "p", id: "target" });
		assert.equal(channel.commandsOfType("set_model").length, writes);
	});
});
