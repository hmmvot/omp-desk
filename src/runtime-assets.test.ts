/**
 * Regression tests for content-addressed runtime assets.
 *
 * Runner: `node --test src/runtime-assets.test.ts`
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
import { after, describe, it } from "node:test";
import {
	RUNTIME_ASSET_DIRECTORY,
	stageRuntimeAssets,
	verifyStagedRuntimeAsset,
} from "./runtime-assets.ts";
import type { PrivateStorageCommandResult, PrivateStorageProbe } from "./host/private-storage.ts";

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
	const lines = principals.map(
		(principal, index) => `${index === 0 ? `${target} ` : " ".repeat(target.length + 1)}${principal}:(OI)(CI)(F)`,
	);
	return `${lines.join("\r\n")}\r\n\r\nSuccessfully processed 1 files; Failed processing 0 files\r\n`;
}

interface AccessProbe {
	readonly probe: PrivateStorageProbe;
	/** Every argument list the restriction was applied with. */
	readonly applied: string[][];
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
}

/**
 * A Windows access seam, injected at the same two probe fields the shared
 * convention defines, so a caller's probe means one thing everywhere.
 */
function windowsProbe(options: ProbeOptions = {}): AccessProbe {
	const applied: string[][] = [];
	let current = options.acl === undefined ? OWNER_ONLY : options.acl;
	const probe: PrivateStorageProbe = {
		platform: "win32",
		currentAccount: ACCOUNT,
		runIcacls: async (target: string): Promise<PrivateStorageCommandResult> => {
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
			if (options.ownerReadFails === true) return { ok: false, stdout: "", detail: "Get-Acl failed" };
			const ownerOf = options.ownerOf ?? ((): string => ACCOUNT);
			return {
				ok: true,
				stdout: paths
					.filter(path => path !== options.omitPath)
					.map(path => `${path}|${ownerOf(path)}`)
					.join("\r\n"),
				detail: null,
			};
		},
	};
	return { probe, applied };
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
	const account = await new Promise<string>(resolve => {
		const child = spawn(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "whoami.exe"), [], {
			windowsHide: true,
		});
		let out = "";
		child.stdout.on("data", chunk => (out += String(chunk)));
		child.on("close", () => resolve(out.trim()));
		child.on("error", () => resolve(""));
	});
	await realIcacls([
		directory,
		"/inheritance:r",
		"/grant:r",
		`${account}:(OI)(CI)(F)`,
		"*S-1-5-18:(OI)(CI)(F)",
		"*S-1-5-32-544:(OI)(CI)(F)",
		"/Q",
	]);
}

after(async () => {
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
				/lets Everyone replace or re-permission it/,
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

	it("establishes the access rules before handing out a copy of a tree another account can write", async () => {
		const root = await makeRoot();
		const source = await makePackagedFile(root, "relay.js", "0;\n");
		const { probe, applied } = windowsProbe({ acl: ["Everyone"], aclAfterRewrite: OWNER_ONLY });

		const [staged] = await stageRuntimeAssets({ storageDir: root, sourcePaths: [source], access: probe });

		assert.equal(applied.length, 1);
		assert.deepEqual(applied[0], [
			"/inheritance:r",
			"/grant:r",
			`${ACCOUNT}:(OI)(CI)(F)`,
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
			/is readable by Everyone/,
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
			/on the path to the store lets Everyone replace or re-permission it/,
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
			/owned by WORKSTATION\\someone-else/,
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
			/is owned by WORKSTATION\\someone-else/,
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
