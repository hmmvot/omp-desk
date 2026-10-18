/**
 * `/btw` side questions through the host chat runtime over the real `RpcSession` on an in-memory channel
 * (docs/designs/2026-10-19-chat-btw-side-questions.md): a typed `/btw` is never sent to OMP as a prompt, a question is asked as a side
 * question, frames reach every page and never the transcript, and every panel request is answered.
 *
 * Runner: `node --test src/host/chat-runtime-btw.test.ts`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BTW_REFUSALS } from "../chat/btw.ts";
import type { ChatHostMessage } from "../protocol/chat-messages.ts";
import { ChatRuntime } from "./chat-runtime.ts";
import type { ChatPage, ChatRuntimeEvent } from "./chat-runtime.ts";
import { FakeRpcChannel } from "./rpc/fake-channel.ts";
import { RpcSession } from "./rpc/session.ts";
import { ManualTimers, tick, waitUntil } from "./rpc/test-support.ts";

const TAB = "tab:btw";
const SESSION_FILE = "D:\\scratch\\btw.jsonl";

class Page implements ChatPage {
	readonly messages: ChatHostMessage[] = [];
	readonly id: string;
	constructor(id: string) { this.id = id; }
	post(message: ChatHostMessage): "sent" { this.messages.push(message); return "sent"; }
	ofType<T extends ChatHostMessage["type"]>(type: T): Extract<ChatHostMessage, { type: T }>[] {
		return this.messages.filter((message): message is Extract<ChatHostMessage, { type: T }> => message.type === type);
	}
	notices(): string[] {
		return this.ofType("omp:chat-event").flatMap(message => (message.frame.type === "command_feedback" ? [message.frame.message] : []));
	}
}

const record = (id: string, patch: Record<string, unknown> = {}) => ({ id, leafId: null, question: "why?", answer: "", status: "running", createdAt: 100, updatedAt: 100, ...patch });

async function rig(history: unknown[] = []) {
	const events: ChatRuntimeEvent[] = [];
	const runtime = new ChatRuntime({
		hostNonce: "host-btw",
		onEvent: (_tab, event) => { events.push(event); },
		createSession: options => new RpcSession({ ...options, timers: new ManualTimers(), fileExists: async () => true }),
	});
	const channel = new FakeRpcChannel({ sessionFile: SESSION_FILE });
	channel.handlers.set("get_btw_history", () => ({ data: { records: history } }));
	channel.handlers.set("btw", command => {
		channel.emit({ type: "btw_record", record: record("r1", { question: String(command.question) }) });
		return { data: { record: record("r1", { question: String(command.question) }) } };
	});
	channel.handlers.set("btw_cancel", () => ({ data: { cancelled: true } }));
	const session = runtime.startLive(TAB, { channel, sessionFile: null, cwd: "D:\\scratch", title: null });
	await waitUntil(() => session.phase === "live");
	await waitUntil(() => channel.commandsOfType("get_btw_history").length === 1);
	await tick();
	const page = new Page("editor");
	runtime.attachPage(TAB, page);
	await tick();
	return { runtime, channel, session, page };
}

const prompts = (channel: FakeRpcChannel) => ["prompt", "steer", "follow_up"].flatMap(type => channel.commandsOfType(type));

describe("a typed /btw", () => {
	it("is a side question, never a prompt: one btw command, answered explained, the record reaches the page and no transcript row appears", async () => {
		const { runtime, channel, page } = await rig();
		const eventsBefore = page.ofType("omp:chat-event").length;
		assert.equal(await runtime.handleMessage(TAB, { type: "omp:chat-prompt", requestId: "q-1", text: "  /btw why is it slow?  " }, page), "explained");
		assert.deepEqual(channel.commandsOfType("btw").map(command => command.question), ["why is it slow?"]);
		assert.deepEqual(prompts(channel), []);
		await tick();
		const last = page.ofType("omp:chat-btw").at(-1)!;
		assert.equal(last.replace, false);
		assert.equal(last.records[0]!.id, "r1");
		assert.equal(page.ofType("omp:chat-event").length, eventsBefore, "a side question adds no chat event");
		runtime.dispose();
	});

	it("takes the same path while a turn runs (steer and follow-up) and a repeated request id asks once", async () => {
		const { runtime, channel, page } = await rig();
		assert.equal(await runtime.handleMessage(TAB, { type: "omp:chat-steer", requestId: "q-2", text: "/btw during a turn" }, page), "explained");
		assert.equal(await runtime.handleMessage(TAB, { type: "omp:chat-steer", requestId: "q-2", text: "/btw during a turn" }, page), "explained");
		assert.equal(channel.commandsOfType("btw").length, 1);
		assert.deepEqual(prompts(channel), []);
		runtime.dispose();
	});

	it("is refused with a fixed sentence when OMP refuses, keeping the draft (refused)", async () => {
		const { runtime, channel, page } = await rig();
		channel.handlers.set("btw", () => ({ success: false, error: "A /btw question is still running; cancel it first" }));
		assert.equal(await runtime.handleMessage(TAB, { type: "omp:chat-prompt", requestId: "q-3", text: "/btw again" }, page), "refused");
		assert.deepEqual(page.notices(), [BTW_REFUSALS.busy]);
		runtime.dispose();
	});

	it("with images or past the length limit asks nothing and says why", async () => {
		const { runtime, channel, page } = await rig();
		const image = { type: "image" as const, mimeType: "image/png", data: "AAAA" };
		assert.equal(await runtime.handleMessage(TAB, { type: "omp:chat-prompt", requestId: "q-4", text: "/btw look", images: [image] }, page), "refused");
		assert.equal(await runtime.handleMessage(TAB, { type: "omp:chat-prompt", requestId: "q-5", text: `/btw ${"x".repeat(8_001)}` }, page), "refused");
		assert.deepEqual(page.notices(), [BTW_REFUSALS.images, BTW_REFUSALS["too-long"]]);
		assert.deepEqual(channel.commandsOfType("btw"), []);
		runtime.dispose();
	});

	it("with no question posts OMP's history, asking the pages to show the list", async () => {
		const { runtime, page } = await rig([record("h1", { status: "complete", answer: "done" })]);
		assert.equal(await runtime.handleMessage(TAB, { type: "omp:chat-prompt", requestId: "q-6", text: "/btw" }, page), "explained");
		await tick();
		const last = page.ofType("omp:chat-btw").at(-1)!;
		assert.equal(last.replace, true);
		assert.equal(last.show, "history");
		assert.deepEqual(last.records.map(item => item.id), ["h1"]);
		runtime.dispose();
	});
});

describe("the side-question frames", () => {
	it("reach every page as records and deltas, and the history-save notice is not a transcript row", async () => {
		const { runtime, channel, page } = await rig();
		const second = new Page("second");
		runtime.attachPage(TAB, second);
		await tick();
		channel.emit({ type: "btw_record", record: record("r9") });
		channel.emit({ type: "btw_delta", recordId: "r9", delta: "hel" });
		channel.emit({ type: "btw_delta", recordId: "r9", delta: "lo" });
		channel.emit({ type: "notice", level: "error", message: "/btw answer r9 was not saved: EACCES", source: "btw-history" });
		await tick();
		for (const each of [page, second]) {
			assert.deepEqual(each.ofType("omp:chat-btw-delta").map(delta => [delta.at, delta.delta]), [[0, "hel"], [3, "lo"]]);
			assert.equal(each.ofType("omp:chat-event").some(event => JSON.stringify(event.frame).includes("not saved")), false);
		}
		runtime.dispose();
	});

	it("follow every snapshot as a replace of what OMP holds, so a page that attaches later sees the running answer", async () => {
		const { runtime } = await rig([record("run", { answer: "partial" })]);
		const late = new Page("late");
		runtime.attachPage(TAB, late);
		await tick();
		const types = late.messages.map(message => message.type);
		const replace = late.ofType("omp:chat-btw")[0]!;
		assert.equal(replace.replace, true);
		assert.equal(replace.records[0]!.turns[0]!.answer, "partial");
		assert.ok(types.indexOf("omp:chat-btw") > types.indexOf("omp:chat-snapshot"), "after the snapshot it belongs to");
		runtime.dispose();
	});
});

describe("a panel request", () => {
	const epochOf = (runtime: ChatRuntime) => runtime.sessionOf(TAB)!.epoch;

	it("ask, cancel and history are each answered by request id", async () => {
		const { runtime, channel, page } = await rig();
		const epoch = epochOf(runtime);
		const rid = (n: number) => String(n).repeat(32);
		assert.equal(await runtime.handleMessage(TAB, { type: "omp:chat-btw-request", requestId: rid(1), epoch, op: "ask", question: "and?", recordId: "r1" }, page), "accepted");
		assert.deepEqual(channel.commandsOfType("btw").at(-1)!.recordId, "r1");
		assert.equal(await runtime.handleMessage(TAB, { type: "omp:chat-btw-request", requestId: rid(2), epoch, op: "cancel", recordId: "r1" }, page), "accepted");
		assert.equal(await runtime.handleMessage(TAB, { type: "omp:chat-btw-request", requestId: rid(3), epoch, op: "history" }, page), "accepted");
		assert.deepEqual(page.ofType("omp:chat-btw-result").map(result => [result.requestId, result.status]), [[rid(1), "accepted"], [rid(2), "accepted"], [rid(3), "accepted"]]);
		runtime.dispose();
	});

	it("is refused, not left unanswered, by every gate: a refusal from OMP, a stale epoch, a read-only route and no conversation", async () => {
		const { runtime, channel, page } = await rig();
		const epoch = epochOf(runtime);
		channel.handlers.set("btw", () => ({ success: false, error: "No active model available for /btw." }));
		await runtime.handleMessage(TAB, { type: "omp:chat-btw-request", requestId: "a".repeat(32), epoch, op: "ask", question: "q" }, page);
		await runtime.handleMessage(TAB, { type: "omp:chat-btw-request", requestId: "b".repeat(32), epoch: { ...epoch, counter: epoch.counter + 5 }, op: "history" }, page);
		const readOnly = new Page("readonly") as Page & { readOnlyReason: () => string | null };
		readOnly.readOnlyReason = () => "This editor is not controlling its session.";
		await runtime.handleMessage(TAB, { type: "omp:chat-btw-request", requestId: "c".repeat(32), epoch, op: "history" }, readOnly);
		await runtime.handleMessage("tab:none", { type: "omp:chat-btw-request", requestId: "d".repeat(32), epoch, op: "history" }, readOnly);
		assert.deepEqual(page.ofType("omp:chat-btw-result").map(result => [result.status, result.reason]), [["refused", "no-model"], ["refused", "not-live"]]);
		assert.deepEqual(readOnly.ofType("omp:chat-btw-result").map(result => [result.requestId[0], result.reason]), [["c", "not-live"], ["d", "not-live"]]);
		runtime.dispose();
	});
});
