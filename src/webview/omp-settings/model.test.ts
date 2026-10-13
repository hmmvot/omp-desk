import assert from "node:assert/strict";
import { test } from "node:test";
import { anchorId, effectiveValue, entryMatches, fileLayerFor, highlightParts, isModified, layout, modifiedCount, moveMember, numberOptionFor, optionNumberValue, parseQuery, rowNotes, sameList, shownEntries, shownValue, toggleMember } from "./model.ts";
import type { ConfigEntry, ConfigOption, ConfigTab } from "../../protocol/omp-config-model.ts";

const entry = (id: string, patch: Partial<ConfigEntry> = {}): ConfigEntry => ({
  id, tab: "files", group: "LSP", label: id.toUpperCase(), description: `About ${id}`, type: "boolean", control: { kind: "boolean" }, readOnly: null,
  layers: { global: { state: "unset" }, project: { state: "unset" } }, effective: { value: false, source: "default", layeredSource: "default" },
  env: null, visible: true, condition: null, writable: { global: true, project: true }, projectOther: null, ...patch,
});
const tabs: ConfigTab[] = [{ id: "files", label: "Files", lead: "", groups: ["Editing", "LSP"] }, { id: "tools", label: "Tools", lead: "", groups: [] }];

test("search words match id, label, group, tab or description; an entry OMP hides is hidden in search too", () => {
  const entries = [entry("lsp.format", { description: "Format on write" }), entry("tui.vim", { visible: false, group: null, tab: "tools" })];
  assert.equal(entryMatches(entries[0]!, "FORMAT write"), true);
  assert.equal(entryMatches(entries[0]!, "format nothing"), false);
  assert.equal(entryMatches(entries[0]!, "files", "Files"), true, "the tab label is searchable");
  assert.equal(entryMatches(entries[0]!, "  "), true);
  assert.deepEqual(shownEntries(entries, "").map(item => item.id), ["lsp.format"], "no query: OMP's own visibility");
  assert.deepEqual(shownEntries(entries, "vim").map(item => item.id), [], "OMP's search does not list an entry whose condition is false");
});

test("filters: typed @tokens and the chips narrow the same way; tab filters take the tab id", () => {
  const set = { global: { state: "set", value: true }, project: { state: "unset" } } as const;
  const entries = [
    entry("a", { layers: set }), entry("b", { layers: { global: { state: "unset" }, project: { state: "set", value: true } } }), entry("c", { env: { name: "PI_C", present: false, active: false, fallback: false } }),
    entry("d", { warning: "Risky", tab: "tools" }), entry("e", { control: null, readOnly: { reason: "complex", note: "" } }), entry("f", { layers: { global: { state: "invalid", summary: "x" }, project: { state: "unset" } } }),
  ];
  const ids = (query: string, chips: string[] = []): string[] => shownEntries(entries, query, chips).map(item => item.id);
  assert.deepEqual(ids("@modified"), ["a", "b", "f"]);
  assert.deepEqual(ids("", ["modified"]), ids("@modified"));
  assert.deepEqual(ids("@project"), ["b"]);
  assert.deepEqual(ids("@env"), ["c"]);
  assert.deepEqual(ids("@warning"), ["d", "f"]);
  assert.deepEqual(ids("@readonly"), ["e"]);
  assert.deepEqual(ids("@tab:tools"), ["d"]);
  assert.deepEqual(ids("@modified f"), ["f"], "words and filters combine");
  assert.deepEqual([...parseQuery("  @ x @Env ").filters], ["env"]);
});

test("sections and the table of contents: tabs in OMP's order, ungrouped first, counts over what is shown, modified marks follow the view", () => {
  const entries = [entry("a", { group: "LSP", layers: { global: { state: "set", value: true }, project: { state: "unset" } } }), entry("b", { group: null }), entry("c", { group: "Editing" }), entry("d", { group: "Surprise" }), entry("e", { tab: "tools", group: null })];
  const { sections, toc } = layout(tabs, entries, "global");
  assert.deepEqual(sections[0]!.groups.map(section => [section.group, section.entries.map(item => item.id)]), [[null, ["b"]], ["Editing", ["c"]], ["LSP", ["a"]], ["Surprise", ["d"]]]);
  assert.deepEqual(toc.map(item => [item.tab.id, item.count, item.modified, item.groups.map(group => group.group)]), [["files", 4, true, ["Editing", "LSP", "Surprise"]], ["tools", 1, false, []]]);
  assert.equal(layout(tabs, entries, "project").toc[0]!.modified, false, "nothing is modified in the project layer");
  assert.deepEqual(layout(tabs, entries.filter(item => item.tab === "tools"), "global").toc.map(item => item.tab.id), ["tools"], "a tab with nothing shown is left out");
  assert.equal(anchorId("files", "Retry & Fallback"), "g-files-retry-fallback");
});

test("a view's control shows its own value, else the layer below it, never the value in force from a higher layer; Effective shows what OMP uses", () => {
  const set = entry("a", { layers: { global: { state: "set", value: true }, project: { state: "unset" } }, effective: { value: false, source: "project", layeredSource: "project" }, default: false });
  assert.deepEqual(shownValue(set, "global"), { value: true, inherited: false });
  assert.deepEqual(shownValue(set, "project"), { value: true, inherited: true }, "the project layer falls back to the global value");
  const fromProject = entry("b", { layers: { global: { state: "unset" }, project: { state: "set", value: true } }, effective: { value: true, source: "project", layeredSource: "project" }, default: false });
  assert.deepEqual(shownValue(fromProject, "global"), { value: false, inherited: true }, "the global layer falls back to OMP's default, not the project's value");
  assert.deepEqual(shownValue(fromProject, "effective"), { value: true, inherited: false });
  assert.equal(effectiveValue(fromProject), true);
  const fallback = entry("c", { effective: {} as never, default: true });
  assert.deepEqual(shownValue(fallback, "global"), { value: true, inherited: true });
  assert.equal(fileLayerFor(fromProject, "effective"), "project");
  assert.equal(fileLayerFor(fallback, "effective"), "global");
});

test("modified marks: a layer that sets the key, or OMP using something but the default", () => {
  const project = entry("a", { layers: { global: { state: "unset" }, project: { state: "set", value: true } }, effective: { value: true, source: "project", layeredSource: "project" } });
  assert.deepEqual([isModified(project, "global"), isModified(project, "project"), isModified(project, "effective")], [false, true, true]);
  assert.equal(modifiedCount([project, entry("b")], "project"), 1);
});

test("notes say what overrides what, what OMP uses, the file that wins, the default, the condition and the environment", () => {
  const texts = (item: ConfigEntry, view: "global" | "project" | "effective"): string[] => rowNotes(item, view).map(note => note.text);
  const both = entry("a", { layers: { global: { state: "set", value: true }, project: { state: "set", value: false } }, effective: { value: false, source: "project", layeredSource: "project" }, default: false,
    condition: { name: "vimModeEnabled", note: "Shown while Vim mode is enabled." } });
  assert.deepEqual(texts(both, "global"), ["In effect: off from the project config.", "The project config overrides this with off.", "Shown while Vim mode is enabled.", "Default: off"]);
  assert.deepEqual(texts(both, "project"), ["Also set in the global config: on.", "Shown while Vim mode is enabled.", "Default: off"]);
  assert.deepEqual(texts(both, "effective").slice(0, 1), ["Comes from the project config."]);
  const shadowed = entry("b", { projectOther: { file: ".claude/settings.json", shadows: true } });
  assert.match(texts(shadowed, "project")[0]!, /\.claude\/settings\.json also sets this and OMP merges it over \.omp\/config\.yml, so a value saved to the project config has no effect\./);
  assert.equal(rowNotes(shadowed, "project")[0]!.tone, "warning");
  assert.match(texts(entry("c", { projectOther: { file: ".omp/settings.json", shadows: false } }), "global").join(" "), /The project value comes from \.omp\/settings\.json/);
  const env = entry("d", { env: { name: "PI_X", present: true, active: true, fallback: false } });
  assert.deepEqual(rowNotes(env, "global").filter(note => note.tone === "env").map(note => note.text), ["Overridden by $PI_X"]);
  assert.match(texts(entry("e", { env: { name: "PI_Y", present: true, active: false, fallback: true } }), "global").join(" "), /\$PI_Y is set but a configured layer wins/);
  assert.equal(rowNotes(entry("f", { env: { name: "PI_Z", present: false, active: false, fallback: false } }), "global").some(note => note.text.includes("PI_Z")), false, "an unset variable is not noise");
  const secret = entry("g", { control: null, readOnly: { reason: "secret", note: "" }, layers: { global: { state: "set" }, project: { state: "unset" } }, writable: { global: false, project: false } });
  assert.equal(rowNotes(secret, "global").some(note => note.text.startsWith("Default")), false);
  const invalid = entry("h", { layers: { global: { state: "invalid", summary: "x" }, project: { state: "unset" } } });
  assert.equal(rowNotes(invalid, "global")[0]!.tone, "error");
});

test("search words are marked case-insensitively, overlapping words merge", () => {
  assert.deepEqual(highlightParts("Format on Write", ["format", "write"]), [{ text: "Format", match: true }, { text: " on ", match: false }, { text: "Write", match: true }]);
  assert.deepEqual(highlightParts("abc", []), [{ text: "abc", match: false }]);
  assert.deepEqual(highlightParts("abcd", ["abc", "bcd"]), [{ text: "abcd", match: true }]);
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
