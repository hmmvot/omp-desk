/**
 * Decoding of the security structures `GetNamedSecurityInfoW` returns (ADR-0076). Pure byte
 * parsing, with no FFI: `win32-native.ts` copies the native memory out and hands the bytes here.
 *
 * Every length is checked against the structure's own declared size before a byte past it is
 * read, and a structure that does not hold together is refused whole (`null`), never guessed at:
 * a private-storage verdict rests on these entries.
 */

/** One access-control entry of a DACL, as the permitted-principal rule reads it. */
export interface SecurityEntry {
	/** The trustee's SID in its string form, `S-1-...`. */
	readonly principal: string;
	/** The raw access mask, unsigned. */
	readonly permissions: number;
	/** `true` for a deny entry. */
	readonly denied: boolean;
}

const ACCESS_ALLOWED_ACE_TYPE = 0;
const ACCESS_DENIED_ACE_TYPE = 1;
const ACCESS_ALLOWED_OBJECT_ACE_TYPE = 5;
const ACCESS_DENIED_OBJECT_ACE_TYPE = 6;
const ACCESS_ALLOWED_CALLBACK_ACE_TYPE = 9;
const ACCESS_DENIED_CALLBACK_ACE_TYPE = 10;
const ACCESS_ALLOWED_CALLBACK_OBJECT_ACE_TYPE = 11;
const ACCESS_DENIED_CALLBACK_OBJECT_ACE_TYPE = 12;

/** ACE types that grant or deny access, and whether each denies; they are the entries of a reading. */
const ACCESS_ACE_DENIES: ReadonlyMap<number, boolean> = new Map([
	[ACCESS_ALLOWED_ACE_TYPE, false],
	[ACCESS_DENIED_ACE_TYPE, true],
	[ACCESS_ALLOWED_OBJECT_ACE_TYPE, false],
	[ACCESS_DENIED_OBJECT_ACE_TYPE, true],
	[ACCESS_ALLOWED_CALLBACK_ACE_TYPE, false],
	[ACCESS_DENIED_CALLBACK_ACE_TYPE, true],
	[ACCESS_ALLOWED_CALLBACK_OBJECT_ACE_TYPE, false],
	[ACCESS_DENIED_CALLBACK_OBJECT_ACE_TYPE, true],
]);
/** Object ACEs carry optional GUIDs between the mask and the SID. */
const OBJECT_ACE_TYPES: ReadonlySet<number> = new Set([
	ACCESS_ALLOWED_OBJECT_ACE_TYPE,
	ACCESS_DENIED_OBJECT_ACE_TYPE,
	ACCESS_ALLOWED_CALLBACK_OBJECT_ACE_TYPE,
	ACCESS_DENIED_CALLBACK_OBJECT_ACE_TYPE,
]);
/**
 * ACE types that audit, alarm or label and so grant nothing: never entries, and never in a DACL a
 * file system returns. Any other type is not understood, so the whole list is refused.
 */
const NON_ACCESS_ACE_TYPES: ReadonlySet<number> = new Set([2, 3, 7, 8, 13, 14, 15, 16, 17]);

const ACE_OBJECT_TYPE_PRESENT = 0x1;
const ACE_INHERITED_OBJECT_TYPE_PRESENT = 0x2;
const GUID_BYTES = 16;
const ACL_HEADER_BYTES = 8;
const ACE_HEADER_BYTES = 4;
export const SID_HEADER_BYTES = 8;
export const MAX_SID_SUBAUTHORITIES = 15;

/** The SID `S-1-1-0` (Everyone): what a NULL DACL grants full control to. */
export const EVERYONE_SID = "S-1-1-0";
/** A NULL DACL is reported as one entry granting Everyone this mask, as .NET's `GetAccessRules` reports it. */
const FULL_ACCESS_MASK = 0xffffffff;

/** Total byte length of the SID that starts `bytes` (read from its own sub-authority count), or `null`. */
export function sidLength(bytes: Uint8Array, offset = 0): number | null {
	if (offset < 0 || offset + SID_HEADER_BYTES > bytes.length) return null;
	const subAuthorities = bytes[offset + 1]!;
	if (subAuthorities > MAX_SID_SUBAUTHORITIES) return null;
	const length = SID_HEADER_BYTES + 4 * subAuthorities;
	return offset + length <= bytes.length ? length : null;
}

/** `S-<revision>-<authority>-<sub>...` of the SID at `offset`, or `null` when it does not fit or is not revision 1. */
export function formatSid(bytes: Uint8Array, offset = 0): string | null {
	const length = sidLength(bytes, offset);
	if (length === null || bytes[offset] !== 1) return null;
	let authority = 0n;
	for (let at = 2; at < 8; at++) authority = (authority << 8n) | BigInt(bytes[offset + at]!);
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let text = `S-1-${authority}`;
	for (let index = 0; index < bytes[offset + 1]!; index++) text += `-${view.getUint32(offset + SID_HEADER_BYTES + 4 * index, true)}`;
	return text;
}

/**
 * Every grant and denial of an ACL, in stored order. `bytes` starts with the `ACL` header and covers
 * at least its declared size. `null` when the list does not hold together (a size past the end, a
 * SID that does not fit its entry, an entry type that is not understood).
 */
export function decodeAclEntries(bytes: Uint8Array): SecurityEntry[] | null {
	if (bytes.length < ACL_HEADER_BYTES) return null;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const aclSize = view.getUint16(2, true);
	const aceCount = view.getUint16(4, true);
	if (aclSize < ACL_HEADER_BYTES || aclSize > bytes.length) return null;
	const entries: SecurityEntry[] = [];
	let offset = ACL_HEADER_BYTES;
	for (let index = 0; index < aceCount; index++) {
		if (offset + ACE_HEADER_BYTES + 4 > aclSize) return null;
		const type = bytes[offset]!;
		const aceSize = view.getUint16(offset + 2, true);
		if (aceSize < ACE_HEADER_BYTES + 4 || offset + aceSize > aclSize) return null;
		const denied = ACCESS_ACE_DENIES.get(type);
		if (denied === undefined) {
			if (!NON_ACCESS_ACE_TYPES.has(type)) return null;
			offset += aceSize;
			continue;
		}
		const permissions = view.getUint32(offset + 4, true);
		let sidOffset = offset + 8;
		if (OBJECT_ACE_TYPES.has(type)) {
			if (sidOffset + 4 > offset + aceSize) return null;
			const flags = view.getUint32(sidOffset, true);
			sidOffset += 4;
			if ((flags & ACE_OBJECT_TYPE_PRESENT) !== 0) sidOffset += GUID_BYTES;
			if ((flags & ACE_INHERITED_OBJECT_TYPE_PRESENT) !== 0) sidOffset += GUID_BYTES;
		}
		const length = sidLength(bytes, sidOffset);
		if (length === null || sidOffset + length > offset + aceSize) return null;
		const principal = formatSid(bytes, sidOffset);
		if (principal === null) return null;
		entries.push({ principal, permissions, denied });
		offset += aceSize;
	}
	return entries;
}

/** What a NULL DACL grants: everyone, everything. */
export function nullDaclEntries(): SecurityEntry[] {
	return [{ principal: EVERYONE_SID, permissions: FULL_ACCESS_MASK, denied: false }];
}

/** The binary SID of `S-1-<authority>-<sub>...`, or `null` when the text is not a SID this module would format. */
export function sidBytesOf(text: string): Buffer | null {
	const parts = /^S-1-(\d+)((?:-\d+)*)$/.exec(text);
	if (parts === null) return null;
	const authority = BigInt(parts[1]!);
	const subs = parts[2] === "" ? [] : parts[2]!.slice(1).split("-").map(Number);
	if (authority >= 1n << 48n || subs.length === 0 || subs.length > MAX_SID_SUBAUTHORITIES || subs.some(sub => !Number.isSafeInteger(sub) || sub > 0xffffffff)) return null;
	const bytes = Buffer.alloc(SID_HEADER_BYTES + 4 * subs.length);
	bytes[0] = 1;
	bytes[1] = subs.length;
	for (let at = 0; at < 6; at++) bytes[2 + at] = Number((authority >> BigInt(8 * (5 - at))) & 0xffn);
	subs.forEach((sub, index) => bytes.writeUInt32LE(sub, SID_HEADER_BYTES + 4 * index));
	return bytes;
}
