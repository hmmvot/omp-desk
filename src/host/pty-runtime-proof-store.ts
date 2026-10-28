/**
 * The PTY runtime's self-check, remembered on disk so a later window or reload does not
 * repeat it ([ADR-0032](../../docs/decisions/0032-prove-the-pty-runtime-with-a-console-child.md),
 * amendment 2026-10-13, proposed).
 *
 * The check proves that *this tree* loads and runs a console child and a pipe child under
 * *this executable* on *this operating system*. All of that is a property of values a later
 * window can read cheaply, so a proof is kept under the key that names them and is reused by
 * any window whose key is equal:
 *
 * - the staged tree's content digest (any changed byte is another tree);
 * - the runtime version the broker reports;
 * - the executable that runs the broker: its path, its size and modification time (a replaced
 *   `Code.exe` or node binary changes them whatever its path), and, when it is this process's
 *   own executable, the Node, Electron and ABI versions it reports;
 * - platform, architecture and the operating system release (the build number).
 *
 * A key that differs in any field finds no file; a file whose own key does not equal the
 * wanted one, whose shape is wrong, whose dates are unreadable or lie in the future, or that is
 * not a small regular file, is a miss and is overwritten by the next proof. Only a *proven*
 * self-check is written — an inconclusive answer admits a launch provisionally and is never
 * kept. Writes replace the file atomically (`src/host/atomic-file.ts`), owner-only mode where
 * the platform has one.
 *
 * The file is not a secret and carries nothing a session depends on for safety: it lets a
 * window skip a smoke check. It lives below `runtime/`, whose access rules the staging pass
 * establishes before anything is written, so another account cannot write it either. A reuse
 * still stages the tree (which re-reads and re-hashes every copy and re-verifies the access
 * rules, exactly as before); only the self-check is skipped.
 */

import { createHash } from "node:crypto";
import { mkdir, rm, stat } from "node:fs/promises";
import { arch, platform, release } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { readBoundedFile, replaceFileAtomic } from "./atomic-file.ts";
import { canonicalJson } from "./control-protocol.ts";
import { RUNTIME_ASSET_DIRECTORY } from "./runtime-assets.ts";

/** What the runtime reported about itself when it was asked to prove itself. */
export interface PtySelfCheckAnswer {
	readonly runtimeVersion: number;
	readonly platform: NodeJS.Platform;
	readonly arch: string;
	readonly node: string;
	readonly electron: string | null;
	readonly nodePty: string | null;
	/** Whether the ConPTY backend (`conpty.dll`) is the one in use. */
	readonly conptyDll: boolean;
	/** The child's own markers were read back from its pseudo console. */
	readonly childOutput: boolean;
	/**
	 * A pipe child (the broker entry itself, `--pipe-echo`) echoed one JSONL line through
	 * stdin/stdout pipes and ended when its stdin closed: what a `managed-rpc` slot runs on.
	 */
	readonly pipeChild: boolean;
	/**
	 * The child's exit code as the backend reported it, or `null` when the backend
	 * reported none — the Windows ConPTY backend does not always have one, and the
	 * markers are what make such a run acceptable (`src/broker/pty-self-check.ts`).
	 */
	readonly childExitCode: number | null;
	readonly durationMs: number;
	/** Set only by the pipe-only check of a Chat-only runtime (ADR-0074): no console child ran, so `childOutput` is false. */
	readonly pipeOnly?: true;
	/** The Bun version that ran a pipe-only check; `null` when the runtime that ran it was not Bun. */
	readonly bun?: string | null;
	/** The executable that ran a pipe-only check, as the runtime itself reports it (`process.execPath`); the host holds it to the file it judged. */
	readonly execPath?: string;
}

/** Directory below `runtime/` holding one proof file per key. */
export const PTY_PROOF_DIRECTORY = "pty-proof";

/** Largest proof file that is read. A real one is well under 2 KiB. */
const MAX_PROOF_BYTES = 16 * 1024;

/** Clock skew tolerated before a recorded time counts as being in the future. */
const FUTURE_SKEW_MS = 5 * 60 * 1000;

/** How long a stored proof is believed. The key does not cover everything the self-check depends on (the environment, policy), so no proof outlives a day. */
const MAX_PROOF_AGE_MS = 24 * 60 * 60 * 1000;

const PROOF_FORMAT = 1;

/** Everything the self-check's answer depends on. */
export interface PtyProofKey {
	readonly format: typeof PROOF_FORMAT;
	readonly runtimeVersion: number;
	readonly treeDigest: string;
	readonly executable: {
		readonly path: string;
		readonly size: number;
		readonly mtimeMs: number;
	};
	/** The versions this process reports when it is the executable; `null` for an explicit node path, whose versions are not known without running it. */
	readonly versions: {
		readonly node: string;
		readonly electron: string | null;
		readonly abi: string;
	} | null;
	readonly platform: string;
	readonly arch: string;
	readonly osRelease: string;
	/** Present (`true`) only for a pipe-only proof. */
	readonly pipeOnly?: true;
}

/** What one proven self-check left behind. */
export interface PtyProofRecord {
	readonly format: typeof PROOF_FORMAT;
	readonly key: PtyProofKey;
	/** When the self-check ran (ISO). */
	readonly provedAt: string;
	readonly selfCheck: PtySelfCheckAnswer;
}

export type PtyProofLookup =
	| { readonly kind: "hit"; readonly record: PtyProofRecord }
	| { readonly kind: "miss"; readonly why: string };

/**
 * The key for one tree under one executable, or `null` when the executable cannot be read
 * (then nothing is reused and nothing is written: an executable that cannot be identified
 * cannot be told apart from a replaced one).
 */
export async function ptyProofKey(input: {
	readonly runtimeVersion: number;
	readonly treeDigest: string;
	readonly executable: string;
	/** `true` when the executable is this process's own, so its versions are known. */
	readonly ownExecutable: boolean;
	/** `true` for the pipe-only check of a Chat-only runtime: its proof is another file and never answers a full lookup. */
	readonly pipeOnly?: boolean;
}): Promise<PtyProofKey | null> {
	let identity;
	try {
		identity = await stat(input.executable);
	} catch {
		return null;
	}
	if (!identity.isFile()) return null;
	return {
		format: PROOF_FORMAT,
		runtimeVersion: input.runtimeVersion,
		treeDigest: input.treeDigest,
		executable: { path: input.executable, size: identity.size, mtimeMs: Math.trunc(identity.mtimeMs) },
		versions: input.ownExecutable
			? { node: process.versions.node, electron: process.versions.electron ?? null, abi: process.versions.modules }
			: null,
		platform: platform(),
		arch: arch(),
		osRelease: release(),
		// Present only for a pipe-only proof, so every existing full-proof key keeps its hash.
		...(input.pipeOnly === true ? { pipeOnly: true as const } : {}),
	};
}

function proofDirectory(storageDir: string): string {
	return join(storageDir, RUNTIME_ASSET_DIRECTORY, PTY_PROOF_DIRECTORY);
}

/** The name the key goes by on disk: a hash of the whole key, so equal keys share it and any differing field does not. */
export function ptyProofKeyName(key: PtyProofKey): string {
	return createHash("sha256").update(canonicalJson(key), "utf8").digest("hex");
}

export function ptyProofPath(storageDir: string, key: PtyProofKey): string {
	return join(proofDirectory(storageDir), `${ptyProofKeyName(key)}.json`);
}

/**
 * A recorded time is usable when it is neither in the future (beyond clock skew) nor older
 * than {@link MAX_PROOF_AGE_MS}: a proof that is not refreshed within a day is checked again.
 */
function isoTime(value: unknown, now: number): number | null {
	if (typeof value !== "string") return null;
	const time = Date.parse(value);
	return Number.isFinite(time) && time <= now + FUTURE_SKEW_MS && now - time <= MAX_PROOF_AGE_MS ? time : null;
}

/** Delete one stored proof. Never throws: a file that cannot be removed is simply read (and judged) again. */
export async function forgetPtyProof(file: string): Promise<void> {
	await rm(file, { force: true }).catch(() => undefined);
}

/** The answer one proven self-check recorded, or `null` when the stored value is not exactly that shape. */
function parseSelfCheck(value: unknown, pipeOnly: boolean): PtySelfCheckAnswer | null {
	if (typeof value !== "object" || value === null) return null;
	const answer = value as Record<string, unknown>;
	const { electron, nodePty, childExitCode } = answer;
	if (
		typeof answer.runtimeVersion !== "number" ||
		typeof answer.platform !== "string" ||
		typeof answer.arch !== "string" ||
		typeof answer.node !== "string" ||
		(electron !== null && typeof electron !== "string") ||
		(nodePty !== null && typeof nodePty !== "string") ||
		typeof answer.conptyDll !== "boolean" ||
		(pipeOnly ? answer.childOutput !== false : answer.childOutput !== true) ||
		answer.pipeChild !== true ||
		(pipeOnly ? answer.pipeOnly !== true || typeof answer.bun !== "string" || typeof answer.execPath !== "string" || childExitCode !== null : childExitCode !== null && childExitCode !== 0) ||
		typeof answer.durationMs !== "number"
	) {
		return null;
	}
	return {
		runtimeVersion: answer.runtimeVersion,
		platform: answer.platform as NodeJS.Platform,
		arch: answer.arch,
		node: answer.node,
		electron,
		nodePty,
		conptyDll: answer.conptyDll,
		childOutput: !pipeOnly,
		pipeChild: true,
		childExitCode: childExitCode === 0 ? 0 : null,
		durationMs: answer.durationMs,
		...(pipeOnly ? { pipeOnly: true as const, bun: answer.bun as string, execPath: answer.execPath as string } : {}),
	};
}

/** The proof stored for exactly this key, or why there is none. Never throws. */
export async function readPtyProof(storageDir: string, key: PtyProofKey, now: number = Date.now()): Promise<PtyProofLookup> {
	let read;
	try {
		read = await readBoundedFile(ptyProofPath(storageDir, key), MAX_PROOF_BYTES);
	} catch {
		return { kind: "miss", why: "the proof file could not be read" };
	}
	if (read.kind === "missing") return { kind: "miss", why: "no proof is stored for this key" };
	if (read.kind === "invalid") return { kind: "miss", why: "the proof file is not a small regular file" };
	let parsed: unknown;
	try {
		parsed = JSON.parse(read.text);
	} catch {
		return { kind: "miss", why: "the proof file is not JSON" };
	}
	if (typeof parsed !== "object" || parsed === null) return { kind: "miss", why: "the proof file is not an object" };
	const record = parsed as Record<string, unknown>;
	if (record.format !== PROOF_FORMAT) return { kind: "miss", why: "the proof file has another format" };
	// The name is a hash of the key; the content is compared as well, so an edited or misplaced file is not trusted.
	if (canonicalJson(record.key) !== canonicalJson(key)) return { kind: "miss", why: "the proof file names another key" };
	const provedAt = isoTime(record.provedAt, now);
	if (provedAt === null) return { kind: "miss", why: "the proof file carries an unreadable time" };
	const selfCheck = parseSelfCheck(record.selfCheck, key.pipeOnly === true);
	if (selfCheck === null) return { kind: "miss", why: "the proof file's self-check answer is malformed" };
	return {
		kind: "hit",
		record: { format: PROOF_FORMAT, key, provedAt: new Date(provedAt).toISOString(), selfCheck },
	};
}

/** Store one proof atomically. Throws when the file cannot be written; the caller decides that it is not fatal. */
export async function writePtyProof(storageDir: string, record: PtyProofRecord): Promise<void> {
	await mkdir(proofDirectory(storageDir), { recursive: true, mode: 0o700 });
	await replaceFileAtomic(ptyProofPath(storageDir, record.key), `${JSON.stringify(record)}\n`, {
		mode: 0o600,
		sync: true,
		createDirectory: false,
	});
}
