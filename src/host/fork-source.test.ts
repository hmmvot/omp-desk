/**
 * Behavioral tests for the disk half of a fork's preconditions, over real temporary session files in the OMP v3 format
 * the HistoryReader reads. Runner: `node --test src/host/fork-source.test.ts`.
 */
import assert from "node:assert/strict";
import { appendFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import type { ChatEntry } from "../chat/messages.ts";
import { awaitForkDisk, readForkDisk } from "./fork-source.ts";
import { ScratchDir, assistantMessage, jsonl, messageEntry, sessionFileText, userMessage } from "./rpc/test-support.ts";

const scratches: ScratchDir[] = [];
afterEach(async () => {
	for (const scratch of scratches.splice(0)) await scratch.remove();
});

async function scratch(): Promise<ScratchDir> {
	const created = await ScratchDir.create();
	scratches.push(created);
	return created;
}

/** One user/assistant pair: leaf `a0`. */
function pair(): ChatEntry[] {
	const user = messageEntry("u0", null, userMessage("question", 1_000));
	return [user, messageEntry("a0", user.id, assistantMessage("answer", 1_005))];
}

/** The next pair on top of `a0`: leaf `a1`. */
function nextPair(): ChatEntry[] {
	const user = messageEntry("u1", "a0", userMessage("again", 1_010));
	return [user, messageEntry("a1", user.id, assistantMessage("more", 1_015))];
}

describe("readForkDisk", () => {
	it("holds when the file contains the live leaf", async () => {
		const dir = await scratch();
		const file = await dir.file("holds.jsonl", sessionFileText({ entries: pair() }));
		assert.equal(await readForkDisk(file, "a0"), "holds");
	});

	it("holds when the live leaf is an earlier entry of the file", async () => {
		const dir = await scratch();
		const file = await dir.file("earlier.jsonl", sessionFileText({ entries: [...pair(), ...nextPair()] }));
		assert.equal(await readForkDisk(file, "a0"), "holds");
	});

	it("trails when the file does not contain the live leaf yet", async () => {
		const dir = await scratch();
		const file = await dir.file("trails.jsonl", sessionFileText({ entries: pair() }));
		assert.equal(await readForkDisk(file, "a1"), "trails");
	});

	it("holds for a null live leaf as long as the file has a durable entry, and trails for a header alone", async () => {
		const dir = await scratch();
		const filled = await dir.file("filled.jsonl", sessionFileText({ entries: pair() }));
		assert.equal(await readForkDisk(filled, null), "holds");
		const empty = await dir.file("empty.jsonl", sessionFileText({ entries: [] }));
		assert.equal(await readForkDisk(empty, null), "trails");
	});

	it("reports a missing file", async () => {
		const dir = await scratch();
		assert.equal(await readForkDisk(path.join(dir.dir, "absent.jsonl"), "a0"), "missing");
	});

	it("trails for a file that has no session header", async () => {
		const dir = await scratch();
		const file = await dir.file("headerless.jsonl", jsonl(pair()));
		assert.equal(await readForkDisk(file, "a0"), "trails");
	});
});

describe("awaitForkDisk", () => {
	it("returns at once when the file already holds the leaf", async () => {
		const dir = await scratch();
		const file = await dir.file("now.jsonl", sessionFileText({ entries: pair() }));
		const started = Date.now();
		assert.equal(await awaitForkDisk(file, "a0", { timeoutMs: 5_000, stepMs: 1_000 }), "holds");
		assert.ok(Date.now() - started < 900, "no waiting step was taken");
	});

	it("returns missing at once for an absent file", async () => {
		const dir = await scratch();
		const started = Date.now();
		assert.equal(await awaitForkDisk(path.join(dir.dir, "absent.jsonl"), "a0", { timeoutMs: 5_000, stepMs: 1_000 }), "missing");
		assert.ok(Date.now() - started < 900, "a missing file is not waited for");
	});

	it("returns trails once the wait has passed and the leaf never arrived", async () => {
		const dir = await scratch();
		const file = await dir.file("never.jsonl", sessionFileText({ entries: pair() }));
		const started = Date.now();
		assert.equal(await awaitForkDisk(file, "a1", { timeoutMs: 60, stepMs: 10 }), "trails");
		assert.ok(Date.now() - started >= 50, "the writer was given the whole wait");
	});

	it("holds when the writer appends the leaf during the wait", async () => {
		const dir = await scratch();
		const file = await dir.file("late.jsonl", sessionFileText({ entries: pair() }));
		const append = (async () => {
			// A real delay: awaitForkDisk polls on the platform clock and has no injectable timer.
			await delay(40);
			await appendFile(file, jsonl(nextPair()));
		})();
		assert.equal(await awaitForkDisk(file, "a1", { timeoutMs: 3_000, stepMs: 10 }), "holds");
		await append;
	});
});
