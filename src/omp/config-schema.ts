import { SettingsRefusal, valueAt } from "../host/omp-settings-core.ts";
import { isRecord as record } from "../shared/guards.ts";
import { evaluateCondition, KNOWN_CONDITIONS } from "./config-conditions.ts";
import type { ConditionReader } from "./config-conditions.ts";
import type {
  ConfigControl, ConfigEntry, ConfigFileFacts, ConfigLayer, ConfigLayerValue, ConfigOption, ConfigReadOnlyReason, ConfigSnapshot,
  ConfigSource, ConfigTab, ConfigValue,
} from "../protocol/omp-config-model.ts";
import type { ConfigRecord } from "../protocol/settings-model.ts";

/**
 * Projects OMP's own settings schema into the bounded JSON the OMP Settings editor shows (ADR-0071).
 * The schema is OMP's: `orderedSettings()` and `lookup()` of `config/registry.ts`, and the tab, group and
 * control mapping of `pi-tui/overlays/settings-defs` (`getSettingsForTab`), which is the mapping the terminal
 * `/settings` uses. Everything is duck-typed against the installed source so a drifted shape is detected, not assumed.
 */
/**
 * The OMP release the projection was written and verified against (the committed recording and the live tests). It is
 * information for the page, never a gate: an installed OMP is judged by the runtime shape checks below, which fail
 * closed (ADR-0011, ADR-0071).
 */
export const VERIFIED_OMP_VERSION = "18.10.3";
const MAX_TEXT = 4096;
const MAX_LIST = 256;
const MAX_OPTIONS = 256;

export interface NativeUi {
  readonly tab: string; readonly group?: string; readonly label: string; readonly description: string; readonly warning?: string;
  readonly condition?: string; readonly options?: readonly NativeOption[] | "runtime"; readonly secret?: boolean; readonly ordered?: boolean; readonly editor?: string;
}
export interface NativeOption { readonly value: string; readonly label: string; readonly description?: string }
/** The registry handle of one setting (`Setting` in `config/registry.ts`), as far as this module reads it. */
export interface NativeSetting {
  readonly id: string; readonly type: string; readonly default: unknown; readonly enumValues?: readonly string[]; readonly ui?: NativeUi;
  readonly isCredential: boolean; readonly envName?: string; readonly envFallback: boolean | string; readonly segments: readonly string[];
  readonly definition: { readonly normalize?: (value: unknown) => unknown; readonly credential?: boolean };
  envValue(): unknown; layered(scope: unknown): unknown; get(scope: unknown): unknown; provenance(scope: unknown): string;
  accepts(value: unknown): boolean; assertWritable(value: unknown): void;
}
/** One definition of `getSettingsForTab` (`SettingDef`). */
export interface NativeDef {
  readonly path: string; readonly type: string; readonly schemaType: string; readonly tab: string; readonly group?: string;
  readonly values?: readonly string[]; readonly options?: readonly NativeOption[]; readonly ordered?: boolean; readonly secret?: boolean;
}
export interface NativeEntry {
  path: string; type: string; defaultValue: unknown; ui?: NativeUi; enumValues?: readonly string[]; credential?: boolean;
}
export interface NativeTabs {
  readonly SETTING_TABS: readonly string[];
  readonly TAB_METADATA?: Readonly<Record<string, { readonly label?: string }>>;
  readonly TAB_LEADS?: Readonly<Record<string, string>>;
  readonly TAB_GROUPS: Readonly<Record<string, readonly string[]>>;
  getSettingsForTab(entries: readonly NativeEntry[], tab: string): readonly NativeDef[];
}
/** The read-only `Settings` instance (`Settings.loadReadOnly`). */
export interface NativeLayers {
  getGlobalSettings(): ConfigRecord; getProjectSettings(): ConfigRecord; getProvenance(setting: NativeSetting): string;
}
export interface SchemaInput {
  readonly tabs: NativeTabs; readonly settings: readonly NativeSetting[]; readonly layers: NativeLayers;
  /** The folder's own `.omp/config.yml`, parsed as the file holds it (the layer a project write targets). */
  readonly nativeProject: ConfigRecord;
  /** Every project settings file OMP merges, lowest precedence first (a later file overrides an earlier one), with its path relative to the folder. */
  readonly projectFiles: readonly { readonly file: string; readonly native: boolean; readonly data: ConfigRecord }[];
  readonly lookup: (id: string) => NativeSetting | undefined;
  readonly platform: NodeJS.Platform; readonly version: string; readonly profile: string;
  readonly files: Readonly<Record<ConfigLayer, ConfigFileFacts>>;
}

/** Why the first project write is refused when an ancestor's `.omp` holds context files (see `ancestorContextDir`). */
export function ancestorMessage(projectFile: string, ancestorOmp: string): string {
  return `Saving a project setting would create ${projectFile}. OMP loads AGENTS.md, RULES.md and SYSTEM.md from the nearest non-empty .omp folder, so sessions in this folder would stop loading them from ${ancestorOmp}. Nothing was changed. Create the file yourself if that is what you want.`;
}
export const SHAPE_MESSAGE = "The installed OMP's settings schema has a shape this version of OMP Desk does not recognise, so nothing was read or changed. Use OMP's /settings in a terminal, or update OMP Desk.";

/** Fails closed on a registry or tab module that does not have the shape this projection was written against. */
export function assertSchemaShape(input: { tabs: unknown; settings: unknown; lookup: unknown }): void {
  const tabs = input.tabs;
  const ok = record(tabs) && Array.isArray(tabs.SETTING_TABS) && tabs.SETTING_TABS.length > 0 && tabs.SETTING_TABS.every(tab => typeof tab === "string")
    && record(tabs.TAB_GROUPS) && typeof tabs.getSettingsForTab === "function"
    && Array.isArray(input.settings) && input.settings.length > 0 && typeof input.lookup === "function"
    && input.settings.every(setting => record(setting) && typeof setting.id === "string" && typeof setting.type === "string"
      && Array.isArray(setting.segments) && typeof setting.layered === "function" && typeof setting.get === "function" && typeof setting.provenance === "function"
      && typeof setting.accepts === "function" && typeof setting.assertWritable === "function" && typeof setting.envValue === "function" && record(setting.definition)
      // Credentials are recognised only through these members; a build that renames one must be refused, never shown as editable text.
      && typeof setting.isCredential === "boolean" && (setting.definition.credential === undefined || typeof setting.definition.credential === "boolean")
      && (setting.ui === undefined || record(setting.ui) && (setting.ui.secret === undefined || typeof setting.ui.secret === "boolean"))
      && (setting.envName === undefined || typeof setting.envName === "string") && (typeof setting.envFallback === "boolean" || typeof setting.envFallback === "string"));
  if (!ok) throw new SettingsRefusal(SHAPE_MESSAGE);
}

/** A credential by any of OMP's markers (`Setting.isCredential`, the definition's `credential`, the legacy `ui.secret`): never read, shown or retained. */
export function isSecret(setting: NativeSetting): boolean {
  return setting.isCredential === true || setting.definition.credential === true || setting.ui?.secret === true;
}

/** The entries OMP's terminal host builds (`createSettingsHost`), without its visibility predicates. */
export function nativeEntries(settings: readonly NativeSetting[], tabs: readonly string[]): NativeEntry[] {
  const entries: NativeEntry[] = [];
  for (const tab of tabs) {
    for (const setting of settings) {
      const ui = setting.ui;
      if (ui?.tab !== tab) continue;
      const note = envNote(setting);
      entries.push({
        path: setting.id, type: setting.type, defaultValue: setting.default,
        ui: note ? { ...ui, description: `${ui.description}${note}` } : ui,
        enumValues: setting.enumValues, credential: isSecret(setting),
      });
    }
  }
  return entries;
}
/** OMP's `envNote`: the description suffix naming an environment variable that is set. */
function envNote(setting: NativeSetting): string {
  if (!setting.envName || setting.envValue() === undefined) return "";
  return setting.envFallback ? ` Unset, it falls back to $${setting.envName}.` : ` $${setting.envName} overrides this setting while it is set.`;
}

function describeComplex(value: unknown): string {
  if (Array.isArray(value)) return `list, ${value.length} ${value.length === 1 ? "item" : "items"}`;
  if (record(value)) { const count = Object.keys(value).length; return `mapping, ${count} ${count === 1 ? "entry" : "entries"}`; }
  return "value";
}
const NOTES: Record<Exclude<ConfigReadOnlyReason, "condition-unknown">, (id: string) => string> = {
  secret: id => `This is a credential. OMP Desk never shows or changes credentials. Set it in a terminal: omp config set ${id} <value>.`,
  complex: () => "A list or mapping with no simple control. Open the YAML file at this key to edit it.",
  "runtime-options": () => "OMP fills this setting's choices at run time (installed themes and shapes). Change it in OMP's /settings or in the YAML file.",
  oversize: () => "This value is too large to show here. Open the YAML file at this key to edit it.",
  unsupported: () => "This setting uses a control this version of OMP Desk does not know. Open the YAML file at this key to edit it.",
};
const CONDITION_UNKNOWN_NOTE = "OMP shows this setting under a visibility rule this version of OMP Desk does not know. Open the YAML file at this key to edit it.";

/** The control a `getSettingsForTab` definition maps to, or why the entry is read-only. */
function controlFor(def: NativeDef, setting: NativeSetting): { control: ConfigControl | null; reason: ConfigReadOnlyReason | null } {
  const readOnly = (reason: ConfigReadOnlyReason) => ({ control: null, reason });
  if (isSecret(setting) || def.secret === true) return readOnly("secret");
  const options = (source: readonly NativeOption[] | undefined): ConfigOption[] | null => {
    if (!Array.isArray(source) || source.length === 0 || source.length > MAX_OPTIONS) return null;
    const result: ConfigOption[] = [];
    for (const option of source) {
      if (!record(option) || typeof option.value !== "string" || typeof option.label !== "string") return null;
      result.push({ value: option.value, label: option.label, ...(typeof option.description === "string" ? { description: option.description } : {}) });
    }
    return result;
  };
  switch (def.type) {
    case "boolean": return setting.type === "boolean" ? { control: { kind: "boolean" }, reason: null } : readOnly("unsupported");
    case "enum": {
      const listed = options((def.values ?? []).map(value => ({ value, label: value })));
      return setting.type === "enum" && listed ? { control: { kind: "enum", options: listed }, reason: null } : readOnly("unsupported");
    }
    case "submenu": {
      if (setting.ui?.options === "runtime") return readOnly("runtime-options");
      const listed = options(def.options);
      if (!listed) return readOnly("unsupported");
      if (setting.type === "enum" || setting.type === "string") {
        if (!listed.every(option => setting.accepts(option.value))) return readOnly("unsupported");
        return { control: { kind: "enum", options: listed }, reason: null };
      }
      if (setting.type === "number") return listed.every(option => optionNumber(option.value) !== undefined) ? { control: { kind: "number", options: listed }, reason: null } : readOnly("unsupported");
      return readOnly("unsupported");
    }
    case "numeric": return setting.type === "number" ? { control: { kind: "numeric", integer: Number.isInteger(setting.default) }, reason: null } : readOnly("unsupported");
    case "text": return setting.type === "string" ? { control: { kind: "text" }, reason: null } : setting.type === "array" || setting.type === "record" ? readOnly("complex") : readOnly("unsupported");
    case "providerLimits": return readOnly("complex");
    case "multiselect": {
      const listed = options(def.options);
      return setting.type === "array" && listed ? { control: { kind: "multiselect", options: listed, ordered: def.ordered === true }, reason: null } : readOnly("unsupported");
    }
    default: return readOnly("unsupported");
  }
}

/** The number a number choice stands for: its own value, or -1 for OMP's `default` sentinel (`numericOption`). */
export function optionNumber(value: string): number | undefined {
  if (value === "default") return -1;
  const parsed = Number(value);
  return value.trim() !== "" && Number.isFinite(parsed) ? parsed : undefined;
}

function convertValue(control: ConfigControl | null, setting: NativeSetting, raw: unknown): { value?: ConfigValue; oversize?: boolean; invalid?: boolean } {
  if (control === null) return {};
  switch (control.kind) {
    case "boolean": return typeof raw === "boolean" ? { value: raw } : { invalid: true };
    case "number": return typeof raw === "number" && Number.isFinite(raw) ? { value: raw } : { invalid: true };
    case "numeric": return typeof raw === "number" && Number.isFinite(raw) ? { value: raw } : { invalid: true };
    case "enum": return typeof raw === "string" ? { value: raw } : { invalid: true };
    case "text": return typeof raw !== "string" ? { invalid: true } : raw.length > MAX_TEXT ? { oversize: true } : { value: raw };
    case "multiselect":
      if (!Array.isArray(raw) || !raw.every(item => typeof item === "string")) return { invalid: true };
      return raw.length > MAX_LIST ? { oversize: true } : { value: [...raw] as string[] };
  }
}

/** OMP may still migrate a legacy spelling in the file (`task.eager: true`), so this is not "ignored". */
const INVALID_SUMMARY = "not recognised here (OMP may migrate it)";
function layerState(setting: NativeSetting, control: ConfigControl | null, secret: boolean, raw: unknown): { layer: ConfigLayerValue; oversize: boolean } {
  if (raw === undefined || raw === null) return { layer: { state: "unset" }, oversize: false };
  if (secret) return { layer: { state: "set" }, oversize: false };
  if (!setting.accepts(raw)) return { layer: { state: "invalid", summary: INVALID_SUMMARY }, oversize: false };
  if (control === null) return { layer: { state: "set", summary: describeComplex(raw) }, oversize: false };
  const converted = convertValue(control, setting, raw);
  if (converted.invalid) return { layer: { state: "invalid", summary: INVALID_SUMMARY }, oversize: false };
  if (converted.oversize) return { layer: { state: "set", summary: typeof raw === "string" ? `${raw.length} characters` : describeComplex(raw) }, oversize: true };
  return { layer: { state: "set", value: converted.value }, oversize: false };
}

/** OMP's provenance words; one this build does not know is a drifted schema, not a default. */
function sourceOf(text: unknown): ConfigSource {
  if (text === "default" || text === "env" || text === "runtime" || text === "overlay" || text === "project" || text === "global") return text;
  throw new SettingsRefusal(SHAPE_MESSAGE);
}
function editableDefault(control: ConfigControl | null, setting: NativeSetting): ConfigValue | undefined {
  if (control === null) return undefined;
  const converted = convertValue(control, setting, setting.default);
  return converted.value;
}

/**
 * The project file that wins a setting when it is not `.omp/config.yml`: OMP merges every project settings file, lowest
 * precedence first, so the last file that sets the key supplies the project layer's value (verified in OMP 18.10.3:
 * `.claude/settings.json` overrides `.omp/config.yml`, which overrides `.omp/settings.json`).
 */
function foreignProjectFile(input: SchemaInput, setting: NativeSetting): ConfigEntry["projectOther"] {
  for (let index = input.projectFiles.length - 1; index >= 0; index--) {
    const source = input.projectFiles[index]!;
    if (valueAt(source.data, setting.segments) == null) continue;
    return source.native ? null : { file: source.file, shadows: valueAt(input.nativeProject, setting.segments) != null };
  }
  return null;
}

export function projectSnapshot(input: SchemaInput): ConfigSnapshot {
  assertSchemaShape({ tabs: input.tabs, settings: input.settings, lookup: input.lookup });
  const globalLayer = input.layers.getGlobalSettings();
  const reader: ConditionReader = {
    platform: input.platform,
    value: id => input.lookup(id)?.get(input.layers),
    provenance: id => { const setting = input.lookup(id); return setting ? setting.provenance(input.layers) : "default"; },
  };
  const scope: unknown = input.layers;
  const nativeEntriesList = nativeEntries(input.settings, input.tabs.SETTING_TABS);
  const notices: string[] = [];
  const tabs: ConfigTab[] = [];
  const entries: ConfigEntry[] = [];
  for (const tab of input.tabs.SETTING_TABS) {
    const listedDefs = input.tabs.getSettingsForTab(nativeEntriesList, tab);
    if (!Array.isArray(listedDefs)) throw new SettingsRefusal(SHAPE_MESSAGE);
    // OMP's panel hides a number with no listed choices; these are shown here with a validated number input.
    const listedPaths = new Set(listedDefs.map(def => def.path));
    const defs = [...listedDefs, ...input.settings.filter(setting => setting.ui?.tab === tab && setting.type === "number" && !isSecret(setting) && !listedPaths.has(setting.id)
      && (setting.ui.options === undefined || !Array.isArray(setting.ui.options) || setting.ui.options.length === 0) && setting.ui.options !== "runtime")
      .map((setting): NativeDef => ({ path: setting.id, type: "numeric", schemaType: "number", tab }))];
    const groups = Array.isArray(input.tabs.TAB_GROUPS[tab]) ? input.tabs.TAB_GROUPS[tab]!.filter((group): group is string => typeof group === "string") : [];
    tabs.push({ id: tab, label: input.tabs.TAB_METADATA?.[tab]?.label ?? tab, lead: input.tabs.TAB_LEADS?.[tab] ?? "", groups });
    for (const def of defs) {
      const setting = input.lookup(def.path);
      const ui = setting?.ui;
      if (!setting || !ui) { notices.push(`OMP lists ${def.path} without a registered setting; it was skipped.`); continue; }
      const { control, reason: controlReason } = controlFor(def, setting);
      const secret = controlReason === "secret";
      const condition = ui.condition === undefined ? null : evaluateCondition(ui.condition, reader);
      const globalState = layerState(setting, control, secret, valueAt(globalLayer, setting.segments));
      const projectState = layerState(setting, control, secret, valueAt(input.nativeProject, setting.segments));
      const oversize = globalState.oversize || projectState.oversize;
      const reason: ConfigReadOnlyReason | null = controlReason ?? (condition !== null && !condition.known ? "condition-unknown" : oversize ? "oversize" : null);
      const visible = condition === null || !condition.known || condition.visible;
      const editable = reason === null && visible;
      const provenance = setting.provenance(scope);
      const layeredRaw = secret ? undefined : setting.layered(scope);
      const effectiveConverted = secret ? {} : convertValue(control, setting, layeredRaw);
      const projectOther = foreignProjectFile(input, setting);
      const present = setting.envName !== undefined && setting.envValue() !== undefined;
      const defaultValue = secret ? undefined : editableDefault(control, setting);
      entries.push({
        id: setting.id, tab, group: typeof ui.group === "string" ? ui.group : null, label: ui.label, description: ui.description + (envNote(setting)),
        ...(typeof ui.warning === "string" ? { warning: ui.warning } : {}),
        type: setting.type === "boolean" || setting.type === "enum" || setting.type === "number" || setting.type === "string" || setting.type === "array" || setting.type === "record" ? setting.type : "string",
        control, readOnly: reason === null ? null : { reason, note: reason === "condition-unknown" ? CONDITION_UNKNOWN_NOTE : NOTES[reason](setting.id) },
        ...(defaultValue === undefined ? {} : { default: defaultValue }),
        layers: { global: globalState.layer, project: projectState.layer },
        effective: { ...(effectiveConverted.value === undefined ? {} : { value: effectiveConverted.value }), source: sourceOf(provenance), layeredSource: sourceOf(input.layers.getProvenance(setting)) },
        env: setting.envName === undefined ? null : { name: setting.envName, present, active: provenance === "env", fallback: Boolean(setting.envFallback) },
        visible, condition: condition === null || !condition.known ? null : { name: ui.condition!, note: condition.note },
        writable: { global: editable, project: editable }, projectOther,
      });
    }
  }
  // Settings OMP gives a tab this build does not list are never in OMP's own panel either.
  if (input.files.project.ancestorOmp) notices.push(ancestorMessage(input.files.project.path, input.files.project.ancestorOmp));
  const listed = new Set(input.tabs.SETTING_TABS);
  const unlisted = input.settings.filter(setting => setting.ui !== undefined && !listed.has(setting.ui.tab)).length;
  if (unlisted > 0) notices.push(`${unlisted} setting${unlisted === 1 ? " uses" : "s use"} a tab this version of OMP Desk does not know and ${unlisted === 1 ? "is" : "are"} not shown.`);
  return { omp: { version: input.version, verified: input.version === VERIFIED_OMP_VERSION }, profile: input.profile, tabs, entries, files: input.files, notices };
}

/** The values at every registered, non-credential setting path: what a locked write compares against (no secret reaches the host). */
export function baselineProjection(layer: ConfigRecord, settings: readonly NativeSetting[]): ConfigRecord {
  const result: ConfigRecord = {};
  for (const setting of settings) {
    if (isSecret(setting)) continue;
    const value = valueAt(layer, setting.segments);
    if (value === undefined) continue;
    let parent = result;
    for (const key of setting.segments.slice(0, -1)) {
      if (!record(parent[key])) parent[key] = {};
      parent = parent[key] as ConfigRecord;
    }
    Object.defineProperty(parent, setting.segments.at(-1)!, { value: structuredClone(value), writable: true, enumerable: true, configurable: true });
  }
  return result;
}
export { KNOWN_CONDITIONS };
