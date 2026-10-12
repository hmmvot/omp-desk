/**
 * The shapes the OMP Settings page and the host exchange: the configuration scope, one edit, and the
 * snapshot of models, roles, agents and providers. Types only, so the page and the host share them
 * without the page importing host code.
 */
export type SettingsScope = "global" | "project";
export type ConfigRecord = Record<string, unknown>;
export interface ConfigEdit { readonly path: readonly string[]; readonly value?: unknown }

export interface SettingsModel {
  readonly provider: string; readonly id: string; readonly name: string; readonly kind: string;
  readonly available: boolean; readonly reasoning: boolean; readonly efforts: readonly string[]; readonly contextWindow?: number;
  readonly maxTokens?: number; readonly input?: readonly string[]; readonly cost?: ConfigRecord;
  readonly recent: number; readonly perf?: ConfigRecord; readonly upstreams?: readonly string[];
}
export interface SettingsRole {
  readonly id: string; readonly name: string; readonly section: string; readonly source: string;
  readonly selector?: string; readonly resolved?: string; readonly thinking?: string;
  readonly accepts: readonly string[]; readonly defaults: readonly string[];
}
export interface SettingsAgent {
  readonly name: string; readonly description: string; readonly systemPrompt: string;
  readonly source: string; readonly hasFile: boolean; readonly disabled: boolean;
  readonly model?: readonly string[]; readonly prewalk?: boolean | string; readonly advisor?: boolean | string;
  readonly effectiveModel: readonly string[]; readonly resolvedModel?: string;
  readonly effectivePrewalk?: string; readonly effectiveAdvisor?: string;
  readonly overrideModel?: string; readonly prewalkOverride?: string; readonly advisorOverride?: string;
}
export interface SettingsSnapshot {
  readonly profile: string; readonly cwd: string; readonly globalFile: string; readonly projectFile: string;
  readonly agentDirectories: Readonly<Record<SettingsScope, string>>;
  readonly global: ConfigRecord; readonly project: ConfigRecord; readonly effective: ConfigRecord;
  readonly provenance: Readonly<Record<string, string>>; readonly models: readonly SettingsModel[];
  readonly roles: readonly SettingsRole[]; readonly agents: readonly SettingsAgent[];
  readonly providers: readonly { readonly id: string; readonly status: string; readonly available: boolean }[];
  readonly presetNames: readonly string[]; readonly activePreset?: string;
}
export interface AgentSpec { readonly identifier: string; readonly whenToUse: string; readonly systemPrompt: string }
