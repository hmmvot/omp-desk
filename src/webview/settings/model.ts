import type { SessionApply } from "../../protocol/settings-messages";
import type { ConfigRecord, ResolvedStatus, ResolvedThinking, SettingsAgent, SettingsModel, SettingsRole, SettingsSnapshot } from "../../protocol/settings-model";
import { modelKey, selectorBase, selectorThinking } from "../../protocol/settings-pick-items.ts";
import { isRecord } from "../../shared/guards.ts";
export function at(data: ConfigRecord, path: readonly string[]): unknown {
  let value: unknown = data;
  for (const key of path) { if (!isRecord(value) || !Object.hasOwn(value, key)) return undefined; value = value[key]; }
  return value;
}
/** A stored list or OMP pattern list as entries: arrays and comma-separated strings, as `normalizeModelPatternList` reads them. */
export function patternList(value: unknown): string[] {
  const parts = typeof value === "string" ? value.split(",") : Array.isArray(value) ? value.flatMap(item => typeof item === "string" ? item.split(",") : []) : [];
  return parts.map(part => part.trim()).filter(Boolean);
}
/** `1 model`, `3 models`. */
export function count(value: number, noun: string): string { return `${value} ${noun}${value === 1 ? "" : "s"}`; }
export function sameList(left: readonly string[], right: readonly string[]): boolean { return left.length === right.length && left.every((item, index) => item === right[index]); }
/** Ordered-list editing: moves stop at the ends, and an entry already in the list is never added twice. */
export function moveEntry(list: readonly string[], index: number, step: number): string[] {
  const other = index + step;
  if (index < 0 || index >= list.length || other < 0 || other >= list.length) return [...list];
  const next = [...list];
  [next[index], next[other]] = [next[other]!, next[index]!];
  return next;
}
export function withoutEntry(list: readonly string[], index: number): string[] { return list.filter((_, position) => position !== index); }
export function withEntry(list: readonly string[], entry: string): string[] { return list.includes(entry) ? [...list] : [...list, entry]; }
/** The native toggle edits the global disabled list only; values from higher layers are never copied into it. */
export function disabledAgentsAfterToggle(globalList: unknown, agent: string, enabled: boolean): string[] {
  const disabled = patternList(globalList).filter(name => name !== agent);
  return enabled ? disabled : [...disabled, agent];
}
export interface EntryStatus { readonly text: string; readonly ok: boolean }
/** What a fallback or override entry resolves to now: a role's model, a provider's availability or a model's. */
export function entryStatus(entry: string, snapshot: Pick<SettingsSnapshot, "models" | "roles" | "providers">): EntryStatus {
  if (entry.startsWith("@")) {
    const role = snapshot.roles.find(item => item.id === entry.slice(1));
    if (!role) return { text: "unknown role", ok: false };
    const { status, provider } = role.resolution.model;
    if (role.resolved) return { text: `→ ${role.resolved}`, ok: true };
    return status === "login" ? { text: `needs login to ${provider}`, ok: false } : { text: status === "none" ? "role has no model" : "role has no available model", ok: false };
  }
  if (entry.endsWith("/*")) {
    const provider = snapshot.providers.find(item => item.id === entry.slice(0, -2));
    if (!provider) return { text: "unknown provider", ok: false };
    return provider.available ? { text: "any model on this provider", ok: true } : { text: `${providerStatus(provider.status)}`, ok: false };
  }
  const model = snapshot.models.find(item => modelKey(item) === selectorBase(entry));
  const thinking = selectorThinking(entry);
  const pattern = entry.includes("*") || !entry.includes("/");
  if (!model) return { text: pattern ? "pattern" : "not in the catalogue", ok: pattern };
  return model.available ? { text: thinking ? `available · thinking ${thinking}` : "available", ok: true } : { text: "needs login", ok: false };
}
/** Usable models lead: the native hub's All scope lists available models only, so the browser defaults to them too. */
export function filteredModels(models: readonly SettingsModel[], query: string, provider: string, kind: string, recent: boolean, availableOnly: boolean): SettingsModel[] {
  const needle = query.trim().toLowerCase();
  return models.filter(model => (!provider || model.provider === provider) && (!kind || model.kind === kind) && (!recent || model.recent >= 0) && (!availableOnly || model.available)
    && (!needle || `${model.provider}/${model.id} ${model.name}`.toLowerCase().includes(needle)))
    .sort((a, b) => recent ? a.recent - b.recent : Number(b.available) - Number(a.available) || a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name));
}
const PROVIDER_STATUS: Record<string, string> = { available: "ready", idle: "ready", cached: "ready", locked: "needs login", unavailable: "unreachable" };
/** Native provider discovery states in user terms. */
export function providerStatus(status: string): string { return PROVIDER_STATUS[status] ?? status; }
const SOURCE_LABELS: Record<string, string> = { default: "OMP default", global: "Global config", project: "Project config", overlay: "Config overlay", runtime: "Runtime override" };
/** Native setting provenance in words. */
export function sourceLabel(source: string | undefined): string { return source === undefined ? "Unknown" : SOURCE_LABELS[source] ?? source; }
/** `128K`, `1M`; an em dash when unknown. */
export function compactCount(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(1))}M`;
  if (value >= 1_000) return `${Number((value / 1_000).toFixed(1))}K`;
  return String(value);
}
/** Input/output price per million tokens, as the native model browser shows it. */
export function priceLabel(cost: ConfigRecord | undefined): string {
  const input = cost?.input; const output = cost?.output;
  if (typeof input !== "number" || typeof output !== "number") return "—";
  if (input === 0 && output === 0) return "free";
  const leg = (value: number): string => String(Number(value.toFixed(2)));
  return `$${leg(input)} / $${leg(output)}`;
}
export function perfLabel(perf: ConfigRecord | undefined): string {
  if (!perf) return "";
  const parts: string[] = [];
  if (typeof perf.tps === "number") parts.push(`${Math.round(perf.tps)} tokens/s`);
  if (typeof perf.ttftMs === "number") parts.push(`first token ${perf.ttftMs < 999.5 ? `${Math.round(perf.ttftMs)} ms` : `${Math.round(perf.ttftMs / 1000)} s`}`);
  if (typeof perf.samples === "number") parts.push(`${perf.samples} samples`);
  return parts.join(" · ");
}
/** A config value for display: lists joined, records as compact JSON, absent as an em dash. */
export function displayValue(value: unknown): string {
  if (value === undefined) return "—";
  if (value === null) return "Cleared";
  if (typeof value === "string") return value || "(empty)";
  if (Array.isArray(value) && value.every(item => typeof item !== "object" || item === null)) return value.length ? value.join(", ") : "(empty list)";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

/** Bars of the thinking meter: `off` has none, `xhigh` and `max` fill it. */
export const LEVEL_BARS: Readonly<Record<string, number>> = { off: 0, minimal: 1, low: 2, medium: 3, high: 4, xhigh: 5, max: 5 };
/** `claude-opus` of `anthropic/claude-opus`; the provider is shown in the tooltip and the detail. */
export function shortModel(key: string | undefined): string { return key ? key.slice(key.indexOf("/") + 1) : ""; }
export interface Pill { readonly kind: string; readonly text: string; readonly title: string }
const SOURCE_PILLS: Readonly<Record<string, Pill>> = {
  env: { kind: "env", text: "env", title: "Set by an environment variable of the extension host, which sessions OMP Desk starts inherit" },
  overlay: { kind: "overlay", text: "overlay", title: "Set by a config overlay file" },
  project: { kind: "project", text: "project", title: "Set in the project config (.omp/config.yml)" },
  global: { kind: "global", text: "global", title: "Set in the global config" },
  builtin: { kind: "builtin", text: "built-in", title: "Not set: OMP's built-in priority list decides" },
  none: { kind: "none", text: "unassigned", title: "Not set, and OMP has no built-in list for this role" },
};
/** The source pill of a role row: where its model comes from, or what an unset role follows. */
export function rolePill(role: SettingsRole): Pill {
  const { source, follows } = role.resolution;
  if (source === "inherited") return { kind: "inherited", text: "inherited", title: `Not set here: follows ${follows.map(id => `@${id}`).join(" → ")}` };
  return SOURCE_PILLS[source]!;
}
/** The source pill of an agent row: its own override, a role its definition names, the definition, or the session. */
export function agentPill(agent: SettingsAgent): Pill {
  const { source, layer, roles } = agent.resolution;
  if (source === "override") return { kind: "override", text: "override", title: `A ${layer} model override replaces the definition` };
  if (source === "definition") return roles.length ? { kind: "inherited", text: `@${roles[0]}`, title: `Its definition names ${roles.map(id => `@${id}`).join(", ")}` } : { kind: "definition", text: "definition", title: "The model is pinned in the agent's definition" };
  return { kind: "inherited", text: "session", title: "No model of its own: it runs on the model of the session that spawns it" };
}
export function thinkingText(thinking: ResolvedThinking): string { return thinking.level ?? "—"; }
const THINKING_WHY: Readonly<Record<ResolvedThinking["source"], string>> = {
  selector: "from the :level on the selector", role: "from the role it follows", definition: "from the agent's definition", model: "the model's own default level",
  setting: "from the default thinking level setting", none: "no level of its own: whoever uses it decides",
};
export function thinkingWhy(thinking: ResolvedThinking): string { return THINKING_WHY[thinking.source]; }
export type ProblemStatus = Exclude<ResolvedStatus, "ok" | "none">;
export interface Problem { readonly scope: "role" | "agent"; readonly id: string; readonly status: ProblemStatus; readonly provider?: string; readonly wanted?: string; readonly disabled: boolean }
/** Everything in use that cannot run: roles somebody assigned (or that follow one) and agents, with the provider to sign in to. */
export function problems(snapshot: Pick<SettingsSnapshot, "roles" | "agents">): Problem[] {
  const result: Problem[] = [];
  for (const role of snapshot.roles) {
    const { model, source } = role.resolution;
    if (model.status !== "ok" && model.status !== "none" && source !== "builtin") result.push({ scope: "role", id: role.id, status: model.status, provider: model.provider, wanted: model.wanted, disabled: false });
  }
  for (const agent of snapshot.agents) {
    const { model } = agent.resolution;
    if (model.status !== "ok" && model.status !== "none") result.push({ scope: "agent", id: agent.name, status: model.status, provider: model.provider, wanted: model.wanted, disabled: agent.disabled });
  }
  return result;
}
/** The roles the Agents page keeps in view: the usual anchors, then every other role an agent's model selection names. */
export function roleStripIds(snapshot: Pick<SettingsSnapshot, "roles" | "agents">): string[] {
  const named = new Set(["default", "smol", "slow", "task", ...snapshot.agents.flatMap(agent => agent.resolution.roles)]);
  return snapshot.roles.map(role => role.id).filter(id => named.has(id));
}
export type AgentFilter = "all" | "override" | "role" | "problems" | "disabled";
export function agentCounts(agents: readonly SettingsAgent[]): Record<AgentFilter, number> {
  const counts: Record<AgentFilter, number> = { all: agents.length, override: 0, role: 0, problems: 0, disabled: 0 };
  for (const agent of agents) for (const filter of ["override", "role", "problems", "disabled"] as const) if (agentMatchesFilter(agent, filter)) counts[filter]++;
  return counts;
}
export function agentMatchesFilter(agent: SettingsAgent, filter: AgentFilter): boolean {
  const { source, roles, model } = agent.resolution;
  switch (filter) {
    case "override": return source === "override";
    case "role": return source === "definition" && roles.length > 0;
    case "problems": return model.status !== "ok" && model.status !== "none";
    case "disabled": return agent.disabled;
    default: return true;
  }
}

export interface SessionBlock {
  readonly heading: string; readonly button?: string; readonly line: string; readonly note?: string;
  /** Why the button cannot be used now. */ readonly blocked?: string; readonly unavailable?: string;
}
const quoted = (label: string): string => `the Chat session “${label}”`;
/**
 * The "Current session" block: what the button would do to the open Chat session, in words. Null when there is nothing to offer:
 * no session, or it already uses the default model (and thinking level, when one would be set).
 */
export function sessionBlock(session: SessionApply | null | undefined): SessionBlock | null {
  if (!session) return null;
  const who = quoted(session.label);
  const line = `Saved settings apply to new sessions. This changes the model of ${who} now.`;
  if (!session.target) return { heading: "Switch this Chat session to the default model", line, unavailable: `${session.unavailable ?? "The default model could not be resolved."} Nothing can be switched.` };
  const level = session.target.thinking !== undefined && session.target.thinking !== "auto" ? session.target.thinking : undefined;
  if (session.current?.model === session.target.model && (level === undefined || session.current.thinking === level)) return null;
  const model = shortModel(session.target.model);
  return {
    heading: `Switch ${who} to ${session.target.model}${level ? ` · ${level}` : ""}`,
    button: `Use ${model} in this session`, line,
    ...(session.target.thinking === "auto" ? { note: "Auto thinking is not applied; the session keeps its current level." } : {}),
    ...(session.busy ? { blocked: "The session is busy. Try again when it is idle." } : {}),
  };
}
