import type { ConfigRecord } from "../host/omp-settings-core.ts";

export interface NativeModel {
  provider: string; id: string; name: string; contextWindow?: number; maxTokens?: number;
  input?: string[]; cost?: ConfigRecord; upstreamProviders?: string[]; reasoning?: boolean;
}
export interface NativeSetting {
  readonly default: unknown;
  get(settings: NativeSettings): unknown; assertWritable(value: unknown): void;
}
export interface NativeSettings {
  getGlobalSettings(): ConfigRecord; getProjectSettings(): ConfigRecord;
  getModelRoles(): Record<string, string | undefined>;
  extensionsSourceLevel(): "project" | "user"; getModelRole(id: string): string | undefined;
  getModelRoleProvenance(id: string): string; getProvenance(setting: NativeSetting): string;
}
export interface NativeAuth {
  close(): void; keys: { source(provider: string): unknown }; credentials: { reload(): Promise<void> };
}
export interface NativeRegistry {
  getAvailable(kind?: string): NativeModel[]; getAll(kind?: string): NativeModel[];
  getDiscoverableProviders(): string[]; getProviderDiscoveryState(id: string): { status: string } | undefined;
  refresh(strategy: string, options?: { refreshCommandCredentials: boolean }): Promise<void>;
  refreshProvider(provider: string, strategy: string, options?: { refreshCommandCredentials: boolean }): Promise<void>;
}
export interface NativeRoleResolution { model?: NativeModel; thinkingLevel?: string }
export interface NativeHubAgent {
  name: string; description: string; systemPrompt: string; source: string; filePath?: string;
  model?: string[]; prewalk?: string | boolean; advisor?: string | boolean; disabled: boolean;
  overrideModel?: string; prewalkOverride?: string; advisorOverride?: string;
}
export interface NativeHubDeps {
  loadAgents(): Promise<NativeHubAgent[]>;
  effectiveModelPatterns(agent: NativeHubAgent): string[]; resolvePatterns(patterns: string[]): string | undefined;
  effectivePrewalkPattern(agent: NativeHubAgent): string | undefined; effectiveAdvisorPattern(agent: NativeHubAgent): string | undefined;
  generateAgent(description: string, onText: (text: string) => void): Promise<string>;
}
export interface NativeGeneratorSession {
  state: { messages: unknown[] }; prompt(text: string, options: { expandPromptTemplates: boolean }): Promise<void>;
  dispose(): Promise<void>;
}
export interface NativeModules {
  "dirs.ts": { setProfile(profile: string): void; getAgentDir(): string; getProjectAgentDir(cwd: string): string; getAgentDbPath(): string };
  "file-lock.ts": { withFileLock<T>(path: string, action: () => Promise<T>): Promise<T> };
  "yaml-config.ts": { stringifyYamlConfig(value: unknown): string };
  "config/settings.ts": { Settings: { loadReadOnly(options: { cwd: string; agentDir: string }): Promise<NativeSettings> } };
  "capability/index.ts": { initializeWithSettings(settings: NativeSettings): () => void };
  "auth/sqlite-credential-store.ts": { SqliteAuthCredentialStore: new (db: SqliteDatabase) => unknown };
  "auth-storage.ts": { AuthStorage: new (store: unknown) => NativeAuth };
  "config/model-registry.ts": { ModelRegistry: new (auth: NativeAuth, modelsPath: string, options: { settings: NativeSettings; cacheDbPath: string }) => NativeRegistry };
  "config/model-resolver.ts": {
    resolveModelRoleValue(value: string, models: NativeModel[], options: { settings: NativeSettings; roleLookup?: { getModelRole(role: string): string | undefined } }): NativeRoleResolution;
    resolveRoleSelection(roles: string[], settings: NativeSettings, models: NativeModel[]): NativeRoleResolution | undefined;
    pickDefaultAvailableModel(models: NativeModel[]): NativeModel | undefined;
    resolveModelOverride(patterns: string[], registry: NativeRegistry, settings: NativeSettings): NativeRoleResolution;
    formatModelStringWithRouting(model: NativeModel): string;
    resolveConfiguredModelPatterns(value: string | string[] | undefined, settings: NativeSettings): string[];
    normalizeModelPatternList(value: string | string[]): string[]; rolePriorityDefaults(role: string): string[];
  };
  "config/model-roles.ts": { getKnownRoleIds(settings: NativeSettings): string[]; getRoleInfo(id: string, settings: NativeSettings): { name: string; section: string; accepts(model: NativeModel): boolean } };
  "session/settings.ts": { cfgDefaultThinkingLevel: NativeSetting };
  "types.ts": { modelKind(model: NativeModel): string };
  "model-thinking.ts": { getSupportedEfforts(model: NativeModel): string[] };
  "modes/agents-hub-deps.ts": { createAgentsHubDeps(cwd: string, settings: NativeSettings, registry: NativeRegistry, roots: () => { explicit: string[]; mode: string; configuredExtensions: string[]; configuredLevel: string }): NativeHubDeps };
  "config.ts": { getConfigDirs(name: string, options: { user: boolean; project: boolean; cwd: string }): { path: string }[] };
  "config/registry.ts": { lookup(id: string): NativeSetting | undefined };
  "config/model-presets.ts": {
    getModelPresetNames(settings: NativeSettings): string[]; findActiveModelPreset(settings: NativeSettings): string | undefined;
    getModelPreset(settings: NativeSettings, name: string): { kind: "found"; preset: { modelRoles: Record<string, string>; defaultThinkingLevel?: string } } | { kind: "missing" | "invalid"; reason?: string };
  };
  "sdk.ts": {
    createAgentSession(options: ConfigRecord): Promise<{ session: NativeGeneratorSession }>;
    discoverAuthStorage(agentDir: string, options: { settings: NativeSettings; cwd: string }): Promise<NativeAuth>;
  };
  "session/session-manager.ts": { SessionManager: { inMemory(): unknown } };
  "prompt.ts": { render(template: string, context?: ConfigRecord): string };
}
export interface SqliteDatabase {
  close(): void; serialize(): Uint8Array;
  query(sql: string): { get(): unknown; all(): Record<string, string | number>[] };
}
