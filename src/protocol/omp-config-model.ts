/**
 * The shapes the OMP Settings editor page and the host exchange (design 2026-10-13-omp-settings-editor,
 * ADR-0071): one bounded JSON description per OMP setting, and the messages that read and change them.
 * Types and pure helpers only, so the page and the host share them without the page importing host code.
 *
 * Nothing here carries a credential. A setting OMP marks as a credential reaches the page as an entry with
 * `readOnly.reason === "secret"` whose layers say only whether a value is configured.
 */
import type { ConfigRecord } from "./settings-model";

/** The two persisted layers the editor writes. `.omp/config.yml` of a folder is the project layer. */
export type ConfigLayer = "global" | "project";
/** Where an effective value comes from, as OMP's own provenance reports it. */
export type ConfigSource = "default" | "global" | "project" | "env" | "runtime" | "overlay";
/** A value the editor can display and edit. Complex settings never carry one. */
export type ConfigValue = boolean | number | string | readonly string[];

export interface ConfigOption { readonly value: string; readonly label: string; readonly description?: string }

/** How an editable setting is edited; `null` on the entry means it is not editable here. */
export type ConfigControl =
  | { readonly kind: "boolean" }
  | { readonly kind: "enum"; readonly options: readonly ConfigOption[] }
  /** A number chosen from the choices OMP lists; the option `value` is the number in text (or `default`, stored as -1). */
  | { readonly kind: "number"; readonly options: readonly ConfigOption[] }
  /**
   * A number OMP lists no choices for (its own panel hides these). OMP's registry declares no bounds, so the rule is the
   * type's: a finite number, and a whole number when the setting's default is one (every such setting counts lines,
   * milliseconds, hours or seconds). `parseNumericInput` is the one check, used by the page and again by the worker.
   */
  | { readonly kind: "numeric"; readonly integer: boolean }
  | { readonly kind: "text" }
  | { readonly kind: "multiselect"; readonly options: readonly ConfigOption[]; readonly ordered: boolean };

/**
 * Why a setting is shown but not editable. `secret`: a credential, set in the terminal. `complex`: a list or
 * mapping with no OMP control; open the YAML file at its key. `runtime-options`: OMP fills the choices at run
 * time (themes). `condition-unknown`: its visibility rule is newer than this build knows. `oversize`: a value too
 * large to show. `unsupported`: a type or control shape this build does not know.
 */
export type ConfigReadOnlyReason = "secret" | "complex" | "runtime-options" | "condition-unknown" | "oversize" | "unsupported";

export interface ConfigLayerValue {
  /** `unset` (key absent or null), `set`, or `invalid` (set to a value OMP ignores and replaces by the default). */
  readonly state: "unset" | "set" | "invalid";
  /** Present only for an editable, non-secret setting whose layer value is valid and small. */
  readonly value?: ConfigValue;
  /** A short description when the value is not shown (`mapping, 3 entries`, `list, 2 items`, `invalid`). */
  readonly summary?: string;
}

export interface ConfigEntry {
  /** OMP's dotted setting id, as written in config files (`lsp.diagnosticsOnWrite`). */
  readonly id: string;
  readonly tab: string;
  readonly group: string | null;
  readonly label: string;
  /** OMP's description, with its environment note appended when a variable is in play. */
  readonly description: string;
  readonly warning?: string;
  readonly type: "boolean" | "enum" | "number" | "string" | "array" | "record";
  readonly control: ConfigControl | null;
  readonly readOnly: { readonly reason: ConfigReadOnlyReason; readonly note: string } | null;
  /** OMP's declared default; absent when it is not an editable kind or has no value. */
  readonly default?: ConfigValue;
  readonly layers: Readonly<Record<ConfigLayer, ConfigLayerValue>>;
  /**
   * `value` is what the settings layers alone give (never an environment value); `source` is the layer OMP's own
   * provenance names, which is `env` while an environment variable overrides; `layeredSource` is the layer that
   * supplies `value` (never `env`).
   */
  readonly effective: { readonly value?: ConfigValue; readonly source: ConfigSource; readonly layeredSource: ConfigSource };
  /** The variable OMP reads for this setting: `present` when it is set, `active` when it takes effect, `fallback` when a configured layer wins over it. */
  readonly env: { readonly name: string; readonly present: boolean; readonly active: boolean; readonly fallback: boolean } | null;
  /** OMP hides an entry whose condition is false. The page hides it too unless searching. */
  readonly visible: boolean;
  readonly condition: { readonly name: string; readonly note: string } | null;
  readonly writable: Readonly<Record<ConfigLayer, boolean>>;
  /**
   * The project file that supplies this value when it is not the folder's `.omp/config.yml` (OMP merges every project
   * settings file; `.claude/settings.json` and the other foreign files override `.omp/config.yml`). `file` is relative
   * to the folder; `shadows` is true when `.omp/config.yml` sets the key too, so a write to it has no effect.
   */
  readonly projectOther: { readonly file: string; readonly shadows: boolean } | null;
}

export interface ConfigTab { readonly id: string; readonly label: string; readonly lead: string; readonly groups: readonly string[] }
/** The number a typed value stands for, or the sentence that says why it is not accepted. Never lets NaN, Infinity or a fraction of a whole-number setting through. */
export function parseNumericInput(text: string, integer: boolean): { readonly value: number } | { readonly error: string } {
  const trimmed = text.trim();
  if (trimmed === "") return { error: "Enter a number." };
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(trimmed)) return { error: "Enter a plain number, such as 30 or 0.5." };
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return { error: "That number is too large." };
  if (integer && !Number.isInteger(value)) return { error: "Enter a whole number." };
  return { value: value === 0 ? 0 : value };
}

/** The setting that makes the editor use the nearest ancestor `.omp` folder as the project (Unity projects). */
export const NEAREST_OMP_SETTING = "ompDesk.ompSettings.useNearestAncestorOmpFolder";
/** The Project view's notice when an ancestor folder's `.omp` looks like the OMP project (not a refusal: the user may intend this folder). */
export function ancestorProjectNotice(ancestor: string): string {
  return `The folder ${ancestor} has an .omp above this one and looks like the OMP project: sessions that run there will not read settings written here. Turn on ${NEAREST_OMP_SETTING} to edit it instead.`;
}

export interface ConfigFileFacts {
  readonly path: string; readonly exists: boolean;
  /**
   * Project layer only: the nearest ancestor `.omp` directory that holds AGENTS.md, RULES.md or SYSTEM.md while this folder's own
   * `.omp` is missing or empty. OMP loads those files from the *nearest* non-empty `.omp`, so creating `config.yml` here stops
   * the ancestor's files loading for sessions in this folder. Null when nothing would change.
   */
  readonly ancestorOmp?: string | null;
  /**
   * Project layer only: the nearest ancestor folder whose `.omp` is non-empty while this folder has none of its own. OMP sessions probably
   * run there, so settings written here would not be read by them; the page says so and points to `ompDesk.ompSettings.useNearestAncestorOmpFolder`.
   */
  readonly ancestorProject?: string | null;
}

export interface ConfigSnapshot {
  /** `verified`: the installed release is the one this editor was verified against; any release is read through the same shape checks. */
  readonly omp: { readonly version: string; readonly verified: boolean };
  readonly profile: string;
  readonly tabs: readonly ConfigTab[];
  readonly entries: readonly ConfigEntry[];
  readonly files: Readonly<Record<ConfigLayer, ConfigFileFacts>>;
  /** Entries this build skipped (an unknown tab) and other schema findings, in plain sentences. */
  readonly notices: readonly string[];
}

/** A baseline the worker returns and the host sends back unchanged with a write (the host never reads it). */
export interface ConfigFileBaseline {
  readonly logical: string; readonly physical: string; readonly exists: boolean; readonly digest: string; readonly settings: ConfigRecord;
}
export interface ConfigReceipt { readonly snapshot: ConfigSnapshot; readonly baselines: Readonly<Record<ConfigLayer, ConfigFileBaseline>> }

/** One change: set a value, or remove the layer's value (Reset). */
export type ConfigChange =
  | { readonly op: "set"; readonly id: string; readonly layer: ConfigLayer; readonly value: ConfigValue }
  | { readonly op: "reset"; readonly id: string; readonly layer: ConfigLayer };

export type ConfigAction =
  | { action: "ready" | "reload" | "pick-scope" | "open-setting"; requestId: string }
  | { action: "set"; requestId: string; id: string; layer: ConfigLayer; value: ConfigValue }
  | { action: "reset"; requestId: string; id: string; layer: ConfigLayer }
  /** Opens the layer's YAML file in a text editor at the setting's key (read-only settings; the page offers it for them). */
  | { action: "open-config"; requestId: string; layer: ConfigLayer; id?: string };

export type ConfigMessage =
  /** `folder` is null for the global scope, and `projectAvailable` false for it and for the home folder (OMP never treats home as a project): no project layer, so project writes and Reset are unavailable. */
  | { type: "ompConfig:init"; key: string; folder: string | null; profile: string; projectAvailable: boolean }
  | { type: "ompConfig:snapshot"; snapshot: ConfigSnapshot }
  /** The outcome of one request. `ok: false` is a refusal; `message` is a plain sentence the page shows verbatim. */
  | { type: "ompConfig:result"; requestId: string; ok: boolean; message: string };

/** Tabs OMP orders, then entries in OMP's own order. Pure so both sides agree on grouping. */
export function groupedEntries(tab: ConfigTab, entries: readonly ConfigEntry[]): readonly { readonly group: string | null; readonly entries: readonly ConfigEntry[] }[] {
  const inTab = entries.filter(entry => entry.tab === tab.id);
  const known = new Set(tab.groups);
  const sections: { group: string | null; entries: ConfigEntry[] }[] = [];
  const first = inTab.filter(entry => entry.group === null);
  if (first.length) sections.push({ group: null, entries: first });
  for (const group of [...tab.groups, ...new Set(inTab.map(entry => entry.group).filter((group): group is string => group !== null && !known.has(group)))]) {
    const members = inTab.filter(entry => entry.group === group);
    if (members.length) sections.push({ group, entries: members });
  }
  return sections;
}

/** A value as the page and the host's result sentences show it: a choice by its label, a switch as on or off. */
export function formatConfigValue(entry: Pick<ConfigEntry, "control">, value: ConfigValue | undefined): string {
  if (value === undefined) return "not set";
  const options = entry.control !== null && "options" in entry.control ? entry.control.options : [];
  const label = (item: string | number): string => options.find(option => option.value === String(item))?.label ?? String(item);
  if (typeof value === "boolean") return value ? "on" : "off";
  if (Array.isArray(value)) return value.length === 0 ? "none" : value.map(label).join(", ");
  return typeof value === "number" || entry.control?.kind === "enum" ? label(value as string | number) : `"${value as string}"`;
}

/** The layers' own wording in result sentences. */
const LAYER_NAME: Record<ConfigLayer, string> = { global: "global", project: "project" };
const SOURCE_NAME: Record<ConfigSource, string> = { default: "OMP's default", global: "the global layer", project: "the project layer", env: "an environment variable", runtime: "a runtime override", overlay: "a --config overlay" };

/**
 * The one sentence a save or reset answers with, from the entry read back after the write: what changed in
 * which layer, and what OMP now uses and where that comes from (so a shadowing layer or variable is visible).
 */
export function describeOutcome(entry: ConfigEntry, change: Pick<ConfigChange, "op" | "layer">, changed: boolean): string {
  const layer = LAYER_NAME[change.layer];
  if (!changed) {
    return change.op === "reset"
      ? `Nothing to reset: ${entry.label} has no value in the ${layer} layer. The file was not rewritten.`
      : `Nothing to save: ${entry.label} already has this value in the ${layer} layer. The file was not rewritten.`;
  }
  const head = change.op === "reset" ? `Reset ${entry.label}: the ${layer} layer no longer sets it.` : `Saved ${entry.label} to the ${layer} layer.`;
  const envNote = entry.env?.active ? ` ${entry.env.name} overrides it while that variable is set.` : "";
  if (change.layer === "project" && entry.projectOther?.shadows) return `${head} ${entry.projectOther.file} also sets it and overrides this file, so OMP still uses ${formatConfigValue(entry, entry.effective.value)} from there.${envNote}`;
  if (entry.env?.active) return `${head} $${entry.env.name} overrides it while that variable is set.`;
  return `${head} OMP now uses ${formatConfigValue(entry, entry.effective.value)} from ${SOURCE_NAME[entry.effective.source]}.`;
}
