import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { readJournalCost, readJournalFacts } from "./session-cost.ts";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function journal(lines: readonly (object | string)[]): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), "omp-desk-journal-"));
	dirs.push(dir);
	const file = path.join(dir, "s.jsonl");
	await writeFile(file, lines.map(line => (typeof line === "string" ? line : JSON.stringify(line))).join("\n") + "\n");
	return file;
}
const assistant = (id: string, total: number) => ({ type: "message", id, parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "assistant", usage: { cost: { total } } } });
const compaction = (id: string, timestamp: string, extra: object = {}) => ({ type: "compaction", id, parentId: null, timestamp, summary: "s", firstKeptEntryId: "x", tokensBefore: 384000, ...extra });

describe("journal facts", () => {
	it("sums the spend of every entry and counts compactions and clears with the latest of each", async () => {
		const file = await journal([
			{ type: "session", id: "h", timestamp: "2026-01-01T00:00:00.000Z" },
			assistant("a1", 0.25), compaction("c1", "2026-01-02T00:00:00.000Z", { method: "soft", tokensAfter: 90000 }),
			assistant("a2", 0.5), { type: "reset_boundary", id: "r1", parentId: null, timestamp: "2026-01-03T00:00:00.000Z" },
			compaction("c2", "2026-01-05T00:00:00.000Z", { method: "snapcompact", warning: "freed too little" }),
			compaction("c0", "2026-01-04T00:00:00.000Z"),
			{ type: "model_usage", id: "m", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", usage: { cost: { total: 0.25 } } },
		]);
		assert.deepEqual(await readJournalFacts(file), {
			cost: 1, compactionCount: 3, clearCount: 1, lastClear: "2026-01-03T00:00:00.000Z",
			lastCompaction: { timestamp: "2026-01-05T00:00:00.000Z", method: "snapcompact", tokensBefore: 384000, tokensAfter: null, warning: "freed too little" },
		});
	});
	it("never mistakes message text for a boundary, skips a torn last line and an unparseable timestamp", async () => {
		const quoted = { type: "message", id: "u", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "{\"type\":\"compaction\",\"id\":\"fake\"}" } };
		const file = await journal([quoted, compaction("c1", "not a date"), "{\"type\":\"compaction\",\"id\":\"torn\",\"tim"]);
		assert.deepEqual(await readJournalFacts(file), { cost: 0, compactionCount: 1, lastCompaction: null, clearCount: 0, lastClear: null });
	});
	it("answers null for a file it cannot read, and the cost wrapper agrees with the facts", async () => {
		assert.equal(await readJournalFacts(path.join(tmpdir(), "omp-desk-no-such-journal.jsonl")), null);
		const file = await journal([assistant("a1", 1.5)]);
		assert.equal(await readJournalCost(file), 1.5);
		assert.equal(await readJournalCost(path.join(tmpdir(), "omp-desk-no-such-journal.jsonl")), null);
	});
});
