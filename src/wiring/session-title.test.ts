import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionIndexEntry } from "../host/session-model.ts";
import { adoptSessionTitle, type SessionTitleDeps } from "./session-title.ts";

const TAB = "tab:one";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

function rig(entry: Partial<SessionIndexEntry> | null) {
	// A partial fixture: the module under test reads only `title`, `sessionId` and `host`.
	const fixture = { title: null, sessionId: "sess-1", host: null, sessionFile: null, ...entry } as Mutable<SessionIndexEntry>;
	const row = entry === null ? null : fixture;
	const calls: string[] = [];
	const warnings: string[] = [];
	let failWith: Error | null = null;
	const deps: SessionTitleDeps = {
		index: {
			get: () => row,
			recordConversationState: async (_tab, update) => {
				if (failWith !== null) throw failWith;
				calls.push(`record ${update.title}`);
				if (row !== null) row.title = update.title;
			},
		},
		refreshLauncher: () => { calls.push("refresh"); },
		applyAppearance: async () => { calls.push("appearance"); },
		log: { warn: message => { warnings.push(message); } },
	};
	return { deps, calls, warnings, fail(error: Error) { failWith = error; } };
}

describe("taking the name OMP reports into the row and the tab", () => {
	it("records the name, repaints the Sessions view and renames the editor, for a fresh session with no file", async () => {
		const r = rig({ sessionFile: null });
		await adoptSessionTitle(r.deps, TAB, "sess-1", "  Fix the build  ");
		assert.deepEqual(r.calls, ["record Fix the build", "refresh", "appearance"]);
	});

	it("does the same for a session with a file", async () => {
		const r = rig({ sessionFile: "D:\\s\\a.jsonl", title: "Old name" });
		await adoptSessionTitle(r.deps, TAB, "sess-1", "New name");
		assert.deepEqual(r.calls, ["record New name", "refresh", "appearance"]);
	});

	it("changes nothing when the row already has the name, so Desk's own rename and OMP's echo of it do not fight", async () => {
		const r = rig({ title: "Same" });
		await adoptSessionTitle(r.deps, TAB, "sess-1", "Same");
		assert.deepEqual(r.calls, []);
	});

	it("ignores an empty name, a name without a session id, a row that is gone and a name of another session", async () => {
		const r = rig({ sessionId: "sess-1" });
		await adoptSessionTitle(r.deps, TAB, "sess-1", "   ");
		await adoptSessionTitle(r.deps, TAB, null, "No id");
		await adoptSessionTitle(r.deps, TAB, "sess-2", "Another session's name");
		assert.deepEqual(r.calls, []);
		const gone = rig(null);
		await adoptSessionTitle(gone.deps, TAB, "sess-1", "Orphan");
		assert.deepEqual(gone.calls, []);
	});

	it("checks the id the row recorded for its host before the file's id, and takes a name for a row that recorded none yet", async () => {
		const hostRecord = { sessionId: "host-id" } as SessionIndexEntry["host"];
		const hosted = rig({ sessionId: "file-id", host: hostRecord });
		await adoptSessionTitle(hosted.deps, TAB, "file-id", "Wrong id");
		assert.deepEqual(hosted.calls, []);
		await adoptSessionTitle(hosted.deps, TAB, "host-id", "Right id");
		assert.deepEqual(hosted.calls, ["record Right id", "refresh", "appearance"]);
		const unrecorded = rig({ sessionId: null });
		await adoptSessionTitle(unrecorded.deps, TAB, "sess-9", "Fresh");
		assert.deepEqual(unrecorded.calls, ["record Fresh", "refresh", "appearance"]);
	});

	it("warns and goes on when the name cannot be recorded", async () => {
		const r = rig({});
		r.fail(new Error("catalog storage write failed"));
		await adoptSessionTitle(r.deps, TAB, "sess-1", "Lost");
		assert.deepEqual(r.calls, []);
		assert.deepEqual(r.warnings, ["Session title could not be refreshed: catalog storage write failed"]);
	});
});
