/**
 * The refusals that say another Windows account can reach, replace or re-permission what the staged runtime (the native module,
 * ADR-0076) is kept in, and the sentence a person is given for them (ADR-0054: the same-user boundary).
 *
 * The boundary is one rule: only the account running VS Code, SYSTEM and Administrators (the group, and any account Windows lists as
 * a member of it, ADR-0054 amended 2026-10-30) may hold access that lets the staged tree
 * be replaced or re-permissioned, on the tree and on every folder on the path to it. The private-storage verifier and the warm-start
 * check refuse with a sentence; that sentence reaches the user as a plain string (it crosses the staging child's output, the loader's
 * recorded failure and the log). This module is the one place that writes it and reads it back, so the notice can say which folder,
 * which account, what access, whether the entry is inherited and which account runs VS Code without the verifier knowing anything
 * about notices. Nothing here relaxes a check; it only describes the one that refused. No imports from `vscode`, no I/O.
 */

import { REPLACEMENT_FREE_MASK } from "./win32-security.ts";

/** What the refusal was about: an entry on a folder on the way to the store, an entry on the store itself, or its owner. */
export type ForeignAccessKind = "replace-folder" | "read-store" | "own-store";

/** One refusal of the same-user boundary, as facts. */
export interface ForeignAccess {
	readonly kind: ForeignAccessKind;
	/** The folder (or, for `read-store` and `own-store`, the store path) the other account reaches. */
	readonly path: string;
	/** The other account's SID. */
	readonly principal: string;
	/** Its `DOMAIN\name` when it resolved; `null` otherwise. */
	readonly principalName: string | null;
	/** The access mask of the entry; `null` for `own-store`, where the account owns the path instead. */
	readonly permissions: number | null;
	/** Whether the entry is inherited from a parent; `null` when the reading did not say (and for `own-store`). */
	readonly inherited: boolean | null;
	/** The SID of the account that runs VS Code; `null` when the refusal did not name it. */
	readonly current: string | null;
	/** Its `DOMAIN\name` when it resolved; `null` otherwise. */
	readonly currentName: string | null;
}

/** The kinds of access an entry's mask is read as, from most to least. */
export type AccessLevel = "full control" | "modify access" | "delete or permission-changing access" | "write access" | "read access";

const FULL_CONTROL = 0x1f01ff;
const GENERIC_ALL = 0x10000000;
const MODIFY = 0x1301bf;
/** FILE_WRITE_DATA, FILE_APPEND_DATA, FILE_WRITE_EA, FILE_WRITE_ATTRIBUTES and GENERIC_WRITE. */
const WRITE_BITS = 0x2 | 0x4 | 0x10 | 0x100 | 0x40000000;

/** The access an entry's mask grants, as the words a person knows from the Security tab. */
export function accessLevel(permissions: number): AccessLevel {
	const mask = permissions >>> 0;
	if ((mask & GENERIC_ALL) !== 0 || (mask & FULL_CONTROL) === FULL_CONTROL) return "full control";
	if ((mask & MODIFY) === MODIFY) return "modify access";
	if ((mask & ~REPLACEMENT_FREE_MASK) !== 0) return "delete or permission-changing access";
	return (mask & WRITE_BITS) !== 0 ? "write access" : "read access";
}

const INHERITED_TEXT = "inherited from a parent folder";
const DIRECT_TEXT = "set directly on it";
const SID = "S-1-(?:\\d+-){1,14}\\d+";
/** A principal as a refusal quotes it: the SID and, once resolved, its name in parentheses. The group names are `<prefix>Sid` and `<prefix>Name`. */
const principalPattern = (prefix: string): string => `(?<${prefix}Sid>${SID})(?: \\((?<${prefix}Name>[^)\\r\\n]*)\\))?`;
/** Mask, optional access words, optional origin: the parenthesis after an entry's refusal. */
const DETAIL = `\\((?<mask>-?\\d+)(?:: (?<words>.*?))?(?:, (?<origin>${INHERITED_TEXT}|${DIRECT_TEXT}))?\\)`;
const TAIL = `(?:; this window runs as ${principalPattern("current")})?`;

const PATTERNS: ReadonlyArray<readonly [ForeignAccessKind, RegExp]> = [
	["replace-folder", new RegExp(`the component (?<path>.+?) on the path to the store lets ${principalPattern("principal")} replace or re-permission it ${DETAIL}${TAIL}`)],
	["read-store", new RegExp(`the store path (?<path>.+?) is readable by ${principalPattern("principal")}, beyond the same-user boundary(?: ${DETAIL})?${TAIL}`)],
	["own-store", new RegExp(`the store path (?<path>.+?) is owned by ${principalPattern("principal")}, beyond the same-user boundary${TAIL}`)],
];

/** `SID (DOMAIN\name)` when the name is known, the bare SID otherwise: the form the verifier's refusals quote a principal in. */
function label(sid: string, name: string | null): string {
	return name === null ? sid : `${sid} (${name})`;
}

/** A principal as the verifier carries it (`SID`, or `SID (name)` once a name was added) taken apart; `null` when it is not a SID. */
export function splitPrincipal(principal: string): { readonly sid: string; readonly name: string | null } | null {
	const matched = new RegExp(`^${principalPattern("p")}$`).exec(principal);
	return matched === null ? null : { sid: matched.groups!.pSid!, name: matched.groups!.pName ?? null };
}

function detailText(access: ForeignAccess): string {
	if (access.permissions === null) return "";
	const origin = access.inherited === null ? "" : `, ${access.inherited ? INHERITED_TEXT : DIRECT_TEXT}`;
	return `(${access.permissions}: ${accessLevel(access.permissions)}${origin})`;
}

/** The refusal sentence for these facts: the one wording the verifier, the warm-start check and {@link findForeignAccess} share. */
export function formatForeignAccess(access: ForeignAccess): string {
	const who = label(access.principal, access.principalName);
	const tail = access.current === null ? "" : `; this window runs as ${label(access.current, access.currentName)}`;
	switch (access.kind) {
		case "replace-folder":
			return `the component ${access.path} on the path to the store lets ${who} replace or re-permission it ${detailText(access)}${tail}`;
		case "read-store":
			return `the store path ${access.path} is readable by ${who}, beyond the same-user boundary${access.permissions === null ? "" : ` ${detailText(access)}`}${tail}`;
		case "own-store":
			return `the store path ${access.path} is owned by ${who}, beyond the same-user boundary${tail}`;
	}
}

/** A foreign-access refusal found inside a longer message, with where it sits. */
export interface FoundForeignAccess {
	readonly access: ForeignAccess;
	readonly index: number;
	readonly length: number;
}

/** Find the refusal {@link formatForeignAccess} wrote inside `raw` (the staging error wraps it in a sentence of its own); `null` when `raw` holds none. */
export function findForeignAccess(raw: string): FoundForeignAccess | null {
	for (const [kind, pattern] of PATTERNS) {
		const matched = pattern.exec(raw);
		const found = matched?.groups;
		if (matched === null || found === undefined) continue;
		return {
			index: matched.index,
			length: matched[0].length,
			access: {
				kind,
				path: found.path!,
				principal: found.principalSid!,
				principalName: found.principalName ?? null,
				permissions: found.mask === undefined ? null : Number(found.mask),
				inherited: found.origin === undefined ? null : found.origin === INHERITED_TEXT,
				current: found.currentSid ?? null,
				currentName: found.currentName ?? null,
			},
		};
	}
	return null;
}

/** Resolves SIDs to `DOMAIN\name`; the native module's lookup, injected. */
export type NameLookup = (sids: readonly string[]) => Promise<ReadonlyMap<string, string>>;

/**
 * `raw` with the names of the accounts its foreign-access refusal quotes, where it has none: the warm start reads access
 * synchronously and so quotes bare SIDs. A message without such a refusal, or whose names are all known, is returned as it is,
 * and so is one whose lookup fails: names are diagnostic only.
 */
export async function nameForeignAccess(raw: string, lookup: NameLookup): Promise<string> {
	const found = findForeignAccess(raw);
	if (found === null) return raw;
	const { access } = found;
	const wanted = [access.principalName === null ? access.principal : null, access.current !== null && access.currentName === null ? access.current : null]
		.filter((sid): sid is string => sid !== null);
	if (wanted.length === 0) return raw;
	try {
		const names = await lookup(wanted);
		const named: ForeignAccess = {
			...access,
			principalName: access.principalName ?? names.get(access.principal) ?? null,
			currentName: access.currentName ?? (access.current === null ? null : names.get(access.current) ?? null),
		};
		return raw.slice(0, found.index) + formatForeignAccess(named) + raw.slice(found.index + found.length);
	} catch {
		return raw;
	}
}

/** What the notification says about a foreign-access refusal: what happened, then what to do. */
export interface ForeignAccessSentences {
	readonly headline: string;
	readonly remedy: string;
}

/** The sentences of the notification, in plain words: which account, which folder, what it could do, and how to end it. */
export function describeForeignAccess(access: ForeignAccess, moreInfo: string): ForeignAccessSentences {
	const who = access.principalName ?? access.principal;
	const runsAs = access.currentName ?? access.current ?? "this account";
	const lead = "The native module (koffi.node) did not load:";
	const other = `another Windows account, ${who},`;
	const level = access.permissions === null ? null : accessLevel(access.permissions);
	const has = level === null ? "has access to" : level === "full control" ? "has full control of" : `has ${level} to`;
	const signedIn = "run VS Code as the account you are signed in to Windows with";
	const finish = `then choose Reload Window. ${moreInfo}`;
	const removeIt = access.inherited === true
		? "That access is inherited from a parent folder: remove it where it is set"
		: "Remove that account's access";
	switch (access.kind) {
		case "replace-folder":
			return {
				headline: `${lead} ${other} ${has} ${access.path}, so it could replace the module that runs as ${runsAs}.`,
				remedy: `${removeIt}${access.inherited === true ? "" : " to the folder"}, or ${signedIn}, ${finish}`,
			};
		case "read-store":
			return {
				headline: `${lead} ${other} ${has} ${access.path}, where the module that runs as ${runsAs} is kept.`,
				remedy: `${removeIt}, or ${signedIn}, ${finish}`,
			};
		case "own-store":
			return {
				headline: `${lead} ${access.path}, where the module that runs as ${runsAs} is kept, is owned by another Windows account, ${who}, which could change who may use it.`,
				remedy: `Run VS Code as that account, or have an administrator give the folder back to the account that runs VS Code, ${finish}`,
			};
	}
}

/** The facts "Copy diagnostics" adds for a foreign-access refusal, one per line. */
export function foreignAccessDiagnostics(access: ForeignAccess): readonly string[] {
	const named = (sid: string | null, name: string | null): string => (sid === null ? "not reported by the message" : label(sid, name));
	return [
		`Folder: ${access.path}`,
		`Other account: ${named(access.principal, access.principalName)}`,
		`Its access: ${access.kind === "own-store" ? "owner" : `${accessLevel(access.permissions!)} (mask ${access.permissions})`}`,
		`Entry: ${access.inherited === null ? (access.kind === "own-store" ? "not an access entry" : "origin not reported") : access.inherited ? INHERITED_TEXT : DIRECT_TEXT}`,
		`VS Code runs as: ${named(access.current, access.currentName)}`,
	];
}
