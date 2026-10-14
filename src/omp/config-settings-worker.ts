import * as fs from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { globalConfigFile, readConfig, writeConfig } from "./config-transaction.ts";
import { ancestorMessage, assertSchemaShape, baselineProjection, optionNumber, projectSnapshot, SHAPE_MESSAGE } from "./config-schema.ts";
import { ancestorContextDir } from "./config-ancestor.ts";
import type { NativeLayers, NativeSetting, NativeTabs } from "./config-schema.ts";
import { SettingsRefusal, valueAt } from "../host/omp-settings-core.ts";
import { isRecord as record } from "../shared/guards.ts";
import { parseNumericInput } from "../protocol/omp-config-model.ts";
import type { ConfigChange, ConfigEntry, ConfigFileBaseline, ConfigLayer, ConfigReceipt } from "../protocol/omp-config-model.ts";
import type { ConfigEdit, ConfigRecord } from "../protocol/settings-model.ts";

/**
 * Bun worker of the OMP Settings editor (ADR-0071). It imports OMP's own settings registry and tab
 * definitions from the selected installed source, projects them with the layer values and provenance of
 * a read-only `Settings` load, and writes one layer through the shared locked, conflict-checked
 * transaction. It never initializes OMP's writable settings singleton, and no credential value leaves it.
 * Run from a verified staged copy by `runSettingsWorker`; the receipt protocol is the settings worker's.
 */
interface WorkerRequest {
  packageRoot: string; cwd: string; profile: string; action: "read" | "write";
  /** False for the global scope and the home folder: no project layer is read, and OMP is run from the agent directory. */
  project?: boolean;
  scope?: ConfigLayer; changes?: ConfigChange[]; baseline?: ConfigFileBaseline;
}
interface Natives {
  dirs: { setProfile(profile: string): void; getAgentDir(): string; getProjectAgentDir(cwd: string): string };
  all: { orderedSettings(): readonly NativeSetting[] };
  registry: { lookup(id: string): NativeSetting | undefined };
  settings: { Settings: { loadReadOnly(options: { cwd: string; agentDir: string }): Promise<NativeLayers> } };
  discovery: {
    initializeWithSettings(settings: NativeLayers): () => void;
    loadCapability(id: string, options: { cwd: string }): Promise<{ items: readonly { path?: unknown; data?: unknown; level?: unknown }[] }>;
  };
  tabs: NativeTabs;
}

async function load(root: string, relative: string, names: readonly string[]): Promise<Record<string, unknown>> {
  // A module the supported release should have but cannot be imported is a drifted schema, not a bug to surface raw (its text could carry paths).
  const loaded: unknown = await import(pathToFileURL(path.join(root, relative)).href).catch(() => undefined);
  if (!record(loaded) || names.some(name => !(name in loaded))) throw new SettingsRefusal(SHAPE_MESSAGE);
  return loaded;
}

async function ompVersion(packageRoot: string): Promise<string> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(path.join(packageRoot, "package.json"), "utf8"));
    return record(parsed) && typeof parsed.version === "string" ? parsed.version : "";
  } catch { return ""; }
}

async function natives(packageRoot: string): Promise<Natives> {
  const parent = path.dirname(packageRoot);
  const [dirs, all, registry, settings, discovery, tabs] = await Promise.all([
    load(path.join(parent, "pi-utils"), "src/dirs.ts", ["setProfile", "getAgentDir", "getProjectAgentDir"]),
    load(packageRoot, "src/config/all-settings.ts", ["orderedSettings"]),
    load(packageRoot, "src/config/registry.ts", ["lookup"]),
    load(packageRoot, "src/config/settings.ts", ["Settings"]),
    load(packageRoot, "src/discovery/index.ts", ["initializeWithSettings", "loadCapability"]),
    load(path.join(parent, "pi-tui"), "src/overlays/settings-defs.ts", ["SETTING_TABS", "TAB_GROUPS", "getSettingsForTab"]),
  ]);
  return { dirs, all, registry, settings, discovery, tabs } as unknown as Natives;
}

async function main(request: WorkerRequest): Promise<unknown> {
  if (!path.isAbsolute(request.packageRoot) || !path.isAbsolute(request.cwd)) throw new SettingsRefusal("The settings context is unavailable.");
  const version = await ompVersion(request.packageRoot);
  const n = await natives(request.packageRoot);
  n.dirs.setProfile(request.profile);
  const agentDir = n.dirs.getAgentDir();
  const globalFile = await globalConfigFile(agentDir);
  const withProject = request.project !== false;
  // Without a project layer OMP runs from the agent directory, which has no project config of its own.
  const cwd = withProject ? request.cwd : agentDir;
  const projectFile = path.join(n.dirs.getProjectAgentDir(cwd), "config.yml");
  const ordered = n.all.orderedSettings();
  assertSchemaShape({ tabs: n.tabs, settings: ordered, lookup: n.registry.lookup });
  const loadSettings = async (): Promise<NativeLayers> => n.settings.Settings.loadReadOnly({ cwd, agentDir });
  const settings = await loadSettings();
  const release = n.discovery.initializeWithSettings(settings);
  try {
    const files = { global: await readConfig(globalFile), project: await readConfig(projectFile) };
    const migratedGlobal = settings.getGlobalSettings();
    const ancestorOmp = withProject && !files.project.exists ? await ancestorContextDir(cwd) : null;
    const snapshot = projectSnapshot({
      tabs: n.tabs, settings: ordered, layers: settings, nativeProject: files.project.settings, lookup: n.registry.lookup,
      projectFiles: withProject ? await projectFilesOf(n, cwd, projectFile) : [],
      platform: process.platform, version, profile: request.profile,
      files: { global: { path: globalFile, exists: files.global.exists }, project: { path: projectFile, exists: files.project.exists, ancestorOmp } },
    });
    if (request.action === "read") {
      const receipt: ConfigReceipt = {
        snapshot,
        baselines: {
          global: { ...files.global, settings: baselineProjection(migratedGlobal, ordered) },
          project: { ...files.project, settings: baselineProjection(files.project.settings, ordered) },
        },
      };
      return receipt;
    }
    return write(request, n, snapshot.entries, ordered, { globalFile, projectFile: withProject ? projectFile : null, ancestorOmp, loadSettings });
  } finally { release(); }
}

/** Every project settings file OMP merges, lowest precedence first, as OMP's own discovery returns them. */
async function projectFilesOf(n: Natives, cwd: string, ownFile: string): Promise<{ file: string; native: boolean; data: ConfigRecord }[]> {
  const found = await n.discovery.loadCapability("settings", { cwd }).catch(() => undefined);
  if (!found || !Array.isArray(found.items)) throw new SettingsRefusal(SHAPE_MESSAGE);
  const fold = (value: string): string => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
  const files: { file: string; native: boolean; data: ConfigRecord }[] = [];
  for (const item of found.items) {
    if (item.level !== "project" || typeof item.path !== "string" || !record(item.data)) continue;
    files.push({ file: path.relative(cwd, item.path).split(path.sep).join("/"), native: fold(item.path) === fold(ownFile), data: item.data });
  }
  return files;
}

/** Every refusal names the setting and the reason; nothing is written before all of them pass. */
async function write(
  request: WorkerRequest, n: Natives, entries: readonly ConfigEntry[], ordered: readonly NativeSetting[],
  where: { globalFile: string; projectFile: string | null; ancestorOmp: string | null; loadSettings(): Promise<NativeLayers> },
): Promise<{ saved: true; changed: boolean }> {
  const layer = request.scope;
  if (layer !== "global" && layer !== "project") throw new SettingsRefusal("Choose global or project scope.");
  if (layer === "project") {
    if (where.projectFile === null) throw new SettingsRefusal("This scope has no project layer. Nothing was changed.");
    if (where.ancestorOmp !== null) throw new SettingsRefusal(ancestorMessage(where.projectFile, where.ancestorOmp));
  }
  const changes = request.changes;
  if (!Array.isArray(changes) || changes.length === 0 || changes.length > 50) throw new SettingsRefusal("No valid settings changes were provided.");
  const planned: { setting: NativeSetting; edit: ConfigEdit; set: boolean }[] = [];
  const seen = new Set<string>();
  for (const change of changes) {
    if (!record(change) || typeof change.id !== "string" || change.layer !== layer || (change.op !== "set" && change.op !== "reset")) throw new SettingsRefusal("The settings changes are invalid.");
    if (seen.has(change.id)) throw new SettingsRefusal(`Change ${change.id} only once per save.`);
    seen.add(change.id);
    const entry = entries.find(candidate => candidate.id === change.id);
    const setting = n.registry.lookup(change.id);
    if (!entry || !setting) throw new SettingsRefusal(`OMP has no setting ${change.id}.`);
    if (entry.readOnly) throw new SettingsRefusal(`${entry.label} cannot be changed here. ${entry.readOnly.note}`);
    if (!entry.visible) throw new SettingsRefusal(`OMP hides ${entry.label} while its condition is false. ${entry.condition?.note ?? ""}`.trim());
    if (!entry.writable[layer]) throw new SettingsRefusal(`${entry.label} cannot be written to the ${layer} layer.`);
    if (change.op === "reset") { planned.push({ setting, edit: { path: setting.segments }, set: false }); continue; }
    planned.push({ setting, edit: { path: setting.segments, value: checkedValue(entry, setting, change.value) }, set: true });
  }
  const paths = ordered.map(setting => setting.segments);
  const allowed = (target: readonly string[]): boolean => target.every(key => key.length > 0 && key.length <= 256 && !["__proto__", "prototype", "constructor"].includes(key))
    && paths.some(known => known.length === target.length && known.every((key, index) => key === target[index]));
  const validate = (data: ConfigRecord): void => {
    for (const item of planned) {
      if (!item.set) continue;
      try { item.setting.assertWritable(valueAt(data, item.setting.segments)); }
      catch (error) { throw new SettingsRefusal(`OMP rejected the value for ${item.setting.id}: ${(error instanceof Error ? error.message : "invalid value").slice(0, 300)}`); }
    }
  };
  const file = layer === "project" ? where.projectFile! : where.globalFile;
  const utilsRoot = path.join(path.dirname(request.packageRoot), "pi-utils");
  const changed = await writeConfig(
    { baseline: request.baseline, edits: planned.map(item => item.edit), scope: layer, pruneEmpty: true }, file, utilsRoot, validate,
    async () => (await where.loadSettings()).getGlobalSettings(), allowed,
  );
  return { saved: true, changed };
}

/** The value as the control gives it, normalized the way OMP does on its way in. */
function checkedValue(entry: ConfigEntry, setting: NativeSetting, value: unknown): unknown {
  const control = entry.control!;
  const refuse = (): never => { throw new SettingsRefusal(`That is not one of the values OMP lists for ${entry.label}.`); };
  let checked: unknown;
  switch (control.kind) {
    case "boolean": if (typeof value !== "boolean") refuse(); checked = value; break;
    case "enum": if (typeof value !== "string" || !control.options.some(option => option.value === value)) refuse(); checked = value; break;
    case "number": {
      const listed = control.options.map(option => optionNumber(option.value));
      if (typeof value !== "number" || !listed.includes(value)) refuse();
      checked = value; break;
    }
    case "numeric": {
      const parsed = typeof value === "number" ? parseNumericInput(String(value), control.integer) : { error: "Enter a number." };
      if ("error" in parsed) throw new SettingsRefusal(`${entry.label}: ${parsed.error}`);
      checked = parsed.value; break;
    }
    case "text": if (typeof value !== "string" || value.length > 4096) throw new SettingsRefusal(`${entry.label} must be text of at most 4096 characters.`); checked = value; break;
    case "multiselect": {
      const allowed = control.options.map(option => option.value);
      if (!Array.isArray(value) || value.length > allowed.length || !value.every(item => typeof item === "string" && allowed.includes(item)) || new Set(value).size !== value.length) refuse();
      checked = [...value as string[]]; break;
    }
  }
  try { return setting.definition.normalize ? setting.definition.normalize(checked) : checked; }
  catch (error) { throw new SettingsRefusal(`OMP rejected the value for ${setting.id}: ${(error instanceof Error ? error.message : "invalid value").slice(0, 300)}`); }
}

try {
  let input = "";
  for await (const chunk of process.stdin) { input += chunk; if (input.length > 1024 * 1024) throw new SettingsRefusal("The settings request is too large."); }
  const parsed: unknown = JSON.parse(input);
  if (!record(parsed) || typeof parsed.packageRoot !== "string" || typeof parsed.cwd !== "string" || typeof parsed.profile !== "string" || !["read", "write"].includes(String(parsed.action))) throw new SettingsRefusal("The settings request is invalid.");
  const result = await main(parsed as unknown as WorkerRequest);
  process.stdout.write(`OMP_DESK_SETTINGS ${JSON.stringify({ ok: true, result })}\n`);
} catch (error) {
  const message = error instanceof SettingsRefusal ? error.message
    : record(error) && error.code === "EEXIST" ? "The target already exists; nothing was overwritten."
    : "OMP could not complete this settings operation. Check the installed runtime and the config files; reload before retrying.";
  process.stdout.write(`OMP_DESK_SETTINGS ${JSON.stringify({ ok: false, error: message })}\n`);
  process.exitCode = 1;
}
