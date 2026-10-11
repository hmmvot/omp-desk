import * as path from "node:path";
import { isRecord as record } from "../guards.ts";

/**
 * True when an entry of Claude Code's plugin registry (`installed_plugins.json`) with a project or local scope records `cwd`
 * as its project: OMP then admits it into that folder's inventory, so the folder is not a project-free Global read.
 */
export function claudeRegistryBindsFolder(registry: unknown, cwd: string): boolean {
  const here = path.resolve(cwd).toLowerCase();
  if (!record(registry) || !record(registry.plugins)) return false;
  return Object.values(registry.plugins).some(entries => Array.isArray(entries) && entries.some(entry =>
    record(entry) && (entry.scope === "project" || entry.scope === "local") && typeof entry.projectPath === "string" && path.resolve(entry.projectPath).toLowerCase() === here));
}
