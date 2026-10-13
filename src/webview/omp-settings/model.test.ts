import assert from "node:assert/strict";
import { test } from "node:test";
import { effectiveValue, entryBadges, entryMatches, moveMember, numberOptionFor, optionNumberValue, sameList, shownEntries, shownValue, tabCounts, toggleMember } from "./model.ts";
import { groupedEntries } from "../../protocol/omp-config-model.ts";
import type { ConfigEntry, ConfigOption, ConfigTab } from "../../protocol/omp-config-model.ts";

const entry = (id: string, patch: Partial<ConfigEntry> = {}): ConfigEntry => ({
  id, tab: "files", group: "LSP", label: id.toUpperCase(), description: `About ${id}`, type: "boolean", control: { kind: "boolean" }, readOnly: null,
  layers: { global: { state: "unset" }, project: { state: "unset" } }, effective: { value: false, source: "default", layeredSource: "default" },
  env: null, visible: true, condition: null, writable: { global: true, project: true }, projectOther: null, ...patch,
});
const tabs: ConfigTab[] = [{ id: "files", label: "Files", lead: "", groups: ["Editing", "LSP"] }, { id: "tools", label: "Tools", lead: "", groups: [] }];

test("filter: every word must match id, label, group or description; an entry OMP hides is hidden in search too", () => {
  const entries = [entry("lsp.format", { description: "Format on write" }), entry("tui.vim", { visible: false, group: null, tab: "tools" })];
  assert.equal(entryMatches(entries[0]!, "FORMAT write"), true);
  assert.equal(entryMatches(entries[0]!, "format nothing"), false);
  assert.equal(entryMatches(entries[0]!, "  "), true);
  assert.deepEqual(shownEntries(entries, "").map(item => item.id), ["lsp.format"], "no query: OMP's own visibility");
  assert.deepEqual(shownEntries(entries, "vim").map(item => item.id), [], "OMP's search does not list an entry whose condition is false");
  assert.deepEqual(tabCounts(tabs, entries, ""), { files: 1, tools: 0 });
  assert.deepEqual(tabCounts(tabs, entries, "vim"), { files: 0, tools: 0 });
});

test("sections: ungrouped first, then OMP's group order, then groups OMP did not list", () => {
  const entries = [entry("a", { group: "LSP" }), entry("b", { group: null }), entry("c", { group: "Editing" }), entry("d", { group: "Surprise" }), entry("e", { tab: "tools" })];
  assert.deepEqual(groupedEntries(tabs[0]!, entries).map(section => [section.group, section.entries.map(item => item.id)]), [[null, ["b"]], ["Editing", ["c"]], ["LSP", ["a"]], ["Surprise", ["d"]]]);
});

test("a layer's control shows its own value, else the layer below it, never the value in force from a higher layer", () => {
  const set = entry("a", { layers: { global: { state: "set", value: true }, project: { state: "unset" } }, effective: { value: false, source: "project", layeredSource: "project" }, default: false });
  assert.deepEqual(shownValue(set, "global"), { value: true, inherited: false });
  assert.deepEqual(shownValue(set, "project"), { value: true, inherited: true }, "the project layer falls back to the global value");
  const fromProject = entry("b", { layers: { global: { state: "unset" }, project: { state: "set", value: true } }, effective: { value: true, source: "project", layeredSource: "project" }, default: false });
  assert.deepEqual(shownValue(fromProject, "global"), { value: false, inherited: true }, "the global layer falls back to OMP's default, not the project's value");
  assert.equal(effectiveValue(fromProject), true);
  const fallback = entry("c", { effective: {} as never, default: true });
  assert.deepEqual(shownValue(fallback, "global"), { value: true, inherited: true });
});

test("badges: layer values, the source in force, other-file projects and environment overrides; a credential shows only that it is set", () => {
  const shadowed = entry("a", { layers: { global: { state: "set", value: true }, project: { state: "set", value: false } }, effective: { value: false, source: "project", layeredSource: "project" }, projectOther: { file: ".claude/settings.json", shadows: true },
    env: { name: "PI_X", present: true, active: true, fallback: false } });
  assert.deepEqual(entryBadges(shadowed).map(badge => badge.text), ["global: on", "project: off", ".claude/settings.json overrides", "in effect: project", "$PI_X overrides"]);
  assert.deepEqual(entryBadges(entry("f", { projectOther: { file: ".omp/settings.json", shadows: false } })).map(badge => badge.text), ["project: .omp/settings.json", "in effect: default"]);
  const idle = entry("b", { env: { name: "PI_Y", present: true, active: false, fallback: true } });
  assert.deepEqual(entryBadges(idle).map(badge => badge.text), ["in effect: default", "$PI_Y set, not used"]);
  const secret = entry("c", { control: null, readOnly: { reason: "secret", note: "" }, layers: { global: { state: "set" }, project: { state: "unset" } } });
  assert.deepEqual(entryBadges(secret).map(badge => badge.text), ["global: set", "in effect: default"]);
  const invalid = entry("d", { layers: { global: { state: "invalid", summary: "a value OMP ignores" }, project: { state: "unset" } } });
  assert.deepEqual(entryBadges(invalid)[0], { text: "global: invalid", tone: "warn", title: "The global layer sets this setting." });
  assert.equal(entryBadges(entry("e", { layers: { global: { state: "set", summary: "mapping, 2 entries" }, project: { state: "unset" } }, control: null }))[0]!.text, "global: mapping, 2 entries");
});

test("number choices map to numbers, with OMP's `default` as -1", () => {
  const options: ConfigOption[] = [{ value: "default", label: "Default" }, { value: "10", label: "10%" }];
  assert.equal(numberOptionFor(options, -1)?.label, "Default");
  assert.equal(numberOptionFor(options, 10)?.value, "10");
  assert.equal(numberOptionFor(options, 11), undefined);
  assert.equal(numberOptionFor(options, undefined), undefined);
  assert.deepEqual(options.map(optionNumberValue), [-1, 10]);
});

test("list edits keep OMP's option order unless the list is ordered", () => {
  const options: ConfigOption[] = ["a", "b", "c"].map(value => ({ value, label: value }));
  assert.deepEqual(toggleMember(["c"], "a", options, false), ["a", "c"]);
  assert.deepEqual(toggleMember(["c"], "a", options, true), ["c", "a"]);
  assert.deepEqual(toggleMember(["a", "c"], "a", options, true), ["c"]);
  assert.deepEqual(moveMember(["a", "b", "c"], "b", -1), ["b", "a", "c"]);
  assert.deepEqual(moveMember(["a", "b"], "a", -1), ["a", "b"], "the first cannot move up");
  assert.deepEqual(moveMember(["a", "b"], "z", 1), ["a", "b"]);
  assert.equal(sameList(["a"], ["a"]) && !sameList(["a"], ["b"]), true);
});
