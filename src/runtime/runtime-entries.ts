/**
 * The verified copies of the runtime entries every child process of a window runs (ADR-0066 moved
 * this out of `extension.ts`; the staging rules themselves are unchanged).
 *
 * Every entry is copied to `<globalStorage>/runtime/<sha256>/<name>`, and the copy is re-read and
 * re-hashed on *every* call — immediately before its caller hands the path to a child process. A
 * path that was correct when it was staged is not a promise about now, so a copy that changed under
 * us is staged again from the packaged file instead of being executed. The staged tree must be
 * writable only by this account, which `stageRuntimeAssets` establishes and verifies before it
 * returns any copy.
 *
 * Running from those copies is what keeps a reinstall from waiting for a session: the installed
 * extension folder is what `code --install-extension <vsix> --force` renames, and a process still
 * reading a file inside it is what fails that rename. A staged file's digest also names its
 * directory, so this build's copies are told apart from another build's.
 *
 * A failure is not cached: the next caller stages again, because the file a failed attempt could not
 * read is usually the one a half-finished install replaced.
 */
import type { Logger } from "../shared/logger.ts";
import { stageRuntimeAssets, verifyStagedRuntimeAsset } from "../host/runtime-assets.ts";
import type { StagedRuntimeAsset } from "../host/runtime-assets.ts";
import type { NativeStageVerdict } from "./native-stage.ts";

/** Staged copies every child process of this window runs. */
export interface StagedRuntimeEntries {
	/** The host-control module the native OMP process preloads and `-e`-loads. */
	readonly hostControl: StagedRuntimeAsset;
	/** The Bun helper a stopped-session rename runs (never an OMP session). */
	readonly renameHelper: StagedRuntimeAsset;
	/** The module a launcher capability probe preloads (`host/launch-capability.ts`); it only reports a nonce. */
	readonly runtimeProbe: StagedRuntimeAsset;
}

/** What staging needs from its window; every read happens when a call stages, never at construction. */
export interface RuntimeStagingDeps {
	/** `<globalStorage>`: the directory the staged tree lives under. */
	storageDir(): string;
	/** The packaged files, as absolute paths. */
	packagedPaths(): {
		readonly hostControl: string;
		readonly renameHelper: string;
		readonly runtimeProbe: string;
	};
	/** Stages the packaged native module and verifies the tree it lands in, in a child that loads the packaged copy. */
	stageNative(): Promise<NativeStageVerdict>;
	/**
	 * Why the packaged entries must not be staged right now (they are no longer the files this host
	 * loaded, so a child started from them would speak a newer protocol), or `null`.
	 */
	refusal(): string | null;
	readonly log: Logger;
}

export interface RuntimeStaging {
	/** The verified copies of this window's runtime entries. */
	entries(): Promise<StagedRuntimeEntries>;
	/**
	 * The staged copy of the native module (`koffi.node`, ADR-0076), verified before it is handed out.
	 *
	 * Staged by the one-shot child (`deps.stageNative`), never by this process: this process reads access
	 * natively, so it cannot verify the tree the module is staged into before it has the module. Staged on its
	 * own, not with {@link RuntimeStaging.entries}: a module that cannot be staged only makes the Windows
	 * readings it serves unknown and must never stop a host from launching.
	 */
	native(): Promise<StagedRuntimeAsset | null>;
	/** Why the last {@link RuntimeStaging.native} call returned `null`, as the raw message; `null` after a staged copy. */
	nativeRefusal(): string | null;
}

/** Do the copies still hold the bytes their digests name? */
async function stagedEntriesIntact(entries: StagedRuntimeEntries): Promise<boolean> {
	for (const asset of [entries.hostControl, entries.runtimeProbe]) {
		if (!(await verifyStagedRuntimeAsset(asset))) return false;
	}
	return true;
}

export function createRuntimeStaging(deps: RuntimeStagingDeps): RuntimeStaging {
	let stagedEntries: Promise<StagedRuntimeEntries> | null = null;
	let stagedNative: Promise<StagedRuntimeAsset | null> | null = null;
	let nativeRefusal: string | null = null;
	return {
		async entries() {
			const cached = stagedEntries;
			if (cached !== null) {
				const entries = await cached;
				if (await stagedEntriesIntact(entries)) return entries;
				deps.log.warn("a staged runtime copy no longer matches its digest; staging the packaged entries again");
				stagedEntries = null;
			}
			const staging = (async () => {
				// Staging copies the packaged entries. After a reinstall those are the new build's, and a child
				// started from them would speak to this (old) host with the new build's protocol.
				const refusal = deps.refusal();
				if (refusal !== null) throw new Error(refusal);
				const paths = deps.packagedPaths();
				const [hostControl, renameHelper, runtimeProbe] = await stageRuntimeAssets({
					storageDir: deps.storageDir(),
					sourcePaths: [paths.hostControl, paths.renameHelper, paths.runtimeProbe],
				});
				return { hostControl, renameHelper, runtimeProbe };
			})();
			stagedEntries = staging.catch((error: unknown) => {
				stagedEntries = null;
				throw error;
			});
			return stagedEntries;
		},
		async native() {
			if (stagedNative !== null) {
				const cached = await stagedNative;
				if (cached !== null && (await verifyStagedRuntimeAsset(cached))) return cached;
			}
			const startedAt = performance.now();
			stagedNative = deps.stageNative().then(
				verdict => {
					if (verdict.kind === "staged") {
						nativeRefusal = null;
						if (verdict.timing !== undefined) {
							const total = performance.now() - startedAt;
							const { bootMs, loadMs, stageMs } = verdict.timing;
							deps.log.info(`window timing: native staging child ${Math.round(total)} ms (runtime boot ${Math.round(bootMs)}, load ${Math.round(loadMs)}, stage and verify ${Math.round(stageMs)}, start and exit ${Math.round(total - bootMs - loadMs - stageMs)}); verification proof ${verdict.proof ?? "not reported"}`);
						}
						return { path: verdict.path, sha256: verdict.sha256 };
					}
					nativeRefusal = verdict.reason;
					deps.log.warn(`the native module could not be staged: ${verdict.reason}`);
					return null;
				},
				(error: unknown) => {
					nativeRefusal = error instanceof Error ? error.message : String(error);
					deps.log.warn(`the native module could not be staged: ${nativeRefusal}`);
					return null;
				},
			);
			return await stagedNative;
		},
		nativeRefusal: () => nativeRefusal,
	};
}
