/**
 * Content-addressed copies of the entries this extension runs *outside* its own
 * install folder.
 *
 * Two packaged files are executed from inside the installed extension folder:
 * the native host-control module the OMP process loads with `-e`
 * (`out/omp-host-control.mjs`) and the PowerShell peer helper
 * (`out/verified-pipe.ps1`). Every process reading one of them is a reference into
 * that folder, so `code --install-extension <vsix> --force` cannot rename it and
 * fails with EPERM ("Please restart VS Code before reinstalling"); a process that
 * outlives the extension host also keeps running the previous version's code,
 * because its own entry point is the old file.
 *
 * This module stages each of those files under
 * `<globalStorage>/runtime/<sha256>/<name>`: written to a temporary sibling name,
 * renamed over the whole path, and read back and re-hashed before it is handed
 * out. The digest in the path is the asset's identity, so two builds are always
 * two different copies and no caller can be handed one build's bytes under
 * another build's path. Callers re-verify the copy on every use
 * ({@link verifyStagedRuntimeAsset}) because a path is not a memory of what was
 * written to it.
 *
 * Access ([ADR-0006](../docs/decisions/0006-host-generated-key-peer-verified-pipe.md)):
 * the staged paths are *not* secret — they appear in the command line of the
 * processes that load them — but they are code that runs as this user, so no
 * other account may write them. The tree is verified through the shared private
 * storage convention (`src/host/private-storage.ts`), which this module describes
 * as a layout rather than re-implementing: the runtime directory and every digest
 * directory (the directories this module owns, rewritten non-recursively when not
 * yet limited and *before* any copy is written, so the copies inherit them), every
 * copy itself (a file's own entries decide whether its bytes can be replaced, and
 * a parent's entries never stand in for them), and every component the tree is
 * reached through — each parent of the storage directory up to but excluding the
 * operating system's own volume root, which the convention derives from the layout
 * rather than being told, and which is where the walk stops as the platform trust
 * anchor. Those components are verified but never rewritten, because whoever can
 * replace `runtime/` through one of them defeats everything below. Every one of
 * those paths must be a plain path (no symbolic link or reparse point), and on
 * Windows be owned by this account, SYSTEM, Administrators or TrustedInstaller
 * (with the `CREATOR OWNER`, `OWNER RIGHTS` and `SELF` placeholders resolved
 * against the verified owner); an entry of another principal refuses only when its
 * rights could replace or re-permission the component — merely creating or writing
 * inside a shared ancestor is tolerated, which is what lets a read-only system
 * directory stand on the path. On POSIX the owner must be this account or the
 * system root, and the mode bits count only while the listing shows no access
 * marker: a plain mode or GNU's context-only `.` is proof, while `+`, `@`, `%`, `?`
 * or an unrecognised marker refuses (Apple's `ls` prints `@` for extended
 * attributes *instead of* `+` for an ACL, so an attribute can hide one), as does a
 * listing that cannot be read. That is a fail-closed availability cost on macOS,
 * where ordinary downloads and Finder tags carry attributes.
 * All of that is the shared module's decision, not this module's: nothing here
 * re-reads an ACL, an owner or a mode, and this module passes no platform gate of
 * its own.
 *
 * Anything that cannot be shown to be owner-only refuses the stage, up to and
 * including the host-control channel not starting on that machine.
 * That is the intended price of running code no one has shown to be
 * write-protected.
 *
 * Bounds, stated rather than implied: this protects against another *user* writing
 * the staged code, and it does not claim protection from arbitrary code running as
 * this same user (the trust boundary of ADR-0006). Reading and hashing a copy
 * immediately before a spawn is a fresh reading, not an atomic
 * verify-then-execute; what keeps another account from
 * substituting code is the access verification above together with publication
 * that replaces a path instead of removing it.
 *
 * Copies of other builds are never removed from here. Nothing in this process can
 * prove that another window — which may still be starting a host from its own
 * copy — or an already running process does not need one, so they accumulate, one
 * small directory per build of the extension, until a cleanup exists that carries
 * that proof.
 */

import { createHash, randomBytes } from "node:crypto";
import { link, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import { restrictPrivateStorage, type PrivateStorageLayout, type PrivateStorageProbe } from "./host/private-storage.ts";

/** Directory inside extension global storage holding staged runtime assets. */
export const RUNTIME_ASSET_DIRECTORY = "runtime";

/** Fixed text the shared convention's write probe writes and reads back. */
const RUNTIME_PROBE_TEXT = "omp-runtime-asset-probe";

/** One verified copy: the path to run, and the digest that identifies its bytes. */
export interface StagedRuntimeAsset {
	/** Absolute path of the verified copy. */
	readonly path: string;
	/** `sha256` of the copy's bytes, hex. Also the name of its directory. */
	readonly sha256: string;
}

/** `sha256` of a file's bytes, or `null` when it cannot be read. */
async function digestOfFile(file: string): Promise<string | null> {
	try {
		return createHash("sha256").update(await readFile(file)).digest("hex");
	} catch {
		return null;
	}
}

/**
 * Re-read a staged copy and report whether it still holds the bytes its digest
 * names. Every caller checks this immediately before it starts a process on the
 * copy: a path that was correct when it was staged is not a promise about now.
 */
export async function verifyStagedRuntimeAsset(asset: StagedRuntimeAsset): Promise<boolean> {
	return (await digestOfFile(asset.path)) === asset.sha256;
}

/**
 * Establish and verify owner-only write access over every path a staged copy
 * depends on, through the shared private storage convention.
 *
 * `directories` are the directories this module owns (the runtime directory and the
 * digest directories) and the only ones a rewrite may touch; `files` are the copies
 * about to be handed out. The ancestors the tree is reached through are derived by
 * the shared convention from `root` and verified there, never rewritten. A layout
 * field this module does not set is one it does not need: no workspace root (the
 * tree is not workspace-bound), no separate verified directory set (`root` and
 * `directories` are the closed set it hands copies out of) and no carrier list.
 */
async function ensureRuntimeAccess(input: {
	readonly root: string;
	readonly directories: readonly string[];
	readonly files: readonly string[];
	readonly probe: PrivateStorageProbe | undefined;
}): Promise<void> {
	const layout: PrivateStorageLayout = {
		root: input.root,
		directories: input.directories,
		// The set this module hands copies out of is closed: `root` and the digest
		// directories are its own (rewritten when needed), and nothing else is read as
		// one of its stores.
		verifiedDirectories: [],
		verifiedFiles: input.files,
		probeDirectory: input.root,
		probeText: RUNTIME_PROBE_TEXT,
	};
	const restriction = await restrictPrivateStorage({
		layout,
		...(input.probe === undefined ? {} : { probe: input.probe }),
	});
	if (!restriction.restricted) {
		throw new Error(
			`the staged runtime tree is not usable: ${restriction.reason ?? "its access could not be established"}`,
		);
	}
}

/**
 * Stage every packaged file named by `sourcePaths`, in order, and verify the
 * access over the tree they were written into.
 *
 * Each copy keeps the source file's own name inside a directory named by its
 * digest. A copy that already exists with the right bytes is reused as is;
 * anything else at that path is replaced atomically. The caller keeps the
 * returned paths — and their digests — for as long as it runs children from
 * them, re-verifying each copy before every use.
 */
export async function stageRuntimeAssets(input: {
	readonly storageDir: string;
	readonly sourcePaths: readonly string[];
	readonly access?: PrivateStorageProbe;
}): Promise<readonly StagedRuntimeAsset[]> {
	const storageDir = input.storageDir;
	if (typeof storageDir !== "string" || storageDir.length === 0) {
		throw new Error("staging runtime assets needs the extension storage directory");
	}
	const root = join(storageDir, RUNTIME_ASSET_DIRECTORY);
	await mkdir(root, { recursive: true, mode: 0o700 });
	// The rules are established and verified *before* anything is written, so every
	// copy inherits entries no other account has: a directory rewritten afterwards
	// could not fix a file that was written under the old entries. The ancestors the
	// tree is reached through are verified in the same call, because whoever can
	// replace the tree through one of them defeats everything inside it.
	await ensureRuntimeAccess({ root, directories: [root], files: [], probe: input.access });

	const staged: StagedRuntimeAsset[] = [];
	const directories: string[] = [root];
	for (const sourcePath of input.sourcePaths) {
		const copy = await stageRuntimeAsset(storageDir, sourcePath);
		staged.push(copy);
		const directory = join(storageDir, RUNTIME_ASSET_DIRECTORY, copy.sha256);
		if (!directories.includes(directory)) directories.push(directory);
	}
	// The copies and their directories exist now, and they are what a substitution
	// would have to write through: verify everything this call hands out.
	await ensureRuntimeAccess({
		root,
		directories,
		files: staged.map(copy => copy.path),
		probe: input.access,
	});
	return staged;
}

async function stageRuntimeAsset(storageDir: string, sourcePath: string): Promise<StagedRuntimeAsset> {
	const name = basename(sourcePath);
	if (name.length === 0 || name === "." || name === "..") {
		throw new Error(`runtime asset ${JSON.stringify(sourcePath)} has no file name to stage under`);
	}
	const bytes = await readFile(sourcePath);
	const sha256 = createHash("sha256").update(bytes).digest("hex");
	const directory = join(storageDir, RUNTIME_ASSET_DIRECTORY, sha256);
	const target = join(directory, name);
	// Already staged and still byte-identical: nothing is written.
	if ((await digestOfFile(target)) === sha256) return { path: target, sha256 };

	await mkdir(directory, { recursive: true, mode: 0o700 });
	const temporary = `${target}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
	await writeFile(temporary, bytes, { mode: 0o600 });
	try {
		// Publication first tries `link`, which creates the path only when it does not
		// exist yet: a second staging of the same digest that races this one therefore
		// sees an ordinary "already there" answer instead of a lost update or a Windows
		// sharing violation. Where hard links are unavailable the replacement below runs
		// instead, and the outcome is the same bytes at the same path.
		if (!(await publishNewCopy(temporary, target))) {
			await replaceCopy(temporary, target, sha256);
			// A concurrent publisher of these very bytes can make the replacement fail
			// even though the path now holds what this call verified; the hash below
			// decides, and a path that holds something else is still refused.
		}
	} finally {
		await rm(temporary, { force: true }).catch(() => {});
	}
	// Verified by hash before it is handed out: a truncated or substituted copy is
	// a failure here, never a process started on unknown bytes.
	if ((await digestOfFile(target)) !== sha256) {
		throw new Error(`the runtime copy ${target} does not match the digest of ${sourcePath}`);
	}
	return { path: target, sha256 };
}

/**
 * Create `target` from the verified `temporary`, or report that it already exists.
 *
 * `true` means this call published the copy. `false` means the path is occupied —
 * by another staging of the same digest, or by something that has to be replaced —
 * and also covers a filesystem that cannot hard-link, where the caller replaces
 * instead. Nothing is written over here, so a racing publisher is never corrupted.
 */
async function publishNewCopy(temporary: string, target: string): Promise<boolean> {
	try {
		await link(temporary, target);
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException | null)?.code;
		for (const expected of ["EEXIST", "EPERM", "EACCES", "ENOSYS", "ENOTSUP", "EXDEV", "EMLINK"]) {
			if (code === expected) return false;
		}
		throw error;
	}
}

/**
 * Replace the whole path in one step, leaving it in place on failure.
 *
 * Nothing is removed first: another window may already have handed this path to a
 * process, and that copy has to stay readable until the replacement lands, so
 * there is no moment at which the path is absent.
 */
async function replaceCopy(temporary: string, target: string, sha256: string): Promise<void> {
	try {
		await rename(temporary, target);
	} catch (error) {
		// Another process can publish exactly these bytes between the reuse check and
		// this replacement, which Windows reports as a sharing violation rather than as
		// the success it is. The caller's hash check accepts that case; a path holding
		// anything else is refused here, with whatever was there left as it is.
		if ((await digestOfFile(target)) === sha256) return;
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(
			`the runtime copy ${target} could not be replaced atomically (${detail}); whatever was there was left as it is`,
		);
	}
}

/**
 * One file of a tree to stage: where it is packaged, and where it must appear
 * inside the staged copy.
 *
 * The relative path is part of the copy's identity, not a convenience: the PTY
 * broker loads its native addon and the `conpty.dll`/`OpenConsole.exe` beside it
 * through paths relative to the staged directory, and the `node-pty` package is
 * loaded as a package, so its internal layout has to survive staging exactly.
 */
export interface RuntimeTreeSource {
	readonly relativePath: string;
	/** Absolute path of the packaged file. */
	readonly sourcePath: string;
}

/** One staged copy inside a tree, with where it sits in that tree. */
export interface StagedRuntimeTreeFile extends StagedRuntimeAsset {
	readonly relativePath: string;
}

/** A staged tree: one directory, the digest naming its whole content, and its files. */
export interface StagedRuntimeTree {
	/** Absolute path of the staged directory. */
	readonly directory: string;
	/**
	 * `sha256` over every file's relative path and bytes. The directory is named by
	 * it, so two builds can never be handed each other's tree.
	 */
	readonly digest: string;
	readonly files: readonly StagedRuntimeTreeFile[];
}

/** A file inside a staged tree, addressed by its path relative to the tree root. */
export function stagedTreeFile(tree: StagedRuntimeTree, relativePath: string): StagedRuntimeAsset | null {
	return tree.files.find(file => file.relativePath === relativePath) ?? null;
}

/** Every file below `directory`, as paths relative to it, in a stable order. */
export async function listRuntimeTreeFiles(directory: string): Promise<string[]> {
	const entries = await readdir(directory, { recursive: true, withFileTypes: true });
	const paths: string[] = [];
	for (const entry of entries) {
		if (!entry.isFile()) continue;
		const absolute = join(entry.parentPath, entry.name);
		paths.push(relative(directory, absolute).split(sep).join("/"));
	}
	return paths.sort();
}

/**
 * Hash every source once and name the tree from its content.
 *
 * Read-only: nothing is written. The digest is what a broker of this build reports as its
 * tree, so it can be computed without staging the tree (an attach compares it).
 */
export async function hashRuntimeTree(
	sources: readonly RuntimeTreeSource[],
): Promise<{
	readonly digests: ReadonlyArray<{ readonly relativePath: string; readonly sourcePath: string; readonly sha256: string }>;
	readonly digest: string;
}> {
	const digests: Array<{ readonly relativePath: string; readonly sourcePath: string; readonly sha256: string }> = [];
	let manifest = "";
	for (const source of [...sources].sort((left, right) => left.relativePath.localeCompare(right.relativePath))) {
		const clean = source.relativePath.replace(/\\/g, "/");
		if (clean.length === 0 || clean.startsWith("/") || clean.split("/").some(part => part === "" || part === "." || part === "..")) {
			throw new Error(`runtime tree entry ${JSON.stringify(source.relativePath)} is not a relative path inside the tree`);
		}
		const bytes = await readFile(source.sourcePath);
		const sha256 = createHash("sha256").update(bytes).digest("hex");
		digests.push({ relativePath: clean, sourcePath: source.sourcePath, sha256 });
		manifest += `${clean}\0${sha256}\n`;
	}
	// A format marker is part of the digest so a later layout change cannot collide
	// with an older tree that happened to hold the same files.
	const digest = createHash("sha256").update(`omp-runtime-tree/v1\n${manifest}`).digest("hex");
	return { digests, digest };
}

/**
 * Stage a whole tree of packaged files as one content-addressed copy.
 *
 * Every file is written into `<runtimeDir>/<treeDigest>/` at its own relative path:
 * the digest is computed from the *content* of the tree (each file's digest together
 * with its relative path), so a tree that already exists with that name holds exactly
 * those bytes, and a build that changes one file gets a different name and a
 * different digest. Nothing evicts an older tree — the same reasoning as
 * {@link stageRuntimeAssets}: a process started from it may still be running, and no
 * one here can prove otherwise.
 *
 * The access rules are established and verified before the copies are handed out,
 * through the shared private storage convention over a layout this function
 * describes: the runtime directory, the tree directory and every directory inside it
 * are the directories this module owns; the copies and their intermediate
 * directories are verified as files and directories; the ancestors are derived by
 * the convention.
 */
export async function stageRuntimeTree(input: {
	readonly storageDir: string;
	/** Directory inside the runtime directory holding trees; keeps them out of the flat single-file layout. */
	readonly namespace: string;
	readonly sources: readonly RuntimeTreeSource[];
	readonly access?: PrivateStorageProbe;
}): Promise<StagedRuntimeTree> {
	if (typeof input.storageDir !== "string" || input.storageDir.length === 0) {
		throw new Error("staging a runtime tree needs the extension storage directory");
	}
	if (typeof input.namespace !== "string" || !/^[a-z0-9-]{1,64}$/.test(input.namespace)) {
		throw new Error("a staged runtime tree needs a plain namespace name");
	}
	if (input.sources.length === 0) throw new Error("staging a runtime tree needs at least one file");
	const root = join(input.storageDir, RUNTIME_ASSET_DIRECTORY);
	const namespaced = join(root, input.namespace);
	await mkdir(namespaced, { recursive: true, mode: 0o700 });

	const { digests, digest } = await hashRuntimeTree(input.sources);
	const directory = join(namespaced, digest);

	await ensureRuntimeAccess({ root, directories: [root, namespaced], files: [], probe: input.access });
	const directories: string[] = [root, namespaced, directory];
	const files: StagedRuntimeTreeFile[] = [];
	for (const entry of digests) {
		const target = join(directory, ...entry.relativePath.split("/"));
		for (let parent = dirname(target); parent.length > directory.length; parent = dirname(parent)) {
			if (!directories.includes(parent)) directories.push(parent);
		}
		await mkdir(dirname(target), { recursive: true, mode: 0o700 });
		files.push(await publishTreeFile(entry.sourcePath, entry.relativePath, target, entry.sha256));
	}
	// Verified again after the writes: what a substitution would have had to write
	// through is now in the layout, and every copy is checked as a file.
	await ensureRuntimeAccess({ root, directories, files: files.map(file => file.path), probe: input.access });
	return { directory, digest, files };
}

/**
 * Publish one tree file, reusing an identical path and replacing anything else.
 *
 * Same rules as {@link stageRuntimeAsset}: the publication creates the path rather
 * than removing it, so a racing staging of the same digest is an ordinary outcome
 * and no reader ever sees the path absent.
 */
async function publishTreeFile(
	sourcePath: string,
	relativePath: string,
	target: string,
	sha256: string,
): Promise<StagedRuntimeTreeFile> {
	if ((await digestOfFile(target)) === sha256) return { path: target, relativePath, sha256 };
	const bytes = await readFile(sourcePath);
	const temporary = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
	await writeFile(temporary, bytes, { mode: 0o600 });
	try {
		if (!(await publishNewCopy(temporary, target))) await replaceCopy(temporary, target, sha256);
	} finally {
		await rm(temporary, { force: true }).catch(() => {});
	}
	if ((await digestOfFile(target)) !== sha256) {
		throw new Error(`the staged tree file ${target} does not match the digest of ${sourcePath}`);
	}
	return { path: target, relativePath, sha256 };
}

/** Re-read a staged tree and report whether every file still holds its own bytes. */
export async function verifyStagedRuntimeTree(tree: StagedRuntimeTree): Promise<boolean> {
	for (const file of tree.files) {
		if (!(await verifyStagedRuntimeAsset(file))) return false;
	}
	return true;
}
