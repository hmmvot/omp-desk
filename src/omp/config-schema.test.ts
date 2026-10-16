import assert from "node:assert/strict";
import { test } from "node:test";
import { ancestorMessage, assertSchemaShape, baselineProjection, optionNumber, projectSnapshot, VERIFIED_OMP_VERSION } from "./config-schema.ts";
import { fakeSchema, loadRecording } from "./config-schema-fixture.ts";
import { evaluateCondition, KNOWN_CONDITIONS } from "./config-conditions.ts";
import { SettingsRefusal } from "../host/omp-settings-core.ts";
import type { ConfigEntry, ConfigSnapshot } from "../protocol/omp-config-model.ts";

const recording = loadRecording();
/** `{ a: { b: value } }` for the dotted segments `a.b`. */
function nest(segments: readonly string[], value: unknown): Record<string, unknown> {
  return segments.length === 1 ? { [segments[0]!]: value } : { [segments[0]!]: nest(segments.slice(1), value) };
}
const entry = (snapshot: ConfigSnapshot, id: string): ConfigEntry => {
  const found = snapshot.entries.find(candidate => candidate.id === id);
  assert.ok(found, `${id} is projected`);
  return found;
};

test("the recorded OMP schema projects into tabs, groups and one control per setting kind", () => {
  const snapshot = projectSnapshot(fakeSchema(recording));
  assert.deepEqual(snapshot.tabs.map(tab => tab.id), recording.tabs.SETTING_TABS);
  const typed = recording.settings.filter(setting => setting.type === "number" && setting.ui && !Object.values(recording.defs).flat().some(def => def.path === setting.id));
  assert.equal(typed.length, 26, "the 26 numbers OMP's panel hides");
  assert.equal(snapshot.entries.length, Object.values(recording.defs).flat().length + typed.length, "every definition OMP's panel has plus the typed numbers is projected, no more");
  for (const setting of typed) assert.deepEqual(entry(snapshot, setting.id).control, { kind: "numeric", integer: Number.isInteger(setting.default) }, setting.id);
  assert.deepEqual(snapshot.notices, []);
  const kinds: Record<string, number> = {};
  for (const item of snapshot.entries) { const key = item.control?.kind ?? `read-only:${item.readOnly?.reason}`; kinds[key] = (kinds[key] ?? 0) + 1; }
  assert.deepEqual(Object.keys(kinds).sort(), ["boolean", "enum", "multiselect", "number", "numeric", "read-only:complex", "read-only:runtime-options", "read-only:secret", "text"]);
  for (const item of snapshot.entries) {
    assert.ok(item.label && item.tab && item.id, `${item.id} has the identity fields`);
    assert.equal(item.readOnly === null, item.control !== null, `${item.id}: read-only exactly when it has no control`);
    if (item.control && "options" in item.control) assert.ok(item.control.options.length > 0 && item.control.options.every(option => option.value !== "" && option.label !== ""), `${item.id}: options are listed`);
  }
  const vim = entry(snapshot, "tui.vimMode");
  assert.deepEqual([vim.tab, vim.group, vim.type, vim.control], ["interaction", "Input", "boolean", { kind: "boolean" }]);
  const percent = entry(snapshot, "compaction.thresholdPercent");
  assert.equal(percent.control?.kind, "number");
  assert.deepEqual(optionNumber("default"), -1);
  assert.ok(percent.control?.kind === "number" && percent.control.options.some(option => option.value === "default"), "the default sentinel is a listed choice");
  assert.deepEqual(entry(snapshot, "theme.dark").readOnly?.reason, "runtime-options");
  const order = entry(snapshot, "compaction.methodOrder");
  assert.ok(order.control?.kind === "multiselect" && order.control.ordered === true);
  assert.equal(entry(snapshot, "providers.maxInFlightRequests").readOnly?.reason, "complex");
});

test("layer values, effective value and source resolve per layer, with project shadowing global", () => {
  const snapshot = projectSnapshot(fakeSchema(recording, {
    global: { lsp: { diagnosticsOnWrite: false }, tui: { vimMode: true } },
    project: { lsp: { diagnosticsOnWrite: true } },
    otherProject: { compaction: { thresholdPercent: 40 } },
  }));
  const lsp = entry(snapshot, "lsp.diagnosticsOnWrite");
  assert.deepEqual(lsp.layers, { global: { state: "set", value: false }, project: { state: "set", value: true } });
  assert.deepEqual(lsp.effective, { value: true, source: "project", layeredSource: "project" });
  const vim = entry(snapshot, "tui.vimMode");
  assert.deepEqual(vim.layers.project, { state: "unset" });
  assert.deepEqual(vim.effective, { value: true, source: "global", layeredSource: "global" });
  const other = entry(snapshot, "compaction.thresholdPercent");
  assert.deepEqual(other.projectOther, { file: ".claude/settings.json", shadows: false }, "a value from another project file is flagged with its file");
  assert.deepEqual(other.layers.project, { state: "unset" });
  assert.equal(other.effective.source, "project");
  const untouched = entry(snapshot, "lsp.formatOnWrite");
  assert.deepEqual([untouched.effective.source, untouched.layers.global.state, untouched.default], ["default", "unset", untouched.effective.value]);
  assert.deepEqual(untouched.writable, { global: true, project: true });
});

test("the project file that wins is the last one that sets the key: a foreign file overrides .omp/config.yml, which overrides .omp/settings.json", () => {
  const snapshot = projectSnapshot(fakeSchema(recording, {
    lowerProject: { lsp: { diagnosticsOnWrite: false, formatOnWrite: false } },
    project: { lsp: { diagnosticsOnWrite: true, formatOnWrite: true } },
    otherProject: { lsp: { formatOnWrite: false } },
  }));
  assert.equal(entry(snapshot, "lsp.diagnosticsOnWrite").projectOther, null, ".omp/config.yml outranks .omp/settings.json, so nothing shadows it");
  const shadowed = entry(snapshot, "lsp.formatOnWrite");
  assert.deepEqual(shadowed.projectOther, { file: ".claude/settings.json", shadows: true }, "the foreign file wins although .omp/config.yml sets the key too");
  assert.equal(shadowed.effective.value, false);
});

test("an environment variable that overrides is reported, not shown as a value; a fallback variable yields to a configured layer", () => {
  const overriding = recording.settings.find(setting => setting.envName !== undefined && setting.envFallback === false && setting.type === "boolean" && setting.ui?.tab !== undefined && !setting.isCredential);
  const fallback = recording.settings.find(setting => setting.envName !== undefined && setting.envFallback !== false && setting.type === "string" && setting.ui?.tab !== undefined && !setting.isCredential);
  assert.ok(overriding && fallback, "the recording has both variable kinds");
  const world = { global: nest(overriding.segments, false), env: { [overriding.envName!]: "1", [fallback.envName!]: "from-env" } };
  const snapshot = projectSnapshot(fakeSchema(recording, world));
  const shadowed = entry(snapshot, overriding.id);
  assert.equal(shadowed.effective.source, "env");
  assert.equal(shadowed.effective.layeredSource, "global");
  assert.equal(shadowed.effective.value, false, "the value is the layers', never the environment's");
  assert.deepEqual(shadowed.env, { name: overriding.envName, present: true, active: true, fallback: false });
  assert.match(shadowed.description, new RegExp(`\\$${overriding.envName} overrides this setting while it is set\\.`));
  const fell = entry(snapshot, fallback.id);
  assert.deepEqual([fell.env?.present, fell.env?.active, fell.env?.fallback], [true, true, true]);
  assert.match(fell.description, /Unset, it falls back to \$/);
  assert.ok(!JSON.stringify(snapshot).includes("from-env"), "an environment value is never sent");
  const configured = projectSnapshot(fakeSchema(recording, { ...world, global: nest(fallback.segments, "configured") }));
  assert.deepEqual([entry(configured, fallback.id).env?.present, entry(configured, fallback.id).env?.active], [true, false], "set, but a configured layer wins");
});

test("credentials never leave the projection: no value, no default, no baseline, state only", () => {
  const secrets = recording.settings.filter(setting => setting.isCredential && setting.ui);
  assert.ok(secrets.length >= 3, "the recording has panel credentials");
  const layerWith = (value: string): Record<string, unknown> => {
    const layer: Record<string, unknown> = {};
    for (const setting of secrets) {
      let parent = layer;
      for (const key of setting.segments.slice(0, -1)) parent = (parent[key] ??= {}) as Record<string, unknown>;
      parent[setting.segments.at(-1)!] = setting.type === "record" ? { token: value } : value;
    }
    return layer;
  };
  const world = { global: layerWith("GLOBAL-SECRET-xyz"), project: layerWith("PROJECT-SECRET-xyz"), env: Object.fromEntries(secrets.filter(setting => setting.envName).map(setting => [setting.envName!, "ENV-SECRET-xyz"])) };
  const input = fakeSchema(recording, world);
  const snapshot = projectSnapshot(input);
  const text = JSON.stringify(snapshot);
  for (const needle of ["GLOBAL-SECRET", "PROJECT-SECRET", "ENV-SECRET"]) assert.ok(!text.includes(needle), `${needle} is not in the snapshot`);
  for (const setting of secrets) {
    const item = entry(snapshot, setting.id);
    assert.equal(item.readOnly?.reason, "secret");
    assert.equal(item.control, null);
    assert.deepEqual(item.writable, { global: false, project: false });
    assert.equal(item.layers.global.state, "set");
    assert.ok(item.layers.global.value === undefined && item.default === undefined && item.effective.value === undefined);
    assert.match(item.readOnly!.note, new RegExp(`omp config set ${setting.id.replace(/\./g, "\\.")}`));
  }
  const baseline = JSON.stringify(baselineProjection(input.layers.getGlobalSettings(), input.settings));
  assert.ok(!baseline.includes("SECRET"), "the write baseline carries no credential");
});

test("visibility conditions: OMP's rules, unknown rules read-only, terminal rules stay visible", () => {
  const off = projectSnapshot(fakeSchema(recording));
  assert.equal(entry(off, "tui.vimModeDisplay").visible, false);
  assert.deepEqual(entry(off, "tui.vimModeDisplay").writable, { global: false, project: false });
  assert.equal(entry(off, "tui.vimModeDisplay").condition?.name, "vimModeEnabled");
  const on = projectSnapshot(fakeSchema(recording, { global: { tui: { vimMode: true } } }));
  assert.equal(entry(on, "tui.vimModeDisplay").visible, true);
  assert.deepEqual(entry(on, "tui.vimModeDisplay").writable, { global: true, project: true });
  const terminal = entry(off, "terminal.showImages");
  assert.deepEqual([terminal.visible, terminal.writable.global], [true, true], "OMP decides from its terminal; the editor shows it");
  assert.equal(entry(off, "spelling.autocorrect").visible, false, "macOS-only on Windows");
  assert.equal(entry(projectSnapshot(fakeSchema(recording, { platform: "darwin" })), "spelling.autocorrect").visible, true);
  const projectList = projectSnapshot(fakeSchema(recording, { otherProject: { contextFiles: { extra: ["a.md"] } } }));
  assert.equal(entry(projectList, "contextFiles.extra").visible, false, "a project-supplied list is not promoted to global");
  const mutated = fakeSchema(recording);
  const first = mutated.settings.find(setting => setting.ui?.condition === "advisorEnabled")!;
  (first as { ui: { condition: string } }).ui = { ...first.ui!, condition: "someFutureCondition" };
  const unknown = entry(projectSnapshot(mutated), first.id);
  assert.equal(unknown.readOnly?.reason, "condition-unknown");
  assert.deepEqual([unknown.visible, unknown.writable.global], [true, false]);
  assert.deepEqual(evaluateCondition("nope", { value: () => undefined, provenance: () => "default", platform: "win32" }), { known: false });
});

test("every condition name the recorded OMP uses has a rule", () => {
  const used = new Set(recording.settings.map(setting => setting.ui?.condition).filter((name): name is string => name !== undefined));
  assert.deepEqual([...used].filter(name => !KNOWN_CONDITIONS.includes(name)), []);
});

test("an invalid configured value is flagged and an oversized one is read-only", () => {
  const snapshot = projectSnapshot(fakeSchema(recording, { global: { tui: { vimMode: "yes" }, lsp: { formatOnWrite: true } }, project: { autocompleteMaxVisible: 999999 } }));
  assert.deepEqual(entry(snapshot, "tui.vimMode").layers.global, { state: "invalid", summary: "not recognised here (OMP may migrate it)" });
  const text = recording.settings.find(setting => setting.type === "string" && setting.ui && recording.defs[setting.ui.tab]?.some(def => def.path === setting.id && def.type === "text") && !setting.isCredential);
  assert.ok(text);
  const big = projectSnapshot(fakeSchema(recording, { global: nest(text.segments, "x".repeat(5000)) }));
  const item = entry(big, text.id);
  assert.equal(item.readOnly?.reason, "oversize");
  assert.equal(item.layers.global.summary, "5000 characters");
  assert.ok(!JSON.stringify(item).includes("xxxxx"), "the oversized value is not sent");
});

test("complex settings report a summary, never contents", () => {
  const snapshot = projectSnapshot(fakeSchema(recording, { global: { providers: { maxInFlightRequests: { openai: 3, anthropic: 2 } } } }));
  const limits = entry(snapshot, "providers.maxInFlightRequests");
  assert.deepEqual(limits.layers.global, { state: "set", summary: "mapping, 2 entries" });
  assert.ok(!JSON.stringify(limits).includes("openai"));
});

test("baselines hold only registered, non-credential values", () => {
  const input = fakeSchema(recording, { global: { tui: { vimMode: true }, unknownBlock: { secretish: "keep" }, lsp: { formatOnWrite: true, bogus: 1 } } });
  assert.deepEqual(baselineProjection(input.layers.getGlobalSettings(), input.settings), { tui: { vimMode: true }, lsp: { formatOnWrite: true } });
});

test("a setting the installed OMP no longer has is not shown, whatever the user's files still hold for it", () => {
  const stale = { providers: { "openai-codex": { codeMode: "on", codeModeDirectTools: ["read"] } } };
  assert.ok(!recording.settings.some(setting => setting.id.startsWith("providers.openai-codex.codeMode")), "the recorded OMP (18.11.1) dropped these settings");
  const clean = projectSnapshot(fakeSchema(recording));
  const snapshot = projectSnapshot(fakeSchema(recording, { global: stale, project: stale, otherProject: stale, lowerProject: stale }));
  assert.deepEqual(snapshot.entries.map(item => item.id), clean.entries.map(item => item.id), "no entry appears for a key only the files hold");
  assert.ok(!JSON.stringify(snapshot).includes("codeMode"), "nothing of the stale key or its value reaches the snapshot");
  assert.deepEqual(snapshot.notices, [], "the page does not warn about it either");
  const input = fakeSchema(recording, { global: stale });
  assert.deepEqual(baselineProjection(input.layers.getGlobalSettings(), input.settings), {}, "a write's baseline does not carry it");
});

test("an unrecognised shape fails closed: no version number gates the editor, the shape checks do", () => {
  assert.equal(projectSnapshot(fakeSchema(recording)).omp.verified, true);
  assert.equal(projectSnapshot({ ...fakeSchema(recording), version: "19.2.0" }).omp.verified, false, "another release is read, and shown as not verified");
  assert.equal(VERIFIED_OMP_VERSION, loadRecording().version);
  const good = fakeSchema(recording);
  assert.doesNotThrow(() => assertSchemaShape(good));
  for (const broken of [
    { ...good, tabs: { ...good.tabs, SETTING_TABS: "appearance" } },
    { ...good, tabs: { ...good.tabs, getSettingsForTab: undefined } },
    { ...good, settings: [] },
    { ...good, settings: [{ id: "x" }] },
    { ...good, lookup: undefined },
    ...["isCredential", "envFallback"].map(member => ({ ...good, settings: good.settings.map(setting => { const copy: Record<string, unknown> = { ...setting }; delete copy[member]; return copy as never; }) })),
    { ...good, settings: good.settings.map(setting => ({ ...setting, ui: "secret" as never })) },
  ]) assert.throws(() => assertSchemaShape(broken), error => error instanceof SettingsRefusal && /shape this version of OMP Desk does not recognise/.test(error.message));
  const noDefs = fakeSchema(recording);
  assert.throws(() => projectSnapshot({ ...noDefs, tabs: { ...noDefs.tabs, getSettingsForTab: () => undefined as never } }), SettingsRefusal);
});

test("a definition whose setting kind or options do not match the control is read-only, not guessed", () => {
  const input = fakeSchema(recording);
  const bad = recording.defs.interaction!.find(def => def.type === "boolean")!;
  const mismatched = { ...input, tabs: { ...input.tabs, getSettingsForTab: (_entries: unknown, tab: string) => recording.defs[tab]!.map(def => def.path === bad.path ? { ...def, type: "marquee" } : def) } };
  assert.equal(entry(projectSnapshot(mismatched), bad.path).readOnly?.reason, "unsupported");
});

test("a credential is recognised by any of OMP's markers, and an unknown provenance word is a drifted schema", () => {
  const input = fakeSchema(recording);
  const target = input.settings.find(setting => !setting.isCredential && setting.ui && setting.type === "string" && recording.defs[setting.ui.tab]?.some(def => def.path === setting.id && def.type === "text"))!;
  const marked = (patch: (setting: typeof target) => typeof target) => {
    const settings = input.settings.map(setting => setting.id === target.id ? patch(setting) : setting);
    return { ...input, settings, lookup: (id: string) => settings.find(setting => setting.id === id) };
  };
  for (const patch of [
    (setting: typeof target) => ({ ...setting, definition: { ...setting.definition, credential: true } }),
    (setting: typeof target) => ({ ...setting, ui: { ...setting.ui!, secret: true } }),
  ]) {
    const secret = entry(projectSnapshot(marked(patch)), target.id);
    assert.equal(secret.readOnly?.reason, "secret");
    assert.equal(secret.control, null);
    assert.deepEqual(baselineProjection({ [target.segments[0]!]: "x" }, marked(patch).settings), {});
  }
  const odd = { ...input, layers: { ...input.layers, getProvenance: () => "elsewhere" } };
  assert.throws(() => projectSnapshot(odd), SettingsRefusal);
});

test("a first project write is explained when an ancestor's context files would stop loading", () => {
  const ancestor = "C:/repo/.omp";
  const snapshot = projectSnapshot(fakeSchema(recording, { ancestorOmp: ancestor }));
  assert.equal(snapshot.files.project.ancestorOmp, ancestor);
  assert.ok(snapshot.notices.includes(ancestorMessage("C:/proj/.omp/config.yml", ancestor)));
  assert.match(ancestorMessage("C:/proj/.omp/config.yml", ancestor), /stop loading them from C:\/repo\/\.omp\. Nothing was changed/);
  assert.deepEqual(projectSnapshot(fakeSchema(recording)).notices, []);
});
