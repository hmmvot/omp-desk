import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SettingsRefusal } from "../omp-settings-core.ts";
import { createInventoryRuntime, parseSnapshot } from "./inventory-runtime.ts";
import type { InventoryRuntimeDeps, WorkerEnvironment } from "./inventory-runtime.ts";

const environment: WorkerEnvironment = { bun: "bun", packageRoot: "C:/omp", helperPath: "C:/worker.mjs" };
const row = (overrides: Record<string, unknown> = {}) => ({ kind: "skill", name: "a", description: null, path: "C:/a/SKILL.md", provider: "native", providerName: "OMP", level: "user", state: "active", shadowed: false,
	disabledReason: null, detail: null, toolPrefix: null, runtimeName: "a", sources: [], toggle: { mechanism: "disabledExtensions", refusal: null }, ...overrides });
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
			receipt([row({ sources: [{ path: null, providerName: "x", level: "project", role: "merges" }] })]), receipt([row({ sources: "x" })]), receipt([row({ sources: new Array(33).fill({ path: null, providerName: "x", level: "project", role: "defines" }) })]),
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
	it("reports a switch result only for a boolean `changed` with well-formed write receipts and shows refusals verbatim, other failures generically", async () => {
		const request = { cwd: "C:/", profile: "default", scope: "global" as const, kind: "skill" as const, name: "a", enabled: false };
		const writes = [{ file: "C:/u/.omp/agent/config.yml", what: "disabledExtensions + skill:a" }, { file: null, what: "plugin p disabled" }];
		assert.deepEqual(await runtimeWith(async input => { assert.deepEqual(input.request, { action: "toggle", scope: "global", kind: "skill", name: "a", enabled: false }); return { changed: true, writes }; }).toggle(request), { ok: true, changed: true, writes });
		assert.deepEqual(await runtimeWith(async () => ({ changed: false, writes: [] })).toggle(request), { ok: true, changed: false, writes: [] });
		for (const odd of [{ changed: "yes", writes: [] }, { changed: true }, { changed: true, writes: [{ file: 3, what: "x" }] }, { changed: true, writes: [{ file: "f" }] }, { changed: false, writes: [{ file: "f", what: "x" }] }, { changed: true, writes: new Array(9).fill({ file: null, what: "x" }) }]) {
			assert.equal((await runtimeWith(async () => odd).toggle(request)).ok, false, JSON.stringify(odd).slice(0, 60));
		}
		assert.deepEqual(await runtimeWith(async () => { throw new SettingsRefusal("OMP no longer lists this item."); }).toggle(request), { ok: false, message: "OMP no longer lists this item." });
		const crashed = await runtimeWith(async () => { throw new Error("EPERM C:/Users/x/.omp/agent/config.yml"); }).toggle(request);
		assert.equal(crashed.ok, false);
		assert.doesNotMatch(crashed.ok ? "" : crashed.message, /EPERM|config\.yml/);
	});
});
