import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { it } from "node:test";
import { isPermittedAclPrincipal, parseWindowsAcl, permissionsPermitReplacement, readStorageAcls, readStorageOwners, restrictPrivateStorage, verifyPrivateStorage, type PrivateStorageLayout, type PrivateStorageProbe } from "./private-storage.ts";
import { TEST_CURRENT_SID, fixtureAcl, fixturePrincipal } from "./private-storage-test-support.ts";

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
		const single = await readStorageAcls([root]);
		assert.equal(single.get(root.toLowerCase())?.ok, true);
		const multiple = await readStorageAcls([root, child]);
		assert.equal(multiple.size, 2, "JSON paths became a nested PowerShell array");
		for (const target of [root, child]) assert.equal(multiple.get(target.toLowerCase())?.ok, true);
		const owners = await readStorageOwners([root, child]);
		assert.equal(owners.ok, true);
		assert.equal(owners.stdout.split(/\r?\n/).filter(line => line.includes("|S-1-")).length, 2);
		const consoleRead = await run(path.join(system32, "cmd.exe"), ["/d", "/c", `chcp 866>nul & "${path.join(system32, "icacls.exe")}" "${root}"`], { windowsHide: true, windowsVerbatimArguments: true, encoding: "buffer" });
		t.diagnostic(`Forced CP866 icacls run: Cyrillic path bytes present=${consoleRead.stdout.includes(Buffer.from("88a2a0ad", "hex"))}; SID verification remains independent of this output`);
		await run(path.join(system32, "icacls.exe"), [root, "/grant", "*S-1-5-32-545:(OI)(CI)(RX)", "/Q"], { windowsHide: true });
		const refused = await verifyPrivateStorage({ layout });
		assert.equal(refused.ready, false, "a real Users read grant was admitted");
		assert.match(refused.reason ?? "", /readable by S-1-5-32-545/);
	} finally { await fs.rm(base, { recursive: true, force: true }); }
});
