/**
 * The extension under test: a VSIX packaged from the working tree into out/e2e-results/ (never over the VSIX files
 * `npm run vsix*` writes, which a release or hand-over may be using), rebuilt only when a source file is newer.
 * `E2E_VSIX=<path>` pins an existing VSIX instead (for example one built from another checkout);
 * `E2E_REBUILD=1` forces a rebuild.
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./launcher.ts";

const SOURCES = ["src", "package.json", "esbuild.mjs", "media/omp-activity.svg", "scripts/package-vsix.mjs"];

function newestMtime(path: string): number {
	if (!existsSync(path)) return 0;
	const info = statSync(path);
	if (!info.isDirectory()) return info.mtimeMs;
	let newest = info.mtimeMs;
	for (const entry of readdirSync(path)) newest = Math.max(newest, newestMtime(join(path, entry)));
	return newest;
}

export async function resolveVsix(resultsDir: string): Promise<string> {
	const explicit = process.env.E2E_VSIX;
	if (explicit) return explicit;
	const arch = process.arch === "arm64" ? "arm64" : "x64";
	const target = `win32-${arch}`;
	const output = join(resultsDir, `omp-desk-e2e-${target}.vsix`);
	const sources = Math.max(...SOURCES.map(entry => newestMtime(join(REPO_ROOT, entry))));
	if (existsSync(output) && statSync(output).mtimeMs > sources && process.env.E2E_REBUILD !== "1") return output;

	// What scripts/package-vsix.mjs does, with another output path.
	const vsce = join(REPO_ROOT, "node_modules", "@vscode", "vsce", "vsce");
	const done = Promise.withResolvers<void>();
	const child = spawn(process.execPath, [vsce, "package", "--target", target, "--no-dependencies", "--out", output], {
		cwd: REPO_ROOT,
		stdio: "inherit",
		env: { ...process.env, OMP_DESK_TARGET: target },
	});
	child.once("error", done.reject);
	child.once("close", code => (code === 0 ? done.resolve() : done.reject(new Error(`vsce package failed (exit ${code})`))));
	await done.promise;
	return output;
}
