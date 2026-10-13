/** What an empty chat offers to go back to: same folder, not itself, newest first, three at most. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_RECENT_TITLE_LENGTH } from "../protocol/messages.ts";
import { recentSessionsOf, recentTitle } from "./recent-sessions.ts";
import type { RecentCandidate, RecentSession } from "./recent-sessions.ts";

function row(tabId: string, over: Partial<{ headline: string; cwd: string; kind: string; lastAt: string | null | undefined }> = {}): RecentCandidate {
	const lastAt = "lastAt" in over ? over.lastAt : "2026-10-13T10:00:00.000Z";
	return {
		tabId,
		headline: over.headline ?? `Title of ${tabId}`,
		entry: { kind: over.kind ?? "session", cwd: over.cwd ?? "/work/app" },
		conversation: lastAt === undefined ? null : { lastAt },
	};
}

const tabs = (chosen: RecentSession[]): string[] => chosen.map(({ row }) => row.tabId);

describe("recentSessionsOf", () => {
	it("keeps the folder's own sessions, newest first, three at most", () => {
		const rows = [
			row("old", { lastAt: "2026-10-10T10:00:00.000Z" }),
			row("newest", { lastAt: "2026-10-13T12:00:00.000Z" }),
			row("elsewhere", { cwd: "/work/other", lastAt: "2026-10-13T13:00:00.000Z" }),
			row("middle", { lastAt: "2026-10-12T10:00:00.000Z" }),
			row("older", { lastAt: "2026-10-11T10:00:00.000Z" }),
		];
		assert.deepEqual(tabs(recentSessionsOf(rows, "/work/app", null, 3)), ["newest", "middle", "older"]);
	});

	it("leaves out the editor's own conversation, drafts and rows whose activity or title is not read", () => {
		const rows = [
			row("self", { lastAt: "2026-10-13T13:00:00.000Z" }),
			row("draft", { kind: "draft", lastAt: "2026-10-13T12:00:00.000Z" }),
			row("unread-yet", { lastAt: undefined }),
			row("no-activity", { lastAt: null }),
			row("garbage", { lastAt: "not a date" }),
			row("untitled", { headline: " \n\t " }),
			row("kept", { lastAt: "2026-10-01T10:00:00.000Z" }),
		];
		assert.deepEqual(tabs(recentSessionsOf(rows, "/work/app", "self", 3)), ["kept"]);
	});

	it("compares folders by identity, not by spelling", () => {
		const rows = [row("slashes", { cwd: "d:\\Work\\App\\" }), row("case", { cwd: "D:/work/app" })];
		const chosen = recentSessionsOf(rows, "d:/work/app", null, 3);
		assert.equal(chosen.length, 2, "both spell the same folder");
		assert.equal(recentSessionsOf(rows, "d:/work/application", null, 3).length, 0);
	});

	it("reports the conversation's activity in epoch milliseconds with a one-line title", () => {
		const [only] = recentSessionsOf([row("a", { headline: "Fix\nthe   login  flow", lastAt: "2026-10-13T10:00:00.000Z" })], "/work/app", null, 3);
		assert.equal(only?.title, "Fix the login flow");
		assert.equal(only?.updatedAt, Date.UTC(2026, 9, 13, 10));
	});
});

describe("recentTitle", () => {
	it("bounds a long headline with an ellipsis and collapses control characters", () => {
		const long = recentTitle("x".repeat(MAX_RECENT_TITLE_LENGTH + 50));
		assert.equal(long.length, MAX_RECENT_TITLE_LENGTH);
		assert.ok(long.endsWith("…"));
		assert.equal(recentTitle("a\u0000b\u007fc"), "a b c");
		assert.equal(recentTitle("short"), "short");
	});
});
