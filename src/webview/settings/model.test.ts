import assert from "node:assert/strict";
import { test } from "node:test";
import { filteredModels, roleChange, lines } from "./model.ts";

test("default auto thinking is a global setting while nondefault efforts stay encoded in selectors", () => {
  assert.deepEqual(roleChange("default", "provider/model:high", "auto", "project"), { edits: [{ path: ["modelRoles", "default"], value: "provider/model" }], thinking: "auto" });
  assert.deepEqual(roleChange("smol", "provider/model:low", "high", "global"), { edits: [{ path: ["modelRoles", "smol"], value: "provider/model:high" }] });
  assert.deepEqual(roleChange("smol", "", "", "project"), { edits: [{ path: ["modelRoles", "smol"], value: null }] });
  assert.deepEqual(roleChange("smol", "", "", "global"), { edits: [{ path: ["modelRoles", "smol"] }] });
  assert.deepEqual(roleChange("smol", "provider/model:high", "inherit", "global"), { edits: [{ path: ["modelRoles", "smol"], value: "provider/model" }] });
  assert.deepEqual(roleChange("default", "provider/model:high", "inherit", "project"), { edits: [{ path: ["modelRoles", "default"], value: "provider/model" }] });
});
test("ordered pattern lists and model search preserve their observable semantics", () => {
  assert.deepEqual(lines(" provider/a\r\n\n@smol\nprovider/b:high "), ["provider/a", "@smol", "provider/b:high"]);
  const models = [
    { provider: "b", id: "one", name: "Vision", kind: "chat", available: true, reasoning: true, efforts: [], recent: 2 },
    { provider: "a", id: "two", name: "Picture", kind: "image", available: false, reasoning: false, efforts: [], recent: -1 },
    { provider: "a", id: "three", name: "Fast", kind: "chat", available: true, reasoning: true, efforts: [], recent: 0 },
  ];
  assert.deepEqual(filteredModels(models, "", "", "", true).map(model => model.id), ["three", "one"]);
  assert.deepEqual(filteredModels(models, "PICTURE", "a", "image", false).map(model => model.id), ["two"]);
  assert.equal(models[0]?.id, "one", "filtering never mutates the native catalogue");
});
