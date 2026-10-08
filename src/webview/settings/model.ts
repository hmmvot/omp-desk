import type { ConfigEdit, ConfigRecord, SettingsModel, SettingsScope } from "../../host/omp-settings-core";
import { isRecord } from "../../guards.ts";
export function at(data: ConfigRecord, path: readonly string[]): unknown {
  let value: unknown = data;
  for (const key of path) { if (!isRecord(value) || !Object.hasOwn(value, key)) return undefined; value = value[key]; }
  return value;
}
export function text(value: unknown): string { return typeof value === "string" ? value : Array.isArray(value) ? value.filter(item => typeof item === "string").join("\n") : ""; }
export function lines(value: string): string[] { return value.split(/\r?\n/).map(line => line.trim()).filter(Boolean); }
/** `1 model`, `3 models`. */
export function count(value: number, noun: string): string { return `${value} ${noun}${value === 1 ? "" : "s"}`; }
export function sameList(left: readonly string[], right: readonly string[]): boolean { return left.length === right.length && left.every((item, index) => item === right[index]); }
/** Append one pattern to an ordered one-per-line list without replacing or duplicating existing entries. */
export function appendLine(list: string, candidate: string): string {
  const entry = candidate.trim();
  const current = lines(list);
  return entry && !current.includes(entry) ? [...current, entry].join("\n") : current.join("\n");
}
/** The native toggle edits the global disabled list only; values from higher layers are never copied into it. */
export function disabledAgentsAfterToggle(globalList: unknown, agent: string, enabled: boolean): string[] {
  const disabled = lines(text(globalList)).filter(name => name !== agent);
  return enabled ? disabled : [...disabled, agent];
}
export function selectorBase(value: string): string { return value.replace(/:(?:auto|off|minimal|low|medium|high|xhigh)$/, ""); }
export function roleChange(role: string, selector: string, effort: string, scope: SettingsScope): { edits: ConfigEdit[]; thinking?: string } {
  const trimmed = selector.trim();
  if (!trimmed) return { edits: [{ path: ["modelRoles", role], ...(scope === "project" ? { value: null } : {}) }] };
  const value = !effort ? trimmed : effort === "inherit" || role === "default" && effort === "auto" ? selectorBase(trimmed) : `${selectorBase(trimmed)}:${effort}`;
  return { edits: [{ path: ["modelRoles", role], value }], ...(role === "default" && effort === "auto" ? { thinking: "auto" } : {}) };
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
