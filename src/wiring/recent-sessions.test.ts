/** The recents answer and the click on one of its rows: a page names a row only by the answer's id and ordinal. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionIndex } from "../host/session-index.ts";
import type { RecentCandidate } from "../views/recent-sessions.ts";
import { registerRecentSessions } from "./recent-sessions.ts";
import type { RecentDocument } from "./recent-sessions.ts";

const INDEX = {} as SessionIndex;

function row(tabId: string, lastAt: string, cwd = "/work/app"): RecentCandidate {
	return { tabId, headline: `Session ${tabId}`, entry: { kind: "session", cwd }, conversation: { lastAt } };
}

function world(initial: RecentCandidate[]) {
	const state = { rows: initial };
	const clicked: string[] = [];
	const infos: string[] = [];
	const recents = registerRecentSessions({
		listed: () => state.rows,
		itemFor: async tabId => state.rows.find(candidate => candidate.tabId === tabId),
		click: async (_index, picked) => { clicked.push(picked.tabId); },
		info: message => { infos.push(message); },
	});
	const document: RecentDocument = { slot: "slot-1", panel: {}, document: { kind: "guest" } };
	return { state, clicked, infos, recents, document };
}

const STALE = "That session is not listed in Sessions any more. Refresh and try again.";

describe("recent sessions", () => {
	it("answers with titles and ages of the folder's newest sessions and nothing that names one", () => {
		const w = world([
			row("a", "2026-10-13T09:00:00.000Z"),
			row("b", "2026-10-13T11:00:00.000Z"),
			row("self", "2026-10-13T12:00:00.000Z"),
			row("other-folder", "2026-10-13T12:30:00.000Z", "/work/other"),
		]);
		const answer = w.recents.answer(w.document, "/work/app", "self", 7);
		assert.deepEqual(answer, {
			type: "omp:recent-sessions",
			requestId: 7,
			items: [
				{ title: "Session b", updatedAt: Date.UTC(2026, 9, 13, 11) },
				{ title: "Session a", updatedAt: Date.UTC(2026, 9, 13, 9) },
			],
		});
		assert.doesNotMatch(JSON.stringify(answer), /tab|slot|\/work/);
	});

	it("opens the clicked row through the Sessions click, by the answer's id and ordinal", async () => {
		const w = world([row("a", "2026-10-13T09:00:00.000Z"), row("b", "2026-10-13T11:00:00.000Z")]);
		w.recents.answer(w.document, "/work/app", null, 3);
		await w.recents.open(INDEX, w.document, { type: "omp:open-recent", requestId: 3, index: 1 });
		assert.deepEqual([w.clicked, w.infos], [["a"], []], "ordinal 1 is the older row");
		await w.recents.open(INDEX, w.document, { type: "omp:open-recent", requestId: 3, index: 0 });
		assert.deepEqual(w.clicked, ["a", "b"]);
	});

	it("refuses a pick the last answer for this document does not hold", async () => {
		const w = world([row("a", "2026-10-13T09:00:00.000Z")]);
		const pick = (requestId: number, index: number) => ({ type: "omp:open-recent", requestId, index }) as const;
		// Nothing was answered yet.
		await w.recents.open(INDEX, w.document, pick(1, 0));
		w.recents.answer(w.document, "/work/app", null, 5);
		// An earlier request's id, and an ordinal beyond the answer.
		await w.recents.open(INDEX, w.document, pick(4, 0));
		await w.recents.open(INDEX, w.document, pick(5, 1));
		assert.deepEqual(w.clicked, []);
		assert.deepEqual(w.infos, [STALE, STALE, STALE]);
	});

	it("does not honour an answer given to another document of the same editor, or one for another editor", async () => {
		const w = world([row("a", "2026-10-13T09:00:00.000Z")]);
		w.recents.answer(w.document, "/work/app", null, 2);
		const rebound: RecentDocument = { ...w.document, document: { kind: "guest" } };
		await w.recents.open(INDEX, rebound, { type: "omp:open-recent", requestId: 2, index: 0 });
		const reopened: RecentDocument = { ...w.document, panel: {} };
		await w.recents.open(INDEX, reopened, { type: "omp:open-recent", requestId: 2, index: 0 });
		await w.recents.open(INDEX, { ...w.document, slot: "slot-2" }, { type: "omp:open-recent", requestId: 2, index: 0 });
		assert.deepEqual([w.clicked, w.infos.length], [[], 3]);
		// The rebound document's own answer works, and the old one is gone for good.
		w.recents.answer(rebound, "/work/app", null, 2);
		await w.recents.open(INDEX, rebound, { type: "omp:open-recent", requestId: 2, index: 0 });
		await w.recents.open(INDEX, w.document, { type: "omp:open-recent", requestId: 2, index: 0 });
		assert.deepEqual([w.clicked, w.infos.length], [["a"], 4]);
	});

	it("says so when the session left Sessions between the answer and the click", async () => {
		const w = world([row("a", "2026-10-13T09:00:00.000Z")]);
		w.recents.answer(w.document, "/work/app", null, 1);
		w.state.rows = [];
		await w.recents.open(INDEX, w.document, { type: "omp:open-recent", requestId: 1, index: 0 });
		assert.deepEqual([w.clicked, w.infos], [[], [STALE]]);
	});
});
