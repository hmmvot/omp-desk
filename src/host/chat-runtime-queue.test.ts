/**
 * Queued-message editing through the host chat runtime, over the real `RpcSession` on an in-memory channel.
 *
 * Pinned behavior: the page's model carries OMP's own queue readback (`get_state`, `queue_update`), text
 * untouched; a cancel and an edit send exactly `remove_queued_message` per item, in order, and a removal
 * answers the asking page with one result per item; a message OMP delivered before the command ran is
 * `gone` (never dropped or removed twice); a lost answer is `unknown`; images travel only for an edit and a
 * route that cannot carry them still receives the text.
 *
 * Runner: `node --test src/host/chat-runtime-queue.test.ts`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChatEpoch } from "../chat/model.ts";
import type { ChatHostMessage, ChatQueueRemoveMessage, ChatQueueResultMessage } from "../webview/chat-messages.ts";
import { ChatClient } from "../webview/lib/chat-client.ts";
import type { GuestWebviewMessage } from "../webview/messages.ts";
import { ChatRuntime } from "./chat-runtime.ts";
import type { ChatPage } from "./chat-runtime.ts";
import { FakeRpcChannel } from "./rpc/fake-channel.ts";
import { RpcSession } from "./rpc/session.ts";
import { ManualTimers, tick, waitUntil } from "./rpc/test-support.ts";

const TAB = "tab:queue";
const SESSION_FILE = "D:\\scratch\\queue.jsonl";
const PNG = "iVBORw0KGgo=";

class RecordingPage implements ChatPage {
	readonly messages: ChatHostMessage[] = [];
	answer: (message: ChatHostMessage) => "sent" | "too-large" | "dropped" = () => "sent";
	readonly id: string;
	constructor(id: string) {
		this.id = id;
	}

	post(message: ChatHostMessage): "sent" | "too-large" | "dropped" {
		const answer = this.answer(message);
		if (answer === "sent") this.messages.push(message);
		return answer;
	}

	results(): ChatQueueResultMessage[] {
		return this.messages.filter((message): message is ChatQueueResultMessage => message.type === "omp:chat-queue-result");
	}
}

/** A live conversation over a scripted child; `setup` runs before the session starts (to script `get_state`). */
async function liveRig(setup?: (channel: FakeRpcChannel) => void) {
	const timers = new ManualTimers();
	const runtime = new ChatRuntime({
		hostNonce: "host-q",
		onEvent: () => {},
		newSnapshotId: () => "snap",
		createSession: options => new RpcSession({ ...options, timers, fileExists: async () => true }),
	});
	const channel = new FakeRpcChannel({ sessionFile: SESSION_FILE });
	setup?.(channel);
	const session = runtime.startLive(TAB, { channel, sessionFile: null, cwd: "D:\\scratch", title: null });
	await waitUntil(() => session.phase === "live");
	assert.equal(session.phase, "live");
	await tick();
	return { runtime, channel, session };
}

function remove(epoch: ChatEpoch, purpose: "cancel" | "edit", items: ChatQueueRemoveMessage["items"], requestId = "q-req-1"): ChatQueueRemoveMessage {
	return { type: "omp:chat-queue-remove", requestId, epoch, purpose, items };
}

/** OMP's `remove_queued_message`: answers per message text from a script of `removed` verdicts. */
function scriptRemoval(channel: FakeRpcChannel, verdicts: Record<string, { removed: boolean; images?: unknown[] }>): void {
	channel.handlers.set("remove_queued_message", command => ({ data: verdicts[String(command.message)] ?? { removed: false } }));
}

describe("the queue readback", () => {
	it("reaches the page exactly as OMP reported it — steering and follow-up, in order, text untouched", async () => {
		const { runtime, channel } = await liveRig();
		const client = new ChatClient({ post: () => true });
		runtime.attachPage(TAB, { id: "editor", post: message => { client.handle(message); return "sent"; } });
		const odd = "line one\r\n\ttabbed \u0007 bell  and  spaces";
		channel.emit({ type: "queue_update", steering: ["first", odd], followUp: ["later"] });
		await tick();
		assert.deepEqual(client.getSnapshot().state?.queuedMessages, { steering: ["first", odd], followUp: ["later"] });
		assert.equal(client.getSnapshot().state?.queuedMessageCount, 3);
		channel.emit({ type: "queue_update", steering: [], followUp: [] });
		await tick();
		assert.deepEqual(client.getSnapshot().state?.queuedMessages, { steering: [], followUp: [] });
	});

	it("is read from get_state when the conversation attaches, and replaced by the next queue_update", async () => {
		const { runtime, channel } = await liveRig(early => {
			early.handlers.set("get_state", () => ({ data: { isStreaming: true, isCompacting: false, queuedMessageCount: 2, queuedMessages: { steering: ["a"], followUp: ["b"] }, sessionId: "s", sessionFile: SESSION_FILE, isSettled: false, model: null, thinkingLevel: "low" } }));
		});
		const client = new ChatClient({ post: () => true });
		runtime.attachPage(TAB, { id: "editor", post: message => { client.handle(message); return "sent"; } });
		assert.deepEqual(client.getSnapshot().state?.queuedMessages, { steering: ["a"], followUp: ["b"] });
		channel.emit({ type: "queue_update", steering: [], followUp: ["b"] });
		await tick();
		assert.deepEqual(client.getSnapshot().state?.queuedMessages, { steering: [], followUp: ["b"] });
	});
});

describe("cancelling and editing queued messages", () => {
	it("a cancel sends one remove_queued_message for the item's own queue and text, and the page is told it was removed", async () => {
		const { runtime, channel, session } = await liveRig();
		const page = new RecordingPage("editor");
		runtime.attachPage(TAB, page);
		scriptRemoval(channel, { later: { removed: true } });
		const outcome = await runtime.handleMessage(TAB, remove(session.epoch, "cancel", [{ queue: "followUp", text: "later" }]), page);
		assert.equal(outcome, "accepted");
		assert.deepEqual(channel.commandsOfType("remove_queued_message").map(({ message, queue }) => ({ message, queue })), [{ message: "later", queue: "followUp" }]);
		assert.deepEqual(page.results().map(result => ({ purpose: result.purpose, results: result.results })), [{ purpose: "cancel", results: [{ status: "removed" }] }]);
	});

	it("an edit of several messages removes them one by one in the order given and hands back text and images", async () => {
		const { runtime, channel, session } = await liveRig();
		const page = new RecordingPage("editor");
		runtime.attachPage(TAB, page);
		scriptRemoval(channel, { steer: { removed: true }, "see [Image #1, 4x4]": { removed: true, images: [{ type: "image", mimeType: "image/png", data: PNG }] }, last: { removed: true } });
		const items = [{ queue: "steering" as const, text: "steer" }, { queue: "followUp" as const, text: "see [Image #1, 4x4]" }, { queue: "followUp" as const, text: "last" }];
		assert.equal(await runtime.handleMessage(TAB, remove(session.epoch, "edit", items), page), "accepted");
		assert.deepEqual(channel.commandsOfType("remove_queued_message").map(command => command.message), ["steer", "see [Image #1, 4x4]", "last"]);
		assert.deepEqual(page.results()[0]?.results, [
			{ status: "removed" },
			{ status: "removed", images: [{ type: "image", mimeType: "image/png", data: PNG }] },
			{ status: "removed" },
		]);
	});

	it("a cancel never carries the removed message's images back", async () => {
		const { runtime, channel, session } = await liveRig();
		const page = new RecordingPage("editor");
		runtime.attachPage(TAB, page);
		scriptRemoval(channel, { pic: { removed: true, images: [{ type: "image", mimeType: "image/png", data: PNG }] } });
		await runtime.handleMessage(TAB, remove(session.epoch, "cancel", [{ queue: "steering", text: "pic" }]), page);
		assert.deepEqual(page.results()[0]?.results, [{ status: "removed" }]);
	});

	it("reports a message OMP delivered before the command ran as gone, and never as removed", async () => {
		const { runtime, channel, session } = await liveRig();
		const page = new RecordingPage("editor");
		runtime.attachPage(TAB, page);
		scriptRemoval(channel, { kept: { removed: true }, delivered: { removed: false } });
		const outcome = await runtime.handleMessage(TAB, remove(session.epoch, "edit", [{ queue: "followUp", text: "delivered" }, { queue: "followUp", text: "kept" }]), page);
		assert.equal(outcome, "accepted");
		assert.deepEqual(page.results()[0]?.results.map(result => result.status), ["gone", "removed"]);
		assert.equal(channel.commandsOfType("remove_queued_message").length, 2, "one command per item, none repeated");
	});

	it("reports an unanswered removal as unknown and the command as unconfirmed — the text is not assumed gone or kept", async () => {
		const { runtime, channel, session } = await liveRig();
		const page = new RecordingPage("editor");
		runtime.attachPage(TAB, page);
		channel.handlers.set("remove_queued_message", () => ({}));
		const outcome = await runtime.handleMessage(TAB, remove(session.epoch, "edit", [{ queue: "followUp", text: "maybe" }]), page);
		assert.equal(outcome, "unconfirmed");
		assert.deepEqual(page.results()[0]?.results, [{ status: "unknown" }]);
	});

	it("a command OMP refuses (no such command) leaves the message queued and says so per item", async () => {
		const { runtime, channel, session } = await liveRig();
		const page = new RecordingPage("editor");
		runtime.attachPage(TAB, page);
		channel.handlers.set("remove_queued_message", () => ({ success: false, error: "unknown command" }));
		await runtime.handleMessage(TAB, remove(session.epoch, "cancel", [{ queue: "steering", text: "x" }]), page);
		assert.deepEqual(page.results()[0]?.results, [{ status: "failed" }]);
	});

	it("answers a repeated request id from the first outcome without sending a second command", async () => {
		const { runtime, channel, session } = await liveRig();
		const page = new RecordingPage("editor");
		runtime.attachPage(TAB, page);
		scriptRemoval(channel, { once: { removed: true } });
		const message = remove(session.epoch, "cancel", [{ queue: "followUp", text: "once" }]);
		await runtime.handleMessage(TAB, message, page);
		await runtime.handleMessage(TAB, message, page);
		assert.equal(channel.commandsOfType("remove_queued_message").length, 1);
	});

	it("ignores a removal from another epoch without touching the queue", async () => {
		const { runtime, channel } = await liveRig();
		const page = new RecordingPage("editor");
		runtime.attachPage(TAB, page);
		const outcome = await runtime.handleMessage(TAB, remove({ nonce: "other", counter: 9 }, "cancel", [{ queue: "steering", text: "x" }]), page);
		assert.equal(outcome, "ignored");
		assert.equal(channel.commandsOfType("remove_queued_message").length, 0);
		assert.deepEqual(page.results()[0]?.results, [{ status: "failed" }], "the asking page is told it is still queued");
	});

	it("refuses while the conversation cannot accept input, answers the page per item, and sends nothing", async () => {
		const { runtime, channel, session } = await liveRig();
		const page = new RecordingPage("editor");
		runtime.attachPage(TAB, page);
		session.setMutationFence("switching");
		const outcome = await runtime.handleMessage(TAB, remove(session.epoch, "cancel", [{ queue: "steering", text: "x" }]), page);
		assert.equal(outcome, "refused");
		assert.equal(channel.commandsOfType("remove_queued_message").length, 0);
		assert.deepEqual(page.results()[0]?.results, [{ status: "failed" }]);
	});

	it("resends a result a route cannot carry without its images, flagged — the text still arrives", async () => {
		const { runtime, channel, session } = await liveRig();
		const page = new RecordingPage("editor");
		runtime.attachPage(TAB, page);
		page.answer = message => (message.type === "omp:chat-queue-result" && JSON.stringify(message).includes(PNG) ? "too-large" : "sent");
		scriptRemoval(channel, { "big [Image #1]": { removed: true, images: [{ type: "image", mimeType: "image/png", data: PNG }] } });
		assert.equal(await runtime.handleMessage(TAB, remove(session.epoch, "edit", [{ queue: "followUp", text: "big [Image #1]" }]), page), "accepted");
		assert.deepEqual(page.results()[0]?.results, [{ status: "removed", imagesDropped: true }]);
	});

	it("answers only the asking route, and reports unconfirmed when that route cannot take the answer", async () => {
		const { runtime, channel, session } = await liveRig();
		const asking = new RecordingPage("asking");
		const other = new RecordingPage("other");
		runtime.attachPage(TAB, asking);
		runtime.attachPage(TAB, other);
		scriptRemoval(channel, { m: { removed: true }, n: { removed: true } });
		assert.equal(await runtime.handleMessage(TAB, remove(session.epoch, "edit", [{ queue: "followUp", text: "m" }], "q-req-a"), asking), "accepted");
		assert.equal(asking.results().length, 1);
		assert.equal(other.results().length, 0, "another route has no pending request to settle, so it is not sent the answer");
		asking.answer = () => "dropped";
		assert.equal(await runtime.handleMessage(TAB, remove(session.epoch, "edit", [{ queue: "followUp", text: "n" }], "q-req-b"), asking), "unconfirmed");
		assert.equal(other.results().length, 0);
	});

	it("answers with the request's own epoch and carries no message text, so the answer stays small", async () => {
		const { runtime, channel, session } = await liveRig();
		const page = new RecordingPage("editor");
		runtime.attachPage(TAB, page);
		const big = "x".repeat(20_000);
		scriptRemoval(channel, { [big]: { removed: true } });
		const request = remove(session.epoch, "cancel", [{ queue: "followUp", text: big }]);
		await runtime.handleMessage(TAB, request, page);
		const [answer] = page.results();
		assert.deepEqual(answer?.epoch, request.epoch);
		assert.ok(JSON.stringify(answer).length < 500);
	});

	it("sends nothing after an unanswered command: later items stay queued and the request is bounded to one command timeout", async () => {
		const { runtime, channel, session } = await liveRig();
		const page = new RecordingPage("editor");
		runtime.attachPage(TAB, page);
		channel.handlers.set("remove_queued_message", () => ({}));
		const items = [{ queue: "steering" as const, text: "first" }, { queue: "followUp" as const, text: "second" }, { queue: "followUp" as const, text: "third" }];
		assert.equal(await runtime.handleMessage(TAB, remove(session.epoch, "edit", items), page), "unconfirmed");
		assert.equal(channel.commandsOfType("remove_queued_message").length, 1);
		assert.deepEqual(page.results()[0]?.results, [{ status: "unknown" }, { status: "failed" }, { status: "failed" }]);
	});
});

describe("the page client", () => {
	it("resolves a removal with the host's per-item answer and reports the already-sent race", async () => {
		const { runtime, channel } = await liveRig();
		const sent: GuestWebviewMessage[] = [];
		let client: ChatClient | null = null;
		const page: ChatPage = { id: "editor", post: message => { client?.handle(message); return "sent"; } };
		client = new ChatClient({ post: message => { sent.push(message); if (message.type === "omp:chat-queue-remove") void runtime.handleMessage(TAB, message, page); return true; } }, { newRequestId: () => "q-client-1" });
		runtime.attachPage(TAB, page);
		scriptRemoval(channel, { a: { removed: true }, b: { removed: false } });
		const outcome = await client.removeQueued("edit", [{ queue: "steering", text: "a" }, { queue: "followUp", text: "b" }]);
		assert.equal(outcome.ok, true);
		assert.deepEqual(outcome.ok ? outcome.results.map(result => result.status) : [], ["removed", "gone"]);
		assert.equal(sent[0]?.type, "omp:chat-queue-remove");
	});
});
