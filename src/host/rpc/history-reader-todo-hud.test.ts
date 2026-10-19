/**
 * What the session file says about the TODO row (OMP's `todo_hud_state` entries and the date of the latest list), read by the
 * history reader. Runner: `node --test src/host/rpc/history-reader-todo-hud.test.ts`.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { ChatEntry } from "../../chat/messages.ts";
import { todoFingerprint } from "../../chat/todo-hud.ts";
import type { TodoPhase } from "../../chat/todos.ts";
import { chatSnapshotFromHistory, HistoryReader } from "./history-reader.ts";
import { ScratchDir, isoOf, messageEntry, sessionFileText, toolResultMessage, userMessage } from "./test-support.ts";

const scratches: ScratchDir[] = [];
afterEach(async () => {
	for (const scratch of scratches.splice(0)) await scratch.remove();
});

const closed: TodoPhase[] = [{ name: "Work", tasks: [{ content: "One", status: "completed" }, { content: "Two", status: "abandoned" }] }];
const reopened: TodoPhase[] = [{ name: "Work", tasks: [{ content: "One", status: "completed" }, { content: "Two", status: "pending" }] }];

const todoEntry = (id: string, parentId: string | null, phases: readonly TodoPhase[], at: number): ChatEntry => messageEntry(id, parentId, toolResultMessage(`call-${id}`, at, "todo", { op: "update", phases }));
const hudEntry = (id: string, parentId: string, data: unknown): ChatEntry => ({ type: "custom", id, parentId, timestamp: isoOf(9_000), customType: "todo_hud_state", data });
const choice = (sourceEntryId: string, phases: readonly TodoPhase[], visibility: unknown): unknown => ({ sourceEntryId, fingerprint: todoFingerprint(phases), visibility });

async function read(entries: readonly ChatEntry[]) {
	const dir = await ScratchDir.create();
	scratches.push(dir);
	const reader = await HistoryReader.open(await dir.file("session.jsonl", sessionFileText({ entries })));
	return reader.snapshot(10);
}

describe("HistoryReader todo row facts", () => {
	it("reports a list the terminal UI dismissed, with the time its entry was written", async () => {
		const snap = await read([todoEntry("t1", null, closed, 5_000), hudEntry("h1", "t1", choice("t1", closed, "dismissed"))]);
		assert.deepEqual(snap.todoHud, { fingerprint: todoFingerprint(closed), changedAt: 7_000, visibility: "dismissed" });
		assert.deepEqual(snap.todoSeed, closed);
	});

	it("lets the newest entry written for this list win, so a reveal after a dismissal shows it again", async () => {
		const snap = await read([
			todoEntry("t1", null, closed, 5_000),
			hudEntry("h1", "t1", choice("t1", closed, "dismissed")),
			hudEntry("h2", "h1", choice("t1", closed, "revealed")),
		]);
		assert.equal(snap.todoHud?.visibility, "revealed");
		const again = await read([
			todoEntry("t1", null, closed, 5_000),
			hudEntry("h1", "t1", choice("t1", closed, "revealed")),
			hudEntry("h2", "h1", choice("t1", closed, "dismissed")),
		]);
		assert.equal(again.todoHud?.visibility, "dismissed");
	});

	it("applies an entry only to the list it was written for", async () => {
		const stale = await read([
			todoEntry("t1", null, closed, 5_000),
			hudEntry("h1", "t1", choice("t1", closed, "dismissed")),
			todoEntry("t2", "h1", reopened, 6_000),
		]);
		assert.equal(stale.todoHud?.visibility, null, "a later list is not covered by the old dismissal");
		assert.equal(stale.todoHud?.changedAt, 8_000);
		const sameListNewEntry = await read([
			todoEntry("t1", null, closed, 5_000),
			hudEntry("h1", "t1", choice("t1", closed, "dismissed")),
			todoEntry("t2", "h1", closed, 6_000),
		]);
		assert.equal(sameListNewEntry.todoHud?.visibility, null, "an identical list in a newer entry is a new snapshot, as OMP identifies it");
		const wrongSource = await read([todoEntry("t1", null, closed, 5_000), hudEntry("h1", "t1", choice("other", closed, "dismissed"))]);
		assert.equal(wrongSource.todoHud?.visibility, null);
		const wrongFingerprint = await read([todoEntry("t1", null, closed, 5_000), hudEntry("h1", "t1", choice("t1", reopened, "dismissed"))]);
		assert.equal(wrongFingerprint.todoHud?.visibility, null);
	});

	it("ignores a visibility OMP does not define and an entry that carries no object", async () => {
		const snap = await read([
			todoEntry("t1", null, closed, 5_000),
			hudEntry("h1", "t1", choice("t1", closed, "hidden")),
			hudEntry("h2", "h1", "dismissed"),
			hudEntry("h3", "h2", null),
		]);
		assert.equal(snap.todoHud?.visibility, null);
	});

	it("dates a list a user edited and reports nothing when the file holds no list or a reset follows it", async () => {
		const edit: ChatEntry = { type: "custom", id: "e1", parentId: null, timestamp: isoOf(4_000), customType: "user_todo_edit", data: { phases: closed } };
		const edited = await read([edit]);
		assert.deepEqual(edited.todoHud, { fingerprint: todoFingerprint(closed), changedAt: 4_000, visibility: null });
		const none = await read([messageEntry("u1", null, userMessage("hello", 1_000))]);
		assert.equal(none.todoHud, null);
		assert.equal(none.todoSeed, null);
		const reset = await read([todoEntry("t1", null, closed, 5_000), { type: "reset_boundary", id: "b1", parentId: "t1", timestamp: isoOf(6_000) }]);
		assert.equal(reset.todoHud, null);
		assert.deepEqual(reset.todoSeed, []);
	});

	it("puts a dismissal into the disk-paint payload so a stopped session shows no cleared list", async () => {
		const dismissed = await read([todoEntry("t1", null, closed, 5_000), hudEntry("h1", "t1", choice("t1", closed, "dismissed"))]);
		const epoch = { nonce: "n", counter: 1 };
		assert.equal(chatSnapshotFromHistory(dismissed, epoch, "view-only", null, "stopped").todoHidden, true);
		const shown = await read([todoEntry("t1", null, closed, 5_000)]);
		assert.equal(chatSnapshotFromHistory(shown, epoch, "view-only", null, "stopped").todoHidden, false);
	});
});
