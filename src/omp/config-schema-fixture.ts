import { readFileSync } from "node:fs";
import { valueAt } from "../host/omp-settings-core.ts";
import type { NativeDef, NativeLayers, NativeSetting, NativeTabs, NativeUi, SchemaInput } from "./config-schema.ts";
import type { ConfigRecord } from "../protocol/settings-model.ts";

/**
 * Test support: the committed recording of the installed OMP's settings schema (`fixtures/omp-schema.json`, written by
 * `config-schema-recorder.ts`) turned into the objects `projectSnapshot` reads, with in-memory layers and environment.
 */
interface RecordedSetting {
  id: string; type: string; default: unknown; enumValues?: string[]; ui?: Omit<NativeUi, "options"> & { options?: unknown }; isCredential: boolean;
  envName?: string; envFallback: boolean | string; segments: string[]; hasNormalize: boolean;
}
export interface Recording {
  version: string;
  tabs: { SETTING_TABS: string[]; TAB_METADATA: Record<string, { label: string }>; TAB_LEADS: Record<string, string>; TAB_GROUPS: Record<string, string[]> };
  defs: Record<string, NativeDef[]>;
  settings: RecordedSetting[];
}
export const RECORDING_URL = new URL("./fixtures/omp-schema.json", import.meta.url);
export function loadRecording(): Recording { return JSON.parse(readFileSync(RECORDING_URL, "utf8")) as Recording; }

export interface FakeWorld {
  readonly global?: ConfigRecord; readonly project?: ConfigRecord;
  /** `.claude/settings.json`: a project file OMP merges over `.omp/config.yml`. */
  readonly otherProject?: ConfigRecord;
  /** `.omp/settings.json`: a project file `.omp/config.yml` overrides. */
  readonly lowerProject?: ConfigRecord;
  /** The nearest ancestor `.omp` whose context files a first project write would stop loading. */
  readonly ancestorOmp?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly platform?: NodeJS.Platform;
}

function deepMerge(base: ConfigRecord, over: ConfigRecord): ConfigRecord {
  const result: ConfigRecord = structuredClone(base);
  for (const [key, value] of Object.entries(over)) {
    const current = result[key];
    result[key] = typeof value === "object" && value !== null && !Array.isArray(value) && typeof current === "object" && current !== null && !Array.isArray(current)
      ? deepMerge(current as ConfigRecord, value as ConfigRecord) : structuredClone(value);
  }
  return result;
}

export function fakeSchema(recording: Recording, world: FakeWorld = {}): SchemaInput {
  const global = world.global ?? {}; const project = world.project ?? {}; const otherProject = world.otherProject ?? {}; const lowerProject = world.lowerProject ?? {};
  const projectFiles = [
    { file: ".omp/settings.json", native: false, data: lowerProject }, { file: ".omp/config.yml", native: true, data: project }, { file: ".claude/settings.json", native: false, data: otherProject },
  ].filter(source => Object.keys(source.data).length > 0);
  const mergedProject = projectFiles.reduce<ConfigRecord>((merged, source) => deepMerge(merged, source.data), {});
  const defOptions = new Map(Object.values(recording.defs).flat().map(def => [def.path, def.options]));
  const settings: NativeSetting[] = recording.settings.map(recorded => {
    const accepts = (value: unknown): boolean => {
      switch (recorded.type) {
        case "boolean": return typeof value === "boolean";
        case "number": return typeof value === "number" && Number.isFinite(value);
        case "string": return typeof value === "string";
        case "enum": return typeof value === "string" && (recorded.enumValues ?? []).includes(value);
        case "array": return Array.isArray(value);
        case "record": return typeof value === "object" && value !== null && !Array.isArray(value);
        default: return false;
      }
    };
    const configured = (layer: ConfigRecord): boolean => valueAt(layer, recorded.segments) != null;
    const envRaw = recorded.envName === undefined ? undefined : world.env?.[recorded.envName];
    const envValue = (): unknown => envRaw === undefined || envRaw === "" ? undefined : recorded.type === "boolean" ? ["1", "true", "yes", "on", "y"].includes(envRaw.toLowerCase()) : recorded.type === "number" ? Number(envRaw) : envRaw;
    const layeredSource = (): string => configured(mergedProject) ? "project" : configured(global) ? "global" : "default";
    const layeredValue = (): unknown => { const raw = valueAt(configured(mergedProject) ? mergedProject : global, recorded.segments); return raw == null || !accepts(raw) ? recorded.default : raw; };
    const envWins = (): boolean => envValue() !== undefined && (!recorded.envFallback || layeredSource() === "default");
    const ui = recorded.ui === undefined ? undefined : { ...recorded.ui, ...(recorded.ui.options === "@defs" ? { options: defOptions.get(recorded.id) } : {}) } as NativeUi;
    return {
      id: recorded.id, type: recorded.type, default: recorded.default, enumValues: recorded.enumValues, ui, isCredential: recorded.isCredential,
      envName: recorded.envName, envFallback: recorded.envFallback, segments: recorded.segments,
      definition: recorded.hasNormalize ? { normalize: (value: unknown) => value } : {},
      envValue, layered: layeredValue, get: () => envWins() ? envValue() : layeredValue(),
      provenance: () => envWins() ? "env" : layeredSource(), accepts,
      assertWritable: (value: unknown) => { if (!accepts(value)) throw new Error(`Invalid value for ${recorded.id}`); },
    };
  });
  const byId = new Map(settings.map(setting => [setting.id, setting]));
  const tabs: NativeTabs = { ...recording.tabs, getSettingsForTab: (_entries, tab) => recording.defs[tab] ?? [] };
  const layers: NativeLayers = {
    getGlobalSettings: () => structuredClone(global), getProjectSettings: () => structuredClone(mergedProject),
    getProvenance: setting => valueAt(mergedProject, setting.segments) != null ? "project" : valueAt(global, setting.segments) != null ? "global" : "default",
  };
  return {
    tabs, settings, layers, nativeProject: structuredClone(project), projectFiles, lookup: id => byId.get(id), platform: world.platform ?? "win32", version: recording.version, profile: "default",
    files: { global: { path: "C:/agent/config.yml", exists: true }, project: { path: "C:/proj/.omp/config.yml", exists: true, ancestorOmp: world.ancestorOmp ?? null } },
  };
}
