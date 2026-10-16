import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { runSettingsWorker } from "../host/omp-settings-worker.ts";
import type { ConfigChange, ConfigEntry, ConfigLayer, ConfigReceipt } from "../protocol/omp-config-model.ts";
import type { ConfigRecord } from "../protocol/settings-model.ts";

/** The OMP Settings editor's worker against the installed OMP and a scratch agent directory and project. */
const packageRoot = process.env.OMP_SETTINGS_TEST_PACKAGE_ROOT ?? path.join(os.homedir(), ".bun", "install", "global", "node_modules", "@oh-my-pi", "pi-coding-agent");
const bunPath = process.env.OMP_SETTINGS_TEST_BUN ?? path.join(os.homedir(), ".bun", "bin", process.platform === "win32" ? "bun.exe" : "bun");
const ompPath = path.join(os.homedir(), ".bun", "bin", process.platform === "win32" ? "omp.exe" : "omp");
const helperPath = fileURLToPath(new URL("./config-settings-worker.ts", import.meta.url));
const available = existsSync(packageRoot) && existsSync(bunPath);
const SECRET = "GLOBAL-SECRET-VALUE-123";

interface Rig { root: string; agent: string; cwd: string; globalFile: string; projectFile: string; env: NodeJS.ProcessEnv }
async function rig(): Promise<Rig> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-config-editor-"));
  const agent = path.join(root, "agent"); const cwd = path.join(root, "project");
  await fs.mkdir(agent, { recursive: true }); await fs.mkdir(path.join(cwd, ".omp"), { recursive: true });
  const globalFile = path.join(agent, "config.yml"); const projectFile = path.join(cwd, ".omp", "config.yml");
  await fs.writeFile(globalFile, `# kept comment\ntui:\n  vimMode: true\nlsp:\n  diagnosticsOnWrite: false\nunknownKey: keep\nmnemopi:\n  llmApiKey: ${SECRET}\n`);
  await fs.writeFile(projectFile, "lsp:\n  diagnosticsOnWrite: true\nprojUnknown: x\n");
  return { root, agent, cwd, globalFile, projectFile, env: { PI_CODING_AGENT_DIR: agent, PI_CONFIG_FILES: "", OMP_AUTH_BROKER_URL: "", OMP_AUTH_BROKER_TOKEN: "" } };
}
const call = (r: Rig, request: ConfigRecord, options: { packageRoot?: string; env?: NodeJS.ProcessEnv } = {}): Promise<unknown> =>
  runSettingsWorker({ bunPath, helperPath, packageRoot: options.packageRoot ?? packageRoot, cwd: r.cwd, profile: "default", request, env: { ...r.env, ...options.env } });
const read = async (r: Rig, env?: NodeJS.ProcessEnv): Promise<ConfigReceipt> => await call(r, { action: "read" }, { env }) as ConfigReceipt;
const entryOf = (receipt: ConfigReceipt, id: string): ConfigEntry => {
  const found = receipt.snapshot.entries.find(candidate => candidate.id === id);
  assert.ok(found, `${id} is in the snapshot`);
  return found;
};
/** Reads, then writes; returns the fresh receipt and whether the file changed. */
async function save(r: Rig, layer: ConfigLayer, changes: ConfigChange[]): Promise<{ changed: boolean; receipt: ConfigReceipt }> {
  const before = await read(r);
  const result = await call(r, { action: "write", scope: layer, changes, baseline: before.baselines[layer] }) as { saved: boolean; changed: boolean };
  assert.equal(result.saved, true);
  return { changed: result.changed, receipt: await read(r) };
}
const refused = async (promise: Promise<unknown>, pattern: RegExp): Promise<void> => { await assert.rejects(promise, error => error instanceof Error && pattern.test(error.message), String(pattern)); };
const ompGet = (r: Rig, key: string): string => spawnSync(ompPath, ["config", "get", key], { cwd: r.cwd, env: { ...process.env, ...r.env }, encoding: "utf8", timeout: 60_000 }).stdout.trim();

test("reads OMP's schema with layer values, sources and no credential, and never touches a file", { skip: !available, timeout: 120_000 }, async () => {
  const r = await rig();
  try {
    const before = await Promise.all([fs.readFile(r.globalFile, "utf8"), fs.readFile(r.projectFile, "utf8")]);
    const receipt = await read(r);
    assert.equal(receipt.snapshot.omp.version, JSON.parse(await fs.readFile(path.join(packageRoot, "package.json"), "utf8")).version);
    assert.deepEqual(receipt.snapshot.files, { global: { path: r.globalFile, exists: true }, project: { path: r.projectFile, exists: true, ancestorOmp: null } });
    assert.ok(receipt.snapshot.entries.length > 300 && receipt.snapshot.tabs.length === 10);
    const lsp = entryOf(receipt, "lsp.diagnosticsOnWrite");
    assert.deepEqual(lsp.layers, { global: { state: "set", value: false }, project: { state: "set", value: true } });
    assert.deepEqual(lsp.effective, { value: true, source: "project", layeredSource: "project" });
    assert.deepEqual(entryOf(receipt, "tui.vimMode").effective, { value: true, source: "global", layeredSource: "global" });
    assert.equal(entryOf(receipt, "tui.vimModeDisplay").visible, true, "visible while Vim mode is on");
    // secret exclusion: neither the page-bound snapshot nor the host-held baselines carry the credential
    const secret = entryOf(receipt, "mnemopi.llmApiKey");
    assert.equal(secret.readOnly?.reason, "secret");
    assert.equal(secret.layers.global.state, "set");
    assert.ok(!JSON.stringify(receipt).includes(SECRET), "the credential value is nowhere in the worker's output");
    assert.equal(JSON.stringify(receipt.baselines).includes("unknownKey"), false, "baselines carry registered settings only");
    assert.deepEqual(await Promise.all([fs.readFile(r.globalFile, "utf8"), fs.readFile(r.projectFile, "utf8")]), before, "reading changes no file");
  } finally { await fs.rm(r.root, { recursive: true, force: true }); }
});

test("an environment variable that overrides a setting is reported as the source while the layers keep their values", { skip: !available, timeout: 120_000 }, async () => {
  const r = await rig();
  try {
    const plain = await read(r);
    const target = plain.snapshot.entries.find(entry => entry.env !== null && !entry.env.fallback && entry.control?.kind === "boolean" && entry.visible);
    assert.ok(target?.env, "OMP has a boolean setting with an overriding variable");
    const overridden = await read(r, { [target.env.name]: "1" });
    const entry = entryOf(overridden, target.id);
    assert.deepEqual([entry.effective.source, entry.env?.present, entry.env?.active], ["env", true, true]);
    assert.equal(entry.effective.value, target.effective.value, "the value shown is the layers', not the environment's");
    assert.equal(entry.effective.layeredSource, target.effective.source);
    assert.match(entry.description, new RegExp(`\\$${target.env.name} overrides this setting while it is set\\.`));
  } finally { await fs.rm(r.root, { recursive: true, force: true }); }
});

test("global and project writes: boolean, enum and number, Reset, unknown keys and comments kept, OMP's own CLI agrees", { skip: !available, timeout: 240_000 }, async () => {
  const r = await rig();
  try {
    let done = await save(r, "global", [{ op: "set", id: "lsp.formatOnWrite", layer: "global", value: true }]);
    assert.equal(done.changed, true);
    assert.deepEqual(entryOf(done.receipt, "lsp.formatOnWrite").layers.global, { state: "set", value: true });
    done = await save(r, "global", [{ op: "set", id: "tui.vimModeDisplay", layer: "global", value: "icon" }]);
    assert.equal(entryOf(done.receipt, "tui.vimModeDisplay").layers.global.value, "icon");
    done = await save(r, "global", [{ op: "set", id: "compaction.thresholdPercent", layer: "global", value: 40 }]);
    assert.equal(entryOf(done.receipt, "compaction.thresholdPercent").layers.global.value, 40);
    done = await save(r, "global", [{ op: "set", id: "compaction.thresholdTokens", layer: "global", value: -1 }]);
    assert.equal(entryOf(done.receipt, "compaction.thresholdTokens").layers.global.value, -1, "OMP's `default` choice is stored as -1");
    done = await save(r, "global", [{ op: "set", id: "compaction.methodOrder", layer: "global", value: ["handoff", "soft"] }]);
    assert.deepEqual(entryOf(done.receipt, "compaction.methodOrder").layers.global.value, ["handoff", "soft"]);
    const globalText = await fs.readFile(r.globalFile, "utf8");
    assert.match(globalText, /unknownKey: keep/);
    assert.match(globalText, new RegExp(`llmApiKey: ${SECRET}`), "an unedited credential is carried through untouched");
    assert.match(globalText, /thresholdPercent: 40/);
    // OMP's own CLI reads the same values
    if (existsSync(ompPath)) {
      assert.equal(ompGet(r, "compaction.thresholdPercent"), "40");
      assert.equal(ompGet(r, "tui.vimModeDisplay"), "icon");
      assert.equal(ompGet(r, "lsp.formatOnWrite"), "true");
    }
    // project layer: set, shadow, Reset (with the emptied `lsp` mapping pruned, the unknown key kept)
    done = await save(r, "project", [{ op: "set", id: "tui.vimMode", layer: "project", value: false }]);
    assert.deepEqual(entryOf(done.receipt, "tui.vimMode").effective, { value: false, source: "project", layeredSource: "project" });
    assert.match(await fs.readFile(r.projectFile, "utf8"), /projUnknown: x/);
    if (existsSync(ompPath)) assert.equal(ompGet(r, "tui.vimMode"), "false", "OMP resolves the project layer over the global one");
    done = await save(r, "project", [{ op: "reset", id: "lsp.diagnosticsOnWrite", layer: "project" }]);
    assert.deepEqual(entryOf(done.receipt, "lsp.diagnosticsOnWrite").effective, { value: false, source: "global", layeredSource: "global" }, "after Reset the global layer shows through");
    const projectText = await fs.readFile(r.projectFile, "utf8");
    assert.ok(!/^lsp:/m.test(projectText), "the mapping Reset emptied is removed, as OMP's own unset does");
    assert.match(projectText, /projUnknown: x/);
    done = await save(r, "global", [{ op: "reset", id: "lsp.diagnosticsOnWrite", layer: "global" }]);
    assert.deepEqual(entryOf(done.receipt, "lsp.diagnosticsOnWrite").effective.source, "default");
    assert.ok(!/diagnosticsOnWrite/.test(await fs.readFile(r.globalFile, "utf8")));
    // a write that changes nothing never rewrites the file or strips its comments
    const stable = await fs.readFile(r.globalFile, "utf8");
    done = await save(r, "global", [{ op: "set", id: "compaction.thresholdPercent", layer: "global", value: 40 }]);
    assert.equal(done.changed, false);
    done = await save(r, "global", [{ op: "reset", id: "lsp.diagnosticsOnWrite", layer: "global" }]);
    assert.equal(done.changed, false);
    assert.equal(await fs.readFile(r.globalFile, "utf8"), stable);
  } finally { await fs.rm(r.root, { recursive: true, force: true }); }
});

test("a missing global or project config is created by the first write, without replacing anything", { skip: !available, timeout: 120_000 }, async () => {
  const r = await rig();
  try {
    await fs.rm(r.globalFile); await fs.rm(path.join(r.cwd, ".omp"), { recursive: true });
    const receipt = await read(r);
    assert.deepEqual([receipt.snapshot.files.global.exists, receipt.snapshot.files.project.exists], [false, false]);
    await call(r, { action: "write", scope: "global", baseline: receipt.baselines.global, changes: [{ op: "set", id: "lsp.formatOnWrite", layer: "global", value: true }] });
    assert.match(await fs.readFile(r.globalFile, "utf8"), /formatOnWrite: true/);
    await call(r, { action: "write", scope: "project", baseline: receipt.baselines.project, changes: [{ op: "set", id: "lsp.formatOnWrite", layer: "project", value: false }] });
    assert.match(await fs.readFile(r.projectFile, "utf8"), /formatOnWrite: false/);
    // the same stale "missing" baseline cannot overwrite what now exists
    await refused(call(r, { action: "write", scope: "project", baseline: receipt.baselines.project, changes: [{ op: "set", id: "lsp.formatOnWrite", layer: "project", value: true }] }), /removed, created or redirected|changed/);
  } finally { await fs.rm(r.root, { recursive: true, force: true }); }
});

test("conflicts: an outside change to the edited key refuses, one to another key is kept", { skip: !available, timeout: 120_000 }, async () => {
  const r = await rig();
  try {
    const stale = await read(r);
    await fs.appendFile(r.globalFile, "compaction:\n  thresholdPercent: 70\n");
    await refused(call(r, { action: "write", scope: "global", baseline: stale.baselines.global, changes: [{ op: "set", id: "compaction.thresholdPercent", layer: "global", value: 40 }] }), /changed outside the editor/);
    assert.match(await fs.readFile(r.globalFile, "utf8"), /thresholdPercent: 70/, "nothing was overwritten");
    await call(r, { action: "write", scope: "global", baseline: stale.baselines.global, changes: [{ op: "set", id: "lsp.formatOnWrite", layer: "global", value: true }] });
    const text = await fs.readFile(r.globalFile, "utf8");
    assert.match(text, /thresholdPercent: 70/, "the outside change to another key survives");
    assert.match(text, /formatOnWrite: true/);
    const projectStale = await read(r);
    await fs.writeFile(r.projectFile, "lsp:\n  diagnosticsOnWrite: false\n");
    await refused(call(r, { action: "write", scope: "project", baseline: projectStale.baselines.project, changes: [{ op: "reset", id: "lsp.diagnosticsOnWrite", layer: "project" }] }), /changed outside the editor/);
    await fs.writeFile(r.globalFile, "bad: [\n");
    await refused(call(r, { action: "read" }), /OMP could not complete/);
  } finally { await fs.rm(r.root, { recursive: true, force: true }); }
});

test("every refusal is explicit and writes nothing", { skip: !available, timeout: 240_000 }, async () => {
  const r = await rig();
  try {
    const receipt = await read(r);
    const baseline = receipt.baselines.global;
    const before = await fs.readFile(r.globalFile, "utf8");
    const write = (changes: unknown, scope: unknown = "global", base: unknown = baseline): Promise<unknown> => call(r, { action: "write", scope, changes, baseline: base });
    const set = (id: string, value: unknown, layer = "global"): unknown => ({ op: "set", id, layer, value });
    await refused(write([set("mnemopi.llmApiKey", "x")]), /cannot be changed here\. This is a credential.*omp config set mnemopi\.llmApiKey/);
    await refused(write([set("theme.dark", "x")]), /cannot be changed here\. OMP fills this setting's choices at run time/);
    await refused(write([set("providers.maxInFlightRequests", { openai: 1 })]), /cannot be changed here\. A list or mapping/);
    await refused(write([set("tui.vimModeDisplay", "bogus")]), /not one of the values OMP lists/);
    await refused(write([set("compaction.thresholdPercent", 41)]), /not one of the values OMP lists/);
    await refused(write([set("tui.vimMode", "yes")]), /not one of the values OMP lists/);
    await refused(write([set("compaction.methodOrder", ["handoff", "handoff"])]), /not one of the values OMP lists/);
    await refused(write([set("no.such.setting", true)]), /OMP has no setting no\.such\.setting/);
    await refused(write([set("tui.vimMode", true), set("tui.vimMode", false)]), /only once per save/);
    await refused(write([set("tui.vimMode", true, "project")]), /settings changes are invalid/);
    await refused(write([]), /No valid settings changes/);
    await refused(write([set("tui.vimMode", true)], "elsewhere"), /Choose global or project scope/);
    await refused(write([set("tui.vimMode", true)], "global", null), /Reload the editor before saving/);
    await refused(write("nope"), /No valid settings changes/);
    // hidden by OMP's own condition: autolearn.autoContinue needs autolearn.enabled
    await refused(write([set("autolearn.autoContinue", true)]), /OMP hides Auto.*while its condition is false/i);
    // a baseline from the other layer's file is not accepted for this one
    await refused(write([set("tui.vimMode", true)], "global", receipt.baselines.project), /Reload the editor before saving/);
    assert.equal(await fs.readFile(r.globalFile, "utf8"), before, "no refusal wrote anything");
  } finally { await fs.rm(r.root, { recursive: true, force: true }); }
});

test("an OMP whose schema modules are missing is refused whatever its version, with one clear message", { skip: !available, timeout: 60_000 }, async () => {
  const r = await rig();
  try {
    const fake = path.join(r.root, "fake", "pi-coding-agent");
    await fs.mkdir(fake, { recursive: true });
    await fs.writeFile(path.join(fake, "package.json"), JSON.stringify({ version: "19.0.0" }));
    await refused(call(r, { action: "read" }, { packageRoot: fake }), /has no @oh-my-pi\/pi-utils beside or inside it/);
    for (const dependency of ["pi-utils", "pi-tui"]) {
      await fs.mkdir(path.join(fake, "node_modules", "@oh-my-pi", dependency), { recursive: true });
      await fs.writeFile(path.join(fake, "node_modules", "@oh-my-pi", dependency, "package.json"), JSON.stringify({ name: `@oh-my-pi/${dependency}`, version: "19.0.0" }));
    }
    await refused(call(r, { action: "read" }, { packageRoot: fake }), /shape this version of OMP Desk does not recognise/);
    await fs.writeFile(path.join(fake, "package.json"), "{");
    await refused(call(r, { action: "read" }, { packageRoot: fake }), /shape this version of OMP Desk does not recognise/);
  } finally { await fs.rm(r.root, { recursive: true, force: true }); }
});

test("numbers OMP lists no choices for are editable with a validated number; the project files OMP merges are reported by name", { skip: !available, timeout: 240_000 }, async () => {
  const r = await rig();
  try {
    const receipt = await read(r);
    const retry = entryOf(receipt, "retry.maxDelayMs");
    assert.deepEqual(retry.control, { kind: "numeric", integer: true });
    assert.deepEqual(retry.readOnly, null);
    const write = (id: string, value: unknown): Promise<unknown> => call(r, { action: "write", scope: "global", baseline: receipt.baselines.global, changes: [{ op: "set", id, layer: "global", value }] });
    for (const bad of [1.5, Number.NaN, "7", -0.5]) await refused(write("retry.maxDelayMs", bad), /Enter a whole number|Enter a number/);
    assert.doesNotMatch(await fs.readFile(r.globalFile, "utf8"), /maxDelayMs/);
    const saved = await save(r, "global", [{ op: "set", id: "retry.maxDelayMs", layer: "global", value: 120000 }]);
    assert.equal(entryOf(saved.receipt, "retry.maxDelayMs").layers.global.state === "set" && (entryOf(saved.receipt, "retry.maxDelayMs").layers.global as { value: number }).value, 120000);
    assert.equal(ompGet(r, "retry.maxDelayMs"), "120000");
    // a foreign project file overrides .omp/config.yml, and .omp/settings.json yields to it
    await fs.mkdir(path.join(r.cwd, ".claude"), { recursive: true });
    await fs.writeFile(path.join(r.cwd, ".claude", "settings.json"), JSON.stringify({ lsp: { diagnosticsOnWrite: false, formatOnWrite: true } }));
    await fs.writeFile(path.join(r.cwd, ".omp", "settings.json"), JSON.stringify({ lsp: { formatOnWrite: false }, tui: { vimMode: false } }));
    const merged = await read(r);
    assert.deepEqual(entryOf(merged, "lsp.diagnosticsOnWrite").projectOther, { file: ".claude/settings.json", shadows: true });
    assert.deepEqual(entryOf(merged, "lsp.diagnosticsOnWrite").effective, { value: false, source: "project", layeredSource: "project" });
    assert.deepEqual(entryOf(merged, "lsp.formatOnWrite").projectOther, { file: ".claude/settings.json", shadows: false });
    assert.deepEqual(entryOf(merged, "tui.vimMode").projectOther, { file: ".omp/settings.json", shadows: false });
    assert.equal(ompGet(r, "lsp.diagnosticsOnWrite"), "false", "OMP agrees the foreign file wins");
  } finally { await fs.rm(r.root, { recursive: true, force: true }); }
});

test("the global scope and a folder without a project layer read no project files and refuse project writes", { skip: !available, timeout: 120_000 }, async () => {
  const r = await rig();
  try {
    const receipt = await call(r, { action: "read", project: false }) as ConfigReceipt;
    assert.equal(receipt.snapshot.files.project.exists, false, "the project file of the folder was not read");
    assert.deepEqual(entryOf(receipt, "lsp.diagnosticsOnWrite").layers.project, { state: "unset" });
    assert.equal(entryOf(receipt, "lsp.diagnosticsOnWrite").effective.source, "global");
    await refused(call(r, { action: "write", project: false, scope: "project", baseline: receipt.baselines.project, changes: [{ op: "set", id: "lsp.formatOnWrite", layer: "project", value: true }] }), /no project layer/);
  } finally { await fs.rm(r.root, { recursive: true, force: true }); }
});

test("the first project write is refused, naming the effect, when an ancestor's .omp holds context files", { skip: !available, timeout: 120_000 }, async () => {
  const r = await rig();
  try {
    const repo = path.join(r.root, "repo"); const sub = path.join(repo, "sub");
    await fs.mkdir(path.join(repo, ".git"), { recursive: true }); await fs.mkdir(path.join(repo, ".omp"), { recursive: true }); await fs.mkdir(sub, { recursive: true });
    await fs.writeFile(path.join(repo, ".omp", "AGENTS.md"), "rules");
    const nested: Rig = { ...r, cwd: sub, projectFile: path.join(sub, ".omp", "config.yml") };
    const receipt = await read(nested);
    assert.equal(receipt.snapshot.files.project.ancestorOmp, path.join(repo, ".omp"));
    assert.ok(receipt.snapshot.notices.some(notice => notice.includes("stop loading them")));
    await refused(call(nested, { action: "write", scope: "project", baseline: receipt.baselines.project, changes: [{ op: "set", id: "lsp.formatOnWrite", layer: "project", value: true }] }), /would stop loading them from .*\.omp\. Nothing was changed/);
    await assert.rejects(fs.stat(path.join(sub, ".omp")), "nothing was created");
    await call(nested, { action: "write", scope: "global", baseline: receipt.baselines.global, changes: [{ op: "set", id: "lsp.formatOnWrite", layer: "global", value: true }] });
  } finally { await fs.rm(r.root, { recursive: true, force: true }); }
});
