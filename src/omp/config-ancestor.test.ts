import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { ancestorContextDir } from "./config-ancestor.ts";
import { sessionFolderFor } from "../host/session-folder.ts";

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

const unityLayout = [".git/HEAD", ".omp/config.yml", ".omp/AGENTS.md", "omp-vscode/Assets/.keep", "Game/ProjectSettings/ProjectVersion.txt"];

test("a Unity-like layout: with sessions at the repository root the editors write the root's .omp and lose nothing; with the setting off the first write below it is refused", async () => {
  const root = await tree(unityLayout);
  const home = path.join(root, "nohome");
  const game = path.join(root, "Game");
  assert.equal(await sessionFolderFor(game, true, { home }), root);
  assert.equal(await ancestorContextDir(root, home), null, "on: the project is the root itself, nothing above it is lost");
  assert.equal(await sessionFolderFor(game, false, { home }), game);
  assert.equal(await ancestorContextDir(game, home), path.join(root, ".omp"), "off: creating Game/.omp would stop the root's AGENTS.md loading, so the write is refused");
});

test("the refusal still protects a checkout of another system and a folder in none, because OMP's own walk knows .git only", async () => {
  const mercurial = await tree([".omp/AGENTS.md", "repo/.hg/store/.keep", "repo/omp-vscode/Assets/.keep"]);
  const home = path.join(mercurial, "nohome");
  const repo = path.join(mercurial, "repo");
  assert.equal(await sessionFolderFor(path.join(repo, "Game"), true, { home }), repo, "sessions and the editors use the Mercurial root");
  assert.equal(await ancestorContextDir(repo, home), path.join(mercurial, ".omp"), "OMP walks above a root without .git to the .omp there: writing repo/.omp would hide its AGENTS.md");
  const loose = await tree([".omp/RULES.md", "project/file.txt"]);
  assert.equal(await sessionFolderFor(path.join(loose, "project"), true, { home: path.join(loose, "nohome") }), path.join(loose, "project"));
  assert.equal(await ancestorContextDir(path.join(loose, "project"), path.join(loose, "nohome")), path.join(loose, ".omp"));
});
