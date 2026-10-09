/**
 * Behavioral tests for the read-only session-file reader: the fixed title slot line, the partial last line, the tail
 * window and its `olderCount`, on-demand older rows, active-path filtering, growth, atomic rewrite, legacy ids, an
 * oversize row, a large file, and (ADR-0051) a snapshot at a given leaf, ancestry-walking older rows, and branch
 * points with their previews. Runner: `node --test src/host/rpc/history-reader.test.ts`.
 */
import assert from "node:assert/strict";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { rendersTranscriptEntry } from "../../chat/transcript.ts";
import type { ChatEntry } from "../../chat/messages.ts";
import {
	ENTRY_TOO_LARGE_CUSTOM_TYPE,
	HistoryReadError,
	HistoryReader,
	rendersByFacts,
} from "./history-reader.ts";
import {
	ScratchDir,
	assistantMessage,
	jsonl,
	messageEntry,
	sessionFileText,
	toolResultMessage,
	userMessage,
} from "./test-support.ts";

const scratches: ScratchDir[] = [];
afterEach(async () => {
	for (const scratch of scratches.splice(0)) await scratch.remove();
});

async function scratch(): Promise<ScratchDir> {
	const created = await ScratchDir.create();
	scratches.push(created);
	return created;
}

/** A linear conversation of `pairs` user/assistant pairs. */
function conversation(pairs: number): ChatEntry[] {
	const rows: ChatEntry[] = [];
	let parent: string | null = null;
	for (let index = 0; index < pairs; index += 1) {
		const user = messageEntry(`u${index}`, parent, userMessage(`q${index}`, 1_000 + index * 10));
		const reply = messageEntry(`a${index}`, user.id, assistantMessage(`r${index}`, 1_005 + index * 10));
		rows.push(user, reply);
		parent = reply.id;
	}
	return rows;
}

describe("HistoryReader", () => {
	it("skips the title slot, reads the header, and returns the tail window with olderCount", async () => {
		const dir = await scratch();
		const file = await dir.file("a.jsonl", sessionFileText({ id: "abc", title: "My title", entries: conversation(5) }));
		const reader = await HistoryReader.open(file);
		const snap = await reader.snapshot(4);
		assert.equal(snap.header.id, "abc");
		assert.equal(snap.title, "My title");
		assert.deepEqual(snap.entries.map(entry => entry.id), ["u3", "a3", "u4", "a4"]);
		assert.equal(snap.olderCount, 6);
		assert.equal(snap.leafId, "a4");
		assert.equal(snap.lastId, "a4");
		assert.equal(snap.legacyIds, false);
	});

	it("ignores an incomplete last line and picks it up once it is completed", async () => {
		const dir = await scratch();
		const rows = conversation(2);
		const extra = JSON.stringify(messageEntry("u2", "a1", userMessage("late", 5000)));
		const file = await dir.file("b.jsonl", sessionFileText({ entries: rows, trailer: extra.slice(0, 40) }));
		const reader = await HistoryReader.open(file);
		assert.equal((await reader.snapshot()).lastId, "a1");
		await appendFile(file, `${extra.slice(40)}\n`);
		const refreshed = await reader.refresh();
		assert.deepEqual(refreshed, { appended: 1, reindexed: false });
		assert.equal((await reader.snapshot()).lastId, "u2");
	});

	it("serves older rows by byte range from the row the caller holds", async () => {
		const dir = await scratch();
		const file = await dir.file("c.jsonl", sessionFileText({ entries: conversation(6) }));
		const reader = await HistoryReader.open(file);
		const snap = await reader.snapshot(4);
		const top = snap.entries[0]!.id;
		const older = await reader.loadOlder(top, 4);
		assert.equal(older.found, true);
		assert.deepEqual(snap.entries.map(entry => entry.id), ["u4", "a4", "u5", "a5"]);
		assert.deepEqual(older.entries.map(entry => entry.id), ["u2", "a2", "u3", "a3"]);
		assert.equal(older.olderCount, snap.olderCount - 4);
		assert.equal((await reader.loadOlder("nope", 4)).found, false);
	});

	it("admits individual tools under the density-independent canonical budget", async () => {
		const dir = await scratch();
		const rows: ChatEntry[] = [messageEntry("start", null, userMessage("Read all files", 1))];
		for (let index = 0; index < 120; index += 1) {
			const callId = `read-${index}`;
			const assistant = assistantMessage("", index + 2);
			if (assistant.role !== "assistant") throw new Error("Invalid assistant fixture");
			const call = messageEntry(`a-${index}`, rows.at(-1)!.id, { ...assistant, content: [{ type: "toolCall", id: callId, name: "read", arguments: { path: `file-${index}.ts` } }] });
			const result = messageEntry(`r-${index}`, call.id, toolResultMessage(callId, index + 3, "read"));
			rows.push(call, result);
		}
		const file = await dir.file("reads.jsonl", sessionFileText({ entries: rows }));
		const snapshot = await (await HistoryReader.open(file)).snapshot(2);
		assert.equal(snapshot.entries[0]!.id, "a-118");
		assert.equal(snapshot.entries.at(-1)!.id, "r-119");
		assert.equal(snapshot.olderCount, 119);
	});

	it("keeps orphan tool output visible within the semantic card bound, excluding non-chat entries", async () => {
		const dir = await scratch();
		const call = messageEntry("t1", "a0", toolResultMessage("c1", 2_000));
		const rows: ChatEntry[] = [...conversation(1), call, messageEntry("u1", "t1", userMessage("next", 3_000))];
		const usage = { type: "model_usage", id: "mu", parentId: "u1", timestamp: "2026-01-01T00:00:00.000Z", purpose: "x" };
		const file = await dir.file("d.jsonl", sessionFileText({ entries: [...rows, usage] }));
		const reader = await HistoryReader.open(file);
		const snap = await reader.snapshot(2);
		assert.deepEqual(snap.entries.map(entry => entry.id), ["t1", "u1"], "orphan output costs one displayed card");
		assert.equal(snap.leafId, "mu", "the leaf is the last entry in file order, chat or not");
		assert.equal(snap.olderCount, 2);
	});

	it("keeps rows off the active path out of the window", async () => {
		const dir = await scratch();
		const rows: ChatEntry[] = [
			messageEntry("u0", null, userMessage("root", 1)),
			messageEntry("a0", "u0", assistantMessage("old branch", 2)),
			messageEntry("a0b", "u0", assistantMessage("new branch", 3)),
		];
		const file = await dir.file("e.jsonl", sessionFileText({ entries: rows }));
		const snap = await (await HistoryReader.open(file)).snapshot();
		assert.deepEqual(snap.entries.map(entry => entry.id), ["u0", "a0b"]);
	});

	it("re-indexes once when the file was rewritten under it, and reports a shrink", async () => {
		const dir = await scratch();
		const file = await dir.file("f.jsonl", sessionFileText({ entries: conversation(3) }));
		const reader = await HistoryReader.open(file);
		assert.equal((await reader.snapshot()).lastId, "a2");
		await writeFile(file, sessionFileText({ entries: conversation(2).map(entry => ({ ...entry, id: `n-${entry.id}`, parentId: entry.parentId === null ? null : `n-${entry.parentId}` })) }));
		const refreshed = await reader.refresh();
		assert.equal(refreshed.reindexed, true);
		assert.equal((await reader.snapshot()).lastId, "n-a1");
	});

	it("reports a missing file and a file without a session header as visible errors", async () => {
		const dir = await scratch();
		await assert.rejects(HistoryReader.open(`${dir.dir}/missing.jsonl`), (error: unknown) => error instanceof HistoryReadError && error.code === "missing");
		const bad = await dir.file("g.jsonl", jsonl([{ type: "message", id: "x" }]));
		await assert.rejects(HistoryReader.open(bad), (error: unknown) => error instanceof HistoryReadError && error.code === "no-header");
	});

	it("flags legacy ids (version below 3) so the cursor is not trusted, and walks the file order", async () => {
		const dir = await scratch();
		const rows = conversation(2).map(entry => ({ ...entry, parentId: null }));
		const file = await dir.file("h.jsonl", sessionFileText({ version: 1, entries: rows }));
		const snap = await (await HistoryReader.open(file)).snapshot();
		assert.equal(snap.legacyIds, true);
		assert.deepEqual(snap.entries.map(entry => entry.id), ["u0", "a0", "u1", "a1"]);
	});

	it("replaces an oversize row with a placeholder instead of dropping it", async () => {
		const dir = await scratch();
		const huge = messageEntry("big", "a0", assistantMessage("x".repeat(33 * 1024 * 1024), 9_000));
		const file = await dir.file("i.jsonl", sessionFileText({ entries: [...conversation(1), huge] }));
		const snap = await (await HistoryReader.open(file)).snapshot();
		const placeholder = snap.entries.find(entry => entry.id === "big");
		assert.ok(placeholder !== undefined && placeholder.type === "custom_message");
		assert.equal(placeholder.customType, ENTRY_TOO_LARGE_CUSTOM_TYPE);
	});

	it("indexes a large file and reads only the tail window", async () => {
		const dir = await scratch();
		const rows = conversation(20_000);
		const file = await dir.file("j.jsonl", sessionFileText({ entries: rows }));
		const started = Date.now();
		const reader = await HistoryReader.open(file);
		const snap = await reader.snapshot(100);
		assert.equal(snap.entries.length, 100);
		assert.equal(snap.olderCount, 40_000 - 100);
		assert.equal(snap.entries.at(-1)?.id, "a19999");
		assert.ok(Date.now() - started < 10_000, "indexing 40k entries is a bounded streaming pass");
	});

	it("tolerates entries whose id is not at a fixed position and does not render a session_exit", async () => {
		const dir = await scratch();
		const custom = { type: "custom", customType: "session_exit", data: {}, id: "ex", parentId: "a0", timestamp: "2026-01-01T00:00:00.000Z" };
		const file = await dir.file("k.jsonl", sessionFileText({ entries: [...conversation(1), custom] }));
		const snap = await (await HistoryReader.open(file)).snapshot();
		assert.deepEqual(snap.entries.map(entry => entry.id), ["u0", "a0", "ex"], "native custom metadata stays available to shared reducers");
		assert.deepEqual(snap.entries.filter(rendersTranscriptEntry).map(entry => entry.id), ["u0", "a0"], "session_exit still has no visible row");
		assert.equal(snap.leafId, "ex");
	});

	describe("saved image references", () => {
		const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8i8AAAAASUVORK5CYII=";

		/** OMP's layout: `<agent>/sessions/--cwd--/<file>.jsonl` beside `<agent>/blobs/<sha256>`. */
		async function agentLayout(imageRefs: readonly string[]): Promise<{ file: string; blobs: string }> {
			const dir = await scratch();
			const sessions = path.join(dir.dir, "agent", "sessions", "--D--scratch--");
			const blobs = path.join(dir.dir, "agent", "blobs");
			await mkdir(sessions, { recursive: true });
			await mkdir(blobs, { recursive: true });
			const user = {
				type: "message", id: "u-img", parentId: null, timestamp: "2026-01-01T00:00:00.000Z",
				message: { role: "user", timestamp: 1, content: [{ type: "text", text: "look" }, ...imageRefs.map(data => ({ type: "image", data, mimeType: "image/png" }))] },
			};
			const file = path.join(sessions, "2026-01-01T00-00-00-000Z_abc.jsonl");
			await writeFile(file, sessionFileText({ entries: [user] }));
			return { file, blobs };
		}

		function imagesOf(entries: readonly ChatEntry[]): { data: string; mimeType: string }[] {
			const entry = entries.find(item => item.id === "u-img");
			assert.ok(entry !== undefined && entry.type === "message" && entry.message.role === "user" && Array.isArray(entry.message.content));
			return (entry.message.content as readonly { type: string; data?: string; mimeType?: string }[]).filter(block => block.type === "image") as { data: string; mimeType: string }[];
		}

		it("swaps OMP's persisted blob:sha256 reference for the stored bytes", async () => {
			const bytes = Buffer.from(PNG, "base64");
			const hash = createHash("sha256").update(bytes).digest("hex");
			const { file, blobs } = await agentLayout([`blob:sha256:${hash}`]);
			await writeFile(path.join(blobs, hash), bytes);
			const snap = await (await HistoryReader.open(file)).snapshot();
			assert.deepEqual(imagesOf(snap.entries), [{ type: "image", data: PNG, mimeType: "image/png" }]);
		});

		it("keeps the reference for a missing, malformed or traversing blob so the page can say it is unavailable", async () => {
			const missing = `blob:sha256:${"0".repeat(64)}`;
			const traversal = "blob:sha256:../../../secret";
			const { file } = await agentLayout([missing, traversal]);
			const snap = await (await HistoryReader.open(file)).snapshot();
			assert.deepEqual(imagesOf(snap.entries).map(image => image.data), [missing, traversal]);
		});
	});
});

describe("rendersByFacts", () => {
	it("agrees with the transcript's own row rule", () => {
		const samples: { entry: ChatEntry; facts: Parameters<typeof rendersByFacts>[0] }[] = [
			{ entry: messageEntry("1", null, userMessage("x", 1)), facts: { type: "message", role: "user" } },
			{ entry: messageEntry("2", null, assistantMessage("x", 1)), facts: { type: "message", role: "assistant" } },
			{ entry: messageEntry("3", null, toolResultMessage("c", 1)), facts: { type: "message", role: "toolResult" } },
			{
				entry: { type: "custom_message", id: "4", parentId: null, timestamp: "", customType: "x", content: "", display: true },
				facts: { type: "custom_message", customType: "x", display: true },
			},
			{
				entry: { type: "custom_message", id: "5", parentId: null, timestamp: "", customType: "x", content: "", display: false },
				facts: { type: "custom_message", customType: "x", display: false },
			},
			{
				entry: { type: "custom_message", id: "6", parentId: null, timestamp: "", customType: "collab-prompt", content: "", display: false },
				facts: { type: "custom_message", customType: "collab-prompt", display: false },
			},
			{ entry: { type: "model_change", id: "7", parentId: null, timestamp: "", model: "p/m" }, facts: { type: "model_change" } },
			{ entry: { type: "compaction", id: "8", parentId: null, timestamp: "", summary: "", firstKeptEntryId: "1", tokensBefore: 1 }, facts: { type: "compaction" } },
		];
		for (const { entry, facts } of samples) assert.equal(rendersByFacts(facts), rendersTranscriptEntry(entry), entry.type);
		assert.equal(rendersByFacts({ type: "custom" }), false);
	});
});

describe("HistoryReader at a leaf that is not the last line (ADR-0051)", () => {
	const marker = (id: string, parentId: string): ChatEntry => ({ type: "custom", id, parentId, timestamp: "2026-01-01T00:00:00.000Z", customType: "omp-desk/navigation", data: {} });

	it("snapshots the path to the given leaf, not to the last entry of the file", async () => {
		const dir = await scratch();
		// u0..a2, then a rewind to a0 (marker m) and a new prompt on it: the file ends on the new branch.
		const rows = [...conversation(3), marker("m", "a0"), messageEntry("u1b", "m", userMessage("branch prompt", 5_000)), messageEntry("a1b", "u1b", assistantMessage("branch reply", 5_005))];
		const reader = await HistoryReader.open(await dir.file("leaf.jsonl", sessionFileText({ entries: rows })));
		const atEnd = await reader.snapshot(10);
		assert.deepEqual(atEnd.entries.map(entry => entry.id), ["u0", "a0", "m", "u1b", "a1b"]);
		assert.equal(atEnd.leafId, "a1b");
		assert.deepEqual(atEnd.branches, [{ entryId: "a0", branches: [{ tipId: "a2", firstPromptId: "u1", firstPrompt: "q1", messages: 4, prompts: 2 }] }]);
		const atOld = await reader.snapshot(10, "a2");
		assert.deepEqual(atOld.entries.map(entry => entry.id), ["u0", "a0", "u1", "a1", "u2", "a2"]);
		assert.equal(atOld.leafId, "a2");
		assert.equal(atOld.lastId, "a1b", "the cursor is still the last line of the file");
		assert.deepEqual(atOld.branches, [{ entryId: "a0", branches: [{ tipId: "a1b", firstPromptId: "u1b", firstPrompt: "branch prompt", messages: 2, prompts: 1 }] }], "a branch rooted at a marker counts when a prompt follows it");
		const tail = await reader.snapshot(2, "a2");
		assert.deepEqual(tail.entries.map(entry => entry.id), ["u2", "a2"]);
		assert.equal(tail.olderCount, 4);
		const unknown = await reader.snapshot(10, "not-indexed");
		assert.equal(unknown.leafId, "a1b", "an unindexed leaf falls back to the file's last entry, which the caller can tell apart");
	});

	it("loads older rows along the ancestors of the row held, not in file order", async () => {
		const dir = await scratch();
		// u0..a3, then a second branch off a1 written after it: u2b..a3b.
		const branch = [
			messageEntry("u2b", "a1", userMessage("b2", 6_000)),
			messageEntry("a2b", "u2b", assistantMessage("rb2", 6_005)),
			messageEntry("u3b", "a2b", userMessage("b3", 6_010)),
			messageEntry("a3b", "u3b", assistantMessage("rb3", 6_015)),
		];
		const reader = await HistoryReader.open(await dir.file("older.jsonl", sessionFileText({ entries: [...conversation(4), ...branch] })));
		const snap = await reader.snapshot(2);
		assert.deepEqual(snap.entries.map(entry => entry.id), ["u3b", "a3b"]);
		assert.equal(snap.olderCount, 6);
		const first = await reader.loadOlder("u3b", 2);
		assert.deepEqual(first.entries.map(entry => entry.id), ["u2b", "a2b"]);
		assert.equal(first.olderCount, 4);
		const second = await reader.loadOlder("u2b", 2);
		assert.deepEqual(second.entries.map(entry => entry.id), ["u1", "a1"], "across the branch point, never a3 (the line before u2b)");
		assert.equal(second.olderCount, 2);
		const other = await reader.snapshot(2, "a3");
		assert.deepEqual(other.entries.map(entry => entry.id), ["u3", "a3"]);
		assert.deepEqual((await reader.loadOlder("u3", 2)).entries.map(entry => entry.id), ["u2", "a2"]);
	});

	it("lists only user-rooted branches, newest first, capped per point", async () => {
		const dir = await scratch();
		const siblings = Array.from({ length: 25 }, (_, index) => messageEntry(`s${index}`, "a0", userMessage(`alt ${index}`, 7_000 + index)));
		// OMP's own pruning leaves a subtree rooted at an assistant message: not a branch the user made.
		const retry = messageEntry("retry", "u0", assistantMessage("discarded", 6_500));
		const reader = await HistoryReader.open(await dir.file("many.jsonl", sessionFileText({ entries: [...conversation(2), retry, ...siblings] })));
		const snap = await reader.snapshot(4, "a1");
		assert.equal(snap.branches.length, 1);
		const [point] = snap.branches;
		assert.equal(point!.entryId, "a0");
		assert.equal(point!.branches.length, 20);
		assert.deepEqual(point!.branches.slice(0, 2).map(branch => [branch.tipId, branch.firstPrompt]), [["s24", "alt 24"], ["s23", "alt 23"]]);
	});

	it("reads first-prompt previews for the newest 40 branches only", async () => {
		const dir = await scratch();
		const rows = conversation(46);
		const branches = Array.from({ length: 45 }, (_, index) => messageEntry(`b${index}`, `a${index}`, userMessage(`alt ${index}\nsecond line`, 9_000 + index)));
		const reader = await HistoryReader.open(await dir.file("previews.jsonl", sessionFileText({ entries: [...rows, ...branches] })));
		const snap = await reader.snapshot(4, "a45");
		assert.equal(snap.branches.length, 45);
		assert.deepEqual(snap.branches.map(point => point.entryId), Array.from({ length: 45 }, (_, index) => `a${index}`));
		const previews = snap.branches.map(point => point.branches[0]!.firstPrompt ?? null);
		assert.deepEqual(previews.slice(0, 5), [null, null, null, null, null], "the oldest points go without a preview");
		assert.deepEqual(previews.slice(5), Array.from({ length: 40 }, (_, index) => `alt ${index + 5}`), "the first line of the prompt");
		assert.ok(snap.branches.every(point => point.branches[0]!.firstPromptId === point.branches[0]!.tipId));
	});
});
