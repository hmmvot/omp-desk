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
	/** SID of the account allowed alongside the trusted system principals. */
	readonly currentSid?: string;
	/** Reads SID-based access entries as JSON; defaults to the module-free .NET reader. */
	readonly readAcl?: (directory: string) => Promise<PrivateStorageCommandResult>;
	/** Applies extra `icacls` arguments to a directory; defaults to running `icacls`. */
	readonly applyIcacls?: (directory: string, args: readonly string[]) => Promise<PrivateStorageCommandResult>;
	/** Reads owners as SIDs, with their resolved names for diagnostics when available. */
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
const MAX_OWNER_BYTES = 64 * 1024;
const MAX_LISTING_BYTES = 256 * 1024;
const ICACLS_TIMEOUT_MS = 10_000;
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

/** Explicit UTF-8 also preserves non-ASCII paths and optional diagnostic account names. */
const WINDOWS_SECURITY_SCRIPT = [
	"$ErrorActionPreference = 'Stop'",
	"[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)",
	"function Principal($sid) {",
	"  $name = $null",
	"  try { $name = $sid.Translate([System.Security.Principal.NTAccount]).Value } catch {}",
	"  if ($null -eq $name) { return $sid.Value }",
	"  return ($sid.Value + ' (' + $name + ')')",
	"}",
	"function Security($item) {",
	"  if ([System.IO.Directory]::Exists($item)) { return [System.IO.Directory]::GetAccessControl($item) }",
	"  return [System.IO.File]::GetAccessControl($item)",
	"}",
].join("\n");

function runSecurityScript(script: string, paths: readonly string[] = []): Promise<PrivateStorageCommandResult> {
	return runCommandDefault({
		command: windowsPowerShellExecutable(),
		args: ["-NoProfile", "-NonInteractive", "-Command", `${WINDOWS_SECURITY_SCRIPT}\n${script}`],
		timeoutMs: OWNER_TIMEOUT_MS,
		maxBytes: MAX_OWNER_BYTES,
		env: windowsPowerShellEnvironment({ OMP_PRIVATE_STORAGE_PATHS: JSON.stringify(paths) }),
	});
}

/** One process reads every requested ACL; failed individual reads remain unverified. */
export async function readStorageAcls(paths: readonly string[]): Promise<Map<string, PrivateStorageCommandResult>> {
	const result = await runSecurityScript([
		"$paths = $env:OMP_PRIVATE_STORAGE_PATHS | ConvertFrom-Json",
		"$reports = @(foreach ($item in $paths) {",
		"  $entries = $null",
		"  try {",
		"    $acl = Security $item",
		"    $entries = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object {",
		"      @{ principal = (Principal $_.IdentityReference); permissions = [int64]$_.FileSystemRights; denied = ($_.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Deny) }",
		"    })",
		"  } catch {}",
		"  @{ path = $item; entries = $entries }",
		"})",
		"ConvertTo-Json -Depth 6 -Compress -InputObject $reports",
	].join("\n"), paths);
	const reports = new Map<string, PrivateStorageCommandResult>();
	if (!result.ok) {
		for (const target of paths) reports.set(target.toLowerCase(), result);
		return reports;
	}
	try {
		const parsed: unknown = JSON.parse(result.stdout);
		if (!Array.isArray(parsed)) return reports;
		for (const report of parsed) {
			if (typeof report?.path !== "string" || !paths.includes(report.path)) continue;
			const key = report.path.toLowerCase();
			if (reports.has(key)) return new Map();
			reports.set(key, {
				ok: report.entries !== null,
				stdout: JSON.stringify(report.entries) ?? "",
				detail: report.entries === null ? "the SID-based security API failed" : null,
			});
		}
	} catch {}
	return reports;
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

/** The current token's SID, never an account name or a console-tool spelling. */
async function readCurrentSid(): Promise<string | null> {
	const result = await runSecurityScript("[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value");
	const sid = result.stdout.trim();
	return result.ok && isSid(sid) ? sid : null;
}

/**
 * Direct .NET security APIs need no Get-Acl module. If policy blocks these too,
 * refuse rather than guess from a truncated, localized dir /q owner column.
 */
export async function readStorageOwners(paths: readonly string[]): Promise<PrivateStorageCommandResult> {
	return runSecurityScript([
		"$paths = $env:OMP_PRIVATE_STORAGE_PATHS | ConvertFrom-Json",
		"foreach ($item in $paths) {",
		"  try { $owner = Principal ((Security $item).GetOwner([System.Security.Principal.SecurityIdentifier])) } catch { $owner = '?' }",
		"  [Console]::WriteLine($item + '|' + $owner)",
		"}",
	].join("\n"), paths);
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

/** One .NET access rule: SID and optional display name, numeric mask and ACE type. */
export interface PrivateStorageAclEntry {
	readonly principal: string;
	readonly permissions: number;
	readonly denied: boolean;
}

export interface PrivateStorageAclReport {
	readonly principals: readonly string[];
	readonly entries: readonly PrivateStorageAclEntry[];
	readonly parsed: boolean;
}

/** Read only the explicit SID-based JSON protocol; malformed rules fail closed. */
export function parseWindowsAcl(stdout: string): PrivateStorageAclReport {
	const unreadable: PrivateStorageAclReport = { principals: [], entries: [], parsed: false };
	try {
		const entries: unknown = JSON.parse(stdout);
		if (!Array.isArray(entries) || entries.length === 0) return unreadable;
		for (const entry of entries) {
			if (typeof entry !== "object" || entry === null ||
				typeof entry.principal !== "string" || principalSid(entry.principal) === null ||
				!Number.isSafeInteger(entry.permissions) || entry.permissions < -2147483648 || entry.permissions > 4294967295 ||
				typeof entry.denied !== "boolean") return unreadable;
		}
		return { entries, principals: entries.filter(entry => !entry.denied).map(entry => entry.principal), parsed: true };
	} catch {
		return unreadable;
	}
}

/**
 * Permit read/execute/synchronize, data/create/attribute writes and generic R/W/X.
 * Delete (including delete-child), write-DACL, write-owner, generic-all, maximum
 * access and any unknown mask bit can replace or re-permission and fail closed.
 */
export function permissionsPermitReplacement(permissions: number): boolean {
	return ((permissions >>> 0) & ~0xE01201BF) !== 0;
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
 * Numeric identities inside ADR-0006's boundary. Owner-relative placeholders are
 * trusted alongside the independently verified owner; names are diagnostic only.
 */
const PERMITTED_ACL_SIDS: Record<string, true> = {
	"S-1-3-4": true, // OWNER RIGHTS
	"S-1-3-0": true, // CREATOR OWNER
	"S-1-5-10": true, // SELF
	"S-1-5-18": true, // SYSTEM
	"S-1-5-32-544": true, // Administrators
	"S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464": true, // TrustedInstaller
};

function isSid(value: string): boolean {
	return /^S-1-(?:\d+-){1,14}\d+$/.test(value);
}

/** Strip only the optional diagnostic name emitted by our SID reader. */
function principalSid(principal: string): string | null {
	const matched = /^(S-1-(?:\d+-){1,14}\d+)(?: \([^\r\n]*\))?$/.exec(principal);
	return matched?.[1] ?? null;
}

export function isPermittedAclPrincipal(principal: string, currentSid: string): boolean {
	const sid = principalSid(principal);
	return sid !== null && (Object.hasOwn(PERMITTED_ACL_SIDS, sid) || (isSid(currentSid) && sid === currentSid));
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


/** The directories the access rewrite applies to, parents first and each named once. */
function restrictedDirectories(layout: PrivateStorageLayout): readonly string[] {
	const directories: string[] = [];
	for (const directory of [layout.root, ...layout.directories]) {
		if (!directories.includes(directory)) directories.push(directory);
	}
	return directories;
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

	const permittedPrincipals: string[] = [];
	if (platform === "win32") {
		const identity = input.probe?.currentSid ?? await readCurrentSid();
		if (identity === null || !isSid(identity)) return refuse("the owning account SID could not be read");
		const storePaths = [...new Set([layout.root, ...layout.directories, ...layout.verifiedDirectories, ...files])];
		const reports = input.probe?.readAcl === undefined ? await readStorageAcls([...storePaths, ...carriers]) : null;
		const readAcl = input.probe?.readAcl ?? (async (target: string) =>
			reports?.get(target.toLowerCase()) ?? { ok: false, stdout: "", detail: "the SID reader returned no ACL" });
		for (const target of storePaths) {
			const result = await readAcl(target);
			if (!result.ok) {
				return refuse(`the store access of ${target} could not be verified (${result.detail ?? "the SID reader failed"})`);
			}
			const acl = parseWindowsAcl(result.stdout);
			if (!acl.parsed) return refuse(`the store access listing of ${target} could not be read`);
			for (const principal of acl.principals) {
				if (!isPermittedAclPrincipal(principal, identity)) {
					return refuse(`the store path ${target} is readable by ${principal}, beyond the same-user boundary`);
				}
				if (!permittedPrincipals.includes(principal)) permittedPrincipals.push(principal);
			}
		}
		for (const target of carriers) {
			const result = await readAcl(target);
			if (!result.ok) {
				return refuse(`the component ${target} on the path to the store could not be verified (${result.detail ?? "the SID reader failed"})`);
			}
			const acl = parseWindowsAcl(result.stdout);
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
		`*${account}:(OI)(CI)(F)`,
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
	const account = input.probe?.currentSid ?? (await readCurrentSid());
	if (account === null || !isSid(account)) {
		return {
			restricted: false,
			reason: "the owning account could not be resolved, so the access rules were left untouched",
			readiness: null,
		};
	}
	const directories = restrictedDirectories(layout);
	let reports = input.probe?.readAcl === undefined ? await readStorageAcls(directories) : null;
	const readAcl = input.probe?.readAcl ?? (async (target: string) =>
		reports?.get(target.toLowerCase()) ?? { ok: false, stdout: "", detail: "the SID reader returned no ACL" });
	const applyIcacls = input.probe?.applyIcacls ?? applyIcaclsDefault;
	for (const [index, directory] of directories.entries()) {
		// A link or reparse point is never rewritten: `icacls` would apply the rules to
		// whatever it reaches, which is not this store. Verification refuses it next.
		const stats = await fs.lstat(directory).catch(() => null);
		if (stats === null || stats.isSymbolicLink() || !stats.isDirectory()) continue;
		// A directory that is already limited to this account, SYSTEM and
		// Administrators is left exactly as it is; the ones that are not are
		// rewritten from themselves, one at a time, never as a recursive walk.
		const result = await readAcl(directory);
		const acl = parseWindowsAcl(result.stdout);
		if (result.ok && acl.parsed && acl.principals.every(principal => isPermittedAclPrincipal(principal, account))) continue;
		const applied = await applyIcacls(directory, ownerOnlyGrant(account));
		if (!applied.ok) {
			return {
				restricted: false,
				reason: `the store access could not be restricted (${applied.detail ?? "icacls failed"})`,
				readiness: null,
			};
		}
		// Inheritable grants can change every remaining directory. Never rewrite
		// one from stale pre-parent-rewrite evidence.
		if (input.probe?.readAcl === undefined && index + 1 < directories.length) {
			reports = await readStorageAcls(directories.slice(index + 1));
		}
	}
	const readiness = await verifyPrivateStorage({ layout, probe: { ...input.probe, currentSid: account } });
	return {
		restricted: readiness.ready,
		reason: readiness.ready ? null : readiness.reason,
		readiness,
	};
}
