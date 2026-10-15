// The packaging gate of the broker tree's recorded digest (ADR-0076, decision 14): the `out/pty-tree.json` inside a VSIX must be
// the digest of the `out/pty` tree and native module that same VSIX carries. The window takes that record as this build's identity
// until it has hashed the installed tree, so a record that describes other bytes than the package holds (a one-shot build that ran
// beside a watch build, files edited after the build, a packaging filter that dropped or kept something the build did not) must
// fail the package, not ship.
//
// `node scripts/verify-vsix-tree-record.mjs <file.vsix>` exits 1 and says why when the record is missing or does not match.
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { computePtyTreeDigest, PTY_TREE_DIGEST_FILE } from "./pty-tree-digest.mjs";

/** The digest the VSIX records and the digest of the tree it holds, or throws with the reason the two cannot be compared. */
export async function readVsixTreeRecord(vsix) {
  const unpacked = await fs.mkdtemp(path.join(os.tmpdir(), "omp-vsix-tree-"));
  try {
    // bsdtar, which ships with Windows, reads a zip.
    const extract = spawnSync("tar", ["-xf", path.resolve(vsix), "-C", unpacked], { encoding: "utf8" });
    if (extract.status !== 0) throw new Error(`${vsix} could not be unpacked: ${(extract.stderr || extract.error?.message || "tar failed").trim()}`);
    const root = path.join(unpacked, "extension");
    const recordFile = path.join(root, ...PTY_TREE_DIGEST_FILE.split("/"));
    let record;
    try {
      record = JSON.parse(await fs.readFile(recordFile, "utf8"));
    } catch (error) {
      throw new Error(`${vsix} holds no readable ${PTY_TREE_DIGEST_FILE}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const packed = await computePtyTreeDigest(root);
    return { recorded: record?.digest, files: record?.files, packed: packed.digest, packedFiles: packed.files };
  } finally {
    await fs.rm(unpacked, { recursive: true, force: true });
  }
}

/** Throws when the VSIX's record is not the digest of its own tree. */
export async function verifyVsixTreeRecord(vsix) {
  const { recorded, files, packed, packedFiles } = await readVsixTreeRecord(vsix);
  if (recorded !== packed || files !== packedFiles) {
    throw new Error(
      `${vsix}: ${PTY_TREE_DIGEST_FILE} records ${String(recorded).slice(0, 12)} over ${String(files)} files, but the packed tree is ${packed.slice(0, 12)} over ${packedFiles}; rebuild with \`node esbuild.mjs\` and package again`,
    );
  }
  return { digest: packed, files: packedFiles };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const vsix = process.argv[2];
  if (vsix === undefined) {
    console.error("Usage: node scripts/verify-vsix-tree-record.mjs <file.vsix>");
    process.exit(2);
  }
  try {
    const { digest, files } = await verifyVsixTreeRecord(vsix);
    console.log(`${vsix}: the recorded broker tree digest ${digest.slice(0, 12)} matches the packed tree (${files} files)`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
