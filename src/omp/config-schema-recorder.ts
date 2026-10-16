import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { ompDependencyRoot } from "../shared/omp-package-layout.ts";
import { nativeEntries } from "./config-schema.ts";
import type { NativeDef, NativeSetting, NativeTabs } from "./config-schema.ts";

/**
 * Test support, run by Bun: writes the part of the installed OMP's settings schema that the editor's projection
 * reads (every setting with panel metadata, the tabs and the resolved panel definitions) as one JSON document on
 * stdout. `src/omp/fixtures/omp-schema.json` is a committed recording of it, so the projection is tested on the
 * real schema without OMP installed; `config-schema.live.test.ts` records the installed OMP again and fails when
 * the two differ, which is how a changed OMP schema is noticed.
 */
const packageRoot = process.argv[2];
if (!packageRoot) throw new Error("Usage: bun config-schema-recorder.ts <pi-coding-agent root>");
const tuiRoot = ompDependencyRoot(packageRoot, "pi-tui");
const load = async (root: string, relative: string): Promise<Record<string, unknown>> => await import(pathToFileURL(path.join(root, relative)).href) as Record<string, unknown>;
const all = await load(packageRoot, "src/config/all-settings.ts") as unknown as { orderedSettings(): readonly NativeSetting[] };
const tabs = await load(tuiRoot, "src/overlays/settings-defs.ts") as unknown as NativeTabs;
const version = (JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8")) as { version: string }).version;
const settings = all.orderedSettings();
const entries = nativeEntries(settings, tabs.SETTING_TABS);
const defs: Record<string, readonly NativeDef[]> = {};
for (const tab of tabs.SETTING_TABS) defs[tab] = tabs.getSettingsForTab(entries, tab).map(def => JSON.parse(JSON.stringify(def)) as NativeDef);
const panel = new Set(Object.values(defs).flat().map(def => def.path));
/** `ui.options` lists the panel definitions already carry are recorded once, in `defs`; the fixture reader puts them back. */
function dedupedUi(setting: NativeSetting): NativeSetting["ui"] {
  const ui = setting.ui;
  if (!ui || !Array.isArray(ui.options)) return ui;
  return { ...ui, options: "@defs" as never };
}
const recording = {
  version,
  tabs: { SETTING_TABS: tabs.SETTING_TABS, TAB_METADATA: tabs.TAB_METADATA, TAB_LEADS: tabs.TAB_LEADS, TAB_GROUPS: tabs.TAB_GROUPS },
  defs,
  settings: settings.filter(setting => panel.has(setting.id) || setting.ui !== undefined).map(setting => ({
    id: setting.id, type: setting.type, default: setting.default, enumValues: setting.enumValues, ui: dedupedUi(setting), isCredential: setting.isCredential,
    envName: setting.envName, envFallback: setting.envFallback, segments: setting.segments, hasNormalize: typeof setting.definition.normalize === "function",
  })),
};
/** Long prose is recorded as a digest: the fixture still changes when OMP rewords it, without carrying 300 KB of text. */
const digest = (text: string): string => `sha256:${createHash("sha256").update(text).digest("hex").slice(0, 16)}`;
const prose = new Set(["description", "warning"]);
process.stdout.write(JSON.stringify(recording, (key, value) => value === Infinity ? "Infinity" : typeof value === "string" && (prose.has(key) || tabLead(key)) ? digest(value) : value, 0));
function tabLead(key: string): boolean { return tabs.SETTING_TABS.includes(key); }
