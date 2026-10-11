import * as path from "node:path";
import { isRecord as record } from "../guards.ts";

/**
 * True when an entry of Claude Code's plugin registry (`installed_plugins.json`) with a project or local scope records `cwd`
 * as its project (`canonical` maps a path to its physical identity, as OMP compares projects by real path): OMP then admits it into that folder's inventory, so the folder is not a project-free Global read.
 */
export function claudeRegistryBindsFolder(registry: unknown, cwd: string, canonical: (resolved: string) => string = resolved => resolved): boolean {
  const identity = (value: string): string => canonical(path.resolve(value)).toLowerCase();
  const here = identity(cwd);
  if (!record(registry) || !record(registry.plugins)) return false;
  return Object.values(registry.plugins).some(entries => Array.isArray(entries) && entries.some(entry =>
    record(entry) && (entry.scope === "project" || entry.scope === "local") && typeof entry.projectPath === "string" && identity(entry.projectPath) === here));
}
