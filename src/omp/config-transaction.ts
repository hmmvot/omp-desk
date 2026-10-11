import * as fs from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { YAML } from "bun";
import { retryWindowsFileOperation } from "../host/file-operation-retry.ts";
import { mergeConfigEdits, valueAt, SettingsRefusal } from "../host/omp-settings-core.ts";
import { isRecord as record } from "../guards";
import type { ConfigEdit, ConfigRecord, SettingsScope } from "../host/omp-settings-core.ts";
import type { NativeModules } from "./settings-contracts.ts";

/**
 * The locked, conflict-checked YAML transaction both Bun workers use to change OMP's `config.yml`
 * (ADR-0048, ADR-0061): installed file lock, re-read under the lock, targeted-key merge, staged
 * fsync and replace, no unlink, exclusive first creation. OMP's serializer drops YAML comments.
 */
export interface FileBaseline { logical: string; physical: string; exists: boolean; digest: string; settings: ConfigRecord }
export interface ConfigWriteRequest { baseline?: FileBaseline; edits?: ConfigEdit[]; scope?: SettingsScope }

/** The two OMP utility modules the transaction needs; presence is checked, not assumed. */
async function utilsImport<Name extends "file-lock.ts" | "yaml-config.ts">(root: string, file: Name): Promise<NativeModules[Name]> {
  const loaded: unknown = await import(pathToFileURL(path.join(root, "src", file)).href);
  const name = file === "file-lock.ts" ? "withFileLock" : "stringifyYamlConfig";
  if (!record(loaded) || typeof loaded[name] !== "function") throw new SettingsRefusal("The installed OMP does not expose the required settings interface.");
  return loaded as unknown as NativeModules[Name];
}

export async function readConfig(logical: string): Promise<FileBaseline> {
  let physical: string;
  try { physical = await fs.realpath(logical); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const link = await fs.lstat(logical).catch((failure: NodeJS.ErrnoException) => {
      if (failure.code === "ENOENT") return null;
      throw failure;
    });
    if (link?.isSymbolicLink()) throw new SettingsRefusal("The config is a dangling symbolic link. Repair its target before saving.");
    // OMP uses the logical spelling for missing targets; first publication is no-replace.
    physical = path.resolve(logical);
  }
  let content: string;
  try { content = await fs.readFile(physical, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { logical, physical, exists: false, digest: "missing", settings: {} };
  }
  let parsed: unknown;
  try { parsed = YAML.parse(content); } catch { throw new SettingsRefusal("Config YAML cannot be parsed. Nothing was changed."); }
  if (parsed !== null && parsed !== undefined && !record(parsed)) throw new SettingsRefusal("Config YAML must be a mapping. Nothing was changed.");
  return { logical, physical, exists: true, digest: createHash("sha256").update(content).digest("hex"), settings: record(parsed) ? parsed : {} };
}

export async function stageFile(target: string, content: string): Promise<string> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const staged = `${target}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await fs.open(staged, "wx", 0o600);
  try {
    try { await handle.writeFile(content, "utf8"); await handle.sync(); }
    finally { await handle.close(); }
  } catch (error) { await fs.rm(staged, { force: true }).catch(() => {}); throw error; }
  return staged;
}

/**
 * Returns whether the file changed; edits that leave every entry as it is never rewrite it (and never strip its comments).
 * `allowed` replaces the Models/Agents editors' path allow-list for another caller.
 */
export async function writeConfig(
  request: ConfigWriteRequest, logical: string, utilsRoot: string,
  validate: (data: ConfigRecord, edits: ConfigEdit[]) => void, migratedGlobal: () => Promise<ConfigRecord>,
  allowed?: (path: readonly string[]) => boolean,
): Promise<boolean> {
  const baseline = request.baseline;
  if (!baseline || baseline.logical !== logical || !request.edits) throw new SettingsRefusal("Reload the editor before saving.");
  const beforeLock = await readConfig(logical);
  if (beforeLock.physical !== baseline.physical || beforeLock.exists !== baseline.exists) throw new SettingsRefusal("The config was removed, created or redirected. Reload before saving.");
  const { withFileLock } = await utilsImport(utilsRoot, "file-lock.ts");
  const { stringifyYamlConfig } = await utilsImport(utilsRoot, "yaml-config.ts");
  return withFileLock(baseline.physical, async () => {
    const current = await readConfig(logical);
    if (current.physical !== baseline.physical || current.exists !== baseline.exists) throw new SettingsRefusal("The config target changed. Reload before saving.");
    const layer = request.scope === "project" ? current.settings : await migratedGlobal();
    const merged = mergeConfigEdits(layer, baseline.settings, request.edits!, allowed);
    if (request.edits!.every(edit => isDeepStrictEqual(valueAt(layer, edit.path), edit.value))) return false;
    validate(merged, request.edits!);
    const content = stringifyYamlConfig(merged);
    const digest = createHash("sha256").update(content).digest("hex");
    if (digest === current.digest) return false;
    const staged = await stageFile(current.physical, content);
    try {
      const latest = await readConfig(logical);
      if (latest.physical !== current.physical || latest.exists !== current.exists || latest.digest !== current.digest) throw new SettingsRefusal("The config changed during saving. Reload; nothing was overwritten.");
      if (current.exists) await retryWindowsFileOperation(() => fs.rename(staged, current.physical));
      else await fs.link(staged, current.physical);
    } finally { await fs.rm(staged, { force: true }); }
    return true;
  });
}

/** OMP reads `config.yml`, or `config.yaml` when only that exists. */
export async function globalConfigFile(agentDir: string): Promise<string> {
  const preferred = path.join(agentDir, "config.yml");
  if (await fs.stat(preferred).catch(() => null)) return preferred;
  const alternate = path.join(agentDir, "config.yaml");
  return await fs.stat(alternate).catch(() => null) ? alternate : preferred;
}
