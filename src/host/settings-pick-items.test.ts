import assert from "node:assert/strict";
import { test } from "node:test";
import { chainKeyEntries, modelPickEntries, roleChange, thinkingPickEntries } from "./settings-pick-items.ts";
import type { PickEntry, PickSnapshot } from "./settings-pick-items.ts";

const model = (provider: string, id: string, extra: Record<string, unknown> = {}) => ({
  provider, id, name: id.toUpperCase(), kind: "chat", available: true, reasoning: true, efforts: ["low", "high"], recent: -1, contextWindow: 200_000, ...extra,
});
const snapshot: PickSnapshot = {
  models: [
    model("zeta", "z-1"), model("alpha", "a-2"), model("alpha", "a-10"), model("alpha", "a-1", { recent: 0 }),
    model("beta", "b-1"), model("locked", "l-1", { available: false }), model("alpha", "img", { kind: "image" }),
  ],
  roles: [
    { id: "default", name: "Default", section: "chat", source: "global", selector: "beta/b-1:high", resolved: "beta/b-1", thinking: "high", accepts: ["zeta/z-1", "alpha/a-2", "alpha/a-10", "alpha/a-1", "beta/b-1"], defaults: [] },
    { id: "smol", name: "Smol", section: "chat", source: "global", selector: "beta/b-1", resolved: "beta/b-1", accepts: ["zeta/z-1", "alpha/a-2", "alpha/a-10", "alpha/a-1", "beta/b-1"], defaults: [] },
    { id: "image", name: "Image", section: "kind", source: "default", accepts: ["alpha/img"], defaults: [] },
  ],
  providers: [{ id: "zeta", status: "available", available: true }, { id: "alpha", status: "available", available: true }, { id: "beta", status: "available", available: true }, { id: "locked", status: "locked", available: false }],
  effective: { modelProviderOrder: ["zeta"] },
};
const rows = (entries: readonly PickEntry[]): string[] => entries.map(entry => "separator" in entry ? `-- ${entry.separator}` : entry.value);

test("role models: models in use lead, then providers by modelProviderOrder and name, recent first, newest versions next", () => {
  const entries = modelPickEntries({ purpose: "role", snapshot, role: "default", current: "beta/b-1:high", showUnavailable: false });
  assert.deepEqual(rows(entries), ["-- Used by roles", "beta/b-1", "-- zeta", "zeta/z-1", "-- alpha", "alpha/a-1", "alpha/a-10", "alpha/a-2"]);
  const current = entries.find(entry => !("separator" in entry) && entry.current);
  assert.ok(current && !("separator" in current) && current.label === "$(check) beta/b-1", "the current model is checked whatever its thinking suffix");
  assert.ok(current && !("separator" in current) && current.detail?.includes("default, smol"), "rows name the roles using the model");
  assert.ok(current && !("separator" in current) && current.description?.includes("200K context"));
});

test("a role offers only models it accepts, Automatic only when the scope has an assignment, and unavailable ones behind the toggle", () => {
  assert.deepEqual(rows(modelPickEntries({ purpose: "role", snapshot, role: "image", showUnavailable: false })), ["-- alpha", "alpha/img"]);
  const cleared = modelPickEntries({ purpose: "role", snapshot, role: "smol", clearable: true, showUnavailable: false });
  assert.equal(rows(cleared)[0], "", "Automatic clears the assignment");
  const shown = modelPickEntries({ purpose: "role", snapshot, role: "smol", showUnavailable: true });
  assert.deepEqual(rows(shown).slice(-2), ["-- locked — needs login", "locked/l-1"], "locked providers follow usable ones and say why");
  const locked = shown.at(-1)!;
  assert.ok(!("separator" in locked) && !locked.available && locked.detail?.includes("$(lock)"));
});

test("agent overrides offer @role references before models and leave out entries already in the list", () => {
  const entries = rows(modelPickEntries({ purpose: "agent-override", snapshot, exclude: ["@smol", "zeta/z-1"], showUnavailable: false }));
  assert.deepEqual(entries.slice(0, 3), ["-- Roles", "@default", "@image"]);
  assert.ok(!entries.includes("@smol") && !entries.includes("zeta/z-1"));
  assert.ok(!entries.includes("-- zeta"), "a provider group emptied by exclusions loses its separator");
});

test("prewalk and advisor start with the agent default and check the current pattern", () => {
  const prewalk = modelPickEntries({ purpose: "prewalk", snapshot, current: "on", showUnavailable: false });
  const first = prewalk[0]!;
  assert.ok(!("separator" in first) && first.value === "on" && first.current && first.description?.includes("@smol"));
  const advisor = modelPickEntries({ purpose: "advisor", snapshot, current: "@smol", showUnavailable: false });
  const head = advisor[0]!;
  assert.ok(!("separator" in head) && head.description?.includes("@advisor") && !head.current);
  assert.ok(advisor.some(entry => !("separator" in entry) && entry.value === "@smol" && entry.current));
});

test("fallback entries add provider wildcards and no role references", () => {
  const entries = rows(modelPickEntries({ purpose: "fallback-entry", snapshot, showUnavailable: false }));
  assert.ok(!entries.some(value => value.startsWith("@")));
  assert.deepEqual(entries.slice(-4), ["-- Same model on another provider", "zeta/*", "alpha/*", "beta/*"]);
  assert.ok(rows(modelPickEntries({ purpose: "fallback-entry", snapshot, showUnavailable: true })).includes("locked/*"));
});

test("chain keys are roles, provider wildcards and exact models OMP accepts, without configured keys or a bare star", () => {
  const entries = rows(chainKeyEntries(snapshot, ["default", "alpha/*", "beta/b-1"]));
  assert.ok(!entries.includes("*"), "OMP treats a bare * key as a role name that matches nothing");
  assert.ok(!entries.includes("default") && !entries.includes("alpha/*") && !entries.includes("beta/b-1"));
  assert.deepEqual(entries.slice(0, 3), ["-- Roles", "smol", "image"]);
  assert.ok(entries.includes("locked/*") && entries.includes("zeta/z-1"));
});

test("thinking offers inherit, off, auto, then the model's efforts, and roles encode it as OMP does", () => {
  const entries = thinkingPickEntries(["low", "high"], "high");
  assert.deepEqual(rows(entries), ["inherit", "off", "auto", "low", "high"]);
  assert.ok(entries.every(entry => !("separator" in entry) && entry.description));
  assert.deepEqual(roleChange("smol", "p/m", "high", "global"), { edits: [{ path: ["modelRoles", "smol"], value: "p/m:high" }] });
  assert.deepEqual(roleChange("smol", "p/m:low", "inherit", "global"), { edits: [{ path: ["modelRoles", "smol"], value: "p/m" }] });
  assert.deepEqual(roleChange("smol", "p/m", "auto", "global"), { edits: [{ path: ["modelRoles", "smol"], value: "p/m:auto" }] });
  assert.deepEqual(roleChange("default", "p/m:high", "auto", "project"), { edits: [{ path: ["modelRoles", "default"], value: "p/m" }], thinking: "auto" });
  assert.deepEqual(roleChange("smol", "p/m", undefined, "global"), { edits: [{ path: ["modelRoles", "smol"], value: "p/m" }] }, "a model without thinking levels is stored bare");
  assert.deepEqual(roleChange("smol", "", undefined, "project"), { edits: [{ path: ["modelRoles", "smol"], value: null }] });
  assert.deepEqual(roleChange("smol", "", undefined, "global"), { edits: [{ path: ["modelRoles", "smol"] }] });
});
