/**
 * The one-shot child that stages and verifies the native module (ADR-0076, decision 4).
 *
 * The extension host cannot load the staged `koffi.node` before the staged tree is verified, and the
 * verification of that tree (`stageRuntimeAssets`) reads access lists and owners natively. This child
 * breaks the circle without PowerShell: it runs under the host's own executable as Node
 * (`ELECTRON_RUN_AS_NODE=1`), loads the *packaged* module, and with it writes the staged copy and
 * verifies the tree. It prints one JSON line, the verdict; the host loads the staged copy only after
 * a `staged` verdict.
 *
 * `node native-stage.js <packaged koffi.node> <globalStorage directory>`. Bundled to
 * `out/native-stage.js`; nothing in it imports `vscode`.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { stageRuntimeAssets } from "../wire/runtime-assets.ts";
import { recordNativeProof } from "../host/native-proof.ts";
import { startWin32Native, win32NativeFailure } from "../wire/win32-native.ts";

/** Where the child's time went, in milliseconds: its process age when staging began (runtime boot and module load), loading the packaged module, staging the copy. */
export interface NativeStageTiming {
	readonly bootMs: number;
	readonly loadMs: number;
	readonly stageMs: number;
}

/** What the child reports on its one line of output. */
export type NativeStageVerdict =
	| { readonly kind: "staged"; readonly path: string; readonly sha256: string; readonly timing?: NativeStageTiming; /** `recorded`, or why no proof was recorded. */ readonly proof?: string }
	| { readonly kind: "refused"; readonly reason: string };

/** Stage the packaged module under `storageDir`; never throws, every failure is a `refused` verdict. */
export async function stageNativeModule(packaged: string, storageDir: string): Promise<NativeStageVerdict> {
	try {
		const bootMs = performance.now();
		const sha256 = createHash("sha256").update(await readFile(packaged)).digest("hex");
		const native = await startWin32Native(async () => ({ path: packaged, sha256 }));
		const loaded = performance.now();
		if (native === null) return { kind: "refused", reason: win32NativeFailure() ?? "the packaged native module did not load" };
		const [staged] = await stageRuntimeAssets({ storageDir, sourcePaths: [packaged] });
		if (staged === undefined) return { kind: "refused", reason: "staging returned no copy" };
		const stagedAt = performance.now();
		// The verification passed: record it, so the next activation can skip this child (ADR-0076, decision 11). A record that
		// cannot be written costs only that warm start; the staging itself succeeded.
		let proof = "recorded";
		try {
			await recordNativeProof({ storageDir, packagedSha256: sha256, stagedPath: staged.path, native });
		} catch (error) {
			proof = error instanceof Error ? error.message : String(error);
		}
		return { kind: "staged", path: staged.path, sha256: staged.sha256, proof, timing: { bootMs, loadMs: loaded - bootMs, stageMs: stagedAt - loaded } };
	} catch (error) {
		return { kind: "refused", reason: error instanceof Error ? error.message : String(error) };
	}
}

// Run only as the entry of the child, never when a test imports `stageNativeModule`.
if (process.argv[1] !== undefined && /native-stage\.(js|ts)$/.test(process.argv[1])) {
	const [packaged, storageDir] = process.argv.slice(2);
	void (async () => {
		const verdict: NativeStageVerdict = packaged === undefined || storageDir === undefined
			? { kind: "refused", reason: "the native stage child needs the packaged module and the storage directory" }
			: await stageNativeModule(packaged, storageDir);
		process.stdout.write(`${JSON.stringify(verdict)}\n`, () => process.exit(verdict.kind === "staged" ? 0 : 1));
	})();
}
