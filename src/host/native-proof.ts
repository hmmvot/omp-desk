/**
 * The recorded proof that the staged native module's layout was verified and has not changed since (ADR-0076, decision 11).
 *
 * The verifier child (`runtime/native-stage.ts`) establishes and verifies the owner-only layout of the staged `koffi.node`
 * natively: the runtime directory, the digest directory, the file, and every ancestor the tree is reached through. After it
 * passed, and only on a local fixed NTFS volume, it records what it verified: the identity of each of those paths (`lstat`: volume,
 * file id and, for the digest directory and the file, size, last-write and change times in nanoseconds) and the account that
 * judged it. A later activation by the same account that finds every path with the identical identity, in a record at most a day
 * old, skips the child and loads the staged copy in one synchronous step; before the module is shared, the lane reads the owner and
 * access list of every path of the chain natively and judges them by the verifier's rules, so an owner or access change that the
 * identities cannot show is still refused in the same activation (`WarmNativeAsset.verify`). The staged bytes are still hashed
 * before every load.
 *
 * The times of the directories above the digest directory are not compared: other programs add and remove entries in the roaming
 * profile and in VS Code's global storage all day, and Desk itself adds a sibling to the runtime directory whenever it stages
 * another asset; each of those moves the directory's times without touching anything the verification said about the chain.
 *
 * Anything the proof cannot vouch for reads as "no proof": a record that is malformed, from the future, too old, for another
 * account or location, a link or junction anywhere in the chain, or an identity that differs. The caller then runs the child as it
 * always did, and the child writes a fresh record.
 */
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, type BigIntStats } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RUNTIME_ASSET_DIRECTORY } from "../wire/runtime-assets.ts";
import { ancestorComponents, chainSecurityProblem, onLocalFixedNtfs, readSecurityOn, readSecuritySyncOn, restrictPrivateStorage } from "../wire/private-storage.ts";
import type { PrivateStorageProbe } from "../wire/private-storage.ts";
import type { Win32Native } from "../wire/win32-native.ts";

/** The directory (inside the global storage, outside the verified chain) holding the records. */
export const NATIVE_PROOF_DIRECTORY = "native-proof";

/** The longest a record vouches: after this the verifier child runs again. */
export const NATIVE_PROOF_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const RECORD_VERSION = 2;
const MAX_RECORD_BYTES = 64 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;
const DECIMAL = /^[0-9]+$/;
const NO_FILE_ID = 0xffffffffffffffffn;
const DRIVE_FIXED = 3;
const SECURITY_DEADLINE_MS = 20_000;

/**
 * The identity of one verified path, as `lstat` reports it; numbers are decimal strings because they exceed 2^53. The size and
 * the two times are present for the digest directory and the file (`strict`) and absent for every directory above them.
 */
export interface ProofEntry {
	readonly path: string;
	readonly kind: "directory" | "file";
	/** The volume serial number (`st_dev`). */
	readonly dev: string;
	readonly ino: string;
	readonly size?: string;
	readonly mtimeNs?: string;
	readonly ctimeNs?: string;
}

/** Who verified: the process token's account (the SID the native read reports) and the profile the process runs for. */
export interface ProofAccount {
	readonly sid: string;
	readonly username: string;
	readonly home: string;
}

export interface NativeProofRecord {
	readonly version: typeof RECORD_VERSION;
	/** SHA-256 of the packaged module the record is for (also its file name). */
	readonly sha256: string;
	/** Where the verified staged copy is. */
	readonly stagedPath: string;
	/** When the verifier child finished verifying, in epoch milliseconds. */
	readonly verifiedAtMs: number;
	readonly account: ProofAccount;
	readonly entries: readonly ProofEntry[];
}

/** The module the warm start names for loading, and the check that must pass before it is shared. */
export interface WarmNativeAsset {
	readonly path: string;
	readonly sha256: string;
}

export type WarmNativeResult =
	| {
		readonly kind: "proven";
		readonly asset: WarmNativeAsset;
		readonly ageMs: number;
		/**
		 * Read the owner and access list of every path of the chain natively, in one synchronous step, and judge them by the verifier's
		 * rules, and require the token's account to be the one that verified. Returns the refusal, or `null`.
		 */
		readonly verify: (native: Win32Native) => string | null;
	}
	| { readonly kind: "none"; readonly reason: string };

/** Where the record for a packaged module with this digest lives. */
export function nativeProofPath(storageDir: string, packagedSha256: string): string {
	return path.join(storageDir, NATIVE_PROOF_DIRECTORY, `${packagedSha256}.json`);
}

/** The staged copy's path for a packaged file: the runtime directory, the digest directory, the file's own name. */
export function stagedNativePath(storageDir: string, packagedPath: string, sha256: string): string {
	return path.join(storageDir, RUNTIME_ASSET_DIRECTORY, sha256, path.basename(packagedPath));
}

/** One link of the verified chain; `strict` links (the digest directory and the file) are compared with their times, the others by file id. */
export interface ProofLink {
	readonly path: string;
	readonly kind: "directory" | "file";
	readonly strict: boolean;
	/** Whether the verifier judges it as a path it owns (every access entry permitted) rather than as a carrier of the tree. */
	readonly owned: boolean;
}

/**
 * Every path the verification covers, outermost first: the ancestors the runtime directory is reached through (up to, and not
 * including, the volume root, the platform's trust anchor), the runtime directory, the digest directory, the staged file.
 */
export function proofChain(stagedPath: string): readonly ProofLink[] {
	const digestDirectory = path.dirname(stagedPath);
	const runtimeDirectory = path.dirname(digestDirectory);
	return [
		...[...ancestorComponents(runtimeDirectory)].reverse().map(p => ({ path: p, kind: "directory" as const, strict: false, owned: false })),
		{ path: runtimeDirectory, kind: "directory" as const, strict: false, owned: true },
		{ path: digestDirectory, kind: "directory" as const, strict: true, owned: true },
		{ path: stagedPath, kind: "file" as const, strict: true, owned: true },
	];
}

/**
 * The identity of `target`, or why it is not one the proof can use: missing, a link or junction, the wrong kind, or a volume that
 * reports no usable file id or change time.
 */
function identityOf(target: string, kind: "directory" | "file", strict: boolean): { readonly entry: ProofEntry } | { readonly refusal: string } {
	let stats: BigIntStats;
	try {
		stats = lstatSync(target, { bigint: true });
	} catch (error) {
		return { refusal: `${target} cannot be read (${(error as NodeJS.ErrnoException).code ?? "error"})` };
	}
	if (stats.isSymbolicLink()) return { refusal: `${target} is a link` };
	if (kind === "directory" ? !stats.isDirectory() : !stats.isFile()) return { refusal: `${target} is not a ${kind}` };
	if (stats.ino === 0n || stats.ino === NO_FILE_ID || stats.ctimeNs === 0n) return { refusal: `${target} has no file id or change time on this volume` };
	const base = { path: target, kind, dev: String(stats.dev), ino: String(stats.ino) };
	return { entry: strict ? { ...base, size: String(stats.size), mtimeNs: String(stats.mtimeNs), ctimeNs: String(stats.ctimeNs) } : base };
}

/** The identity of every path of the chain now; the reason when any of them cannot be vouched for. */
export function snapshotProofChain(stagedPath: string): { readonly entries: readonly ProofEntry[] } | { readonly refusal: string } {
	const entries: ProofEntry[] = [];
	for (const item of proofChain(stagedPath)) {
		const identity = identityOf(item.path, item.kind, item.strict);
		if ("refusal" in identity) return identity;
		entries.push(identity.entry);
	}
	return { entries };
}

function isEntry(value: unknown): value is ProofEntry {
	if (typeof value !== "object" || value === null) return false;
	const e = value as Record<string, unknown>;
	if (typeof e.path !== "string" || (e.kind !== "directory" && e.kind !== "file")) return false;
	const present = [e.size, e.mtimeNs, e.ctimeNs].filter(part => part !== undefined);
	// All three or none: an entry that names some of its times is not one this code wrote.
	if (present.length !== 0 && present.length !== 3) return false;
	return [e.dev, e.ino, ...present].every(part => typeof part === "string" && DECIMAL.test(part));
}

function isAccount(value: unknown): value is ProofAccount {
	if (typeof value !== "object" || value === null) return false;
	const a = value as Record<string, unknown>;
	return typeof a.sid === "string" && /^S-1-[0-9-]+$/.test(a.sid) && typeof a.username === "string" && a.username.length > 0 && typeof a.home === "string" && a.home.length > 0;
}

/** The record in `text`, or `null` when it is not exactly a current-version record. */
export function parseNativeProof(text: string): NativeProofRecord | null {
	try {
		const value: unknown = JSON.parse(text);
		if (typeof value !== "object" || value === null) return null;
		const r = value as Record<string, unknown>;
		if (r.version !== RECORD_VERSION || typeof r.sha256 !== "string" || !SHA256.test(r.sha256)) return null;
		if (typeof r.stagedPath !== "string" || typeof r.verifiedAtMs !== "number" || !Number.isFinite(r.verifiedAtMs)) return null;
		if (!isAccount(r.account)) return null;
		if (!Array.isArray(r.entries) || r.entries.length === 0 || !r.entries.every(isEntry)) return null;
		return { version: RECORD_VERSION, sha256: r.sha256, stagedPath: r.stagedPath, verifiedAtMs: r.verifiedAtMs, account: r.account, entries: r.entries };
	} catch {
		return null;
	}
}

/** The account this process runs as, as the process token reports it synchronously. */
function currentProfile(): { readonly username: string; readonly home: string } | null {
	try {
		const info = os.userInfo();
		return { username: info.username, home: info.homedir };
	} catch {
		return null;
	}
}

/**
 * The warm start's decision, in one synchronous step: the staged module to load when a recorded verification still holds, or why
 * not. Reads the packaged file (to name its record), the record, and the identity of each verified path; never writes.
 */
export function warmNativeAsset(input: { readonly storageDir: string; readonly packagedPath: string; readonly now?: () => number }): WarmNativeResult {
	const none = (reason: string): WarmNativeResult => ({ kind: "none", reason });
	let packaged: Buffer;
	try {
		packaged = readFileSync(input.packagedPath);
	} catch (error) {
		return none(`the packaged module cannot be read (${(error as NodeJS.ErrnoException).code ?? "error"})`);
	}
	const sha256 = createHash("sha256").update(packaged).digest("hex");
	const recordPath = nativeProofPath(input.storageDir, sha256);
	// The record's integrity rests on the owner-only rules of its directory, checked when it was written; here it must at least be
	// a plain file in a plain directory, not something that leads elsewhere.
	for (const [target, kind] of [[path.dirname(recordPath), "directory"], [recordPath, "file"]] as const) {
		const identity = identityOf(target, kind, false);
		if ("refusal" in identity) return none(`no record for this module (${identity.refusal})`);
	}
	let text: string;
	try {
		text = readFileSync(recordPath, { encoding: "utf8", flag: "r" });
	} catch (error) {
		return none(`no record for this module (${(error as NodeJS.ErrnoException).code ?? "error"})`);
	}
	if (text.length > MAX_RECORD_BYTES) return none("the record is too large");
	const record = parseNativeProof(text);
	if (record === null) return none("the record is malformed");
	const stagedPath = stagedNativePath(input.storageDir, input.packagedPath, sha256);
	if (record.sha256 !== sha256 || record.stagedPath !== stagedPath) return none("the record is for another module or location");
	const profile = currentProfile();
	if (profile === null || profile.username !== record.account.username || profile.home !== record.account.home) return none("the record was written by another account");
	const ageMs = (input.now ?? Date.now)() - record.verifiedAtMs;
	if (!(ageMs >= 0)) return none("the record is from the future");
	if (ageMs > NATIVE_PROOF_MAX_AGE_MS) return none("the record is more than a day old");
	const chain = proofChain(stagedPath);
	if (record.entries.length !== chain.length) return none("the record does not cover the current path chain");
	for (const [index, item] of chain.entries()) {
		const expected = record.entries[index]!;
		if (expected.path !== item.path || expected.kind !== item.kind) return none("the record does not cover the current path chain");
		const identity = identityOf(item.path, item.kind, item.strict);
		if ("refusal" in identity) return none(identity.refusal);
		const now = identity.entry;
		// A link the record holds without times (or a strict one that lost them) is not the record this code writes.
		if ((expected.ctimeNs === undefined) === item.strict) return none("the record does not cover the current path chain");
		if (now.dev !== expected.dev || now.ino !== expected.ino || now.size !== expected.size || now.mtimeNs !== expected.mtimeNs || now.ctimeNs !== expected.ctimeNs) {
			return none(`${item.path} changed since it was verified`);
		}
	}
	const paths = chain.map(item => item.path);
	const owned = chain.filter(item => item.owned).map(item => item.path);
	const carriers = chain.filter(item => !item.owned).map(item => item.path);
	const verify = (native: Win32Native): string | null => {
		// The record exists only for a local fixed NTFS volume; the stat identity above includes the volume serial. Asked again,
		// because the synchronous read must never go to a network path.
		if (!onLocalFixedNtfs(native, stagedPath)) return "the staged native module is no longer on a local fixed NTFS volume";
		const read = readSecuritySyncOn(native, paths);
		if (read.sid !== null && read.sid !== record.account.sid) return "the record was written by another account";
		return chainSecurityProblem(read, { owned, carriers });
	};
	return { kind: "proven", asset: { path: stagedPath, sha256 }, ageMs, verify };
}

/**
 * Verify the proof directory itself, then record the verified chain (the verifier child, after its own verification passed).
 *
 * A record is written only for a layout on one local, fixed NTFS volume: a network share caches metadata and may report ids and
 * times that mean nothing across machines, and a file system that does not keep a volume-wide file id cannot show a replaced
 * path. The directory is created and made owner-only by the same convention as the runtime directory, before the record is
 * written into it, and the record is verified as a file afterwards. It is outside the chain, so none of this changes what the
 * record names. The chain is read before and after, and the record is kept only if nothing it names moved meanwhile.
 * Returns the record, or throws with the reason no proof could be recorded (the child then still reports "staged": there is
 * simply no warm start next time).
 */
export async function recordNativeProof(input: {
	readonly storageDir: string;
	readonly packagedSha256: string;
	readonly stagedPath: string;
	readonly native: Win32Native;
	readonly now?: () => number;
	readonly access?: PrivateStorageProbe;
}): Promise<NativeProofRecord> {
	const volumeRoot = path.parse(input.stagedPath).root;
	const volume = input.native.volumeOf(volumeRoot);
	if (volume.driveType !== DRIVE_FIXED || volume.fileSystem !== "NTFS") {
		throw new Error(`no proof is recorded for ${volumeRoot}: it is not a local fixed NTFS volume (drive type ${volume.driveType}, file system ${volume.fileSystem ?? "unknown"})`);
	}
	const profile = currentProfile();
	if (profile === null) throw new Error("no proof can be recorded: the account's profile could not be read");
	const account = await readSecurityOn(input.native, [input.stagedPath]);
	if (account.sid === null) throw new Error("no proof can be recorded: the account SID could not be read");
	const directory = path.join(input.storageDir, NATIVE_PROOF_DIRECTORY);
	const verifyLayout = async (files: readonly string[]): Promise<void> => {
		const restriction = await restrictPrivateStorage({
			layout: {
				root: directory,
				directories: [directory],
				verifiedDirectories: [],
				verifiedFiles: files,
				probeDirectory: directory,
				probeText: "omp-native-proof-probe",
			},
			...(input.access === undefined ? {} : { probe: input.access }),
		});
		if (!restriction.restricted) throw new Error(`the proof directory is not usable: ${restriction.reason ?? "its access could not be established"}`);
	};
	// Taken right after the staging verified the chain, and again after the record is written.
	const before = snapshotProofChain(input.stagedPath);
	if ("refusal" in before) throw new Error(`no proof can be recorded: ${before.refusal}`);
	if (new Set(before.entries.map(entry => entry.dev)).size !== 1) throw new Error("no proof is recorded: the layout spans more than one volume");
	await mkdir(directory, { recursive: true, mode: 0o700 });
	await verifyLayout([]);
	const record: NativeProofRecord = {
		version: RECORD_VERSION,
		sha256: input.packagedSha256,
		stagedPath: input.stagedPath,
		verifiedAtMs: (input.now ?? Date.now)(),
		account: { sid: account.sid, username: profile.username, home: profile.home },
		entries: before.entries,
	};
	const target = nativeProofPath(input.storageDir, input.packagedSha256);
	const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, JSON.stringify(record), { flag: "wx", mode: 0o600 });
		await rename(temporary, target);
	} catch (error) {
		await rm(temporary, { force: true }).catch(() => {});
		throw error;
	}
	try {
		await verifyLayout([target]);
		const after = snapshotProofChain(input.stagedPath);
		if ("refusal" in after) throw new Error(`no proof can be recorded: ${after.refusal}`);
		if (JSON.stringify(after.entries) !== JSON.stringify(before.entries)) throw new Error("no proof is recorded: the layout changed while the record was written");
	} catch (error) {
		await rm(target, { force: true }).catch(() => {});
		throw error;
	}
	return record;
}
