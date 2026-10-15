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
import { recordingLogger, type LoggedLine } from "../shared/logger.ts";
import { stageRuntimeAssets } from "../host/runtime-assets.ts";
import { startWin32Native } from "../host/win32-native.ts";

/** What the child reports on its one line of output. */
export type NativeStageVerdict =
	| { readonly kind: "staged"; readonly path: string; readonly sha256: string }
	| { readonly kind: "refused"; readonly reason: string };

/** Stage the packaged module under `storageDir`; never throws, every failure is a `refused` verdict. */
export async function stageNativeModule(packaged: string, storageDir: string): Promise<NativeStageVerdict> {
	try {
		const sha256 = createHash("sha256").update(await readFile(packaged)).digest("hex");
		const lines: LoggedLine[] = [];
		const native = await startWin32Native(async () => ({ path: packaged, sha256 }), recordingLogger(lines));
		if (native === null) return { kind: "refused", reason: lines.at(-1)?.message ?? "the packaged native module did not load" };
		const [staged] = await stageRuntimeAssets({ storageDir, sourcePaths: [packaged] });
		if (staged === undefined) return { kind: "refused", reason: "staging returned no copy" };
		return { kind: "staged", path: staged.path, sha256: staged.sha256 };
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
