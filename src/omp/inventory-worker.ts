import { existsSync, readFileSync, realpathSync } from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { claudeRegistryBindsFolder } from "./inventory-guards.ts";
import { SettingsRefusal, valueAt } from "../host/omp-settings-core.ts";
import { PROTECTED_EXTENSION_NAMES } from "../host/inventory/inventory-model.ts";
import { isRecord as record } from "../guards";
import { BUILTIN_SWITCHES, SHARED_SWITCH_NOTES } from "./inventory-switches.ts";
import { globalConfigFile, readConfig, writeConfig } from "./config-transaction.ts";
import type { ConfigEdit, ConfigRecord } from "../host/omp-settings-core.ts";
import type { InventoryRow, InventorySnapshot, RowToggle, ViewKind } from "../host/inventory/inventory-model.ts";

/**
 * Bun worker for ADR-0061: reads OMP's own extension inventory (the TUI dashboard's
 * `loadAllExtensions`, checked against warning-bearing capability loads and OMP's effective skill
 * loader) and writes OMP's own user-level switches. It never writes a project file. Run from a
 * verified staged copy by `runSettingsWorker`; the receipt protocol is the settings worker's.
 */
interface WorkerRequest {
  packageRoot: string; cwd: string; profile: string;
  /** `global` means `cwd` must hold no project layer; the worker refuses to describe a polluted one. */
  scope: "session" | "global";
  action: "read" | "toggle";
  kind?: string; name?: string; enabled?: boolean;
}
interface NativeSetting { readonly id: string; readonly type: string; get(settings: unknown): unknown; assertWritable(value: unknown): void }
interface NativeSettings {
  getGlobalSettings(): ConfigRecord; getProjectSettings(): ConfigRecord; extensionsSourceLevel(): "user" | "project";
}
interface NativeExtension {
  id: string; kind: string; name: string; description?: string; path: string;
  source: { provider: string; providerName: string; level: string };
  state: "active" | "disabled" | "shadowed"; disabledReason?: string; raw: unknown;
}
interface NativeSkill { name: string; description: string; filePath: string; source: string; _source?: { provider?: string; providerName?: string; level?: string } }
interface NativePlugin { name: string; version: string; path: string; manifest: { extensions?: string[] }; enabled: boolean }
interface Natives {
  dirs: { setProfile(profile: string): void; getAgentDir(): string; getMCPConfigPath(scope: "user" | "project", cwd: string): string };
  settings: { Settings: { loadReadOnly(options: { cwd: string; agentDir: string }): Promise<NativeSettings> } };
  discovery: { initializeWithSettings(settings: NativeSettings): () => void; loadCapability(id: string, options: Record<string, unknown>): Promise<{ all: unknown[]; warnings: string[] }> };
  extSettings: { cfgDisabledExtensions: NativeSetting; cfgExtensions: NativeSetting; cfgSkills: NativeSetting };
  state: { loadAllExtensions(cwd: string, disabled: string[]): Promise<NativeExtension[]> };
  skills: { loadSkills(options: Record<string, unknown>): Promise<{ skills: NativeSkill[]; warnings: unknown[] }> };
  loader: { discoverExtensionPaths(configured: string[], cwd: string, disabled: string[], options: { ambient: boolean }): Promise<string[]> };
  helpers: { getExtensionNameFromPath(extensionPath: string): string };
  tools: { BUILTIN_TOOLS: Record<string, unknown> };
  registry: { lookup(id: string): NativeSetting | undefined };
  plugins: { PluginManager: new (cwd: string) => { list(): Promise<NativePlugin[]>; setEnabled(name: string, enabled: boolean): Promise<void> } };
  pluginLoader: { getEnabledPlugins(cwd: string): Promise<Array<NativePlugin & { scope: "user" | "project" }>> };
  writer: { setServerDisabled(file: string, name: string, disabled: boolean): Promise<void>; setServerForceEnabled(file: string, name: string, force: boolean): Promise<void>;
    readDisabledServers(file: string): Promise<string[]>; readEnabledServers(file: string): Promise<string[]> };
  bridge: { createMCPToolName(server: string, tool: string): string };
  claudePaths: { resolveClaudePaths(): { configDir: string } };
  transport: { inferMcpTransport(server: unknown): string };
}

/** The selected OMP install is runtime-specific and must not be bundled with the extension. */
async function load(root: string, file: string, names: readonly string[]): Promise<Record<string, unknown>> {
  // The module path is chosen at run time from the installed OMP; a static import cannot name it.
  const loaded: unknown = await import(pathToFileURL(path.join(root, "src", file)).href);
  if (!record(loaded) || !names.every(name => loaded[name] !== undefined)) throw new SettingsRefusal("The installed OMP does not expose the interface this view needs.");
  return loaded;
}
async function natives(packageRoot: string): Promise<Natives> {
  const scope = path.dirname(packageRoot);
  const [claudePaths, dirs, settings, discovery, extSettings, state, skills, loader, helpers, tools, registry, plugins, pluginLoader, writer, bridge, transport] = await Promise.all([
    load(packageRoot, "config/claude-paths.ts", ["resolveClaudePaths"]),
    load(path.join(scope, "pi-utils"), "dirs.ts", ["setProfile", "getAgentDir", "getMCPConfigPath"]),
    load(packageRoot, "config/settings.ts", ["Settings"]),
    load(packageRoot, "discovery/index.ts", ["initializeWithSettings", "loadCapability"]),
    load(packageRoot, "extensibility/settings.ts", ["cfgDisabledExtensions", "cfgExtensions", "cfgSkills"]),
    load(packageRoot, "modes/components/extensions/state-manager.ts", ["loadAllExtensions"]),
    load(packageRoot, "extensibility/skills.ts", ["loadSkills"]),
    load(packageRoot, "extensibility/extensions/loader.ts", ["discoverExtensionPaths"]),
    load(packageRoot, "discovery/helpers.ts", ["getExtensionNameFromPath"]),
    load(packageRoot, "tools/index.ts", ["BUILTIN_TOOLS"]),
    load(packageRoot, "config/registry.ts", ["lookup"]),
    load(packageRoot, "extensibility/plugins/manager.ts", ["PluginManager"]),
    load(packageRoot, "extensibility/plugins/loader.ts", ["getEnabledPlugins"]),
    load(packageRoot, "mcp/config-writer.ts", ["setServerDisabled", "setServerForceEnabled", "readDisabledServers", "readEnabledServers"]),
    load(packageRoot, "mcp/tool-bridge.ts", ["createMCPToolName"]),
    load(path.join(scope, "pi-tui"), "overlays/extensions/mcp-runtime.ts", ["inferMcpTransport"]),
  ]);
  return { claudePaths, dirs, settings, discovery, extSettings, state, skills, loader, helpers, tools, registry, plugins, pluginLoader, writer, bridge, transport } as unknown as Natives;
}

const TEXT_LIMIT = 500;
const text = (value: unknown): string | null => typeof value === "string" && value.trim().length > 0 ? value.trim().slice(0, TEXT_LIMIT) : null;
const samePath = (a: string, b: string): boolean => path.normalize(a).toLowerCase() === path.normalize(b).toLowerCase();

/** Warnings that mean a source was skipped or unreadable, not a naming notice: such a list can be incomplete. */
// (A missing optional file such as `<ancestor>/.vscode/mcp.json` is reported as "Failed to read" and is not an omission.)
const OMISSION = /Failed to (load|parse)|Invalid (item|plugin|JSON|config)|no installPath/i;

/** Files that SELECT project-level plugin rows or project settings without the rows themselves living in a project folder. */
function projectMarkers(cwd: string, claudeConfigDir: string): string[] {
  const found: string[] = [];
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    for (const relative of [[".omp", "plugins", "installed_plugins.json"], [".claude", "settings.json"], [".claude", "settings.local.json"]]) {
      if (existsSync(path.join(dir, ...relative))) found.push(`file ${relative.join("/")}`);
    }
    if (path.dirname(dir) === dir) break;
  }
  // OMP admits an entry of the user's Claude plugin registry into a project's inventory when its recorded projectPath is that project.
  try {
    const registry: unknown = JSON.parse(readFileSync(path.join(claudeConfigDir, "plugins", "installed_plugins.json"), "utf8"));
    if (claudeRegistryBindsFolder(registry, cwd, resolved => { try { return realpathSync.native(resolved); } catch { return resolved; } })) found.push("Claude plugin entry bound to this folder");
  } catch { /* no readable Claude registry: nothing selects a project entry from it */ }
  return found;
}
/** A file inside a dot-folder of `cwd` or one of its ancestors (`.omp/`, `.claude/`, `.agents/`): the shape of a project layer, whatever level OMP's provider claims. */
function inProjectFolder(file: string, cwd: string): boolean {
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    const relative = path.relative(dir, file);
    if (relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative) && relative.split(path.sep)[0]!.startsWith(".")) return true;
    if (path.dirname(dir) === dir) return false;
  }
}

/** Command base name or URL host only: arguments, environment, headers and query strings can carry secrets. */
function endpointOf(server: ConfigRecord, transport: string): string {
  if (transport === "stdio") return typeof server.command === "string" && server.command.length > 0 ? path.basename(server.command.replaceAll("\\", "/")) : "no command";
  try { return typeof server.url === "string" ? new URL(server.url).host : "no url"; } catch { return "invalid url"; }
}

const VIEW_OF_CAPABILITY: Readonly<Record<string, ViewKind>> = { skills: "skills", tools: "tools", mcps: "mcp", "extension-modules": "extensions" };

function disabledToggle(ext: NativeExtension, mechanism: RowToggle["mechanism"]): RowToggle {
  const raw = record(ext.raw) ? ext.raw : {};
  if (ext.state === "shadowed" || raw._shadowed === true) return { mechanism: null, refusal: "a higher-priority item of the same name shadows it" };
  if (ext.disabledReason === "provider-disabled") return { mechanism: null, refusal: "its provider is disabled in OMP" };
  if (ext.disabledReason === "user-opt-in") return { mechanism: null, refusal: "its user-level source is not enabled in OMP" };
  return { mechanism, refusal: null };
}

interface Collected { snapshot: InventorySnapshot; mcpEntryDisabled: ReadonlySet<string>; globalDisabled: readonly string[]; mcpDenied: ReadonlySet<string>; mcpForced: ReadonlySet<string> }

async function collect(request: WorkerRequest, n: Natives): Promise<Collected> {
  n.dirs.setProfile(request.profile);
  const agentDir = n.dirs.getAgentDir();
  const settings = await n.settings.Settings.loadReadOnly({ cwd: request.cwd, agentDir });
  const release = n.discovery.initializeWithSettings(settings);
  try {
    const disabledSetting = n.extSettings.cfgDisabledExtensions.get(settings);
    const disabled = Array.isArray(disabledSetting) ? disabledSetting.filter((id): id is string => typeof id === "string") : [];
    const project = settings.getProjectSettings();
    const globalLayer = settings.getGlobalSettings();
    const globalDisabled = Array.isArray(globalLayer.disabledExtensions) ? globalLayer.disabledExtensions.filter((id): id is string => typeof id === "string") : [];
    const overridden = Array.isArray(project.disabledExtensions);
    const projectDisabled = overridden ? (project.disabledExtensions as unknown[]).filter((id): id is string => typeof id === "string") : [];
    const extensions = await n.state.loadAllExtensions(request.cwd, disabled);
    const incomplete = new Set<ViewKind>();
    const rows: InventoryRow[] = [];
    const mcpEntryDisabled = new Set<string>();
    const idToggle = (ext: NativeExtension): RowToggle => {
      const toggle = disabledToggle(ext, "disabledExtensions");
      return overridden && toggle.mechanism !== null ? { mechanism: null, refusal: "this project's config replaces the global disabledExtensions list" } : toggle;
    };
    const kinds = { skill: 0, tool: 0, mcp: 0, "extension-module": 0 };
    for (const ext of extensions) {
      const source = { provider: String(ext.source.provider), providerName: String(ext.source.providerName), level: ext.source.level === "project" ? "project" as const : ext.source.level === "native" ? "native" as const : "user" as const };
      const raw = record(ext.raw) ? ext.raw : {};
      const common = { name: ext.name, path: text(ext.path), ...source, state: ext.state, shadowed: ext.state === "shadowed" || raw._shadowed === true,
        disabledReason: ext.disabledReason ?? null, toolPrefix: null, detail: null as string | null, runtimeName: null as string | null };
      if (ext.kind === "skill") { kinds.skill++; rows.push({ ...common, kind: "skill", description: text(ext.description), toggle: idToggle(ext) }); }
      else if (ext.kind === "tool") { kinds.tool++; rows.push({ ...common, kind: "custom-tool", description: text(ext.description), toggle: idToggle(ext) }); }
      else if (ext.kind === "extension-module") {
        if (ext.source.provider === "native") kinds["extension-module"]++;
        rows.push({ ...common, kind: "extension-module", description: null,
          toggle: Object.hasOwn(PROTECTED_EXTENSION_NAMES, ext.name) ? { mechanism: null, refusal: "OMP Desk depends on this extension" } : idToggle(ext) });
      } else if (ext.kind === "mcp") {
        kinds.mcp++;
        const transport = n.transport.inferMcpTransport(raw);
        const minted = n.bridge.createMCPToolName(ext.name, "x");
        if (raw.enabled === false) mcpEntryDisabled.add(ext.name);
        const excluded = projectDisabled.includes(`mcp:${ext.name}`);
        rows.push({ ...common, kind: "mcp", description: null, detail: `${transport} · ${endpointOf(raw, transport)}`,
          toolPrefix: minted.endsWith("_x") ? minted.slice(0, -1) : null,
          toggle: excluded ? { mechanism: null, refusal: "this project's config disables it by name, which a global switch cannot override" } : disabledToggle(ext, "mcp") });
      }
    }

    // The dashboard loader logs and swallows per-kind failures; check against warning-bearing loads.
    const expected: Readonly<Record<string, number>> = { skills: kinds.skill, tools: kinds.tool, mcps: kinds.mcp, "extension-modules": kinds["extension-module"] };
    await Promise.all(Object.entries(VIEW_OF_CAPABILITY).map(async ([capability, view]) => {
      try {
        const result = await n.discovery.loadCapability(capability, { cwd: request.cwd, includeDisabled: true, disabledExtensions: disabled, ...(capability === "extension-modules" ? { providers: ["native"] } : {}) });
        const failed = result.warnings.some(warning => OMISSION.test(warning));
        if (failed || result.all.length !== expected[capability]) incomplete.add(view);
      } catch { incomplete.add(view); }
    }));

    // OMP's effective skill set (custom directories, collision renames, source eligibility) names each skill as a session
    // registers it; a second load with nothing disabled is the superset that keeps a disabled custom-directory skill listed.
    try {
      const skillOptions = n.extSettings.cfgSkills.get(settings) as { customDirectories?: string[] };
      // OMP expands `~` itself; only a relative directory is anchored here.
      const customDirectories = skillOptions.customDirectories?.map(dir => path.isAbsolute(dir) || dir === "~" || dir.startsWith("~/") || dir.startsWith("~\\") ? dir : path.resolve(request.cwd, dir));
      const base = { ...skillOptions, ...(customDirectories === undefined ? {} : { customDirectories }), cwd: request.cwd,
        extensionRoots: { explicit: [], mode: "merge", configured: n.extSettings.cfgExtensions.get(settings), configuredLevel: settings.extensionsSourceLevel() } };
      const [effective, everything] = await Promise.all([n.skills.loadSkills({ ...base, disabledExtensions: disabled }), n.skills.loadSkills({ ...base, disabledExtensions: [] })]);
      if ([...effective.warnings, ...everything.warnings].some(warning => OMISSION.test(JSON.stringify(warning)))) incomplete.add("skills");
      const runtime = [...effective.skills];
      const nameOf = (file: string): string | null => { const at = runtime.findIndex(skill => samePath(skill.filePath, file)); return at < 0 ? null : runtime.splice(at, 1)[0]!.name; };
      for (const row of rows) {
        if (row.kind !== "skill" || row.path === null) continue;
        rows[rows.indexOf(row)] = { ...row, runtimeName: nameOf(row.path) };
      }
      const listed = new Set(rows.filter(row => row.kind === "skill" && row.path !== null).map(row => path.normalize(row.path!).toLowerCase()));
      for (const skill of everything.skills) {
        if (listed.has(path.normalize(skill.filePath).toLowerCase())) continue;
        const off = disabled.includes(`skill:${skill.name}`);
        rows.push({ kind: "skill", name: skill.name, description: text(skill.description), path: text(skill.filePath), provider: skill._source?.provider ?? "custom",
          providerName: skill._source?.providerName ?? "Custom directory", level: skill._source?.level === "project" ? "project" : "user", state: off ? "disabled" : "active", shadowed: false,
          disabledReason: null, detail: null, toolPrefix: null, runtimeName: nameOf(skill.filePath),
          toggle: overridden ? { mechanism: null, refusal: "this project's config replaces the global disabledExtensions list" } : { mechanism: "disabledExtensions", refusal: null } });
      }
    } catch { incomplete.add("skills"); }

    // Configured extension files outside OMP's native directories: shown, never switched here.
    try {
      const configured = n.extSettings.cfgExtensions.get(settings);
      const paths = Array.isArray(configured) && configured.length > 0
        ? await n.loader.discoverExtensionPaths(configured.filter((entry): entry is string => typeof entry === "string"), request.cwd, [], { ambient: false }) : [];
      const level = settings.extensionsSourceLevel() === "project" ? "project" as const : "user" as const;
      for (const extensionPath of paths) {
        if (rows.some(row => row.kind === "extension-module" && row.path !== null && samePath(row.path, extensionPath))) continue;
        rows.push({ kind: "extension-module", name: n.helpers.getExtensionNameFromPath(extensionPath), description: null, path: extensionPath, provider: "configured", providerName: "Configured path", level,
          state: "active", shadowed: false, disabledReason: null, detail: null, toolPrefix: null, runtimeName: null,
          toggle: { mechanism: null, refusal: "it is configured through OMP's `extensions` setting" } });
      }
    } catch { incomplete.add("extensions"); }

    for (const tool of Object.keys(n.tools.BUILTIN_TOOLS)) {
      const switchId = BUILTIN_SWITCHES[tool];
      const setting = switchId === undefined ? undefined : n.registry.lookup(switchId);
      const value = setting?.get(settings);
      let toggle: RowToggle = { mechanism: null, refusal: SHARED_SWITCH_NOTES[tool] ? `it ${SHARED_SWITCH_NOTES[tool]}` : "OMP has no on/off switch for this tool" };
      let detail: string | null = SHARED_SWITCH_NOTES[tool] ?? null;
      if (setting?.type === "boolean") toggle = valueAt(project, setting.id.split(".")) !== undefined ? { mechanism: null, refusal: "this project's config sets it" } : { mechanism: "setting", refusal: null };
      else if (setting !== undefined) { toggle = { mechanism: null, refusal: "OMP offers this tool as a multi-state setting; change it in OMP's settings" }; detail = `${setting.id}: ${String(value)}`; }
      if (SHARED_SWITCH_NOTES[tool] && setting !== undefined && setting.type === "boolean") detail = SHARED_SWITCH_NOTES[tool]!;
      rows.push({ kind: "builtin-tool", name: tool, description: null, path: null, provider: "builtin", providerName: "Built-in", level: "builtin",
        state: value === false || value === "off" ? "disabled" : "active", shadowed: false, disabledReason: null, detail, toolPrefix: null, runtimeName: null, toggle });
    }

    // Plugins: user plugins are switched globally (Global scope only). In a session the project's copy of a package wins
    // over the user's (OMP's loader), so the user's copy is shown as shadowed and the project's is listed read-only.
    try {
      const plugins = await new n.plugins.PluginManager(request.cwd).list();
      const projectCopies = new Map((request.scope === "session" ? await n.pluginLoader.getEnabledPlugins(request.cwd) : []).filter(plugin => plugin.scope === "project").map(plugin => [plugin.name, plugin] as const));
      for (const plugin of plugins) {
        const count = plugin.manifest.extensions?.length ?? 0;
        const shadowed = projectCopies.has(plugin.name);
        rows.push({ kind: "plugin", name: plugin.name, description: null, path: path.join(plugin.path, "package.json"), provider: "omp-plugins", providerName: "OMP package", level: "user",
          state: shadowed ? "shadowed" : plugin.enabled ? "active" : "disabled", shadowed, disabledReason: shadowed ? "shadowed" : null,
          detail: `v${plugin.version}${count > 0 ? ` · ${count} extension entr${count === 1 ? "y" : "ies"}` : ""}`, toolPrefix: null, runtimeName: null,
          toggle: shadowed ? { mechanism: null, refusal: "this project's copy of the package is the one OMP loads" }
            : request.scope === "global" ? { mechanism: "plugin", refusal: null } : { mechanism: null, refusal: "switch the view to Global to enable or disable plugins" } });
      }
      for (const plugin of projectCopies.values()) {
        rows.push({ kind: "plugin", name: plugin.name, description: null, path: path.join(plugin.path, "package.json"), provider: "omp-plugins", providerName: "OMP package", level: "project",
          state: "active", shadowed: false, disabledReason: null, detail: `v${plugin.version} · installed in this project`, toolPrefix: null, runtimeName: null,
          toggle: { mechanism: null, refusal: "it is installed in this project; manage it there" } });
      }
    } catch { incomplete.add("extensions"); }

    // OMP reports the install scope of a marketplace plugin but not which registry selected it (a project registry or a user one): no global switch is offered for such a row.
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      if (row.provider === "claude-plugins" && row.level === "project" && row.toggle.mechanism !== null) rows[i] = { ...row, toggle: { mechanism: null, refusal: "OMP marks this marketplace plugin as project-scoped without saying which registry selected it" } };
    }

    // Global must be user-only: a project layer at the neutral folder would shadow rows and settings silently.
    // Row payloads can sit outside the project's own folders (a project plugin registry points into a user cache),
    // so the registry and settings files that SELECT such rows are checked as well as where the rows live.
    if (request.scope === "global") {
      const found = [...Object.keys(project).map(key => `setting ${key}`), ...projectMarkers(request.cwd, n.claudePaths.resolveClaudePaths().configDir),
        ...rows.filter(row => row.path !== null && inProjectFolder(row.path, request.cwd)).map(row => `${row.kind} ${row.name}`)];
      if (found.length > 0) throw new SettingsRefusal(`OMP found project configuration at the folder used for the Global inventory (${found.slice(0, 3).join(", ")}), so Global cannot be shown reliably. Remove that project configuration.`);
    }
    const providerSetting = n.registry.lookup("disabledProviders")?.get(settings);
    const disabledProviders = Array.isArray(providerSetting) ? providerSetting.filter((id): id is string => typeof id === "string").slice(0, 50) : [];
    const userMcp = n.dirs.getMCPConfigPath("user", request.cwd);
    const [mcpDenied, mcpForced] = await Promise.all([n.writer.readDisabledServers(userMcp).catch(() => [] as string[]), n.writer.readEnabledServers(userMcp).catch(() => [] as string[])]);
    return { snapshot: { rows, cwd: request.cwd, profile: request.profile, projectOverridesDisabledExtensions: overridden, incomplete: [...incomplete], disabledProviders }, mcpEntryDisabled, globalDisabled,
      mcpDenied: new Set(mcpDenied), mcpForced: new Set(mcpForced) };
  } finally { release(); }
}

function validName(name: unknown): name is string { return typeof name === "string" && name.length > 0 && name.length <= 256 && !/[\u0000-\u001f]/.test(name) }

/** One thing a switch changed: the file (`null` where OMP's own plugin store owns the location) and a short credential-free description. */
interface ToggleWrite { file: string | null; what: string }
const listWrite = (file: string, id: string, present: boolean): ToggleWrite => ({ file, what: `disabledExtensions ${present ? "+" : "-"} ${id}` });

async function toggle(request: WorkerRequest, n: Natives): Promise<{ changed: boolean; writes: ToggleWrite[] }> {
  const { kind, name, enabled } = request;
  if (!validName(name) || typeof enabled !== "boolean") throw new SettingsRefusal("The switch request is invalid.");
  const collected = await collect(request, n);
  const { snapshot, mcpEntryDisabled } = collected;
  const row = snapshot.rows.find(candidate => candidate.kind === kind && candidate.name === name);
  const view: Readonly<Record<string, ViewKind>> = { skill: "skills", "custom-tool": "tools", "builtin-tool": "tools", mcp: "mcp", "extension-module": "extensions", plugin: "extensions" };
  if (row !== undefined && snapshot.incomplete.includes(view[row.kind]!)) throw new SettingsRefusal("OMP reported a failure loading some sources of this kind. Refresh before switching anything.");
  const utilsRoot = path.join(path.dirname(request.packageRoot), "pi-utils");
  const agentDir = n.dirs.getAgentDir();
  const globalFile = await globalConfigFile(agentDir);
  const reload = async (): Promise<ConfigRecord> => (await n.settings.Settings.loadReadOnly({ cwd: request.cwd, agentDir })).getGlobalSettings();
  const baseline = async () => ({ ...(await readConfig(globalFile)), settings: structuredClone(await reload()) });
  const write = async (edit: ConfigEdit, allowed: (path: readonly string[]) => boolean, validate: (data: ConfigRecord) => void): Promise<boolean> =>
    writeConfig({ baseline: await baseline(), edits: [edit], scope: "global" }, globalFile, utilsRoot, data => validate(data), reload, allowed);
  const listEdit = async (id: string, present: boolean): Promise<boolean> => {
    // The edited array is computed from the very baseline the locked transaction compares against.
    const base = await baseline();
    const current = base.settings.disabledExtensions;
    const list = Array.isArray(current) ? current.filter((entry): entry is string => typeof entry === "string") : [];
    if (list.includes(id) === present) return false;
    const next = present ? [...list, id] : list.filter(entry => entry !== id);
    return writeConfig({ baseline: base, edits: [{ path: ["disabledExtensions"], value: next }], scope: "global" }, globalFile, utilsRoot,
      data => { try { n.extSettings.cfgDisabledExtensions.assertWritable(valueAt(data, ["disabledExtensions"])); } catch { throw new SettingsRefusal("OMP rejected the new disabled list. Nothing was changed."); } },
      reload, edit => edit.length === 1 && edit[0] === "disabledExtensions");
  };
  if (kind === "skill" || kind === "custom-tool" || kind === "extension-module") {
    if (kind === "extension-module" && Object.hasOwn(PROTECTED_EXTENSION_NAMES, name)) throw new SettingsRefusal("OMP Desk depends on this extension and cannot disable it.");
    if (row === undefined || row.toggle.mechanism !== "disabledExtensions") throw new SettingsRefusal(row?.toggle.refusal ? `This item cannot be switched: ${row.toggle.refusal}.` : "OMP no longer lists this item. Refresh and try again.");
    const id = `${kind === "custom-tool" ? "tool" : kind}:${name}`;
    const changed = await listEdit(id, !enabled);
    return { changed, writes: changed ? [listWrite(globalFile, id, !enabled)] : [] };
  }
  if (kind === "builtin-tool") {
    const switchId = BUILTIN_SWITCHES[name];
    const setting = switchId === undefined ? undefined : n.registry.lookup(switchId);
    if (row === undefined || row.toggle.mechanism !== "setting" || setting === undefined || setting.type !== "boolean") throw new SettingsRefusal(row?.toggle.refusal ? `This tool cannot be switched: ${row.toggle.refusal}.` : "OMP has no on/off switch for this tool.");
    const target = setting.id.split(".");
    const changed = await write({ path: target, value: enabled }, edit => edit.length === target.length && edit.every((key, i) => key === target[i]),
      () => { try { setting.assertWritable(enabled); } catch { throw new SettingsRefusal("OMP rejected this setting. Nothing was changed."); } });
    return { changed, writes: changed ? [{ file: globalFile, what: `${setting.id} = ${enabled}` }] : [] };
  }
  if (kind === "mcp") {
    if (row === undefined || row.toggle.mechanism !== "mcp") throw new SettingsRefusal(row?.toggle.refusal ? `This server cannot be switched: ${row.toggle.refusal}.` : "OMP no longer lists this server. Refresh and try again.");
    // Idempotence follows the saved user policy (denylist/allowlist), not the cwd-effective state shown in the row.
    const { mcpDenied, mcpForced } = collected;
    const alreadySaved = enabled ? !mcpDenied.has(name) && mcpForced.has(name) === mcpEntryDisabled.has(name) && !collected.globalDisabled.includes(`mcp:${name}`) : mcpDenied.has(name) && !mcpForced.has(name);
    if (alreadySaved) return { changed: false, writes: [] };
    // Global policy by name through the user denylist/allowlist OMP applies before precedence (mcp/config.ts);
    // per-entry flags and every non-user file stay untouched.
    const userPath = n.dirs.getMCPConfigPath("user", request.cwd);
    const writes: ToggleWrite[] = [];
    let step = 0;
    try {
      if (enabled) {
        await n.writer.setServerDisabled(userPath, name, false); step = 1;
        await n.writer.setServerForceEnabled(userPath, name, mcpEntryDisabled.has(name)); step = 2;
      } else {
        await n.writer.setServerForceEnabled(userPath, name, false); step = 1;
        await n.writer.setServerDisabled(userPath, name, true); step = 2;
      }
      if (enabled && await listEdit(`mcp:${name}`, false)) writes.push(listWrite(globalFile, `mcp:${name}`, false));
    } catch {
      throw new SettingsRefusal(step === 0 ? "OMP could not update its user MCP configuration." : "The MCP switch was only partly written. Refresh to see the current state.");
    }
    writes.unshift({ file: userPath, what: `MCP server ${name} ${enabled ? "enabled" : "disabled"} by name in the user MCP configuration` });
    return { changed: true, writes };
  }
  if (kind === "plugin") {
    if (row === undefined || row.toggle.mechanism !== "plugin") throw new SettingsRefusal(row?.toggle.refusal ? `This plugin cannot be switched: ${row.toggle.refusal}.` : "OMP no longer lists this plugin. Refresh and try again.");
    if ((row.state === "disabled") === !enabled) return { changed: false, writes: [] };
    try { await new n.plugins.PluginManager(request.cwd).setEnabled(name, enabled); }
    catch { throw new SettingsRefusal("OMP could not change this plugin. Refresh to see the current state; `omp plugin enable` and `omp plugin disable` are the fallback."); }
    return { changed: true, writes: [{ file: null, what: `plugin ${name} ${enabled ? "enabled" : "disabled"} through OMP's plugin manager` }] };
  }
  throw new SettingsRefusal("The switch request is invalid.");
}

try {
  let input = "";
  for await (const chunk of process.stdin) { input += chunk; if (input.length > 64 * 1024) throw new SettingsRefusal("The inventory request is too large."); }
  const parsed: unknown = JSON.parse(input);
  if (!record(parsed) || typeof parsed.packageRoot !== "string" || typeof parsed.cwd !== "string" || typeof parsed.profile !== "string" ||
    !path.isAbsolute(parsed.packageRoot) || !path.isAbsolute(parsed.cwd) || !["read", "toggle"].includes(String(parsed.action)) || !["session", "global"].includes(String(parsed.scope))) throw new SettingsRefusal("The inventory request is invalid.");
  const request = parsed as unknown as WorkerRequest;
  const n = await natives(request.packageRoot);
  const result = request.action === "read" ? (await collect(request, n)).snapshot : await toggle(request, n);
  process.stdout.write(`OMP_DESK_SETTINGS ${JSON.stringify({ ok: true, result })}\n`);
} catch (error) {
  const message = error instanceof SettingsRefusal ? error.message : "OMP could not complete this operation. Check the installed runtime and permissions; refresh before retrying.";
  process.stdout.write(`OMP_DESK_SETTINGS ${JSON.stringify({ ok: false, error: message })}\n`);
  process.exitCode = 1;
}
