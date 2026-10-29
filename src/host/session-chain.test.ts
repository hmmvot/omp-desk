/**
 * Tests for session continuations (OMP 18.13): the proof that one file is the same conversation carried on in a newer
 * file, and the grouping of listed files into chains. Real files in a scratch directory, the way OMP writes them.
 *
 * Runner: `node:test`. Run with `node --test src/host/session-chain.test.ts`.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { groupChains, MAX_CONTINUATION_HOPS, proveContinuation } from "./session-chain.ts";
import type { ChainMember } from "./session-chain.ts";
import { parseSessionFileHeader } from "./session-files.ts";

let root = "";
let counter = 0;

before(async () => {
	root = await mkdtemp(path.join(tmpdir(), "omp-chain-"));
});
after(async () => {
	await rm(root, { recursive: true, force: true });
});

/** A fresh directory per test: a chain never crosses one, and tests must not see each other's files. */
async function scratch(): Promise<string> {
	const directory = path.join(root, `d${++counter}`);
	await mkdir(directory, { recursive: true });
	return directory;
}

/** A session file as OMP 18.13 writes it: the title slot, then the header (the link before the carried fields). */
async function session(directory: string, id: string, options: { continuationOf?: string; time?: string; name?: string } = {}): Promise<string> {
	const file = path.join(directory, options.name ?? `${options.time ?? "2026-10-29T12-00-00-000Z"}_${id}.jsonl`);
	const slot = JSON.stringify({ type: "title", v: 1, title: "", updatedAt: "2026-10-29T12:00:00.000Z", pad: " ".repeat(8) });
	const header = JSON.stringify({
		type: "session",
		version: 3,
		id,
		timestamp: "2026-10-29T12:00:00.000Z",
		...(options.continuationOf === undefined ? {} : { parentSession: options.continuationOf, continuationOf: options.continuationOf }),
		cwd: "C:\\work",
	});
	await writeFile(file, `${slot}\n${header}\n`, "utf8");
	return file;
}

describe("session header continuation link", () => {
	it("reads continuationOf from the header and leaves it out of a session that continues nothing", () => {
		const base = { type: "session", id: "B", cwd: "C:\\w" };
		assert.equal(parseSessionFileHeader(`${JSON.stringify({ ...base, continuationOf: "A", parentSession: "A" })}\n`)?.continuationOf, "A");
		assert.equal("continuationOf" in (parseSessionFileHeader(`${JSON.stringify(base)}\n`) ?? {}), false);
		assert.equal("continuationOf" in (parseSessionFileHeader(`${JSON.stringify({ ...base, continuationOf: "" })}\n`) ?? {}), false);
	});
});

describe("proveContinuation", () => {
	it("proves a direct continuation (one hop) with the ids of both headers", async () => {
		const directory = await scratch();
		const first = await session(directory, "AAA", { time: "2026-10-29T12-00-00-000Z" });
		const second = await session(directory, "BBB", { continuationOf: "AAA", time: "2026-10-29T12-05-00-000Z" });
		assert.deepEqual(await proveContinuation(first, second), { fromFile: first, toFile: second, fromId: "AAA", toId: "BBB", hops: 1 });
	});

	it("proves a continuation of a continuation (two hops) from the first file, and one hop from the second", async () => {
		const directory = await scratch();
		const first = await session(directory, "AAA");
		const second = await session(directory, "BBB", { continuationOf: "AAA", time: "2026-10-29T12-05-00-000Z" });
		const third = await session(directory, "CCC", { continuationOf: "BBB", time: "2026-10-29T12-10-00-000Z" });
		assert.deepEqual(await proveContinuation(first, third), { fromFile: first, toFile: third, fromId: "AAA", toId: "CCC", hops: 2 });
		assert.equal((await proveContinuation(second, third))?.hops, 1);
	});

	it("is not symmetric: the older file is never a continuation of the newer one, and a file never continues itself", async () => {
		const directory = await scratch();
		const first = await session(directory, "AAA");
		const second = await session(directory, "BBB", { continuationOf: "AAA", time: "2026-10-29T12-05-00-000Z" });
		assert.equal(await proveContinuation(second, first), null);
		assert.equal(await proveContinuation(first, first), null);
	});

	it("refuses a link that names a session of no file of the directory (forged or unrelated continuationOf)", async () => {
		const directory = await scratch();
		const first = await session(directory, "AAA");
		const forged = await session(directory, "ZZZ", { continuationOf: "GHOST", time: "2026-10-29T12-05-00-000Z" });
		assert.equal(await proveContinuation(first, forged), null);
	});

	it("refuses a continuation of another session: the chain does not reach the file asked for", async () => {
		const directory = await scratch();
		const asked = await session(directory, "AAA");
		const other = await session(directory, "OTH");
		const unrelated = await session(directory, "CCC", { continuationOf: "OTH", time: "2026-10-29T12-05-00-000Z" });
		assert.equal(await proveContinuation(asked, unrelated), null);
		assert.equal((await proveContinuation(other, unrelated))?.hops, 1);
	});

	it("refuses a file without a link, an unreadable file and a missing file", async () => {
		const directory = await scratch();
		const first = await session(directory, "AAA");
		const plain = await session(directory, "BBB", { time: "2026-10-29T12-05-00-000Z" });
		assert.equal(await proveContinuation(first, plain), null);
		assert.equal(await proveContinuation(first, path.join(directory, "2026-10-29T12-06-00-000Z_NOPE.jsonl")), null);
		assert.equal(await proveContinuation(path.join(directory, "2026-10-29T12-06-00-000Z_NOPE.jsonl"), plain), null);
		const junk = path.join(directory, "2026-10-29T12-07-00-000Z_JUNK.jsonl");
		await writeFile(junk, "not json\n", "utf8");
		assert.equal(await proveContinuation(first, junk), null);
	});

	it("refuses a cycle, even one that never reaches the file asked for", async () => {
		const directory = await scratch();
		const asked = await session(directory, "AAA");
		const left = await session(directory, "LLL", { continuationOf: "RRR", time: "2026-10-29T12-05-00-000Z" });
		await session(directory, "RRR", { continuationOf: "LLL", time: "2026-10-29T12-06-00-000Z" });
		assert.equal(await proveContinuation(asked, left), null);
	});

	it("refuses a chain longer than the bound and accepts one exactly as long", async () => {
		const directory = await scratch();
		const first = await session(directory, "N0");
		let last = first;
		for (let hop = 1; hop <= MAX_CONTINUATION_HOPS; hop++) last = await session(directory, `N${hop}`, { continuationOf: `N${hop - 1}`, time: `2026-10-29T13-${String(hop).padStart(2, "0")}-00-000Z` });
		assert.equal((await proveContinuation(first, last))?.hops, MAX_CONTINUATION_HOPS);
		const beyond = await session(directory, "NEXT", { continuationOf: `N${MAX_CONTINUATION_HOPS}`, time: "2026-10-29T14-00-00-000Z" });
		assert.equal(await proveContinuation(first, beyond), null);
	});

	it("refuses a link that two files of the directory both answer to, and a file named for an id it does not hold", async () => {
		const directory = await scratch();
		const first = await session(directory, "AAA");
		const second = await session(directory, "BBB", { continuationOf: "AAA", time: "2026-10-29T12-05-00-000Z" });
		await session(directory, "AAA", { time: "2026-10-29T12-01-00-000Z" });
		assert.equal(await proveContinuation(first, second), null, "two files hold the id the link names");
		const dir2 = await scratch();
		const asked = await session(dir2, "AAA");
		const misnamed = await session(dir2, "XXX", { name: "2026-10-29T12-02-00-000Z_BBB.jsonl" });
		const child = await session(dir2, "CCC", { continuationOf: "BBB", time: "2026-10-29T12-05-00-000Z" });
		assert.equal(await proveContinuation(asked, child), null, "the file named for BBB holds XXX");
		assert.ok(misnamed);
	});

	it("refuses files of two directories and relative paths", async () => {
		const one = await scratch();
		const two = await scratch();
		const first = await session(one, "AAA");
		const second = await session(two, "BBB", { continuationOf: "AAA" });
		assert.equal(await proveContinuation(first, second), null);
		assert.equal(await proveContinuation("a.jsonl", "b.jsonl"), null);
	});

	it("finds the file asked for by its header id when its name is not the generated one", async () => {
		const directory = await scratch();
		const current = await session(directory, "AAA", { name: "current.jsonl" });
		const next = await session(directory, "BBB", { continuationOf: "AAA", time: "2026-10-29T12-05-00-000Z" });
		assert.equal((await proveContinuation(current, next))?.fromId, "AAA");
	});

	it("never builds a name pattern from an id with path characters", async () => {
		const directory = await scratch();
		const first = await session(directory, "AAA");
		const evil = await session(directory, "EVIL", { continuationOf: "..\\..\\x", time: "2026-10-29T12-05-00-000Z" });
		assert.equal(await proveContinuation(first, evil), null);
	});
});

describe("groupChains", () => {
	const member = (key: string, sessionId: string, continuationOf: string | null, directory = "C:\\s"): ChainMember => ({ key, directory, sessionId, continuationOf });

	it("groups a chain and leaves unrelated files alone, keeping the listed order", () => {
		const members = [member("a", "A", null), member("x", "X", null), member("b", "B", "A"), member("c", "C", "B")];
		assert.deepEqual(groupChains(members).map(chain => chain.map(entry => entry.key)), [["a", "b", "c"], ["x"]]);
	});

	it("does not link across directories, to an id nobody holds, or to an id two files hold", () => {
		const members = [member("a", "A", null, "C:\\one"), member("b", "B", "A", "C:\\two"), member("c", "C", "GHOST"), member("d1", "D", null), member("d2", "D", null), member("e", "E", "D")];
		assert.deepEqual(groupChains(members).map(chain => chain.map(entry => entry.key)), [["a"], ["b"], ["c"], ["d1"], ["d2"], ["e"]]);
	});

	it("keeps both branches of a parent in one chain and survives a cycle", () => {
		const branches = [member("a", "A", null), member("b", "B", "A"), member("c", "C", "A")];
		assert.deepEqual(groupChains(branches).map(chain => chain.map(entry => entry.key)), [["a", "b", "c"]]);
		const cycle = [member("l", "L", "R"), member("r", "R", "L")];
		assert.deepEqual(groupChains(cycle).map(chain => chain.map(entry => entry.key)), [["l", "r"]]);
	});
});
