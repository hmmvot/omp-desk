// The digest of the packaged broker tree, recorded at build time (ADR-0076, decision 14).
//
// The tree is `out/pty/` (without source maps) plus the native module the host also loads, `out/native/koffi.node`, which rides
// in the tree as `native/koffi.node`. Its digest names "this build's broker runtime": a surviving broker that reports the same
// digest runs exactly the bytes this VSIX shipped. The algorithm is `hashRuntimeTree` in `src/host/runtime-assets.ts`, written
// out again here because the build is plain JavaScript; `scripts/pty-tree-digest.test.mjs` proves the two agree on a tree.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/** Where the record is written, relative to the extension root; read by `src/host/pty-runtime.ts` (`PTY_TREE_DIGEST_FILE`). */
export const PTY_TREE_DIGEST_FILE = "out/pty-tree.json";

/** Marks the digest layout, so a later change of it cannot collide with a record of this one. */
const FORMAT = "omp-runtime-tree/v1";

/** Every file of the tree as `{ relativePath, sourcePath }`, exactly as `ptyRuntimeSources` lists them. */
async function treeSources(root) {
  const pty = path.join(root, "out", "pty");
  const entries = await fs.readdir(pty, { recursive: true, withFileTypes: true });
  const sources = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const sourcePath = path.join(entry.parentPath, entry.name);
    const relativePath = path.relative(pty, sourcePath).split(path.sep).join("/");
    if (relativePath.endsWith(".map")) continue;
    sources.push({ relativePath, sourcePath });
  }
  const native = path.join(root, "out", "native", "koffi.node");
  if ((await fs.stat(native).catch(() => null))?.isFile() === true) sources.push({ relativePath: "native/koffi.node", sourcePath: native });
  return sources;
}

/** The digest of the tree under `root`, and how many files it covers. */
export async function computePtyTreeDigest(root = ".") {
  const sources = (await treeSources(root)).sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  let manifest = "";
  for (const source of sources) {
    const sha256 = createHash("sha256").update(await fs.readFile(source.sourcePath)).digest("hex");
    manifest += `${source.relativePath}\0${sha256}\n`;
  }
  const digest = createHash("sha256").update(`${FORMAT}\n${manifest}`).digest("hex");
  return { digest, files: sources.length };
}

/**
 * Record the tree's digest next to it, outside the tree (a record inside would change what it records). A build whose tree is
 * not complete writes none, and removes an older one: the host then hashes the tree itself.
 */
export async function writePtyTreeDigest(root = ".") {
  await removePtyTreeDigest(root);
  for (const required of ["pty-broker.js", "pty-owner-watch.ps1"]) {
    if ((await fs.stat(path.join(root, "out", "pty", required)).catch(() => null)) === null) return null;
  }
  const { digest, files } = await computePtyTreeDigest(root);
  await fs.writeFile(path.join(root, ...PTY_TREE_DIGEST_FILE.split("/")), `${JSON.stringify({ format: FORMAT, digest, files })}\n`, "utf8");
  return { digest, files };
}

/** Remove the record: a watch build changes the tree after every rebuild, so the host must hash it itself. */
export async function removePtyTreeDigest(root = ".") {
  await fs.rm(path.join(root, ...PTY_TREE_DIGEST_FILE.split("/")), { force: true });
}

/**
 * Run `build`, which produces the tree, and record the digest of what it produced as the last step. The record is removed
 * before `build` writes anything, so a build that fails part-way (a bundle that does not compile, a file that cannot be copied)
 * leaves none: a record that exists describes the tree of the build that finished.
 */
export async function recordPtyTreeDigestAfter(build, root = ".") {
  await removePtyTreeDigest(root);
  await build();
  return await writePtyTreeDigest(root);
}
