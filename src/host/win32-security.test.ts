import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeAclEntries, EVERYONE_SID, formatSid, nullDaclEntries, sidBytesOf, sidLength } from "./win32-security.ts";

/** The binary SID of `S-1-5-18` (SYSTEM): revision 1, one sub-authority, authority 5, sub-authority 18. */
const SYSTEM = Buffer.from([1, 1, 0, 0, 0, 0, 0, 5, 18, 0, 0, 0]);
const ADMINISTRATORS = sidBytesOf("S-1-5-32-544")!;
const EVERYONE = sidBytesOf("S-1-1-0")!;

/** One ACE: header, mask, then `body` (what follows the mask). */
function ace(type: number, mask: number, body: Buffer, flags = 0): Buffer {
	const bytes = Buffer.alloc(8 + body.length);
	bytes[0] = type;
	bytes[1] = flags;
	bytes.writeUInt16LE(bytes.length, 2);
	bytes.writeUInt32LE(mask, 4);
	body.copy(bytes, 8);
	return bytes;
}

/** An ACL of `aces`, with the declared size and count unless overridden. */
function acl(aces: readonly Buffer[], override: { size?: number; count?: number } = {}): Buffer {
	const body = Buffer.concat(aces);
	const bytes = Buffer.alloc(8 + body.length);
	bytes[0] = 2;
	bytes.writeUInt16LE(override.size ?? bytes.length, 2);
	bytes.writeUInt16LE(override.count ?? aces.length, 4);
	body.copy(bytes, 8);
	return bytes;
}

function objectBody(flags: number, guids: number, sid: Buffer): Buffer {
	const head = Buffer.alloc(4);
	head.writeUInt32LE(flags, 0);
	return Buffer.concat([head, Buffer.alloc(16 * guids, 7), sid]);
}

describe("SIDs", () => {
	it("formats the binary form and encodes the string form back", () => {
		assert.equal(formatSid(SYSTEM), "S-1-5-18");
		assert.equal(formatSid(ADMINISTRATORS), "S-1-5-32-544");
		assert.deepEqual(sidBytesOf("S-1-5-18"), SYSTEM);
		const account = "S-1-5-21-1004336348-1177238915-682003330-1001";
		assert.equal(formatSid(sidBytesOf(account)!), account);
	});

	it("refuses a SID that does not fit its own sub-authority count or is not revision 1", () => {
		assert.equal(sidLength(SYSTEM.subarray(0, 10)), null);
		assert.equal(formatSid(Buffer.from([1, 16, 0, 0, 0, 0, 0, 5, ...new Array(64).fill(0)])), null, "more than 15 sub-authorities");
		assert.equal(formatSid(Buffer.from([2, 1, 0, 0, 0, 0, 0, 5, 18, 0, 0, 0])), null);
		assert.equal(sidBytesOf("S-1-5-banana"), null);
		assert.equal(sidBytesOf("S-1-5"), null, "a SID needs a sub-authority");
	});
});

describe("decodeAclEntries", () => {
	it("reads allow and deny entries in stored order with their raw masks", () => {
		const entries = decodeAclEntries(acl([ace(0, 0x1f01ff, SYSTEM), ace(1, 0x120116, ADMINISTRATORS), ace(0, 0xffffffff, EVERYONE)]));
		assert.deepEqual(entries, [
			{ principal: "S-1-5-18", permissions: 0x1f01ff, denied: false },
			{ principal: "S-1-5-32-544", permissions: 0x120116, denied: true },
			{ principal: "S-1-1-0", permissions: 0xffffffff, denied: false },
		]);
	});

	it("reads object ACEs with and without their GUIDs, and callback ACEs with their trailing data", () => {
		const entries = decodeAclEntries(
			acl([
				ace(5, 0x2, objectBody(0, 0, SYSTEM)),
				ace(6, 0x4, objectBody(1, 1, SYSTEM)),
				ace(11, 0x8, objectBody(3, 2, ADMINISTRATORS)),
				ace(12, 0x10, objectBody(2, 1, ADMINISTRATORS)),
				ace(9, 0x20, Buffer.concat([SYSTEM, Buffer.from("condition")])),
				ace(10, 0x40, Buffer.concat([EVERYONE, Buffer.from("x")])),
			]),
		);
		assert.deepEqual(entries, [
			{ principal: "S-1-5-18", permissions: 0x2, denied: false },
			{ principal: "S-1-5-18", permissions: 0x4, denied: true },
			{ principal: "S-1-5-32-544", permissions: 0x8, denied: false },
			{ principal: "S-1-5-32-544", permissions: 0x10, denied: true },
			{ principal: "S-1-5-18", permissions: 0x20, denied: false },
			{ principal: "S-1-1-0", permissions: 0x40, denied: true },
		]);
	});

	it("does not report audit, alarm or label entries, and reports an empty list as empty", () => {
		assert.deepEqual(decodeAclEntries(acl([ace(2, 0x1, SYSTEM), ace(3, 0x1, SYSTEM), ace(17, 0x1, SYSTEM), ace(0, 0x3, SYSTEM)])), [
			{ principal: "S-1-5-18", permissions: 0x3, denied: false },
		]);
		assert.deepEqual(decodeAclEntries(acl([])), []);
	});

	it("refuses a list it does not understand or that does not hold together", () => {
		assert.equal(decodeAclEntries(acl([ace(4, 0x1, SYSTEM)])), null, "a compound ACE type");
		assert.equal(decodeAclEntries(acl([ace(99, 0x1, SYSTEM)])), null, "an unknown ACE type");
		assert.equal(decodeAclEntries(acl([ace(0, 0x1, SYSTEM)], { count: 2 })), null, "a count past the end");
		assert.equal(decodeAclEntries(acl([ace(0, 0x1, SYSTEM)], { size: 12 })), null, "an ACE past the declared size");
		assert.equal(decodeAclEntries(acl([ace(0, 0x1, SYSTEM)], { size: 4 })), null, "a size below the header");
		assert.equal(decodeAclEntries(acl([ace(0, 0x1, SYSTEM)], { size: 4000 })), null, "a size past the bytes given");
		assert.equal(decodeAclEntries(Buffer.alloc(4)), null, "no header");
		const shortSid = ace(0, 0x1, SYSTEM.subarray(0, 6));
		assert.equal(decodeAclEntries(acl([shortSid])), null, "a SID that does not fit its entry");
		const lyingSid = Buffer.from(SYSTEM);
		lyingSid[1] = 5;
		assert.equal(decodeAclEntries(acl([ace(0, 0x1, lyingSid)])), null, "a SID whose count exceeds its entry");
		const shortObject = ace(5, 0x1, Buffer.from([1, 0, 0, 0]));
		assert.equal(decodeAclEntries(acl([shortObject])), null, "an object ACE whose GUID and SID are missing");
	});

	it("reads a NULL DACL as full control for Everyone", () => {
		assert.deepEqual(nullDaclEntries(), [{ principal: EVERYONE_SID, permissions: 0xffffffff, denied: false }]);
	});
});
