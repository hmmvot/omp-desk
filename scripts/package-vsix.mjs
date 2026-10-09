// Package one platform-specific VSIX: `node scripts/package-vsix.mjs <win32-x64|win32-arm64>`.
//
// `vsce package` runs `vscode:prepublish` (the esbuild build), which reads
// OMP_DESK_TARGET to ship only that architecture's node-pty prebuilds. The output is
// `out/omp-desk-<target>-<version>.vsix`, next to the build output and ignored by Git.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";

const TARGETS = ["win32-x64", "win32-arm64"];
const target = process.argv[2];
if (!TARGETS.includes(target)) {
  console.error(`Usage: node scripts/package-vsix.mjs <${TARGETS.join("|")}>`);
  process.exit(2);
}

const require = createRequire(import.meta.url);
const vsceManifest = require.resolve("@vscode/vsce/package.json");
const vsce = path.join(path.dirname(vsceManifest), "vsce");
const { name, version } = require("../package.json");
const output = path.join("out", `${name}-${target}-${version}.vsix`);

const result = spawnSync(process.execPath, [vsce, "package", "--target", target, "--no-dependencies", "--out", output], {
  stdio: "inherit",
  env: { ...process.env, OMP_DESK_TARGET: target },
});
process.exit(result.status ?? 1);
