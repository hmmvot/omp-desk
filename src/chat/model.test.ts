/**
 * Behavioral tests for the chat model reducer shared by the host and the page: pending rows and their
 * reconciliation, epoch fencing, snapshot round trip, the dialog queue, notices and presentation state, and the
 * todo/window projections. Runner: `node --test src/chat/model.test.ts`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChatEntry, ChatMessage } from "./messages.ts";
import {
	MAX_COMMAND_OUTPUTS,
	applyChatEntries,
	applyChatEvent,
	applyChatOlder,
	applyChatRewrite,
	applyChatSnapshot,
	applyChatUiCancel,
	applyChatUiRequest,
	createChatModel,
	chatTurnInProgress,
	isUnsavedRow,
	markPendingUnsaved,
	askAnswersMatch,
	normalizeUiRequest,
	reduceChatFrame,
	snapshotOf,
	windowOf,
	type ChatEpoch,
	type ChatEventFrame,
	type ChatModel,
	type ChatSnapshotPayload,
} from "./model.ts";
import { assistantMessage, messageEntry, toolResultMessage, userMessage } from "../host/rpc/test-support.ts";
import { positionTranscript } from "./projection.ts";

const EPOCH: ChatEpoch = { nonce: "n", counter: 1 };

function emptySnapshot(overrides: Partial<ChatSnapshotPayload> = {}): ChatSnapshotPayload {
	return {
		...snapshotOf(createChatModel(), EPOCH),
		phase: "live",
		header: { id: "s", cwd: "c", timestamp: "" },
		...overrides,
	};
}

function live(overrides: Partial<ChatSnapshotPayload> = {}): ChatModel {
	return applyChatSnapshot(createChatModel(), emptySnapshot(overrides), { now: 1 });
}

function end(model: ChatModel, messageId: string, message: ChatMessage): ChatModel {
	return reduceChatFrame(model, { type: "message_end", messageId, message }, { now: 1 });
}

const ids = (model: ChatModel): string[] => model.entries.map(entry => entry.id);

describe("turn working status", () => {
	it("retains streamed and active intents across engine gaps, snapshots and asks until settle", () => {
		let model = reduceChatFrame(live(), { type: "agent_start" }, { now: 100 });
		assert.equal(chatTurnInProgress(model), true);
		assert.equal(model.workingIntent, null);
		const message = { ...assistantMessage("", 101), content: [{ type: "toolCall" as const, id: "read-one", name: "read", arguments: { i: "  Reading source...  ", path: "a.ts" } }] };
		model = reduceChatFrame(model, { type: "message_update", messageId: "reply", message });
		assert.equal(model.workingIntent, "Reading source");
		model = reduceChatFrame(model, { type: "tool_execution_start", toolCallId: "read-two", toolName: "read", args: { i: "Checking behavior." } });
		model = reduceChatFrame(model, { type: "tool_execution_update", toolCallId: "read-two", toolName: "read", args: { i: false }, partialResult: {} });
		model = reduceChatFrame(model, { type: "tool_execution_end", toolCallId: "read-two", toolName: "read", result: {}, isError: false });
		assert.equal(model.workingIntent, "Checking behavior");
		model = reduceChatFrame(model, { type: "agent_end", isTerminal: false, awaitingAsyncWork: true });
		assert.equal(model.working, false);
		assert.equal(chatTurnInProgress(model), true, "async engine gaps do not blink");
		model = applyChatSnapshot(createChatModel(), snapshotOf(model, EPOCH));
		assert.equal(model.workingIntent, "Checking behavior");
		model = applyChatUiRequest(model, { id: "ask", method: "confirm", title: "Continue?", message: "" });
		assert.equal(chatTurnInProgress(model), true);
		model = reduceChatFrame(model, { type: "agent_start" }, { now: 200 });
		assert.equal(model.workingIntent, "Checking behavior", "same turn resumes its intent");
		model = reduceChatFrame(model, { type: "agent_end" });
		assert.equal(chatTurnInProgress(model), true, "terminal engine end still awaits settle");
		model = reduceChatFrame(model, { type: "session_settled" }, { now: 300 });
		assert.equal(chatTurnInProgress(model), false);
		model = reduceChatFrame(model, { type: "agent_start" }, { now: 400 });
		assert.equal(model.workingIntent, null, "a fresh turn cannot reuse an old intent");
	});
});

describe("pending rows", () => {
	it("turns a live message_end into a pending row that the durable entry replaces by role and message timestamp", () => {
		let model = live();
		model = end(model, "msg-1", userMessage("hi", 100));
		model = end(model, "msg-2", assistantMessage("yo", 200));
		assert.deepEqual(ids(model), ["live:msg-1", "live:msg-2"]);
		assert.equal(model.durableCount, 0);

		const durable = messageEntry("d-user", null, userMessage("hi", 100));
		model = applyChatEntries(model, [durable], "d-user", { now: 2 });
		assert.deepEqual(ids(model), ["d-user", "live:msg-2"], "durable rows come first; the unmatched row stays");
		assert.equal(model.durableCount, 1);
		assert.equal(model.leafId, "d-user");
		assert.deepEqual([...model.pending.keys()], ["live:msg-2"]);
	});

	it("does not match on the entry's own persist time and never matches a different role", () => {
		let model = end(live(), "msg-1", userMessage("hi", 100));
		// Same timestamp number, other role; and an entry whose ISO persist time equals the message time.
		const wrongRole = messageEntry("x1", null, assistantMessage("hi", 100));
		const persistTimeOnly: ChatEntry = { ...messageEntry("x2", "x1", userMessage("hi", 999)), timestamp: new Date(100).toISOString() };
		model = applyChatEntries(model, [wrongRole, persistTimeOnly], "x2");
		assert.deepEqual(ids(model), ["x1", "x2", "live:msg-1"]);
	});

	it("is idempotent for a durable id it already holds and for a replayed message_end", () => {
		const durable = messageEntry("d1", null, assistantMessage("a", 500));
		let model = applyChatEntries(live(), [durable], "d1");
		model = applyChatEntries(model, [durable], "d1");
		assert.deepEqual(ids(model), ["d1"]);
		model = end(model, "msg-7", assistantMessage("a", 500));
		assert.deepEqual(ids(model), ["d1"], "a ring replay of an already-durable message is not a new row");
	});

	it("skips a replayed message_end older than the loaded window when older rows exist", () => {
		const model = end(live({ entries: [messageEntry("d5", null, userMessage("new", 5_000))], olderCount: 3 }), "msg-1", userMessage("old", 1_000));
		assert.deepEqual(ids(model), ["d5"]);
		const noOlder = end(live({ entries: [messageEntry("d5", null, userMessage("new", 5_000))], olderCount: 0 }), "msg-1", userMessage("old", 1_000));
		assert.deepEqual(ids(noOlder), ["d5", "live:msg-1"], "with the whole history loaded an unknown message is genuinely pending");
	});

	it("re-ending the same messageId replaces its pending row instead of duplicating it", () => {
		let model = end(live(), "msg-1", assistantMessage("a", 1));
		model = end(model, "msg-1", assistantMessage("ab", 1));
		assert.equal(model.entries.length, 1);
		assert.equal(model.pending.size, 1);
	});

	it("flags unmatched rows unsaved without dropping them, and keeps the flag across a snapshot round trip", () => {
		let model = end(live(), "msg-1", userMessage("hi", 100));
		model = markPendingUnsaved(model);
		assert.equal(isUnsavedRow(model, "live:msg-1"), true);
		assert.equal(markPendingUnsaved(model), model, "idempotent");
		const restored = applyChatSnapshot(createChatModel(), snapshotOf(model, EPOCH));
		assert.deepEqual(ids(restored), ["live:msg-1"]);
		assert.equal(isUnsavedRow(restored, "live:msg-1"), true);
	});

	it("filters durable rows to the chat entry types", () => {
		const usage = { type: "model_usage", id: "mu", parentId: null, timestamp: "", purpose: "x" } as unknown as ChatEntry;
		const model = applyChatEntries(live(), [usage, messageEntry("m", null, userMessage("hi", 1))], "m");
		assert.deepEqual(ids(model), ["m"]);
	});
});

describe("epoch fencing and snapshots", () => {
	it("drops events of another epoch and applies the current one", () => {
		const model = live();
		const frame: ChatEventFrame = { type: "agent_start" };
		assert.equal(applyChatEvent(model, { nonce: "n", counter: 0 }, frame), model);
		assert.equal(applyChatEvent(model, { nonce: "other", counter: 1 }, frame), model);
		assert.equal(applyChatEvent(model, null, frame), model);
		assert.equal(applyChatEvent(model, EPOCH, frame).working, true);
	});

	it("resets unconditionally on a snapshot, even to a lower counter from a new host", () => {
		const first = applyChatSnapshot(createChatModel(), emptySnapshot({ epoch: { nonce: "old", counter: 99 }, working: true }));
		const next = applyChatSnapshot(first, emptySnapshot({ epoch: { nonce: "new", counter: 1 }, working: false }));
		assert.deepEqual(next.epoch, { nonce: "new", counter: 1 });
		assert.equal(next.working, false);
		assert.equal(applyChatEvent(next, { nonce: "old", counter: 99 }, { type: "agent_start" }).working, false);
	});

	it("round-trips the in-flight state through snapshotOf and applyChatSnapshot", () => {
		let model = live();
		model = reduceChatFrame(model, { type: "agent_start" });
		model = reduceChatFrame(model, { type: "message_update", messageId: "msg-3", message: assistantMessage("par", 9) });
		model = reduceChatFrame(model, { type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "ls" } }, { now: 7 });
		model = applyChatUiRequest(model, { id: "u1", method: "confirm", title: "T", message: "M" });
		model = applyChatUiRequest(model, { id: "u2", method: "input", title: "T2" });
		const restored = applyChatSnapshot(createChatModel(), snapshotOf(model, EPOCH));
		assert.equal(restored.working, true);
		assert.equal(restored.streamId, "msg-3");
		assert.equal(restored.stream?.role, "assistant");
		assert.deepEqual([...restored.activeTools.keys()], ["t1"]);
		assert.equal(restored.uiRequest?.id, "u1");
		assert.deepEqual(restored.uiQueue.map(request => request.id), ["u2"]);
	});
});

describe("streaming projection", () => {
	it("holds the assistant ghost from message_start/update and hands it to a pending row at message_end", () => {
		let model = live();
		model = reduceChatFrame(model, { type: "message_start", messageId: "msg-1", message: assistantMessage("", 10) });
		model = reduceChatFrame(model, { type: "message_update", messageId: "msg-1", message: assistantMessage("hel", 10) });
		assert.equal(model.stream?.role, "assistant");
		assert.deepEqual(ids(model), []);
		model = end(model, "msg-1", assistantMessage("hello", 10));
		assert.equal(model.stream, null);
		assert.deepEqual(ids(model), ["live:msg-1"]);
	});

	it("ignores a user message_start and clears tools when the turn ends", () => {
		let model = reduceChatFrame(live(), { type: "message_start", messageId: "msg-1", message: userMessage("q", 1) });
		assert.equal(model.stream, null);
		model = reduceChatFrame(model, { type: "tool_execution_start", toolCallId: "t", toolName: "x", args: {} });
		model = reduceChatFrame(model, { type: "tool_stream_update", toolCallId: "t", toolName: "x", update: { diff: 1 } });
		assert.deepEqual(model.activeTools.get("t")?.streamUpdate, { diff: 1 });
		model = reduceChatFrame(model, { type: "agent_end" });
		assert.equal(model.activeTools.size, 0);
		assert.equal(model.working, false);
	});

	it("tracks settle: agent_start unsettles, session_settled settles", () => {
		let model = reduceChatFrame(live(), { type: "agent_start" });
		assert.equal(model.settled, false);
		model = reduceChatFrame(model, { type: "prompt_result", id: "vsc:1", status: "completed", agentInvoked: true, sessionSettled: false });
		assert.equal(model.settled, false);
		assert.deepEqual(model.lastPromptResult, { id: "vsc:1", status: "completed", agentInvoked: true, sessionSettled: false });
		model = reduceChatFrame(model, { type: "session_settled" });
		assert.equal(model.settled, true);
		assert.equal(model.working, false);
	});

	it("applies state_update as the authority for the footer and streaming flag", () => {
		let model = reduceChatFrame(live(), { type: "agent_start" });
		model = reduceChatFrame(model, {
			type: "state_update",
			state: { model: null, thinkingLevel: "low", isStreaming: false, isCompacting: false, queuedMessageCount: 1 },
			todoSeed: [],
		});
		assert.equal(model.working, false);
		assert.equal(model.state?.thinkingLevel, "low");
		model = reduceChatFrame(model, { type: "config_update", model: { provider: "p", id: "m", contextWindow: null } });
		assert.equal(model.state?.model?.id, "m");
	});
});

describe("dialogs", () => {
	it("queues FIFO, ignores a duplicate id, and removes the head or a queued one on cancel", () => {
		let model = live();
		for (const id of ["a", "b", "c"]) model = applyChatUiRequest(model, { id, method: "input", title: id });
		model = applyChatUiRequest(model, { id: "b", method: "input", title: "dup" });
		assert.equal(model.uiRequest?.id, "a");
		assert.deepEqual(model.uiQueue.map(request => request.id), ["b", "c"]);
		model = applyChatUiCancel(model, "b");
		assert.deepEqual(model.uiQueue.map(request => request.id), ["c"]);
		model = applyChatUiCancel(model, "a");
		assert.equal(model.uiRequest?.id, "c");
		assert.equal(applyChatUiCancel(model, "zzz"), model);
	});

	it("normalizes and bounds a select request and rejects shapes it cannot render", () => {
		const request = normalizeUiRequest({
			id: "r",
			method: "select",
			title: "T\u0000itle",
			options: ["A", "B"],
			optionDetails: [{ description: "first" }],
		});
		assert.deepEqual(request, { id: "r", method: "select", title: "Title", options: [{ label: "A", description: "first" }, { label: "B" }] });
		const many = normalizeUiRequest({ id: "r", method: "select", title: "t", options: new Array(500).fill("x") });
		assert.equal(many?.method === "select" && many.options.length, 200);
		assert.equal(normalizeUiRequest({ id: "r", method: "select", title: "t", options: [1] }), null);
		assert.equal(normalizeUiRequest({ id: "", method: "input", title: "t" }), null);
		assert.equal(normalizeUiRequest({ id: "r", method: "wat", title: "t" }), null);
		assert.deepEqual(normalizeUiRequest({ id: "r", method: "editor", title: "t", prefill: "p", promptStyle: true }), {
			id: "r",
			method: "editor",
			title: "t",
			prefill: "p",
			promptStyle: true,
		});
	});

	it("normalizes an ask frame into one request carrying every question and refuses keys it cannot answer faithfully", () => {
		const frame = {
			id: "a1",
			method: "ask",
			questions: [
				{ id: "q1", question: "Scope?", header: " Scope ", options: [{ label: "Narrow", description: " small " }, { label: "Wide" }], recommended: 1 },
				{ id: "q2", question: "Checks?", multi: true, options: [{ label: "Typecheck" }], recommended: 7 },
			],
		};
		const request = normalizeUiRequest(frame);
		assert.deepEqual(request, {
			id: "a1",
			method: "ask",
			title: "Scope? (+1 more)",
			questions: [
				{ id: "q1", question: "Scope?", header: "Scope", options: [{ label: "Narrow", description: "small" }, { label: "Wide" }], multi: false, recommended: 1 },
				{ id: "q2", question: "Checks?", options: [{ label: "Typecheck" }], multi: true },
			],
		});
		// An answer key the child compares by identity is never rewritten: a label sanitising would change makes the dialog unrenderable.
		assert.equal(normalizeUiRequest({ ...frame, questions: [{ id: "q", question: "x", options: [{ label: "A\u0000B" }] }] }), null);
		assert.equal(normalizeUiRequest({ ...frame, questions: [{ id: "q", question: "x", options: [{ label: "A" }, { label: "A" }] }] }), null);
		assert.equal(normalizeUiRequest({ ...frame, questions: [{ id: "q", question: "x", options: [] }, { id: "q", question: "y", options: [] }] }), null);
		assert.equal(normalizeUiRequest({ ...frame, questions: [] }), null);
		assert.equal(normalizeUiRequest({ id: "", method: "ask", questions: frame.questions }), null);
	});

	it("accepts only ask answers the child would accept", () => {
		const request = normalizeUiRequest({
			id: "a1",
			method: "ask",
			questions: [
				{ id: "q1", question: "Scope?", options: [{ label: "Narrow" }, { label: "Wide" }] },
				{ id: "q2", question: "Checks?", multi: true, options: [{ label: "Typecheck" }, { label: "Unit" }] },
			],
		});
		assert.ok(request !== null && request.method === "ask");
		const ok = [{ id: "q1", selectedOptions: ["Narrow"] }, { id: "q2", selectedOptions: ["Typecheck", "Unit"], customInput: "more" }];
		assert.equal(askAnswersMatch(request, ok), true);
		assert.equal(askAnswersMatch(request, [{ id: "q1", selectedOptions: [] }, { id: "q2", selectedOptions: [] }]), true, "unanswered questions are allowed");
		assert.equal(askAnswersMatch(request, ok.slice(0, 1)), false, "one answer per question");
		assert.equal(askAnswersMatch(request, [ok[1]!, ok[0]!]), false, "in question order");
		assert.equal(askAnswersMatch(request, [{ id: "q1", selectedOptions: ["Nope"] }, ok[1]!]), false, "unknown option");
		assert.equal(askAnswersMatch(request, [{ id: "q1", selectedOptions: ["Narrow", "Wide"] }, ok[1]!]), false, "single-select takes one");
		assert.equal(askAnswersMatch(request, [{ id: "q1", selectedOptions: ["Narrow"], customInput: "x" }, ok[1]!]), false, "single-select is one answer or a custom one");
		assert.equal(askAnswersMatch(request, [ok[0]!, { id: "q2", selectedOptions: ["Unit", "Unit"] }]), false, "no repeated option");
	});
});

describe("command output and presentation", () => {
	it("caps handled-command cards and strips control characters without flattening lines", () => {
		let model = live();
		for (let index = 0; index < MAX_COMMAND_OUTPUTS + 5; index += 1) model = reduceChatFrame(model, { type: "command_output", text: `output ${index}` });
		assert.equal(model.ephemeral.filter(item => item.kind === "command_output").length, MAX_COMMAND_OUTPUTS);
		assert.deepEqual(model.ephemeral[0]?.payload, { text: "output 5" });
		model = reduceChatFrame(model, { type: "command_output", text: "line\u0007 one\nline two" });
		assert.deepEqual(model.ephemeral.at(-1)?.payload, { text: "line one\nline two" });
	});

	it("keeps one bounded status line from status and widget entries", () => {
		let model = reduceChatFrame(live(), { type: "ui_status", key: "a", text: "one" });
		model = reduceChatFrame(model, { type: "ui_widget", key: "w", lines: ["two", "lines"] });
		assert.equal(model.statusLine, "one · two lines");
		model = reduceChatFrame(model, { type: "ui_status", key: "a", text: null });
		assert.equal(model.statusLine, "two lines");
		model = reduceChatFrame(model, { type: "ui_widget", key: "w", lines: null });
		assert.equal(model.statusLine, null);
		for (let index = 0; index < 40; index += 1) model = reduceChatFrame(model, { type: "ui_status", key: `k${index}`, text: "x".repeat(500) });
		assert.ok((model.statusLine ?? "").length <= 200);
		assert.ok(model.statusEntries.size <= 16);
	});

	it("re-issues composer text with a new seq so the same text can repeat", () => {
		let model = reduceChatFrame(live(), { type: "ui_editor_text", text: "x" });
		const first = model.pendingEditorText?.seq;
		model = reduceChatFrame(model, { type: "ui_editor_text", text: "x" });
		assert.equal(model.pendingEditorText?.seq, (first ?? 0) + 1);
	});


	it("updates the title from session_info_update", () => {
		const model = reduceChatFrame(live(), { type: "session_info_update", title: "Renamed" });
		assert.equal(model.header?.title, "Renamed");
	});
});

describe("projections", () => {
	it("projects the todo list from a pending tool result and falls back to the state's seed", () => {
		const phases = [{ name: "P", tasks: [{ content: "do it", status: "in_progress" }] }];
		let model = end(live(), "msg-1", toolResultMessage("c", 50, "todo", { op: "set", phases }));
		assert.deepEqual(model.todo?.phases, phases);
		const seeded = live({ todoSeed: phases });
		assert.deepEqual(seeded.todo?.phases, phases);
		assert.equal(live({ todoSeed: "garbage" }).todo, null);
	});

	it("mounts a window over durable and pending rows and prepends older rows without duplicates", () => {
		const rows: ChatEntry[] = [];
		for (let index = 0; index < 6; index += 1) rows.push(messageEntry(`u${index}`, index === 0 ? null : `u${index - 1}`, userMessage(`q${index}`, 100 + index)));
		let model = live({ entries: rows.slice(3), olderCount: 3, leafId: "u5" });
		model = end(model, "msg-1", assistantMessage("live", 900));
		const window = windowOf(model, 2, null);
		assert.deepEqual(window.rows.map(row => row.id), ["u5", "live:msg-1"]);
		assert.equal(window.olderRows, 2);
		model = applyChatOlder(model, rows.slice(0, 4), 0);
		assert.deepEqual(ids(model), ["u0", "u1", "u2", "u3", "u4", "u5", "live:msg-1"]);
		assert.equal(model.olderCount, 0);
	});

	it("rewrites the durable rows wholesale and consumes the pending rows they now cover", () => {
		let model = end(live(), "msg-1", userMessage("hi", 100));
		model = end(model, "msg-2", assistantMessage("yo", 200));
		const rows = [messageEntry("d1", null, userMessage("hi", 100)), messageEntry("d0", null, userMessage("other", 1))];
		model = applyChatRewrite(model, rows, 0, "d1");
		assert.deepEqual(ids(model), ["d1", "d0", "live:msg-2"]);
		assert.equal(model.leafId, "d1");
	});
});

describe("IRC and custom rows reconcile without a false 'not yet saved'", () => {
	const custom = (customType: string, timestamp: number, content: string, details: unknown): ChatMessage =>
		({ role: "custom", customType, content, display: true, details, attribution: "agent", timestamp }) as ChatMessage;
	const incoming = (timestamp: number, id: string, body = "hello"): ChatMessage => custom("irc:incoming", timestamp, `<irc>${body}</irc>`, { id, from: "Scout", message: body });
	/** A saved custom_message: the entry carries its own persist timestamp, the message's own is epoch-ms of `at`. */
	const saved = (id: string, parentId: string | null, message: ChatMessage, at = message.timestamp): ChatEntry => {
		const { role: _role, timestamp: _timestamp, ...fields } = message as ChatMessage & { role: "custom"; timestamp: number };
		return { type: "custom_message", id, parentId, timestamp: new Date(at).toISOString(), ...fields } as ChatEntry;
	};
	const observe = (model: ChatModel, message: ChatMessage): ChatModel => reduceChatFrame(model, { type: "irc_message", message } as never, { now: 1 });
	const flagged = (model: ChatModel): string[] => [...model.pending.keys()].filter(id => isUnsavedRow(model, id));

	it("folds the irc_message observation and the agent's own message_end into one pending row that its entry replaces", () => {
		const message = incoming(5_000, "irc-1");
		let model = observe(live(), message);
		model = end(model, "msg-7", message);
		assert.equal(model.pending.size, 1, "one record is one row, not an observation plus a message");
		assert.equal(model.entries.length, 1);
		model = applyChatEntries(model, [saved("d1", null, message)], "d1");
		assert.deepEqual(ids(model), ["d1"]);
		assert.equal(model.pending.size, 0);
		assert.deepEqual(flagged(markPendingUnsaved(model)), []);
	});

	it("is the same row whichever of the observation and the message_end arrives first, and under replay", () => {
		const message = incoming(5_000, "irc-1");
		let model = end(live(), "msg-7", message);
		model = observe(model, message);
		model = end(model, "msg-7", message);
		model = observe(model, message);
		assert.equal(model.pending.size, 1);
		assert.equal(model.entries.length, 1);
		model = applyChatEntries(model, [saved("d1", null, message)], "d1");
		model = observe(end(model, "msg-7", message), message);
		assert.deepEqual(ids(model), ["d1"], "once saved, a replayed observation or message_end adds nothing");
	});

	it("matches an entry OMP stamped at append time (plan-mode IRC and sendCustomMessage) by content, keeping the row's place", () => {
		const before = userMessage("question", 4_000);
		const message = incoming(5_000, "irc-2");
		const async = custom("async-result", 5_100, "job done", { jobs: [{ jobId: "j1", type: "task" }] });
		let model = applyChatEntries(live(), [messageEntry("u1", null, before)], "u1");
		model = observe(model, message);
		model = end(model, "msg-9", async);
		model = applyChatEntries(model, [saved("d-irc", "u1", message, 5_037), saved("d-async", "d-irc", async, 5_212)], "d-async");
		assert.deepEqual(ids(model), ["u1", "d-irc", "d-async"]);
		assert.equal(model.pending.size, 0);
		assert.equal(model.durablePositions.get("d-irc")?.anchorId, "u1", "the saved row keeps the position the live row held");
	});

	it("still flags a record whose entry never arrives, and never matches different content or a distant entry", () => {
		const message = incoming(5_000, "irc-3");
		let model = observe(live(), message);
		const other = incoming(5_010, "irc-other", "different body");
		const distant = saved("d-far", null, message, 5_000 + 120_000);
		model = applyChatEntries(model, [saved("d-other", null, other), distant], "d-far");
		assert.deepEqual([...model.pending.keys()], ["live:irc:irc:incoming:5000"], "neither a different message nor a distant entry consumes it");
		model = markPendingUnsaved(model);
		assert.deepEqual(flagged(model), ["live:irc:irc:incoming:5000"], "a record that truly never persisted keeps the real flag");
		const plain = markPendingUnsaved(end(live(), "msg-1", userMessage("lost", 7)));
		assert.deepEqual(flagged(plain), ["live:msg-1"]);
	});

	it("prefers the exact timestamp over a same-content neighbour, and a wholesale rewrite matches an append-stamped entry too", () => {
		const first = incoming(5_000, "dup", "same");
		const second = custom("irc:incoming", 5_800, "<irc>same</irc>", { id: "dup", from: "Scout", message: "same" });
		let model = end(end(live(), "a", first), "b", second);
		model = applyChatEntries(model, [saved("d2", null, second)], "d2");
		assert.deepEqual([...model.pending.keys()], ["live:a"], "the exact-timestamp row is the one consumed");

		const message = incoming(9_000, "irc-rw", "rewritten");
		const rewritten = applyChatRewrite(observe(live(), message), [saved("rw", null, message, 9_041)], 0, "rw");
		assert.deepEqual(ids(rewritten), ["rw"]);
		assert.equal(rewritten.pending.size, 0);
	});

	it("keeps display-only relay and work-pool cards as ephemeral rows that are never pending and never flagged", () => {
		const relay = custom("irc:relay", 6_000, "[IRC `A` → `B`]\n\nbody", { from: "A", to: "B", body: "body" });
		const pool = custom("irc:workpool", 6_001, "[pool p → W]", { pool: "p", from: "pool:p", to: "W", body: "x", mode: "queued" });
		let model = observe(observe(live(), relay), pool);
		model = observe(model, relay);
		assert.equal(model.pending.size, 0);
		assert.equal(model.ephemeral.length, 2, "a replayed observation does not duplicate the card");
		assert.deepEqual(flagged(markPendingUnsaved(model)), []);
		const shown = positionTranscript(model.entries, model.durableCount, model.pending, model.ephemeral).map(entry => entry.type === "message" ? entry.message : null);
		assert.deepEqual(shown.map(message => message?.role === "custom" ? message.customType : null), ["irc:relay", "irc:workpool"]);
		assert.equal(observe(live(), { ...relay, display: false } as ChatMessage).ephemeral.length, 0, "hidden observations stay hidden");
	});
});
