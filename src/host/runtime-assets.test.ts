/**
 * Regression tests for content-addressed runtime assets.
 *
 * Runner: `node --test src/host/runtime-assets.test.ts`
 *
 * These copies are what the native host-control module and the PowerShell peer
 * helper are run from, so what matters is that a copy is complete, verifiable by
 * digest at any moment, lives outside the installed extension folder, is
 * replaced atomically rather than reused when the packaged file changes, is
 * never removed while another window might still need it, and sits in a tree no
 * other account can write — including the copies themselves, the directories
 * that hold them and the directories the tree is reachable through.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import {
	RUNTIME_ASSET_DIRECTORY,
	stageRuntimeAssets,
	stageRuntimeTree,
	verifyStagedRuntimeAsset,
} from "./runtime-assets.ts";
import { readStorageSecurity, type PrivateStorageCommandResult, type PrivateStorageProbe } from "./private-storage.ts";
import { loadWin32Native, setWin32NativeForTest } from "./win32-native.ts";
import { installedAddonAsset } from "./win32-test-support.ts";
import { TEST_CURRENT_SID, fixtureAcl, fixturePrincipal } from "./private-storage-test-support.ts";

/** The account a simulated Windows probe runs as. */
const ACCOUNT = "WORKSTATION\\dev";
/** The entries a probe reports for a tree only this account, SYSTEM and Administrators may write. */
const OWNER_ONLY = [ACCOUNT, "NT AUTHORITY\\SYSTEM", "BUILTIN\\Administrators"];

const roots: string[] = [];

async function makeRoot(): Promise<string> {
	const root = await mkdtemp(path.join(tmpdir(), "omp-runtime-"));
	roots.push(root);
	return root;
}

/** A packaged entry inside a fake install folder under `root`. */
async function makePackagedFile(root: string, name: string, content: string): Promise<string> {
	const directory = path.join(root, "install", "out");
	await mkdir(directory, { recursive: true });
	const file = path.join(directory, name);
	await writeFile(file, content, "utf8");
	return file;
}

function digestOf(content: string): string {
	return createHash("sha256").update(content, "utf8").digest("hex");
}

/** The staged path these bytes would take. */
function stagedPathOf(storageDir: string, name: string, content: string): string {
	return path.join(storageDir, RUNTIME_ASSET_DIRECTORY, digestOf(content), name);
}

/** An `icacls` listing naming exactly the given principals. */
function aclListing(target: string, principals: readonly string[]): string {
	return fixtureAcl(principals.map(principal => `${principal}:(OI)(CI)(F)`));
}

interface AccessProbe {
	readonly probe: PrivateStorageProbe;
	/** Every argument list the restriction was applied with. */
	readonly applied: string[][];
	/** The paths of every verification pass, in order: a pass reads the owners of its paths exactly once. */
	readonly passes: string[][];
}

interface ProbeOptions {
	/** What every path's access listing reports; `null` means the read fails. */
	readonly acl?: readonly string[] | null;
	/** What it reports once the rewrite ran; omitted leaves `acl` in place. */
	readonly aclAfterRewrite?: readonly string[] | null;
	/** Paths whose listing reports `Everyone` instead (an explicitly permissive entry). */
	readonly permissive?: (target: string) => boolean;
	/** Owner each path reports. */
	readonly ownerOf?: (path: string) => string;
	/** Path left out of the owner answer, as an unreadable owner would be. */
	readonly omitPath?: string;
	/** Make the whole owner read fail. */
	readonly ownerReadFails?: boolean;
	/** Runs when a verification pass reads its owners, before it answers: what the tree looks like at that moment. */
	readonly onPass?: (paths: readonly string[]) => Promise<void> | void;
}

/**
 * A Windows access seam, injected at the same two probe fields the shared
 * convention defines, so a caller's probe means one thing everywhere.
 */
function windowsProbe(options: ProbeOptions = {}): AccessProbe {
	const applied: string[][] = [];
	const passes: string[][] = [];
	let current = options.acl === undefined ? OWNER_ONLY : options.acl;
	const probe: PrivateStorageProbe = {
		platform: "win32",
		currentSid: TEST_CURRENT_SID,
		readAcl: async (target: string): Promise<PrivateStorageCommandResult> => {
			if (current === null) return { ok: false, stdout: "", detail: "icacls is unavailable" };
			if (options.permissive?.(target) === true) return { ok: true, stdout: aclListing(target, ["Everyone"]), detail: null };
			return { ok: true, stdout: aclListing(target, current), detail: null };
		},
		applyIcacls: async (_target: string, args: readonly string[]): Promise<PrivateStorageCommandResult> => {
			applied.push([...args]);
			if (options.aclAfterRewrite !== undefined) current = options.aclAfterRewrite;
			return { ok: true, stdout: "", detail: null };
		},
		readOwners: async (paths: readonly string[]): Promise<PrivateStorageCommandResult> => {
			passes.push([...paths]);
			await options.onPass?.(paths);
			if (options.ownerReadFails === true) return { ok: false, stdout: "", detail: "Get-Acl failed" };
			const ownerOf = options.ownerOf ?? ((): string => ACCOUNT);
			return {
				ok: true,
				stdout: paths
					.filter(path => path !== options.omitPath)
					.map(path => `${path}|${fixturePrincipal(ownerOf(path))}`)
					.join("\r\n"),
				detail: null,
			};
		},
	};
	return { probe, applied, passes };
}

/** Run the real System32 `icacls` on one path. */
function realIcacls(args: readonly string[]): Promise<void> {
	const deferred = Promise.withResolvers<void>();
	const child = spawn(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe"), [...args], {
		windowsHide: true,
	});
	child.on("close", () => deferred.resolve());
	child.on("error", () => deferred.resolve());
	return deferred.promise;
}

/** Give one directory the rules the shared convention establishes, with the real tool. */
async function restrictWithRealTool(directory: string): Promise<void> {
	const account = (await readStorageSecurity([directory])).sid;
	assert.ok(account !== null, "the test account SID could not be read");
	await realIcacls([
		directory,
		"/inheritance:r",
		"/grant:r",
		`*${account}:(OI)(CI)(F)`,
		"*S-1-5-18:(OI)(CI)(F)",
		"*S-1-5-32-544:(OI)(CI)(F)",
		"/Q",
	]);
}

before(async () => {
	if (process.platform === "win32") setWin32NativeForTest(await loadWin32Native(await installedAddonAsset()));
});

after(async () => {
	setWin32NativeForTest(undefined);
	await Promise.all(roots.map(root => rm(root, { recursive: true, force: true }).catch(() => {})));
});

describe("staged runtime assets", () => {
	it("copies a packaged entry under its digest, outside the install folder", async () => {
		const root = await makeRoot();
		const source = await makePackagedFile(root, "relay.js", "console.log('relay');\n");
		const { probe } = windowsProbe();
		const [staged] = await stageRuntimeAssets({ storageDir: root, sourcePaths: [source], access: probe });

		assert.equal(staged.sha256, digestOf("console.log('relay');\n"));
		assert.equal(staged.path, path.join(root, RUNTIME_ASSET_DIRECTORY, staged.sha256, "relay.js"));
		assert.equal(await readFile(staged.path, "utf8"), "console.log('relay');\n");
		assert.equal(
			path.relative(path.join(root, "install"), staged.path).startsWith(".."),
			true,
			"the copy a child runs is not inside the folder a reinstall renames",
		);
		assert.equal(await verifyStagedRuntimeAsset(staged), true);
	});

	it(
		"refuses a tree under a writable ancestor with the real tools",
		{ skip: process.platform !== "win32" },
		async () => {
			const root = await makeRoot();
			// The ancestor another account may write is made here, not borrowed from the
			// temporary directory: whether that one is shared depends on the machine.
			const shared = path.join(root, "shared");
			await mkdir(shared, { recursive: true });
			await realIcacls([shared, "/grant", "*S-1-1-0:(OI)(CI)(M)", "/Q"]);
			const tree = path.join(shared, "ompsandbox");
			await mkdir(tree, { recursive: true });
			await restrictWithRealTool(tree);
			const source = await makePackagedFile(root, "verified-pipe.ps1", "param()\n");

			// The tree itself is owned and restricted, but it sits under a directory
			// Everyone may modify: the shared rule refuses the carrier, and the stage must
			// fail closed.
			await assert.rejects(
				stageRuntimeAssets({ storageDir: path.join(tree, "globalStorage"), sourcePaths: [source] }),
				/lets S-1-1-0(?: \([^\r\n]*\))? replace or re-permission it/,
			);
		},
	);

	it(
		"stages under a clean ancestor chain with the real tools",
		{ skip: process.platform !== "win32" },
		async () => {
			// A chain this account owns all the way up to (but excluding) the volume root,
			// as the extension's own profile storage is. `LocalAppData` is shared read-only
			// here, which the carrier rule accepts, while the temporary directory is not.
			const localAppData = process.env.LOCALAPPDATA ?? "";
			if (localAppData.length === 0) return;
			const root = await mkdtemp(path.join(localAppData, "omp-runtime-"));
			roots.push(root);
			const source = await makePackagedFile(root, "verified-pipe.ps1", "param()\n");

			// Real `icacls`, real ancestor walk, real owner read and real rename
			// publication: no seam is injected at all.
			const [staged] = await stageRuntimeAssets({ storageDir: path.join(root, "globalStorage"), sourcePaths: [source] });

			assert.equal(await readFile(staged.path, "utf8"), "param()\n");
			assert.equal(await verifyStagedRuntimeAsset(staged), true);
		},
	);

	it("reuses a byte-identical copy instead of writing it again", async () => {
		const root = await makeRoot();
		const source = await makePackagedFile(root, "relay.js", "module.exports = 1;\n");
		const { probe } = windowsProbe();
		const [first] = await stageRuntimeAssets({ storageDir: root, sourcePaths: [source], access: probe });
		const before = await stat(first.path);

		const [second] = await stageRuntimeAssets({ storageDir: root, sourcePaths: [source], access: probe });

		assert.equal(second.path, first.path);
		assert.equal(second.sha256, first.sha256);
		assert.equal((await stat(second.path)).mtimeMs, before.mtimeMs, "an identical copy is not rewritten");
		assert.deepEqual(await readdir(path.dirname(first.path)), ["relay.js"], "no temporary file is left behind");
	});

	it("replaces a staged copy whose bytes no longer match its digest", async () => {
		const root = await makeRoot();
		const source = await makePackagedFile(root, "verified-pipe.ps1", "param()\n");
		const { probe } = windowsProbe();
		const [staged] = await stageRuntimeAssets({ storageDir: root, sourcePaths: [source], access: probe });
		await writeFile(staged.path, "tampered\n", "utf8");

		const [restaged] = await stageRuntimeAssets({ storageDir: root, sourcePaths: [source], access: probe });

		assert.equal(restaged.sha256, digestOf("param()\n"));
		assert.equal(await readFile(restaged.path, "utf8"), "param()\n", "a tampered copy is never handed out");
		assert.equal(await verifyStagedRuntimeAsset(restaged), true);
	});

	it("refuses a path it cannot replace atomically instead of removing it", async () => {
		const root = await makeRoot();
		const source = await makePackagedFile(root, "relay.js", "0;\n");
		const target = stagedPathOf(root, "relay.js", "0;\n");
		// A directory in place of the copy: closing this in place is impossible, and a
		// removal would be the alternative — which must not happen, because another
		// window may already have handed that path to a process.
		await mkdir(target, { recursive: true });
		await writeFile(path.join(target, "keep.txt"), "keep", "utf8");
		const { probe } = windowsProbe();

		await assert.rejects(
			stageRuntimeAssets({ storageDir: root, sourcePaths: [source], access: probe }),
			/could not be replaced atomically/,
		);
		assert.equal(await readFile(path.join(target, "keep.txt"), "utf8"), "keep", "the existing path is left as it is");
	});

	it("publishes one copy when three first stagings of it run at once", async () => {
		const root = await makeRoot();
		const source = await makePackagedFile(root, "omp-host-control.mjs", "export const v = 1;\n");
		const { probe } = windowsProbe();

		// No pre-existing copy: the three calls below race to publish this digest for the
		// first time, which is what the temporary-name uniqueness and the atomic replace
		// have to survive. (The reuse case is covered by its own test.)
		const staged = (
			await Promise.all([
				stageRuntimeAssets({ storageDir: root, sourcePaths: [source], access: probe }),
				stageRuntimeAssets({ storageDir: root, sourcePaths: [source], access: probe }),
				stageRuntimeAssets({ storageDir: root, sourcePaths: [source], access: probe }),
			])
		).map(([asset]) => asset!);

		const [first] = staged;
		for (const asset of staged) {
			assert.equal(asset.path, first.path, "every concurrent staging publishes the same path");
			assert.equal(asset.sha256, first.sha256, "every concurrent staging hands out the same digest");
		}
		assert.equal(await readFile(first.path, "utf8"), "export const v = 1;\n", "the published path always reads back");
		assert.deepEqual(
			await readdir(path.dirname(first.path)),
			["omp-host-control.mjs"],
			"one copy, and no temporary file survives a concurrent first publication",
		);
	});

	it("keeps the copy of a build this window does not run", async () => {
		const root = await makeRoot();
		const first = await makePackagedFile(root, "omp-host-control.mjs", "export const v = 1;\n");
		const { probe } = windowsProbe();
		const [older] = await stageRuntimeAssets({ storageDir: root, sourcePaths: [first], access: probe });

		const second = await makePackagedFile(root, "omp-host-control.mjs", "export const v = 2;\n");
		const [newer] = await stageRuntimeAssets({ storageDir: root, sourcePaths: [second], access: probe });

		assert.notEqual(newer.sha256, older.sha256, "two builds are two copies");
		assert.equal(
			existsSync(older.path),
			true,
			"another window may still be starting a host from its own copy, so nothing here removes it",
		);
		assert.equal(await readFile(newer.path, "utf8"), "export const v = 2;\n");
	});

	it("reports a copy whose bytes changed after it was staged", async () => {
		const root = await makeRoot();
		const source = await makePackagedFile(root, "relay.js", "0;\n");
		const { probe } = windowsProbe();
		const [staged] = await stageRuntimeAssets({ storageDir: root, sourcePaths: [source], access: probe });

		await writeFile(staged.path, "substituted\n", "utf8");
		assert.equal(await verifyStagedRuntimeAsset(staged), false);

		await rm(staged.path, { force: true });
		assert.equal(await verifyStagedRuntimeAsset(staged), false, "a missing copy is not a verified copy");
	});

	it("accepts a tree limited to this account, SYSTEM and Administrators", async () => {
		const root = await makeRoot();
		const source = await makePackagedFile(root, "relay.js", "0;\n");
		const { probe, applied } = windowsProbe({ acl: [ACCOUNT, "CREATOR OWNER", "NT AUTHORITY\\SYSTEM", "BUILTIN\\Administrators"] });

		await stageRuntimeAssets({ storageDir: root, sourcePaths: [source], access: probe });

		assert.deepEqual(applied, [], "a tree that already meets the rule is not rewritten");
	});

	describe("verification passes", () => {
		const sourcesOf = async (root: string, files: Record<string, string>) =>
			await Promise.all(
				Object.entries(files).map(async ([relativePath, content]) => ({
					relativePath,
					sourcePath: await makePackagedFile(root, relativePath.replaceAll("/", "_"), content),
				})),
			);
		const has = (pass: readonly string[], file: string): boolean => pass.some(entry => entry.toLowerCase() === file.toLowerCase());

		it("verifies the rules before the first byte is written and the finished layout after it, when it writes", async () => {
			const root = await makeRoot();
			const source = await makePackagedFile(root, "relay.js", "0;\n");
			const target = stagedPathOf(root, "relay.js", "0;\n");
			let existedAtFirstPass: boolean | null = null;
			const { probe, passes } = windowsProbe({ onPass: () => { existedAtFirstPass ??= existsSync(target); } });

			await stageRuntimeAssets({ storageDir: root, sourcePaths: [source], access: probe });

			assert.equal(passes.length, 2, "a staging that writes keeps its two passes");
			assert.equal(existedAtFirstPass, false, "the first pass ran before the copy existed");
			assert.equal(has(passes[0]!, target), false);
			assert.equal(has(passes[1]!, target), true, "the closing pass checks the copy as a file");
		});

		it("verifies the whole final layout once, and writes nothing, when every copy is already in place", async () => {
			const root = await makeRoot();
			const source = await makePackagedFile(root, "relay.js", "0;\n");
			const target = stagedPathOf(root, "relay.js", "0;\n");
			await stageRuntimeAssets({ storageDir: root, sourcePaths: [source], access: windowsProbe().probe });
			const before = await stat(target);
			const { probe, passes, applied } = windowsProbe();

			const [staged] = await stageRuntimeAssets({ storageDir: root, sourcePaths: [source], access: probe });

			assert.equal(staged!.path, target);
			assert.equal(passes.length, 1, "one pass instead of two");
			assert.equal(has(passes[0]!, target), true, "the one pass covers the copy as a file");
			assert.equal(has(passes[0]!, path.dirname(target)), true, "and the digest directory");
			assert.equal((await stat(target)).mtimeMs, before.mtimeMs, "nothing was written");
			assert.deepEqual(applied, []);
		});

		it("still refuses, after its one pass, a copy that is in place but owned by another account", async () => {
			const root = await makeRoot();
			const source = await makePackagedFile(root, "relay.js", "0;\n");
			const target = stagedPathOf(root, "relay.js", "0;\n");
			await stageRuntimeAssets({ storageDir: root, sourcePaths: [source], access: windowsProbe().probe });
			const { probe, passes } = windowsProbe({ ownerOf: entry => (entry === target ? "WORKSTATION\\someone-else" : ACCOUNT) });

			await assert.rejects(
				stageRuntimeAssets({ storageDir: root, sourcePaths: [source], access: probe }),
				/owned by S-1-5-21-100-200-300-1002/,
			);
			assert.equal(passes.length, 1);
		});

		it("still refuses a copy in place whose own entry lets another account write it", async () => {
			const root = await makeRoot();
			const source = await makePackagedFile(root, "relay.js", "0;\n");
			const target = stagedPathOf(root, "relay.js", "0;\n");
			await stageRuntimeAssets({ storageDir: root, sourcePaths: [source], access: windowsProbe().probe });
			const { probe } = windowsProbe({ permissive: candidate => candidate === target });

			await assert.rejects(
				stageRuntimeAssets({ storageDir: root, sourcePaths: [source], access: probe }),
				/is readable by S-1-1-0 \(Everyone\)/,
			);
		});

		it("rewrites an unrestricted runtime directory before a staging that writes nothing returns it", async () => {
			const root = await makeRoot();
			const source = await makePackagedFile(root, "relay.js", "0;\n");
			await stageRuntimeAssets({ storageDir: root, sourcePaths: [source], access: windowsProbe().probe });
			const { probe, applied } = windowsProbe({ acl: ["Everyone"], aclAfterRewrite: OWNER_ONLY });

			await stageRuntimeAssets({ storageDir: root, sourcePaths: [source], access: probe });

			assert.ok(applied.length > 0, "the directories this module owns are limited before the copy is handed out");
		});

		it("takes both passes again when one of several copies is missing, and the first sees it missing", async () => {
			const root = await makeRoot();
			const first = await makePackagedFile(root, "a.js", "a;\n");
			const second = await makePackagedFile(root, "b.js", "b;\n");
			await stageRuntimeAssets({ storageDir: root, sourcePaths: [first, second], access: windowsProbe().probe });
			const lost = stagedPathOf(root, "b.js", "b;\n");
			await rm(lost);
			let lostAtFirstPass: boolean | null = null;
			const { probe, passes } = windowsProbe({ onPass: () => { lostAtFirstPass ??= !existsSync(lost); } });

			await stageRuntimeAssets({ storageDir: root, sourcePaths: [first, second], access: probe });

			assert.equal(passes.length, 2);
			assert.equal(lostAtFirstPass, true, "the missing copy is written only after the first pass");
			assert.equal(await readFile(lost, "utf8"), "b;\n");
		});

		it("takes both passes for a tree it writes and one for a tree already complete", async () => {
			const root = await makeRoot();
			const sources = await sourcesOf(root, { "entry.js": "1;\n", "lib/part.js": "2;\n" });
			const written = windowsProbe();

			const tree = await stageRuntimeTree({ storageDir: root, namespace: "tree", sources, access: written.probe });
			assert.equal(written.passes.length, 2);
			assert.equal(has(written.passes[0]!, tree.files[0]!.path), false, "the first pass is ahead of every write");

			const again = windowsProbe();
			const before = await stat(tree.files[0]!.path);
			const reused = await stageRuntimeTree({ storageDir: root, namespace: "tree", sources, access: again.probe });
			assert.equal(again.passes.length, 1);
			assert.equal(reused.directory, tree.directory);
			assert.deepEqual(reused.files, tree.files);
			assert.equal((await stat(tree.files[0]!.path)).mtimeMs, before.mtimeMs, "nothing was written");
			for (const file of tree.files) assert.equal(has(again.passes[0]!, file.path), true, "every file is verified as a file");
			assert.equal(has(again.passes[0]!, tree.directory), true, "and the tree's own directory");
			assert.equal(has(again.passes[0]!, path.join(tree.directory, "lib")), true, "and the directory inside the tree");
		});

		it("reads the copies again after its one pass, and writes the ones that no longer hold as in a first staging (an asset)", async () => {
			const root = await makeRoot();
			const source = await makePackagedFile(root, "relay.js", "0;\n");
			const [staged] = await stageRuntimeAssets({ storageDir: root, sourcePaths: [source], access: windowsProbe().probe });
			// The copy is replaced while the one pass runs: a substitution that the pass, which judges access and not bytes, cannot see.
			let replaced = false;
			const { probe, passes } = windowsProbe({ onPass: async () => { if (!replaced) { replaced = true; await writeFile(staged!.path, "substituted\n", "utf8"); } } });

			const [again] = await stageRuntimeAssets({ storageDir: root, sourcePaths: [source], access: probe });

			assert.equal(passes.length, 3, "the no-write pass, then a first staging's two");
			assert.equal(await readFile(again!.path, "utf8"), "0;\n", "the bytes handed out were read after the rules held");
		});

		it("reads a tree's copies again after its one pass, and writes the ones that no longer hold", async () => {
			const root = await makeRoot();
			const sources = await sourcesOf(root, { "entry.js": "1;\n", "lib/part.js": "2;\n" });
			const tree = await stageRuntimeTree({ storageDir: root, namespace: "tree", sources, access: windowsProbe().probe });
			let replaced = false;
			const { probe, passes } = windowsProbe({ onPass: async () => { if (!replaced) { replaced = true; await writeFile(tree.files[1]!.path, "substituted\n", "utf8"); } } });

			const again = await stageRuntimeTree({ storageDir: root, namespace: "tree", sources, access: probe });

			assert.equal(passes.length, 3);
			for (const file of again.files) assert.equal(await verifyStagedRuntimeAsset(file), true, "every copy holds its own bytes");
		});

		it("verifies a tree that is missing a file before that file is written", async () => {
			const root = await makeRoot();
			const sources = await sourcesOf(root, { "entry.js": "1;\n", "lib/part.js": "2;\n" });
			const tree = await stageRuntimeTree({ storageDir: root, namespace: "tree", sources, access: windowsProbe().probe });
			const lost = tree.files.find(file => file.relativePath === "lib/part.js")!.path;
			await rm(lost);
			let lostAtFirstPass: boolean | null = null;
			const { probe, passes } = windowsProbe({ onPass: () => { lostAtFirstPass ??= !existsSync(lost); } });

			await stageRuntimeTree({ storageDir: root, namespace: "tree", sources, access: probe });

			assert.equal(passes.length, 2);
			assert.equal(lostAtFirstPass, true);
			assert.equal(await readFile(lost, "utf8"), "2;\n");
		});

		it("still refuses a complete tree whose copy another account owns or can write, and one it cannot read", async () => {
			const root = await makeRoot();
			const sources = await sourcesOf(root, { "entry.js": "1;\n" });
			const tree = await stageRuntimeTree({ storageDir: root, namespace: "tree", sources, access: windowsProbe().probe });
			const file = tree.files[0]!.path;

			const foreign = windowsProbe({ ownerOf: entry => (entry === file ? "WORKSTATION\\someone-else" : ACCOUNT) });
			await assert.rejects(
				stageRuntimeTree({ storageDir: root, namespace: "tree", sources, access: foreign.probe }),
				/owned by S-1-5-21-100-200-300-1002/,
			);
			assert.equal(foreign.passes.length, 1);
			await assert.rejects(
				stageRuntimeTree({ storageDir: root, namespace: "tree", sources, access: windowsProbe({ permissive: candidate => candidate === file }).probe }),
				/is readable by S-1-1-0 \(Everyone\)/,
			);
			await assert.rejects(
				stageRuntimeTree({ storageDir: root, namespace: "tree", sources, access: windowsProbe({ ownerReadFails: true }).probe }),
				/not usable/,
			);
			await assert.rejects(
				stageRuntimeTree({ storageDir: root, namespace: "tree", sources, access: windowsProbe({ acl: null }).probe }),
				/not usable/,
			);
		});

		it("never accepts a copy whose bytes changed: it is written again, behind the first pass", async () => {
			const root = await makeRoot();
			const source = await makePackagedFile(root, "relay.js", "0;\n");
			const [staged] = await stageRuntimeAssets({ storageDir: root, sourcePaths: [source], access: windowsProbe().probe });
			await writeFile(staged!.path, "tampered\n", "utf8");
			let bytesAtFirstPass: string | null = null;
			const { probe, passes } = windowsProbe({ onPass: async () => { bytesAtFirstPass ??= await readFile(staged!.path, "utf8"); } });

			await stageRuntimeAssets({ storageDir: root, sourcePaths: [source], access: probe });

			assert.equal(passes.length, 2);
			assert.equal(bytesAtFirstPass, "tampered\n", "the replacement waits for the first pass");
			assert.equal(await readFile(staged!.path, "utf8"), "0;\n");
		});
	});

	it("establishes the access rules before handing out a copy of a tree another account can write", async () => {
		const root = await makeRoot();
		const source = await makePackagedFile(root, "relay.js", "0;\n");
		const { probe, applied } = windowsProbe({ acl: ["Everyone"], aclAfterRewrite: OWNER_ONLY });

		const [staged] = await stageRuntimeAssets({ storageDir: root, sourcePaths: [source], access: probe });

		assert.equal(applied.length, 1);
		assert.deepEqual(applied[0], [
			"/inheritance:r",
			"/grant:r",
			`*${TEST_CURRENT_SID}:(OI)(CI)(F)`,
			"*S-1-5-18:(OI)(CI)(F)",
			"*S-1-5-32-544:(OI)(CI)(F)",
			"/Q",
		]);
		assert.equal(await readFile(staged.path, "utf8"), "0;\n");
	});

	it("refuses a copy whose own entry lets another account write it", async () => {
		const root = await makeRoot();
		const source = await makePackagedFile(root, "verified-pipe.ps1", "param()\n");
		const target = stagedPathOf(root, "verified-pipe.ps1", "param()\n");
		// The parent directory is limited, but this file carries an explicit entry of its
		// own — which a parent's entries do not override.
		const { probe } = windowsProbe({ permissive: candidate => candidate === target });

		await assert.rejects(
			stageRuntimeAssets({ storageDir: root, sourcePaths: [source], access: probe }),
			/is readable by S-1-1-0 \(Everyone\)/,
		);
	});

	it("refuses a directory the staged tree is reachable through when another account can write it", async () => {
		const root = await makeRoot();
		const source = await makePackagedFile(root, "relay.js", "0;\n");
		// The directory that holds the runtime tree: whoever can write it can replace the
		// tree, whatever the tree's own entries say. It is verified, never rewritten.
		const { probe, applied } = windowsProbe({ permissive: candidate => candidate === root });

		await assert.rejects(
			stageRuntimeAssets({ storageDir: root, sourcePaths: [source], access: probe }),
			/on the path to the store lets S-1-1-0 \(Everyone\) replace or re-permission it/,
		);
		assert.deepEqual(applied, [], "a directory this module does not own is never rewritten");
	});

	it("refuses a copy owned by another account", async () => {
		const root = await makeRoot();
		const source = await makePackagedFile(root, "relay.js", "0;\n");
		const target = stagedPathOf(root, "relay.js", "0;\n");
		const { probe } = windowsProbe({ ownerOf: entry => (entry === target ? "WORKSTATION\\someone-else" : ACCOUNT) });

		await assert.rejects(
			stageRuntimeAssets({ storageDir: root, sourcePaths: [source], access: probe }),
			/owned by S-1-5-21-100-200-300-1002 \(WORKSTATION\\someone-else\)/,
		);
	});

	it("refuses a copy whose owner cannot be read at all", async () => {
		const root = await makeRoot();
		const source = await makePackagedFile(root, "relay.js", "0;\n");
		const { probe } = windowsProbe({ omitPath: stagedPathOf(root, "relay.js", "0;\n") });

		await assert.rejects(
			stageRuntimeAssets({ storageDir: root, sourcePaths: [source], access: probe }),
			/the owner of .* could not be read/,
		);
	});

	it("refuses a tree whose owner read fails", async () => {
		const root = await makeRoot();
		const source = await makePackagedFile(root, "relay.js", "0;\n");
		const { probe } = windowsProbe({ ownerReadFails: true });

		await assert.rejects(
			stageRuntimeAssets({ storageDir: root, sourcePaths: [source], access: probe }),
			/the store owner could not be read/,
		);
	});

	it("refuses a tree whose access listing cannot be read", async () => {
		const root = await makeRoot();
		const source = await makePackagedFile(root, "relay.js", "0;\n");
		const { probe } = windowsProbe({ acl: null });

		await assert.rejects(
			stageRuntimeAssets({ storageDir: root, sourcePaths: [source], access: probe }),
			/could not be verified/,
		);
	});

	it("refuses a runtime directory that is a reparse point", { skip: process.platform !== "win32" }, async () => {
		const root = await makeRoot();
		const source = await makePackagedFile(root, "relay.js", "0;\n");
		const elsewhere = path.join(root, "elsewhere");
		await mkdir(elsewhere, { recursive: true });
		const junction = path.join(root, "runtime");
		const made = spawn(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe"), [
			"/c",
			"mklink",
			"/J",
			junction,
			elsewhere,
		], { windowsHide: true });
		const madeExit = await new Promise<number | null>(resolve => made.on("close", resolve));
		if (madeExit !== 0) {
			// A machine that refuses to create the junction cannot test this refusal.
			return;
		}
		const { probe } = windowsProbe();

		await assert.rejects(
			stageRuntimeAssets({ storageDir: root, sourcePaths: [source], access: probe }),
			/not a plain directory|link or reparse point/,
		);
	});

	it(
		"refuses a staged tree whose POSIX modes allow another account to write it",
		{ skip: process.platform !== "win32" },
		async () => {
			const root = await makeRoot();
			const source = await makePackagedFile(root, "relay.js", "0;\n");
			// The simulated POSIX check sees this Windows filesystem's modes, which a
			// freshly written copy never reports as group/other-write-free; the accepting
			// branch of that check needs a POSIX host and is not exercised here.
			await assert.rejects(
				stageRuntimeAssets({
					storageDir: root,
					sourcePaths: [source],
					access: { platform: "linux", ownerUid: 0 },
				}),
				/writable beyond this account/,
			);
		},
	);

	it("accepts a shared volume root, which is the platform anchor and not walked", async () => {
		const root = await makeRoot();
		const source = await makePackagedFile(root, "relay.js", "0;\n");
		const volumeRoot = path.parse(root).root;
		// Only the volume root reports a foreign write entry: the walk stops below it, so
		// this is the deployment assumption rather than a finding (see ADR-0012).
		const { probe, applied } = windowsProbe({ permissive: candidate => candidate === volumeRoot });

		const [staged] = await stageRuntimeAssets({ storageDir: root, sourcePaths: [source], access: probe });

		assert.equal(await readFile(staged.path, "utf8"), "0;\n");
		assert.deepEqual(applied, [], "the anchor is never rewritten");
	});

	it("refuses an ancestor above the storage directory that another account can write", async () => {
		const root = await makeRoot();
		const source = await makePackagedFile(root, "relay.js", "0;\n");
		const ancestor = path.dirname(root);
		const { probe, applied } = windowsProbe({ permissive: candidate => candidate === ancestor });

		await assert.rejects(
			stageRuntimeAssets({ storageDir: root, sourcePaths: [source], access: probe }),
			/lets .* replace or re-permission it/,
		);
		assert.deepEqual(applied, [], "an ancestor is never rewritten");
	});

	it("refuses an ancestor above the storage directory owned by another account", async () => {
		const root = await makeRoot();
		const source = await makePackagedFile(root, "relay.js", "0;\n");
		const ancestor = path.dirname(root);
		const { probe } = windowsProbe({
			ownerOf: candidate => (candidate === ancestor ? "WORKSTATION\\someone-else" : ACCOUNT),
		});

		await assert.rejects(
			stageRuntimeAssets({ storageDir: root, sourcePaths: [source], access: probe }),
			/is owned by S-1-5-21-100-200-300-1002 \(WORKSTATION\\someone-else\)/,
		);
	});

	it("requires the extension storage directory", async () => {
		const root = await makeRoot();
		const source = await makePackagedFile(root, "relay.js", "0;\n");
		await assert.rejects(stageRuntimeAssets({ storageDir: "", sourcePaths: [source] }), /storage directory/);
	});

	it("surfaces a packaged file that cannot be read", async () => {
		const root = await makeRoot();
		const source = await makePackagedFile(root, "relay.js", "0;\n");
		await rm(source, { force: true });
		const { probe } = windowsProbe();
		await assert.rejects(stageRuntimeAssets({ storageDir: root, sourcePaths: [source], access: probe }), /ENOENT/);
		assert.deepEqual(
			await readdir(path.join(root, RUNTIME_ASSET_DIRECTORY)),
			[],
			"a failed stage leaves no digest directory behind",
		);
	});
});
