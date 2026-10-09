import assert from "node:assert/strict";
import { test } from "node:test";
import { disabledAgentsAfterToggle, entryStatus, filteredModels, moveEntry, patternList, withEntry, withoutEntry } from "./model.ts";

const models = [
  { provider: "b", id: "one", name: "Vision", kind: "chat", available: true, reasoning: true, efforts: [], recent: 2 },
  { provider: "a", id: "two", name: "Picture", kind: "image", available: false, reasoning: false, efforts: [], recent: -1 },
  { provider: "a", id: "three", name: "Fast", kind: "chat", available: true, reasoning: true, efforts: [], recent: 0 },
];

test("stored lists read as OMP reads pattern lists: arrays and comma-separated strings", () => {
  assert.deepEqual(patternList(["provider/a", " @smol , provider/b:high "]), ["provider/a", "@smol", "provider/b:high"]);
  assert.deepEqual(patternList("provider/a, @smol"), ["provider/a", "@smol"]);
  assert.deepEqual(patternList(undefined), []);
  assert.deepEqual(patternList({ not: "a list" }), []);
});

test("list editing moves within bounds, removes by position and never duplicates", () => {
  const list = ["a/one", "@smol", "c/two"];
  assert.deepEqual(moveEntry(list, 2, -1), ["a/one", "c/two", "@smol"]);
  assert.deepEqual(moveEntry(list, 0, 1), ["@smol", "a/one", "c/two"]);
  assert.deepEqual(moveEntry(list, 0, -1), list, "moving the first entry up is a no-op");
  assert.deepEqual(moveEntry(list, 2, 1), list, "moving the last entry down is a no-op");
  assert.deepEqual(withoutEntry(list, 1), ["a/one", "c/two"]);
  assert.deepEqual(withEntry(list, "x/three"), [...list, "x/three"]);
  assert.deepEqual(withEntry(list, "@smol"), list, "an entry already in the list is not added twice");
  assert.deepEqual(list, ["a/one", "@smol", "c/two"], "editing never mutates the original list");
});

test("entries describe what they resolve to now", () => {
  const snapshot = {
    models,
    roles: [{ id: "smol", name: "smol", section: "chat", source: "global", selector: "a/three", resolved: "a/three", accepts: [], defaults: [] },
      { id: "slow", name: "slow", section: "chat", source: "global", selector: "z/gone", accepts: [], defaults: [] }],
    providers: [{ id: "a", status: "available", available: true }, { id: "z", status: "locked", available: false }],
  };
  assert.deepEqual(entryStatus("@smol", snapshot), { text: "→ a/three", ok: true });
  assert.deepEqual(entryStatus("@slow", snapshot), { text: "role has no available model", ok: false });
  assert.deepEqual(entryStatus("@nope", snapshot), { text: "unknown role", ok: false });
  assert.deepEqual(entryStatus("a/*", snapshot), { text: "any model on this provider", ok: true });
  assert.deepEqual(entryStatus("z/*", snapshot), { text: "needs login", ok: false });
  assert.deepEqual(entryStatus("a/three:high", snapshot), { text: "available · thinking high", ok: true });
  assert.deepEqual(entryStatus("a/two", snapshot), { text: "needs login", ok: false });
  assert.deepEqual(entryStatus("a/missing", snapshot), { text: "not in the catalogue", ok: false });
  assert.deepEqual(entryStatus("claude-*", snapshot), { text: "pattern", ok: true });
});

test("model search preserves its observable semantics", () => {
  assert.deepEqual(filteredModels(models, "", "", "", true, false).map(model => model.id), ["three", "one"]);
  assert.deepEqual(filteredModels(models, "PICTURE", "a", "image", false, false).map(model => model.id), ["two"]);
  assert.deepEqual(filteredModels(models, "", "", "", false, false).map(model => model.id), ["three", "one", "two"], "usable models lead the unfiltered catalogue");
  assert.deepEqual(filteredModels(models, "", "", "", false, true).map(model => model.id), ["three", "one"], "the available-only default hides locked models");
  assert.equal(models[0]?.id, "one", "filtering never mutates the native catalogue");
});

test("agent toggles rewrite only the global disabled list, never copying other layers", () => {
  assert.deepEqual(disabledAgentsAfterToggle(undefined, "reviewer", false), ["reviewer"]);
  assert.deepEqual(disabledAgentsAfterToggle(["explore", "reviewer"], "reviewer", true), ["explore"]);
  assert.deepEqual(disabledAgentsAfterToggle(["explore"], "reviewer", false), ["explore", "reviewer"]);
  assert.deepEqual(disabledAgentsAfterToggle(["reviewer"], "reviewer", false), ["reviewer"], "a repeated disable stays a single entry");
});
