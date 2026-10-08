import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { pathToFileURL } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { retryWindowsFileOperation } from "../host/file-operation-retry.ts";
import { displaySettings, editorSettings, mergeConfigEdits, parseAgentSpec, valueAt, withRollbackJournalHeader, EDITOR_SETTING_PATHS, SettingsRefusal } from "../host/omp-settings-core.ts";
import { isRecord as record } from "../guards";
import type { AgentSpec, ConfigEdit, ConfigRecord, SettingsScope } from "../host/omp-settings-core.ts";
import { YAML } from "bun";
import { Database } from "bun:sqlite";
import type { NativeAuth, NativeModules } from "./settings-contracts.ts";

interface FileBaseline { logical: string; physical: string; exists: boolean; digest: string; settings: ConfigRecord }
interface WorkerRequest {
  packageRoot: string; cwd: string; profile: string;
  action: "read" | "write" | "refresh" | "generate" | "create" | "resolve-default" | "agent-file" | "preset-plan";
  scope?: SettingsScope; edits?: ConfigEdit[]; baseline?: FileBaseline;
  provider?: string; description?: string; spec?: AgentSpec; agent?: string; catalogueCache?: string;
  preset?: string; operation?: "save" | "switch" | "delete";
}
/** OMP's selected install is runtime-specific and must not be bundled with the extension. */
async function sourceImport<Name extends keyof NativeModules>(root: string, file: Name): Promise<NativeModules[Name]> {
  const loaded: unknown = await import(pathToFileURL(path.join(root, "src", file)).href);
  if (!record(loaded)) throw new SettingsRefusal("The installed OMP settings interface is unavailable.");
  const exports: Record<keyof NativeModules, readonly string[]> = {
    "dirs.ts": ["setProfile", "getAgentDir", "getProjectAgentDir", "getAgentDbPath"],
    "file-lock.ts": ["withFileLock"], "yaml-config.ts": ["stringifyYamlConfig"],
    "config/settings.ts": ["Settings"], "capability/index.ts": ["initializeWithSettings"],
    "auth/sqlite-credential-store.ts": ["SqliteAuthCredentialStore"], "auth-storage.ts": ["AuthStorage"],
    "config/model-registry.ts": ["ModelRegistry"],
    "config/model-resolver.ts": ["formatModelStringWithRouting", "resolveModelRoleValue", "resolveRoleSelection", "pickDefaultAvailableModel", "resolveModelOverride", "resolveConfiguredModelPatterns", "normalizeModelPatternList", "rolePriorityDefaults"],
    "config/model-roles.ts": ["getKnownRoleIds", "getRoleInfo"], "session/settings.ts": ["cfgDefaultThinkingLevel"],
    "types.ts": ["modelKind"], "model-thinking.ts": ["getSupportedEfforts"],
    "modes/agents-hub-deps.ts": ["createAgentsHubDeps"], "config.ts": ["getConfigDirs"],
    "config/registry.ts": ["lookup"], "config/model-presets.ts": ["getModelPresetNames", "findActiveModelPreset", "getModelPreset"],
    "sdk.ts": ["createAgentSession", "discoverAuthStorage"], "session/session-manager.ts": ["SessionManager"], "prompt.ts": ["render"],
  };
  for (const name of exports[file]) {
    if (name === "cfgDefaultThinkingLevel" ? !record(loaded[name]) : typeof loaded[name] !== "function") {
      throw new SettingsRefusal("The installed OMP does not expose the required settings interface.");
    }
  }
  // Export presence is checked above; these signatures pin the inspected installed-source contract.
  const typed = loaded as unknown as NativeModules[Name];
  return typed;
}

async function readConfig(logical: string): Promise<FileBaseline> {
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

async function stageFile(target: string, content: string): Promise<string> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const staged = `${target}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await fs.open(staged, "wx", 0o600);
  try {
    try { await handle.writeFile(content, "utf8"); await handle.sync(); }
    finally { await handle.close(); }
  } catch (error) { await fs.rm(staged, { force: true }).catch(() => {}); throw error; }
  return staged;
}

async function writeConfig(request: WorkerRequest, logical: string, utilsRoot: string, validate: (data: ConfigRecord, edits: ConfigEdit[]) => void, migratedGlobal: () => Promise<ConfigRecord>): Promise<void> {
  const baseline = request.baseline;
  if (!baseline || baseline.logical !== logical || !request.edits) throw new SettingsRefusal("Reload the editor before saving.");
  const beforeLock = await readConfig(logical);
  if (beforeLock.physical !== baseline.physical || beforeLock.exists !== baseline.exists) throw new SettingsRefusal("The config was removed, created or redirected. Reload before saving.");
  const { withFileLock } = await sourceImport(utilsRoot, "file-lock.ts");
  const { stringifyYamlConfig } = await sourceImport(utilsRoot, "yaml-config.ts");
  await withFileLock(baseline.physical, async () => {
    const current = await readConfig(logical);
    if (current.physical !== baseline.physical || current.exists !== baseline.exists) throw new SettingsRefusal("The config target changed. Reload before saving.");
    const layer = request.scope === "project" ? current.settings : await migratedGlobal();
    const merged = mergeConfigEdits(layer, baseline.settings, request.edits!);
    validate(merged, request.edits!);
    const content = stringifyYamlConfig(merged);
    const digest = createHash("sha256").update(content).digest("hex");
    if (digest === current.digest) return;
    const staged = await stageFile(current.physical, content);
    try {
      const latest = await readConfig(logical);
      if (latest.physical !== current.physical || latest.exists !== current.exists || latest.digest !== current.digest) throw new SettingsRefusal("The config changed during saving. Reload; nothing was overwritten.");
      if (current.exists) await retryWindowsFileOperation(() => fs.rename(staged, current.physical));
      else await fs.link(staged, current.physical);
    } finally { await fs.rm(staged, { force: true }); }
  });
}

async function main(request: WorkerRequest): Promise<unknown> {
  if (!path.isAbsolute(request.packageRoot) || !path.isAbsolute(request.cwd)) throw new SettingsRefusal("The settings context is unavailable.");
  const utilsRoot = path.join(path.dirname(request.packageRoot), "pi-utils");
  const aiRoot = path.join(path.dirname(request.packageRoot), "pi-ai");
  const catalogRoot = path.join(path.dirname(request.packageRoot), "pi-catalog");
  const dirs = await sourceImport(utilsRoot, "dirs.ts");
  dirs.setProfile(request.profile);
  const agentDir = dirs.getAgentDir();
  let globalFile = path.join(agentDir, "config.yml");
  if (!(await fs.stat(globalFile).catch(() => null)) && await fs.stat(path.join(agentDir, "config.yaml")).catch(() => null)) globalFile = path.join(agentDir, "config.yaml");
  const projectFile = path.join(dirs.getProjectAgentDir(request.cwd), "config.yml");
  const files = { global: await readConfig(globalFile), project: await readConfig(projectFile) };
  const { Settings } = await sourceImport(request.packageRoot, "config/settings.ts");
  const settings = await Settings.loadReadOnly({ cwd: request.cwd, agentDir });
  files.global.settings = editorSettings(settings.getGlobalSettings());
  const capability = await sourceImport(request.packageRoot, "capability/index.ts");
  const releaseCapability = capability.initializeWithSettings(settings);
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "omp-desk-models-"));
  let auth: NativeAuth | undefined;
  try {
    // Native credential and model cache initialization runs only on snapshots, never the user's databases.
    const dbPath = dirs.getAgentDbPath();
    let memoryDb = new Database(":memory:");
    let recent: string[] = [];
    const perf = new Map<string, ConfigRecord>();
    if (await fs.stat(dbPath).catch(() => null)) {
      const original = new Database(dbPath, { readonly: true });
      try {
        memoryDb.close(); memoryDb = Database.deserialize(withRollbackJournalHeader(original.serialize()));
        if (original.query("SELECT name FROM sqlite_master WHERE name='model_usage'").get()) recent = original.query("SELECT model_key FROM model_usage ORDER BY last_used_at DESC").all().map(row => String(row.model_key));
        if (original.query("SELECT name FROM sqlite_master WHERE name='model_perf'").get()) {
          for (const row of original.query("SELECT model_key,samples,output_tokens,gen_ms,ttft_samples,ttft_ms FROM model_perf").all()) {
            const genMs = Number(row.gen_ms); const tokens = Number(row.output_tokens); const ttftSamples = Number(row.ttft_samples);
            if (genMs > 0 && tokens > 0) perf.set(String(row.model_key), { samples: row.samples, tps: tokens * 1000 / genMs, ttftMs: ttftSamples > 0 ? Number(row.ttft_ms) / ttftSamples : null });
          }
        }
      } finally { original.close(); }
    }
    const { SqliteAuthCredentialStore } = await sourceImport(aiRoot, "auth/sqlite-credential-store.ts");
    const { AuthStorage } = await sourceImport(aiRoot, "auth-storage.ts");
    if (request.action === "refresh" || request.action === "generate") {
      memoryDb.close();
      const { discoverAuthStorage } = await sourceImport(request.packageRoot, "sdk.ts");
      // Explicit operations use OMP's lease/CAS persistence so rotated OAuth tokens are never discarded.
      auth = await discoverAuthStorage(agentDir, { settings, cwd: request.cwd });
    } else {
      auth = new AuthStorage(new SqliteAuthCredentialStore(memoryDb));
      // As OMP's own constructors do; any pruning writes only reach the in-memory snapshot.
      await auth.credentials.reload();
    }
    const cachePath = path.join(agentDir, "models.db");
    const scratchCache = request.catalogueCache ?? path.join(scratch, "models.db");
    await fs.mkdir(path.dirname(scratchCache), { recursive: true });
    if (!(await fs.stat(scratchCache).catch(() => null)) && await fs.stat(cachePath).catch(() => null)) {
      const original = new Database(cachePath, { readonly: true });
      try { await fs.writeFile(scratchCache, original.serialize()); } finally { original.close(); }
    }
    const modelsPath = path.join(agentDir, "models.yml");
    if (!(await fs.stat(modelsPath).catch(() => null)) && !(await fs.stat(path.join(agentDir, "models.yaml")).catch(() => null)) && await fs.stat(path.join(agentDir, "models.json")).catch(() => null)) {
      throw new SettingsRefusal("OMP has a legacy models.json catalogue. Open native OMP once to migrate it before using these editors.");
    }
    const { ModelRegistry } = await sourceImport(request.packageRoot, "config/model-registry.ts");
    const registry = new ModelRegistry(auth, modelsPath, { settings, cacheDbPath: scratchCache });
    if (request.action === "refresh") {
      if (request.provider) await registry.refreshProvider(request.provider, "online", { refreshCommandCredentials: true });
      else await registry.refresh("online", { refreshCommandCredentials: true });
    }
    const resolver = await sourceImport(request.packageRoot, "config/model-resolver.ts");
    const roleModule = await sourceImport(request.packageRoot, "config/model-roles.ts");
    const sessionSettings = await sourceImport(request.packageRoot, "session/settings.ts");
    const { modelKind } = await sourceImport(catalogRoot, "types.ts");
    const { getSupportedEfforts } = await sourceImport(catalogRoot, "model-thinking.ts");
    const { createAgentsHubDeps } = await sourceImport(request.packageRoot, "modes/agents-hub-deps.ts");
    const configuredExtensions = settings.getGlobalSettings().extensions;
    const projectExtensions = settings.getProjectSettings().extensions;
    const nativeExtensions = projectExtensions ?? configuredExtensions;
    const extensionRoots = { explicit: [], mode: "merge", configuredExtensions: Array.isArray(nativeExtensions) ? nativeExtensions.filter((item): item is string => typeof item === "string") : [], configuredLevel: settings.extensionsSourceLevel() };
    const deps = createAgentsHubDeps(request.cwd, settings, registry, () => extensionRoots);
    const agents = await deps.loadAgents();
    if (request.action === "agent-file") {
      const agent = agents.find(item => item.name === request.agent);
      if (!agent?.filePath) throw new SettingsRefusal("This agent has no definition file.");
      return { file: agent.filePath };
    }
    if (request.action === "generate") {
      if (!request.description?.trim()) throw new SettingsRefusal("Describe the agent to generate first.");
      await registry.refresh("online-if-uncached");
      const patterns = resolver.resolveConfiguredModelPatterns(settings.getModelRole("default"), settings);
      const selectedModel = resolver.resolveModelOverride(patterns, registry, settings).model ?? registry.getAvailable()[0];
      if (!selectedModel) throw new SettingsRefusal("No available model can generate an agent.");
      const { createAgentSession } = await sourceImport(request.packageRoot, "sdk.ts");
      const { SessionManager } = await sourceImport(request.packageRoot, "session/session-manager.ts");
      const prompt = await sourceImport(utilsRoot, "prompt.ts");
      const systemPrompt = await fs.readFile(path.join(request.packageRoot, "src", "prompts", "system", "agent-creation-architect.md"), "utf8");
      const userPrompt = await fs.readFile(path.join(request.packageRoot, "src", "prompts", "system", "agent-creation-user.md"), "utf8");
      // Same native architect prompts/options; in-memory history deliberately prevents a stray Sessions row.
      const { session } = await createAgentSession({
        cwd: request.cwd, authStorage: auth, modelRegistry: registry, settings, model: selectedModel,
        sessionManager: SessionManager.inMemory(), systemPrompt: [prompt.render(systemPrompt, {})],
        hasUI: false, enableLsp: false, enableMCP: false, disableExtensionDiscovery: true,
        toolNames: ["__none__"], customTools: [], skills: [], contextFiles: [], promptTemplates: [], slashCommands: [], bindProcessState: false,
      });
      try {
        await session.prompt(prompt.render(userPrompt, { request: request.description }), { expandPromptTemplates: false });
        for (const message of [...session.state.messages].reverse()) {
          if (!record(message) || message.role !== "assistant" || !Array.isArray(message.content)) continue;
          const text = message.content.flatMap(block => record(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : []).join("\n").trim();
          if (text) return { spec: parseAgentSpec(text) };
        }
        throw new SettingsRefusal("The agent architect returned no specification.");
      } finally { await session.dispose(); }
    }
    if (request.action === "create") {
      const spec = parseAgentSpec(request.spec);
      const { getConfigDirs } = await sourceImport(request.packageRoot, "config.ts");
      const scope = request.scope === "project" ? "project" : "user";
      const directory = getConfigDirs("agents", { user: scope === "user", project: scope === "project", cwd: request.cwd })[0]?.path;
      if (!directory) throw new SettingsRefusal("The selected agent directory is unavailable.");
      const target = path.join(directory, `${spec.identifier}.md`);
      const staged = await stageFile(target, `---\n${YAML.stringify({ name: spec.identifier, description: spec.whenToUse }, null, 2).trimEnd()}\n---\n\n${spec.systemPrompt.trim()}\n`);
      try {
        // A hard-link publication is exclusive: an existing name is never replaced, even without cooperation.
        await fs.link(staged, target);
      } finally { await fs.rm(staged, { force: true }); }
      return { created: true };
    }
    if (request.action === "preset-plan") {
      const name = request.preset;
      if (!name || !/^[a-zA-Z][\w-]*$/.test(name)) throw new SettingsRefusal("Use a letter, then letters, digits, - or _ for a preset name.");
      if (request.operation === "save") return {
        scope: "global", edits: [{ path: ["modelPresets", name], value: {
          modelRoles: Object.fromEntries(Object.entries(settings.getModelRoles()).filter((entry): entry is [string, string] => typeof entry[1] === "string" && Boolean(entry[1]))),
          defaultThinkingLevel: sessionSettings.cfgDefaultThinkingLevel.get(settings),
        } }],
      };
      if (request.operation === "delete") {
        if (!Object.hasOwn(record(files.global.settings.modelPresets) ? files.global.settings.modelPresets : {}, name)) throw new SettingsRefusal("This preset is inherited. Open its source config to remove it.");
        return { scope: "global", edits: [{ path: ["modelPresets", name] }] };
      }
      if (request.operation !== "switch") throw new SettingsRefusal("Choose a preset operation.");
      const presetModule = await sourceImport(request.packageRoot, "config/model-presets.ts");
      const found = presetModule.getModelPreset(settings, name);
      if (found.kind !== "found") throw new SettingsRefusal("The preset is missing or invalid. Open its source config to repair it.");
      const definitions = await sourceImport(request.packageRoot, "config/registry.ts");
      const scope: SettingsScope = definitions.lookup("modelRoleStorage")?.get(settings) === "project" ? "project" : "global";
      const currentRoles = settings.getModelRoles();
      const rawRoles = record(files[scope].settings.modelRoles) ? files[scope].settings.modelRoles : {};
      const edits: ConfigEdit[] = [];
      for (const role of new Set([...Object.keys(currentRoles), ...Object.keys(found.preset.modelRoles)])) {
        if (Object.hasOwn(found.preset.modelRoles, role)) edits.push({ path: ["modelRoles", role], value: found.preset.modelRoles[role] });
        else if (Object.hasOwn(rawRoles, role)) edits.push({ path: ["modelRoles", role], value: scope === "project" ? null : undefined });
      }
      const proposed = (role: string): string | undefined => {
        const source = settings.getModelRoleProvenance(role);
        if (["env", "runtime", "overlay"].includes(source) || scope === "global" && source === "project") return settings.getModelRole(role);
        const edit = edits.find(edit => edit.path[1] === role);
        return edit ? typeof edit.value === "string" ? edit.value : undefined : settings.getModelRole(role);
      };
      const candidate = proposed("default");
      const model = candidate ? resolver.resolveModelRoleValue(candidate, registry.getAvailable(), { settings, roleLookup: { getModelRole: proposed } }).model
        : resolver.pickDefaultAvailableModel(registry.getAvailable());
      if (!model) throw new SettingsRefusal("The preset's effective default is unavailable. No settings were written.");
      return { scope, edits, thinking: found.preset.defaultThinkingLevel, preset: name };
    }
    const available = registry.getAvailable("all");
    const validate = (data: ConfigRecord, edits: ConfigEdit[]): void => {
      const { lookup } = registryDefinitions;
      for (const edit of edits) {
        const root = EDITOR_SETTING_PATHS.find(root => root.every((key, i) => edit.path[i] === key));
        if (!root) throw new SettingsRefusal("This editor cannot write that setting.");
        const setting = lookup(root.join("."));
        if (!setting) throw new SettingsRefusal("The installed OMP does not support this setting.");
        try { setting.assertWritable(valueAt(data, root) ?? setting.default); }
        catch { throw new SettingsRefusal("OMP rejected this setting's value. Nothing was changed."); }
        if (edit.value === undefined || edit.value === null) continue;
        const selectors: string[] = [];
        if (edit.path[0] === "cycleOrder" || edit.path[1] === "disabledAgents") {
          if (!Array.isArray(edit.value) || !edit.value.every(item => typeof item === "string")) throw new SettingsRefusal("Use a list of role or agent names.");
        }
        if (edit.path[0] === "modelPresets") {
          if (!/^[a-zA-Z][\w-]*$/.test(edit.path[1] ?? "") || !record(edit.value) || !record(edit.value.modelRoles) || !Object.values(edit.value.modelRoles).every(value => typeof value === "string" && value.trim())) throw new SettingsRefusal("The model preset is invalid.");
          if (edit.value.defaultThinkingLevel !== undefined) {
            try { sessionSettings.cfgDefaultThinkingLevel.assertWritable(edit.value.defaultThinkingLevel); }
            catch { throw new SettingsRefusal("The preset's thinking level is invalid."); }
          }
        }
        if (edit.path[0] === "modelRoles") {
          const role = edit.path[1];
          if (!role || !/^[a-zA-Z][\w-]*$/.test(role)) throw new SettingsRefusal("Use a letter, then letters, digits, - or _ for a role.");
          if (typeof edit.value !== "string") throw new SettingsRefusal("A role must contain a model selector.");
          if (request.preset) continue;
          const resolved = resolver.resolveModelRoleValue(edit.value, available, { settings });
          if (!resolved.model || !roleModule.getRoleInfo(role, settings).accepts(resolved.model)) throw new SettingsRefusal("The selected model is unavailable or incompatible with this role.");
          if (resolved.thinkingLevel && !["auto", "off", ...getSupportedEfforts(resolved.model)].includes(resolved.thinkingLevel)) throw new SettingsRefusal("This model does not support that thinking effort.");
        } else if (["agentModelOverrides", "agentPrewalk", "agentAdvisor"].includes(edit.path[1] ?? "")) {
          if (!agents.some(agent => agent.name === edit.path[2])) throw new SettingsRefusal("That agent is no longer discovered. Reload before saving.");
          const modelOverride = edit.path[1] === "agentModelOverrides";
          if (typeof edit.value !== "string" && !(modelOverride && Array.isArray(edit.value) && edit.value.every(item => typeof item === "string"))) throw new SettingsRefusal("Use native model patterns, or on/off for prewalk and advisor.");
          if (modelOverride || edit.value !== "on" && edit.value !== "off") selectors.push(...resolver.normalizeModelPatternList(edit.value as string | string[]));
        } else if (edit.path[0] === "retry" && edit.path[1] === "fallbackChains") {
          if (!Array.isArray(edit.value) || !edit.value.every(item => typeof item === "string")) throw new SettingsRefusal("A fallback chain must be a list of model selectors.");
          selectors.push(...edit.value);
        }
        if (selectors.length && !resolver.resolveModelOverride(resolver.resolveConfiguredModelPatterns(selectors, settings), registry, settings).model) throw new SettingsRefusal("No available model matches this selection. Refresh or log in to its provider.");
      }
    };
    const registryDefinitions = await sourceImport(request.packageRoot, "config/registry.ts");
    if (request.action === "write") {
      const scope = request.scope ?? "global";
      if (scope === "project" && (valueAt(editorSettings(settings.getProjectSettings()), ["modelRoleStorage"]) ?? valueAt(editorSettings(settings.getGlobalSettings()), ["modelRoleStorage"])) !== "project") throw new SettingsRefusal("Project role writes require OMP's modelRoleStorage setting to be project.");
      if (scope === "project" && request.edits?.some(edit => edit.path[0] !== "modelRoles")) throw new SettingsRefusal("The native dashboards save this setting globally; project scope is only for model roles.");
      if (scope === "project" && !isDeepStrictEqual(files.project.settings.modelRoles, settings.getProjectSettings().modelRoles)) throw new SettingsRefusal("Project model roles require a native OMP migration first. Nothing was changed.");
      await writeConfig(request, scope === "project" ? projectFile : globalFile, utilsRoot, validate, async () => (await Settings.loadReadOnly({ cwd: request.cwd, agentDir })).getGlobalSettings());
      return { saved: true };
    }
    if (request.action === "resolve-default") {
      const selected = resolver.resolveRoleSelection(["default"], settings, registry.getAvailable());
      const model = selected?.model ?? resolver.pickDefaultAvailableModel(registry.getAvailable());
      if (!model) throw new SettingsRefusal("No available default model can be applied.");
      if (resolver.formatModelStringWithRouting(model) !== `${model.provider}/${model.id}`) throw new SettingsRefusal("Not applied: the effective default has upstream routing that RPC cannot express.");
      return { provider: model.provider, id: model.id, thinking: selected?.thinkingLevel ?? sessionSettings.cfgDefaultThinkingLevel.get(settings) };
    }
    const all = registry.getAll("all");
    const availableKeys = new Set(available.map(model => `${model.provider}/${model.id}`));
    const models = all.map(model => ({
      provider: model.provider, id: model.id, name: model.name, kind: modelKind(model),
      available: availableKeys.has(`${model.provider}/${model.id}`), reasoning: Boolean(model.reasoning), efforts: getSupportedEfforts(model),
      contextWindow: model.contextWindow, maxTokens: model.maxTokens, input: model.input, cost: model.cost,
      recent: recent.indexOf(`${model.provider}/${model.id}`), perf: perf.get(`${model.provider}/${model.id}`),
      upstreams: model.upstreamProviders ?? [],
    }));
    const roles = roleModule.getKnownRoleIds(settings).map((id: string) => {
      const info = roleModule.getRoleInfo(id, settings);
      const selector = settings.getModelRole(id);
      const resolved = resolver.resolveRoleSelection([id], settings, available);
      return { id, name: info.name, section: info.section, source: settings.getModelRoleProvenance(id), selector,
        resolved: resolved?.model ? `${resolved.model.provider}/${resolved.model.id}` : undefined,
        thinking: resolved?.thinkingLevel, accepts: available.filter(info.accepts).map(model => `${model.provider}/${model.id}`),
        defaults: resolver.rolePriorityDefaults(id) };
    });
    const effective: ConfigRecord = {};
    const provenance: Record<string, string> = {};
    for (const root of EDITOR_SETTING_PATHS) {
      const setting = registryDefinitions.lookup(root.join("."));
      if (!setting) continue;
      const val = setting.get(settings);
      if (root.length === 1) effective[root[0]!] = val;
      else { effective[root[0]!] ??= {}; (effective[root[0]!] as ConfigRecord)[root[1]!] = val; }
      provenance[root.join(".")] = settings.getProvenance(setting);
    }
    const presets = await sourceImport(request.packageRoot, "config/model-presets.ts");
    const { getConfigDirs } = await sourceImport(request.packageRoot, "config.ts");
    const globalAgents = getConfigDirs("agents", { user: true, project: false, cwd: request.cwd })[0]?.path;
    const projectAgents = getConfigDirs("agents", { user: false, project: true, cwd: request.cwd })[0]?.path;
    if (!globalAgents || !projectAgents) throw new SettingsRefusal("OMP did not supply the native agent creation directories.");
    const agentDirectories = { global: globalAgents, project: projectAgents };
    return {
      snapshot: {
        profile: request.profile, cwd: request.cwd, globalFile, projectFile, agentDirectories,
        global: displaySettings(files.global.settings), project: displaySettings(files.project.settings), effective: displaySettings(effective), provenance,
        models, roles, agents: agents.map(agent => ({
          name: agent.name, description: agent.description, systemPrompt: agent.systemPrompt, source: agent.source,
          hasFile: Boolean(agent.filePath), disabled: agent.disabled, model: agent.model, prewalk: agent.prewalk, advisor: agent.advisor,
          effectiveModel: deps.effectiveModelPatterns(agent), resolvedModel: deps.resolvePatterns(deps.effectiveModelPatterns(agent)),
          effectivePrewalk: deps.effectivePrewalkPattern(agent), effectiveAdvisor: deps.effectiveAdvisorPattern(agent),
          overrideModel: agent.overrideModel, prewalkOverride: agent.prewalkOverride, advisorOverride: agent.advisorOverride,
        })),
        providers: [...new Set<string>([...all.map(model => model.provider), ...registry.getDiscoverableProviders()])].map(id => ({
          id, available: available.some(model => model.provider === id), status: registry.getProviderDiscoveryState(id)?.status ?? (auth!.keys.source(id) ? "available" : "locked"),
        })),
        presetNames: presets.getModelPresetNames(settings), activePreset: presets.findActiveModelPreset(settings),
      },
      files: {
        global: { ...files.global, settings: editorSettings(files.global.settings) },
        project: { ...files.project, settings: editorSettings(files.project.settings) },
      },
    };
  } finally {
    auth?.close(); releaseCapability();
    await fs.rm(scratch, { recursive: true, force: true });
  }
}


try {
  let input = "";
  for await (const chunk of process.stdin) { input += chunk; if (input.length > 4 * 1024 * 1024) throw new SettingsRefusal("The settings request is too large."); }
  const parsed: unknown = JSON.parse(input);
  if (!record(parsed) || typeof parsed.packageRoot !== "string" || typeof parsed.cwd !== "string" || typeof parsed.profile !== "string" || !["read", "write", "refresh", "generate", "create", "resolve-default", "agent-file", "preset-plan"].includes(String(parsed.action))) throw new SettingsRefusal("The settings request is invalid.");
  const result = await main(parsed as unknown as WorkerRequest);
  process.stdout.write(`OMP_DESK_SETTINGS ${JSON.stringify({ ok: true, result })}\n`);
} catch (error) {
  const message = error instanceof SettingsRefusal ? error.message
    : record(error) && error.code === "EEXIST" ? "The target already exists; nothing was overwritten."
    : "OMP could not complete this settings operation. Check the installed runtime, permissions and provider connection; reload before retrying.";
  process.stdout.write(`OMP_DESK_SETTINGS ${JSON.stringify({ ok: false, error: message })}\n`);
  process.exitCode = 1;
}
