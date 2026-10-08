import { isDeepStrictEqual } from "node:util";
import { isRecord as record } from "../guards.ts";

export type SettingsScope = "global" | "project";
export type ConfigRecord = Record<string, unknown>;
/** Only extension-authored refusals may cross the worker's credential boundary. */
export class SettingsRefusal extends Error {}
export interface ConfigEdit { readonly path: readonly string[]; readonly value?: unknown }
export const EDITOR_SETTING_PATHS = [
  ["modelRoles"], ["modelRoleStorage"], ["cycleOrder"], ["modelPresets"],
  ["modelProviderOrder"], ["enabledModels"], ["enabledProviders"], ["disabledProviders"],
  ["defaultThinkingLevel"], ["retry", "fallbackChains"],
  ["task", "disabledAgents"], ["task", "agentModelOverrides"],
  ["task", "agentPrewalk"], ["task", "agentAdvisor"],
] as const;

export function valueAt(data: ConfigRecord, path: readonly string[]): unknown {
  let value: unknown = data;
  for (const key of path) {
    if (!record(value) || !Object.hasOwn(value, key)) return undefined;
    value = value[key];
  }
  return value;
}
/**
 * Lets a serialized SQLite image open as a writable in-memory database. OMP keeps its
 * databases in WAL mode, and SQLite cannot open a deserialized image whose header still
 * selects WAL ("unable to open database file"), so header bytes 18-19 are reset in place
 * to the rollback-journal format. Page content is unchanged.
 */
export function withRollbackJournalHeader(image: Uint8Array): Uint8Array {
  if (image.length >= 100 && image[18] === 2 && image[19] === 2) { image[18] = 1; image[19] = 1; }
  return image;
}
export function editorSettings(data: ConfigRecord): ConfigRecord {
  const result: ConfigRecord = {};
  for (const path of EDITOR_SETTING_PATHS) {
    const value = valueAt(data, path);
    if (value !== undefined) putValue(result, path, structuredClone(value));
  }
  return result;
}
/** Display only recognized setting values; hidden baselines retain full entries for conflict detection. */
export function displaySettings(data: ConfigRecord): ConfigRecord {
  const selected = editorSettings(data);
  const stringList = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  const entryValue = (value: unknown): unknown => typeof value === "string" || typeof value === "boolean" || value === null ? value : Array.isArray(value) ? stringList(value) : "[invalid value]";
  for (const root of EDITOR_SETTING_PATHS) {
    const value = valueAt(selected, root);
    if (value === undefined) continue;
    const key = root.at(-1)!;
    let safe: unknown;
    if (key === "modelPresets" && record(value)) safe = Object.fromEntries(Object.entries(value).map(([name, preset]) => [name, record(preset) ? {
      modelRoles: record(preset.modelRoles) ? Object.fromEntries(Object.entries(preset.modelRoles).map(([role, selector]) => [role, typeof selector === "string" ? selector : "[invalid value]"])) : "[invalid value]",
      ...(typeof preset.defaultThinkingLevel === "string" ? { defaultThinkingLevel: preset.defaultThinkingLevel } : {}),
    } : "[invalid value]"]));
    else if (["modelRoles", "fallbackChains", "agentModelOverrides", "agentPrewalk", "agentAdvisor"].includes(key) && record(value)) safe = Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, entryValue(entry)]));
    else if (["enabledModels", "enabledProviders", "disabledProviders"].includes(key) && Array.isArray(value)) safe = value.map(item => typeof item === "string" ? item : record(item) ? Object.fromEntries(Object.entries(item).filter(([field]) => ["path", "paths", "pathPrefix", "pathPrefixes", "values", "items", "models", "providers"].includes(field)).map(([field, entry]) => [field, entryValue(entry)])) : "[invalid value]");
    else safe = entryValue(value);
    putValue(selected, root, safe);
  }
  return selected;
}
function allowedPath(path: readonly string[]): boolean {
  if (!path.every(key => key.length > 0 && key.length <= 256 && !["__proto__", "prototype", "constructor"].includes(key))) return false;
  return EDITOR_SETTING_PATHS.some(root => {
    if (!root.every((key, i) => path[i] === key)) return false;
    const entrySetting = ["modelRoles", "modelPresets", "fallbackChains", "agentModelOverrides", "agentPrewalk", "agentAdvisor"].includes(root.at(-1)!);
    if (entrySetting) return path.length === root.length + 1;
    return ["cycleOrder", "disabledAgents", "defaultThinkingLevel"].includes(root.at(-1)!) && path.length === root.length;
  });
}
function putValue(data: ConfigRecord, path: readonly string[], value: unknown): void {
  let parent = data;
  for (const key of path.slice(0, -1)) {
    if (parent[key] === undefined) parent[key] = {};
    if (!record(parent[key])) throw new SettingsRefusal("The setting's parent is not a mapping. Open the config file to repair it first.");
    parent = parent[key] as ConfigRecord;
  }
  const leaf = path.at(-1)!;
  if (value === undefined) delete parent[leaf];
  else Object.defineProperty(parent, leaf, { value, writable: true, enumerable: true, configurable: true });
}
/** Merge only explicitly edited leaves; sibling changes and unknown keys stay intact. */
export function mergeConfigEdits(current: ConfigRecord, baseline: ConfigRecord, edits: readonly ConfigEdit[]): ConfigRecord {
  if (edits.length === 0 || edits.length > 100) throw new SettingsRefusal("No valid settings changes were provided.");
  for (const edit of edits) {
    if (!allowedPath(edit.path)) throw new SettingsRefusal("This editor cannot write that setting.");
    if (!isDeepStrictEqual(valueAt(current, edit.path), valueAt(baseline, edit.path))) {
      throw new SettingsRefusal("This setting changed outside the editor. Reload before saving; nothing was overwritten.");
    }
    for (let length = 1; length < edit.path.length; length++) {
      const ancestor = valueAt(current, edit.path.slice(0, length));
      if (ancestor !== undefined && !record(ancestor)) throw new SettingsRefusal("The setting's parent is not a mapping. Reload or repair the config file first.");
    }
  }
  const result = structuredClone(current);
  for (const edit of edits) putValue(result, edit.path, structuredClone(edit.value));
  return result;
}

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

/** Match the native Agents hub's private generated-spec parser and review contract. */
export function parseAgentSpec(raw: string | unknown): AgentSpec {
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try { parsed = JSON.parse(extractAgentSpecJson(raw)); }
    catch { throw new SettingsRefusal("Agent generation returned invalid JSON."); }
  }
  if (!record(parsed) || typeof parsed.identifier !== "string" || typeof parsed.whenToUse !== "string" || typeof parsed.systemPrompt !== "string") throw new SettingsRefusal("Agent generation returned an invalid specification.");
  const identifier = parsed.identifier.trim(); const whenToUse = parsed.whenToUse.trim(); const systemPrompt = parsed.systemPrompt.trim();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+){1,5}$/.test(identifier)) throw new SettingsRefusal("Use a lowercase hyphenated identifier with two to six words.");
  if (!whenToUse.toLowerCase().startsWith("use this agent when")) throw new SettingsRefusal("The description must start with 'Use this agent when'.");
  if (!systemPrompt) throw new SettingsRefusal("The agent system prompt cannot be empty.");
  return { identifier, whenToUse, systemPrompt };
}

/** Native `extractJsonObject`: a bare JSON object is kept intact (its strings may contain fences); else the first fence, else the outer braces. */
function extractAgentSpecJson(raw: string): string {
  try { JSON.parse(raw); return raw; } catch { /* Not bare JSON: extract it. */ }
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) return fence[1].trim();
  const start = raw.indexOf("{"); const end = raw.lastIndexOf("}");
  return start >= 0 && end >= start ? raw.slice(start, end + 1).trim() : raw.trim();
}
