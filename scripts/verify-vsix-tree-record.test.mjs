import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { writePtyTreeDigest } from "./pty-tree-digest.mjs";
import { verifyVsixTreeRecord } from "./verify-vsix-tree-record.mjs";

const roots = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

const TREE = {
  "out/pty/pty-broker.js": "// entry",
  "out/pty/pty-owner-watch.ps1": "# owner watch",
  "out/pty/node_modules/node-pty/lib/index.js": "module.exports = {};",
  "out/native/koffi.node": "native",
};

/** A `.vsix` (a zip with the extension under `extension/`) over a tree, with the build's record written last, as `esbuild.mjs` does. */
async function vsixOf(files, { record = true } = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "omp-vsix-gate-"));
  roots.push(base);
  const extension = path.join(base, "extension");
  for (const [name, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(extension, name)), { recursive: true });
    await fs.writeFile(path.join(extension, name), text, "utf8");
  }
  if (record) assert.ok(await writePtyTreeDigest(extension));
  return { base, extension, pack: async () => {
    const vsix = path.join(base, "package.vsix");
    await fs.rm(vsix, { force: true });
    const made = spawnSync("tar", ["--format", "zip", "-cf", vsix, "-C", base, "extension"], { encoding: "utf8" });
    assert.equal(made.status, 0, made.stderr);
    return vsix;
  } };
}

describe("the packaging gate of the recorded broker tree digest", { skip: process.platform !== "win32" }, () => {
  it("accepts a package whose record is the digest of the tree it carries", async () => {
    const built = await vsixOf(TREE);
    const verdict = await verifyVsixTreeRecord(await built.pack());
    assert.equal(verdict.files, 4);
  });

  it("fails a package whose tree changed after the record was written", async () => {
    const built = await vsixOf(TREE);
    await fs.writeFile(path.join(built.extension, "out/pty/pty-broker.js"), "// another entry");
    await assert.rejects(verifyVsixTreeRecord(await built.pack()), /records [0-9a-f]{12} over 4 files, but the packed tree is [0-9a-f]{12} over 4/);
  });

  it("fails a package that dropped a file the record covers, and one that added a file it does not", async () => {
    const built = await vsixOf(TREE);
    await fs.rm(path.join(built.extension, "out/native/koffi.node"));
    await assert.rejects(verifyVsixTreeRecord(await built.pack()), /but the packed tree is/);
    const added = await vsixOf(TREE);
    await fs.writeFile(path.join(added.extension, "out/pty/extra.js"), "// not recorded");
    await assert.rejects(verifyVsixTreeRecord(await added.pack()), /but the packed tree is/);
  });

  it("fails a package with no record", async () => {
    const built = await vsixOf(TREE, { record: false });
    await assert.rejects(verifyVsixTreeRecord(await built.pack()), /holds no readable out\/pty-tree\.json/);
  });
});
