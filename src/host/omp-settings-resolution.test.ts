import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { runSettingsWorker } from "./omp-settings-worker.ts";
import { ROLE_NOTES } from "../protocol/role-notes.ts";
import type { ConfigRecord, SettingsAgent, SettingsRole, SettingsSnapshot } from "../protocol/settings-model.ts";

const packageRoot = process.env.OMP_SETTINGS_TEST_PACKAGE_ROOT ?? path.join(os.homedir(), ".bun", "install", "global", "node_modules", "@oh-my-pi", "pi-coding-agent");
const bunPath = process.env.OMP_SETTINGS_TEST_BUN ?? path.join(os.homedir(), ".bun", "bin", process.platform === "win32" ? "bun.exe" : "bun");
const helperPath = fileURLToPath(new URL("../omp/settings-worker.ts", import.meta.url));
const skip = !existsSync(packageRoot) || !existsSync(bunPath);
interface Receipt { snapshot: SettingsSnapshot; files: { global: ConfigRecord; project: ConfigRecord } }

const MODELS = `providers:
  fx-ok:
    api: openai-completions
    baseUrl: https://example.invalid/v1
    apiKey: fixture-never-used-for-network
    models:
      - { id: fast, name: Fast, reasoning: true, contextWindow: 8192, maxTokens: 1024 }
      - { id: big, name: Big, reasoning: true, contextWindow: 8192, maxTokens: 1024 }
`;
const agent = (name: string, frontmatter: string): string => `---\nname: ${name}\ndescription: Use this agent when testing ${name}\n${frontmatter}---\nDo the ${name} fixture work.\n`;

/** A scratch agent directory and project with every kind of role and agent source, and a worker caller. */
async function fixture(globalYaml: string, projectYaml: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-resolution-"));
  const nativeRoot = await fs.mkdtemp(path.join(os.homedir(), "omp-desk-resolution-test-"));
  const cwd = path.join(root, "project"); const agentDir = path.join(nativeRoot, "agent");
  const globalFile = path.join(agentDir, "config.yml"); const projectFile = path.join(cwd, ".omp", "config.yml");
  await fs.mkdir(path.join(agentDir, "agents"), { recursive: true }); await fs.mkdir(path.dirname(projectFile), { recursive: true });
  await fs.writeFile(globalFile, globalYaml); await fs.writeFile(projectFile, projectYaml); await fs.writeFile(path.join(agentDir, "models.yml"), MODELS);
  const agents = path.join(agentDir, "agents");
  await fs.writeFile(path.join(agents, "follower.md"), agent("follower", "model: \"@smol\"\n"));
  await fs.writeFile(path.join(agents, "pinned.md"), agent("pinned", "model: fx-ok/big:high\nthinking-level: low\n"));
  await fs.writeFile(path.join(agents, "locked-agent.md"), agent("locked-agent", "model: anthropic/claude-3-haiku-20240307\n"));
  await fs.writeFile(path.join(agents, "bare.md"), agent("bare", ""));
  await fs.writeFile(path.join(agents, "shielded.md"), agent("shielded", "model: \"@slow\"\nthinking-level: medium\n"));
  const call = (request: ConfigRecord, env: NodeJS.ProcessEnv = {}) => runSettingsWorker({ packageRoot, bunPath, helperPath, cwd, profile: "default", request,
    env: { PI_CONFIG_DIR: path.basename(nativeRoot), PI_CODING_AGENT_DIR: "", PI_CONFIG_FILES: "", OMP_AUTH_BROKER_URL: "", OMP_AUTH_BROKER_TOKEN: "", PI_SMOL_MODEL: "", PI_SLOW_MODEL: "", PI_PLAN_MODEL: "", ...env } });
  const read = async (env?: NodeJS.ProcessEnv): Promise<Receipt> => await call({ action: "read" }, env) as Receipt;
  return { call, read, globalFile, projectFile, cwd, cleanup: async () => { await fs.rm(root, { recursive: true, force: true }); await fs.rm(nativeRoot, { recursive: true, force: true }); } };
}
const role = (snapshot: SettingsSnapshot, id: string): SettingsRole => snapshot.roles.find(item => item.id === id)!;
const agentOf = (snapshot: SettingsSnapshot, name: string): SettingsAgent => snapshot.agents.find(item => item.name === name)!;

const GLOBAL = `modelRoleStorage: project
defaultThinkingLevel: medium
modelRoles:
  default: fx-ok/fast
  slow: fx-ok/big:high
  vision: anthropic/claude-3-haiku-20240307
task:
  agentModelOverrides:
    shielded: fx-ok/big
`;
const PROJECT = `modelRoles:
  smol: fx-ok/fast:low
  slow: fx-ok/fast
`;

test("roles resolve through OMP's own functions: layers, followed roles, built-in lists, env and login problems", { skip, timeout: 180_000 }, async () => {
  const f = await fixture(GLOBAL, PROJECT);
  try {
    const { snapshot } = await f.read();
    const smol = role(snapshot, "smol").resolution;
    assert.equal(smol.source, "project"); assert.equal(smol.model.model, "fx-ok/fast");
    assert.deepEqual(smol.thinking, { level: "low", source: "selector" });
    assert.deepEqual(smol.trace.map(step => [step.kind, step.state]), [["project", "used"]]);
    const slow = role(snapshot, "slow").resolution;
    assert.equal(slow.source, "project", "the project value wins over the global one");
    assert.deepEqual(slow.trace.map(step => [step.kind, step.state, step.value]), [["project", "used", "fx-ok/fast"], ["global", "shadowed", "fx-ok/big:high"]]);
    const dflt = role(snapshot, "default").resolution;
    assert.equal(dflt.source, "global"); assert.deepEqual(dflt.thinking, { level: "medium", source: "setting" });
    assert.deepEqual(role(snapshot, "slow").resolution.thinking, { source: "none" }, "a role without a level suffix has no level of its own");
    const tiny = role(snapshot, "tiny");
    assert.equal(tiny.resolution.source, "inherited"); assert.deepEqual(tiny.resolution.follows, ["smol"]);
    assert.equal(tiny.resolved, "fx-ok/fast"); assert.deepEqual(tiny.resolution.thinking, { level: "low", source: "role" });
    assert.deepEqual(role(snapshot, "memory").resolution.follows, ["tiny", "smol"]);
    assert.deepEqual(role(snapshot, "advisor").resolution.follows, ["slow"], "advisor follows slow only while slow is set");
    assert.deepEqual([...role(snapshot, "smol").resolution.followers].sort(), ["memory", "tiny", "widget"]);
    assert.equal(role(snapshot, "commit").resolution.source, "none"); assert.equal(role(snapshot, "commit").resolution.model.status, "none");
    assert.equal(role(snapshot, "plan").resolution.source, "none");
    const vision = role(snapshot, "vision").resolution;
    assert.deepEqual([vision.model.status, vision.model.provider, vision.model.wanted], ["login", "anthropic", "anthropic/claude-3-haiku-20240307"]);
    const judge = role(snapshot, "judge").resolution;
    assert.equal(judge.source, "builtin"); assert.ok(role(snapshot, "judge").defaults.length > 0);
    assert.equal(role(snapshot, "image").resolution.source, "builtin");
    // The item-6 table agrees with OMP: a built-in list exists exactly for the roles the table says.
    for (const row of snapshot.roles) if (Object.hasOwn(ROLE_NOTES, row.id)) assert.equal(row.defaults.length > 0, ROLE_NOTES[row.id]!.list, `built-in list of ${row.id}`);
    const env = await f.read({ PI_SLOW_MODEL: "fx-ok/big:max" });
    const envSlow = role(env.snapshot, "slow").resolution;
    assert.equal(envSlow.source, "env"); assert.equal(envSlow.envName, "PI_SLOW_MODEL"); assert.equal(envSlow.model.model, "fx-ok/big");
    assert.deepEqual(envSlow.trace.map(step => step.kind), ["env", "project", "global"]);
    assert.equal(envSlow.trace[0]!.state, "used"); assert.equal(envSlow.trace[1]!.state, "shadowed");
    // The variable reaches the resolution only: the saved selector, the effective record and its provenance stay the persisted ones, so no write is built from it.
    assert.equal(role(env.snapshot, "slow").selector, "fx-ok/fast");
    assert.deepEqual(env.snapshot.effective.modelRoles, snapshot.effective.modelRoles);
    assert.equal(env.snapshot.provenance.modelRoles, snapshot.provenance.modelRoles);
    assert.equal(role(snapshot, "slow").selector, "fx-ok/fast", "the environment never leaks into the next read");
  } finally { await f.cleanup(); }
});

test("agents resolve their model, thinking and source, and say what a reset would do", { skip, timeout: 180_000 }, async () => {
  const f = await fixture(GLOBAL, PROJECT);
  try {
    const { snapshot } = await f.read();
    const follower = agentOf(snapshot, "follower").resolution;
    assert.equal(follower.source, "definition"); assert.deepEqual(follower.roles, ["smol"]); assert.equal(follower.model.model, "fx-ok/fast");
    assert.deepEqual(follower.thinking, { level: "low", source: "role" });
    const pinned = agentOf(snapshot, "pinned").resolution;
    assert.deepEqual(pinned.thinking, { level: "high", source: "selector" }, "an explicit :level beats the definition's thinking-level");
    const locked = agentOf(snapshot, "locked-agent").resolution;
    assert.deepEqual([locked.model.status, locked.model.provider], ["login", "anthropic"]);
    const bare = agentOf(snapshot, "bare").resolution;
    assert.equal(bare.source, "session"); assert.equal(bare.model.model, "fx-ok/fast", "no model in the definition: the default role stands in for the session");
    const shielded = agentOf(snapshot, "shielded").resolution;
    assert.equal(shielded.source, "override"); assert.equal(shielded.layer, "global"); assert.equal(shielded.model.model, "fx-ok/big");
    assert.deepEqual(shielded.shadowedRoles, ["slow"]);
    assert.deepEqual(shielded.thinking, { level: "medium", source: "definition" });
    assert.equal(shielded.ifReset.global!.source, "definition"); assert.equal(shielded.ifReset.global!.model.model, "fx-ok/fast", "without the override @slow (project: fx-ok/fast) decides");
    assert.deepEqual(shielded.trace.map(step => [step.kind, step.state]), [["override", "used"], ["definition", "shadowed"], ["session", "shadowed"]]);
    assert.deepEqual(role(snapshot, "slow").resolution.agents, { following: ["reviewer"], overridden: ["shielded"] });
    assert.deepEqual([...role(snapshot, "smol").resolution.agents.following].sort(), ["follower", "scout", "sonic"], "bundled agents that name @smol count too");
    assert.ok(role(snapshot, "default").resolution.agents.following.includes("bare"));
    const task = agentOf(snapshot, "task").resolution;
    assert.equal(task.source, "session", "the bundled task agent says @task, which is unassigned, so it follows the session");
  } finally { await f.cleanup(); }
});

test("agent overrides are written to the project layer, reset by removing the key, and refused where the project cannot hold them", { skip, timeout: 180_000 }, async () => {
  const f = await fixture(GLOBAL, PROJECT);
  try {
    let receipt = await f.read();
    const write = (edits: ConfigRecord[], scope = "project") => f.call({ action: "write", scope, baseline: receipt.files[scope as "project"], edits });
    await write([{ path: ["task", "agentModelOverrides", "follower"], value: "fx-ok/big" }, { path: ["task", "agentPrewalk", "follower"], value: "off" }]);
    const projectText = await fs.readFile(f.projectFile, "utf8");
    assert.match(projectText, /agentModelOverrides:\s+follower: fx-ok\/big/); assert.match(projectText, /smol: fx-ok\/fast:low/, "roles in the project file survive");
    receipt = await f.read();
    const follower = agentOf(receipt.snapshot, "follower").resolution;
    assert.equal(follower.source, "override"); assert.equal(follower.layer, "project"); assert.equal(follower.model.model, "fx-ok/big");
    assert.deepEqual(follower.prewalk, { value: "off", from: "project" });
    assert.equal(follower.ifReset.project!.source, "definition"); assert.equal(follower.ifReset.project!.model.model, "fx-ok/fast");
    // A project value shadows the global one and a reset of the project layer reveals it again.
    receipt = await f.read();
    await write([{ path: ["task", "agentModelOverrides", "shielded"], value: "fx-ok/fast" }]);
    receipt = await f.read();
    const shielded = agentOf(receipt.snapshot, "shielded").resolution;
    assert.equal(shielded.layer, "project"); assert.equal(shielded.model.model, "fx-ok/fast"); assert.deepEqual(shielded.trace.slice(0, 2).map(step => [step.layer, step.state]), [["project", "used"], ["global", "shadowed"]]);
    assert.equal(shielded.ifReset.project!.layer, "global"); assert.equal(shielded.ifReset.project!.model.model, "fx-ok/big");
    await write([{ path: ["task", "agentModelOverrides", "shielded"] }, { path: ["task", "agentModelOverrides", "follower"] }, { path: ["task", "agentPrewalk", "follower"] }]);
    const after = await fs.readFile(f.projectFile, "utf8");
    assert.doesNotMatch(after, /task:/, "a reset removes the keys and prunes the mappings it leaves empty");
    assert.doesNotMatch(after, /null/, "agent resets never write a tombstone");
    assert.match(after, /smol: fx-ok\/fast:low/);
    receipt = await f.read();
    assert.equal(agentOf(receipt.snapshot, "shielded").resolution.layer, "global");
    // Refusals: everything else stays global, and an unknown agent is refused; nothing is written.
    const before = await fs.readFile(f.projectFile, "utf8");
    await assert.rejects(write([{ path: ["task", "disabledAgents"], value: ["follower"] }]), /project scope is only for model roles and agent/);
    await assert.rejects(write([{ path: ["cycleOrder"], value: ["default"] }]));
    await assert.rejects(write([{ path: ["task", "agentModelOverrides", "no-such-agent"], value: "fx-ok/fast" }]), /no longer discovered/);
    await assert.rejects(write([{ path: ["task", "agentModelOverrides", "follower"], value: "fx-ok/does-not-exist" }]), /No available model/);
    assert.equal(await fs.readFile(f.projectFile, "utf8"), before);
    // An ordered list override in the project file is read as OMP reads it and survives an unrelated project write.
    await fs.writeFile(f.projectFile, `${before}\ntask:\n  agentModelOverrides:\n    follower:\n      - anthropic/claude-3-haiku-20240307\n      - fx-ok/big\n`);
    receipt = await f.read();
    assert.equal(agentOf(receipt.snapshot, "follower").resolution.model.model, "fx-ok/big", "the first usable entry of the list runs");
    assert.equal(agentOf(receipt.snapshot, "follower").resolution.overrides.project, "anthropic/claude-3-haiku-20240307,fx-ok/big");
    await write([{ path: ["task", "agentModelOverrides", "pinned"], value: "fx-ok/fast" }]);
    assert.match(await fs.readFile(f.projectFile, "utf8"), /pinned: fx-ok\/fast/);
    assert.match(await fs.readFile(f.projectFile, "utf8"), /follower:\s+- anthropic/);
    // Project agent writes work with the project role storage left at global too: they are not role writes.
    await fs.writeFile(f.globalFile, GLOBAL.replace("modelRoleStorage: project\n", ""));
    receipt = await f.read();
    await write([{ path: ["task", "agentModelOverrides", "bare"], value: "fx-ok/big" }]);
    await assert.rejects(write([{ path: ["modelRoles", "plan"], value: "fx-ok/big" }]), /modelRoleStorage/);
  } finally { await f.cleanup(); }
});

test("a role that tools resolve as a chain continues down its retry fallback chain when its own model cannot be used", { skip, timeout: 180_000 }, async () => {
  const f = await fixture(`${GLOBAL.replace("modelRoles:\n", "modelRoles:\n  memory: anthropic/claude-3-haiku-20240307\n")}retry:\n  fallbackChains:\n    memory:\n      - fx-ok/big\n`, PROJECT);
  try {
    const { snapshot } = await f.read();
    const memory = role(snapshot, "memory").resolution;
    assert.deepEqual([memory.model.status, memory.model.model], ["ok", "fx-ok/big"], "OMP's memory tool uses the first attempt of the chain, not the unusable assignment");
    assert.deepEqual(memory.trace.map(step => [step.kind, step.state]), [["global", "shadowed"], ["builtin", "used"]]);
    assert.deepEqual(memory.candidates, []);
    assert.deepEqual([role(snapshot, "vision").resolution.model.status], ["login"], "a role OMP reads as an alias or raw value keeps the login diagnosis");
  } finally { await f.cleanup(); }
});

test("the first project file is refused when it would hide an ancestor's context files from sessions in the folder (ADR-0071)", { skip, timeout: 180_000 }, async () => {
  const f = await fixture(GLOBAL, PROJECT);
  try {
    const receipt = await f.read();
    await fs.rm(path.dirname(f.projectFile), { recursive: true, force: true });
    await fs.mkdir(path.join(path.dirname(f.cwd), ".omp"), { recursive: true });
    await fs.writeFile(path.join(path.dirname(f.cwd), ".omp", "AGENTS.md"), "ancestor rules\n");
    await assert.rejects(f.call({ action: "write", scope: "project", baseline: receipt.files.project, edits: [{ path: ["task", "agentModelOverrides", "follower"], value: "fx-ok/big" }] }), /nearest non-empty \.omp folder/);
    assert.equal(existsSync(f.projectFile), false, "nothing was created");
  } finally { await f.cleanup(); }
});
