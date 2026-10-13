import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/**
 * OMP loads AGENTS.md, RULES.md and SYSTEM.md from the nearest non-empty `.omp` directory between the folder and the repository
 * root, never from several (`findNearestProjectConfigDir` in `discovery/builtin.ts`). The home directory is never a project.
 * Creating `<folder>/.omp/config.yml` therefore makes the folder the nearest and stops an ancestor's files loading for its sessions.
 */
const CONTEXT_FILES = ["AGENTS.md", "RULES.md", "SYSTEM.md", "SYSTEM_TEMPLATE.md"];

const same = (a: string, b: string): boolean => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
async function entries(dir: string): Promise<string[]> { return fs.readdir(dir).catch(() => []); }

/** The nearest ancestor `.omp` directory that holds context files and would stop loading, or null when creating the folder's own `.omp` changes nothing. */
export async function ancestorContextDir(folder: string, home: string = os.homedir()): Promise<string | null> {
  const start = path.resolve(folder);
  if ((await entries(path.join(start, ".omp"))).length > 0) return null;
  let repoRoot: string | null = null;
  for (let dir = start; ; dir = path.dirname(dir)) {
    if ((await entries(dir)).includes(".git")) { repoRoot = dir; break; }
    if (path.dirname(dir) === dir) break;
  }
  // OMP stops at the repository root, inclusive (or at home when there is no repository): a folder that is the stop has nothing above it to lose.
  if (repoRoot !== null ? same(start, repoRoot) : same(start, path.resolve(home))) return null;
  for (let dir = path.dirname(start); path.dirname(start) !== start; dir = path.dirname(dir)) {
    if (!same(dir, path.resolve(home))) {
      const names = await entries(path.join(dir, ".omp"));
      if (names.length > 0) return names.some(name => CONTEXT_FILES.includes(name)) ? path.join(dir, ".omp") : null;
    }
    if (repoRoot !== null ? same(dir, repoRoot) : same(dir, path.resolve(home))) return null;
    if (path.dirname(dir) === dir) return null;
  }
  return null;
}

/**
 * The project folder for a workspace folder when the user opted into the nearest ancestor `.omp` (Unity projects: VS Code opens
 * `<repo>/omp-vscode` while OMP sessions run at `<repo>`, which holds `.omp`): the folder itself or its nearest ancestor whose `.omp` is
 * non-empty, the same walk OMP's own discovery makes (inclusive stop at the repository root, or at home when there is none, and
 * the home directory is never a project). Null when there is none.
 */
export async function nearestOmpFolder(folder: string, home: string = os.homedir()): Promise<string | null> {
  const resolvedHome = path.resolve(home);
  for (let dir = path.resolve(folder); ; dir = path.dirname(dir)) {
    if (same(dir, resolvedHome)) return null;
    if ((await entries(path.join(dir, ".omp"))).length > 0) return dir;
    if ((await entries(dir)).includes(".git") || path.dirname(dir) === dir) return null;
  }
}

/** The folder the editor treats as the project: the workspace folder, or with the setting on its nearest ancestor `.omp` folder, falling back to the workspace folder. */
export async function projectFolderFor(folder: string, useNearestAncestor: boolean, home: string = os.homedir()): Promise<string> {
  return useNearestAncestor ? await nearestOmpFolder(folder, home) ?? folder : folder;
}

/**
 * The nearest ancestor folder (never the folder itself) whose `.omp` is non-empty, when the folder has no non-empty `.omp` of its own and the
 * walk (inclusive stop at the repository root, or home) reaches one: the folder OMP sessions run in is probably that one, not this folder.
 */
export async function ancestorProjectFolder(folder: string, home: string = os.homedir()): Promise<string | null> {
  const start = path.resolve(folder);
  if ((await entries(path.join(start, ".omp"))).length > 0) return null;
  if ((await entries(start)).includes(".git") || same(start, path.resolve(home)) || path.dirname(start) === start) return null;
  return nearestOmpFolder(path.dirname(start), home);
}
