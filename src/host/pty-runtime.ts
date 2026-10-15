/**
 * The PTY broker's runtime: where it is staged from, how its ABI is proved, and how
 * it is started ([ADR-0024](../../docs/decisions/0024-own-omp-pty-for-in-tab-terminal.md),
 * [ADR-0012](../../docs/decisions/0012-run-child-process-entries-from-staged-copies.md),
 * [ADR-0032](../../docs/decisions/0032-prove-the-pty-runtime-with-a-console-child.md)).
 *
 * A broker is not a single file. It is an entry script, the native module the process
 * checks run through, a PowerShell owner-watch helper, and a `node-pty` package whose native addon loads `conpty.dll` and
 * `OpenConsole.exe` from beside itself and a worker script from a path relative to
 * its own directory. All of that has to keep the layout it was built with, has to
 * live outside the installed extension folder while a session runs, and has to be
 * loaded by a runtime whose ABI matches the prebuilt addon.
 *
 * So this module does three things and refuses to guess at any of them:
 *
 * 1. it enumerates the packaged tree (`out/pty/**` plus `out/native/koffi.node`, produced by `esbuild.mjs` from
 *    `node-pty`, the checked-in helper and koffi), and hands it to the shared tree staging;
 * 2. it *proves* the runtime instead of assuming it: the staged entry is started once
 *    with `--self-check`, which loads the addon in the same runtime the broker will
 *    use, runs a real child through a real pseudo console in the staged tree, and
 *    runs a pipe child for `managed-rpc` slots. The proof is the console child's own
 *    per-run markers read back from the pseudo console, not its exit code, which the
 *    Windows ConPTY backend does not always report (`src/broker/pty-self-check.ts`).
 *    The child is a plain console client (the command interpreter a folder shell
 *    runs), never the staged entry's own executable: an Electron-as-node child was
 *    measured writing nothing to its pseudo console, which made this gate refuse a
 *    healthy runtime. A tree whose native addon cannot load, or whose ConPTY backend
 *    cannot run a child or carry its output, is reported unready here rather than
 *    failing on the user's first session;
 * 3. it starts the broker detached, under the extension host's own executable
 *    (with `ELECTRON_RUN_AS_NODE=1` when that executable is Electron), so the
 *    process outlives the window that started it.
 *
 * Unsupported platforms are reported, not approximated: the kernel identity readings
 * this design rests on are implemented for Windows only, and no other platform's PTY
 * behaviour has been exercised, so a readiness check on another platform returns an
 * unready answer with that reason.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { stat } from "node:fs/promises";
import { localFs } from "./local-fs.ts";
import { join } from "node:path";
import process from "node:process";
import type { PrivateStorageProbe } from "./private-storage.ts";
import {
	hashRuntimeTree,
	listRuntimeTreeFiles,
	stageRuntimeTree,
	verifyStagedRuntimeTree,
	type RuntimeTreeSource,
	type StagedRuntimeAsset,
	type StagedRuntimeTree,
} from "./runtime-assets.ts";
import { forgetPtyProof, ptyProofKey, ptyProofPath, readPtyProof, writePtyProof, type PtyProofRecord, type PtySelfCheckAnswer } from "./pty-runtime-proof-store.ts";
import { isPtyDigest, PTY_RUNTIME_VERSION } from "./pty-protocol.ts";
import {
	SELF_CHECK_DEADLINE_FLAG,
	SELF_CHECK_DEADLINE_MS,
	SELF_CHECK_INCONCLUSIVE_EXIT,
	SELF_CHECK_NATIVE_DIGEST_FLAG,
	SELF_CHECK_NATIVE_FLAG,
	selfCheckTimeoutMayBeLateness,
} from "../broker/pty-self-check.ts";

/** Directory in the installed extension holding the packaged broker tree. */
export const PTY_RUNTIME_DIRECTORY = "out/pty";

/** Namespace inside the staged runtime directory that holds this tree. */
export const PTY_RUNTIME_NAMESPACE = "pty-tree";

/** Entry script of the broker inside the tree. */
export const PTY_BROKER_ENTRY = "pty-broker.js";

/** The native module inside the tree: the build's `out/native/koffi.node`, staged with the rest (ADR-0076). */
export const PTY_NATIVE_ADDON = "native/koffi.node";

/** Where the build puts that module, relative to the extension root. */
export const PTY_NATIVE_SOURCE = "out/native/koffi.node";

/** Owner-watch helper inside the tree; the tree is incomplete without it (ADR-0030). */
export const PTY_OWNER_HELPER = "pty-owner-watch.ps1";

/** The only platform this design has measured; everywhere else reports `not-ready`. */
export const PTY_SUPPORTED_PLATFORM: NodeJS.Platform = "win32";

/** The platform names Node can report, for narrowing a value that came from a peer. */
const KNOWN_PLATFORMS: Record<string, true> = {
	win32: true,
	darwin: true,
	linux: true,
	aix: true,
	freebsd: true,
	openbsd: true,
	sunos: true,
	android: true,
};

/** A staged runtime that passed its own self-check, or was admitted provisionally because the self-check was inconclusive. */
export interface PtyRuntime {
	readonly tree: StagedRuntimeTree;
	readonly entry: StagedRuntimeAsset;
	/** The staged native module (ADR-0076): handed to a broker on its command line, which re-hashes and loads it. */
	readonly native: StagedRuntimeAsset;
	/** The staged owner-watch helper, run for a folder shell that was given a hint. */
	readonly ownerHelper: StagedRuntimeAsset;
	/** `sha256` of the entry script, re-verified before it is started. */
	readonly entrySha256: string;
	/** What the self-check observed, for diagnostics; `null` for a tree admitted before its probe finished. */
	readonly selfCheck: PtySelfCheckAnswer | null;
}

export type { PtySelfCheckAnswer };

/** The stored proof an answer was read from instead of being computed. */
export interface ReusedPtyProof {
	/** When the earlier self-check ran (ISO). */
	readonly provedAt: string;
	/** The file it was read from, so a failure that contradicts it can withdraw exactly that proof. */
	readonly file: string;
}

export interface PtyRuntimeReadiness {
	/**
	 * A broker may be started from {@link runtime}. True for a proven tree and for one
	 * admitted provisionally ({@link proven} false); false only for a refusal.
	 */
	readonly ready: boolean;
	/**
	 * Whether the self-check proved the tree. `false` with `ready: true` is the
	 * provisional admission: the probe ran out of time with nothing observed to be wrong,
	 * and {@link reason} says so. Never cached as a proof.
	 */
	readonly proven: boolean;
	readonly reason: string | null;
	readonly platform: NodeJS.Platform;
	readonly runtimeVersion: number;
	readonly treeDigest: string | null;
	readonly runtime: PtyRuntime | null;
	/**
	 * Set when this answer was not computed but read from the proof an earlier window or
	 * reload stored for the same key (staged tree, runtime version, executable, OS build):
	 * no self-check ran for it. `provedAt` is when that earlier self-check ran.
	 */
	readonly reusedProof?: ReusedPtyProof;
}

export interface PtyRuntimeOptions {
	/** Extension global storage directory; staged trees live under it. */
	readonly storageDir: string;
	/** Extension root: `out/pty` is resolved below it. */
	readonly extensionRoot: string;
	/** Node binary to start the broker with; defaults to the extension host's own. */
	readonly nodePath?: string;
	/** Extra environment for the self-check and the broker. */
	readonly env?: Readonly<Record<string, string>>;
	/** Access probe, for tests that must not depend on this machine's ACLs. */
	readonly access?: PrivateStorageProbe;
	/**
	 * The deadline each phase of the self-check is given, in ms; the entry's own default
	 * ({@link SELF_CHECK_DEADLINE_MS}) when absent. The re-run of an inconclusive probe asks
	 * for {@link SELF_CHECK_EXTENDED_DEADLINE_MS}.
	 */
	readonly selfCheckDeadlineMs?: number;
	/** Test seam: the self-check run; defaults to starting the staged entry with `--self-check`. */
	readonly runSelfCheck?: (
		runtime: { readonly entry: StagedRuntimeAsset; readonly native: StagedRuntimeAsset; readonly tree: StagedRuntimeTree },
		options: PtyRuntimeOptions,
	) => Promise<SelfCheckResult>;
	/**
	 * Prove only what a Chat (`managed-rpc`) broker needs: the staged entry runs under this runtime and a pipe child
	 * carries a line (`--self-check --pipe-only`,
	 * [ADR-0074](../../docs/decisions/0074-run-chat-brokers-on-the-sessions-own-bun-runtime-with-code-exe-as-fallback.md)).
	 * Its proof is kept apart from the full proof (own key, own cache entry) and its answer says `pipeOnly`.
	 */
	readonly pipeOnly?: boolean;
	/** Arguments the runtime itself takes before the entry script (for Bun, `--no-install`). */
	readonly runtimeArgs?: readonly string[];
	/** Test seam; defaults to `Date.now`. */
	readonly now?: () => number;
}

/**
 * Every packaged file of the broker tree, as sorted relative paths.
 *
 * The whole directory is listed rather than a hand-written file list: a list is
 * exactly the kind of thing that silently stops matching `node-pty`'s layout after a
 * dependency update, and the failure would be an addon that cannot find its DLL. The
 * one exclusion is the bundle's own source map, which belongs to a developer's
 * debugger and must not become part of what a session runs from.
 */
export async function ptyRuntimeSources(extensionRoot: string): Promise<readonly RuntimeTreeSource[]> {
	const root = join(extensionRoot, PTY_RUNTIME_DIRECTORY);
	const files = await listRuntimeTreeFiles(root);
	const sources: RuntimeTreeSource[] = [];
	for (const relativePath of files) {
		if (relativePath.endsWith(".map")) continue;
		sources.push({ relativePath, sourcePath: join(root, ...relativePath.split("/")) });
	}
	// The addon is packaged beside the tree, not inside it, because the extension host loads it too
	// (ADR-0076). It rides in the tree so its digest is part of the tree's, and so of every stored proof.
	// A build without it yields an incomplete tree, which `ensurePtyRuntime` reports by name.
	const nativeSource = join(extensionRoot, ...PTY_NATIVE_SOURCE.split("/"));
	if ((await stat(nativeSource).catch(() => null))?.isFile() === true) {
		sources.push({ relativePath: PTY_NATIVE_ADDON, sourcePath: nativeSource });
	}
	return sources;
}

/** The runtime the broker must be started with, and the environment that makes it one. */
export function ptyRuntimeCommand(nodePath?: string): { readonly command: string; readonly env: NodeJS.ProcessEnv } {
	const command = nodePath ?? process.execPath;
	const env: NodeJS.ProcessEnv = { ...process.env };
	if (nodePath === undefined && process.versions.electron !== undefined) {
		// The extension host is Electron; this makes its own executable behave as node.
		env.ELECTRON_RUN_AS_NODE = "1";
	}
	return { command, env };
}

/** What one run of the staged entry's `--self-check` concluded. */
type SelfCheckKind = "proven" | "broken" | "inconclusive";

export interface SelfCheckResult {
	readonly kind: SelfCheckKind;
	readonly answer: PtySelfCheckAnswer | null;
	readonly detail: string;
}

/** Extra time the host gives the entry beyond its two deadlines: process start and the addon load. */
const SELF_CHECK_HOST_SLACK_MS = 30_000;

/** The parsed first JSON line the staged entry printed, or `null` when it printed none. */
function selfCheckAnswerRecord(stdout: string): Record<string, unknown> | null {
	const line = stdout.split(/\r?\n/).find(entry => entry.trim().startsWith("{"));
	if (line === undefined) return null;
	try {
		const parsed: unknown = JSON.parse(line);
		return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

/**
 * The bounded reason the staged entry printed for itself, or `""` when it printed none.
 *
 * The entry prints one JSON line describing what it observed before it exits, so a
 * refused runtime can carry the entry's own reason instead of only a status. The text
 * comes from this extension's own staged entry, never from a guest or a host, and it
 * is collapsed to a single line and bounded before it is reported.
 */
function selfCheckAnswerDetail(stdout: string): string {
	const detail = selfCheckAnswerRecord(stdout)?.detail;
	return typeof detail === "string" ? detail.replace(/\s+/g, " ").slice(0, 400).trim() : "";
}

/** The identity of one executable file that a cached proof was taken under: size, modification time and file id. */
async function executableStamp(file: string): Promise<string> {
	try {
		const status = await stat(file, { bigint: true });
		return `${status.size}:${status.mtimeMs}:${status.ino}`;
	} catch {
		return "unreadable";
	}
}

/**
 * Run the staged entry's `--self-check` and read its answer.
 *
 * A run ends one of three ways. `proven` carries the entry's answer. `broken` is a fault
 * the entry observed or an answer that does not hold up. `inconclusive` is the entry
 * reporting that it ran out of time with nothing observed to be wrong, or this host's
 * own bound killing an entry that never answered while the deadline it was given may
 * still only have been lateness ({@link selfCheckTimeoutMayBeLateness}).
 */
async function runSelfCheck(
	runtime: { readonly entry: StagedRuntimeAsset; readonly native: StagedRuntimeAsset; readonly tree: StagedRuntimeTree },
	options: PtyRuntimeOptions,
): Promise<SelfCheckResult> {
	const { command, env } = ptyRuntimeCommand(options.nodePath);
	const deadlineMs = options.selfCheckDeadlineMs ?? SELF_CHECK_DEADLINE_MS;
	const args = [
		...(options.runtimeArgs ?? []),
		runtime.entry.path,
		"--self-check",
		...(options.pipeOnly === true ? ["--pipe-only"] : []),
		SELF_CHECK_NATIVE_FLAG,
		runtime.native.path,
		SELF_CHECK_NATIVE_DIGEST_FLAG,
		runtime.native.sha256,
	];
	if (options.selfCheckDeadlineMs !== undefined) args.push(`${SELF_CHECK_DEADLINE_FLAG}=${options.selfCheckDeadlineMs}`);
	const child = spawn(command, args, {
		cwd: runtime.tree.directory,
		windowsHide: true,
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...env, ...options.env },
	});
	let stdout = "";
	let stderr = "";
	child.stdout?.on("data", (chunk: Buffer) => {
		if (stdout.length < 64 * 1024) stdout += chunk.toString("utf8");
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		if (stderr.length < 8 * 1024) stderr += chunk.toString("utf8");
	});
	const exit = Promise.withResolvers<number | null>();
	child.on("error", () => exit.resolve(null));
	child.on("close", code => exit.resolve(code));
	// The entry runs its console phase and its pipe phase one after the other, each under
	// the deadline, so this host's own bound is both plus the slack.
	let killed = false;
	const timer = setTimeout(() => {
		killed = true;
		child.kill();
	}, 2 * deadlineMs + SELF_CHECK_HOST_SLACK_MS);
	timer.unref();
	let code: number | null;
	try {
		code = await exit.promise;
	} finally {
		clearTimeout(timer);
	}
	if (code !== 0) {
		// Anything unreadable falls back to the process's own first stderr line.
		const reported = selfCheckAnswerDetail(stdout);
		const detail = reported.length > 0 ? reported : (stderr.trim().split(/\r?\n/)[0] ?? "");
		const text = `the runtime self-check failed with exit code ${code ?? "unknown"}${detail.length > 0 ? `: ${detail}` : ""}`;
		// Lateness is admitted only when the deadline this run was given may excuse it, and then
		// only on the entry's own consistent classification (its inconclusive exit code, `ok:
		// false`, `outcome: "inconclusive"` and no nonzero child exit code reported beside it),
		// or when this host's bound killed an entry that had printed nothing at all. Any answer
		// it did print outranks the kill.
		const record = selfCheckAnswerRecord(stdout);
		const childExit = record?.childExitCode;
		const faultReported = typeof childExit === "number" && childExit !== 0;
		const entrySaysLate =
			code === SELF_CHECK_INCONCLUSIVE_EXIT && record?.ok === false && record.outcome === "inconclusive" && !faultReported;
		const killedSilent = killed && stdout.trim().length === 0;
		if (selfCheckTimeoutMayBeLateness(deadlineMs) && (entrySaysLate || killedSilent)) {
			return { kind: "inconclusive", answer: null, detail: text };
		}
		return { kind: "broken", answer: null, detail: text };
	}
	// Every answer below that does not hold up is a fault, not lateness: the entry finished.
	const refuse = (detail: string): SelfCheckResult => ({ kind: "broken", answer: null, detail });
	const line = stdout.split(/\r?\n/).find(entry => entry.trim().startsWith("{"));
	if (line === undefined) {
		const detail = stderr.trim().split(/\r?\n/)[0] ?? "";
		return refuse(`the runtime self-check printed no answer (exit ${code ?? "unknown"}${detail.length > 0 ? `: ${detail}` : ""})`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return refuse("the runtime self-check answer is not JSON");
	}
	if (typeof parsed !== "object" || parsed === null) {
		return refuse("the runtime self-check answer is not an object");
	}
	const record = parsed as Record<string, unknown>;
	if (record.ok !== true) {
		return refuse(`the runtime self-check failed: ${String(record.detail ?? "no reason given")}`);
	}
	if (typeof record.platform !== "string" || typeof record.arch !== "string" || typeof record.node !== "string") {
		return refuse("the runtime self-check answer is missing its platform description");
	}
	// A platform name outside the known set is replaced by this host's.
	const platform = KNOWN_PLATFORMS[record.platform] === true ? (record.platform as NodeJS.Platform) : process.platform;
	// The child's own markers read back from its pseudo console are the positive half
	// of the proof: an exit report alone says only that something ended, which a
	// backend that delivered nothing to the child would also produce.
	if (options.pipeOnly !== true && record.childOutput !== true) {
		return refuse("the runtime self-check did not prove the child's output reached its pseudo console");
	}
	if (record.pipeChild !== true) {
		return refuse("the runtime self-check did not prove a pipe child can carry a JSONL line");
	}
	// A reported exit code must be clean. An unreported one (`null`) is accepted only
	// because the markers above were proved: the Windows ConPTY backend does not always
	// report a code at all.
	if (record.childExitCode !== 0 && record.childExitCode !== null) {
		return refuse(`the runtime self-check child did not exit cleanly (${String(record.childExitCode)})`);
	}
	if (options.pipeOnly !== true && (!Number.isSafeInteger(record.childPid) || (record.childPid as number) <= 0)) {
		return refuse("the runtime self-check did not report the child process it started");
	}
	if (options.pipeOnly === true && (record.pipeOnly !== true || record.childOutput !== false || record.loopback !== true || typeof record.execPath !== "string")) {
		return refuse("the pipe-only runtime self-check answered as something else");
	}
	const answer: PtySelfCheckAnswer = {
		runtimeVersion: typeof record.runtimeVersion === "number" ? record.runtimeVersion : PTY_RUNTIME_VERSION,
		platform,
		arch: record.arch,
		node: record.node,
		electron: typeof record.electron === "string" ? record.electron : null,
		nodePty: typeof record.nodePty === "string" ? record.nodePty : null,
		conptyDll: record.conptyDll === true,
		childOutput: options.pipeOnly !== true,
		pipeChild: true,
		childExitCode: options.pipeOnly === true ? null : (record.childExitCode as number | null),
		durationMs: typeof record.durationMs === "number" ? record.durationMs : -1,
		...(options.pipeOnly === true
			? { pipeOnly: true as const, bun: typeof record.bun === "string" ? record.bun : null, execPath: record.execPath as string }
			: {}),
	};
	return { kind: "proven", answer, detail: "the runtime proved itself" };
}

/**
 * Runtimes that already passed their self-check.
 *
 * The key is the storage directory, the tree digest and the runtime binary: the check
 * is a property of all three, since the same tree under another node binary is a
 * different ABI question, and the same digest under another storage directory points
 * at another copy.
 */
const provedRuntimes = new Map<string, PtyRuntime>();

/** Forget every in-process proof, so the next call reads the persistent proof or runs the check (a new window's view). */
export function forgetProvedPtyRuntimes(): void {
	provedRuntimes.clear();
}

/**
 * Withdraw a proof an earlier window stored once a launch that relied on it failed before a
 * broker existed: the stored file goes and every in-process proof with it, so the next launch
 * runs the self-check itself and reports what it finds instead of repeating the failure.
 *
 * With `pipeOnly`, only the pipe-only in-process proofs go: a Chat broker's failure on Bun says nothing about the
 * full proof a Terminal launch stands on (ADR-0074).
 */
export async function discardReusedPtyProof(reused: ReusedPtyProof, scope: { readonly pipeOnly?: boolean } = {}): Promise<void> {
	if (scope.pipeOnly === true) {
		for (const key of [...provedRuntimes.keys()]) if (key.includes("\0pipe-only\0")) provedRuntimes.delete(key);
	} else {
		provedRuntimes.clear();
	}
	await forgetPtyProof(reused.file);
}

/**
 * The content digest of this build's packaged broker tree, hashed without staging or writing
 * anything: what a broker of this build reports as its tree. An attach compares a broker's
 * against it and needs nothing else from the runtime. It reads every file of the tree, so a window takes the
 * build's own record of it ({@link ptyRecordedTreeDigest}) and hashes only to check that record, in the background.
 */
export async function ptyPackagedTreeDigest(extensionRoot: string, options: { readonly concurrency?: number } = {}): Promise<string> {
	return (await hashRuntimeTree(await ptyRuntimeSources(extensionRoot), options)).digest;
}

/** Where the build records the digest of the packaged tree, relative to the extension root (`scripts/pty-tree-digest.mjs`). */
export const PTY_TREE_DIGEST_FILE = "out/pty-tree.json";

/** The layout marker of a recorded digest, the one `hashRuntimeTree` puts in the digest itself. */
const PTY_TREE_DIGEST_FORMAT = "omp-runtime-tree/v2";

/** The largest digest record this window reads (a real one is about 100 bytes); a larger file is no record, and the tree is hashed. */
const PTY_TREE_DIGEST_MAX_BYTES = 4 * 1024;

/** The file of {@link ptyRecordedTreeDigest}. */
export function ptyRecordedTreeDigestFile(extensionRoot: string): string {
	return join(extensionRoot, ...PTY_TREE_DIGEST_FILE.split("/"));
}

/**
 * The digest of the packaged tree as the build recorded it, or `null` when there is no usable record (a build from source or
 * a watch build, a record that is missing, unreadable or not a digest): the caller then hashes the tree. One small read.
 */
export async function ptyRecordedTreeDigest(extensionRoot: string): Promise<string | null> {
	try {
		const file = ptyRecordedTreeDigestFile(extensionRoot);
		const parsed: unknown = JSON.parse(await localFs(file).readSmallFile(file, PTY_TREE_DIGEST_MAX_BYTES));
		if (typeof parsed !== "object" || parsed === null || !("format" in parsed) || !("digest" in parsed)) return null;
		return parsed.format === PTY_TREE_DIGEST_FORMAT && isPtyDigest(parsed.digest) ? parsed.digest : null;
	} catch {
		return null;
	}
}

/**
 * Stage the broker tree and prove it.
 *
 * A proven answer (`ready` and `proven`) means: every packaged file was copied into
 * owner-only storage outside the installed extension, every copy was re-hashed, the
 * entry, the native module and the owner-watch helper are all present, and the staged
 * entry loaded the native module and proved a real child and a pipe child in the runtime
 * that will be used for sessions. A tree that fails any of that is reported unready with
 * the reason, and the caller must not start a broker from it.
 *
 * The one other ready answer is the provisional one (`ready` without `proven`): the
 * tree is staged and verified, but the self-check ran out of time with nothing observed
 * to be wrong, which on a saturated machine says nothing about the runtime
 * ([ADR-0032](../../docs/decisions/0032-prove-the-pty-runtime-with-a-console-child.md),
 * 2026-10-12 amendment). It is never cached as a proof; {@link PtyRuntimeProof} repeats it.
 */
export async function ensurePtyRuntime(options: PtyRuntimeOptions): Promise<PtyRuntimeReadiness> {
	if (process.platform !== PTY_SUPPORTED_PLATFORM) {
		return {
			ready: false,
			proven: false,
			reason:
				`the PTY broker is implemented and measured for ${PTY_SUPPORTED_PLATFORM} only; ` +
				`this host is ${process.platform}`,
			platform: process.platform,
			runtimeVersion: PTY_RUNTIME_VERSION,
			treeDigest: null,
			runtime: null,
		};
	}
	let sources: readonly RuntimeTreeSource[];
	try {
		sources = await ptyRuntimeSources(options.extensionRoot);
	} catch (error) {
		return notReady(`the packaged broker tree could not be listed: ${messageOf(error)}`);
	}
	const missing: string[] = [];
	for (const required of [PTY_BROKER_ENTRY, PTY_NATIVE_ADDON, PTY_OWNER_HELPER]) {
		if (!sources.some(source => source.relativePath === required)) missing.push(required);
	}
	if (missing.length > 0) {
		return notReady(`the packaged broker tree is incomplete: ${missing.join(", ")} is missing (run the build)`);
	}
	let tree: StagedRuntimeTree;
	try {
		tree = await stageRuntimeTree({
			storageDir: options.storageDir,
			namespace: PTY_RUNTIME_NAMESPACE,
			sources,
			...(options.access === undefined ? {} : { access: options.access }),
		});
	} catch (error) {
		return notReady(`the broker tree could not be staged: ${messageOf(error)}`);
	}
	const entry = tree.files.find(file => file.relativePath === PTY_BROKER_ENTRY);
	const native = tree.files.find(file => file.relativePath === PTY_NATIVE_ADDON);
	const ownerHelper = tree.files.find(file => file.relativePath === PTY_OWNER_HELPER);
	if (entry === undefined || native === undefined || ownerHelper === undefined) {
		return notReady("the staged broker tree lost its entry, its native module or its owner-watch helper");
	}
	const cacheKey = `${options.storageDir}\0${tree.digest}\0${options.nodePath ?? ""}\0${
		options.pipeOnly === true ? `pipe-only\0${await executableStamp(ptyRuntimeCommand(options.nodePath).command)}` : "full"
	}`;
	const cached = provedRuntimes.get(cacheKey);
	if (cached !== undefined) return readyAnswer(cached);
	if (!(await verifyStagedRuntimeTree(tree))) {
		return notReady("the staged broker tree does not hold the bytes it was staged with");
	}
	const now = options.now ?? Date.now;
	const { command } = ptyRuntimeCommand(options.nodePath);
	const key = await ptyProofKey({
		runtimeVersion: PTY_RUNTIME_VERSION,
		treeDigest: tree.digest,
		executable: command,
		ownExecutable: options.nodePath === undefined,
		pipeOnly: options.pipeOnly === true,
	});
	const build = (selfCheck: PtySelfCheckAnswer | null): PtyRuntime => ({
		tree,
		entry,
		native: { path: native.path, sha256: native.sha256 },
		ownerHelper: { path: ownerHelper.path, sha256: ownerHelper.sha256 },
		entrySha256: entry.sha256,
		selfCheck,
	});
	// A window or reload that finds the proof an earlier one stored under the same key skips the self-check:
	// the tree was staged, its access verified and every copy re-hashed above exactly as for a first run.
	if (key !== null) {
		const stored = await readPtyProof(options.storageDir, key, now());
		if (stored.kind === "hit") {
			const reused = build(stored.record.selfCheck);
			provedRuntimes.set(cacheKey, reused);
			return { ...readyAnswer(reused), reusedProof: { provedAt: stored.record.provedAt, file: ptyProofPath(options.storageDir, key) } };
		}
	}
	const check = await (options.runSelfCheck ?? runSelfCheck)({ entry, native, tree }, options);
	if (check.kind === "broken") {
		return notReady(check.detail, tree.digest);
	}
	const runtime = build(check.answer);
	if (check.answer === null) {
		// Ran out of time with nothing observed to be wrong: a slow machine, not a refuted
		// runtime. The tree is staged and verified, so a broker may be started from it and the
		// real spawn reports its own failure; the result is deliberately not cached as a proof,
		// in this process or on disk.
		return {
			...readyAnswer(runtime),
			proven: false,
			reason: `${check.detail}; no fault was observed, so the runtime is admitted unproven while the check is repeated with a longer deadline`,
		};
	}
	provedRuntimes.set(cacheKey, runtime);
	if (key !== null) {
		const record: PtyProofRecord = { format: 1, key, provedAt: new Date(now()).toISOString(), selfCheck: check.answer };
		// Failing to remember a proof costs the next window one more self-check, never a launch.
		await writePtyProof(options.storageDir, record).catch(() => undefined);
	}
	return readyAnswer(runtime);

	function notReady(reason: string, digest: string | null = null): PtyRuntimeReadiness {
		return {
			ready: false,
			proven: false,
			reason,
			platform: process.platform,
			runtimeVersion: PTY_RUNTIME_VERSION,
			treeDigest: digest,
			runtime: null,
		};
	}
}

function readyAnswer(runtime: PtyRuntime): PtyRuntimeReadiness {
	return {
		ready: true,
		proven: true,
		reason: null,
		platform: process.platform,
		runtimeVersion: runtime.selfCheck?.runtimeVersion ?? PTY_RUNTIME_VERSION,
		treeDigest: runtime.tree.digest,
		runtime,
	};
}

/** Re-read every staged file: called immediately before a broker is started from it. */
export async function verifyPtyRuntime(runtime: PtyRuntime): Promise<boolean> {
	return await verifyStagedRuntimeTree(runtime.tree);
}

/**
 * Start one broker from a proved runtime.
 *
 * Detached, with stdio ignored and the child unreferenced: the process has to outlive
 * the extension host that started it.
 */
export function spawnPtyBroker(
	runtime: PtyRuntime,
	args: readonly string[],
	options: PtyRuntimeOptions,
): ChildProcess {
	const { command, env } = ptyRuntimeCommand(options.nodePath);
	const child = spawn(command, [...(options.runtimeArgs ?? []), runtime.entry.path, ...args], {
		cwd: runtime.tree.directory,
		detached: true,
		windowsHide: true,
		stdio: ["ignore", "ignore", "ignore"],
		env: { ...env, ...options.env },
	});
	// A file that cannot be started reports ENOENT or EACCES asynchronously on Windows; the caller reads the
	// outcome from the exit code and the record, so the event itself is only kept from becoming an uncaught error.
	child.on("error", () => {});
	child.unref();
	return child;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
