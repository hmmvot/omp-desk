/**
 * Stop takes back a message sent a moment ago (ADR-0082) on a real `RpcSession` over the fake child. The fake plays OMP
 * 18.12.2 as recorded: a prompt aborted before `agent_start` is dropped and its `prompt_result` (`aborted`,
 * `agentInvoked: true`) arrives after the abort answer; a prompt aborted after the user message was written leaves the
 * message and an aborted assistant message, and the Stop's move is the Desk navigate command. Runner:
 * `node --test src/host/rpc/session-stop-withdraw.test.ts`.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { ChatContent, ChatEntry } from "../../chat/messages.ts";
import { NAVIGATE_COMMAND, NAVIGATION_MARKER_TYPE, parseNavigateArgs, type NavigateArgs } from "../../chat/rewind.ts";
import { WITHDRAW_GRACE_MS } from "../../chat/stop-withdraw.ts";
import { FakeRpcChannel } from "./fake-channel.ts";
import { RpcSession, type AbortRestoreOutcome, type PromptRequest } from "./session.ts";
import { ManualTimers, assistantMessage, isoOf, messageEntry, tick, userMessage, waitUntil } from "./test-support.ts";

const sessions: RpcSession[] = [];
afterEach(() => {
	for (const session of sessions.splice(0)) session.dispose();
});

const PREFIX = `/${NAVIGATE_COMMAND} `;
const CATALOG = [
	{ name: NAVIGATE_COMMAND, source: "extension" },
	{ name: "skill:review", source: "skill" },
	{ name: "compact", source: "builtin" },
	{ name: "fix-bug", source: "file" },
];
const IMAGE = { type: "image" as const, mimeType: "image/png", data: "AA==" };

const u1 = messageEntry("u1", null, userMessage("earlier", 1000));
const a1 = messageEntry("a1", "u1", assistantMessage("sure", 2000));

interface Rig {
	channel: FakeRpcChannel;
	session: RpcSession;
	timers: ManualTimers;
	/** Navigate calls the fake child received, in order. */
	navigations: NavigateArgs[];
}

/** A conversation `[u1, a1]` with the child's leaf on `a1`, a catalog, and a child that carries out the navigate command. */
async function boot(options: { catalog?: readonly Record<string, unknown>[]; navigate?: "move" | "drop" } = {}): Promise<Rig> {
	const channel = new FakeRpcChannel({ sessionFile: null, entries: [u1, a1] as never, leafId: "a1" });
	const catalog = options.catalog ?? CATALOG;
	channel.handlers.set("get_available_commands", () => ({ data: { commands: catalog } }));
	const navigations: NavigateArgs[] = [];
	channel.handlers.set("prompt", command => {
		const message = String(command.message);
		if (!message.startsWith(PREFIX)) return {};
		const args = parseNavigateArgs(message.slice(PREFIX.length));
		assert.ok(args !== null, "the host encodes a well-formed navigate request");
		navigations.push(args);
		if (options.navigate === "drop") return "drop";
		move(channel, args);
		setImmediate(() => channel.emit({ type: "prompt_result", id: String(command.id), agentInvoked: false, status: "completed", sessionSettled: true }));
		return {};
	});
	const timers = new ManualTimers();
	const session = new RpcSession({ channel, sessionFile: null, cwd: "D:\\scratch", hostNonce: "host-a", timers, fileExists: async () => true, watchdogIntervalMs: 60 * 60_000, stallCheckIntervalMs: 60 * 60_000 });
	sessions.push(session);
	await session.start();
	await waitUntil(() => session.model.commands.length > 0);
	await tick();
	return { channel, session, timers, navigations };
}

let markerSeq = 0;
/** What the OMP-side command does: a rewind lands on the target's parent, then the marker is appended. */
function move(channel: FakeRpcChannel, args: NavigateArgs): void {
	const target = channel.child.entries.find(entry => entry.id === args.targetId);
	assert.ok(target !== undefined, `the target ${args.targetId} exists in the child`);
	const to = (target.parentId as string | null) ?? null;
	markerSeq += 1;
	channel.child.entries.push({
		type: "custom",
		customType: NAVIGATION_MARKER_TYPE,
		id: `nav-${markerSeq}`,
		parentId: to,
		timestamp: isoOf(50_000 + markerSeq),
		data: { v: 1, requestId: args.requestId, kind: args.kind, from: channel.child.leafId, target: args.targetId, to, summarized: false },
	});
	channel.child.leafId = `nav-${markerSeq}`;
}

let ridSeq = 0;
const rid = (): string => `stop-${(ridSeq += 1)}`;

const aborted = (id: string, parentId: string, content: readonly ChatContent[] = [], timestamp = 3500): ChatEntry =>
	messageEntry(id, parentId, { role: "assistant", content, model: "m", stopReason: "aborted", timestamp } as never);

/** OMP writes the user message and starts the turn: the entries land in the child, then `agent_start`. */
function startsTurn(channel: FakeRpcChannel, text = "fix the typo", id = "u3", parentId = "a1"): void {
	channel.child.entries.push(messageEntry(id, parentId, userMessage(text, 3000)) as never);
	channel.child.leafId = id;
	channel.emit({ type: "agent_start" });
}

interface StopScript {
	/** Entries OMP appends while it stops the turn (the aborted answer). */
	entries?: readonly ChatEntry[];
	steering?: readonly { text: string }[];
	/** The anchor's `prompt_result`: `"after"` the abort answer (as recorded), `"before"` it, or never. */
	result?: "after" | "before" | "never";
	status?: "aborted" | "completed" | "error";
	/** The turn had started: its end and settle frames go out with the answer. */
	turn?: boolean;
}

/** `abort_and_restore_queue` as OMP 18.12.2 answers it, with the frames that go with it. */
function onStop(channel: FakeRpcChannel, script: StopScript = {}): void {
	channel.handlers.set("abort_and_restore_queue", () => {
		for (const entry of script.entries ?? []) {
			channel.child.entries.push(entry as never);
			channel.child.leafId = entry.id;
		}
		const result = (): void => { channel.emit({ type: "prompt_result", id: "vsc:p1", agentInvoked: true, status: script.status ?? "aborted", sessionSettled: true }); };
		if (script.result === "before") result();
		if (script.turn !== false && script.turn !== undefined) {
			channel.emit({ type: "agent_end", messages: [] });
			channel.emit({ type: "session_settled" });
		}
		if ((script.result ?? "after") === "after") setImmediate(result);
		return { data: { steering: script.steering ?? [], followUp: [] } };
	});
}

async function send(rig: Rig, request: Partial<PromptRequest> = {}): Promise<void> {
	await rig.session.prompt({ requestId: "p1", text: "fix the typo", ...request });
	await tick();
}

async function stop(rig: Rig, requestId = rid(), takeBack = true): Promise<AbortRestoreOutcome> {
	return rig.session.abortAndRestore(requestId, { takeBack });
}

const withdrawn = (text: string, extra: Record<string, unknown> = {}) => ({ status: "withdrawn", text, images: [], unconfirmed: false, ...extra });

describe("a message the Stop takes out of the conversation", () => {
	it("moves the leaf past the message through the Rewind path and returns what was typed, images included", async () => {
		const rig = await boot();
		await send(rig, { images: [IMAGE] });
		startsTurn(rig.channel);
		onStop(rig.channel, { turn: true, entries: [aborted("a3", "u3")] });
		const outcome = await stop(rig);
		assert.deepEqual(outcome, { status: "accepted", restored: { entries: [], imagesDropped: false, truncated: false }, withdrawal: withdrawn("fix the typo", { images: [IMAGE] }) });
		assert.equal(rig.navigations.length, 1);
		assert.deepEqual([rig.navigations[0]!.kind, rig.navigations[0]!.targetId, rig.navigations[0]!.summarize], ["rewind", "u3", false]);
		assert.match(rig.navigations[0]!.requestId, /^[0-9a-f]{32}$/);
		const ids = rig.session.model.entries.map(entry => entry.id);
		assert.equal(ids.includes("u3"), false, "the message is off the active branch");
		assert.equal(ids.includes("a3"), false);
		assert.equal(ids.at(-1)?.startsWith("nav-"), true, "the marker is the tip: Undo is offered");
		assert.equal(rig.session.model.leafId, rig.channel.child.leafId);
	});

	it("does not count thinking, however long the model thought", async () => {
		const rig = await boot();
		await send(rig);
		startsTurn(rig.channel);
		rig.timers.advance(90_000);
		onStop(rig.channel, { turn: true, entries: [aborted("a3", "u3", [{ type: "thinking", thinking: "hmm" }])] });
		assert.equal((await stop(rig) as { withdrawal?: unknown }).withdrawal !== undefined, true);
		assert.equal(rig.navigations.length, 1);
	});

	it("allows an answer that started to stream inside the grace window", async () => {
		const rig = await boot();
		await send(rig);
		startsTurn(rig.channel);
		rig.timers.advance(WITHDRAW_GRACE_MS);
		onStop(rig.channel, { turn: true, entries: [aborted("a3", "u3", [{ type: "text", text: "Sure, I will" }])] });
		assert.deepEqual((await stop(rig) as { withdrawal?: unknown }).withdrawal, withdrawn("fix the typo"));
	});

	it("takes back a skill invocation the user typed, which OMP wrote as a skill-prompt entry and no user message", async () => {
		const rig = await boot();
		await send(rig, { text: "/skill:review please" });
		const invocation = { type: "custom_message", id: "s3", parentId: "a1", timestamp: isoOf(3100), customType: "skill-prompt", content: "expanded body", display: true, attribution: "user", details: { name: "review", prompt: "/skill:review please" } };
		rig.channel.child.entries.push(invocation as never);
		rig.channel.child.leafId = "s3";
		rig.channel.emit({ type: "agent_start" });
		onStop(rig.channel, { turn: true, entries: [aborted("a3", "s3")] });
		assert.deepEqual((await stop(rig) as { withdrawal?: unknown }).withdrawal, withdrawn("/skill:review please"));
		assert.equal(rig.navigations[0]?.targetId, "s3");
	});

	it("takes back a markdown command's expansion by position, and returns what was typed", async () => {
		const rig = await boot();
		await send(rig, { text: "/fix-bug now" });
		startsTurn(rig.channel, "Fix the bug named in: now");
		onStop(rig.channel, { turn: true, entries: [aborted("a3", "u3")] });
		assert.deepEqual((await stop(rig) as { withdrawal?: unknown }).withdrawal, withdrawn("/fix-bug now"));
	});

	it("hands back what was still queued, after the message, once", async () => {
		const rig = await boot();
		await send(rig);
		await rig.session.steer({ requestId: "p2", text: "and the second one" });
		startsTurn(rig.channel);
		onStop(rig.channel, { turn: true, entries: [aborted("a3", "u3")], steering: [{ text: "and the second one" }] });
		const outcome = await stop(rig);
		assert.equal(outcome.status === "accepted" && outcome.restored.entries.map(entry => entry.text).join("|"), "and the second one");
		assert.deepEqual(outcome.status === "accepted" && outcome.withdrawal, withdrawn("fix the typo"));
		assert.equal(rig.navigations.length, 1);
	});

	it("holds every other mutation until the decision is out, and answers a second Stop with today's Stop", async () => {
		const rig = await boot();
		await send(rig);
		startsTurn(rig.channel);
		onStop(rig.channel, { turn: true, entries: [aborted("a3", "u3")], result: "never" });
		const first = stop(rig, "stop-a");
		await tick();
		assert.deepEqual(await rig.session.prompt({ requestId: "p9", text: "too soon" }), { status: "refused", reason: "busy" });
		assert.equal(rig.channel.commandsOfType("prompt").some(command => command.message === "too soon"), false, "nothing reached OMP");
		const second = await stop(rig, "stop-b");
		assert.equal(second.status === "accepted" && second.withdrawal, undefined, "no anchor left for another Stop");
		rig.channel.emit({ type: "prompt_result", id: "vsc:p1", agentInvoked: true, status: "aborted", sessionSettled: true });
		assert.deepEqual((await first as { withdrawal?: unknown }).withdrawal, withdrawn("fix the typo"));
		assert.equal((await rig.session.prompt({ requestId: "p10", text: "now" })).status, "accepted", "the fence is gone");
		assert.equal(await stop(rig, "stop-a").then(outcome => outcome === undefined), false, "a repeat returns the first outcome");
		assert.equal(rig.navigations.length, 1, "never navigates twice");
	});
});

describe("a prompt OMP dropped before it reached the agent", () => {
	it("returns the typed text from the ledger without moving anything, although the abort answer came first", async () => {
		const rig = await boot();
		await send(rig, { images: [IMAGE] });
		onStop(rig.channel, { turn: false });
		const outcome = await stop(rig);
		assert.deepEqual(outcome.status === "accepted" && outcome.withdrawal, withdrawn("fix the typo", { images: [IMAGE] }));
		assert.equal(rig.navigations.length, 0);
		assert.equal(rig.channel.commandsOfType("prompt").length, 1, "only the user's prompt");
	});

	it("works when the result came before the abort answer too", async () => {
		const rig = await boot();
		await send(rig);
		onStop(rig.channel, { turn: false, result: "before" });
		const outcome = await stop(rig);
		assert.deepEqual(outcome.status === "accepted" && outcome.withdrawal, withdrawn("fix the typo"));
	});

	it("returns the prompt once when it also came back in the queue", async () => {
		const rig = await boot();
		await send(rig);
		onStop(rig.channel, { turn: false, steering: [{ text: "fix the typo" }, { text: "other" }] });
		const outcome = await stop(rig);
		assert.equal(outcome.status === "accepted" && outcome.restored.entries.map(entry => entry.text).join("|"), "other");
		assert.deepEqual(outcome.status === "accepted" && outcome.withdrawal, withdrawn("fix the typo"));
	});

	it("stays unproven without the prompt's result: the message is kept silently after the wait", async () => {
		const rig = await boot();
		await send(rig);
		onStop(rig.channel, { turn: false, result: "never" });
		const stopping = stop(rig);
		await tick();
		rig.timers.advance(5_000);
		const outcome = await stopping;
		assert.equal(outcome.status === "accepted" && outcome.withdrawal, undefined);
	});
});

describe("a Stop that is today's Stop", () => {
	it("leaves a message whose turn called a tool, whatever the time, and does not wait", async () => {
		const rig = await boot();
		await send(rig);
		startsTurn(rig.channel);
		rig.channel.emit({ type: "tool_execution_start", toolCallId: "c1", toolName: "read", args: {} });
		onStop(rig.channel, { turn: true, entries: [aborted("a3", "u3", [{ type: "toolCall", id: "c1", name: "read", arguments: {} }])] });
		const outcome = await stop(rig);
		assert.equal(outcome.status === "accepted" && outcome.withdrawal, undefined);
		assert.equal(rig.navigations.length, 0);
	});

	it("leaves a message whose answer is older than the grace, found after the settle", async () => {
		const rig = await boot();
		await send(rig);
		startsTurn(rig.channel);
		rig.timers.advance(WITHDRAW_GRACE_MS + 1);
		onStop(rig.channel, { turn: true, entries: [aborted("a3", "u3", [{ type: "text", text: "Sure" }])] });
		const outcome = await stop(rig);
		assert.equal(outcome.status === "accepted" && outcome.withdrawal, undefined);
		assert.equal(rig.navigations.length, 0);
	});

	it("leaves a message whose answer already streams past the grace, with no wait for the settle", async () => {
		const rig = await boot();
		await send(rig);
		startsTurn(rig.channel);
		rig.channel.emitMessage("message_start", "m-1", { role: "assistant", content: [{ type: "text", text: "Sure, I" }], model: "m", stopReason: "stop", timestamp: 3500 });
		rig.timers.advance(WITHDRAW_GRACE_MS + 1);
		onStop(rig.channel, { turn: true, entries: [aborted("a3", "u3", [{ type: "text", text: "Sure, I" }])], result: "never" });
		const outcome = await stop(rig);
		assert.equal(outcome.status === "accepted" && outcome.withdrawal, undefined);
		assert.equal(rig.navigations.length, 0);
	});

	it("leaves a turn that ended by itself: nothing was stopped", async () => {
		const rig = await boot();
		await send(rig);
		startsTurn(rig.channel);
		onStop(rig.channel, { turn: true, status: "completed", entries: [messageEntry("a3", "u3", assistantMessage("Done", 3500))] });
		const outcome = await stop(rig);
		assert.equal(outcome.status === "accepted" && outcome.withdrawal, undefined);
		assert.equal(rig.navigations.length, 0);
	});

	it("leaves a message OMP wrote with a second user message, such as a steer it delivered", async () => {
		const rig = await boot();
		await send(rig);
		startsTurn(rig.channel);
		onStop(rig.channel, { turn: true, entries: [messageEntry("u4", "u3", userMessage("and also", 3200)), aborted("a3", "u4")] });
		const outcome = await stop(rig);
		assert.equal(outcome.status === "accepted" && outcome.withdrawal, undefined);
		assert.equal(rig.navigations.length, 0);
	});

	it("does nothing without takeBack, and nothing after the prompt's result already came", async () => {
		const rig = await boot();
		await send(rig);
		startsTurn(rig.channel);
		onStop(rig.channel, { turn: true, entries: [aborted("a3", "u3")], result: "never" });
		const outcome = await stop(rig, rid(), false);
		assert.equal(outcome.status === "accepted" && outcome.withdrawal, undefined);
		assert.equal(rig.navigations.length, 0);
		rig.channel.emit({ type: "prompt_result", id: "vsc:p1", agentInvoked: true, status: "aborted", sessionSettled: true });
		await tick();
		const late = await stop(rig);
		assert.equal(late.status === "accepted" && late.withdrawal, undefined, "the ledger entry is gone with the result");
	});

	it("never anchors a prompt OMP answered as not invoking the agent, or a second prompt, or an extension command", async () => {
		const local = await boot();
		local.channel.handlers.set("prompt", () => ({ data: { agentInvoked: false } }));
		await send(local);
		onStop(local.channel, { turn: false });
		assert.equal((await stop(local) as { withdrawal?: unknown }).withdrawal, undefined, "a stale ledger entry is no anchor");

		const second = await boot();
		await send(second);
		await send(second, { requestId: "p2", text: "second" });
		onStop(second.channel, { turn: false, steering: [{ text: "second" }] });
		const outcome = await stop(second);
		assert.deepEqual(outcome.status === "accepted" && outcome.withdrawal, withdrawn("fix the typo"), "the first prompt is the anchor");
		assert.equal(outcome.status === "accepted" && outcome.restored.entries.map(entry => entry.text).join("|"), "second");

		const command = await boot();
		await send(command, { text: "/compact" });
		onStop(command.channel, { turn: false });
		assert.equal((await stop(command) as { withdrawal?: unknown }).withdrawal, undefined, "a builtin can act before it sends anything");
	});
	it("anchors a later prompt although an earlier local command left an entry that never gets a result", async () => {
		const rig = await boot();
		const handler = rig.channel.handlers.get("prompt")!;
		rig.channel.handlers.set("prompt", command => (command.message === "/compact" ? { data: { agentInvoked: false } } : handler(command)));
		await send(rig, { requestId: "p0", text: "/compact" });
		await send(rig);
		onStop(rig.channel, { turn: false });
		const outcome = await stop(rig);
		assert.deepEqual(outcome.status === "accepted" && outcome.withdrawal, withdrawn("fix the typo"));
	});

	it("never withdraws on the plain abort fallback of an OMP without the queue command", async () => {
		const rig = await boot();
		await send(rig);
		rig.channel.handlers.set("abort_and_restore_queue", () => ({ success: false, error: "Unknown command: abort_and_restore_queue" }));
		const outcome = await stop(rig);
		assert.deepEqual(outcome, { status: "accepted", restored: { entries: [], imagesDropped: false, truncated: false } });
		assert.equal(rig.channel.commandsOfType("abort").length, 1);
		assert.equal(rig.navigations.length, 0);
	});
});

describe("a move that did not go through", () => {
	it("says `kept` when OMP refuses the move, and moves nothing", async () => {
		const rig = await boot({ catalog: [{ name: "compact", source: "builtin" }] });
		await send(rig);
		startsTurn(rig.channel);
		onStop(rig.channel, { turn: true, entries: [aborted("a3", "u3")] });
		const outcome = await stop(rig);
		assert.deepEqual(outcome.status === "accepted" && outcome.withdrawal, { status: "kept" });
		assert.equal(rig.navigations.length, 0);
		assert.equal(rig.session.model.entries.some(entry => entry.id === "u3"), true);
	});

	it("returns the draft marked unconfirmed when OMP never answers the move", async () => {
		const rig = await boot({ navigate: "drop" });
		await send(rig);
		startsTurn(rig.channel);
		onStop(rig.channel, { turn: true, entries: [aborted("a3", "u3")] });
		const stopping = stop(rig);
		await waitUntil(() => rig.navigations.length === 1);
		await tick();
		rig.timers.advance(30_000);
		assert.deepEqual((await stopping as { withdrawal?: unknown }).withdrawal, withdrawn("fix the typo", { unconfirmed: true }));
	});
});
