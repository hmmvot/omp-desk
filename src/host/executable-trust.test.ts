/**
 * Tests for the trust rule of an executable that runs in place
 * ([ADR-0074](../../docs/decisions/0074-run-chat-brokers-on-the-sessions-own-bun-runtime-with-code-exe-as-fallback.md)).
 *
 * Runner: `node --test src/host/executable-trust.test.ts`
 *
 * What matters here: the verdict is made from security identifiers and numeric masks read through the `readSecurity`
 * seam, never from the machine's real ACLs. The file and the folder it sits in are held to read and execute for
 * everyone else; each directory further above, up to but not including the volume root, to the
 * replace/re-permission rule of private storage.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { permissionsPermitModification, verifyExecutableTrust, type ExecutableTrust } from "./executable-trust.ts";
import type { PrivateStorageSecurityRead, PrivateStorageSecurityReport } from "./private-storage.ts";

const ME = "S-1-5-21-1111111111-2222222222-3333333333-1001";
const OTHER = "S-1-5-21-1111111111-2222222222-3333333333-1002";
const SYSTEM = "S-1-5-18";
const ADMINS = "S-1-5-32-544";
const USERS = "S-1-5-32-545";

const FULL_CONTROL = 0x1f01ff;
const READ_EXECUTE = 0x1200a9;
const WRITE_DATA = 0x2;
const CREATE_FILES_AND_WRITE_DATA = 0x2 | 0x4 | 0x100;
const DELETE_CHILD = 0x40;
const DELETE = 0x10000;
const WRITE_DAC = 0x40000;

interface Entry {
	readonly principal: string;
	readonly permissions: number;
	readonly denied?: boolean;
}

const FILE = "C:\\Users\\me\\.bun\\bin\\bun.exe";
/** The folder the executable sits in: held as strictly as the file itself. */
const OWN_FOLDER = "C:\\Users\\me\\.bun\\bin";
/** The file and every directory above it below the volume root, nearest first, as the verifier asks for them. */
const CHAIN = [FILE, OWN_FOLDER, "C:\\Users\\me\\.bun", "C:\\Users\\me", "C:\\Users"];
/** The pass-through folders: above the executable's own folder. */
const ABOVE = CHAIN.slice(2);

/** What a user-profile chain typically carries; the file and its own folder never grant other principals more than read. */
function typical(strict: boolean): Entry[] {
	return [
		{ principal: ME, permissions: FULL_CONTROL },
		{ principal: SYSTEM, permissions: FULL_CONTROL },
		{ principal: ADMINS, permissions: FULL_CONTROL },
		{ principal: USERS, permissions: READ_EXECUTE },
		...(strict ? [] : [{ principal: USERS, permissions: CREATE_FILES_AND_WRITE_DATA }]),
	];
}

function report(entries: readonly Entry[], owner: string | null = ME): PrivateStorageSecurityReport {
	return {
		acl: { ok: true, stdout: JSON.stringify(entries.map(entry => ({ denied: false, ...entry }))), detail: null },
		owner,
	};
}

interface Overrides {
	readonly sid?: string | null;
	readonly failure?: string | null;
	readonly reports?: Record<string, PrivateStorageSecurityReport | null>;
}

/** A complete good read for CHAIN, with per-path replacements (`null` removes the report). */
function security(overrides: Overrides = {}): PrivateStorageSecurityRead {
	const reports = new Map<string, PrivateStorageSecurityReport>();
	for (const target of CHAIN) {
		const replaced = overrides.reports?.[target];
		if (replaced === null) continue;
		reports.set(target.toLowerCase(), replaced ?? report(typical(target === FILE || target === OWN_FOLDER)));
	}
	return { sid: overrides.sid === undefined ? ME : overrides.sid, failure: overrides.failure ?? null, reports };
}

/** Runs the verifier with a recording seam. */
async function verify(read: PrivateStorageSecurityRead | (() => Promise<PrivateStorageSecurityRead>), file = FILE) {
	const calls: { paths: readonly string[] }[] = [];
	const result = await verifyExecutableTrust(file, {
		readSecurity: async paths => {
			calls.push({ paths });
			return typeof read === "function" ? read() : read;
		},
	});
	return { result, calls };
}

function refusal(result: ExecutableTrust): string {
	assert.equal(result.ok, false, "expected a refusal");
	return result.ok ? "" : result.reason;
}

describe("permissionsPermitModification", () => {
	it("allows read and execute rights only", () => {
		assert.equal(permissionsPermitModification(READ_EXECUTE), false);
		assert.equal(permissionsPermitModification(0x1200a9), false);
		assert.equal(permissionsPermitModification(0xa0000000), false); // generic read | generic execute
		assert.equal(permissionsPermitModification(0x80000000), false); // generic read
		assert.equal(permissionsPermitModification(0), false);
		assert.equal(permissionsPermitModification(-2147483648), false); // the same generic-read bit, as a signed number
	});

	it("refuses every write, delete, re-permission and unknown right", () => {
		for (const permissions of [WRITE_DATA, 0x4, 0x10, 0x100, DELETE_CHILD, DELETE, WRITE_DAC, 0x80000, FULL_CONTROL, 0x40000000, 0x10000000, READ_EXECUTE | WRITE_DATA, 0x02000000]) {
			assert.equal(permissionsPermitModification(permissions), true, `0x${permissions.toString(16)}`);
		}
	});
});

describe("verifyExecutableTrust", { skip: process.platform === "win32" ? false : "the verified paths are Windows paths" }, () => {
	it("accepts a typical user-profile chain and reports the paths it read", async () => {
		const { result, calls } = await verify(security());
		assert.deepEqual(result, { ok: true, paths: CHAIN });
		assert.equal(calls.length, 1);
		assert.deepEqual(calls[0]?.paths, CHAIN);
	});

	it("reads the file plus every directory above it and never the volume root", async () => {
		const { calls } = await verify(security());
		assert.ok(!calls[0]?.paths.some(target => /^[A-Za-z]:\\?$/.test(target)));
		assert.equal(calls[0]?.paths[0], FILE);
	});

	it("accepts an access list that carries the account's name beside its SID", async () => {
		const named = report([
			{ principal: `${ME} (PC\\me)`, permissions: FULL_CONTROL },
			{ principal: `${SYSTEM} (NT AUTHORITY\\SYSTEM)`, permissions: FULL_CONTROL },
			{ principal: `${USERS} (BUILTIN\\Users)`, permissions: READ_EXECUTE },
		], `${ME} (PC\\me)`);
		const { result } = await verify(security({ reports: { [FILE]: named } }));
		assert.equal(result.ok, true);
	});

	it("refuses another principal that can write data to the file", async () => {
		const file = report([...typical(true), { principal: OTHER, permissions: WRITE_DATA }]);
		const reason = refusal((await verify(security({ reports: { [FILE]: file } }))).result);
		assert.ok(reason.includes(OTHER));
		assert.ok(reason.includes(FILE));
		assert.match(reason, /change/);
	});

	it("refuses another principal that may do more than read and execute the file, even without write data", async () => {
		for (const permissions of [WRITE_DAC, DELETE, 0x4, 0x100, FULL_CONTROL]) {
			const file = report([...typical(true), { principal: USERS, permissions }]);
			refusal((await verify(security({ reports: { [FILE]: file } }))).result);
		}
	});

	it("refuses another principal that can write data, create files or do anything beyond read and execute in the executable's own folder", async () => {
		for (const permissions of [WRITE_DATA, CREATE_FILES_AND_WRITE_DATA, 0x4, 0x100, DELETE_CHILD, DELETE, WRITE_DAC, FULL_CONTROL]) {
			const entries = [...typical(true), { principal: OTHER, permissions }];
			const reason = refusal((await verify(security({ reports: { [OWN_FOLDER]: report(entries) } }))).result);
			assert.ok(reason.includes("the executable's folder"), reason);
			assert.ok(reason.includes(OWN_FOLDER), reason);
			assert.ok(reason.includes(OTHER), reason);
			assert.match(reason, /change/);
		}
	});

	it("refuses the common user-profile grant of create-files to Users on the executable's own folder", async () => {
		const reason = refusal((await verify(security({ reports: { [OWN_FOLDER]: report(typical(false)) } }))).result);
		assert.ok(reason.includes("the executable's folder"), reason);
		assert.ok(reason.includes(USERS), reason);
	});

	it("refuses another principal that can delete children, delete or re-permission a folder above the executable's own", async () => {
		for (const permissions of [DELETE_CHILD, DELETE, WRITE_DAC]) {
			for (const directory of ABOVE) {
				const entries = [...typical(false), { principal: OTHER, permissions }];
				const reason = refusal((await verify(security({ reports: { [directory]: report(entries) } }))).result);
				assert.ok(reason.includes(directory), reason);
				assert.ok(reason.includes(OTHER), reason);
				assert.ok(reason.includes("the directory"), reason);
				assert.match(reason, /replace or re-permission/);
			}
		}
	});

	it("lets another principal create files and write data in a folder above the executable's own", async () => {
		for (const directory of ABOVE) {
			const entries = [...typical(false), { principal: OTHER, permissions: CREATE_FILES_AND_WRITE_DATA }, { principal: OTHER, permissions: WRITE_DATA }];
			const { result } = await verify(security({ reports: { [directory]: report(entries) } }));
			assert.equal(result.ok, true, directory);
		}
	});

	it("ignores denied entries", async () => {
		const denied = { principal: OTHER, permissions: FULL_CONTROL, denied: true };
		const file = report([...typical(true), denied]);
		const own = report([...typical(true), denied]);
		const directory = report([...typical(false), denied]);
		const { result } = await verify(security({ reports: { [FILE]: file, [OWN_FOLDER]: own, "C:\\Users\\me": directory } }));
		assert.equal(result.ok, true);
	});

	it("refuses an owner that is not the account, SYSTEM or Administrators", async () => {
		const file = report(typical(true), OTHER);
		const reason = refusal((await verify(security({ reports: { [FILE]: file } }))).result);
		assert.ok(reason.includes(`owned by ${OTHER}`));
		const folder = report(typical(true), OTHER);
		assert.ok(refusal((await verify(security({ reports: { [OWN_FOLDER]: folder } }))).result).includes("the executable's folder"));
		const directory = report(typical(false), USERS);
		assert.ok(refusal((await verify(security({ reports: { "C:\\Users": directory } }))).result).includes("the directory"));
	});

	it("accepts SYSTEM and Administrators as owners", async () => {
		for (const owner of [SYSTEM, ADMINS]) {
			const { result } = await verify(security({ reports: { "C:\\Users": report(typical(false), owner) } }));
			assert.equal(result.ok, true, owner);
		}
	});

	it("refuses a path whose owner could not be read", async () => {
		const reason = refusal((await verify(security({ reports: { "C:\\Users\\me": report(typical(false), null) } }))).result);
		assert.match(reason, /owner of C:\\Users\\me could not be read/);
	});

	it("refuses an access list that could not be read", async () => {
		const unreadable: PrivateStorageSecurityReport = { acl: { ok: false, stdout: "", detail: "Access is denied" }, owner: ME };
		const reason = refusal((await verify(security({ reports: { "C:\\Users\\me\\.bun": unreadable } }))).result);
		assert.ok(reason.includes("C:\\Users\\me\\.bun"));
		assert.ok(reason.includes("Access is denied"));
	});

	it("refuses an access list that does not parse", async () => {
		for (const stdout of ["not json", "[]", "{}", JSON.stringify([{ principal: "everyone", permissions: 1, denied: false }]), JSON.stringify([{ principal: ME, permissions: "full", denied: false }])]) {
			const garbled: PrivateStorageSecurityReport = { acl: { ok: true, stdout, detail: null }, owner: ME };
			const reason = refusal((await verify(security({ reports: { [FILE]: garbled } }))).result);
			assert.match(reason, /could not be read/, stdout);
		}
	});

	it("refuses when the account SID is unknown", async () => {
		const reason = refusal((await verify(security({ sid: null }))).result);
		assert.match(reason, /SID could not be read/);
	});

	it("refuses when the whole read failed", async () => {
		const reason = refusal((await verify(security({ failure: "powershell timed out" }))).result);
		assert.ok(reason.includes("powershell timed out"));
	});

	it("refuses when the reader throws", async () => {
		const reason = refusal((await verify(async () => {
			throw new Error("spawn powershell ENOENT");
		})).result);
		assert.ok(reason.includes("spawn powershell ENOENT"));
	});

	it("refuses a path the reader returned no report for", async () => {
		for (const target of CHAIN) {
			const reason = refusal((await verify(security({ reports: { [target]: null } }))).result);
			assert.ok(reason.includes(target), reason);
			assert.match(reason, /no report/);
		}
	});

	it("refuses a path that is not absolute without reading anything", async () => {
		for (const file of ["bun.exe", ".\\bun.exe", "bin\\bun.exe"]) {
			const { result, calls } = await verify(security(), file);
			assert.ok(refusal(result).includes(file));
			assert.equal(calls.length, 0);
		}
	});

	it("reads only the file for one directly below the volume root, and nothing above", async () => {
		const read: PrivateStorageSecurityRead = {
			sid: ME,
			failure: null,
			reports: new Map([["d:\\bun.exe", report(typical(true), ADMINS)]]),
		};
		const { result, calls } = await verify(read, "D:\\bun.exe");
		assert.deepEqual(result, { ok: true, paths: ["D:\\bun.exe"] });
		assert.deepEqual(calls[0]?.paths, ["D:\\bun.exe"]);
	});
});
