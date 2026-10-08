/**
 * Tests for the turn-activity projection of a chat model.
 *
 * The projection decides two things for the host: whether a completion or a waiting dialog
 * deserves a notice, and which "question" label the Sessions row shows. So the cases worth
 * pinning are the refusals: a conversation that is not `live` reports nothing (its frames
 * describe a session that is not running), and the outcome is the host's own `stopReason`
 * taken from the newest reply rather than an inference from what the panel happens to show.
 *
 * Runner: `node --test src/webview/lib/activity.test.ts`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AssistantMessage, SessionEntry } from "@oh-my-pi/pi-wire";
import type { ChatModel } from "../../chat/model.ts";
import { createChatModel, reduceChatFrame, snapshotOf, applyChatSnapshot } from "../../chat/model.ts";
import { turnActivity, activitySignature, withRegistrySubagentWork } from "./activity.ts";
import { composerPopupOpen, reportComposerPopupOpen, subscribeComposerPopupOpen } from "./composer-overlay.ts";

function snapshot(patch: Partial<ChatModel> = {}): ChatModel {
	return { ...createChatModel(), phase: "live", ...patch };
}

function reply(stopReason: AssistantMessage["stopReason"]): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		model: "m",
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
		stopReason,
		timestamp: 1,
	};
}

function entry(id: string, message: AssistantMessage): SessionEntry {
	return { type: "message", id, parentId: null, timestamp: "t", message };
}

describe("what the conversation reports", () => {
	it("reports nothing while its session is not live", () => {
		for (const phase of ["starting", "attaching", "resyncing", "stopped", "failed", "view-only", "legacy"] as const) {
			assert.equal(turnActivity(snapshot({ phase, working: true })), null);
		}
	});


	it("takes the outcome from the newest reply, in-flight one first", () => {
		assert.equal(turnActivity(snapshot({ entries: [entry("a1", reply("stop"))], stream: reply("aborted") }))?.outcome, "aborted");
		assert.equal(turnActivity(snapshot({ entries: [entry("a1", reply("length"))] }))?.outcome, "length");
	});

	it("reports no outcome rather than guessing when there is no reply yet", () => {
		assert.equal(turnActivity(snapshot({ working: true }))?.outcome, null);
	});

	it("keeps an async pause unfinished across settle frames and reconnect, then resumes the same display turn", () => {
		let model = reduceChatFrame(snapshot(), { type: "agent_start" }, { now: 10 });
		model = reduceChatFrame(model, { type: "agent_end", isTerminal: false, awaitingAsyncWork: true, outcome: "stop" });
		const pausedSignature = activitySignature(turnActivity(model)!);
		model = reduceChatFrame(model, { type: "session_settled" });
		model = reduceChatFrame(model, { type: "prompt_result", status: "completed", agentInvoked: true, sessionSettled: true });
		assert.equal(model.settled, false);
		assert.equal(model.displayTurns[0]!.complete, false);
		assert.equal(turnActivity(model)!.backgroundWork, true);
		assert.equal(turnActivity(model)!.promptStatus, null);
		model = applyChatSnapshot(createChatModel(), snapshotOf(model, { nonce: "restart", counter: 1 }));
		assert.equal(model.asyncPaused, true);
		model = reduceChatFrame(model, { type: "agent_start" }, { now: 20 });
		assert.equal(model.displayTurns.length, 1);
		assert.equal(model.displayTurns[0]!.startedAt, 10);
		assert.equal(model.asyncPaused, false);
		assert.notEqual(activitySignature(turnActivity(model)!), pausedSignature);
		model = reduceChatFrame(model, { type: "agent_end", isTerminal: true, outcome: "stop" });
		model = reduceChatFrame(model, { type: "session_settled" });
		assert.equal(model.displayTurns[0]!.complete, true);
		assert.equal(turnActivity(model)!.backgroundWork, false);
		assert.equal(model.settled, true);
	});

	it("a registry subagent keeps a settled chat in background work until it stops, without touching other facts", () => {
		const settled = turnActivity(snapshot({ settled: true }))!;
		assert.equal(settled.backgroundWork, false);
		const waiting = withRegistrySubagentWork(settled);
		assert.deepEqual({ ...waiting, backgroundWork: settled.backgroundWork, settled: settled.settled }, settled);
		assert.equal(waiting.backgroundWork, true);
		assert.equal(waiting.settled, false);
		assert.notEqual(activitySignature(waiting), activitySignature(settled));
	});

	it("reports live child work independently of the main agent working flag", () => {
		const model = snapshot({ agents: new Map([["Reader", { id: "Reader", index: 0, agent: "scout", agentSource: "native", lastUpdate: 10, status: "running" }]]) });
		assert.equal(turnActivity(model)!.streaming, false);
		assert.equal(turnActivity(model)!.backgroundWork, true);
	});
});

describe("the composer popup state", () => {
	it("tells subscribers about changes, ignores repeats, and stops after release", () => {
		const seen: boolean[] = [];
		const release = subscribeComposerPopupOpen(open => seen.push(open));
		assert.equal(composerPopupOpen(), false);
		// The composer reports on every render of its popup state; only real
		// changes may reach the host, or the report would be re-sent needlessly.
		reportComposerPopupOpen("completion", false);
		reportComposerPopupOpen("completion", true);
		reportComposerPopupOpen("completion", true);
		reportComposerPopupOpen("completion", false);
		assert.deepEqual(seen, [true, false]);
		assert.equal(composerPopupOpen(), false);
		release();
		reportComposerPopupOpen("completion", true);
		assert.deepEqual(seen, [true, false], "a released subscriber must stop receiving");
		reportComposerPopupOpen("completion", false);
	});
	it("keeps Escape reserved until both completion and context popovers are closed", () => {
		const seen: boolean[] = [];
		const release = subscribeComposerPopupOpen(value => seen.push(value));
		reportComposerPopupOpen("completion", true);
		reportComposerPopupOpen("context", true);
		reportComposerPopupOpen("context", false);
		assert.equal(composerPopupOpen(), true);
		assert.deepEqual(seen, [true]);
		reportComposerPopupOpen("context", true);
		reportComposerPopupOpen("completion", false);
		assert.equal(composerPopupOpen(), true);
		reportComposerPopupOpen("context", false);
		assert.deepEqual(seen, [true, false]);
		release();
	});
});

/**
 * The heuristic question flag.
 *
 * The session tree shows "question" ahead of "answer ready" on the strength of this one
 * boolean, so its regressions are user-visible mislabels: a question mark inside a tool
 * argument or a running turn announced as a question nobody asked, an aborted reply
 * announced as one the user can answer, or an older reply's question mark resurfacing
 * after a tools-only step. All of those are decided here, from the reply's own text.
 */
function textReply(stopReason: AssistantMessage["stopReason"], text: string): AssistantMessage {
	return { ...reply(stopReason), content: [{ type: "text", text }] };
}

function textEntry(id: string, stopReason: AssistantMessage["stopReason"], text: string): SessionEntry {
	return entry(id, textReply(stopReason, text));
}

describe("the trailing-question heuristic", () => {
	it("flags a completed reply whose last non-whitespace character is a question mark", () => {
		assert.equal(turnActivity(snapshot({ entries: [textEntry("a1", "stop", "Shall I proceed?")] }))?.trailingQuestion, true);
		// Trailing whitespace is the ordinary shape of a completed reply, and it must not hide
		// the question.
		assert.equal(turnActivity(snapshot({ entries: [textEntry("a1", "stop", "Shall I proceed?\n\n ")] }))?.trailingQuestion, true);
		assert.equal(turnActivity(snapshot({ entries: [textEntry("a1", "stop", "Which of these?\t")] }))?.trailingQuestion, true);
	});

	it("does not flag prose, and does not flag a question mark that is not the last thing", () => {
		for (const text of ["Done. Nothing else needed.", "Why? Because that is the rule.", "", "   \n"]) {
			assert.equal(turnActivity(snapshot({ entries: [textEntry("a1", "stop", text)] }))?.trailingQuestion, false, `flagged ${JSON.stringify(text)}`);
		}
	});

	it("never flags a running turn, whatever the newest text already ends with", () => {
		assert.equal(turnActivity(snapshot({ working: true, entries: [textEntry("a1", "stop", "Shall I proceed?")] }))?.trailingQuestion, false);
		// The in-flight reply is the newest text while a turn runs; its own text is not final yet.
		// A stream that is still arriving has no settled stop reason at all: what makes this
		// false is that the turn is running, not what the ghost currently says.
		assert.equal(turnActivity(snapshot({ working: true, stream: textReply("toolUse", "Shall I proceed?") }))?.trailingQuestion, false);
	});

	it("never flags an aborted, errored, truncated or tool-continuing reply", () => {
		for (const stopReason of ["aborted", "error", "length", "toolUse"] as const) {
			assert.equal(
				turnActivity(snapshot({ entries: [textEntry("a1", stopReason, "Shall I proceed?")] }))?.trailingQuestion,
				false,
				`flagged ${String(stopReason)}`,
			);
		}
	});

	it("flags the reply the user is actually looking at, not an older question", () => {
		// The newest assistant message carried no text (a tools-only step), so there is nothing
		// to read as a question — an older reply's question mark must not resurface.
		const snapshotWithStep = snapshot({ entries: [textEntry("a1", "stop", "Shall I proceed?"), entry("a2", reply("toolUse"))] });
		assert.equal(turnActivity(snapshotWithStep)?.trailingQuestion, false);
		// With a new completed reply the newest text decides again.
		const answered = snapshot({ entries: [textEntry("a1", "stop", "Shall I proceed?"), textEntry("a2", "stop", "Understood.")] });
		assert.equal(turnActivity(answered)?.trailingQuestion, false);
		assert.equal(
			turnActivity(snapshot({ entries: [textEntry("a1", "stop", "Understood."), textEntry("a2", "stop", "Anything else?")] }))?.trailingQuestion,
			true,
		);
	});

	it("flags nothing when no assistant reply exists at all", () => {
		assert.equal(turnActivity(snapshot())?.trailingQuestion, false);
		assert.equal(turnActivity(snapshot({ working: true }))?.trailingQuestion, false);
	});
});
