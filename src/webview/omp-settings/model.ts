import { formatConfigValue } from "../../protocol/omp-config-model.ts";
import type { ConfigEntry, ConfigLayer, ConfigOption, ConfigSource, ConfigTab, ConfigValue } from "../../protocol/omp-config-model.ts";

/**
 * The OMP Settings page's pure logic: filtering, the value a layer shows, badges and list edits. No React and
 * no host calls, so the presentation can be replaced without touching it (design 2026-10-13-omp-settings-editor).
 */

/** Every whitespace-separated word must appear in the id, label, group or description (case-insensitive). */
export function entryMatches(entry: ConfigEntry, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = `${entry.id} ${entry.label} ${entry.group ?? ""} ${entry.description}`.toLowerCase();
  return words.every(word => haystack.includes(word));
}

/** What OMP's own panel shows: an entry whose visibility condition is false is hidden, in search too (`#defToItem` drops it before the search corpus is built). */
export function shownEntries(entries: readonly ConfigEntry[], query: string): readonly ConfigEntry[] {
  return entries.filter(entry => entry.visible && entryMatches(entry, query));
}

/** How many entries each tab would list for the query, for the tab labels. */
export function tabCounts(tabs: readonly ConfigTab[], entries: readonly ConfigEntry[], query: string): Readonly<Record<string, number>> {
  const shown = shownEntries(entries, query);
  return Object.fromEntries(tabs.map(tab => [tab.id, shown.filter(entry => entry.tab === tab.id).length]));
}

/**
 * What the selected layer's control shows: its own value, else the value it falls back to (`inherited`). A layer falls back to
 * the layer below it (project to global, global to OMP's default), never to the value in effect, which a higher layer or another
 * project file can supply: editing an inherited control writes what it shows into this layer, and promoting a higher layer's
 * value into the global file would be a silent change (OMP guards the same case for `contextFiles.extra`).
 */
export function shownValue(entry: ConfigEntry, layer: ConfigLayer): { readonly value: ConfigValue | undefined; readonly inherited: boolean } {
  const own = entry.layers[layer];
  if (own.state === "set" && own.value !== undefined) return { value: own.value, inherited: false };
  const below = layer === "project" ? entry.layers.global : undefined;
  return { value: below?.state === "set" && below.value !== undefined ? below.value : entry.default, inherited: true };
}

/** The value OMP uses for this setting (env aside): the Effective view. */
export function effectiveValue(entry: ConfigEntry): ConfigValue | undefined { return entry.effective.value ?? entry.default; }

export interface Badge { readonly text: string; readonly tone: "layer" | "source" | "env" | "warn" | "muted"; readonly title: string }

const SOURCE_TEXT: Record<ConfigSource, string> = { default: "default", global: "global", project: "project", env: "environment", runtime: "runtime override", overlay: "--config overlay" };

/** The layer values and where the effective value comes from, as short badges. */
export function entryBadges(entry: ConfigEntry): readonly Badge[] {
  const badges: Badge[] = [];
  for (const layer of ["global", "project"] as const) {
    const state = entry.layers[layer];
    if (state.state === "unset") continue;
    const shown = state.state === "invalid" ? "invalid" : state.value !== undefined ? formatConfigValue(entry, state.value) : state.summary ?? "set";
    badges.push({ text: entry.readOnly?.reason === "secret" ? `${layer}: set` : `${layer}: ${shown}`, tone: state.state === "invalid" ? "warn" : "layer", title: `The ${layer} layer sets this setting.` });
  }
  if (entry.projectOther) badges.push(entry.projectOther.shadows
    ? { text: `${entry.projectOther.file} overrides`, tone: "warn", title: `${entry.projectOther.file} also sets this setting and OMP merges it over .omp/config.yml, so a value saved to the project layer here has no effect.` }
    : { text: `project: ${entry.projectOther.file}`, tone: "muted", title: `${entry.projectOther.file}, a project settings file other than .omp/config.yml, sets this setting.` });
  badges.push({ text: `in effect: ${SOURCE_TEXT[entry.effective.source]}`, tone: "source", title: "The layer OMP takes the value from." });
  if (entry.env?.present) {
    badges.push(entry.env.active
      ? { text: `$${entry.env.name} overrides`, tone: "env", title: "An environment variable overrides the layers while it is set. Changes here are saved but do not take effect until it is unset." }
      : { text: `$${entry.env.name} set, not used`, tone: "muted", title: "The environment variable is set, but a configured layer wins over it." });
  }
  return badges;
}

/** The option whose number is `value`, for a number chosen from OMP's list (`default` stands for -1). */
export function numberOptionFor(options: readonly ConfigOption[], value: number | undefined): ConfigOption | undefined {
  return value === undefined ? undefined : options.find(option => (option.value === "default" ? -1 : Number(option.value)) === value);
}
export function optionNumberValue(option: ConfigOption): number { return option.value === "default" ? -1 : Number(option.value); }

/** Adds or removes one member of a list setting; an unordered list keeps OMP's option order, an ordered one appends. */
export function toggleMember(selected: readonly string[], value: string, options: readonly ConfigOption[], ordered: boolean): readonly string[] {
  if (selected.includes(value)) return selected.filter(item => item !== value);
  if (ordered) return [...selected, value];
  const next = new Set([...selected, value]);
  return options.map(option => option.value).filter(item => next.has(item));
}
export function moveMember(selected: readonly string[], value: string, direction: -1 | 1): readonly string[] {
  const index = selected.indexOf(value);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= selected.length) return selected;
  const next = [...selected];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}
export function sameList(a: readonly string[], b: readonly string[]): boolean { return a.length === b.length && a.every((item, index) => item === b[index]); }
