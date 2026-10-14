import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/**
 * OMP loads AGENTS.md, RULES.md and SYSTEM.md from the nearest non-empty `.omp` directory between the folder and the repository
 * root, never from several (`findNearestProjectConfigDir` in `discovery/builtin.ts`). The home directory is never a project.
 * Creating `<folder>/.omp/config.yml` therefore makes the folder the nearest and stops an ancestor's files loading for its sessions.
 *
 * The editors bind the folder sessions run in: a session's own cwd, or `session-folder.ts`'s answer for the first opened workspace folder,
 * which is the checkout root for a folder inside one. OMP stops at a Git root, so a write there hides nothing; the refusal still applies
 * where OMP's walk reaches an ancestor `.omp`: a session folder that is not its checkout root (a session recorded in a subfolder, a pinned
 * subfolder row, a folder chosen with the dialog), a folder in a checkout of another system (Mercurial, Plastic, Subversion: OMP knows `.git`
 * only), a folder in none, and any folder when `ompDesk.runSessionsAtRepositoryRoot` is off.
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
