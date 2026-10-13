import { formatConfigValue, groupedEntries } from "../../protocol/omp-config-model.ts";
import type { ConfigEntry, ConfigLayer, ConfigOption, ConfigSource, ConfigTab, ConfigValue } from "../../protocol/omp-config-model.ts";

/**
 * The OMP Settings page's pure logic: search and filters, the value a view shows, notes, the table of contents and
 * list edits. No React and no host calls, so the presentation can be replaced without touching it (design
 * 2026-10-13-omp-settings-editor).
 */

/** The page's one layer switch: the two files OMP merges, and what OMP uses (read-only). */
export type View = ConfigLayer | "effective";
export const VIEW_NAME: Readonly<Record<View, string>> = { global: "Global", project: "Project", effective: "Effective" };

/** The filter chips; a typed `@name` token in the search box means the same. */
export const FILTERS = ["modified", "project", "env", "warning", "readonly"] as const;
export type Filter = typeof FILTERS[number];

export interface ParsedQuery {
  /** Lower-case words that must all appear in the entry's text. */
  readonly terms: readonly string[];
  /** `@modified`, `@env`, `@tab:model`… typed in the search box, plus the chips switched on. */
  readonly filters: ReadonlySet<string>;
}

export function parseQuery(query: string, chips: Iterable<string> = []): ParsedQuery {
  const terms: string[] = [];
  const filters = new Set<string>(chips);
  for (const token of query.toLowerCase().split(/\s+/).filter(Boolean)) {
    if (token.startsWith("@")) { if (token.length > 1) filters.add(token.slice(1)); } else terms.push(token);
  }
  return { terms, filters };
}

/** Whether the entry sets a value in a layer or has a warning the page should flag. */
export function hasInvalidLayer(entry: ConfigEntry): boolean { return entry.layers.global.state === "invalid" || entry.layers.project.state === "invalid"; }

const searchText = (entry: ConfigEntry, tabLabel: string): string => `${entry.id} ${entry.label} ${entry.group ?? ""} ${tabLabel} ${entry.description}`.toLowerCase();

function passes(entry: ConfigEntry, filter: string): boolean {
  switch (filter) {
    case "modified": return entry.layers.global.state !== "unset" || entry.layers.project.state !== "unset";
    case "project": return entry.layers.project.state !== "unset";
    case "global": return entry.layers.global.state !== "unset";
    case "env": return entry.env !== null;
    case "warning": return entry.warning !== undefined || hasInvalidLayer(entry);
    case "readonly": return entry.readOnly !== null;
    default: return filter.startsWith("tab:") ? entry.tab.toLowerCase() === filter.slice(4) : true;
  }
}

/** Every word must appear in the id, label, group, tab or description (case-insensitive). */
export function entryMatches(entry: ConfigEntry, query: string, tabLabel = ""): boolean {
  const { terms } = parseQuery(query);
  const text = searchText(entry, tabLabel);
  return terms.every(term => text.includes(term));
}

/**
 * What OMP's own panel shows: an entry whose visibility condition is false is hidden, in search too (`#defToItem` drops it before
 * the search corpus is built), then the search words and the filters narrow it.
 */
export function shownEntries(entries: readonly ConfigEntry[], query: string, chips: Iterable<string> = [], tabs: readonly ConfigTab[] = []): readonly ConfigEntry[] {
  const { terms, filters } = parseQuery(query, chips);
  const labels = new Map(tabs.map(tab => [tab.id, tab.label]));
  return entries.filter(entry => entry.visible
    && terms.every(term => searchText(entry, labels.get(entry.tab) ?? "").includes(term))
    && [...filters].every(filter => passes(entry, filter)));
}

/** Whether the view marks the entry as changed: it sets a value in this layer, or OMP uses something other than the default. */
export function isModified(entry: ConfigEntry, view: View): boolean {
  return view === "effective" ? entry.effective.source !== "default" : entry.layers[view].state !== "unset";
}
export function modifiedCount(entries: readonly ConfigEntry[], view: View): number { return entries.filter(entry => entry.visible && isModified(entry, view)).length; }

/**
 * What a view's control shows: its own value, else the layer below it (`inherited`), never the value in force from a higher layer or
 * another project file, because editing an inherited control writes what it shows into this layer. The Effective view shows the value
 * OMP uses and is read-only.
 */
export function shownValue(entry: ConfigEntry, view: View): { readonly value: ConfigValue | undefined; readonly inherited: boolean } {
  if (view === "effective") return { value: effectiveValue(entry), inherited: false };
  const own = entry.layers[view];
  if (own.state === "set" && own.value !== undefined) return { value: own.value, inherited: false };
  const below = view === "project" ? entry.layers.global : undefined;
  return { value: below?.state === "set" && below.value !== undefined ? below.value : entry.default, inherited: true };
}

/** The value OMP uses for this setting (env aside). */
export function effectiveValue(entry: ConfigEntry): ConfigValue | undefined { return entry.effective.value ?? entry.default; }

/** The layer whose file a row's "open config" action opens in a view: the Effective view opens the file that supplies the value. */
export function fileLayerFor(entry: ConfigEntry, view: View): ConfigLayer {
  if (view !== "effective") return view;
  return entry.effective.layeredSource === "project" ? "project" : "global";
}

const SOURCE_TEXT: Record<ConfigSource, string> = { default: "OMP's default", global: "the global config", project: "the project config", env: "an environment variable", runtime: "a runtime override", overlay: "a --config overlay" };

export interface Note { readonly tone: "info" | "error" | "warning" | "muted" | "env"; readonly text: string; readonly title?: string }

/** The small lines under a row: what overrides what, what OMP uses, the default, the condition, the environment. */
export function rowNotes(entry: ConfigEntry, view: View): readonly Note[] {
  const notes: Note[] = [];
  const show = (value: ConfigValue | undefined): string => formatConfigValue(entry, value);
  for (const layer of ["global", "project"] as const) {
    if (entry.layers[layer].state === "invalid") notes.push({ tone: "error", text: `The ${layer} config holds a value this editor does not recognise here (OMP may migrate it); OMP may use the default instead.` });
  }
  const layered = entry.effective.layeredSource;
  if (view === "effective") notes.push({ tone: "info", text: `Comes from ${SOURCE_TEXT[layered]}.` });
  else if (layered !== view && layered !== "default" && entry.effective.value !== undefined) notes.push({ tone: "info", text: `In effect: ${show(entry.effective.value)} from ${SOURCE_TEXT[layered]}.` });
  if (entry.projectOther) {
    notes.push(entry.projectOther.shadows
      ? { tone: "warning", text: `${entry.projectOther.file} also sets this and OMP merges it over .omp/config.yml, so a value saved to the project config has no effect.` }
      : { tone: "info", text: `The project value comes from ${entry.projectOther.file}, not .omp/config.yml.` });
  }
  const global = entry.layers.global; const project = entry.layers.project;
  if (view === "global" && project.state === "set" && project.value !== undefined) notes.push({ tone: "info", text: `The project config overrides this with ${show(project.value)}.` });
  if (view === "project" && global.state === "set" && global.value !== undefined) notes.push({ tone: "info", text: `Also set in the global config: ${show(global.value)}.` });
  if (view !== "effective" && entry.writable[view] && entry.layers[view].state === "unset") {
    notes.push({ tone: "muted", text: view === "project" ? "Not set in the project config; the control shows the value it falls back to." : "Not set in the global config; OMP's default applies." });
  }
  if (entry.condition) notes.push({ tone: "muted", text: entry.condition.note });
  if (entry.default !== undefined && entry.readOnly === null) notes.push({ tone: "muted", text: `Default: ${show(entry.default)}` });
  if (entry.env?.present) {
    notes.push(entry.env.active
      ? { tone: "env", text: `Overridden by $${entry.env.name}`, title: "An environment variable overrides the layers while it is set. A change saved here does not take effect until it is unset." }
      : { tone: "muted", text: `$${entry.env.name} is set but a configured layer wins.`, title: "The variable only fills in when no layer sets a value." });
  }
  return notes;
}

export interface TocGroup { readonly group: string; readonly anchor: string; readonly count: number }
export interface TocTab { readonly tab: ConfigTab; readonly anchor: string; readonly count: number; readonly modified: boolean; readonly groups: readonly TocGroup[] }
export interface ListSection { readonly tab: ConfigTab; readonly anchor: string; readonly groups: readonly { readonly group: string | null; readonly anchor: string; readonly entries: readonly ConfigEntry[] }[] }

export const anchorId = (tab: string, group: string | null): string => `g-${tab}-${group === null ? "top" : group.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

/** The list's sections and the table of contents over the shown entries, tabs and groups in OMP's order; tabs with nothing shown are left out. */
export function layout(tabs: readonly ConfigTab[], shown: readonly ConfigEntry[], view: View): { readonly sections: readonly ListSection[]; readonly toc: readonly TocTab[] } {
  const sections: ListSection[] = []; const toc: TocTab[] = [];
  for (const tab of tabs) {
    const inTab = shown.filter(entry => entry.tab === tab.id);
    if (inTab.length === 0) continue;
    const groups = groupedEntries(tab, shown);
    sections.push({ tab, anchor: anchorId(tab.id, null), groups: groups.map(section => ({ group: section.group, anchor: anchorId(tab.id, section.group), entries: section.entries })) });
    toc.push({
      tab, anchor: anchorId(tab.id, null), count: inTab.length, modified: inTab.some(entry => isModified(entry, view)),
      groups: groups.flatMap(section => section.group === null ? [] : [{ group: section.group, anchor: anchorId(tab.id, section.group), count: section.entries.length }]),
    });
  }
  return { sections, toc };
}

/** Splits text around the search words (case-insensitive) so the page can mark them; no HTML is built here. */
export function highlightParts(text: string, terms: readonly string[]): readonly { readonly text: string; readonly match: boolean }[] {
  const words = terms.filter(term => term.length > 0);
  if (words.length === 0) return [{ text, match: false }];
  const lower = text.toLowerCase();
  const marked = new Array<boolean>(text.length).fill(false);
  for (const word of words) for (let at = lower.indexOf(word); at >= 0; at = lower.indexOf(word, at + word.length)) for (let index = at; index < at + word.length; index++) marked[index] = true;
  const parts: { text: string; match: boolean }[] = [];
  for (let index = 0; index < text.length; index++) {
    const last = parts.at(-1);
    if (last && last.match === marked[index]) last.text += text[index]!; else parts.push({ text: text[index]!, match: marked[index]! });
  }
  return parts;
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
