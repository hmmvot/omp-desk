/**
 * Tests for the durable broker records.
 *
 * Runner: `node --test src/host/pty-registry.test.ts`
 *
 * A record is the only thing that survives a window, so what matters is that a slot
 * can be occupied exactly once, that a record this build cannot read is never treated
 * as absent (an older broker's record is not a free slot — it is a live writer this
 * build cannot drive), that a retire only removes the bytes it was asked about, and
 * that reading a slot is a directory lookup rather than a path a caller can steer.
 *
 * The access check runs through the shared private storage convention, so the probe
 * seam is injected here exactly as the rest of the suite does it: the tests describe
 * an owner-only directory without depending on this machine's ACLs.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import type { PrivateStorageCommandResult, PrivateStorageProbe } from "./private-storage.ts";
import { TEST_CURRENT_SID, fixtureAcl, fixturePrincipal } from "./private-storage-test-support.ts";
import {
	acquirePtySlotLock,
	claimPtyRecord,
	ensurePtyStateAccess,
	listPtyRecords,
	ptyRecordPath,
	ptySlotLockPath,
	ptyStateDirectory,
	readPtyRecord,
	releasePtySlotLock,
	retirePtyRecord,
} from "./pty-registry.ts";
import {
	PTY_PROTOCOL_VERSION,
	PTY_RECORD_VERSION,
	PTY_SERVICE,
	createPtyToken,
	type PtyBrokerRecord,
} from "./pty-protocol.ts";

const ACCOUNT = "WORKSTATION\\dev";
const OWNER_ONLY = [ACCOUNT, "NT AUTHORITY\\SYSTEM", "BUILTIN\\Administrators"];

const roots: string[] = [];

after(async () => {
	for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function makeStorage(): Promise<string> {
	const root = await mkdtemp(path.join(tmpdir(), "omp-pty-registry-"));
	roots.push(root);
	return root;
}

function aclListing(target: string, principals: readonly string[]): string {
	return fixtureAcl(principals.map(principal => `${principal}:(OI)(CI)(F)`));
}

/** An access seam that describes an owner-only directory on any host. */
function ownerOnlyProbe(): PrivateStorageProbe {
	return {
		platform: "win32",
		currentSid: TEST_CURRENT_SID,
		readAcl: async (target: string): Promise<PrivateStorageCommandResult> => ({
			ok: true,
			stdout: aclListing(target, OWNER_ONLY),
			detail: null,
		}),
		applyIcacls: async (): Promise<PrivateStorageCommandResult> => ({ ok: true, stdout: "", detail: null }),
		readOwners: async (paths: readonly string[]): Promise<PrivateStorageCommandResult> => ({
			ok: true,
			stdout: paths.map(target => `${target}|${fixturePrincipal(ACCOUNT)}`).join("\r\n"),
			detail: null,
		}),
	};
}

function record(slot: string, brokerId = "pty-11111111-2222-3333-4444-555555555555"): PtyBrokerRecord {
	return {
		version: PTY_RECORD_VERSION,
		service: PTY_SERVICE,
		protocolVersion: PTY_PROTOCOL_VERSION,
		runtimeVersion: 1,
		treeDigest: "a".repeat(64),
		brokerId,
		generation: "gen-11111111-2222-3333-4444-555555555555",
		slot,
		kind: "managed-omp",
		port: 51234,
		token: createPtyToken(),
		brokerPid: 4242,
		brokerCreationTime: "134349421014308869",
		startedAt: new Date(0).toISOString(),
		cols: 100,
		rows: 30,
		title: null,
	};
}

describe("broker records", () => {
	it("occupies a slot exactly once, atomically", async () => {
		const storage = await makeStorage();
		const first = await claimPtyRecord(storage, record("tab:1"));
		assert.equal(first.claimed, true);
		const second = await claimPtyRecord(storage, record("tab:1", "pty-99999999-2222-3333-4444-555555555555"));
		assert.equal(second.claimed, false);
		// The occupant is untouched: the loser never writes over it.
		const lookup = await readPtyRecord(storage, "tab:1");
		assert.equal(lookup.kind, "ok");
		assert.equal(lookup.kind === "ok" ? lookup.record.brokerId : "", "pty-11111111-2222-3333-4444-555555555555");
		// No temporary file is left behind by either attempt.
		const names = await readdir(ptyStateDirectory(storage));
		assert.deepEqual(names.filter(name => name.endsWith(".tmp")), []);
	});

	it("keeps slots apart even when their keys differ only in punctuation", async () => {
		const storage = await makeStorage();
		assert.notEqual(ptyRecordPath(storage, "tab:a/b"), ptyRecordPath(storage, "tab:a_b"));
		assert.equal(ptyRecordPath(storage, "tab:a/b"), ptyRecordPath(storage, "tab:a/b"));
		const first = await claimPtyRecord(storage, record("tab:a/b"));
		const second = await claimPtyRecord(storage, record("tab:a_b", "pty-99999999-2222-3333-4444-555555555555"));
		assert.equal(first.claimed, true);
		assert.equal(second.claimed, true);
		const listed = await listPtyRecords(storage);
		assert.equal(listed.records.length, 2);
		assert.deepEqual(listed.records.map(entry => entry.slot).sort(), ["tab:a/b", "tab:a_b"]);
	});

	it("reports a record it cannot read as invalid rather than absent", async () => {
		const storage = await makeStorage();
		await claimPtyRecord(storage, record("tab:1"));
		await writeFile(ptyRecordPath(storage, "tab:1"), "{ this is not json", "utf8");
		assert.equal((await readPtyRecord(storage, "tab:1")).kind, "invalid");
		const listed = await listPtyRecords(storage);
		assert.equal(listed.records.length, 0);
		assert.equal(listed.invalid.length, 1);
		// A slot whose file was never written is absent, and says so.
		assert.equal((await readPtyRecord(storage, "tab:2")).kind, "none");
		assert.equal((await listPtyRecords(path.join(storage, "elsewhere"))).missing, true);
	});

	it("retires only the bytes it was asked about", async () => {
		const storage = await makeStorage();
		await claimPtyRecord(storage, record("tab:1"));
		const wrong = await retirePtyRecord(storage, "tab:1", "pty-99999999-2222-3333-4444-555555555555");
		assert.equal(wrong.retired, false);
		// A record naming another broker is left where it is.
		assert.match(wrong.detail, /different broker/);
		assert.equal((await readPtyRecord(storage, "tab:1")).kind, "ok");

		const right = await retirePtyRecord(storage, "tab:1", "pty-11111111-2222-3333-4444-555555555555");
		assert.equal(right.retired, true);
		assert.equal((await readPtyRecord(storage, "tab:1")).kind, "none");
		// Retiring what is already gone is the same outcome, not a failure.
		assert.equal((await retirePtyRecord(storage, "tab:1", "pty-11111111-2222-3333-4444-555555555555")).retired, true);
	});

	it("refuses a claim while a launcher holds the slot lock, and retires under it", async () => {
		const storage = await makeStorage();
		await claimPtyRecord(storage, record("tab:1"));
		const held = await acquirePtySlotLock(storage, "tab:1", { holderId: "launcher-a" });
		assert.equal(held.acquired, true);
		// Another window waits, then refuses: it neither steals the lock nor publishes.
		const refused = await acquirePtySlotLock(storage, "tab:1", { holderId: "launcher-b", waitMs: 200 });
		assert.equal(refused.acquired, false);
		assert.match(refused.detail, /another window holds the slot lock/);
		// The launcher retires the dead broker's record while holding the lock...
		const retired = await retirePtyRecord(storage, "tab:1", "pty-11111111-2222-3333-4444-555555555555", {
			holderId: "launcher-a",
		});
		assert.equal(retired.retired, true);
		// ...and in that state nobody else may publish into the slot: this is the moment
		// in which a third window could otherwise start a second writer.
		const blocked = await claimPtyRecord(storage, record("tab:1", "pty-22222222-2222-3333-4444-555555555555"));
		assert.equal(blocked.claimed, false);
		assert.match(blocked.detail, /another window is claiming this slot/);
		// The launcher's own broker is allowed past its launcher's lock.
		const own = await claimPtyRecord(storage, record("tab:1", "pty-33333333-2222-3333-4444-555555555555"), {
			launchId: "launcher-a",
		});
		assert.equal(own.claimed, true);
		await releasePtySlotLock(storage, "tab:1", "launcher-a");
		const lookup = await readPtyRecord(storage, "tab:1");
		assert.equal(lookup.kind === "ok" ? lookup.record.brokerId : "", "pty-33333333-2222-3333-4444-555555555555");
		// A lock whose holder process is gone is taken over.
		await writeFile(ptySlotLockPath(storage, "tab:1"), `${JSON.stringify({ holderId: "gone", pid: 2147483000, creationTime: null })}\n`, "utf8");
		const takeover = await acquirePtySlotLock(storage, "tab:1", { holderId: "launcher-c", waitMs: 500 });
		assert.equal(takeover.acquired, true);
		await releasePtySlotLock(storage, "tab:1", "launcher-c");
	});

	it("refuses to publish a record where its directory is not provably owner-only", async () => {
		const storage = await makeStorage();
		const permissive: PrivateStorageProbe = {
			...ownerOnlyProbe(),
			readAcl: async (target: string): Promise<PrivateStorageCommandResult> => ({
				ok: true,
				stdout: aclListing(target, ["Everyone"]),
				detail: null,
			}),
		};
		const access = await ensurePtyStateAccess(storage, permissive);
		assert.equal(access.ok, false);
		assert.match(access.reason ?? "", /Everyone/);
	});

	it("verifies the directory it actually owns, and says it is fine when it is", async () => {
		const storage = await makeStorage();
		const access = await ensurePtyStateAccess(storage, ownerOnlyProbe());
		assert.equal(access.ok, true);
		await claimPtyRecord(storage, record("tab:1"));
		const again = await ensurePtyStateAccess(storage, ownerOnlyProbe());
		assert.equal(again.ok, true);
		// The published bytes are the record itself, naming its slot.
		const text = await readFile(ptyRecordPath(storage, "tab:1"), "utf8");
		assert.match(text, /"type"|"slot"/);
	});
});
