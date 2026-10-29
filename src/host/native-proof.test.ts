/**
 * The recorded verification of the staged native module (ADR-0076, decision 11): the verifier's staging records a proof, a
 * warm start accepts exactly the state it recorded and nothing else, and every change the proof must notice makes it read as
 * "no proof". Runs the real staging and the real module against a throwaway store under the user's profile. Runner:
 * `node --test src/host/native-proof.test.ts`.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, before, describe, it } from "node:test";

import {
	NATIVE_PROOF_MAX_AGE_MS,
	nativeProofPath,
	parseNativeProof,
	proofChain,
	recordNativeProof,
	stagedNativePath,
	warmNativeAsset,
} from "./native-proof.ts";
import type { NativeProofRecord } from "./native-proof.ts";
import { stageNativeModule } from "../runtime/native-stage.ts";
import { stageRuntimeAssets } from "./runtime-assets.ts";
import { chainSecurityProblem } from "./private-storage.ts";
import type { PrivateStorageSecurityRead, PrivateStorageSecurityReport } from "./private-storage.ts";
import { loadWin32Native, loadWin32NativeSync, setWin32NativeForTest } from "./win32-native.ts";
import type { Win32Native } from "./win32-native.ts";
import { installedAddonAsset } from "./win32-test-support.ts";

const windowsOnly = { skip: process.platform !== "win32" ? "the proof reads Windows file identity and staging rules" : false };

const stores: string[] = [];
afterEach(async () => {
	for (const store of stores.splice(0)) await rm(store, { recursive: true, force: true });
});

async function newStore(): Promise<string> {
	const store = await mkdtemp(path.join(process.env.LOCALAPPDATA ?? os.tmpdir(), "omp-native-proof-"));
	stores.push(store);
	return store;
}

/** A store with the real packaged module staged and a proof recorded by the real staging. */
async function stagedStore(): Promise<{ readonly storageDir: string; readonly packagedPath: string; readonly stagedPath: string; readonly sha256: string }> {
	const storageDir = await newStore();
	const asset = await installedAddonAsset();
	const verdict = await stageNativeModule(asset.path, storageDir);
	assert.equal(verdict.kind, "staged", verdict.kind === "refused" ? verdict.reason : "");
	if (verdict.kind !== "staged") throw new Error("not staged");
	assert.equal(verdict.proof, "recorded", "the staging recorded its verification");
	return { storageDir, packagedPath: asset.path, stagedPath: verdict.path, sha256: verdict.sha256 };
}

describe("parsing a record", () => {
	const entry = { path: "C:\\a", kind: "directory", dev: "9", ino: "1", size: "0", mtimeNs: "2", ctimeNs: "3" };
	const carrier = { path: "C:\\a", kind: "directory", dev: "9", ino: "1" };
	const account = { sid: "S-1-5-21-1-2-3-1001", username: "me", home: "C:\\Users\\me" };
	const good = { version: 2, sha256: "a".repeat(64), stagedPath: "C:\\a\\b", verifiedAtMs: 1, account, entries: [carrier, entry] };

	it("reads exactly a version-2 record", () => {
		assert.deepEqual(parseNativeProof(JSON.stringify(good)), good);
	});

	it("refuses anything else", () => {
		const bad: unknown[] = [
			null, 5, "x", [],
			{ ...good, version: 1 },
			{ ...good, account: undefined },
			{ ...good, account: { ...account, sid: "not-a-sid" } },
			{ ...good, account: { ...account, username: "" } },
			{ ...good, entries: [{ ...carrier, dev: undefined }] },
			{ ...good, sha256: "A".repeat(64) },
			{ ...good, sha256: "a".repeat(63) },
			{ ...good, stagedPath: 7 },
			{ ...good, verifiedAtMs: "1" },
			{ ...good, verifiedAtMs: null },
			{ ...good, entries: [] },
			{ ...good, entries: [{ ...entry, kind: "link" }] },
			{ ...good, entries: [{ ...entry, ino: "-1" }] },
			{ ...good, entries: [{ ...entry, ctimeNs: 3 }] },
			{ ...good, entries: [{ ...entry, ctimeNs: undefined }] },
			{ ...good, entries: [{ ...carrier, ino: undefined }] },
		];
		for (const value of bad) assert.equal(parseNativeProof(JSON.stringify(value)), null, JSON.stringify(value));
		assert.equal(parseNativeProof("{not json"), null);
	});
});

describe("the path chain", () => {
	it("runs from the outermost ancestor below the volume root to the staged file, never names the volume root, and compares only the digest directory and the file by their times", () => {
		const staged = path.join("C:\\", "Users", "x", "AppData", "Roaming", "Code", "User", "globalStorage", "hmmvot.omp-desk", "runtime", "d".repeat(64), "koffi.node");
		const chain = proofChain(staged);
		assert.equal(chain[0]!.path, path.join("C:\\", "Users"));
		assert.deepEqual(chain.slice(-3).map(item => [path.basename(item.path), item.kind]), [["runtime", "directory"], ["d".repeat(64), "directory"], ["koffi.node", "file"]]);
		assert.ok(chain.every(item => item.path !== "C:\\"), "the volume root is the platform's anchor, not a link of the chain");
		assert.deepEqual(chain.filter(item => item.strict).map(item => path.basename(item.path)), ["d".repeat(64), "koffi.node"]);
	});
});

describe("a warm start", windowsOnly, () => {
	before(async () => {
		setWin32NativeForTest(await loadWin32Native(await installedAddonAsset()));
	});

	it("is proven by the record the staging wrote, for the staged copy of this very module", async () => {
		const { storageDir, packagedPath, stagedPath, sha256 } = await stagedStore();
		const warm = warmNativeAsset({ storageDir, packagedPath });
		assert.equal(warm.kind, "proven", warm.kind === "none" ? warm.reason : "");
		if (warm.kind !== "proven") return;
		assert.deepEqual(warm.asset, { path: stagedPath, sha256 });
		assert.ok(warm.ageMs >= 0 && warm.ageMs < 60_000);
		// A module loads in one synchronous step. The installed copy is the one this process already maps: loading the staged copy
		// here would hold it open, and a mapped file cannot be deleted with the throwaway store.
		const native = loadWin32NativeSync(await installedAddonAsset());
		assert.equal(native.processCreation(process.pid).kind, "found");
	});

	it("reads nothing it did not record: no record, a malformed one, one for another module or place", async () => {
		const { storageDir, packagedPath, sha256 } = await stagedStore();
		const record = nativeProofPath(storageDir, sha256);
		const text = await readFile(record, "utf8");
		const reasonOf = (): string => {
			const warm = warmNativeAsset({ storageDir, packagedPath });
			assert.equal(warm.kind, "none");
			return warm.kind === "none" ? warm.reason : "";
		};
		await writeFile(record, "{ nope");
		assert.match(reasonOf(), /malformed/);
		const parsed = JSON.parse(text) as NativeProofRecord;
		await writeFile(record, JSON.stringify({ ...parsed, stagedPath: path.join(storageDir, "elsewhere", "koffi.node") }));
		assert.match(reasonOf(), /another module or location/);
		await writeFile(record, JSON.stringify({ ...parsed, entries: parsed.entries.slice(1) }));
		assert.match(reasonOf(), /does not cover/);
		await rm(record);
		assert.match(reasonOf(), /no record/);
	});

	it("expires after a day and is never from the future", async () => {
		const { storageDir, packagedPath } = await stagedStore();
		const at = Date.now();
		assert.equal(warmNativeAsset({ storageDir, packagedPath, now: () => at + NATIVE_PROOF_MAX_AGE_MS - 60_000 }).kind, "proven");
		const old = warmNativeAsset({ storageDir, packagedPath, now: () => at + NATIVE_PROOF_MAX_AGE_MS + 60_000 });
		assert.equal(old.kind, "none");
		assert.match(old.kind === "none" ? old.reason : "", /more than a day/);
		const future = warmNativeAsset({ storageDir, packagedPath, now: () => at - 3_600_000 });
		assert.match(future.kind === "none" ? future.reason : "", /future/);
	});

	it("notices a change of the file or of its directory", async () => {
		const { storageDir, packagedPath, stagedPath } = await stagedStore();
		const chain = proofChain(stagedPath);
		const owned = chain.slice(-2).map(item => item.path);

		// A touched file (its times move; its bytes do not).
		const later = new Date(Date.now() + 5_000);
		await utimes(stagedPath, later, later);
		let warm = warmNativeAsset({ storageDir, packagedPath });
		assert.equal(warm.kind, "none");
		assert.match(warm.kind === "none" ? warm.reason : "", /changed since it was verified/);

		// Re-verified by the real staging, the proof holds again.
		const asset = await installedAddonAsset();
		assert.equal((await stageNativeModule(asset.path, storageDir)).kind, "staged");
		assert.equal(warmNativeAsset({ storageDir, packagedPath }).kind, "proven");

		// An entry added to the digest directory (a change of its times).
		for (const directory of [owned[0]!]) {
			await writeFile(path.join(directory, "stray.txt"), "x");
			warm = warmNativeAsset({ storageDir, packagedPath });
			assert.equal(warm.kind, "none", `an entry added to ${path.basename(directory)} went unnoticed`);
			await rm(path.join(directory, "stray.txt"));
			assert.equal((await stageNativeModule(asset.path, storageDir)).kind, "staged");
			const again = warmNativeAsset({ storageDir, packagedPath });
			assert.equal(again.kind, "proven", `the staging recorded the new state (${path.basename(directory)}: ${again.kind === "none" ? again.reason : ""})`);
		}
	});

	it("does not mind entries added to the runtime directory (Desk stages other assets there) or to the directories above the store", async () => {
		const { storageDir, packagedPath } = await stagedStore();
		for (const directory of [path.join(storageDir, "runtime"), storageDir, path.dirname(storageDir)]) {
			const stray = path.join(directory, "stray.txt");
			await writeFile(stray, "x");
			await utimes(directory, new Date(Date.now() + 7_000), new Date(Date.now() + 7_000));
			assert.equal(warmNativeAsset({ storageDir, packagedPath }).kind, "proven", `an entry in ${path.basename(directory)} must not cost the warm start`);
			await rm(stray);
		}
	});

	it("refuses an ancestor that was replaced by another directory, even with the same tree below it", async () => {
		const { storageDir, packagedPath } = await stagedStore();
		const moved = `${storageDir}.moved`;
		stores.push(moved);
		await rename(storageDir, moved);
		await mkdir(storageDir);
		// Everything the record and the chain hold moves with it: only the directory they hang from is another one.
		for (const name of ["runtime", "native-proof"]) await rename(path.join(moved, name), path.join(storageDir, name));
		const warm = warmNativeAsset({ storageDir, packagedPath });
		assert.equal(warm.kind, "none");
		assert.match(warm.kind === "none" ? warm.reason : "", /changed since it was verified/);
	});

	it("is not proven for another account's record, another volume, or a record that is not a plain file", async () => {
		const { storageDir, packagedPath, sha256 } = await stagedStore();
		const record = nativeProofPath(storageDir, sha256);
		const parsed = JSON.parse(await readFile(record, "utf8")) as NativeProofRecord;
		const reason = (): string => {
			const warm = warmNativeAsset({ storageDir, packagedPath });
			assert.equal(warm.kind, "none");
			return warm.kind === "none" ? warm.reason : "";
		};
		await writeFile(record, JSON.stringify({ ...parsed, account: { ...parsed.account, username: `${parsed.account.username}-other` } }));
		assert.match(reason(), /another account/);
		await writeFile(record, JSON.stringify({ ...parsed, entries: parsed.entries.map(entry => ({ ...entry, dev: "1" })) }));
		assert.match(reason(), /changed since it was verified/);
		await rm(record);
		await mkdir(record);
		assert.match(reason(), /not a file/);
		await rm(record, { recursive: true });
		await writeFile(record, JSON.stringify(parsed));
		assert.equal(warmNativeAsset({ storageDir, packagedPath }).kind, "proven");
	});

	it("hands the loader a check that passes for the layout the child verified, and refuses another account's token", async () => {
		const { storageDir, packagedPath, sha256 } = await stagedStore();
		const warm = warmNativeAsset({ storageDir, packagedPath });
		assert.equal(warm.kind, "proven");
		if (warm.kind !== "proven") return;
		const native = (await loadWin32Native(await installedAddonAsset()));
		assert.equal(warm.verify(native), null);
		// A record written for another SID: the token that reads the chain is not the account that verified it.
		const record = nativeProofPath(storageDir, sha256);
		const parsed = JSON.parse(await readFile(record, "utf8")) as NativeProofRecord;
		await writeFile(record, JSON.stringify({ ...parsed, account: { ...parsed.account, sid: "S-1-5-21-1-2-3-4" } }));
		const other = warmNativeAsset({ storageDir, packagedPath });
		assert.equal(other.kind, "proven");
		if (other.kind !== "proven") return;
		assert.match(other.verify(native) ?? "", /another account/);
	});

	it("refuses a layout whose access an owner or access list change has loosened since the child verified it", async () => {
		const { storageDir, packagedPath } = await stagedStore();
		const stagedPath = stagedNativePath(storageDir, packagedPath, createHash("sha256").update(await readFile(packagedPath)).digest("hex"));
		const warm = warmNativeAsset({ storageDir, packagedPath });
		if (warm.kind !== "proven") throw new Error("not proven");
		const real = await loadWin32Native(await installedAddonAsset());
		// The same module, but the security read reports Everyone with write access on a directory above the store.
		const loosened: Win32Native = {
			...real,
			readSecuritySync: paths => {
				const read = real.readSecuritySync(paths);
				const carrier = proofChain(stagedPath)[0]!.path.toLowerCase();
				const report = read.reports.get(carrier);
				const entries = [...(report?.entries ?? []), { principal: "S-1-1-0", permissions: 0x1f01ff, denied: false, inherited: false }];
				return { ...read, reports: new Map([...read.reports, [carrier, { entries, owner: report?.owner ?? null }]]) };
			},
		};
		assert.equal(warm.verify(real), null, "the unmodified read is accepted");
		assert.match(warm.verify(loosened) ?? "", /on the path to the store lets .* replace or re-permission it/);
	});

	it("records no proof for a volume that is not a local fixed NTFS volume, and none that spans two volumes", async () => {
		const storageDir = await newStore();
		const asset = await installedAddonAsset();
		const real = await loadWin32Native(asset);
		const [copy] = await stageRuntimeAssets({ storageDir, sourcePaths: [asset.path] });
		const staged = copy!.path;
		const remote: Win32Native = { ...real, volumeOf: () => ({ driveType: 4, fileSystem: "NTFS" }) };
		await assert.rejects(recordNativeProof({ storageDir, packagedSha256: asset.sha256, stagedPath: staged, native: remote }), /not a local fixed NTFS volume \(drive type 4, file system NTFS\)/);
		const fat: Win32Native = { ...real, volumeOf: () => ({ driveType: 3, fileSystem: "FAT32" }) };
		await assert.rejects(recordNativeProof({ storageDir, packagedSha256: asset.sha256, stagedPath: staged, native: fat }), /file system FAT32/);
		const unknown: Win32Native = { ...real, volumeOf: () => ({ driveType: 3, fileSystem: null }) };
		await assert.rejects(recordNativeProof({ storageDir, packagedSha256: asset.sha256, stagedPath: staged, native: unknown }), /file system unknown/);
	});

	it("refuses a path that was replaced by a link, even one that leads to the very same tree", async () => {
		const { storageDir, packagedPath, stagedPath } = await stagedStore();
		const digestDirectory = path.dirname(stagedPath);
		const moved = `${digestDirectory}.moved`;
		await rename(digestDirectory, moved);
		await symlink(moved, digestDirectory, "junction");
		const warm = warmNativeAsset({ storageDir, packagedPath });
		assert.equal(warm.kind, "none");
		assert.match(warm.kind === "none" ? warm.reason : "", /is a link|changed since/);
		await rm(digestDirectory, { force: true });
		await rename(moved, digestDirectory);
	});

	it("is not proven for a module whose record is another build's, and a store with no staging has none", async () => {
		const storageDir = await newStore();
		const { packagedPath } = await stagedStore();
		const warm = warmNativeAsset({ storageDir, packagedPath });
		assert.equal(warm.kind, "none");
		const unreadable = warmNativeAsset({ storageDir, packagedPath: path.join(storageDir, "absent", "koffi.node") });
		assert.match(unreadable.kind === "none" ? unreadable.reason : "", /packaged module cannot be read/);
	});

	it("keeps the staged bytes under the digest check: a substituted file with a matching record state still fails to load", async () => {
		const { storageDir, packagedPath, stagedPath, sha256 } = await stagedStore();
		const original = await readFile(stagedPath);
		// Rewrite the bytes and put the file's identity back as the record has it is impossible without the owner's rights;
		// here the record is simply regenerated over the substituted file to prove the digest, not the proof, stops the load.
		await mkdir(path.dirname(stagedPath), { recursive: true });
		await writeFile(stagedPath, Buffer.concat([original, Buffer.from("tampered")]));
		const warm = warmNativeAsset({ storageDir, packagedPath });
		assert.equal(warm.kind, "none", "a rewritten file changes its size and times");
		assert.throws(() => loadWin32NativeSync({ path: stagedPath, sha256 }), /does not match its digest/);
	});
});

describe("the chain's security judgement", () => {
	const ME = "S-1-5-21-1-2-3-1001";
	const OTHER = "S-1-5-21-1-2-3-1002";
	const SYSTEM = "S-1-5-18";
	const owned = ["C:\\u\\g\\runtime", "C:\\u\\g\\runtime\\d"];
	const carriers = ["C:\\u", "C:\\u\\g"];
	const entry = (principal: string, permissions = 0x1f01ff, denied = false) => ({ principal, permissions, denied });
	/** A read in which every path is owned by `ME` and lists only the given principals. */
	function read(options: { readonly acl?: Record<string, ReturnType<typeof entry>[]>; readonly owner?: Record<string, string | null>; readonly failure?: string | null; readonly sid?: string | null } = {}): PrivateStorageSecurityRead {
		const reports = new Map<string, PrivateStorageSecurityReport>();
		for (const target of [...owned, ...carriers]) {
			const entries = options.acl?.[target] ?? [entry(ME), entry(SYSTEM)];
			reports.set(target.toLowerCase(), { acl: { ok: true, stdout: JSON.stringify(entries), detail: null }, owner: options.owner?.[target] === undefined ? ME : options.owner[target]! });
		}
		return { sid: options.sid === undefined ? ME : options.sid, failure: options.failure ?? null, reports };
	}
	const judge = (r: PrivateStorageSecurityRead) => chainSecurityProblem(r, { owned, carriers });

	it("accepts the layout the verifier accepts", () => {
		assert.equal(judge(read()), null);
	});

	it("refuses an owned path another account can use, a carrier another account can replace, and an owner outside the trusted set", () => {
		assert.match(judge(read({ acl: { [owned[1]!]: [entry(ME), entry(OTHER, 0x120089)] } })) ?? "", /readable by S-1-5-21-1-2-3-1002/);
		assert.match(judge(read({ acl: { [carriers[1]!]: [entry(ME), entry(OTHER, 0x10000)] } })) ?? "", /lets S-1-5-21-1-2-3-1002 replace or re-permission it/);
		assert.equal(judge(read({ acl: { [carriers[1]!]: [entry(ME), entry(OTHER, 0x120089)] } })), null, "a carrier another account may only read and traverse is fine");
		assert.equal(judge(read({ acl: { [carriers[1]!]: [entry(ME), entry(OTHER, 0x10000, true)] } })), null, "a denial is not a grant");
		assert.match(judge(read({ owner: { [carriers[0]!]: OTHER } })) ?? "", /owned by S-1-5-21-1-2-3-1002/);
		assert.match(judge(read({ owner: { [owned[0]!]: null } })) ?? "", /owner of .* could not be read/);
	});

	it("refuses what it could not read", () => {
		assert.match(judge(read({ failure: "the security read did not finish in 20000 ms" })) ?? "", /did not finish/);
		assert.match(judge(read({ sid: null })) ?? "", /SID could not be read/);
		const missing = read();
		(missing.reports as Map<string, PrivateStorageSecurityReport>).delete(carriers[0]!.toLowerCase());
		assert.match(judge(missing) ?? "", /could not be verified/);
	});
});
