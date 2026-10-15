import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { ptyPackagedTreeDigest, ptyRecordedTreeDigest } from "../src/host/pty-runtime.ts";
import { computePtyTreeDigest, PTY_TREE_DIGEST_FILE, recordPtyTreeDigestAfter, removePtyTreeDigest, writePtyTreeDigest } from "./pty-tree-digest.mjs";

const roots = [];

async function tree(files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-tree-digest-"));
  roots.push(root);
  for (const [name, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), text, "utf8");
  }
  return root;
}

const COMPLETE = {
  "out/pty/pty-broker.js": "// entry",
  "out/pty/pty-owner-watch.ps1": "# owner watch",
  "out/pty/pty-broker.js.map": "{}",
  "out/pty/node_modules/node-pty/lib/index.js": "module.exports = {};",
  "out/pty/node_modules/node-pty/prebuilds/win32-x64/pty.node": "binary",
  "out/pty/node_modules/node-pty/package.json": "{}",
  "out/native/koffi.node": "native",
};

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("the build's record of the packaged tree digest", () => {
  it("is the digest the host hashes from the same tree: layout, order, the native module, no source map", async () => {
    const root = await tree(COMPLETE);
    const computed = await computePtyTreeDigest(root);
    assert.equal(computed.files, 6, "the source map is not part of the tree");
    assert.equal(computed.digest, await ptyPackagedTreeDigest(root));
  });

  it("changes with any file of the tree and with the native module, and not with a source map", async () => {
    const root = await tree(COMPLETE);
    const before = (await computePtyTreeDigest(root)).digest;
    await fs.writeFile(path.join(root, "out/pty/pty-broker.js.map"), "{ changed }");
    assert.equal((await computePtyTreeDigest(root)).digest, before);
    await fs.writeFile(path.join(root, "out/native/koffi.node"), "other native");
    assert.notEqual((await computePtyTreeDigest(root)).digest, before);
  });

  it("is written outside the tree, read back by the host, and refused when the tree is incomplete", async () => {
    const root = await tree(COMPLETE);
    const written = await writePtyTreeDigest(root);
    assert.ok(written !== null);
    assert.equal(await ptyRecordedTreeDigest(root), written.digest);
    assert.equal(await ptyPackagedTreeDigest(root), written.digest, "the record does not change what the tree hashes to");

    await fs.rm(path.join(root, "out/pty/pty-owner-watch.ps1"));
    assert.equal(await writePtyTreeDigest(root), null);
    assert.equal(await ptyRecordedTreeDigest(root), null, "an incomplete tree leaves no record, and removes an older one");
  });

  it("is removed by a watch build", async () => {
    const root = await tree(COMPLETE);
    await writePtyTreeDigest(root);
    await removePtyTreeDigest(root);
    assert.equal(await ptyRecordedTreeDigest(root), null);
    assert.equal((await fs.stat(path.join(root, "out/pty")).catch(() => null))?.isDirectory(), true);
    assert.equal(PTY_TREE_DIGEST_FILE, "out/pty-tree.json");
  });

  it("is not left behind by a build that fails after it began, and is written by one that finishes", async () => {
    const root = await tree(COMPLETE);
    const old = await writePtyTreeDigest(root);
    assert.ok(old !== null);
    await assert.rejects(
      recordPtyTreeDigestAfter(async () => {
        await fs.writeFile(path.join(root, "out/pty/pty-broker.js"), "// a new entry");
        throw new Error("a later target did not build");
      }, root),
      /did not build/,
    );
    assert.equal(await ptyRecordedTreeDigest(root), null, "the previous build's record does not outlive a failed build");

    const written = await recordPtyTreeDigestAfter(async () => {
      await fs.writeFile(path.join(root, "out/pty/pty-broker.js"), "// a newer entry");
    }, root);
    assert.ok(written !== null);
    assert.notEqual(written.digest, old.digest);
    assert.equal(await ptyRecordedTreeDigest(root), written.digest);
  });

  it("is ignored when it is not a digest of this layout", async () => {
    const root = await tree({ ...COMPLETE, "out/pty-tree.json": JSON.stringify({ format: "omp-runtime-tree/v1", digest: "not-a-digest", files: 1 }) });
    assert.equal(await ptyRecordedTreeDigest(root), null);
    await fs.writeFile(path.join(root, "out/pty-tree.json"), JSON.stringify({ format: "omp-runtime-tree/v0", digest: "a".repeat(64) }));
    assert.equal(await ptyRecordedTreeDigest(root), null);
    await fs.writeFile(path.join(root, "out/pty-tree.json"), "{ not json");
    assert.equal(await ptyRecordedTreeDigest(root), null);
  });
});
