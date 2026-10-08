/**
 * Tests for the record lister of the Processes view, against real temporary directories.
 *
 * The lister reads this extension's records and, read-only, the predecessor id's; it drops
 * the token at the parse boundary; and it keeps what it parsed so that a registry full of
 * stopped brokers costs a directory listing per refresh, not a re-parse.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rename, rm, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { createBrokerRecordLister } from "./broker-process-records.ts";
import {
	PTY_PROTOCOL_VERSION,
	PTY_RECORD_VERSION,
	PTY_RUNTIME_VERSION,
	PTY_SERVICE,
	createPtyToken,
	isPtyBrokerId,
	isPtyCreationTime,
	isPtyDigest,
	isPtyGeneration,
} from "./pty-protocol.ts";
import type { PtyBrokerRecord } from "./pty-protocol.ts";
import { ptyStateDirectory } from "./pty-registry.ts";

const roots: string[] = [];

after(async () => {
	for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function makeStorage(): Promise<string> {
	const root = await mkdtemp(path.join(tmpdir(), "omp-broker-records-"));
	roots.push(root);
	return root;
}

let serial = 0;

/** A record that passes the registry's own parser. */
function record(slot: string, overrides: Partial<PtyBrokerRecord> = {}): PtyBrokerRecord {
	serial += 1;
	const made: PtyBrokerRecord = {
		version: PTY_RECORD_VERSION,
		service: PTY_SERVICE,
		protocolVersion: PTY_PROTOCOL_VERSION,
		runtimeVersion: PTY_RUNTIME_VERSION,
		treeDigest: "a".repeat(64),
		brokerId: `pty-${randomUUID()}`,
		generation: `gen-${randomUUID()}`,
		slot,
		kind: "managed-rpc",
		port: 50000 + serial,
		token: createPtyToken(),
		brokerPid: 3000 + serial,
		brokerCreationTime: "134349421014308869",
		startedAt: new Date(0).toISOString(),
		cols: 100,
		rows: 30,
		title: null,
		...overrides,
	};
	assert.ok(isPtyDigest(made.treeDigest) && isPtyBrokerId(made.brokerId) && isPtyGeneration(made.generation));
	assert.ok(made.brokerCreationTime === null || isPtyCreationTime(made.brokerCreationTime));
	return made;
}

async function publish(storage: string, file: string, content: unknown): Promise<string> {
	const directory = ptyStateDirectory(storage);
	await mkdir(directory, { recursive: true });
	const target = path.join(directory, file);
	await writeFile(target, typeof content === "string" ? content : JSON.stringify(content), "utf8");
	return target;
}

describe("broker record lister", () => {
	it("lists the current records, tagged as current", async () => {
		const storage = await makeStorage();
		const first = record("tab:a");
		const second = record("shell:b", { kind: "folder-shell" });
		await publish(storage, "pty-a.json", first);
		await publish(storage, "pty-b.json", second);
		const listing = await createBrokerRecordLister({ storageDir: storage, predecessorStorageDir: null })();
		assert.equal(listing.unreadable, 0);
		assert.deepEqual(listing.records.map(entry => entry.source), ["current", "current"]);
		assert.deepEqual(listing.records.map(entry => entry.record.slot).sort(), ["shell:b", "tab:a"]);
		const byslot = new Map(listing.records.map(entry => [entry.record.slot, entry.record] as const));
		assert.equal(byslot.get("tab:a")?.brokerId, first.brokerId);
		assert.equal(byslot.get("tab:a")?.brokerPid, first.brokerPid);
		assert.equal(byslot.get("shell:b")?.kind, "folder-shell");
	});

	it("lists a predecessor's records too, tagged as predecessor", async () => {
		const storage = await makeStorage();
		const predecessor = await makeStorage();
		await publish(storage, "pty-a.json", record("tab:a"));
		await publish(predecessor, "pty-old.json", record("tab:old"));
		const listing = await createBrokerRecordLister({ storageDir: storage, predecessorStorageDir: predecessor })();
		const bySlot = new Map(listing.records.map(entry => [entry.record.slot, entry.source] as const));
		assert.equal(bySlot.get("tab:a"), "current");
		assert.equal(bySlot.get("tab:old"), "predecessor");
		assert.equal(listing.records.length, 2);
	});

	it("does not read the predecessor when none is given", async () => {
		const storage = await makeStorage();
		const predecessor = await makeStorage();
		await publish(predecessor, "pty-old.json", record("tab:old"));
		const listing = await createBrokerRecordLister({ storageDir: storage, predecessorStorageDir: null })();
		assert.deepEqual(listing.records, []);
	});

	it("hands out records without their token", async () => {
		const storage = await makeStorage();
		const predecessor = await makeStorage();
		const current = record("tab:a");
		const old = record("tab:old");
		await publish(storage, "pty-a.json", current);
		await publish(predecessor, "pty-old.json", old);
		const listing = await createBrokerRecordLister({ storageDir: storage, predecessorStorageDir: predecessor })();
		assert.equal(listing.records.length, 2);
		for (const entry of listing.records) assert.equal("token" in entry.record, false);
		const serialized = JSON.stringify(listing);
		assert.equal(serialized.includes(current.token), false);
		assert.equal(serialized.includes(old.token), false);
	});

	it("counts a file it cannot parse as unreadable, and still lists the rest", async () => {
		const storage = await makeStorage();
		const predecessor = await makeStorage();
		await publish(storage, "pty-good.json", record("tab:good"));
		await publish(storage, "pty-garbage.json", "{ not json");
		await publish(storage, "pty-shape.json", { version: PTY_RECORD_VERSION, service: PTY_SERVICE });
		await publish(predecessor, "pty-old-garbage.json", "[]");
		const listing = await createBrokerRecordLister({ storageDir: storage, predecessorStorageDir: predecessor })();
		assert.deepEqual(listing.records.map(entry => entry.record.slot), ["tab:good"]);
		assert.equal(listing.unreadable, 3);
	});

	it("ignores lock files, temporary files and other names, and does not count them", async () => {
		const storage = await makeStorage();
		await publish(storage, "pty-a.json", record("tab:a"));
		await publish(storage, "pty-a.json.lock", "{\"pid\":1}");
		await publish(storage, "pty-a.json.tmp", "partial");
		await publish(storage, "notes.txt", "hello");
		const listing = await createBrokerRecordLister({ storageDir: storage, predecessorStorageDir: null })();
		assert.equal(listing.records.length, 1);
		assert.equal(listing.unreadable, 0);
	});

	it("answers an empty listing for a directory that does not exist", async () => {
		const storage = await makeStorage();
		const predecessor = await makeStorage();
		const listing = await createBrokerRecordLister({ storageDir: storage, predecessorStorageDir: predecessor })();
		assert.deepEqual(listing, { records: [], unreadable: 0 });
		const missing = await createBrokerRecordLister({ storageDir: path.join(storage, "nowhere"), predecessorStorageDir: null })();
		assert.deepEqual(missing, { records: [], unreadable: 0 });
	});

	it("picks up a record that appears, and one that is rewritten", async () => {
		const storage = await makeStorage();
		const list = createBrokerRecordLister({ storageDir: storage, predecessorStorageDir: null });
		assert.deepEqual((await list()).records, []);
		const original = record("tab:a", { title: "one" });
		const target = await publish(storage, "pty-a.json", original);
		const first = await list();
		assert.equal(first.records.length, 1);
		assert.equal(first.records[0]?.record.title, "one");
		// A different size is a different file.
		await writeFile(target, JSON.stringify({ ...original, title: "a longer title" }), "utf8");
		const second = await list();
		assert.equal(second.records[0]?.record.title, "a longer title");
		// The same size with a later modification time is a different file too.
		await writeFile(target, JSON.stringify({ ...original, title: "a LONGER title" }), "utf8");
		const later = new Date(Date.now() + 60_000);
		await utimes(target, later, later);
		const third = await list();
		assert.equal(third.records[0]?.record.title, "a LONGER title");
	});

	it("forgets a record whose file is deleted, and one that is replaced by another name", async () => {
		const storage = await makeStorage();
		const list = createBrokerRecordLister({ storageDir: storage, predecessorStorageDir: null });
		const keep = await publish(storage, "pty-keep.json", record("tab:keep"));
		const gone = await publish(storage, "pty-gone.json", record("tab:gone"));
		assert.equal((await list()).records.length, 2);
		await unlink(gone);
		assert.deepEqual((await list()).records.map(entry => entry.record.slot), ["tab:keep"]);
		await rename(keep, path.join(path.dirname(keep), "pty-renamed.json"));
		assert.deepEqual((await list()).records.map(entry => entry.record.slot), ["tab:keep"]);
		// A file that returns under an old name is read again, not served from memory.
		await publish(storage, "pty-gone.json", record("tab:back"));
		assert.deepEqual((await list()).records.map(entry => entry.record.slot).sort(), ["tab:back", "tab:keep"]);
	});

	it("stops counting an unreadable file once it is deleted, and lists it once it is fixed", async () => {
		const storage = await makeStorage();
		const list = createBrokerRecordLister({ storageDir: storage, predecessorStorageDir: null });
		const broken = await publish(storage, "pty-broken.json", "{");
		assert.deepEqual(await list(), { records: [], unreadable: 1 });
		assert.equal((await list()).unreadable, 1);
		await writeFile(broken, JSON.stringify(record("tab:fixed")), "utf8");
		const fixed = await list();
		assert.equal(fixed.unreadable, 0);
		assert.deepEqual(fixed.records.map(entry => entry.record.slot), ["tab:fixed"]);
		await unlink(broken);
		assert.deepEqual(await list(), { records: [], unreadable: 0 });
	});

	it("keeps the two sources apart when both name the same file name", async () => {
		const storage = await makeStorage();
		const predecessor = await makeStorage();
		await publish(storage, "pty-same.json", record("tab:new"));
		await publish(predecessor, "pty-same.json", record("tab:old"));
		const list = createBrokerRecordLister({ storageDir: storage, predecessorStorageDir: predecessor });
		for (let round = 0; round < 2; round++) {
			const listing = await list();
			const bySlot = new Map(listing.records.map(entry => [entry.record.slot, entry.source] as const));
			assert.equal(bySlot.get("tab:new"), "current");
			assert.equal(bySlot.get("tab:old"), "predecessor");
		}
	});
});
