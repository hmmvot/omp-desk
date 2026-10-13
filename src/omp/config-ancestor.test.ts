import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { ancestorContextDir } from "./config-ancestor.ts";

async function tree(files: readonly string[]): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ancestor-"));
  for (const file of files) { await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true }); await fs.writeFile(path.join(root, file), ""); }
  return root;
}

test("a folder inside a repository whose root .omp holds AGENTS.md would stop loading it", async () => {
  const root = await tree([".git/HEAD", ".omp/AGENTS.md", "sub/pkg/file.txt"]);
  const home = path.join(root, "nohome");
  assert.equal(await ancestorContextDir(path.join(root, "sub", "pkg"), home), path.join(root, ".omp"));
});

test("nothing changes when the folder has its own .omp, when no ancestor holds context files, or when the ancestor is outside the repository", async () => {
  const own = await tree([".git/HEAD", ".omp/AGENTS.md", "sub/.omp/x.yml"]);
  assert.equal(await ancestorContextDir(path.join(own, "sub"), path.join(own, "nohome")), null);
  const plain = await tree([".git/HEAD", ".omp/config.yml", "sub/file.txt"]);
  assert.equal(await ancestorContextDir(path.join(plain, "sub"), path.join(plain, "nohome")), null, "the nearest .omp has no context files");
  const outside = await tree([".omp/AGENTS.md", "repo/.git/HEAD", "repo/sub/file.txt"]);
  assert.equal(await ancestorContextDir(path.join(outside, "repo", "sub"), path.join(outside, "nohome")), null, "OMP stops at the repository root");
});

test("the home directory is never a project", async () => {
  const root = await tree([".omp/RULES.md", "work/sub/file.txt"]);
  assert.equal(await ancestorContextDir(path.join(root, "work", "sub"), root), null);
});

test("a folder that is the repository root has nothing above it to lose, whatever sits above the repository", async () => {
  const root = await tree([".omp/AGENTS.md", "repo/.git/HEAD"]);
  assert.equal(await ancestorContextDir(path.join(root, "repo"), path.join(root, "nohome")), null);
});
