/**
 * Tests for the native watch's application of an observation: a session file OMP moved to (a proven continuation,
 * OMP 18.13) is still the row's conversation; any other different file stays a `/resume`/`/new` handover.
 * Real continuation files in a scratch directory; the index, window and identity are recording doubles.
 *
 * Runner: `node --test src/runtime/local-native-watch.test.ts`.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import type { ContinuationProof } from "../host/session-chain.ts";
import { LocalNativeWatch } from "./local-native-watch.ts";

const TAB = "tab-1";
let root = "";
let counter = 0;

before(async () => {
	root = await mkdtemp(path.join(tmpdir(), "omp-watch-"));
});
after(async () => {
	await rm(root, { recursive: true, force: true });
});

async function scratch(): Promise<string> {
	const directory = path.join(root, `d${++counter}`);
	await mkdir(directory, { recursive: true });
	return directory;
}

/** A session file as OMP 18.13 writes it: the title slot, then the header. */
async function session(directory: string, id: string, options: { continuationOf?: string; time?: string } = {}): Promise<string> {
	const file = path.join(directory, `${options.time ?? "2026-10-29T12-00-00-000Z"}_${id}.jsonl`);
	const slot = JSON.stringify({ type: "title", v: 1, title: "", updatedAt: "2026-10-29T12:00:00.000Z", pad: " ".repeat(8) });
	const header = JSON.stringify({
		type: "session", version: 3, id, timestamp: "2026-10-29T12:00:00.000Z",
		...(options.continuationOf === undefined ? {} : { parentSession: options.continuationOf, continuationOf: options.continuationOf }),
		cwd: "C:\\work",
	});
	await writeFile(file, `${slot}\n${header}\n`, "utf8");
	return file;
}

interface Fixture {
	readonly watch: LocalNativeWatch;
	readonly calls: string[];
	readonly proofs: ContinuationProof[];
	readonly rows: Map<string, { tabId: string; sessionId: string | null; sessionFile: string | null; title: string; scope: string }>;
	observe(facts: { sessionId: string | null; sessionFile: string | null }): Promise<void>;
}

function fixture(row: { sessionId: string; sessionFile: string }, options: { accept: boolean }): Fixture {
	const calls: string[] = [];
	const proofs: ContinuationProof[] = [];
	const rows = new Map([[TAB, { tabId: TAB, sessionId: row.sessionId as string | null, sessionFile: row.sessionFile as string | null, title: "Title", scope: "workspace" }]]);
	const index = {
		get: (tabId: string) => rows.get(tabId) ?? null,
		list: () => [...rows.values()],
		recordHostSessionId: async (tabId: string, id: string) => { calls.push(`hostId:${tabId}:${id}`); },
		recordConversationState: async () => { calls.push("title"); },
		trackSession: async (input: { sessionFile: string }) => {
			calls.push("track");
			const created = { tabId: "tab-2", sessionId: null, sessionFile: input.sessionFile, title: "", scope: "workspace" };
			rows.set(created.tabId, created);
			return created;
		},
		createDraft: async () => { calls.push("draft"); return { tabId: "tab-3", sessionId: null, sessionFile: null, title: "", scope: "workspace" }; },
		transferNativeHost: async (request: { toTabId: string }) => { calls.push(`transfer:${request.toTabId}`); return { status: "refused", kind: "other", detail: "fixture" }; },
		bindEditorSlot: async () => undefined,
		setActiveTab: async () => undefined,
	};
	const identity = {
		bind: async () => { calls.push("bind"); },
		forget: () => { calls.push("forget"); },
		bindContinuation: async (tabId: string, _runtime: unknown, proof: ContinuationProof) => {
			calls.push(`continuation:${tabId}`);
			proofs.push(proof);
			if (!options.accept) return false;
			const current = rows.get(tabId)!;
			current.sessionFile = proof.toFile;
			current.sessionId = proof.toId;
			return true;
		},
	};
	const window = {
		titled: () => { calls.push("titled"); },
		committed: async (tabId: string) => { calls.push(`committed:${tabId}`); },
		passive: () => undefined, rebound: () => undefined, presented: async () => undefined, settled: () => undefined,
	};
	const mapping = { forConversation: () => null, reload: () => undefined, planRepointAgainst: () => ({ ok: true, value: {} }) };
	const watch = new LocalNativeWatch({
		index, window, identity, records: {}, control: {}, exit: {},
		reconciler: () => ({}), brokerSlots: () => mapping, log: { info: () => undefined },
	} as never);
	const runtime = { pid: 1, cwd: "C:\\work", identity: { childCreationTime: "created" }, observed: null };
	const state = { tabId: TAB, slotId: "slot-1", runtime, transitioning: false };
	return {
		watch, calls, proofs, rows,
		observe: facts => watch.observe(state as never, runtime as never, { available: true, cwd: "C:\\work", name: "Title", ...facts } as never),
	};
}

describe("LocalNativeWatch continuation", () => {
	it("follows a proven continuation on the same row: one bind with the proof, no second row, no transfer", async () => {
		const directory = await scratch();
		const first = await session(directory, "AAA");
		const second = await session(directory, "BBB", { continuationOf: "AAA", time: "2026-10-29T12-05-00-000Z" });
		const f = fixture({ sessionId: "AAA", sessionFile: first }, { accept: true });
		await f.observe({ sessionId: "BBB", sessionFile: second });
		assert.deepEqual(f.proofs, [{ fromFile: first, toFile: second, fromId: "AAA", toId: "BBB", hops: 1 }]);
		assert.deepEqual(f.calls, [`continuation:${TAB}`, `hostId:${TAB}:BBB`, `committed:${TAB}`]);
		assert.equal(f.rows.size, 1);
		assert.equal(f.rows.get(TAB)?.sessionFile, second);
	});

	it("follows a two-hop continuation", async () => {
		const directory = await scratch();
		const first = await session(directory, "AAA");
		await session(directory, "BBB", { continuationOf: "AAA", time: "2026-10-29T12-05-00-000Z" });
		const third = await session(directory, "CCC", { continuationOf: "BBB", time: "2026-10-29T12-10-00-000Z" });
		const f = fixture({ sessionId: "AAA", sessionFile: first }, { accept: true });
		await f.observe({ sessionId: "CCC", sessionFile: third });
		assert.equal(f.proofs[0]?.hops, 2);
		assert.deepEqual(f.calls, [`continuation:${TAB}`, `hostId:${TAB}:CCC`, `committed:${TAB}`]);
	});

	it("falls through to the handover when the catalog refuses the continuation", async () => {
		const directory = await scratch();
		const first = await session(directory, "AAA");
		const second = await session(directory, "BBB", { continuationOf: "AAA", time: "2026-10-29T12-05-00-000Z" });
		const f = fixture({ sessionId: "AAA", sessionFile: first }, { accept: false });
		await f.observe({ sessionId: "BBB", sessionFile: second });
		assert.equal(f.proofs.length, 1);
		assert.deepEqual(f.calls, [`continuation:${TAB}`, "track", "transfer:tab-2"]);
	});

	it("keeps the handover for a different file that proves nothing (unrelated and forged links)", async () => {
		const directory = await scratch();
		const first = await session(directory, "AAA");
		const unrelated = await session(directory, "UUU", { time: "2026-10-29T12-05-00-000Z" });
		const forged = await session(directory, "FFF", { continuationOf: "GHOST", time: "2026-10-29T12-06-00-000Z" });
		for (const [id, file] of [["UUU", unrelated], ["FFF", forged]] as const) {
			const f = fixture({ sessionId: "AAA", sessionFile: first }, { accept: true });
			await f.observe({ sessionId: id, sessionFile: file });
			assert.deepEqual(f.proofs, []);
			assert.deepEqual(f.calls, ["track", "transfer:tab-2"]);
		}
	});

	it("does not accept a proven file whose id differs from the one the process reports", async () => {
		const directory = await scratch();
		const first = await session(directory, "AAA");
		const second = await session(directory, "BBB", { continuationOf: "AAA", time: "2026-10-29T12-05-00-000Z" });
		const f = fixture({ sessionId: "AAA", sessionFile: first }, { accept: true });
		await f.observe({ sessionId: "OTHER", sessionFile: second });
		assert.deepEqual(f.proofs, []);
		assert.deepEqual(f.calls, ["track", "transfer:tab-2"]);
	});

	it("leaves the same file and id on the ordinary same-row path without asking for a proof", async () => {
		const directory = await scratch();
		const first = await session(directory, "AAA");
		const f = fixture({ sessionId: "AAA", sessionFile: first }, { accept: true });
		await f.observe({ sessionId: "AAA", sessionFile: first });
		assert.deepEqual(f.calls, [`hostId:${TAB}:AAA`, `committed:${TAB}`]);
	});
});
