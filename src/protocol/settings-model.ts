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
/** Why a role or agent has no usable model: no credentials for its provider (`login`), a catalogue model OMP does not offer (`unavailable`), a pattern that matches nothing (`missing`), or nothing named at all (`none`). */
export type ResolvedStatus = "ok" | "login" | "unavailable" | "missing" | "none";
/** What a role or agent runs on now, as OMP's own resolution functions report it. `wanted` is the model that would run if the provider were usable. */
export interface ResolvedModel { readonly model?: string; readonly status: ResolvedStatus; readonly provider?: string; readonly wanted?: string }
/** A thinking level and where it comes from: an explicit `:level` on the selector, on the role it follows, the agent's definition, the model's own default, the default thinking level setting, or nowhere (whoever uses the role decides). */
export interface ResolvedThinking { readonly level?: string; readonly source: "selector" | "role" | "definition" | "model" | "setting" | "none" }
export type TraceKind = "env" | "overlay" | "project" | "global" | "inherited" | "builtin" | "override" | "definition" | "session" | "none";
/** One line of "how it was decided": `used` won, `shadowed` was set but overridden, `unset` was consulted and held nothing. */
export interface TraceStep { readonly kind: TraceKind; readonly layer?: SettingsScope; readonly title: string; readonly value?: string; readonly note?: string; readonly state: "used" | "shadowed" | "unset" }
export type RoleSource = "env" | "overlay" | "project" | "global" | "inherited" | "builtin" | "none";
export interface RoleResolution {
  readonly source: RoleSource;
  /** The roles an unset role follows now, nearest first; the last one is the role whose value is used. */
  readonly follows: readonly string[];
  readonly model: ResolvedModel; readonly thinking: ResolvedThinking;
  readonly trace: readonly TraceStep[];
  /** Unset roles that currently follow this one, and the agents whose model selection names it (following now, or shielded by an override). */
  readonly followers: readonly string[]; readonly agents: { readonly following: readonly string[]; readonly overridden: readonly string[] };
  /** What OMP tries after the first choice, in order, for a role it resolves as a chain (the retry fallback chain or its built-in list). */
  readonly candidates?: readonly string[];
  /** The environment variable behind an `env` source. */
  readonly envName?: string;
}
export interface SettingsRole {
  readonly id: string; readonly name: string; readonly section: string;
  readonly selector?: string; readonly resolved?: string;
  readonly accepts: readonly string[]; readonly defaults: readonly string[];
  readonly resolution: RoleResolution;
}
export type AgentSource = "override" | "definition" | "session";
export interface AgentOutcome { readonly source: AgentSource; readonly layer?: SettingsScope; readonly model: ResolvedModel; readonly thinking: ResolvedThinking }
export interface AgentResolution extends AgentOutcome {
  /** Roles the deciding selector names, in order (`@slow`), and the roles a shadowed definition names. */
  readonly roles: readonly string[]; readonly shadowedRoles: readonly string[];
  readonly trace: readonly TraceStep[];
  /** What the agent would run on if the override of one layer were removed. */
  readonly ifReset: Readonly<Partial<Record<SettingsScope, AgentOutcome>>>;
  readonly overrides: Readonly<Partial<Record<SettingsScope, string>>>;
  readonly prewalk?: { readonly value: string; readonly from: SettingsScope | "definition" };
  readonly advisor?: { readonly value: string; readonly from: SettingsScope | "definition" };
}
export interface SettingsAgent {
  readonly name: string; readonly description: string; readonly systemPrompt: string;
  readonly source: string; readonly hasFile: boolean; readonly disabled: boolean;
  readonly model?: readonly string[]; readonly prewalk?: boolean | string; readonly advisor?: boolean | string; readonly thinkingLevel?: string;
  readonly effectiveModel: readonly string[];
  readonly effectivePrewalk?: string; readonly effectiveAdvisor?: string;
  readonly overrideModel?: string; readonly prewalkOverride?: string; readonly advisorOverride?: string;
  readonly resolution: AgentResolution;
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
