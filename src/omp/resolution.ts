import { roleNote } from "../protocol/role-notes.ts";
import type { AgentOutcome, AgentResolution, AgentSource, ResolvedModel, ResolvedThinking, RoleResolution, RoleSource, SettingsScope, TraceStep } from "../protocol/settings-model.ts";
import type { NativeHubAgent, NativeModel, NativeModules, NativeRoleResolution, NativeSettings, RoleLookup } from "./settings-contracts.ts";
import { isRecord as record } from "../shared/guards.ts";

/**
 * The effective model, thinking level, source and decision trace of every role and agent, computed with
 * OMP's own resolution functions (design 2026-10-13, ADR-0072). OMP's functions and data are handed in, so
 * tests drive this with the live import and with fixtures; nothing here re-implements OMP's rules except
 * where it must name one (a step's label), and the rule it names is asked of OMP, not copied.
 */
type Resolver = NativeModules["config/model-resolver.ts"];
export interface ResolutionInput {
  readonly resolver: Resolver;
  readonly settings: NativeSettings;
  /** Models OMP offers now, and the whole catalogue (to name the model a failed resolution wanted). */
  readonly available: readonly NativeModel[]; readonly all: readonly NativeModel[];
  /** Providers with no credentials. */
  readonly loginProviders: ReadonlySet<string>;
  readonly roleIds: readonly string[];
  /** The models a role accepts among those OMP offers: the pool OMP's tools hand to `resolveRoleChain`. */
  readonly pool: (role: string) => readonly NativeModel[];
  readonly defaultThinkingLevel: string | undefined;
  /** Roles whose value comes from an environment variable of this process, as OMP applies them at launch. */
  readonly envRoles: Readonly<Record<string, { readonly name: string; readonly value: string }>>;
  readonly agents: readonly (NativeHubAgent & { readonly effectivePrewalk?: string; readonly effectiveAdvisor?: string })[];
}
export interface Resolutions { readonly roles: ReadonlyMap<string, RoleResolution>; readonly agents: ReadonlyMap<string, AgentResolution> }

const PROBE = "omp-desk-probe/";
const NO_ROLES: RoleLookup = { getModelRole: () => undefined };
const key = (model: NativeModel): string => `${model.provider}/${model.id}`;
const PROVENANCE: Readonly<Record<string, RoleSource>> = { runtime: "env", overlay: "overlay", project: "project", global: "global" };
const LAYER_TITLES: Readonly<Record<string, string>> = { env: "Environment", overlay: "Config overlay", project: "Project config", global: "Global config" };

/** Resolve `patterns` against the models OMP offers; when nothing resolves, say why by resolving them against the whole catalogue. */
function outcome(input: ResolutionInput, patterns: readonly string[], resolveWith: (models: NativeModel[]) => NativeRoleResolution): { model: ResolvedModel; raw: NativeRoleResolution } {
  const usable = resolveWith([...input.available]);
  if (usable.model) return { model: { model: key(usable.model), status: "ok" }, raw: usable };
  if (patterns.length === 0) return { model: { status: "none" }, raw: usable };
  const wanted = resolveWith([...input.all]);
  if (wanted.model) return { model: { status: input.loginProviders.has(wanted.model.provider) ? "login" : "unavailable", provider: wanted.model.provider, wanted: key(wanted.model) }, raw: usable };
  return { model: { status: "missing", wanted: patterns[0] }, raw: usable };
}
const hasOwnSuffix = (resolver: Resolver, selector: string): boolean => resolver.extractExplicitThinkingSelector(selector, NO_ROLES) !== undefined;
const patternText = (value: unknown): string | undefined => {
  const text = typeof value === "string" ? value : Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").join(",") : "";
  return text.trim() || undefined;
};
const layerRecord = (data: Record<string, unknown>, path: readonly string[]): unknown => {
  let value: unknown = data;
  for (const part of path) { if (!record(value)) return undefined; value = value[part]; }
  return value;
};

/**
 * Which roles an unset `role` consults, nearest first, and which of them supplies its value. OMP exposes no
 * list of its inheritance rules, so each candidate is asked: set only that role to a sentinel selector and
 * see whether OMP's alias resolution of `@role` returns the sentinel. Two candidates are ordered by setting
 * both. Conditional rules (`advisor` follows `slow` only while `slow` is set) come out right because the
 * probes start from the roles that really are set.
 */
export function roleChain(input: ResolutionInput, role: string): { consulted: string[]; used: string | "builtin" | "none" } {
  const configured = new Set(input.roleIds.filter(id => id !== role && input.settings.getModelRole(id)?.trim()));
  const terminal = (set: ReadonlySet<string>): string => {
    const lookup: RoleLookup = { getModelRole: id => id !== role && set.has(id) ? `${PROBE}${id}` : undefined };
    const patterns = input.resolver.resolveConfiguredModelPatterns(`@${role}`, lookup);
    const first = patterns[0];
    if (first?.startsWith(PROBE)) return first.slice(PROBE.length);
    return patterns.length === 0 || patterns.length === 1 && first === `@${role}` ? "none" : "builtin";
  };
  const consulted = input.roleIds.filter(id => id !== role && terminal(new Set([id])) === id)
    .sort((a, b) => terminal(new Set([a, b])) === a ? -1 : 1);
  return { consulted, used: terminal(configured) };
}

function roleThinking(input: ResolutionInput, id: string, own: string | undefined, raw: NativeRoleResolution): ResolvedThinking {
  const { resolver, settings } = input;
  const explicit = raw.model ? (raw.explicitThinkingLevel ? raw.thinkingLevel : undefined) : resolver.extractExplicitThinkingSelector(`@${id}`, settings);
  if (explicit) return { level: explicit, source: own !== undefined && hasOwnSuffix(resolver, own) ? "selector" : "role" };
  if (id === "default" && input.defaultThinkingLevel) return { level: input.defaultThinkingLevel, source: "setting" };
  return { source: "none" };
}

function resolveRoles(input: ResolutionInput): Map<string, Omit<RoleResolution, "agents">> {
  const { resolver, settings } = input;
  const projectRoles = layerRecord(settings.getProjectSettings(), ["modelRoles"]);
  const resolved = new Map<string, Omit<RoleResolution, "agents">>();
  const followers = new Map<string, string[]>();
  for (const id of input.roleIds) {
    const provenance = settings.getModelRoleProvenance(id);
    const selector = settings.getModelRole(id)?.trim() || undefined;
    const patterns = resolver.resolveConfiguredModelPatterns(`@${id}`, settings);
    const literal = patterns.length === 1 && patterns[0] === `@${id}`;
    let { model, raw } = outcome(input, literal ? [] : patterns, models => resolver.resolveModelRoleValue(`@${id}`, models, { settings }));
    // Tools that resolve this role as a chain go on to the retry fallback chain or the built-in list when the role's own model cannot be used.
    let candidates: string[] | undefined; let fellBack: NativeModel | undefined;
    if (roleNote(id).chain) {
      const chain = resolver.resolveRoleChain(id, settings, [...input.pool(id)]);
      candidates = chain.slice(1).map(candidate => key(candidate.model));
      const [first] = chain;
      if (first && !model.model) {
        fellBack = first.model;
        model = { model: key(first.model), status: "ok" };
        raw = { model: first.model, ...(first.thinkingLevel !== undefined ? { thinkingLevel: first.thinkingLevel, explicitThinkingLevel: true } : {}) };
      }
    }
    const thinking = roleThinking(input, id, selector, raw);
    const env = input.envRoles[id];
    const layers: { kind: "env" | "overlay" | "project" | "global"; value: string }[] = [];
    if (env) layers.push({ kind: "env", value: env.value });
    else if (provenance === "overlay" && selector) layers.push({ kind: "overlay", value: selector });
    const project = settings.getProjectModelRole(id); const global = settings.getGlobalModelRole(id);
    if (project) layers.push({ kind: "project", value: project });
    if (global) layers.push({ kind: "global", value: global });
    const trace: TraceStep[] = layers.map((layer, index) => ({
      kind: layer.kind, ...(layer.kind === "project" || layer.kind === "global" ? { layer: layer.kind } : {}), title: LAYER_TITLES[layer.kind]!, value: layer.value,
      ...(layer.kind === "env" ? { note: `$${env!.name}` } : {}), state: index === 0 ? "used" : "shadowed",
    }));
    if (fellBack && layers.length) trace[0] = { ...trace[0]!, state: "shadowed", note: [trace[0]!.note, "cannot be used"].filter(Boolean).join(" · ") };
    if (fellBack && layers.length) trace.push({ kind: "builtin", title: "Fallback", value: key(fellBack), note: "the role's own model cannot be used, so OMP continues with the retry fallback chain or its built-in list", state: "used" });
    if (projectRoles && record(projectRoles) && projectRoles[id] === null) trace.push({ kind: "project", layer: "project", title: LAYER_TITLES.project!, note: "cleared here, so the global value applies", state: "unset" });
    let source: RoleSource = layers.length ? (PROVENANCE[provenance] ?? "global") : "none";
    let follows: string[] = [];
    if (!layers.length) {
      const chain = roleChain(input, id);
      const hops = chain.used === "builtin" || chain.used === "none" ? chain.consulted : chain.consulted.slice(0, chain.consulted.indexOf(chain.used) + 1);
      for (const hop of hops) {
        const used = hop === chain.used;
        trace.push({ kind: "inherited", title: `@${hop}`, ...(used ? { value: settings.getModelRole(hop) ?? "" } : {}), note: used ? `set in the ${(LAYER_TITLES[PROVENANCE[settings.getModelRoleProvenance(hop)] ?? "global"] ?? "config").toLowerCase()}` : "not set, so the next one is consulted", state: used ? "used" : "unset" });
      }
      if (chain.used === "builtin") {
        source = "builtin";
        trace.push({ kind: "builtin", title: "Built-in list", value: model.model ?? resolver.rolePriorityDefaults(id)[0], note: "OMP's priority list: the first candidate that can be used wins", state: "used" });
      } else if (chain.used === "none") {
        source = "none";
        trace.push({ kind: "none", title: "Not assigned", note: roleNote(id).summary, state: "used" });
      } else { source = "inherited"; follows = hops; for (const hop of hops) followers.set(hop, [...followers.get(hop) ?? [], id]); }
    }
    resolved.set(id, { source, follows, model, thinking, trace, followers: [], ...(candidates ? { candidates } : {}), ...(env ? { envName: env.name } : {}), });
  }
  return new Map([...resolved].map(([id, value]) => [id, { ...value, followers: followers.get(id) ?? [] }]));
}

/** What an agent would run on with `overrideText` as its effective model override. */
function agentOutcome(input: ResolutionInput, agent: NativeHubAgent, overrideText: string | undefined): AgentOutcome & { roles: string[]; shadowedRoles: string[]; effective: boolean } {
  const { resolver, settings } = input;
  const patterns = resolver.resolveAgentModelPatterns({ settingsOverride: overrideText, agentModel: agent.model, settings });
  const session = `${PROBE}session`;
  const probe = (settingsOverride: string | undefined, agentModel: string[] | undefined): boolean => {
    const result = resolver.resolveAgentModelPatterns({ settingsOverride, agentModel, settings, activeModelPattern: session });
    return !(result.length === 1 && result[0] === session);
  };
  const overrideDecides = overrideText !== undefined && probe(overrideText, undefined);
  const definitionDecides = !overrideDecides && Boolean(agent.model?.length) && probe(undefined, agent.model);
  const source: AgentSource = overrideDecides ? "override" : definitionDecides ? "definition" : "session";
  const { model, raw } = outcome(input, patterns, models => resolver.resolveModelOverride(patterns, { getAvailable: () => models }, settings));
  const named = (texts: readonly string[]): string[] => [...new Set(resolver.normalizeModelPatternList([...texts]).flatMap(pattern => resolver.resolveExplicitModelRole(pattern, settings) ?? []))];
  const decidingTexts = overrideDecides ? [overrideText!] : definitionDecides ? agent.model! : [];
  let thinking: ResolvedThinking = { source: "none" };
  const explicit = raw.model ? (raw.explicitThinkingLevel ? raw.thinkingLevel : undefined) : patterns[0] ? resolver.extractExplicitThinkingSelector(patterns[0], settings) : undefined;
  if (explicit) thinking = { level: explicit, source: resolver.normalizeModelPatternList([...decidingTexts]).some(text => hasOwnSuffix(resolver, text)) ? "selector" : "role" };
  else if (agent.thinkingLevel) thinking = { level: agent.thinkingLevel, source: "definition" };
  else if (raw.model?.thinking?.defaultLevel) thinking = { level: raw.model.thinking.defaultLevel, source: "model" };
  else if (raw.model && !raw.model.thinking?.unverified && input.defaultThinkingLevel) thinking = { level: input.defaultThinkingLevel, source: "setting" };
  const roles = decidingTexts.length ? named(decidingTexts) : agent.model?.length && source === "session" ? named(agent.model) : ["default"];
  return { source, model, thinking, roles, shadowedRoles: overrideDecides && agent.model ? named(agent.model) : [], effective: overrideDecides };
}

function resolveAgents(input: ResolutionInput): Map<string, AgentResolution> {
  const { settings } = input;
  const project = settings.getProjectSettings(); const global = settings.getGlobalSettings();
  const layers: Readonly<Record<SettingsScope, Record<string, unknown>>> = { project, global };
  const result = new Map<string, AgentResolution>();
  for (const agent of input.agents) {
    const stored = (map: string, scope: SettingsScope): string | undefined => patternText(layerRecord(layers[scope], ["task", map, agent.name]));
    const overrides: Partial<Record<SettingsScope, string>> = {};
    for (const scope of ["project", "global"] as const) { const text = stored("agentModelOverrides", scope); if (text) overrides[scope] = text; }
    const effective = overrides.project ?? overrides.global;
    const current = agentOutcome(input, agent, effective);
    const ifReset: Partial<Record<SettingsScope, AgentOutcome>> = {};
    for (const scope of ["project", "global"] as const) {
      if (overrides[scope] === undefined) continue;
      const remaining = scope === "project" ? { text: overrides.global, layer: "global" as const } : { text: overrides.project, layer: "project" as const };
      const { source, model, thinking } = agentOutcome(input, agent, remaining.text);
      ifReset[scope] = { source, ...(source === "override" ? { layer: remaining.layer } : {}), model, thinking };
    }
    const trace: TraceStep[] = [];
    for (const scope of ["project", "global"] as const) {
      if (overrides[scope] === undefined) continue;
      const used = current.effective && effective === overrides[scope];
      trace.push({ kind: "override", layer: scope, title: scope === "project" ? "Project override" : "Global override", value: overrides[scope],
        note: current.effective ? `task.agentModelOverrides in the ${scope} config` : "resolves to nothing, so it is ignored", state: used ? "used" : "shadowed" });
    }
    if (!trace.length) trace.push({ kind: "override", title: "Override", note: "none in the project or global config", state: "unset" });
    const originNote = agent.source === "bundled" ? "bundled agent" : `${agent.source} agent file`;
    trace.push(agent.model?.length
      ? { kind: "definition", title: "Definition", value: agent.model.join(", "), note: current.source === "session" ? `${originNote}; it names the session's model` : originNote, state: current.source === "definition" ? "used" : "shadowed" }
      : { kind: "definition", title: "Definition", note: "no model in the definition", state: "unset" });
    trace.push({ kind: "session", title: "Session model", note: "the model of the session that spawns the agent; here the default role's, as no session is known", state: current.source === "session" ? "used" : "shadowed" });
    const switchFrom = (map: string, effectivePattern: string | undefined): { value: string; from: SettingsScope | "definition" } | undefined => {
      for (const scope of ["project", "global"] as const) { const value = stored(map, scope); if (value !== undefined) return { value, from: scope }; }
      return effectivePattern === undefined ? undefined : { value: effectivePattern, from: "definition" };
    };
    const prewalk = switchFrom("agentPrewalk", agent.effectivePrewalk); const advisor = switchFrom("agentAdvisor", agent.effectiveAdvisor);
    result.set(agent.name, {
      source: current.source, ...(current.source === "override" ? { layer: overrides.project !== undefined ? "project" as const : "global" as const } : {}),
      model: current.model, thinking: current.thinking, roles: current.roles, shadowedRoles: current.shadowedRoles, trace, ifReset, overrides,
      ...(prewalk ? { prewalk } : {}), ...(advisor ? { advisor } : {}),
    });
  }
  return result;
}

export function resolveAll(input: ResolutionInput): Resolutions {
  const roles = resolveRoles(input);
  const agents = resolveAgents(input);
  const following = new Map<string, string[]>(); const overridden = new Map<string, string[]>();
  for (const [name, agent] of agents) {
    for (const role of agent.roles) following.set(role, [...following.get(role) ?? [], name]);
    for (const role of agent.shadowedRoles) overridden.set(role, [...overridden.get(role) ?? [], name]);
  }
  return {
    roles: new Map([...roles].map(([id, value]) => [id, { ...value, agents: { following: following.get(id) ?? [], overridden: overridden.get(id) ?? [] } }])),
    agents,
  };
}
