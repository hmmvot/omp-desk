import type { ConfigEdit, ConfigRecord, SettingsModel, SettingsScope } from "../../host/omp-settings-core";
import { isRecord } from "../../guards.ts";
export function at(data: ConfigRecord, path: readonly string[]): unknown {
  let value: unknown = data;
  for (const key of path) { if (!isRecord(value) || !Object.hasOwn(value, key)) return undefined; value = value[key]; }
  return value;
}
export function text(value: unknown): string { return typeof value === "string" ? value : Array.isArray(value) ? value.filter(item => typeof item === "string").join("\n") : ""; }
export function lines(value: string): string[] { return value.split(/\r?\n/).map(line => line.trim()).filter(Boolean); }
export function selectorBase(value: string): string { return value.replace(/:(?:auto|off|minimal|low|medium|high|xhigh)$/, ""); }
export function roleChange(role: string, selector: string, effort: string, scope: SettingsScope): { edits: ConfigEdit[]; thinking?: string } {
  const trimmed = selector.trim();
  if (!trimmed) return { edits: [{ path: ["modelRoles", role], ...(scope === "project" ? { value: null } : {}) }] };
  const value = !effort ? trimmed : effort === "inherit" || role === "default" && effort === "auto" ? selectorBase(trimmed) : `${selectorBase(trimmed)}:${effort}`;
  return { edits: [{ path: ["modelRoles", role], value }], ...(role === "default" && effort === "auto" ? { thinking: "auto" } : {}) };
}
export function filteredModels(models: readonly SettingsModel[], query: string, provider: string, kind: string, recent: boolean): SettingsModel[] {
  const needle = query.trim().toLowerCase();
  return models.filter(model => (!provider || model.provider === provider) && (!kind || model.kind === kind) && (!recent || model.recent >= 0)
    && (!needle || `${model.provider}/${model.id} ${model.name}`.toLowerCase().includes(needle))).sort((a, b) => recent ? a.recent - b.recent : a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name));
}
