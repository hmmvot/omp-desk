import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { ancestorContextDir, ancestorProjectFolder, nearestOmpFolder, projectFolderFor } from "./config-ancestor.ts";
import { ancestorProjectNotice } from "../protocol/omp-config-model.ts";

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

test("a Unity-like layout: with the setting on the project is the repository root that holds .omp; off, the workspace folder is the project and its first write is refused", async () => {
  const root = await tree(unityLayout);
  const home = path.join(root, "nohome");
  const game = path.join(root, "Game");
  assert.equal(await projectFolderFor(game, true, home), root);
  assert.equal(await nearestOmpFolder(game, home), root);
  assert.equal(await projectFolderFor(game, false, home), game);
  assert.equal(await ancestorContextDir(game, home), path.join(root, ".omp"), "off: creating Game/.omp would stop the root's AGENTS.md loading, so the write is refused");
  assert.equal(await ancestorContextDir(root, home), null, "on: the project is the root itself, nothing above it is lost");
});

test("the folder itself counts when its .omp is non-empty; an empty .omp does not", async () => {
  const root = await tree([".git/HEAD", ".omp/config.yml", "Game/.omp/config.yml"]);
  assert.equal(await nearestOmpFolder(path.join(root, "Game"), path.join(root, "nohome")), path.join(root, "Game"));
  await fs.rm(path.join(root, "Game", ".omp", "config.yml"));
  assert.equal(await nearestOmpFolder(path.join(root, "Game"), path.join(root, "nohome")), root, "an empty .omp is skipped, as OMP skips it");
});

test("with no ancestor .omp the workspace folder stays the project", async () => {
  const root = await tree([".git/HEAD", "omp-vscode/Assets/.keep"]);
  const game = path.join(root, "Game");
  assert.equal(await nearestOmpFolder(game, path.join(root, "nohome")), null);
  assert.equal(await projectFolderFor(game, true, path.join(root, "nohome")), game);
});

test("the walk stops at the repository root, inclusive, and at home, which is never a project", async () => {
  const outside = await tree([".omp/config.yml", "repo/.git/HEAD", "repo/omp-vscode/Assets/.keep"]);
  assert.equal(await nearestOmpFolder(path.join(outside, "repo", "Game"), path.join(outside, "nohome")), null, ".omp above the repository root is not reached");
  const rootHolds = await tree(["repo/.git/HEAD", "repo/.omp/config.yml", "repo/omp-vscode/Assets/.keep"]);
  assert.equal(await nearestOmpFolder(path.join(rootHolds, "repo", "Game"), path.join(rootHolds, "nohome")), path.join(rootHolds, "repo"), "the repository root itself is checked");
  const homeHolds = await tree([".omp/config.yml", "work/omp-vscode/Assets/.keep"]);
  assert.equal(await nearestOmpFolder(path.join(homeHolds, "work", "Game"), homeHolds), null, "no repository: the walk ends at home and home's .omp is not a project");
  assert.equal(await projectFolderFor(homeHolds, true, homeHolds), homeHolds, "the home folder itself falls back to itself (it has no project layer)");
});

test("an ancestor .omp that is the OMP project is reported with its folder, whether or not it holds context files; nothing is reported when the folder has its own .omp or is the repository root", async () => {
  const home = "nohome";
  // the real Unity case: the root's .omp holds config.yml, settings.json, agents, mcp.json and no context file
  const root = await tree([".git/HEAD", ".omp/config.yml", ".omp/settings.json", ".omp/agents/a.md", ".omp/mcp.json", "omp-vscode/Assets/.keep"]);
  const game = path.join(root, "Game");
  assert.equal(await ancestorProjectFolder(game, path.join(root, home)), root);
  assert.equal(await ancestorContextDir(game, path.join(root, home)), null, "no context file: the first write is not refused, only the notice is shown");
  await fs.mkdir(path.join(game, ".omp"), { recursive: true });
  assert.equal(await ancestorProjectFolder(game, path.join(root, home)), root, "an empty .omp of its own does not count");
  await fs.writeFile(path.join(game, ".omp", "config.yml"), "x: 1\n");
  assert.equal(await ancestorProjectFolder(game, path.join(root, home)), null, "a non-empty .omp of its own is the project");
  assert.equal(await ancestorProjectFolder(root, path.join(root, home)), null, "the repository root has no ancestor to defer to");
  const above = await tree([".omp/config.yml", "repo/.git/HEAD", "repo/omp-vscode/Assets/.keep"]);
  assert.equal(await ancestorProjectFolder(path.join(above, "repo", "Game"), path.join(above, home)), null, "the walk stops at the repository root");
  assert.match(ancestorProjectNotice(root), /has an \.omp above this one and looks like the OMP project: sessions that run there will not read settings written here\. Turn on ompDesk\.ompSettings\.useNearestAncestorOmpFolder to edit it instead\./);
});
