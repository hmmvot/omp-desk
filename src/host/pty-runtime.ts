/**
 * The PTY broker's runtime: where it is staged from, how its ABI is proved, and how
 * it is started ([ADR-0024](../../docs/decisions/0024-own-omp-pty-for-in-tab-terminal.md),
 * [ADR-0012](../../docs/decisions/0012-run-child-process-entries-from-staged-copies.md),
 * [ADR-0032](../../docs/decisions/0032-prove-the-pty-runtime-with-a-console-child.md)).
 *
 * A broker is not a single file. It is an entry script, a PowerShell identity probe,
 * and a `node-pty` package whose native addon loads `conpty.dll` and
 * `OpenConsole.exe` from beside itself and a worker script from a path relative to
 * its own directory. All of that has to keep the layout it was built with, has to
 * live outside the installed extension folder while a session runs, and has to be
 * loaded by a runtime whose ABI matches the prebuilt addon.
 *
 * So this module does three things and refuses to guess at any of them:
 *
 * 1. it enumerates the packaged tree (`out/pty/**`, produced by `esbuild.mjs` from
 *    `node-pty` plus the checked-in helper), and hands it to the shared tree staging;
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
} from "../runtime-assets.ts";
import { PTY_RUNTIME_VERSION } from "./pty-protocol.ts";
import type { PtyProbeHelper } from "./pty-identity.ts";

/** Directory in the installed extension holding the packaged broker tree. */
export const PTY_RUNTIME_DIRECTORY = "out/pty";

/** Namespace inside the staged runtime directory that holds this tree. */
export const PTY_RUNTIME_NAMESPACE = "pty-tree";

/** Entry script of the broker inside the tree. */
export const PTY_BROKER_ENTRY = "pty-broker.js";

/** Identity probe helper inside the tree. */
export const PTY_PROBE_HELPER = "pty-process-probe.ps1";

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

/** A staged runtime that passed its own self-check. */
export interface PtyRuntime {
	readonly tree: StagedRuntimeTree;
	readonly entry: StagedRuntimeAsset;
	readonly helper: PtyProbeHelper;
	/** The staged owner-watch helper, run for a folder shell that was given a hint. */
	readonly ownerHelper: PtyProbeHelper;
	/** `sha256` of the entry script, re-verified before it is started. */
	readonly entrySha256: string;
	/** What the self-check observed, for diagnostics. */
	readonly selfCheck: PtySelfCheckAnswer;
}

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
}

export interface PtyRuntimeReadiness {
	readonly ready: boolean;
	readonly reason: string | null;
	readonly platform: NodeJS.Platform;
	readonly runtimeVersion: number;
	readonly treeDigest: string | null;
	readonly runtime: PtyRuntime | null;
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

interface SelfCheckResult {
	readonly answer: PtySelfCheckAnswer | null;
	readonly detail: string;
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
	const line = stdout.split(/\r?\n/).find(entry => entry.trim().startsWith("{"));
	if (line === undefined) return "";
	try {
		const parsed: unknown = JSON.parse(line);
		if (typeof parsed !== "object" || parsed === null) return "";
		const detail = (parsed as Record<string, unknown>).detail;
		return typeof detail === "string" ? detail.replace(/\s+/g, " ").slice(0, 400).trim() : "";
	} catch {
		return "";
	}
}

/** Run the staged entry's `--self-check` and read its answer. */
async function runSelfCheck(
	runtime: { readonly entry: StagedRuntimeAsset; readonly tree: StagedRuntimeTree },
	options: PtyRuntimeOptions,
): Promise<SelfCheckResult> {
	const { command, env } = ptyRuntimeCommand(options.nodePath);
	const child = spawn(command, [runtime.entry.path, "--self-check"], {
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
	const timer = setTimeout(() => child.kill(), 60_000);
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
		return {
			answer: null,
			detail: `the runtime self-check failed with exit code ${code ?? "unknown"}${detail.length > 0 ? `: ${detail}` : ""}`,
		};
	}
	const line = stdout.split(/\r?\n/).find(entry => entry.trim().startsWith("{"));
	if (line === undefined) {
		const detail = stderr.trim().split(/\r?\n/)[0] ?? "";
		return { answer: null, detail: `the runtime self-check printed no answer (exit ${code ?? "unknown"}${detail.length > 0 ? `: ${detail}` : ""})` };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return { answer: null, detail: "the runtime self-check answer is not JSON" };
	}
	if (typeof parsed !== "object" || parsed === null) {
		return { answer: null, detail: "the runtime self-check answer is not an object" };
	}
	const record = parsed as Record<string, unknown>;
	if (record.ok !== true) {
		return { answer: null, detail: `the runtime self-check failed: ${String(record.detail ?? "no reason given")}` };
	}
	if (typeof record.platform !== "string" || typeof record.arch !== "string" || typeof record.node !== "string") {
		return { answer: null, detail: "the runtime self-check answer is missing its platform description" };
	}
	// A platform name outside the known set is replaced by this host's.
	const platform = KNOWN_PLATFORMS[record.platform] === true ? (record.platform as NodeJS.Platform) : process.platform;
	// The child's own markers read back from its pseudo console are the positive half
	// of the proof: an exit report alone says only that something ended, which a
	// backend that delivered nothing to the child would also produce.
	if (record.childOutput !== true) {
		return { answer: null, detail: "the runtime self-check did not prove the child's output reached its pseudo console" };
	}
	if (record.pipeChild !== true) {
		return { answer: null, detail: "the runtime self-check did not prove a pipe child can carry a JSONL line" };
	}
	// A reported exit code must be clean. An unreported one (`null`) is accepted only
	// because the markers above were proved: the Windows ConPTY backend does not always
	// report a code at all.
	if (record.childExitCode !== 0 && record.childExitCode !== null) {
		return { answer: null, detail: `the runtime self-check child did not exit cleanly (${String(record.childExitCode)})` };
	}
	if (!Number.isSafeInteger(record.childPid) || (record.childPid as number) <= 0) {
		return { answer: null, detail: "the runtime self-check did not report the child process it started" };
	}
	const answer: PtySelfCheckAnswer = {
		runtimeVersion: typeof record.runtimeVersion === "number" ? record.runtimeVersion : PTY_RUNTIME_VERSION,
		platform,
		arch: record.arch,
		node: record.node,
		electron: typeof record.electron === "string" ? record.electron : null,
		nodePty: typeof record.nodePty === "string" ? record.nodePty : null,
		conptyDll: record.conptyDll === true,
		childOutput: true,
		pipeChild: true,
		childExitCode: record.childExitCode,
		durationMs: typeof record.durationMs === "number" ? record.durationMs : -1,
	};
	return { answer, detail: "the runtime proved itself" };
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

/** Where the identity probe alone is staged, apart from the whole broker tree. */
export const PTY_PROBE_NAMESPACE = "pty-probe";

/** What an attach needs from the runtime: the verified identity probe, and nothing that is executed as a session. */
export interface PtyProbeReadiness {
	readonly ready: boolean;
	readonly reason: string | null;
	readonly runtimeVersion: number;
	/** The digest this build's packaged broker tree has (what a broker of this build reports), computed without staging it. */
	readonly treeDigest: string | null;
	readonly helper: PtyProbeHelper | null;
}

const stagedProbes = new Map<string, PtyProbeHelper>();

/**
 * Stage and verify only the identity probe helper.
 *
 * Re-adopting an already-running broker reads its durable record, takes the kernel creation
 * time of the recorded pid through this helper, and authenticates with the record's token; it
 * never executes the staged broker tree, so the tree's self-check (which guards *starting* a
 * child under it) is not part of this path. The helper gets the same treatment as any staged
 * file: content-addressed, copied into owner-only storage, access-verified, and re-read and
 * re-hashed by the probe immediately before every spawn. The tree digest an attach compares a
 * broker's against is computed by hashing the packaged files, which writes nothing.
 */
export async function ensurePtyProbeHelper(options: PtyRuntimeOptions): Promise<PtyProbeReadiness> {
	const fail = (reason: string): PtyProbeReadiness => ({
		ready: false,
		reason,
		runtimeVersion: PTY_RUNTIME_VERSION,
		treeDigest: null,
		helper: null,
	});
	if (process.platform !== PTY_SUPPORTED_PLATFORM) {
		return fail(`the PTY broker is implemented and measured for ${PTY_SUPPORTED_PLATFORM} only; this host is ${process.platform}`);
	}
	let all: readonly RuntimeTreeSource[];
	let treeDigest: string;
	try {
		all = await ptyRuntimeSources(options.extensionRoot);
		treeDigest = (await hashRuntimeTree(all)).digest;
	} catch (error) {
		return fail(`the packaged broker tree could not be read: ${messageOf(error)}`);
	}
	const sources = all.filter(source => source.relativePath === PTY_PROBE_HELPER);
	if (sources.length !== 1) return fail(`the packaged broker tree is incomplete: ${PTY_PROBE_HELPER} is missing (run the build)`);
	let tree: StagedRuntimeTree;
	try {
		tree = await stageRuntimeTree({
			storageDir: options.storageDir,
			namespace: PTY_PROBE_NAMESPACE,
			sources,
			...(options.access === undefined ? {} : { access: options.access }),
		});
	} catch (error) {
		return fail(`the identity probe could not be staged: ${messageOf(error)}`);
	}
	const file = tree.files.find(candidate => candidate.relativePath === PTY_PROBE_HELPER);
	if (file === undefined) return fail("the staged identity probe went missing");
	const cacheKey = `${options.storageDir}\0${tree.digest}`;
	const known = stagedProbes.get(cacheKey);
	if (known !== undefined) return { ready: true, reason: null, runtimeVersion: PTY_RUNTIME_VERSION, treeDigest, helper: known };
	if (!(await verifyStagedRuntimeTree(tree))) return fail("the staged identity probe does not hold the bytes it was staged with");
	const helper: PtyProbeHelper = { path: file.path, sha256: file.sha256 };
	stagedProbes.set(cacheKey, helper);
	return { ready: true, reason: null, runtimeVersion: PTY_RUNTIME_VERSION, treeDigest, helper };
}

/**
 * Stage the broker tree and prove it.
 *
 * A ready answer means: every packaged file was copied into owner-only storage
 * outside the installed extension, every copy was re-hashed, the entry, the identity
 * probe and the owner-watch helper are all present, and the staged entry proved a
 * real child and a pipe child in the runtime that will be used for sessions. A tree
 * that fails any of that is reported unready with the reason, and the caller must
 * not start a broker from it.
 */
export async function ensurePtyRuntime(options: PtyRuntimeOptions): Promise<PtyRuntimeReadiness> {
	if (process.platform !== PTY_SUPPORTED_PLATFORM) {
		return {
			ready: false,
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
	for (const required of [PTY_BROKER_ENTRY, PTY_PROBE_HELPER, PTY_OWNER_HELPER]) {
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
	const helper = tree.files.find(file => file.relativePath === PTY_PROBE_HELPER);
	const ownerHelper = tree.files.find(file => file.relativePath === PTY_OWNER_HELPER);
	if (entry === undefined || helper === undefined || ownerHelper === undefined) {
		return notReady("the staged broker tree lost its entry, its identity probe or its owner-watch helper");
	}
	const cacheKey = `${options.storageDir}\0${tree.digest}\0${options.nodePath ?? ""}`;
	const cached = provedRuntimes.get(cacheKey);
	if (cached !== undefined) return readyAnswer(cached);
	if (!(await verifyStagedRuntimeTree(tree))) {
		return notReady("the staged broker tree does not hold the bytes it was staged with");
	}
	const check = await runSelfCheck({ entry, tree }, options);
	if (check.answer === null) {
		return notReady(check.detail, tree.digest);
	}
	const runtime: PtyRuntime = {
		tree,
		entry,
		helper: { path: helper.path, sha256: helper.sha256 },
		ownerHelper: { path: ownerHelper.path, sha256: ownerHelper.sha256 },
		entrySha256: entry.sha256,
		selfCheck: check.answer,
	};
	provedRuntimes.set(cacheKey, runtime);
	return readyAnswer(runtime);

	function notReady(reason: string, digest: string | null = null): PtyRuntimeReadiness {
		return {
			ready: false,
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
		reason: null,
		platform: process.platform,
		runtimeVersion: runtime.selfCheck.runtimeVersion,
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
	const child = spawn(command, [runtime.entry.path, ...args], {
		cwd: runtime.tree.directory,
		detached: true,
		windowsHide: true,
		stdio: ["ignore", "ignore", "ignore"],
		env: { ...env, ...options.env },
	});
	child.unref();
	return child;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
