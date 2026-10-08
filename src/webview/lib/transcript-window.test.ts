/**
 * Behavioral tests for the transcript render window.
 *
 * The window is what the view mounts out of the replica: a bounded tail when the
 * reader is following the newest message, and a held row once they are reading
 * older ones. The cases worth pinning are the ones that turn the bound into a
 * visible defect:
 *
 * - the bound counts rows, not entries, so a run of row-less entries at the tail
 *   (tool results, developer text, hidden custom messages) cannot spend the
 *   window and open the view on nothing;
 * - a result the window holds but whose calling row stayed above it keeps its own
 *   card, in its own place in the row order and inside the same bound, instead of
 *   going down with the row that renders it or landing out of order at the end;
 * - a held top row does not move under a live append, so nothing on screen
 *   shifts while the session streams — while a transcript replaced wholesale
 *   falls back to the newest rows.
 *
 * Runner: `bun test src/webview/lib/transcript-window.test.ts`, or
 * `node --test src/webview/lib/transcript-window.test.ts`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { WireUsage } from "@oh-my-pi/pi-wire";
import type { AssistantMessage, ChatEntry } from "../../chat/messages.ts";
import { TRANSCRIPT_WINDOW_ROWS, pageTranscriptCards, transcriptWindow, type TranscriptWindow } from "./transcript-window.ts";
import { projectTranscript } from "../../chat/transcript.ts";

const USAGE: WireUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } };

function base(id: string): { id: string; parentId: null; timestamp: string } {
	return { id, parentId: null, timestamp: "2026-09-25T00:00:00.000Z" };
}

/** `count` consecutive user messages, in arrival order. */
function userEntries(prefix: string, count: number): ChatEntry[] {
	return Array.from({ length: count }, (_, index) => ({
		...base(`${prefix}${index}`),
		type: "message" as const,
		message: { role: "user" as const, content: `${prefix}${index}`, timestamp: index },
	}));
}

function assistantEntry(id: string, toolCallId: string): ChatEntry {
	const message: AssistantMessage = {
		role: "assistant",
		content: [{ type: "toolCall", id: toolCallId, name: "read", arguments: {} }],
		model: "test/model",
		usage: USAGE,
		stopReason: "toolUse",
		timestamp: 1,
	};
	return { ...base(id), type: "message", message };
}

function toolResultEntry(id: string, toolCallId: string): ChatEntry {
	return {
		...base(id),
		type: "message",
		message: {
			role: "toolResult",
			toolCallId,
			toolName: "read",
			content: [{ type: "text", text: "ok" }],
			isError: false,
			timestamp: 2,
		},
	};
}

/** Developer text and hidden custom messages: replicated, but with no row of their own. */
function rowLessEntry(id: string): ChatEntry {
	if (id.startsWith("dev")) {
		return { ...base(id), type: "message", message: { role: "developer", content: "context", timestamp: 3 } };
	}
	return { ...base(id), type: "custom_message", customType: "note", content: "hidden", display: false };
}

function orphanTools(view: TranscriptWindow): string[] {
	return view.rows.flatMap(card => {
		const tools = card.kind === "tool" ? [card.tool] : [];
		return tools.filter(tool => !view.rows.some(owner => owner.id === tool.entryId)).map(tool => tool.call.id);
	});
}

describe("transcript window", () => {

	it("opens on the newest rows and leaves the older ones to a reveal", () => {
		const entries = userEntries("u", 300);
		const view = transcriptWindow(entries, TRANSCRIPT_WINDOW_ROWS, null);
		assert.equal(view.rows.length, TRANSCRIPT_WINDOW_ROWS);
		assert.equal(view.topId, entries[200]?.id);
		const newest = view.rows.at(-1);
		assert.ok(newest?.kind === "entry");
		assert.ok(newest.entry.type === "message" && newest.entry.message.role === "user");
		assert.equal(newest.entry.message.content, "u299", "the newest message is mounted");
		assert.equal(view.olderRows, 200);
		assert.equal(view.earlierTopId, entries[100]?.id, "one bound up from the top row");
	});

	it("counts rows, not entries, so a row-less tail cannot empty the window", () => {
		// A long tool run: each call is followed by its result, and the session ends
		// on a stretch of results, developer text and hidden custom messages. A
		// suffix of raw entries would mount only those and paint an empty transcript.
		const entries: ChatEntry[] = [];
		for (let index = 0; index < 60; index += 1) {
			entries.push(assistantEntry(`a${index}`, `call${index}`), toolResultEntry(`r${index}`, `call${index}`));
		}
		for (let index = 0; index < 120; index += 1) {
			entries.push(rowLessEntry(index % 2 === 0 ? `dev${index}` : `note${index}`));
		}

		const view = transcriptWindow(entries, 10, null);
		assert.equal(view.rows.length, 10, "ten rendered cards, not ten entries");
		assert.equal(view.topId, "a50", "the window opens on a call row, never on a row-less entry");
		assert.equal(view.rows.at(-1)?.id, "a59", "the newest call row is mounted");
		const oldest = view.rows[0];
		assert.ok(oldest?.kind === "tool");
		assert.equal(oldest.tool.result?.toolCallId, "call50", "the oldest mounted call retains its paired result");
	});

	it("opens on the newest rows again when the pinned row is gone", () => {
		const entries = userEntries("u", 20);
		const opened = transcriptWindow(entries, 5, null);
		assert.equal(opened.topId, entries[15]?.id);

		// A transcript replaced wholesale — a different session — holds none of those ids.
		const replacement = userEntries("v", 20);
		const view = transcriptWindow(replacement, 5, opened.topId);
		assert.equal(view.topId, replacement[15]?.id);
		assert.equal(view.rows.length, 5);
	});

	it("keeps a result whose call row is outside the window in its own place", () => {
		// The call row is far above the bound, its result sits near the end, and a
		// user message follows it: the result has no row of its own, so it holds a
		// card — between the two, never appended after the later message.
		const entries: ChatEntry[] = [
			assistantEntry("owner", "call-owner"),
			...userEntries("u", 150),
			toolResultEntry("late-result", "call-owner"),
			...userEntries("later", 1),
		];
		const view = transcriptWindow(entries, TRANSCRIPT_WINDOW_ROWS, null);
		const result = view.rows.findIndex(entry => entry.id === "late-result");
		assert.ok(result >= 0, "the result is mounted");
		assert.ok(result < view.rows.findIndex(entry => entry.id === "later0"), "before the later message");
		assert.deepEqual(orphanTools(view), ["call-owner"]);
		assert.ok(!view.rows.some(entry => entry.id === "owner"), "the call row is outside the window");
		assert.equal(view.topId, "u52", "the result's card counts against the same bound");

		// Once the call row is inside the window the result is rendered on it, so
		// nothing is held apart.
		const held = transcriptWindow(entries, 200, null);
		assert.ok(held.rows.some(entry => entry.id === "owner"));
		assert.deepEqual(orphanTools(held), []);
	});

	it("bounds the window by cards when many results arrive apart from their calls", () => {
		// Every call row sits above the window, so each result is a card of its own:
		// the bound has to count them, or the initial render would grow with them.
		const entries: ChatEntry[] = [
			...Array.from({ length: 200 }, (_, index) => assistantEntry(`owner${index}`, `call${index}`)),
			...Array.from({ length: 200 }, (_, index) => toolResultEntry(`r${index}`, `call${index}`)),
		];
		const view = transcriptWindow(entries, TRANSCRIPT_WINDOW_ROWS, null);
		assert.ok(view.rows.every(card => card.kind === "tool"), "result cards render in this tail");
		assert.equal(orphanTools(view).length, TRANSCRIPT_WINDOW_ROWS);
		assert.equal(view.rows.length, TRANSCRIPT_WINDOW_ROWS);
	});

	it("puts a result back on its calling row when the reader reveals it, moving nothing", () => {
		const entries: ChatEntry[] = [
			assistantEntry("owner", "call-owner"),
			...userEntries("u", 150),
			toolResultEntry("late-result", "call-owner"),
		];
		const opened = transcriptWindow(entries, TRANSCRIPT_WINDOW_ROWS, null);
		assert.deepEqual(orphanTools(opened), ["call-owner"]);
		assert.equal(opened.earlierTopId, "owner", "one step up reaches the call row");

		const revealed = transcriptWindow(entries, TRANSCRIPT_WINDOW_ROWS, opened.earlierTopId);
		assert.ok(revealed.rows.some(entry => entry.id === "owner"));
		assert.deepEqual(orphanTools(revealed), [], "the call row renders the result now");
		const retainedIds = new Set(opened.rows.filter(card => card.id !== "late-result").map(card => card.id));
		assert.deepEqual(revealed.rows.filter(card => retainedIds.has(card.id)), opened.rows.filter(card => retainedIds.has(card.id)), "revealing the owner preserves the other visible messages");
	});

	it("holds the rows on screen in place when a live entry arrives", () => {
		const entries = userEntries("u", 20);
		const opened = transcriptWindow(entries, 5, null);
		assert.equal(opened.topId, entries[15]?.id);

		const added = [...entries, ...userEntries("live", 1)];
		// Unpinned, the bound slides: that is the view following the tail, where the
		// oldest row is off screen and a new row is what the reader is watching for.
		assert.notEqual(transcriptWindow(added, 5, null).topId, opened.topId);

		// Held at the row it opened on (the view pins it when the reader leaves the
		// tail), the append grows the transcript below the viewport: the top row is
		// the same row, nothing on screen moves, and no row is dropped.
		const held = transcriptWindow(added, 5, opened.topId);
		assert.equal(held.topId, opened.topId);
		assert.equal(held.rows.length, opened.rows.length + 1);
		assert.deepEqual(held.rows.slice(0, opened.rows.length), opened.rows);
	});

	it("reveals older rows above the window without dropping or reordering what is shown", () => {
		const entries = userEntries("u", 20);
		const opened = transcriptWindow(entries, 5, null);
		assert.equal(opened.earlierTopId, "u10");

		const revealed = transcriptWindow(entries, 5, opened.earlierTopId);
		assert.equal(revealed.topId, "u10");
		assert.equal(revealed.rows.length, 10);
		assert.equal(revealed.olderRows, 10);
		// The reveal prepends: everything already mounted is still mounted, in place.
		assert.deepEqual(revealed.rows.slice(revealed.rows.length - opened.rows.length), opened.rows);
	});

	it("reports no reveal left once the window reaches the oldest row", () => {
		const entries = userEntries("u", 4);
		const view = transcriptWindow(entries, 4, null);
		assert.equal(view.rows.length, 4);
		assert.equal(view.olderRows, 0);
		assert.equal(view.earlierTopId, null);
	});

	it("accessible pages stay at their end bookmark through prepend and live append, with exact next/previous coverage", () => {
		const history = userEntries("u", 300);
		const latest = pageTranscriptCards(projectTranscript(history), 100, null);
		assert.equal(latest.topId, "u200");
		assert.equal(latest.previousEndId, "u199");
		const earlier = pageTranscriptCards(projectTranscript(history), 100, latest.previousEndId);
		assert.deepEqual(earlier.rows.map(card => card.id), history.slice(100, 200).map(entry => entry.id));
		const changed = [...userEntries("older", 80), ...history, ...userEntries("new", 2)];
		const held = pageTranscriptCards(projectTranscript(changed), 100, earlier.endId);
		assert.deepEqual(held.rows.map(card => card.id), earlier.rows.map(card => card.id));
		assert.equal(held.newCount, 102);
		assert.equal(held.nextEndId, "u299");
		assert.equal(pageTranscriptCards(projectTranscript(changed), 100, held.nextEndId).topId, "u200");
		assert.equal(pageTranscriptCards(projectTranscript(changed), 100, null).topId, "u202");
	});

	it("a paged tail owns each late orphan once and returns it to the call on its earlier page", () => {
		const history = [assistantEntry("call", "late"), ...userEntries("u", 8), toolResultEntry("result", "late")];
		const projection = projectTranscript(history);
		const tail = pageTranscriptCards(projection, 5, null);
		assert.deepEqual(tail.rows.map(card => card.kind), ["entry", "entry", "entry", "entry", "tool"]);
		const orphan = tail.rows.at(-1);
		assert.ok(orphan?.kind === "tool");
		assert.equal(orphan.tool.call.id, "late");
		const earlier = pageTranscriptCards(projection, 5, tail.previousEndId);
		assert.equal(earlier.rows[0]?.kind === "tool" && earlier.rows[0]?.tool.result?.toolCallId, "late");
		assert.equal(earlier.rows.filter(card => card.kind === "tool").length, 1);
	});
});
