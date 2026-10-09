import type { ConfigRecord, SettingsModel, SettingsSnapshot } from "../../host/omp-settings-core";
import { modelKey, selectorBase, selectorThinking } from "../../host/settings-pick-items.ts";
import { isRecord } from "../../guards.ts";
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
    return role.resolved ? { text: `→ ${role.resolved}`, ok: true } : { text: role.selector ? "role has no available model" : "automatic", ok: !role.selector };
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
  if (typeof perf.ttftMs === "number") parts.push(`first token ${(perf.ttftMs / 1000).toFixed(1)} s`);
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
