import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import * as vm from "node:vm";
import ts from "typescript";
import { displaySettings, editorSettings, mergeConfigEdits, parseAgentSpec, withRollbackJournalHeader } from "./omp-settings-core.ts";
import { nativeSettingsCommand } from "../chat/settings-command.ts";

test("a WAL-mode database image is switched in place to the rollback-journal header so it can be deserialized", () => {
  const wal = new Uint8Array(4096); wal.set(new TextEncoder().encode("SQLite format 3\0")); wal[18] = 2; wal[19] = 2; wal[20] = 7;
  assert.equal(withRollbackJournalHeader(wal), wal, "the owned serialized buffer is reused, not copied");
  assert.deepEqual([wal[18], wal[19], wal[20]], [1, 1, 7]);
  const legacy = new Uint8Array(4096); legacy[18] = 1; legacy[19] = 1;
  assert.deepEqual([...withRollbackJournalHeader(legacy).subarray(18, 20)], [1, 1]);
  const short = Uint8Array.of(...new Array(20).fill(2));
  assert.deepEqual([...withRollbackJournalHeader(short)], new Array(20).fill(2), "a truncated image is left for SQLite to reject");
});

test("record-entry edits merge external siblings and preserve unknown configuration without copying baseline data", () => {
  const baseline = { modelRoles: { default: "provider/a", smol: "provider/b" }, unknown: { keep: 1 } };
  const current = { ...baseline, modelRoles: { ...baseline.modelRoles, smol: "provider/c" }, unknown: { keep: 2, another: true } };
  const result = mergeConfigEdits(current, editorSettings(baseline), [{ path: ["modelRoles", "default"], value: "provider/d:high" }]);
  assert.deepEqual(result, { modelRoles: { default: "provider/d:high", smol: "provider/c" }, unknown: { keep: 2, another: true } });
  assert.equal(current.modelRoles.default, "provider/a");
});
test("overlapping record and whole-array changes refuse rather than clobber", () => {
  assert.throws(() => mergeConfigEdits({ modelRoles: { default: "changed" } }, { modelRoles: { default: "before" } }, [{ path: ["modelRoles", "default"], value: "mine" }]));
  assert.throws(() => mergeConfigEdits({ cycleOrder: ["default", "slow"] }, { cycleOrder: ["default"] }, [{ path: ["cycleOrder"], value: ["smol"] }]));
});
test("global deletion and project tombstones affect only the selected role", () => {
  const baseline = { modelRoles: { default: "provider/a", smol: "provider/b" } };
  assert.deepEqual(mergeConfigEdits(baseline, baseline, [{ path: ["modelRoles", "smol"] }]), { modelRoles: { default: "provider/a" } });
  assert.deepEqual(mergeConfigEdits(baseline, baseline, [{ path: ["modelRoles", "smol"], value: null }]), { modelRoles: { default: "provider/a", smol: null } });
});
test("read-only preferences, whole records, unknown settings and prototype paths cannot be written", () => {
  for (const path of [["enabledModels"], ["modelRoleStorage"], ["modelRoles"], ["task", "enable"], ["modelRoles", "__proto__"], ["constructor", "x"]]) assert.throws(() => mergeConfigEdits({}, {}, [{ path, value: [] }]));
  assert.throws(() => mergeConfigEdits({ task: false }, {}, [{ path: ["task", "agentPrewalk", "scout"], value: "on" }]));
});
test("display projection excludes unrelated config and nested unknown preset or path-scope data", () => {
  const data = { apiKey: "secret", modelPresets: { work: { modelRoles: { default: "p/m" }, defaultThinkingLevel: "high", private: "secret" } }, enabledModels: [{ path: "src/**", models: ["p/m"], credential: "secret" }] };
  const display = displaySettings(data);
  assert.equal(JSON.stringify(display).includes("secret"), false);
  assert.deepEqual(display.enabledModels, [{ path: "src/**", models: ["p/m"] }]);
  assert.equal((editorSettings(data).modelPresets as typeof data.modelPresets).work.private, "secret", "hidden baseline must retain full entries");
});
test("native settings slash interception is exact while model selector arguments pass through", () => {
  for (const text of ["/model", "/models", " /MODELS \n"]) assert.equal(nativeSettingsCommand(text), "models");
  for (const text of ["/agents", "/agents ignored", "/agents\nignored\narguments"]) assert.equal(nativeSettingsCommand(text), "agents");
  for (const text of ["/model p/m", "/models p/m", "explain /agents", "/agents/other", "/modeling"]) assert.equal(nativeSettingsCommand(text), null);
});
const nativeSource = path.join(homedir(), ".bun", "install", "global", "node_modules", "@oh-my-pi", "pi-tui", "src", "overlays", "agents-hub.ts");
test("generated-spec adapter matches the actual installed native private parser behavior", { skip: !existsSync(nativeSource) }, () => {
  const source = ts.createSourceFile(nativeSource, readFileSync(nativeSource, "utf8"), ts.ScriptTarget.Latest, true);
  const selected = source.statements.filter(node => ts.isFunctionDeclaration(node) && ["extractJsonObject", "parseGeneratedAgentSpec"].includes(node.name?.text ?? "")
    || ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === "IDENTIFIER_PATTERN"));
  assert.equal(selected.length, 3, "installed native parser contract changed");
  const code = ts.transpileModule(selected.map(node => node.getText(source)).join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  // OMP 18.8 exports the parser; the transpiled export assignment needs an `exports` binding.
  const native = vm.runInNewContext(`${code}\nparseGeneratedAgentSpec`, { exports: {} }) as (raw: string) => unknown;
  const valid = { identifier: "focused-helper", whenToUse: "Use this agent when reviewing changes", systemPrompt: "Review the changes." };
  const fencedPrompt = { ...valid, systemPrompt: "Answer with:\n\u0060\u0060\u0060json\n{\"ok\":true}\n\u0060\u0060\u0060" };
  const cases = [JSON.stringify(valid), `prose ${JSON.stringify(valid)} after`, `\u0060\u0060\u0060json\n${JSON.stringify(valid)}\n\u0060\u0060\u0060`, `\u0060\u0060\u0060json\n\u0060\u0060\u0060 ${JSON.stringify(valid)}`, JSON.stringify(fencedPrompt), ` ${JSON.stringify(fencedPrompt, null, 2)} `, "null", "[]", "{}", "bad JSON", ...["single", "UPPER-helper", "one-two-three-four-five-six-seven"].map(identifier => JSON.stringify({ ...valid, identifier })), JSON.stringify({ ...valid, whenToUse: "Wrong prefix" }), JSON.stringify({ ...valid, systemPrompt: " " }), JSON.stringify({ ...valid, identifier: " focused-helper ", systemPrompt: " text " })];
  const outcome = (parse: (raw: string) => unknown, raw: string): string => { try { return JSON.stringify({ ok: true, value: parse(raw) }); } catch { return JSON.stringify({ ok: false }); } };
  for (const raw of cases) assert.equal(outcome(parseAgentSpec, raw), outcome(native, raw));
});
test("a bare generated spec keeps code fences inside its strings, as OMP 18.8's parser does", () => {
  const systemPrompt = "Reply with:\n\u0060\u0060\u0060json\n{\"ok\":true}\n\u0060\u0060\u0060";
  const spec = { identifier: "fence-writer", whenToUse: "Use this agent when a reply needs a fenced example", systemPrompt };
  assert.deepEqual(parseAgentSpec(JSON.stringify(spec)), spec);
  assert.deepEqual(parseAgentSpec(`\u0060\u0060\u0060json\n${JSON.stringify({ ...spec, systemPrompt: "Plain." })}\n\u0060\u0060\u0060`), { ...spec, systemPrompt: "Plain." }, "a fenced reply is still unwrapped");
});
