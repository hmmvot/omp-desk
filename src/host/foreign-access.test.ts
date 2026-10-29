import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	accessLevel,
	describeForeignAccess,
	findForeignAccess,
	foreignAccessDiagnostics,
	formatForeignAccess,
	nameForeignAccess,
	splitPrincipal,
	type ForeignAccess,
} from "./foreign-access.ts";

const OTHER = "S-1-5-21-100-200-300-1002";
const ME = "S-1-5-21-100-200-300-1001";
const FOLDER = "C:\\Users\\<account>\\AppData\\Roaming\\Code\\User\\globalStorage\\publisher.extension";

const carrier: ForeignAccess = {
	kind: "replace-folder",
	path: FOLDER,
	principal: OTHER,
	principalName: "PC\\OtherUser",
	permissions: 0x1f01ff,
	inherited: false,
	current: ME,
	currentName: "PC\\Me",
};

describe("accessLevel", () => {
	it("reads a mask as the words of the Security tab", () => {
		assert.equal(accessLevel(0x1f01ff), "full control");
		assert.equal(accessLevel(0xffffffff), "full control");
		assert.equal(accessLevel(0x10000000), "full control");
		assert.equal(accessLevel(0x1301bf), "modify access");
		assert.equal(accessLevel(0x40000), "delete or permission-changing access");
		assert.equal(accessLevel(0x10000 | 0x1200a9), "delete or permission-changing access");
		assert.equal(accessLevel(0x116), "write access");
		assert.equal(accessLevel(0x1200a9), "read access");
		assert.equal(accessLevel((0x80000000 | 0x20000000) | 0), "read access", "a signed generic read/execute");
	});
});

describe("the refusal sentence", () => {
	it("is read back as the facts it was written from, whatever surrounds it", () => {
		const cases: ForeignAccess[] = [
			carrier,
			{ ...carrier, inherited: true },
			{ ...carrier, inherited: null, principalName: null, currentName: null },
			{ ...carrier, current: null, currentName: null },
			{ ...carrier, kind: "read-store", permissions: 0x1200a9 },
			{ ...carrier, kind: "read-store", permissions: null, inherited: null },
			{ ...carrier, kind: "own-store", permissions: null, inherited: null },
		];
		for (const access of cases) {
			const sentence = formatForeignAccess(access);
			assert.deepEqual(findForeignAccess(sentence)?.access, access, sentence);
			const wrapped = `the staged runtime tree is not usable: ${sentence} [more]`;
			const found = findForeignAccess(wrapped);
			assert.deepEqual(found?.access, access, wrapped);
			assert.equal(wrapped.slice(found!.index, found!.index + found!.length), sentence, "the match is the sentence and nothing around it");
		}
	});

	it("keeps the wording the verifier always had at its start, and says the origin and the account after it", () => {
		assert.equal(
			formatForeignAccess(carrier),
			`the component ${FOLDER} on the path to the store lets ${OTHER} (PC\\OtherUser) replace or re-permission it (2032127: full control, set directly on it); this window runs as ${ME} (PC\\Me)`,
		);
		assert.equal(
			formatForeignAccess({ ...carrier, kind: "read-store", permissions: 0x1200a9, inherited: true }),
			`the store path ${FOLDER} is readable by ${OTHER} (PC\\OtherUser), beyond the same-user boundary (1179817: read access, inherited from a parent folder); this window runs as ${ME} (PC\\Me)`,
		);
		assert.equal(
			formatForeignAccess({ ...carrier, kind: "own-store", permissions: null, inherited: null }),
			`the store path ${FOLDER} is owned by ${OTHER} (PC\\OtherUser), beyond the same-user boundary; this window runs as ${ME} (PC\\Me)`,
		);
	});

	it("is not found in a message that only resembles it", () => {
		assert.equal(findForeignAccess("the component C:\\x on the path to the store could not be verified (the SID reader failed)"), null);
		assert.equal(findForeignAccess("the component C:\\x on the path to the store lets everyone replace or re-permission it (1)"), null, "a principal that is not a SID");
		assert.equal(findForeignAccess("This program is blocked by group policy."), null);
	});

	it("takes a principal apart into its SID and the name it carries", () => {
		assert.deepEqual(splitPrincipal(OTHER), { sid: OTHER, name: null });
		assert.deepEqual(splitPrincipal(`${OTHER} (PC\\OtherUser)`), { sid: OTHER, name: "PC\\OtherUser" });
		assert.equal(splitPrincipal("PC\\OtherUser"), null);
	});
});

describe("nameForeignAccess", () => {
	const bare = formatForeignAccess({ ...carrier, principalName: null, currentName: null });

	it("adds the names the lookup resolves, and asks only for the SIDs that have none", async () => {
		const asked: string[][] = [];
		const named = await nameForeignAccess(`prefix: ${bare}`, async sids => {
			asked.push([...sids]);
			return new Map([[OTHER, "PC\\OtherUser"], [ME, "PC\\Me"]]);
		});
		assert.equal(named, `prefix: ${formatForeignAccess(carrier)}`);
		assert.deepEqual(asked, [[OTHER, ME]]);
		const half = await nameForeignAccess(formatForeignAccess({ ...carrier, principalName: null }), async sids => {
			asked.push([...sids]);
			return new Map([[OTHER, "PC\\OtherUser"]]);
		});
		assert.equal(half, formatForeignAccess(carrier));
		assert.deepEqual(asked[1], [OTHER]);
	});

	it("leaves the message as it is when nothing resolves, the lookup fails, everything is named, or it holds no such refusal", async () => {
		assert.equal(await nameForeignAccess(bare, async () => new Map()), bare);
		assert.equal(await nameForeignAccess(bare, async () => { throw new Error("lane died"); }), bare);
		const full = formatForeignAccess(carrier);
		assert.equal(await nameForeignAccess(full, async () => { throw new Error("must not be asked"); }), full);
		assert.equal(await nameForeignAccess("it could not be staged", async () => { throw new Error("must not be asked"); }), "it could not be staged");
	});
});

describe("the notification's sentences", () => {
	it("names the folder, the account and the account VS Code runs as, and how to end it", () => {
		const { headline, remedy } = describeForeignAccess(carrier, "More.");
		assert.equal(headline, `The native module (koffi.node) did not load: another Windows account, PC\\OtherUser, has full control of ${FOLDER}, so it could replace the module that runs as PC\\Me.`);
		assert.equal(remedy, "Remove that account's access to the folder, or run VS Code as the account you are signed in to Windows with, then choose Reload Window. More.");
	});

	it("says that an inherited entry has to be removed where it is set", () => {
		const { remedy } = describeForeignAccess({ ...carrier, inherited: true }, "More.");
		assert.match(remedy, /^That access is inherited from a parent folder: remove it where it is set, or run VS Code as/);
	});

	it("falls back to the SID and to this account when a name is not known", () => {
		const { headline } = describeForeignAccess({ ...carrier, principalName: null, current: null, currentName: null, permissions: 0x1301bf }, "More.");
		assert.match(headline, new RegExp(`another Windows account, ${OTHER}, has modify access to .*, so it could replace the module that runs as this account\\.$`));
	});

	it("says what the other kinds of refusal mean", () => {
		const read = describeForeignAccess({ ...carrier, kind: "read-store", permissions: 0x1200a9 }, "More.");
		assert.match(read.headline, /has read access to .*, where the module that runs as PC\\Me is kept\.$/);
		const owned = describeForeignAccess({ ...carrier, kind: "own-store", permissions: null, inherited: null }, "More.");
		assert.match(owned.headline, /is owned by another Windows account, PC\\OtherUser, which could change who may use it\.$/);
		assert.match(owned.remedy, /^Run VS Code as that account/);
	});

	it("puts one line per fact in the diagnostics", () => {
		assert.deepEqual(foreignAccessDiagnostics({ ...carrier, inherited: true }), [
			`Folder: ${FOLDER}`,
			`Other account: ${OTHER} (PC\\OtherUser)`,
			"Its access: full control (mask 2032127)",
			"Entry: inherited from a parent folder",
			`VS Code runs as: ${ME} (PC\\Me)`,
		]);
		const owner = foreignAccessDiagnostics({ ...carrier, kind: "own-store", permissions: null, inherited: null, current: null, currentName: null });
		assert.deepEqual(owner.slice(2), ["Its access: owner", "Entry: not an access entry", "VS Code runs as: not reported by the message"]);
	});
});
