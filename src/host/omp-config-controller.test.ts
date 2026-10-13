import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { OmpConfigController, parseConfigAction } from "./omp-config-controller.ts";
import type { OmpConfigPorts } from "./omp-config-controller.ts";
import { SettingsRefusal } from "./omp-settings-core.ts";
import type { ConfigEntry, ConfigMessage, ConfigReceipt } from "../protocol/omp-config-model.ts";
import type { ConfigRecord } from "../protocol/settings-model.ts";

const entry = (id: string, patch: Partial<ConfigEntry> = {}): ConfigEntry => ({
  id, tab: "files", group: "LSP", label: `Label of ${id}`, description: "", type: "boolean", control: { kind: "boolean" }, readOnly: null,
  layers: { global: { state: "unset" }, project: { state: "unset" } }, effective: { value: false, source: "default", layeredSource: "default" },
  env: null, visible: true, condition: null, writable: { global: true, project: true }, projectOther: null, ...patch,
});
const receipt = (entries: ConfigEntry[], files = { global: true, project: true }, dir = "C:/x"): ConfigReceipt => ({
  snapshot: { omp: { version: "18.10.3", verified: true }, profile: "default", tabs: [], entries, notices: [], files: { global: { path: `${dir}/agent.yml`, exists: files.global }, project: { path: `${dir}/p.yml`, exists: files.project } } },
  baselines: { global: { logical: "g", physical: "g", exists: true, digest: "d1", settings: {} }, project: { logical: "p", physical: "p", exists: true, digest: "d2", settings: {} } },
});

interface Rig { controller: OmpConfigController; messages: ConfigMessage[]; requests: ConfigRecord[]; opened: { file: string; line: number | null }[]; script: (handler: (request: ConfigRecord) => unknown) => void; ports: { pick?: string | null | undefined; rebind?: string | null; resolveTo?: string; openedSetting?: number } }
function rig(folder: string | null = "C:/proj"): Rig {
  const messages: ConfigMessage[] = []; const requests: ConfigRecord[] = []; const opened: Rig["opened"] = [];
  let handler: (request: ConfigRecord) => unknown = () => receipt([entry("lsp.formatOnWrite")]);
  const state: Rig["ports"] = {};
  const ports: OmpConfigPorts = {
    async worker(request) { requests.push(request); const result = handler(request); if (result instanceof Error) throw result; return result; },
    post: message => { messages.push(message); }, key: () => "key-1",
    async openFile(file, line) { opened.push({ file, line }); },
    async openSetting() { state.openedSetting = (state.openedSetting ?? 0) + 1; },
    async pickScope() { return state.pick; }, async rebind(folder) { return state.rebind ? { refusal: state.rebind } : { folder: state.resolveTo ?? folder }; },
  };
  return { controller: new OmpConfigController(folder, "default", ports), messages, requests, opened, script: next => { handler = next; }, ports: state };
}
const results = (r: Rig) => r.messages.filter((message): message is Extract<ConfigMessage, { type: "ompConfig:result" }> => message.type === "ompConfig:result");

test("ready announces the editor, reads once and answers its request", async () => {
  const r = rig();
  await r.controller.handle({ action: "ready", requestId: "a" });
  assert.deepEqual(r.messages.map(message => message.type), ["ompConfig:init", "ompConfig:snapshot", "ompConfig:result"]);
  assert.deepEqual(r.messages[0], { type: "ompConfig:init", key: "key-1", folder: "C:/proj", profile: "default", projectAvailable: true });
  assert.deepEqual(results(r), [{ type: "ompConfig:result", requestId: "a", ok: true, message: "" }]);
  assert.deepEqual(r.requests, [{ action: "read", project: true }]);
});

test("a set writes one change with the layer's baseline, reads back, and says what OMP now uses and from where", async () => {
  const r = rig();
  await r.controller.handle({ action: "ready", requestId: "r0" });
  r.script(request => request.action === "read"
    ? receipt([entry("lsp.formatOnWrite", { layers: { global: { state: "set", value: true }, project: { state: "unset" } }, effective: { value: true, source: "global", layeredSource: "global" } })])
    : { saved: true, changed: true });
  await r.controller.handle({ action: "set", requestId: "r1", id: "lsp.formatOnWrite", layer: "global", value: true });
  const write = r.requests.find(request => request.action === "write")!;
  assert.deepEqual([write.scope, write.changes, (write.baseline as { digest: string }).digest], ["global", [{ op: "set", id: "lsp.formatOnWrite", layer: "global", value: true }], "d1"]);
  assert.deepEqual(results(r).at(-1), { type: "ompConfig:result", requestId: "r1", ok: true, message: "Saved Label of lsp.formatOnWrite to the global layer. OMP now uses on from the global layer." });
  assert.equal(r.messages.filter(message => message.type === "ompConfig:snapshot").length, 2, "every save sends a fresh snapshot");
});

test("a shadowing project value or an overriding variable is named in the result", async () => {
  const r = rig();
  await r.controller.handle({ action: "ready", requestId: "r0" });
  r.script(request => request.action === "read"
    ? receipt([entry("lsp.formatOnWrite", { effective: { value: true, source: "project", layeredSource: "project" } }), entry("edit.fuzzyMatch", { env: { name: "PI_EDIT_FUZZY", present: true, active: true, fallback: false } })])
    : { saved: true, changed: true });
  await r.controller.handle({ action: "set", requestId: "r1", id: "lsp.formatOnWrite", layer: "global", value: false });
  assert.match(results(r).at(-1)!.message, /Saved .* to the global layer\. OMP now uses on from the project layer\./);
  await r.controller.handle({ action: "reset", requestId: "r2", id: "edit.fuzzyMatch", layer: "global" });
  assert.match(results(r).at(-1)!.message, /Reset .*: the global layer no longer sets it\. \$PI_EDIT_FUZZY overrides it while that variable is set\./);
});

test("a no-op write is reported as nothing to save", async () => {
  const r = rig();
  await r.controller.handle({ action: "ready", requestId: "r0" });
  r.script(request => request.action === "read" ? receipt([entry("lsp.formatOnWrite")]) : { saved: true, changed: false });
  await r.controller.handle({ action: "reset", requestId: "r1", id: "lsp.formatOnWrite", layer: "global" });
  assert.match(results(r).at(-1)!.message, /Nothing to reset: .* has no value in the global layer\. The file was not rewritten\./);
  await r.controller.handle({ action: "set", requestId: "r2", id: "lsp.formatOnWrite", layer: "project", value: false });
  assert.match(results(r).at(-1)!.message, /Nothing to save: .* already has this value in the project layer\./);
});

test("refusals: no project folder, no read yet, a worker refusal, a generic failure and a failed readback", async () => {
  const global = rig(null);
  await global.controller.handle({ action: "set", requestId: "x0", id: "a", layer: "global", value: true });
  assert.deepEqual(results(global).at(-1), { type: "ompConfig:result", requestId: "x0", ok: false, message: "Reload before saving." });
  await global.controller.handle({ action: "ready", requestId: "x1" });
  await global.controller.handle({ action: "set", requestId: "x2", id: "a", layer: "project", value: true });
  assert.match(results(global).at(-1)!.message, /Choose a project folder in the scope control first\. Nothing was changed\./);
  assert.equal(global.requests.filter(request => request.action === "write").length, 0, "nothing reached the worker");
  await global.controller.handle({ action: "open-config", requestId: "x3", layer: "project" });
  assert.equal(results(global).at(-1)!.ok, false);

  const r = rig();
  await r.controller.handle({ action: "ready", requestId: "r0" });
  r.script(request => request.action === "write" ? new SettingsRefusal("This setting changed outside the editor. Reload before saving; nothing was overwritten.") : receipt([entry("a")]));
  await r.controller.handle({ action: "set", requestId: "r1", id: "a", layer: "global", value: true });
  assert.deepEqual(results(r).at(-1), { type: "ompConfig:result", requestId: "r1", ok: false, message: "This setting changed outside the editor. Reload before saving; nothing was overwritten." });
  r.script(() => new Error("C:\\secret\\path leaked"));
  await r.controller.handle({ action: "reload", requestId: "r2" });
  assert.deepEqual(results(r).at(-1), { type: "ompConfig:result", requestId: "r2", ok: false, message: "The settings operation could not complete. Reload before retrying." });
  r.script(request => request.action === "write" ? { saved: true, changed: true } : new Error("boom"));
  await r.controller.handle({ action: "set", requestId: "r3", id: "a", layer: "global", value: true });
  assert.match(results(r).at(-1)!.message, /The change was saved, but reading the files back failed\./);
  r.script(() => ({ snapshot: { entries: "nope" }, baselines: {} }));
  await r.controller.handle({ action: "reload", requestId: "r4" });
  assert.match(results(r).at(-1)!.message, /invalid settings snapshot/);
});

test("one operation at a time, and a repeated request id is answered once", async () => {
  const r = rig();
  await r.controller.handle({ action: "ready", requestId: "r0" });
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  r.script(() => gate.then(() => receipt([entry("a")])));
  const first = r.controller.handle({ action: "reload", requestId: "slow" });
  await r.controller.handle({ action: "reload", requestId: "second" });
  assert.deepEqual(results(r).at(-1), { type: "ompConfig:result", requestId: "second", ok: false, message: "A settings operation is still running." });
  await r.controller.handle({ action: "reload", requestId: "slow" });
  release();
  await first;
  const answers = results(r).filter(message => message.requestId === "slow");
  assert.equal(answers.length, 1);
  assert.equal(r.requests.filter(request => request.action === "read").length, 2);
});

test("open-config opens the layer's file at the setting's key, or at the top with a note", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-config-controller-"));
  try {
    await fs.writeFile(path.join(dir, "agent.yml"), "tui:\n  vimMode: true\nlsp:\n  formatOnWrite: true\n");
    const r = rig();
    r.script(() => receipt([entry("lsp.formatOnWrite"), entry("tui.vimModeDisplay")], { global: true, project: false }, dir));
    await r.controller.handle({ action: "ready", requestId: "r0" });
    await r.controller.handle({ action: "open-config", requestId: "r1", layer: "global", id: "lsp.formatOnWrite" });
    assert.deepEqual(r.opened.at(-1), { file: `${dir}/agent.yml`, line: 3 });
    assert.equal(results(r).at(-1)!.message, "");
    await r.controller.handle({ action: "open-config", requestId: "r2", layer: "global", id: "tui.vimModeDisplay" });
    assert.deepEqual(r.opened.at(-1)?.line, null);
    assert.match(results(r).at(-1)!.message, /does not set that key; the file is open at the top/);
    await r.controller.handle({ action: "open-config", requestId: "r3", layer: "project" });
    assert.match(results(r).at(-1)!.message, /no \.omp\/config\.yml yet/);
    await r.controller.handle({ action: "open-config", requestId: "r4", layer: "global", id: "no.such" });
    assert.match(results(r).at(-1)!.message, /OMP has no setting no\.such/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("pick-scope moves the editor to a folder, to global, or reports a scope that is already open", async () => {
  const r = rig("C:/proj");
  await r.controller.handle({ action: "ready", requestId: "r0" });
  r.ports.pick = undefined;
  await r.controller.handle({ action: "pick-scope", requestId: "r1" });
  assert.equal(r.controller.folder, "C:/proj", "dismissing the picker changes nothing");
  r.ports.pick = null;
  await r.controller.handle({ action: "pick-scope", requestId: "r2" });
  assert.equal(r.controller.folder, null);
  assert.equal(results(r).at(-1)!.message, "Showing the global scope.");
  assert.deepEqual(r.messages.filter(message => message.type === "ompConfig:init").at(-1), { type: "ompConfig:init", key: "key-1", folder: null, profile: "default", projectAvailable: false });
  r.ports.pick = "C:/other"; r.ports.rebind = "That scope is already open in another tab.";
  await r.controller.handle({ action: "pick-scope", requestId: "r3" });
  assert.equal(r.controller.folder, null, "a refused move keeps the current scope");
  assert.equal(results(r).at(-1)!.message, "That scope is already open in another tab.");
  r.ports.rebind = null;
  await r.controller.handle({ action: "pick-scope", requestId: "r4" });
  assert.equal(r.controller.folder, "C:/other");
  assert.equal(results(r).at(-1)!.message, "Showing the project scope of C:/other.");
  // the host may resolve the picked folder to the project folder it stands for (nearest ancestor .omp); the editor then shows that one
  r.ports.pick = "C:/repo/Game"; r.ports.resolveTo = "C:/repo";
  await r.controller.handle({ action: "pick-scope", requestId: "r5" });
  assert.equal(r.controller.folder, "C:/repo");
  assert.equal(results(r).at(-1)!.message, "Showing the project scope of C:/repo.");
  assert.deepEqual(r.messages.filter(message => message.type === "ompConfig:init").at(-1), { type: "ompConfig:init", key: "key-1", folder: "C:/repo", profile: "default", projectAvailable: true });
});

test("parseConfigAction accepts exactly the contract's shapes", () => {
  const ok = (value: unknown) => assert.notEqual(parseConfigAction(value), null, JSON.stringify(value));
  const bad = (value: unknown) => assert.equal(parseConfigAction(value), null, JSON.stringify(value));
  ok({ action: "open-setting", requestId: "a" }); ok({ action: "ready", requestId: "a" }); ok({ action: "reload", requestId: "a" }); ok({ action: "pick-scope", requestId: "a" });
  ok({ action: "set", requestId: "a", id: "x.y", layer: "global", value: true }); ok({ action: "set", requestId: "a", id: "x.y", layer: "project", value: ["a", "b"] });
  ok({ action: "set", requestId: "a", id: "x.y", layer: "global", value: 3 }); ok({ action: "set", requestId: "a", id: "x.y", layer: "global", value: "" });
  ok({ action: "reset", requestId: "a", id: "x", layer: "project" }); ok({ action: "open-config", requestId: "a", layer: "global" }); ok({ action: "open-config", requestId: "a", layer: "global", id: "x" });
  bad(null); bad("ready"); bad({ action: "ready" }); bad({ action: "ready", requestId: "bad id!" }); bad({ action: "nope", requestId: "a" });
  bad({ action: "set", requestId: "a", id: "x", layer: "elsewhere", value: true }); bad({ action: "set", requestId: "a", id: "", layer: "global", value: true });
  bad({ action: "set", requestId: "a", id: "x", layer: "global", value: { object: 1 } }); bad({ action: "set", requestId: "a", id: "x", layer: "global", value: [1] });
  bad({ action: "set", requestId: "a", id: "x", layer: "global", value: Number.NaN }); bad({ action: "set", requestId: "a", id: "x", layer: "global", value: "x".repeat(5000) });
  bad({ action: "set", requestId: "a", id: "x", layer: "global" }); bad({ action: "reset", requestId: "a", layer: "global" }); bad({ action: "open-config", requestId: "a", layer: "global", id: 3 });
});

test("an empty text save removes the key like OMP's own panel; a credential is never opened at its key; the home folder has no project layer", async () => {
  const r = rig();
  await r.controller.handle({ action: "ready", requestId: "r0" });
  r.script(request => request.action === "read"
    ? receipt([entry("collab.relayUrl", { type: "string", control: { kind: "text" }, layers: { global: { state: "set", value: "x" }, project: { state: "unset" } } }),
      entry("mnemopi.llmApiKey", { type: "string", control: null, readOnly: { reason: "secret", note: "" }, layers: { global: { state: "set" }, project: { state: "unset" } } })])
    : { saved: true, changed: true });
  await r.controller.handle({ action: "reload", requestId: "r0b" });
  await r.controller.handle({ action: "set", requestId: "r1", id: "collab.relayUrl", layer: "global", value: "" });
  const write = r.requests.find(request => request.action === "write")!;
  assert.deepEqual(write.changes, [{ op: "reset", id: "collab.relayUrl", layer: "global" }]);
  assert.match(results(r).at(-1)!.message, /^Reset /);
  await r.controller.handle({ action: "open-config", requestId: "r2", layer: "global", id: "mnemopi.llmApiKey" });
  assert.deepEqual([results(r).at(-1)!.ok, r.opened.length], [false, 0]);
  assert.match(results(r).at(-1)!.message, /credential/);
  const home = rig(os.homedir());
  assert.equal(home.controller.projectAvailable, false);
  await home.controller.handle({ action: "ready", requestId: "h0" });
  assert.equal(home.messages.find(message => message.type === "ompConfig:init")?.type === "ompConfig:init" && (home.messages[0] as { projectAvailable: boolean }).projectAvailable, false);
  await home.controller.handle({ action: "set", requestId: "h1", id: "lsp.formatOnWrite", layer: "project", value: true });
  assert.match(results(home).at(-1)!.message, /home folder/);
});

test("open-setting shows the setting that makes the editor use the ancestor .omp, without touching the files", async () => {
  const r = rig();
  await r.controller.handle({ action: "open-setting", requestId: "s1" });
  assert.equal(r.ports.openedSetting, 1);
  assert.deepEqual(results(r).at(-1), { type: "ompConfig:result", requestId: "s1", ok: true, message: "" });
  assert.deepEqual(r.requests, []);
});
