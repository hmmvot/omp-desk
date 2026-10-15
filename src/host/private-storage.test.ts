import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { after, before, it } from "node:test";
import { synchronousLocalPaths, isPermittedAclPrincipal, namedPrincipal, parseWindowsAcl, permissionsPermitReplacement, readStorageSecurity, readVerifiedStorageSecurity, restrictPrivateStorage, verifyPrivateStorage, type PrivateStorageLayout, type PrivateStorageProbe, type PrivateStorageSecurityReport } from "./private-storage.ts";
import { formatToolSpawn, reportToolSpawn, setToolSpawnObserver, type ToolSpawn } from "./tool-spawn-trace.ts";
import { TEST_CURRENT_SID, fixtureAcl, fixturePrincipal } from "./private-storage-test-support.ts";
import { loadWin32Native, setWin32NativeForTest, type Win32Native, type Win32SecurityRead } from "./win32-native.ts";
import { installedAddonAsset } from "./win32-test-support.ts";

// Captured with Windows .NET Encoding.GetEncoding(866), not UTF-8 literals masquerading as OEM bytes.
const RUSSIAN_PRINCIPALS = [
	["BUILTIN\\Администраторы", "4255494c54494e5c80a4aca8ada8e1e2e0a0e2aee0eb"],
	["NT AUTHORITY\\СИСТЕМА", "4e5420415554484f524954595c91889192858c80"],
	["NT SERVICE\\TrustedInstaller", "4e5420534552564943455c54727573746564496e7374616c6c6572"],
	["СОЗДАТЕЛЬ-ВЛАДЕЛЕЦ", "918e87848092858b9c2d828b8084858b8596"],
	["КОМПЬЮТЕР\\Иван", "8a8e8c8f9c9e9285905c88a2a0ad"],
] as const;
const RUSSIAN_FOREIGN = [
	["BUILTIN\\Пользователи", "4255494c54494e5c8faeabeca7aea2a0e2a5aba8"],
	["Все", "82e1a5"],
] as const;

it("admits Russian CP866 fixture identities by SID, and preserves UTF-8 diagnostic names", () => {
	const decoder = new TextDecoder("ibm866");
	for (const [name, hex] of RUSSIAN_PRINCIPALS) {
		const bytes = Buffer.from(hex, "hex");
		assert.equal(decoder.decode(bytes), name);
		const principal = fixturePrincipal(name);
		const readback = Buffer.from(fixtureAcl([`${name}:(OI)(CI)(F)`]), "utf8").toString("utf8");
		const acl = parseWindowsAcl(readback);
		assert.equal(acl.parsed, true);
		assert.equal(acl.principals[0], principal);
		assert.equal(isPermittedAclPrincipal(principal, TEST_CURRENT_SID), true, name);
	}
	assert.equal(Buffer.from(RUSSIAN_PRINCIPALS[0][1], "hex").toString("utf8").split("\ufffd").length - 1, 12);
});

it("refuses localized Users and Everyone, foreign SIDs and names without a SID", () => {
	const decoder = new TextDecoder("ibm866");
	for (const [name, hex] of RUSSIAN_FOREIGN) {
		assert.equal(decoder.decode(Buffer.from(hex, "hex")), name);
		assert.equal(isPermittedAclPrincipal(fixturePrincipal(name), TEST_CURRENT_SID), false, name);
	}
	for (const principal of ["S-1-5-11 (NT AUTHORITY\\Authenticated Users)", "S-1-5-21-100-200-300-9999", "BUILTIN\\Администраторы", "NT AUTHORITY\\SYSTEM", "?", ""]) {
		assert.equal(isPermittedAclPrincipal(principal, TEST_CURRENT_SID), false, principal);
	}
	// A display-name collision cannot impersonate an allowed SID.
	assert.equal(isPermittedAclPrincipal("S-1-1-0 (BUILTIN\\Администраторы)", TEST_CURRENT_SID), false);
	assert.equal(isPermittedAclPrincipal("S-1-5-18 (arbitrary localized display name)", TEST_CURRENT_SID), true);
	for (const sid of ["S-1-3-0", "S-1-3-4", "S-1-5-10", TEST_CURRENT_SID]) {
		assert.equal(isPermittedAclPrincipal(sid, TEST_CURRENT_SID), true);
	}
});

it("fails closed on malformed SID ACL JSON and access masks", () => {
	for (const value of ["", "{}", "[]", '[{"principal":"S-1-5-18","permissions":"F","denied":false}]', '[{"principal":"S-1-5-18","permissions":4294967296,"denied":false}]', '[{"principal":"?","permissions":1,"denied":false}]', '[{"principal":"S-1-5-18","permissions":1}]']) {
		assert.equal(parseWindowsAcl(value).parsed, false, value);
	}
});

it("accepts signed generic read/execute masks but refuses replacement and unknown bits", () => {
	const genericReadExecute = (0x80000000 | 0x20000000) | 0;
	const report = parseWindowsAcl(JSON.stringify([{ principal: "S-1-5-32-545", permissions: genericReadExecute, denied: false }]));
	assert.equal(report.parsed, true);
	assert.equal(permissionsPermitReplacement(genericReadExecute), false);
	for (const mask of [genericReadExecute | 0x40, 0x10000, 0x40000, 0x80000, 0x10000000, 0x02000000, 0x200]) {
		assert.equal(permissionsPermitReplacement(mask), true, String(mask));
	}
});

it("verifies localized owners and rejects localized foreign owners even with permitted placeholders", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-localized-acl-"));
	try {
		const layout: PrivateStorageLayout = { root, directories: [root], verifiedDirectories: [root], probeDirectory: root, probeText: "localized-proof" };
		const allowed = RUSSIAN_PRINCIPALS.map(([name]) => `${name}:(OI)(CI)(F)`);
		const probe: PrivateStorageProbe = {
			platform: "win32", currentSid: TEST_CURRENT_SID,
			readAcl: async () => ({ ok: true, stdout: fixtureAcl(allowed), detail: null }),
			readOwners: async targets => ({ ok: true, stdout: targets.map(target => `${target}|${fixturePrincipal("КОМПЬЮТЕР\\Иван")}`).join("\r\n"), detail: null }),
		};
		const ready = await verifyPrivateStorage({ layout, probe });
		assert.equal(ready.ready, true, ready.reason ?? "localized store refused");
		for (const [name] of RUSSIAN_FOREIGN) {
			const refused = await verifyPrivateStorage({ layout, probe: { ...probe, readAcl: async () => ({ ok: true, stdout: fixtureAcl([...allowed, `${name}:(RX)`]), detail: null }) } });
			assert.equal(refused.ready, false);
			assert.match(refused.reason ?? "", /readable by S-1-/);
			assert.ok(refused.reason?.includes(name));
		}
		const ownerRefused = await verifyPrivateStorage({ layout, probe: { ...probe, readOwners: async targets => ({ ok: true, stdout: targets.map(target => `${target}|S-1-5-21-100-200-300-9999 (КОМПЬЮТЕР\\Иван)`).join("\r\n"), detail: null }) } });
		assert.equal(ownerRefused.ready, false);
		assert.match(ownerRefused.reason ?? "", /owned by S-1-5-21-100-200-300-9999/);
		const unknownOwner = await verifyPrivateStorage({ layout, probe: { ...probe, readOwners: async targets => ({ ok: true, stdout: targets.map(target => `${target}|?`).join("\r\n"), detail: null }) } });
		assert.equal(unknownOwner.ready, false);
		assert.match(unknownOwner.reason ?? "", /owner .* could not be read/);
	} finally { await fs.rm(root, { recursive: true, force: true }); }
});

let realNative: Win32Native | null = null;
before(async () => {
	if (process.platform === "win32") {
		realNative = await loadWin32Native(await installedAddonAsset());
		setWin32NativeForTest(realNative);
	}
});
after(() => setWin32NativeForTest(undefined));

it("smokes real SID verification and rejects a real Users read grant, independent of CP866 console output", { skip: process.platform !== "win32" }, async t => {
	const base = await fs.mkdtemp(path.join(process.env.LOCALAPPDATA ?? os.homedir(), "omp-sid-smoke-"));
	const root = path.join(base, "Иван");
	const child = path.join(root, "child");
	const layout: PrivateStorageLayout = { root, directories: [root, child], verifiedDirectories: [root, child], probeDirectory: root, probeText: "real-sid-proof" };
	const run = promisify(execFile);
	const system32 = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32");
	try {
		// Broaden only this test's own carrier. Root and child inherit its Users ACE;
		// rewriting root must propagate clean rules without rewriting child.
		await run(path.join(system32, "icacls.exe"), [base, "/grant", "*S-1-5-32-545:(OI)(CI)(RX)", "/Q"], { windowsHide: true });
		const rewritten: string[] = [];
		const restriction = await restrictPrivateStorage({ layout, probe: {
			applyIcacls: async (target, args) => {
				rewritten.push(target);
				await run(path.join(system32, "icacls.exe"), [target, ...args], { windowsHide: true });
				return { ok: true, stdout: "", detail: null };
			},
		} });
		assert.equal(restriction.restricted, true, restriction.reason ?? "real restriction failed");
		assert.equal((await verifyPrivateStorage({ layout })).ready, true);
		assert.deepEqual(rewritten, [root], "a clean inheriting child was rewritten from stale ACL evidence");
		const single = await readStorageSecurity([root]);
		assert.equal(single.sid !== null, true, "the SID was not read");
		assert.equal(single.reports.get(root.toLowerCase())?.acl.ok, true);
		const multiple = await readStorageSecurity([root, child]);
		assert.equal(multiple.reports.size, 2);
		for (const target of [root, child]) {
			assert.equal(multiple.reports.get(target.toLowerCase())?.acl.ok, true);
			assert.match(multiple.reports.get(target.toLowerCase())?.owner ?? "", /^S-1-/);
		}
		const consoleRead = await run(path.join(system32, "cmd.exe"), ["/d", "/c", `chcp 866>nul & "${path.join(system32, "icacls.exe")}" "${root}"`], { windowsHide: true, windowsVerbatimArguments: true, encoding: "buffer" });
		t.diagnostic(`Forced CP866 icacls run: Cyrillic path bytes present=${consoleRead.stdout.includes(Buffer.from("88a2a0ad", "hex"))}; SID verification remains independent of this output`);
		await run(path.join(system32, "icacls.exe"), [root, "/grant", "*S-1-5-32-545:(OI)(CI)(RX)", "/Q"], { windowsHide: true });
		const refused = await verifyPrivateStorage({ layout });
		assert.equal(refused.ready, false, "a real Users read grant was admitted");
		assert.match(refused.reason ?? "", /readable by S-1-5-32-545 \(BUILTIN\\.+\)/);
	} finally { await fs.rm(base, { recursive: true, force: true }); }
});

// ---- One process per verification pass (ADR-0054, amended 2026-10-13) ----

const CLEAN_ENTRIES = ["NT AUTHORITY\\SYSTEM:(OI)(CI)(F)", "BUILTIN\\Administrators:(OI)(CI)(F)", "WORKSTATION\\dev:(OI)(CI)(F)"];

/** What the one process reports for a clean machine; each field can be bent per path. */
function fakeSecurity(bend: {
	readonly sid?: string | null;
	readonly entries?: (target: string) => readonly string[] | null;
	readonly owner?: (target: string) => string | null;
} = {}): { readonly read: NonNullable<PrivateStorageProbe["readSecurity"]>; readonly calls: string[][] } {
	const calls: string[][] = [];
	const read: NonNullable<PrivateStorageProbe["readSecurity"]> = async paths => {
		calls.push([...paths]);
		const reports = new Map<string, PrivateStorageSecurityReport>();
		for (const target of paths) {
			const entries = bend.entries === undefined ? CLEAN_ENTRIES : bend.entries(target);
			reports.set(target.toLowerCase(), {
				acl: entries === null
					? { ok: false, stdout: "", detail: "the SID-based security API failed" }
					: { ok: true, stdout: fixtureAcl(entries), detail: null },
				owner: bend.owner === undefined ? fixturePrincipal("WORKSTATION\\dev") : bend.owner(target),
			});
		}
		return { sid: bend.sid === undefined ? TEST_CURRENT_SID : bend.sid, failure: null, reports };
	};
	return { read, calls };
}

/** The read of a failed batch: no account and every path unreadable. */
function failedRead(paths: readonly string[], detail: string) {
	return {
		sid: null,
		failure: detail,
		reports: new Map<string, PrivateStorageSecurityReport>(paths.map(target => [target.toLowerCase(), { acl: { ok: false, stdout: "", detail }, owner: null }])),
	};
}

/** A native module that answers one fixed security read and a fixed set of account names. */
function fakeNative(read: Win32SecurityRead, names: ReadonlyMap<string, string> = new Map()): Win32Native & { readonly deadlines: number[] } {
	const deadlines: number[] = [];
	const unused = (): never => { throw new Error("not read by a security test"); };
	return {
		deadlines,
		mutexState: unused,
		processCreation: unused,
		processDescendants: unused,
		openPipeClient: unused,
		volumeOf: unused,
		readSecuritySync: unused,
		readSecurity: async (_paths, deadlineMs) => { deadlines.push(deadlineMs); return read; },
		lookupAccountNames: async sids => new Map([...names].filter(([sid]) => sids.includes(sid))),
	};
}

async function withStore<T>(run: (layout: PrivateStorageLayout, root: string) => Promise<T>): Promise<T> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-one-process-"));
	try {
		return await run({ root, directories: [root], verifiedDirectories: [root], probeDirectory: root, probeText: "one-process-proof" }, root);
	} finally { await fs.rm(root, { recursive: true, force: true }); }
}

it("verifies the SID, every access list and every owner from one reading, and replaces nothing else", async () => {
	await withStore(async layout => {
		const security = fakeSecurity();
		const ready = await verifyPrivateStorage({ layout, probe: { platform: "win32", readSecurity: security.read } });
		assert.equal(ready.ready, true, ready.reason ?? "refused");
		assert.equal(security.calls.length, 1, "one process serves SID, ACLs and owners");
		const [paths] = security.calls;
		assert.ok(paths?.includes(layout.root), "the store root is in the one reading");
		assert.ok((paths?.length ?? 0) > 1, "the carriers above the store are in the same reading");
		// A probe that names a read replaces only that read: the SID still comes from the one reading.
		const partly = fakeSecurity();
		const named = await verifyPrivateStorage({ layout, probe: { platform: "win32", readSecurity: partly.read, readOwners: async targets => ({ ok: true, stdout: targets.map(target => `${target}|${fixturePrincipal("WORKSTATION\\dev")}`).join("\n"), detail: null }) } });
		assert.equal(named.ready, true, named.reason ?? "refused");
		assert.equal(partly.calls.length, 1);
		// With every read named by the probe no process runs at all.
		const none = fakeSecurity();
		const all = await verifyPrivateStorage({ layout, probe: { platform: "win32", currentSid: TEST_CURRENT_SID, readSecurity: none.read, readAcl: async () => ({ ok: true, stdout: fixtureAcl(CLEAN_ENTRIES), detail: null }), readOwners: async targets => ({ ok: true, stdout: targets.map(target => `${target}|${fixturePrincipal("WORKSTATION\\dev")}`).join("\n"), detail: null }) } });
		assert.equal(all.ready, true, all.reason ?? "refused");
		assert.equal(none.calls.length, 0);
	});
});

it("still refuses a wrong owner, an unreadable owner and a path the process left out of its report", async () => {
	await withStore(async layout => {
		const foreign = fakeSecurity({ owner: () => "S-1-5-21-100-200-300-9999 (OTHER\\mallory)" });
		const wrongOwner = await verifyPrivateStorage({ layout, probe: { platform: "win32", readSecurity: foreign.read } });
		assert.equal(wrongOwner.ready, false);
		assert.match(wrongOwner.reason ?? "", /is owned by S-1-5-21-100-200-300-9999/);
		// An owner no one could read is never guessed.
		const unreadable = fakeSecurity({ owner: target => target === layout.root ? null : fixturePrincipal("WORKSTATION\\dev") });
		const refused = await verifyPrivateStorage({ layout, probe: { platform: "win32", readSecurity: unreadable.read } });
		assert.equal(refused.ready, false);
		assert.match(refused.reason ?? "", /owner of .* could not be read/);
		// A report the process left out for one path leaves that path's owner unread.
		const missing: NonNullable<PrivateStorageProbe["readSecurity"]> = async paths => {
			const full = await fakeSecurity().read(paths);
			const reports = new Map(full.reports);
			reports.delete(layout.root.toLowerCase());
			return { ...full, reports };
		};
		const gone = await verifyPrivateStorage({ layout, probe: { platform: "win32", readSecurity: missing } });
		assert.equal(gone.ready, false);
		assert.match(gone.reason ?? "", /could not be verified|owner of .* could not be read|no ACL/);
	});
});

it("still refuses an extra ACE on the store, a replace right on a carrier and an unreadable access list", async () => {
	await withStore(async layout => {
		const extra = fakeSecurity({ entries: target => target === layout.root ? [...CLEAN_ENTRIES, "BUILTIN\\Users:(OI)(CI)(RX)"] : CLEAN_ENTRIES });
		const readable = await verifyPrivateStorage({ layout, probe: { platform: "win32", readSecurity: extra.read } });
		assert.equal(readable.ready, false);
		assert.match(readable.reason ?? "", /readable by S-1-5-32-545/);

		const carrier = path.dirname(layout.root);
		const replaceable = fakeSecurity({ entries: target => target === carrier ? [...CLEAN_ENTRIES, "BUILTIN\\Users:(OI)(CI)(M)"] : CLEAN_ENTRIES });
		const lets = await verifyPrivateStorage({ layout, probe: { platform: "win32", readSecurity: replaceable.read } });
		assert.equal(lets.ready, false);
		assert.match(lets.reason ?? "", /lets S-1-5-32-545 .* replace or re-permission it/);

		const unreadableAcl = fakeSecurity({ entries: target => target === layout.root ? null : CLEAN_ENTRIES });
		const refused = await verifyPrivateStorage({ layout, probe: { platform: "win32", readSecurity: unreadableAcl.read } });
		assert.equal(refused.ready, false);
		assert.match(refused.reason ?? "", /could not be verified/);

		const emptyAcl = fakeSecurity({ entries: target => target === layout.root ? [] : CLEAN_ENTRIES });
		const empty = await verifyPrivateStorage({ layout, probe: { platform: "win32", readSecurity: emptyAcl.read } });
		assert.equal(empty.ready, false);
		assert.match(empty.reason ?? "", /could not be read/);
	});
});

it("refuses when the read fails, times out or answers something that is not an identity", async () => {
	await withStore(async layout => {
		const verifyWith = async (read: NonNullable<PrivateStorageProbe["readSecurity"]>, extra: Partial<PrivateStorageProbe> = {}) =>
			await verifyPrivateStorage({ layout, probe: { platform: "win32", ...extra, readSecurity: read } });
		const timedOut = async (paths: readonly string[]) => failedRead(paths, "the security read did not finish in 20000 ms");

		const refusedAtSid = await verifyWith(timedOut);
		assert.equal(refusedAtSid.ready, false);
		assert.match(refusedAtSid.reason ?? "", /SID could not be read/);
		// With the SID supplied the same failure reaches the access lists and then the owners.
		const withSid = await verifyWith(timedOut, { currentSid: TEST_CURRENT_SID });
		assert.equal(withSid.ready, false);
		assert.match(withSid.reason ?? "", /could not be verified \(the security read did not finish in 20000 ms\)/);
		const ownersOnly = await verifyWith(timedOut, {
			currentSid: TEST_CURRENT_SID,
			readAcl: async () => ({ ok: true, stdout: fixtureAcl(CLEAN_ENTRIES), detail: null }),
		});
		assert.equal(ownersOnly.ready, false);
		assert.match(ownersOnly.reason ?? "", /store owner could not be read \(the security read did not finish in 20000 ms\)/);

		for (const sid of [null, "not-a-sid"]) {
			const clean = fakeSecurity({ sid });
			assert.equal((await verifyWith(clean.read)).ready, false, `an answer of ${String(sid)} for the account was admitted`);
		}
		// A good read is admitted by the same path, so the refusals above are the read's doing.
		const admitted = await verifyWith(fakeSecurity().read);
		assert.equal(admitted.ready, true, admitted.reason ?? "refused");
	});
});

it("maps the native read per path, keeps each read independent and ignores nothing it was asked for", async () => {
	const entries = [{ principal: "S-1-5-18", permissions: 0x1f01ff, denied: false }];
	const native = fakeNative({
		sid: TEST_CURRENT_SID,
		failure: null,
		reports: new Map([
			["c:\\a", { entries, owner: "S-1-5-18" }],
			["c:\\b", { entries: null, owner: null }],
		]),
	});
	setWin32NativeForTest(native);
	try {
		const read = await readStorageSecurity(["C:\\a", "C:\\b"]);
		assert.equal(read.sid, TEST_CURRENT_SID);
		assert.equal(read.failure, null);
		assert.equal(read.reports.size, 2);
		assert.equal(read.reports.get("c:\\a")?.acl.ok, true);
		assert.deepEqual(JSON.parse(read.reports.get("c:\\a")?.acl.stdout ?? ""), entries);
		assert.equal(read.reports.get("c:\\a")?.owner, "S-1-5-18");
		assert.equal(read.reports.get("c:\\b")?.acl.ok, false);
		assert.equal(read.reports.get("c:\\b")?.owner, null);
		assert.deepEqual(native.deadlines, [20_000], "one batch under one 20 s deadline");
		// A value that is not a SID is not an identity.
		setWin32NativeForTest(fakeNative({ sid: "not-a-sid", failure: null, reports: new Map() }));
		assert.equal((await readStorageSecurity(["C:\\a"])).sid, null);
		// No module: every path is unreadable, which refuses.
		setWin32NativeForTest(null);
		const unavailable = await readStorageSecurity(["C:\\a", "C:\\b"]);
		assert.equal(unavailable.failure, "the native module is unavailable");
		assert.deepEqual([...unavailable.reports.values()].map(report => report.acl.ok), [false, false]);
	} finally { setWin32NativeForTest(realNative ?? undefined); }
});

it("names a refused principal from the lookup and leaves a bare SID when it does not resolve", async () => {
	setWin32NativeForTest(fakeNative({ sid: TEST_CURRENT_SID, failure: null, reports: new Map() }, new Map([["S-1-5-32-545", "BUILTIN\\Users"]])));
	try {
		assert.equal(await namedPrincipal("S-1-5-32-545"), "S-1-5-32-545 (BUILTIN\\Users)");
		assert.equal(await namedPrincipal("S-1-5-21-1-2-3-4"), "S-1-5-21-1-2-3-4");
		assert.equal(await namedPrincipal("S-1-5-32-545 (already named)"), "S-1-5-32-545 (already named)");
		setWin32NativeForTest(null);
		assert.equal(await namedPrincipal("S-1-5-32-545"), "S-1-5-32-545", "without a module the SID stands alone");
	} finally { setWin32NativeForTest(realNative ?? undefined); }
});

it("restricts a store that is already limited with one reading and no rewrite, and rewrites from that reading otherwise", async () => {
	await withStore(async (layout, root) => {
		const clean = fakeSecurity();
		const icacls: string[] = [];
		const probe = (read: NonNullable<PrivateStorageProbe["readSecurity"]>): PrivateStorageProbe => ({
			platform: "win32",
			readSecurity: read,
			applyIcacls: async target => { icacls.push(target); return { ok: true, stdout: "", detail: null }; },
		});
		const already = await restrictPrivateStorage({ layout, probe: probe(clean.read) });
		assert.equal(already.restricted, true, already.reason ?? "refused");
		assert.equal(clean.calls.length, 1, "a limited store costs one reading");
		assert.deepEqual(icacls, []);

		// Another account may read the root until it is rewritten; the rewrite then re-verifies from a fresh reading.
		let rewritten = false;
		const rewrites: string[] = [];
		const broad = fakeSecurity({ entries: target => target === root && !rewritten ? [...CLEAN_ENTRIES, "BUILTIN\\Users:(OI)(CI)(RX)"] : CLEAN_ENTRIES });
		const fixed = await restrictPrivateStorage({
			layout,
			probe: { ...probe(broad.read), applyIcacls: async target => { rewrites.push(target); rewritten = true; return { ok: true, stdout: "", detail: null }; } },
		});
		assert.equal(fixed.restricted, true, fixed.reason ?? "refused");
		assert.deepEqual(rewrites, [root]);
		assert.equal(broad.calls.length, 2, "the refused pass's reading decides the rewrite; one more reading verifies it");

		// A rewrite that does not take is refused, never assumed.
		const stuck = fakeSecurity({ entries: target => target === root ? [...CLEAN_ENTRIES, "BUILTIN\\Users:(OI)(CI)(RX)"] : CLEAN_ENTRIES });
		const refused = await restrictPrivateStorage({ layout, probe: probe(stuck.read) });
		assert.equal(refused.restricted, false);
		assert.match(refused.reason ?? "", /readable by S-1-5-32-545/);

		// A refusal no rewrite can repair (a foreign owner) stands after the one reading; nothing is rewritten and nothing is read twice.
		const foreign = fakeSecurity({ owner: () => "S-1-5-21-100-200-300-9999 (OTHER\\mallory)" });
		const rewritesBefore = icacls.length;
		const owned = await restrictPrivateStorage({ layout, probe: probe(foreign.read) });
		assert.equal(owned.restricted, false);
		assert.match(owned.reason ?? "", /is owned by S-1-5-21-100-200-300-9999/);
		assert.equal(foreign.calls.length, 1);
		assert.equal(icacls.length, rewritesBefore);
	});
});

it("leaves the access rules untouched when the account cannot be resolved, after one reading", async () => {
	await withStore(async layout => {
		const icacls: string[] = [];
		let reads = 0;
		const restriction = await restrictPrivateStorage({
			layout,
			probe: {
				platform: "win32",
				readSecurity: async paths => {
					reads += 1;
					return failedRead(paths, "the security read did not finish in 20000 ms");
				},
				applyIcacls: async target => { icacls.push(target); return { ok: true, stdout: "", detail: null }; },
			},
		});
		assert.equal(restriction.restricted, false);
		assert.match(restriction.reason ?? "", /access rules were left untouched/);
		assert.match(restriction.reason ?? "", /could not be resolved \(the security read did not finish in 20000 ms\)/, "the cause of the failed reading is in the refusal");
		assert.deepEqual(icacls, []);
		assert.equal(reads, 1, "a timed-out reading is not repeated within the same pass");
	});
});

it("verifies a limited real store natively: no process is started and the refusal names the principal", { skip: process.platform !== "win32" }, async () => {
	const base = await fs.mkdtemp(path.join(process.env.LOCALAPPDATA ?? os.homedir(), "omp-one-process-"));
	const root = path.join(base, "store");
	const layout: PrivateStorageLayout = { root, directories: [root], verifiedDirectories: [], probeDirectory: root, probeText: "one-process-real" };
	const system32 = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32");
	const run = promisify(execFile);
	const traces: ToolSpawn[] = [];
	try {
		const first = await restrictPrivateStorage({
			layout,
			probe: { applyIcacls: async (target, args) => {
				await run(path.join(system32, "icacls.exe"), [target, ...args], { windowsHide: true });
				return { ok: true, stdout: "", detail: null };
			} },
		});
		assert.equal(first.restricted, true, first.reason ?? "the real store was not restricted");
		setToolSpawnObserver(trace => traces.push(trace));
		try {
			const second = await restrictPrivateStorage({ layout });
			assert.equal(second.restricted, true, second.reason ?? "the limited real store was refused");
			await run(path.join(system32, "icacls.exe"), [root, "/grant", "*S-1-5-32-545:(OI)(CI)(RX)", "/Q"], { windowsHide: true });
			const refused = await verifyPrivateStorage({ layout });
			assert.equal(refused.ready, false);
			assert.match(refused.reason ?? "", /readable by S-1-5-32-545 \(BUILTIN\\.+\)/, "the SID a refusal quotes carries its name");
		} finally { setToolSpawnObserver(null); }
		assert.deepEqual(traces.map(formatToolSpawn), [], "reading the access of a store starts no process");
	} finally { await fs.rm(base, { recursive: true, force: true }); }
});

it("keeps a failing observer from changing what a spawn decides", () => {
	setToolSpawnObserver(() => { throw new Error("observer failed"); });
	try {
		assert.doesNotThrow(() => reportToolSpawn({ tool: "powershell", purpose: "x", pid: null, ms: 1, outcome: "ok" }));
	} finally { setToolSpawnObserver(null); }
	assert.equal(formatToolSpawn({ tool: "icacls", purpose: "p", pid: null, ms: 2, outcome: "timeout" }), "tool spawn: icacls p no pid 2 ms timeout");
});

it("reads in one synchronous step when every path is on a local fixed NTFS volume, and through the lane otherwise", async () => {
	const read: Win32SecurityRead = { sid: TEST_CURRENT_SID, failure: null, reports: new Map() };
	const calls = { sync: 0, lane: 0, volumes: [] as string[] };
	const native: Win32Native = {
		...fakeNative(read),
		volumeOf: root => {
			calls.volumes.push(root);
			return root === "c:\\" ? { driveType: 3, fileSystem: "NTFS" } : root === "d:\\" ? { driveType: 4, fileSystem: "NTFS" } : { driveType: 3, fileSystem: "FAT32" };
		},
		readSecuritySync: () => { calls.sync++; return read; },
		readSecurity: async () => { calls.lane++; return read; },
	};
	setWin32NativeForTest(native);
	try {
		await readVerifiedStorageSecurity(["C:\\a", "C:\\a\\b"]);
		await readVerifiedStorageSecurity(["C:\\c"]);
		assert.deepEqual([calls.sync, calls.lane], [2, 0]);
		assert.deepEqual(calls.volumes, ["c:\\"], "the volume of a root is asked once");
		await readVerifiedStorageSecurity(["C:\\a", "D:\\share\\x"]);
		await readVerifiedStorageSecurity(["E:\\fat"]);
		await readVerifiedStorageSecurity(["\\\\server\\share\\x"]);
		assert.deepEqual([calls.sync, calls.lane], [2, 3], "a network drive, another file system and a UNC path keep the lane and its deadline");
		// The ordinary reader never goes synchronous: it makes no promise about the paths it is handed.
		await readStorageSecurity(["C:\\a"]);
		assert.deepEqual([calls.sync, calls.lane], [2, 4]);
	} finally { setWin32NativeForTest(realNative ?? undefined); }
});

it("tells where a verification spent its time, part by part", { skip: process.platform !== "win32" }, async () => {
	const base = await fs.mkdtemp(path.join(process.env.LOCALAPPDATA ?? os.homedir(), "omp-phases-"));
	const root = path.join(base, "store");
	const layout: PrivateStorageLayout = { root, directories: [root], verifiedDirectories: [], probeDirectory: root, probeText: "phases" };
	const system32 = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32");
	try {
		const run = promisify(execFile);
		await restrictPrivateStorage({ layout, probe: { applyIcacls: async (target, args) => {
			await run(path.join(system32, "icacls.exe"), [target, ...args], { windowsHide: true });
			return { ok: true, stdout: "", detail: null };
		} } });
		const phases: [string, number][] = [];
		let turned = false;
		setImmediate(() => { turned = true; });
		const ready = await verifyPrivateStorage({ layout, phases: (name, ms) => phases.push([name, ms]) });
		assert.equal(ready.ready, true, ready.reason ?? "");
		assert.equal(turned, false, "a limited store on a local NTFS volume is verified without one turn of the event loop");
		assert.deepEqual(phases.map(([name]) => name), ["directories", "plain", "security", "judge", "probe"]);
		assert.ok(phases.every(([, ms]) => ms >= 0));
	} finally { await fs.rm(base, { recursive: true, force: true }); }
});

it("walks synchronously only where every path and every ancestor is a plain local directory", { skip: process.platform !== "win32" }, async () => {
	const base = await fs.mkdtemp(path.join(process.env.LOCALAPPDATA ?? os.homedir(), "omp-sync-walk-"));
	try {
		const store = path.join(base, "store", "deeper");
		assert.equal(await synchronousLocalPaths([store]), false, "an ancestor that does not exist is not a plain directory");
		await fs.mkdir(path.join(base, "store"));
		assert.equal(await synchronousLocalPaths([store]), true, "the path itself need not exist yet");
		assert.equal(await synchronousLocalPaths([store], "linux"), false, "only Windows has the volume facts");
		const target = path.join(base, "real");
		await fs.mkdir(target);
		const junction = path.join(base, "link");
		await fs.symlink(target, junction, "junction");
		assert.equal(await synchronousLocalPaths([path.join(junction, "x")]), false, "a junction on the way sends the verification to the asynchronous path, which refuses it");
		const read: Win32SecurityRead = { sid: TEST_CURRENT_SID, failure: null, reports: new Map() };
		setWin32NativeForTest({ ...fakeNative(read), volumeOf: () => ({ driveType: 4, fileSystem: "NTFS" }) });
		try {
			assert.equal(await synchronousLocalPaths([store]), false, "a network drive is not walked on this thread");
		} finally { setWin32NativeForTest(realNative ?? undefined); }
		setWin32NativeForTest({ ...fakeNative(read) });
		try {
			assert.equal(await synchronousLocalPaths([store]), false, "a module that cannot tell the volume is not trusted with it");
		} finally { setWin32NativeForTest(realNative ?? undefined); }
	} finally { await fs.rm(base, { recursive: true, force: true }); }
});

it("judges the folder of a file too: a folder that is a junction or a directory symlink is not walked, and nothing is remembered", { skip: process.platform !== "win32" }, async () => {
	const base = await fs.mkdtemp(path.join(process.env.LOCALAPPDATA ?? os.homedir(), "omp-sync-folder-"));
	try {
		const plain = path.join(base, "plain");
		await fs.mkdir(plain);
		const file = path.join(plain, "session.jsonl");
		assert.equal(await synchronousLocalPaths([file]), true, "a plain folder, however deep, on the volume of its root");
		const target = path.join(base, "elsewhere");
		await fs.mkdir(target);
		const junction = path.join(base, "junction-folder");
		await fs.symlink(target, junction, "junction");
		assert.equal(await synchronousLocalPaths([path.join(junction, "session.jsonl")]), false, "the file's own folder is a junction");
		const directoryLink = path.join(base, "symlink-folder");
		const linked = await fs.symlink(target, directoryLink, "dir").then(() => true, () => false);
		if (linked) assert.equal(await synchronousLocalPaths([path.join(directoryLink, "session.jsonl")]), false, "the file's own folder is a directory symlink");
		// The walk is made again on every call: a folder that becomes a link after a yes is a no on the next question.
		await fs.rm(plain, { recursive: true });
		await fs.symlink(target, plain, "junction");
		assert.equal(await synchronousLocalPaths([file]), false, "a folder replaced by a link since the last answer");
	} finally { await fs.rm(base, { recursive: true, force: true }); }
});

it("refuses UNC, extended and device paths by their spelling, before any native call, and asks about a volume only for a fixed disk", { skip: process.platform !== "win32" }, async () => {
	const read: Win32SecurityRead = { sid: TEST_CURRENT_SID, failure: null, reports: new Map() };
	const asked: string[] = [];
	setWin32NativeForTest({ ...fakeNative(read), volumeOf: root => { asked.push(root); return { driveType: 3, fileSystem: "NTFS" }; } });
	try {
		for (const target of ["\\\\server\\share\\dir\\file", "\\\\?\\UNC\\server\\share\\dir\\file", "\\\\?\\C:\\dir\\file", "\\\\.\\C:\\dir\\file", "relative\\file"]) {
			assert.equal(await synchronousLocalPaths([target]), false, target);
		}
		assert.deepEqual(asked, [], "no volume was asked about for any of them");
	} finally { setWin32NativeForTest(realNative ?? undefined); }
});
