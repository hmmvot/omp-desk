import assert from "node:assert/strict";
import { test } from "node:test";
import { SettingsRefusal } from "./omp-settings-core.ts";
import { parseModelPickRequest, parseRoleAssignment } from "./settings-pick-requests.ts";

test("pick-model requests accept only list purposes with bounded current values and exclusions", () => {
  assert.deepEqual(parseModelPickRequest({ purpose: "fallback-entry" }), { purpose: "fallback-entry", exclude: [] });
  assert.deepEqual(parseModelPickRequest({ purpose: "agent-override", exclude: ["@smol", "p/m"] }), { purpose: "agent-override", exclude: ["@smol", "p/m"] });
  assert.deepEqual(parseModelPickRequest({ purpose: "prewalk", current: "on" }), { purpose: "prewalk", current: "on", exclude: [] });
  for (const raw of [{ purpose: "role" }, { purpose: "shell" }, {}, { purpose: "advisor", current: "" }, { purpose: "advisor", current: 3 },
    { purpose: "advisor", exclude: "p/m" }, { purpose: "advisor", exclude: [1] }, { purpose: "advisor", exclude: Array(101).fill("p/m") }, { purpose: "advisor", current: "x".repeat(513) }]) {
    assert.throws(() => parseModelPickRequest(raw), SettingsRefusal, JSON.stringify(raw).slice(0, 60));
  }
});

test("assign-role requests name a valid role, a write scope and a step; thinking needs a known role", () => {
  const roles = [{ id: "smol" }];
  assert.deepEqual(parseRoleAssignment({ role: "smol", scope: "global", step: "thinking" }, roles), { role: "smol", scope: "global", step: "thinking" });
  assert.deepEqual(parseRoleAssignment({ role: "my-role", scope: "project", step: "model" }, roles), { role: "my-role", scope: "project", step: "model" }, "a new custom role is assigned by choosing its model");
  for (const raw of [{ role: "my-role", scope: "global", step: "thinking" }, { role: "1bad", scope: "global", step: "model" }, { role: "smol", scope: "everywhere", step: "model" }, { role: "smol", scope: "global", step: "save" }]) {
    assert.throws(() => parseRoleAssignment(raw, roles), SettingsRefusal);
  }
});
