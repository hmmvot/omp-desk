import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SettingsRefusal } from "../omp-settings-core.ts";
import { createInventoryRuntime, parseSnapshot } from "./inventory-runtime.ts";
import type { InventoryRuntimeDeps, WorkerEnvironment } from "./inventory-runtime.ts";

const environment: WorkerEnvironment = { bun: "bun", packageRoot: "C:/omp", helperPath: "C:/worker.mjs" };
const row = (overrides: Record<string, unknown> = {}) => ({ kind: "skill", name: "a", description: null, path: "C:/a/SKILL.md", provider: "native", providerName: "OMP", level: "user", state: "active", shadowed: false,
	disabledReason: null, detail: null, toolPrefix: null, runtimeName: "a", toggle: { mechanism: "disabledExtensions", refusal: null }, ...overrides });
const receipt = (rows: unknown[] = [row()], extra: Record<string, unknown> = {}) => ({ rows, cwd: "C:/", profile: "default", projectOverridesDisabledExtensions: false, incomplete: [], disabledProviders: [], ...extra });

function runtimeWith(run: InventoryRuntimeDeps["run"], env: WorkerEnvironment | { readonly unavailable: string } = environment) {
	return createInventoryRuntime({ environment: async () => env, run });
}

describe("inventory receipt validation", () => {
	it("accepts a well-formed receipt and keeps every field", () => {
		const snapshot = parseSnapshot(receipt([row(), row({ name: "b", kind: "mcp", toolPrefix: "mcp__b_", toggle: { mechanism: "mcp", refusal: null } })], { incomplete: ["skills"] }));
		assert.equal(snapshot?.rows.length, 2);
		assert.deepEqual(snapshot?.incomplete, ["skills"]);
		assert.equal(snapshot?.rows[1]?.toolPrefix, "mcp__b_");
	});
	it("rejects anything outside the contract rather than rendering it", () => {
		for (const bad of [
			null, "text", { ...receipt(), rows: "x" }, receipt([row({ kind: "evil" })]), receipt([row({ level: "root" })]), receipt([row({ state: "weird" })]), receipt([row({ name: "" })]),
			receipt([row({ shadowed: "yes" })]), receipt([row({ toggle: { mechanism: "shell", refusal: null } })]), receipt([row({ toggle: null })]), receipt([row({ path: "x".repeat(5000) })]),
			receipt([row()], { incomplete: ["bogus"] }), receipt([row()], { projectOverridesDisabledExtensions: "no" }), receipt(new Array(5001).fill(row())), receipt([null]),
		]) assert.equal(parseSnapshot(bad), null, JSON.stringify(bad)?.slice(0, 80));
	});
});

describe("inventory runtime", () => {
	it("returns the parsed snapshot and passes the scope, folder and profile to the worker", async () => {
		const calls: unknown[] = [];
		const runtime = runtimeWith(async input => { calls.push([input.cwd, input.profile, input.request]); return receipt(); });
		const result = await runtime.read({ cwd: "D:/p", profile: "work", scope: "session" });
		assert.ok("rows" in result);
		assert.deepEqual(calls, [["D:/p", "work", { action: "read", scope: "session" }]]);
	});
	it("passes through an unavailable environment and a refusal sentence, and hides every other failure", async () => {
		assert.deepEqual(await runtimeWith(async () => receipt(), { unavailable: "No Bun." }).read({ cwd: "C:/", profile: "default", scope: "global" }), { unavailable: "No Bun." });
		const refused = await runtimeWith(async () => { throw new SettingsRefusal("OMP found project configuration."); }).read({ cwd: "C:/", profile: "default", scope: "global" });
		assert.deepEqual(refused, { unavailable: "OMP found project configuration." });
		const crashed = await runtimeWith(async () => { throw new Error("spawn C:/secret/token EACCES"); }).read({ cwd: "C:/", profile: "default", scope: "global" });
		assert.ok("unavailable" in crashed);
		assert.doesNotMatch(crashed.unavailable, /secret|EACCES/);
		const garbage = await runtimeWith(async () => ({ rows: 1 })).read({ cwd: "C:/", profile: "default", scope: "global" });
		assert.match("unavailable" in garbage ? garbage.unavailable : "", /unrecognised/);
	});
	it("reports a switch result only for a boolean `changed` and shows refusals verbatim, other failures generically", async () => {
		const request = { cwd: "C:/", profile: "default", scope: "global" as const, kind: "skill" as const, name: "a", enabled: false };
		assert.deepEqual(await runtimeWith(async input => { assert.deepEqual(input.request, { action: "toggle", scope: "global", kind: "skill", name: "a", enabled: false }); return { changed: true }; }).toggle(request), { ok: true, changed: true });
		const odd = await runtimeWith(async () => ({ changed: "yes" })).toggle(request);
		assert.equal(odd.ok, false);
		assert.deepEqual(await runtimeWith(async () => { throw new SettingsRefusal("OMP no longer lists this item."); }).toggle(request), { ok: false, message: "OMP no longer lists this item." });
		const crashed = await runtimeWith(async () => { throw new Error("EPERM C:/Users/x/.omp/agent/config.yml"); }).toggle(request);
		assert.equal(crashed.ok, false);
		assert.doesNotMatch(crashed.ok ? "" : crashed.message, /EPERM|config\.yml/);
	});
});
