/**
 * Private, extension-owned storage mechanics shared by the features that keep
 * sensitive bytes outside the workspace.
 *
 * The policy comes from
 * [ADR-0007](../../docs/decisions/0007-native-file-evidence-and-guarded-restore.md)
 * (restricted Windows storage access inside
 * [ADR-0006](../../docs/decisions/0006-host-generated-key-peer-verified-pipe.md)'s
 * same-user trust boundary): before the first byte is written, the store must be
 * a real local directory outside the workspace, not a link or reparse point,
 * with access limited to the owning account plus SYSTEM and Administrators (or
 * an owner-only mode elsewhere), and a bounded write probe must read back. A
 * failed access rewrite leaves the caller's capture off rather than assumed
 * safe.
 *
 * This module owns only those mechanics: directory preparation, ACL reading,
 * the permitted-principal rule, the write probe and the restriction rewrite. It
 * knows nothing about what a feature stores, its schema, its consent records or
 * its disablement markers — callers keep their own naming, schema and policy and
 * describe their layout through {@link PrivateStorageLayout}.
 */

import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { windowsPowerShellEnvironment, windowsPowerShellExecutable } from "./windows-powershell.ts";

/** One bounded security-tool result; injected so tests never depend on machine ACLs. */
export interface PrivateStorageCommandResult {
	readonly ok: boolean;
	readonly stdout: string;
	readonly detail: string | null;
}

/**
 * Everything the verifier needs to know about one feature's private store.
 *
 * `root` is the directory the access rewrite applies to and one of the
 * directories the ACL listing is read from; `workspaceRoot` is the root the
 * store must sit outside of; the probe runs in `probeDirectory`.
 */
export interface PrivateStorageLayout {
	/** Absolute local feature root outside every workspace root. */
	readonly root: string;
	/**
	 * Absolute local workspace root the store must not be inside, when the store is
	 * workspace-bound at all. Absent means "not workspace-bound" — a store that is
	 * not scoped to a workspace, such as the extension's own staged runtime tree —
	 * and only the inside-the-workspace refusal is skipped; every other check stands.
	 */
	readonly workspaceRoot?: string;
	/** Directories to create and to hold to the permitted principals, deepest last. */
	readonly directories: readonly string[];
	/** Directories whose access listing must be limited to the permitted set. */
	readonly verifiedDirectories: readonly string[];
	/**
	 * Existing files whose own access listing must be limited to the permitted
	 * principals. A parent's rules do not override an explicit entry on a file, so a
	 * file written while the store was broader keeps whatever it was given. A path
	 * that does not exist yet is skipped: it holds nothing to protect, and a file
	 * created later inherits the directory's rules.
	 */
	readonly verifiedFiles?: readonly string[];
	/** Directory that must accept the write probe. */
	readonly probeDirectory: string;
	/** Fixed text the probe writes and reads back. */
	readonly probeText: string;
}

export interface PrivateStorageProbe {
	readonly platform?: NodeJS.Platform;
	/** Account allowed alongside SYSTEM and Administrators. Defaults to this process's user. */
	readonly currentUser?: string;
	/** Fully qualified `machine-or-domain\account`; defaults to reading `whoami`. */
	readonly currentAccount?: string;
	readonly runIcacls?: (directory: string) => Promise<PrivateStorageCommandResult>;
	/** Applies extra `icacls` arguments to a directory; defaults to running `icacls`. */
	readonly applyIcacls?: (directory: string, args: readonly string[]) => Promise<PrivateStorageCommandResult>;
	/** Reads the owner of every given path; defaults to {@link readStorageOwners}. */
	readonly readOwners?: (paths: readonly string[]) => Promise<PrivateStorageCommandResult>;
	/**
	 * Reads the mode `ls -ld` prints for one path, on POSIX; the mode carries the
	 * marker for an extended access control list. Defaults to `/bin/ls -ld`.
	 */
	readonly readPosixAcl?: (path: string) => Promise<PrivateStorageCommandResult>;
	/** POSIX owner this process is expected to be; defaults to `process.getuid()`. */
	readonly ownerUid?: number;
}

export interface PrivateStorageReadiness {
	readonly ready: boolean;
	/** Why capture must stay off; `null` only when `ready`. */
	readonly reason: string | null;
	/** Steps that passed, for the enablement record and diagnostics. */
	readonly evidence: readonly string[];
	/** Principals the store grants access to, as read from the ACL. */
	readonly permittedPrincipals: readonly string[];
}

export interface PrivateStorageRestriction {
	readonly restricted: boolean;
	readonly reason: string | null;
	/** The independent verification that ran after the rewrite; `null` if it never ran. */
	readonly readiness: PrivateStorageReadiness | null;
}

/** Absolute local path requirements shared by every private store namespace. */
export type LocalRootInspection =
	| { readonly ok: true; readonly root: string }
	| { readonly ok: false; readonly detail: string };

const DEVICE_PREFIX_RE = /^[\\/]{2}[.?][\\/]/;
const UNC_PREFIX_RE = /^[\\/]{2}/;

/**
 * Accept only an absolute, local path short enough for a bounded namespace.
 *
 * A UNC or device path is rejected rather than resolved: the access rules below
 * name an account on *this* machine, and a redirected root can be governed by
 * another host's ACL entirely.
 */
export function inspectLocalRoot(value: unknown): LocalRootInspection {
	if (typeof value !== "string" || value.length === 0) return { ok: false, detail: "missing" };
	if (UNC_PREFIX_RE.test(value) || DEVICE_PREFIX_RE.test(value)) {
		return { ok: false, detail: "a network or device path" };
	}
	if (!path.isAbsolute(value)) return { ok: false, detail: "not absolute" };
	const resolved = path.resolve(value);
	if (resolved.length > 240) return { ok: false, detail: "too long for a bounded namespace" };
	return { ok: true, root: resolved };
}

/** Whether `directory` is `root` itself or lies inside it. */
export function isInsideRoot(root: string, directory: string): boolean {
	const relative = path.relative(root, directory);
	return relative.length === 0 || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

const MAX_ICACLS_BYTES = 64 * 1024;
const MAX_WHOAMI_BYTES = 4096;
const MAX_OWNER_BYTES = 64 * 1024;
const MAX_LISTING_BYTES = 256 * 1024;
const ICACLS_TIMEOUT_MS = 10_000;
const WHOAMI_TIMEOUT_MS = 5000;
const OWNER_TIMEOUT_MS = 20_000;
const DIR_TIMEOUT_MS = 20_000;
const SETTLE_GRACE_MS = 250;

/** One bounded security-tool run. */
interface PrivateStorageToolRun {
	readonly command: string;
	readonly args: readonly string[];
	readonly timeoutMs: number;
	readonly maxBytes: number;
	/** The child's whole environment; this process's own when absent. */
	readonly env?: NodeJS.ProcessEnv;
}

/** Run one security tool and capture its output, bounded and without a shell. */
function runCommandDefault(run: PrivateStorageToolRun): Promise<PrivateStorageCommandResult> {
	const { promise, resolve } = Promise.withResolvers<PrivateStorageCommandResult>();
	const child = spawn(run.command, [...run.args], {
		windowsHide: true,
		...(run.env === undefined ? {} : { env: run.env }),
	});
	const chunks: Buffer[] = [];
	let length = 0;
	let settled = false;
	const finish = (result: PrivateStorageCommandResult): void => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		resolve(result);
	};
	const timer = setTimeout(() => {
		child.kill();
		setTimeout(
			() => finish({ ok: false, stdout: "", detail: `${run.command} did not answer in time` }),
			SETTLE_GRACE_MS,
		);
	}, run.timeoutMs);
	child.stdin.end();
	child.stdout.on("data", (chunk: Buffer) => {
		length += chunk.length;
		if (length > run.maxBytes) {
			child.kill();
			finish({ ok: false, stdout: "", detail: `${run.command} output exceeded the accepted size` });
			return;
		}
		chunks.push(chunk);
	});
	child.stderr.on("data", () => {});
	child.on("error", error =>
		finish({ ok: false, stdout: "", detail: `${run.command} could not start: ${error.name}` }),
	);
	child.on("close", code =>
		finish(
			code === 0
				? { ok: true, stdout: Buffer.concat(chunks).toString("utf8"), detail: null }
				: { ok: false, stdout: "", detail: `${run.command} exited with ${String(code)}` },
		),
	);
	return promise;
}

/**
 * Absolute path of a Windows security tool.
 *
 * A bare name is resolved through PATH, where developer toolchains (Git for
 * Windows' `usr/bin`, MSYS, Cygwin) ship same-named ports: their `whoami`
 * prints the account without its machine or domain, which the access rules
 * below cannot name. Only the system copy is trusted.
 */
function systemTool(name: string): string {
	const root = process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows";
	return path.join(root, "System32", name);
}

function runIcaclsDefault(directory: string): Promise<PrivateStorageCommandResult> {
	return runCommandDefault({
		command: systemTool("icacls.exe"),
		args: [directory],
		timeoutMs: ICACLS_TIMEOUT_MS,
		maxBytes: MAX_ICACLS_BYTES,
	});
}

function applyIcaclsDefault(
	directory: string,
	args: readonly string[],
): Promise<PrivateStorageCommandResult> {
	// A rewritten directory carries retained files that must keep their access.
	return runCommandDefault({
		command: systemTool("icacls.exe"),
		args: [directory, ...args],
		timeoutMs: ICACLS_TIMEOUT_MS * 12,
		maxBytes: MAX_ICACLS_BYTES,
	});
}

/** `machine-or-domain\account` for this process, as the system `whoami` reports it. */
async function readCurrentAccount(): Promise<string | null> {
	const result = await runCommandDefault({
		command: systemTool("whoami.exe"),
		args: [],
		timeoutMs: WHOAMI_TIMEOUT_MS,
		maxBytes: MAX_WHOAMI_BYTES,
	});
	if (!result.ok) return null;
	const account = result.stdout.trim();
	return /^[^\s\\"]{1,128}\\[^\s\\"]{1,128}$/.test(account) ? account : null;
}

/**
 * The owner of each path, as a Windows account name, from PowerShell's `Get-Acl`.
 *
 * One process answers for every path, and the paths travel in the child's
 * environment so no quoting rule can change them. This is the exact read: `.Owner`
 * returns the account name the system resolves for the owner SID, with no column to
 * overflow. A machine where a policy refuses to load the security module answers
 * nothing, which the caller then replaces with the listing read below.
 */
async function readOwnersByName(paths: readonly string[]): Promise<Map<string, string>> {
	const script = [
		"$paths = @($env:OMP_PRIVATE_STORAGE_PATHS | ConvertFrom-Json)",
		"foreach ($item in $paths) {",
		"\ttry { $owner = (Get-Acl -LiteralPath $item -ErrorAction Stop).Owner } catch { $owner = '?' }",
		"\tWrite-Output ($item + '|' + $owner)",
		"}",
	].join("\n");
	const reported = await runCommandDefault({
		command: windowsPowerShellExecutable(),
		args: ["-NoProfile", "-NonInteractive", "-Command", script],
		timeoutMs: OWNER_TIMEOUT_MS,
		maxBytes: MAX_OWNER_BYTES,
		env: windowsPowerShellEnvironment({ OMP_PRIVATE_STORAGE_PATHS: JSON.stringify(paths) }),
	});
	return reported.ok ? ownersFrom(reported.stdout, paths) : new Map();
}

/**
 * The owner of each path, from the owner `dir /q` prints before the entry's name.
 *
 * The listing is narrowed to the entry being asked about, so a directory holding a
 * hundred thousand entries costs no more than one holding two. `cmd.exe` and the
 * `dir` built into it load no module, which is why this read exists: a hardened image
 * can refuse to load the module `Get-Acl` lives in, and a store must still be usable
 * there. Its owner column is fixed width, so a long account name is printed without
 * the space before the entry name and is truncated — such a name is reported as
 * unreadable rather than guessed at, and the caller refuses that path. `dir` prints
 * an entry by its long name even when it was asked for by its 8.3 short name, so a
 * path spelled with one is listed by the long spelling of the same object.
 */
async function readOwnersByListing(paths: readonly string[]): Promise<Map<string, string>> {
	const owners = new Map<string, string>();
	for (const target of paths) {
		const listed = await longSpelling(target);
		const listing = await runCommandDefault({
			command: systemTool("cmd.exe"),
			args: ["/d", "/c", "dir", "/q", "/a", `${listed}*`],
			timeoutMs: DIR_TIMEOUT_MS,
			maxBytes: MAX_LISTING_BYTES,
		});
		if (!listing.ok) continue;
		const owner = ownerFromDirListing(listing.stdout, path.basename(listed));
		if (owner !== null) owners.set(target.toLowerCase(), owner);
	}
	return owners;
}

/**
 * The resolved spelling of `target` when it names the same object with nothing
 * redirected on the way (it differs only by 8.3 short names), and `target` itself
 * otherwise, so a link is never read in place of the path that was asked about.
 */
async function longSpelling(target: string): Promise<string> {
	const real = await fs.realpath(target).catch(() => null);
	return real !== null && (await spellsSameObject(path.resolve(target), real)) ? real : target;
}

/**
 * The owner of every path, exact where the system can answer and from the listing
 * where it cannot. A path neither read can prove is reported as `?`, which the caller
 * refuses on, so one unprovable component never hides the answers for the others.
 */
export async function readStorageOwners(paths: readonly string[]): Promise<PrivateStorageCommandResult> {
	const owners = new Map<string, string>();
	for (const read of [readOwnersByName, readOwnersByListing]) {
		const missing = paths.filter(target => !owners.has(target.toLowerCase()));
		if (missing.length === 0) break;
		for (const [target, owner] of await read(missing)) owners.set(target, owner);
	}
	const lines = paths.map(target => `${target}|${owners.get(target.toLowerCase()) ?? "?"}`);
	return { ok: true, stdout: `${lines.join("\r\n")}\r\n`, detail: null };
}

/**
 * The owner `dir /q` prints immediately before an entry's own name.
 *
 * The owner column is fixed width: when the account name overflows it, the name is
 * printed with no separating space and is cut short (`NT SERVICE\TrustedInsta` in
 * front of `Windows`). The entry name is therefore matched as the end of the last
 * token, and only a whole `qualifier\account` or SID is accepted — a truncated or
 * unrecognized owner is `null`, never a guess.
 */
function ownerFromDirListing(stdout: string, name: string): string | null {
	const wanted = name.toLowerCase();
	for (const rawLine of stdout.split(/\r?\n/)) {
		const tokens = rawLine.trim().split(/\s+/);
		if (tokens.length < 3) continue;
		const last = tokens[tokens.length - 1]!.toLowerCase();
		if (last !== wanted && !last.endsWith(wanted)) continue;
		const candidates =
			last === wanted
				? [tokens[tokens.length - 2]!]
				: [`${tokens[tokens.length - 2] ?? ""}${tokens[tokens.length - 1]!.slice(0, -name.length)}`];
		for (const candidate of candidates) {
			if (/^([^\s\\"]{1,128}\\[^\s\\"]{1,128}|\*?S-1-[0-9-]{2,})$/i.test(candidate)) return candidate;
		}
	}
	return null;
}

/** The mode `ls -ld` prints for one path, on POSIX, as the default ACL-marker read. */
function readPosixAclDefault(target: string): Promise<PrivateStorageCommandResult> {
	return runCommandDefault({
		command: "/bin/ls",
		args: ["-ld", target],
		timeoutMs: DIR_TIMEOUT_MS,
		maxBytes: MAX_LISTING_BYTES,
	});
}

/** What the mode field of a POSIX long listing says about an extended access list. */
export type PosixAccessMarker =
	| { readonly kind: "none" }
	| { readonly kind: "lsm-context-only" }
	| { readonly kind: "ambiguous"; readonly marker: string }
	| { readonly kind: "unreadable" };

/**
 * Classify the marker that follows the mode in a `ls -ld` listing.
 *
 * POSIX requires the mode field of a long listing to be followed by a mark for an
 * alternate access method, and each system prints its own set:
 *   • GNU coreutils prints `.` only when the only access state is an LSM security
 *     context (`ACL_T_LSM_CONTEXT_ONLY`), `+` whenever an access control list is
 *     present (`ACL_T_YES`) and `?` when the list could not be read — so `.` rules an
 *     access list out, while `+` and `?` refuse.
 *   • Apple's `ls` prints `@` when extended attributes exist and only *otherwise*
 *     prints `+` for an access control list, and `%` for a dataless file on top of
 *     both — so an `@`-only or `%`-only mode can hide an access list entirely.
 * Only a listing whose mode carries no marker, or `.` alone, is taken as proof that
 * no access list exists; every other marker is ambiguous and refuses, and so is a
 * listing with no readable mode line at all.
 */
export function posixAccessMarker(stdout: string): PosixAccessMarker {
	for (const rawLine of stdout.split(/\r?\n/)) {
		const mode = rawLine.trim().split(/\s+/)[0] ?? "";
		const parsed = /^[-dlbcps][-rwxsStT]{9}([^A-Za-z0-9]*)$/.exec(mode);
		if (parsed === null) continue;
		const marker = parsed[1] ?? "";
		if (marker.length === 0) return { kind: "none" };
		if (marker === ".") return { kind: "lsm-context-only" };
		return { kind: "ambiguous", marker };
	}
	return { kind: "unreadable" };
}

/** What one owner read reported for each path, keyed by lower-case path. */
function ownersFrom(stdout: string, paths: readonly string[]): Map<string, string> {
	const wanted = new Set(paths.map(target => target.toLowerCase()));
	const owners = new Map<string, string>();
	for (const rawLine of stdout.split(/\r?\n/)) {
		const separator = rawLine.indexOf("|");
		if (separator <= 0) continue;
		const target = rawLine.slice(0, separator).trim().toLowerCase();
		const owner = rawLine.slice(separator + 1).trim();
		if (!wanted.has(target) || owner.length === 0 || owner === "?") continue;
		owners.set(target, owner);
	}
	return owners;
}

/** One access entry as `icacls` prints it: a principal and the rights it holds. */
export interface PrivateStorageAclEntry {
	readonly principal: string;
	/** The rights between the inheritance flags, e.g. `F`, `RX`, `M,DC`. */
	readonly permissions: string;
	/** A deny entry, which restricts what it names instead of granting it access. */
	readonly denied: boolean;
}

export interface PrivateStorageAclReport {
	/** Principals an entry of this listing *grants* something to. */
	readonly principals: readonly string[];
	readonly entries: readonly PrivateStorageAclEntry[];
	readonly parsed: boolean;
}

/** Groups `icacls` prints that carry inheritance or ACE type rather than a right. */
const ACL_NON_PERMISSION_GROUPS: Record<string, true> = {
	OI: true,
	CI: true,
	IO: true,
	I: true,
	NP: true,
	ID: true,
	DENY: true,
};

/**
 * An integrity-level entry, which `icacls` prints in the same listing as the access
 * entries. It labels the object's mandatory level and grants nobody anything: it
 * restricts what may be written (for instance `Mandatory Label\High Mandatory
 * Level:(NW)` stops a lower-integrity process from writing up). It is recognised two
 * ways, because either can appear alone: by the principal it names — `Mandatory
 * Label\…` or the integrity SIDs `S-1-16-…` — and by the rights it carries, which are
 * only the integrity tokens below, so a system that prints the label in another
 * language is still classified rather than read as a grant. Anything that is neither
 * a label nor an access entry keeps its principal and rights and is refused by the
 * rules below, never ignored.
 */
const MANDATORY_LABEL_ENTRY_RE = /^(?:mandatory label|s-1-16-)/i;

/** Rights only an integrity label carries: no write up, no read up, no execute up. */
const INTEGRITY_LABEL_TOKENS: Record<string, true> = { NW: true, NR: true, NX: true };

/** A label, or `null` when these groups describe an access entry. */
function labelEntryPrincipal(principal: string, accessGroups: readonly string[]): string | null {
	if (MANDATORY_LABEL_ENTRY_RE.test(principal)) return principal;
	if (accessGroups.length === 0) return null;
	const tokens = accessGroups.flatMap(group => group.split(",")).map(token => token.trim().toUpperCase());
	if (tokens.length === 0) return null;
	return tokens.every(token => Object.hasOwn(INTEGRITY_LABEL_TOKENS, token)) ? principal : null;
}

/**
 * Read the access entries out of `icacls <target>` output.
 *
 * Both of `icacls`'s common layouts put the path, and in the friendly form the
 * owner, on the same line as the first access entry, so that prefix is stripped
 * before the principal is taken. A listing with no readable access entry at all is
 * `parsed: false`, which the caller treats as unverified. Each entry keeps the rights
 * it holds beside its principal, so a caller can tell a principal that may only read
 * from one that may rewrite or remove what the entry sits on, and whether the entry
 * grants access at all; an integrity label grants none and is not an entry.
 */
export function parseIcaclsAcl(stdout: string, directory: string): PrivateStorageAclReport {
	const entries: PrivateStorageAclEntry[] = [];
	const directoryLower = directory.toLowerCase();
	for (const rawLine of stdout.split(/\r?\n/)) {
		let line = rawLine.trim();
		if (line.length === 0) continue;
		if (/^(successfully processed|failed processing)/i.test(line)) continue;
		if (line.toLowerCase().startsWith(directoryLower)) {
			line = line.slice(directory.length).trim();
		} else {
			const leading = /^(?:[A-Za-z]:[\\/]\S*|\\\\\S*)\s+/.exec(line);
			if (leading) line = line.slice(leading[0].length).trim();
		}
		const separator = line.indexOf(":(");
		if (separator <= 0 || !line.endsWith(")")) continue;
		const principal = line.slice(0, separator).trim();
		if (principal.length === 0 || principal.length > 260) continue;
		const groups = [...line.slice(separator + 1).matchAll(/\(([^()]*)\)/g)].map(match => match[1]!.trim());
		const accessGroups = groups.filter(
			group => group.length > 0 && !Object.hasOwn(ACL_NON_PERMISSION_GROUPS, group.toUpperCase()),
		);
		if (labelEntryPrincipal(principal, accessGroups) !== null) continue;
		entries.push({
			principal,
			permissions: accessGroups.join(","),
			denied: groups.some(group => group.toUpperCase() === "DENY"),
		});
	}
	return {
		principals: entries.filter(entry => !entry.denied).map(entry => entry.principal),
		entries,
		parsed: entries.length > 0,
	};
}

/**
 * Rights that let their holder replace or re-permission the object they sit on.
 *
 * Removing or renaming a component needs `D` (or `DC`, the right its parent grants
 * over it); re-permissioning it needs `WDAC` or `WO`; `F`, `GA` and `MA` contain all
 * of those and `M` contains `D`. The remaining write and create rights — `W`, `WD`,
 * `AD`, `WEA`, `WA`, `GW` — let another account write inside or beneath a component
 * without letting it put a different object in that component's place, and `M` on a
 * directory carries no `FILE_DELETE_CHILD` (its access mask is `0x1301BF`, which has
 * no `0x40` bit), so a shared top-level `Users` directory that grants `Users:(RX)`, or a parent that
 * grants create rights, stays acceptable while a component granting delete or
 * re-permission rights refuses. Every token this table does not name counts as
 * control, so an unreadable or newer right fails closed.
 */
const NON_REPLACEMENT_ACCESS_TOKENS: Record<string, true> = {
	N: true,
	R: true,
	RX: true,
	RD: true,
	REA: true,
	RA: true,
	RC: true,
	X: true,
	S: true,
	GR: true,
	GE: true,
	W: true,
	WD: true,
	AD: true,
	WEA: true,
	WA: true,
	GW: true,
};

export function permissionsPermitReplacement(permissions: string): boolean {
	const tokens = permissions
		.split(",")
		.map(token => token.trim().toUpperCase())
		.filter(token => token.length > 0);
	if (tokens.length === 0) return false;
	return tokens.some(token => !Object.hasOwn(NON_REPLACEMENT_ACCESS_TOKENS, token));
}

/**
 * The path components strictly below the filesystem volume root that `root` is
 * reached through, nearest first.
 *
 * The volume root itself is deliberately not in this list: it is the platform's own
 * trust anchor, it cannot be renamed or deleted, and no component beside it can be
 * replaced through it without a right this walk checks on the component itself. The
 * anchor is named in the readiness evidence so the boundary is stated rather than
 * implied, and every component between it and the store is verified.
 */
function ancestorComponents(root: string): readonly string[] {
	const components: string[] = [];
	let current = path.dirname(path.resolve(root));
	while (path.dirname(current) !== current) {
		if (!components.includes(current)) components.push(current);
		current = path.dirname(current);
	}
	return components;
}

/**
 * Why one POSIX path is not restricted to this account, or `null` when it is.
 *
 * A directory or file the store owns must be reachable by this account alone — the
 * same line the Windows rules draw, where any other principal at all refuses — and
 * must be owned by this account, because an owner can rewrite the permissions of
 * what it owns. A directory the store is merely reached through is held differently:
 * it may be shared and may grant read or execute access to anyone, but it must be
 * owned by this account or by the system root — an account that owns a path
 * component can replace it — and it may be writable beyond this account only when it
 * is the root's own sticky directory, where the sticky bit keeps every other account
 * from removing an entry it does not own (`/tmp` is exactly that).
 */
export function posixAccessProblem(input: {
	readonly target: string;
	readonly kind: "directory" | "file" | "carrier";
	readonly mode: number;
	readonly uid: number;
	readonly ownerUid: number | undefined;
}): string | null {
	const permissions = input.mode & 0o7777;
	if (input.kind === "carrier") {
		const ownedByThisAccount = input.ownerUid !== undefined && input.uid === input.ownerUid;
		const ownedByRoot = input.uid === 0;
		if (!ownedByThisAccount && !ownedByRoot) {
			return `the directory ${input.target} on the path to the store is owned by uid ${input.uid}, not by this account or the system root`;
		}
		if ((permissions & 0o022) !== 0 && !(ownedByRoot && (permissions & 0o1000) !== 0)) {
			return `the directory ${input.target} on the path to the store is writable beyond this account (mode ${permissions.toString(8)})`;
		}
		return null;
	}
	if ((permissions & 0o077) !== 0) {
		const exposed = (permissions & 0o022) !== 0 ? "writable" : "reachable";
		return `the store ${input.kind} ${input.target} is mode ${permissions.toString(8)}, ${exposed} beyond this account`;
	}
	if (input.ownerUid !== undefined && input.uid !== input.ownerUid) {
		return `the store path ${input.target} is owned by uid ${input.uid}, not by this process's user`;
	}
	return null;
}

/**
 * Well-known principals a private store may name: the account, SYSTEM and
 * Administrators, plus the owner-relative placeholders and the operating system's
 * own service owner.
 *
 * Every entry is one identity, named once by its account name and once by its SID,
 * because a listing may print either:
 *   • `S-1-5-18` SYSTEM, `S-1-5-32-544` Administrators — the same boundary ADR-0006
 *     already draws.
 *   • `S-1-3-0` CREATOR OWNER, `S-1-3-4` OWNER RIGHTS, `S-1-5-10` SELF — placeholders
 *     that resolve to the owner of the object, which is this account (or an owner
 *     this account trusts) for everything the store creates.
 *   • `S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464` TrustedInstaller
 *     — the service that owns and can re-permission every operating-system location,
 *     so it is part of the trust boundary rather than outside it.
 *
 * Anything else — `Everyone`, `Users`, `Authenticated Users`, `INTERACTIVE`, `S-1-5-3`
 * Batch (the token of any process run in a batch queue, not an administrator), an
 * unresolved or foreign SID — means the store is reachable beyond the same-user trust
 * boundary, so a store that names it, or is owned by it, is refused.
 */
const PERMITTED_ACL_PRINCIPALS: Record<string, true> = {
	"owner rights": true,
	"s-1-3-4": true,
	"creator owner": true,
	"s-1-3-0": true,
	// SELF: the object's own principal, which for this store is the owner above.
	self: true,
	"s-1-5-10": true,
	"nt authority\\system": true,
	// `dir /q`, the owner read on a machine that cannot load the security module,
	// prints this well-known authority without its `NT ` part (observed in a real
	// listing of a volume's `Users` directory). Only that observed spelling is added —
	// an arbitrary `DOMAIN\system` is not — and `icacls` and `Get-Acl` print the full
	// form above.
	"authority\\system": true,
	system: true,
	"s-1-5-18": true,
	"builtin\\administrators": true,
	administrators: true,
	"s-1-5-32-544": true,
	"nt service\\trustedinstaller": true,
	"s-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464": true,
};

/** Split `machine-or-domain\name` into its qualifier and its account name. */
function splitAccountName(value: string): { readonly qualifier: string | null; readonly name: string } {
	const separator = value.lastIndexOf("\\");
	if (separator <= 0) return { qualifier: null, name: value };
	return { qualifier: value.slice(0, separator), name: value.slice(separator + 1) };
}

/**
 * Is one listed principal the store's owner, SYSTEM or Administrators?
 *
 * The account is matched as a Windows identity, not as a name: a listed
 * `DOMAIN\name` is this account only when the qualifier is the one this process
 * was told about (or this machine's own name, when only a bare account name is
 * known), so an account of another domain that happens to share the short name is
 * not accepted as this one. Callers should pass the qualified `whoami` account,
 * which is what {@link verifyPrivateStorage} resolves for them.
 */
export function isPermittedAclPrincipal(principal: string, currentUser: string): boolean {
	const normalized = principal.trim().toLowerCase().replace(/^\*/, "");
	if (normalized.length === 0) return false;
	if (Object.hasOwn(PERMITTED_ACL_PRINCIPALS, normalized)) return true;
	const account = splitAccountName(currentUser.trim().toLowerCase());
	if (account.name.length === 0) return false;
	const listed = splitAccountName(normalized);
	if (listed.name !== account.name) return false;
	if (listed.qualifier === null) return true;
	if (account.qualifier !== null) return listed.qualifier === account.qualifier;
	return listed.qualifier === os.hostname().trim().toLowerCase();
}

export function describeStorageError(error: unknown): string {
	if (typeof error === "object" && error !== null) {
		const code = (error as { code?: unknown }).code;
		if (typeof code === "string") return code;
	}
	return error instanceof Error ? error.name : "unknown error";
}

async function ensureDirectories(layout: PrivateStorageLayout): Promise<void> {
	for (const directory of layout.directories) {
		await fs.mkdir(directory, { recursive: true, mode: 0o700 });
	}
}

/** The name of the account that runs this extension host, as this process sees it. */
function currentUserName(): string {
	try {
		return os.userInfo().username;
	} catch {
		return "";
	}
}

/** The directories the access rewrite applies to, parents first and each named once. */
function restrictedDirectories(layout: PrivateStorageLayout): readonly string[] {
	const directories: string[] = [];
	for (const directory of [layout.root, ...layout.directories]) {
		if (!directories.includes(directory)) directories.push(directory);
	}
	return directories;
}

/** Is every principal one directory's listing names one this account trusts? */
async function isLimitedToOwner(input: {
	readonly directory: string;
	readonly runIcacls: (directory: string) => Promise<PrivateStorageCommandResult>;
	readonly currentUser: string;
}): Promise<boolean> {
	const result = await input.runIcacls(input.directory);
	if (!result.ok) return false;
	const acl = parseIcaclsAcl(result.stdout, input.directory);
	return acl.parsed && acl.principals.every(principal => isPermittedAclPrincipal(principal, input.currentUser));
}

/**
 * Why a path cannot be trusted as a plain object of the expected kind, or `null`
 * when it can.
 *
 * A symlink and a directory junction both report as symbolic links, and a path
 * underneath either one is not the object the store named: the access rules read
 * from it would describe a different directory. Resolving the path catches a
 * redirection anywhere along it, on the platforms where that is how a path is
 * replaced. A resolved spelling that differs only by Windows 8.3 short names (a
 * temporary directory under `C:\Users\RUNNER~1`, say) is not a redirection, and
 * {@link spellsSameObject} proves that component by component.
 */
async function unplainPath(target: string, kind: "directory" | "file", resolveLinks: boolean): Promise<string | null> {
	const stats = await fs.lstat(target).catch(() => null);
	if (stats === null) return `the store ${kind} ${target} does not exist`;
	if (stats.isSymbolicLink()) return `the store ${kind} ${target} is a link or reparse point`;
	if (kind === "directory" ? !stats.isDirectory() : !stats.isFile()) {
		return `the store ${kind} ${target} is not a plain ${kind}`;
	}
	if (!resolveLinks) return null;
	const real = await fs.realpath(target).catch(() => null);
	if (real === null) return `the store ${kind} ${target} could not be resolved`;
	if (!(await spellsSameObject(path.resolve(target), real))) {
		return `the store ${kind} ${target} is reached through a link or reparse point`;
	}
	return null;
}

/**
 * Does `spelled` name the object at `real` with nothing redirected on the way?
 *
 * Both must have the same volume root and the same number of components. Where a
 * component's spelling differs from the resolved one (an 8.3 short name), the
 * spelled prefix must itself not be a link or reparse point and must be the very
 * object at the resolved prefix: the same file ID on the same volume. A junction
 * or symlink fails the first test; a redirection to another directory fails the
 * second. Every earlier prefix was proven the same object, so an identically
 * spelled component names the same entry in the same directory.
 */
async function spellsSameObject(spelled: string, real: string): Promise<boolean> {
	if (spelled.toLowerCase() === real.toLowerCase()) return true;
	const spelledRoot = path.parse(spelled).root, realRoot = path.parse(real).root;
	if (spelledRoot.toLowerCase() !== realRoot.toLowerCase()) return false;
	const spelledParts = spelled.slice(spelledRoot.length).split(path.sep).filter(part => part.length > 0);
	const realParts = real.slice(realRoot.length).split(path.sep).filter(part => part.length > 0);
	if (spelledParts.length !== realParts.length) return false;
	let spelledPrefix = spelledRoot, realPrefix = realRoot;
	for (let index = 0; index < spelledParts.length; index++) {
		spelledPrefix = path.join(spelledPrefix, spelledParts[index]!);
		realPrefix = path.join(realPrefix, realParts[index]!);
		if (spelledParts[index]!.toLowerCase() === realParts[index]!.toLowerCase()) continue;
		const [alias, resolved] = await Promise.all([
			fs.lstat(spelledPrefix, { bigint: true }).catch(() => null),
			fs.lstat(realPrefix, { bigint: true }).catch(() => null),
		]);
		if (alias === null || resolved === null || alias.isSymbolicLink()) return false;
		if (alias.ino !== resolved.ino || alias.dev !== resolved.dev) return false;
	}
	return true;
}

/**
 * Prove a private store is usable before a single byte is captured: a real local
 * directory outside the workspace, not a link or reparse point anywhere on the way
 * to it, owned by this account (plus SYSTEM and Administrators) and with an access
 * listing limited to them on Windows, or an owner-only mode elsewhere, and a write
 * probe that reads back.
 *
 * Every path the store will trust is read, not only the directory it sits in: the
 * directories it owns, the directories a listing is taken from, the files it hands
 * out and every component between the store and the filesystem volume root. A file
 * keeps whatever explicit entries it was given, so a parent's rules are never taken
 * as proof for a file; a component the store is reached through may grant another
 * principal read, execute or create rights, but never the right to replace or
 * re-permission the object in that component's place. The volume root itself is the
 * platform's trust anchor: it cannot be renamed or deleted, and it is named in the
 * evidence instead of being held to rules this extension is not responsible for.
 * On POSIX the mode bits count only while no extended access control list exists:
 * where one does it can grant access the mode does not show, so the marker that
 * follows the mode is classified — nothing, or GNU coreutils' context-only `.`, is
 * proof; an access-list `+`, an attribute `@` (which Apple prints instead of `+`), a
 * dataless `%`, an unreadable `?` or any other marker refuses, and so does a
 * listing whose mode cannot be read at all.
 */
export async function verifyPrivateStorage(input: {
	readonly layout: PrivateStorageLayout;
	readonly probe?: PrivateStorageProbe;
}): Promise<PrivateStorageReadiness> {
	const layout = input.layout;
	const platform = input.probe?.platform ?? process.platform;
	const evidence: string[] = [];
	const refuse = (reason: string): PrivateStorageReadiness => ({
		ready: false,
		reason,
		evidence,
		permittedPrincipals: [],
	});

	if (layout.workspaceRoot !== undefined && isInsideRoot(layout.workspaceRoot, layout.root)) {
		return refuse("the store sits inside the workspace it records");
	}
	evidence.push(
		layout.workspaceRoot === undefined ? "store is not bound to a workspace" : "store is outside the workspace",
	);

	try {
		const existing = await fs.lstat(layout.root).catch(() => null);
		if (existing !== null && (existing.isSymbolicLink() || !existing.isDirectory())) {
			return refuse(`the store root ${layout.root} is not a plain directory`);
		}
		await ensureDirectories(layout);
	} catch (error) {
		return refuse(`the store could not be created (${describeStorageError(error)})`);
	}

	const carriers = ancestorComponents(layout.root);
	for (const directory of [layout.root, ...layout.directories, ...layout.verifiedDirectories, ...carriers]) {
		const problem = await unplainPath(directory, "directory", platform === "win32");
		if (problem !== null) return refuse(problem);
	}
	const files: string[] = [];
	for (const file of layout.verifiedFiles ?? []) {
		// A file that is not there yet holds nothing to protect: whatever is written at
		// that path later inherits the rules of the directory it lands in.
		if ((await fs.lstat(file).catch(() => null)) === null) continue;
		const problem = await unplainPath(file, "file", platform === "win32");
		if (problem !== null) return refuse(problem);
		files.push(file);
	}
	evidence.push("the store and every path it is reached through is a plain, non-redirected path");

	let currentUser = input.probe?.currentUser ?? "";
	if (currentUser.length === 0) currentUser = currentUserName();
	const permittedPrincipals: string[] = [];
	if (platform === "win32") {
		const runIcacls = input.probe?.runIcacls ?? runIcaclsDefault;
		// The identity is the qualified account whenever one can be read: a bare name
		// cannot tell this machine's account from another domain's account of the same
		// name, and a listing that named the other one must not read as proof.
		let identity = input.probe?.currentAccount ?? "";
		if (identity.length === 0) identity = currentUser;
		if (!identity.includes("\\")) identity = (await readCurrentAccount()) ?? identity;

		const storePaths = [...layout.directories, ...layout.verifiedDirectories, ...files];
		for (const target of storePaths) {
			const result = await runIcacls(target);
			if (!result.ok) {
				return refuse(`the store access of ${target} could not be verified (${result.detail ?? "icacls failed"})`);
			}
			const acl = parseIcaclsAcl(result.stdout, target);
			if (!acl.parsed) return refuse(`the store access listing of ${target} could not be read`);
			for (const principal of acl.principals) {
				if (!isPermittedAclPrincipal(principal, identity)) {
					return refuse(`the store path ${target} is readable by ${principal}, beyond the same-user boundary`);
				}
				if (!permittedPrincipals.includes(principal)) permittedPrincipals.push(principal);
			}
		}
		for (const target of carriers) {
			const result = await runIcacls(target);
			if (!result.ok) {
				return refuse(`the component ${target} on the path to the store could not be verified (${result.detail ?? "icacls failed"})`);
			}
			const acl = parseIcaclsAcl(result.stdout, target);
			if (!acl.parsed) return refuse(`the access listing of ${target} on the path to the store could not be read`);
			for (const entry of acl.entries) {
				if (entry.denied || isPermittedAclPrincipal(entry.principal, identity)) continue;
				if (!permissionsPermitReplacement(entry.permissions)) continue;
				return refuse(
					`the component ${target} on the path to the store lets ${entry.principal} replace or re-permission it (${entry.permissions})`,
				);
			}
		}
		// One owner read covers every path. An owner outside the trusted set can rewrite
		// the access rules of what it owns, so an owner read or compared by guesswork
		// refuses instead.
		const owned = [...new Set([...storePaths, ...carriers])];
		const owners = await (input.probe?.readOwners ?? readStorageOwners)(owned);
		if (!owners.ok) {
			return refuse(`the store owner could not be read (${owners.detail ?? "the owner tool failed"})`);
		}
		const ownerByPath = ownersFrom(owners.stdout, owned);
		for (const target of owned) {
			const owner = ownerByPath.get(target.toLowerCase());
			if (owner === undefined) return refuse(`the owner of ${target} could not be read`);
			if (!isPermittedAclPrincipal(owner, identity)) {
				return refuse(`the store path ${target} is owned by ${owner}, beyond the same-user boundary`);
			}
		}
		evidence.push("access is limited to the owner, SYSTEM and Administrators");
		evidence.push("every store path is owned by the owner, SYSTEM or Administrators");
		evidence.push(
			`every component between the store and ${path.parse(layout.root).root} is owned by a trusted principal and lets no other account replace or re-permission it, and ${path.parse(layout.root).root} is the platform trust anchor`,
		);
	} else {
		const ownerUid = input.probe?.ownerUid ?? process.getuid?.();
		const checked: ReadonlyArray<readonly [string, "directory" | "file" | "carrier"]> = [
			...[layout.root, ...layout.directories, ...layout.verifiedDirectories, layout.probeDirectory].map(
				target => [target, "directory"] as const,
			),
			...files.map(target => [target, "file"] as const),
			...carriers.map(target => [target, "carrier"] as const),
		];
		for (const [target, kind] of checked) {
			const stats = await fs.lstat(target).catch(() => null);
			if (stats === null) return refuse(`the store ${kind} ${target} does not exist`);
			const problem = posixAccessProblem({ target, kind, mode: stats.mode, uid: stats.uid, ownerUid });
			if (problem !== null) return refuse(problem);
		}
		// The mode bits are the whole story only while no extended access list exists:
		// where one does, it can grant another account access the mode does not show, so
		// the marker for one is classified and anything ambiguous refuses.
		const readPosixAcl = input.probe?.readPosixAcl ?? readPosixAclDefault;
		for (const [target] of checked) {
			const listing = await readPosixAcl(target);
			if (!listing.ok) {
				return refuse(
					`the extended access list of ${target} could not be read (${listing.detail ?? "the platform listing failed"})`,
				);
			}
			const marker = posixAccessMarker(listing.stdout);
			if (marker.kind === "unreadable") return refuse(`the extended access list of ${target} could not be read`);
			if (marker.kind === "ambiguous") {
				return refuse(
					`the store path ${target} shows the access marker '${marker.marker}', which can stand for an extended access control list, so the mode alone does not prove access is limited to this account`,
				);
			}
		}
		evidence.push("access is limited to the owning user by an owner-only mode");
		evidence.push(
			"no path the store is reached through shows an access marker that could stand for an extended access control list",
		);
		evidence.push(
			`every component between the store and ${path.parse(layout.root).root} is owned by this account or the system root and lets no other account replace what it holds, and ${path.parse(layout.root).root} is the platform trust anchor`,
		);
	}

	const probeFile = path.join(layout.probeDirectory, `.probe-${randomUUID()}`);
	try {
		const handle = await fs.open(probeFile, "wx", 0o600);
		try {
			await handle.writeFile(Buffer.from(layout.probeText, "utf8"));
			await handle.sync();
		} finally {
			await handle.close();
		}
		const written = await fs.readFile(probeFile);
		if (written.toString("utf8") !== layout.probeText) return refuse("the store write probe did not read back");
		evidence.push("the store accepted and returned a bounded write probe");
	} catch (error) {
		return refuse(`the store write probe failed (${describeStorageError(error)})`);
	} finally {
		await fs.rm(probeFile, { force: true }).catch(() => {});
	}

	return { ready: true, reason: null, evidence, permittedPrincipals };
}

/**
 * The access rules a private store's directories need: no inherited entries, and
 * an inheritable grant to the owning account, SYSTEM and Administrators only.
 *
 * Deliberately not recursive. `/T` rewrites the entries of every *file* it
 * reaches, and the inheritable `(OI)(CI)` grant a directory needs leaves a file
 * with no access entry at all — a retained blob, record or segment would become
 * unreadable and undeletable. A directory rewritten this way passes the grant on
 * to everything created inside it afterwards, which is why the rules are
 * established on the directories, before the first byte is written.
 */
function ownerOnlyGrant(account: string): readonly string[] {
	return [
		"/inheritance:r",
		"/grant:r",
		`${account}:(OI)(CI)(F)`,
		"*S-1-5-18:(OI)(CI)(F)",
		"*S-1-5-32-544:(OI)(CI)(F)",
		"/Q",
	];
}

/**
 * Establish the Windows access rules a private store requires, then verify them.
 *
 * ADR-0007 requires restricted storage access to exist *before* the first byte,
 * and an extension-owned directory is the one place the extension is entitled to
 * set its own rules: inherited entries (a shared `%TEMP%`, a redirected profile)
 * are removed, and only the owning account, SYSTEM and Administrators are
 * granted. Every directory the store owns is rewritten from itself, never as a
 * recursive walk: a file that is already there keeps the access it reaches
 * through the directory that holds it, and a file written afterwards inherits
 * the same rules. The rewrite is followed by an independent
 * {@link verifyPrivateStorage} pass, so a failed or partial rewrite leaves
 * capture off rather than assumed safe. This is not a per-event operation.
 */
export async function restrictPrivateStorage(input: {
	readonly layout: PrivateStorageLayout;
	readonly probe?: PrivateStorageProbe;
}): Promise<PrivateStorageRestriction> {
	const layout = input.layout;
	const platform = input.probe?.platform ?? process.platform;
	if (platform !== "win32") {
		const readiness = await verifyPrivateStorage({ layout, ...(input.probe ? { probe: input.probe } : {}) });
		return {
			restricted: readiness.ready,
			reason: readiness.ready ? null : readiness.reason,
			readiness,
		};
	}
	try {
		await ensureDirectories(layout);
	} catch (error) {
		return { restricted: false, reason: `the store could not be created (${describeStorageError(error)})`, readiness: null };
	}
	const account = input.probe?.currentAccount ?? (await readCurrentAccount());
	if (account === null || account.trim().length === 0) {
		return {
			restricted: false,
			reason: "the owning account could not be resolved, so the access rules were left untouched",
			readiness: null,
		};
	}
	const runIcacls = input.probe?.runIcacls ?? runIcaclsDefault;
	const applyIcacls = input.probe?.applyIcacls ?? applyIcaclsDefault;
	// The pre-check uses the same exact identity the verification will use, so a
	// directory only another domain's same-named account can reach is rewritten.
	const identity = input.probe?.currentAccount ?? account;
	for (const directory of restrictedDirectories(layout)) {
		// A link or reparse point is never rewritten: `icacls` would apply the rules to
		// whatever it reaches, which is not this store. Verification refuses it next.
		const stats = await fs.lstat(directory).catch(() => null);
		if (stats === null || stats.isSymbolicLink() || !stats.isDirectory()) continue;
		// A directory that is already limited to this account, SYSTEM and
		// Administrators is left exactly as it is; the ones that are not are
		// rewritten from themselves, one at a time, never as a recursive walk.
		if (await isLimitedToOwner({ directory, runIcacls, currentUser: identity })) continue;
		const applied = await applyIcacls(directory, ownerOnlyGrant(account));
		if (!applied.ok) {
			return {
				restricted: false,
				reason: `the store access could not be restricted (${applied.detail ?? "icacls failed"})`,
				readiness: null,
			};
		}
	}
	const readiness = await verifyPrivateStorage({ layout, ...(input.probe ? { probe: input.probe } : {}) });
	return {
		restricted: readiness.ready,
		reason: readiness.ready ? null : readiness.reason,
		readiness,
	};
}
