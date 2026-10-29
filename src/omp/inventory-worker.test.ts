import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runSettingsWorker } from "../wire/omp-settings-worker.ts";
import { parseSnapshot } from "../wire/inventory/inventory-runtime.ts";
import { BUILTIN_SWITCHES } from "./inventory-switches.ts";
import type { InventoryRow, InventorySnapshot } from "../wire/inventory/inventory-model.ts";

const packageRoot = process.env.OMP_SETTINGS_TEST_PACKAGE_ROOT ?? path.join(os.homedir(), ".bun", "install", "global", "node_modules", "@oh-my-pi", "pi-coding-agent");
const bunPath = process.env.OMP_SETTINGS_TEST_BUN ?? path.join(os.homedir(), ".bun", "bin", process.platform === "win32" ? "bun.exe" : "bun");
const helperPath = fileURLToPath(new URL("./inventory-worker.ts", import.meta.url));
const available = existsSync(packageRoot) && existsSync(bunPath);

/**
 * Runs against the installed OMP with a disposable config root under the home folder, so skills,
 * extensions, MCP, settings AND the plugin lock file all resolve there and never in the user's own
 * configuration (PI_CONFIG_DIR relocates the whole root; PI_CODING_AGENT_DIR must stay empty).
 */
test("installed OMP inventory: rows, origins, redaction, global switches and refusals", { skip: !available, timeout: 180_000 }, async () => {
  const nativeRoot = await fs.mkdtemp(path.join(os.homedir(), "omp-desk-inventory-test-"));
  const agentDir = path.join(nativeRoot, "agent");
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-desk-inventory-project-"));
  // The extension runs Global from a drive root: no ancestor folder can contribute project-level skills or settings.
  const neutral = path.parse(os.tmpdir()).root;
  const write = async (file: string, content: string): Promise<void> => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content); };
  const env = { PI_CONFIG_DIR: path.basename(nativeRoot), PI_CODING_AGENT_DIR: "", PI_CONFIG_FILES: "", OMP_AUTH_BROKER_URL: "", OMP_AUTH_BROKER_TOKEN: "" };
  const run = (request: Record<string, unknown>, cwd = neutral) => runSettingsWorker({ bunPath, helperPath, packageRoot, cwd, profile: "default", request, env });
  const read = async (scope: "session" | "global", cwd = neutral): Promise<InventorySnapshot> => {
    const snapshot = parseSnapshot(await run({ action: "read", scope }, cwd));
    assert.ok(snapshot, "the receipt parses as an inventory");
    return snapshot;
  };
  /** A switch receipt reduced to what the worker owes the caller: whether it wrote, and each write's file name and description. */
  const outcome = (receipt: unknown): { changed: boolean; writes: Array<[string | null, string]> } => {
    assert.ok(typeof receipt === "object" && receipt !== null && "changed" in receipt && "writes" in receipt && Array.isArray(receipt.writes), "a switch receipt has `changed` and `writes`");
    const writes: Array<[string | null, string]> = [];
    for (const entry of receipt.writes) {
      assert.ok(typeof entry === "object" && entry !== null && "file" in entry && "what" in entry && typeof entry.what === "string" && (entry.file === null || typeof entry.file === "string"));
      writes.push([entry.file === null ? null : path.basename(entry.file), entry.what]);
    }
    return { changed: receipt.changed === true, writes };
  };
  const listed = (what: string) => ({ changed: true, writes: [["config.yml", what]] });
  const row = (snapshot: InventorySnapshot, kind: string, name: string): InventoryRow => {
    const found = snapshot.rows.find(candidate => candidate.kind === kind && candidate.name === name);
    assert.ok(found, `${kind} ${name} is listed`);
    return found;
  };
  try {
    await write(path.join(agentDir, "skills", "demo-skill", "SKILL.md"), "---\nname: demo-skill\ndescription: Demo skill\n---\nbody\n");
    await write(path.join(projectDir, ".omp", "skills", "project-skill", "SKILL.md"), "---\nname: project-skill\ndescription: Project skill\n---\nbody\n");
    await write(path.join(agentDir, "extensions", "demo-ext.ts"), "export default function () {}\n");
    await write(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: {
      "demo-mcp": { type: "stdio", command: "C:/tools/demo-server.exe", args: ["--secret", "TOPSECRET"], env: { TOKEN: "TOPSECRET" } },
      "remote-mcp": { type: "http", url: "https://user:pw@example.com/mcp?key=TOPSECRET" },
    } }));
    await write(path.join(agentDir, "config.yml"), `# keep me if you can\nskills:\n  customDirectories:\n    - ~/${path.basename(nativeRoot)}/custom-skills\ntodo:\n  enabled: true\nastGrep:\n  enabled: false\nunrelated:\n  keep: 1\n`);
    await write(path.join(nativeRoot, "custom-skills", "custom-one", "SKILL.md"), "---\nname: custom-one\ndescription: From a tilde custom directory\n---\nbody\n");
    await write(path.join(nativeRoot, "plugins", "package.json"), JSON.stringify({ dependencies: { "demo-plugin": "1.0.0" } }));
    await write(path.join(nativeRoot, "plugins", "node_modules", "demo-plugin", "package.json"), JSON.stringify({ name: "demo-plugin", version: "1.0.0", omp: { extensions: ["./ext.ts"] } }));
    await write(path.join(nativeRoot, "plugins", "omp-plugins.lock.json"), JSON.stringify({ plugins: { "demo-plugin": { version: "1.0.0", enabledFeatures: null, enabled: true } }, settings: {} }));

    // Global: user-level rows with origin, a switch each, built-ins with the explicit switch table.
    const global = await read("global");
    assert.equal(row(global, "skill", "demo-skill").provider, "native");
    assert.equal(row(global, "skill", "demo-skill").level, "user");
    assert.equal(row(global, "skill", "demo-skill").toggle.mechanism, "disabledExtensions");
    assert.equal(row(global, "skill", "demo-skill").runtimeName, "demo-skill");
    assert.ok(row(global, "skill", "demo-skill").path?.endsWith("SKILL.md"));
    assert.equal(global.rows.some(candidate => candidate.name === "project-skill"), false, "Global never lists a project's skill");
    assert.equal(row(global, "extension-module", "demo-ext").toggle.mechanism, "disabledExtensions");
    assert.equal(row(global, "plugin", "demo-plugin").toggle.mechanism, "plugin");
    const server = row(global, "mcp", "demo-mcp");
    assert.equal(server.detail, "stdio · demo-server.exe");
    assert.equal(server.toolPrefix, "mcp__demo_mcp_");
    assert.equal(row(global, "mcp", "remote-mcp").detail, "http · example.com");
    assert.equal(JSON.stringify(global).includes("TOPSECRET"), false, "no argument, env, header or query string leaves the worker");
    assert.equal(JSON.stringify(global).includes("user:pw"), false);
    assert.equal(row(global, "builtin-tool", "todo").toggle.mechanism, "setting");
    assert.equal(row(global, "builtin-tool", "ast_grep").state, "disabled");
    assert.equal(row(global, "builtin-tool", "read").toggle.mechanism, null);
    assert.equal(row(global, "builtin-tool", "find").toggle.mechanism, null, "an enum setting is displayed, not switched");
    assert.deepEqual(global.incomplete, []);

    // Every explicit switch id exists in the installed registry and is boolean (find.enabled is the one enum).
    for (const [tool, id] of Object.entries(BUILTIN_SWITCHES)) {
      const mechanism = row(global, "builtin-tool", tool).toggle.mechanism;
      assert.equal(mechanism, tool === "find" ? null : "setting", `${tool} -> ${id}`);
    }

    // A custom-directory skill (configured with `~`) is listed, can be disabled, stays listed while disabled, and can be enabled again.
    assert.equal(row(global, "skill", "custom-one").state, "active");
    assert.deepEqual(outcome(await run({ action: "toggle", scope: "global", kind: "skill", name: "custom-one", enabled: false })), listed("disabledExtensions + skill:custom-one"));
    assert.equal(row(await read("global"), "skill", "custom-one").state, "disabled");
    assert.deepEqual(outcome(await run({ action: "toggle", scope: "global", kind: "skill", name: "custom-one", enabled: true })), listed("disabledExtensions - skill:custom-one"));
    assert.equal(row(await read("global"), "skill", "custom-one").state, "active");

    // A malformed existing VS Code MCP config is an omission, not an empty list.
    await write(path.join(projectDir, ".vscode", "mcp.json"), "{ not json");
    assert.ok((await read("session", projectDir)).incomplete.includes("mcp"), "a skipped malformed source marks the view incomplete");
    await fs.rm(path.join(projectDir, ".vscode"), { recursive: true });

    // A custom-directory skill that collides with a disabled native skill has no effective runtime name.
    await write(path.join(nativeRoot, "custom-skills", "dup", "SKILL.md"), "---\nname: demo-skill\ndescription: Colliding custom copy\n---\nbody\n");
    assert.deepEqual(outcome(await run({ action: "toggle", scope: "global", kind: "skill", name: "demo-skill", enabled: false })), listed("disabledExtensions + skill:demo-skill"));
    const collided = (await read("global")).rows.filter(candidate => candidate.kind === "skill" && candidate.path?.includes("custom-skills"));
    assert.equal(collided.some(candidate => candidate.name === "demo-skill" && candidate.runtimeName !== null), false, "disabled by raw name: not an effective skill");
    assert.deepEqual(outcome(await run({ action: "toggle", scope: "global", kind: "skill", name: "demo-skill", enabled: true })), listed("disabledExtensions - skill:demo-skill"));

    // Session scope sees the project's own skill and read-only project state.
    const session = await read("session", projectDir);
    assert.equal(row(session, "skill", "project-skill").level, "project");
    assert.equal(row(session, "plugin", "demo-plugin").toggle.mechanism, null, "plugins switch only from Global");

    // Global switches write the isolated user configuration and nothing else.
    assert.deepEqual(outcome(await run({ action: "toggle", scope: "global", kind: "skill", name: "demo-skill", enabled: false })), listed("disabledExtensions + skill:demo-skill"));
    assert.deepEqual(outcome(await run({ action: "toggle", scope: "global", kind: "skill", name: "demo-skill", enabled: false })), { changed: false, writes: [] });
    assert.deepEqual(outcome(await run({ action: "toggle", scope: "global", kind: "extension-module", name: "demo-ext", enabled: false })), listed("disabledExtensions + extension-module:demo-ext"));
    assert.deepEqual(outcome(await run({ action: "toggle", scope: "global", kind: "builtin-tool", name: "ast_grep", enabled: true })), listed(`${BUILTIN_SWITCHES.ast_grep} = true`));
    const config = await fs.readFile(path.join(agentDir, "config.yml"), "utf8");
    assert.match(config, /skill:demo-skill/);
    assert.match(config, /extension-module:demo-ext/);
    assert.match(config, /unrelated:\s+keep: 1/, "unrelated keys survive");
    const after = await read("global");
    assert.equal(row(after, "skill", "demo-skill").state, "disabled");
    assert.equal(row(after, "builtin-tool", "ast_grep").state, "active");
    assert.deepEqual(outcome(await run({ action: "toggle", scope: "global", kind: "skill", name: "demo-skill", enabled: true })), listed("disabledExtensions - skill:demo-skill"));
    assert.doesNotMatch(await fs.readFile(path.join(agentDir, "config.yml"), "utf8"), /skill:demo-skill/);

    // MCP: user-level denylist by name, per-entry flags and the server definitions untouched; re-enable clears it.
    const mcpBefore = JSON.parse(await fs.readFile(path.join(agentDir, "mcp.json"), "utf8")) as { mcpServers: Record<string, unknown> };
    assert.deepEqual(outcome(await run({ action: "toggle", scope: "global", kind: "mcp", name: "demo-mcp", enabled: false })), { changed: true, writes: [["mcp.json", "MCP server demo-mcp disabled by name in the user MCP configuration"]] });
    const mcpDisabled = JSON.parse(await fs.readFile(path.join(agentDir, "mcp.json"), "utf8")) as { mcpServers: Record<string, unknown>; disabledServers?: string[] };
    assert.deepEqual(mcpDisabled.disabledServers, ["demo-mcp"]);
    assert.deepEqual(mcpDisabled.mcpServers, mcpBefore.mcpServers);
    assert.equal(row(await read("global"), "mcp", "demo-mcp").state, "disabled");
    assert.deepEqual(outcome(await run({ action: "toggle", scope: "global", kind: "mcp", name: "demo-mcp", enabled: true })), { changed: true, writes: [["mcp.json", "MCP server demo-mcp enabled by name in the user MCP configuration"]] });
    assert.equal(row(await read("global"), "mcp", "demo-mcp").state, "active");

    // A project-defined server is disabled by name from the user file; the project file is untouched.
    await write(path.join(projectDir, ".omp", "mcp.json"), JSON.stringify({ mcpServers: { "project-mcp": { type: "stdio", command: "node" } } }));
    const projectMcpBefore = await fs.readFile(path.join(projectDir, ".omp", "mcp.json"), "utf8");
    assert.deepEqual(outcome(await run({ action: "toggle", scope: "session", kind: "mcp", name: "project-mcp", enabled: false }, projectDir)), { changed: true, writes: [["mcp.json", "MCP server project-mcp disabled by name in the user MCP configuration"]] });
    assert.equal(await fs.readFile(path.join(projectDir, ".omp", "mcp.json"), "utf8"), projectMcpBefore);
    assert.equal(row(await read("session", projectDir), "mcp", "project-mcp").state, "disabled");

    // Plugin: OMP's own lock file in the isolated root.
    assert.deepEqual(outcome(await run({ action: "toggle", scope: "global", kind: "plugin", name: "demo-plugin", enabled: false })), { changed: true, writes: [[null, "plugin demo-plugin disabled through OMP's plugin manager"]] });
    assert.equal(JSON.parse(await fs.readFile(path.join(nativeRoot, "plugins", "omp-plugins.lock.json"), "utf8")).plugins["demo-plugin"].enabled, false);
    await assert.rejects(run({ action: "toggle", scope: "session", kind: "plugin", name: "demo-plugin", enabled: true }, projectDir), /Global|switched/);

    // Refusals leave the configuration as it is.
    const configBefore = await fs.readFile(path.join(agentDir, "config.yml"), "utf8");
    await assert.rejects(run({ action: "toggle", scope: "global", kind: "extension-module", name: "omp-host-control", enabled: false }), /depends on this extension/);
    await assert.rejects(run({ action: "toggle", scope: "global", kind: "builtin-tool", name: "read", enabled: false }), /cannot be switched/);
    await assert.rejects(run({ action: "toggle", scope: "global", kind: "skill", name: "no-such-skill", enabled: false }), /no longer lists/);
    assert.equal(await fs.readFile(path.join(agentDir, "config.yml"), "utf8"), configBefore);

    // A relocated Claude registry (CLAUDE_CONFIG_DIR, as OMP honours it) with an entry bound to the Global folder makes Global refuse.
    const claudeDir = path.join(nativeRoot, "claude-config");
    await write(path.join(claudeDir, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "bound@market": [{ scope: "project", projectPath: neutral, installPath: path.join(claudeDir, "cache"), version: "1" }] } }));
    await assert.rejects(runSettingsWorker({ bunPath, helperPath, packageRoot, cwd: neutral, profile: "default", request: { action: "read", scope: "global" }, env: { ...env, CLAUDE_CONFIG_DIR: claudeDir } }), /project configuration/);
    for (const padded of [`  ${claudeDir}  `, `${claudeDir}${path.sep}..${path.sep}claude-config`]) {
      await assert.rejects(runSettingsWorker({ bunPath, helperPath, packageRoot, cwd: neutral, profile: "default", request: { action: "read", scope: "global" }, env: { ...env, CLAUDE_CONFIG_DIR: padded } }), /project configuration/, "whitespace and unnormalised overrides resolve as OMP resolves them");
    }
    await runSettingsWorker({ bunPath, helperPath, packageRoot, cwd: neutral, profile: "default", request: { action: "read", scope: "global" }, env: { ...env, CLAUDE_CONFIG_DIR: "   " } });

    // A project that sets its own disabledExtensions replaces the global list: no global switch there.
    await write(path.join(projectDir, ".omp", "config.yml"), "disabledExtensions: []\n");
    const overridden = await read("session", projectDir);
    assert.equal(overridden.projectOverridesDisabledExtensions, true);
    assert.equal(row(overridden, "skill", "project-skill").toggle.mechanism, null);
    await assert.rejects(run({ action: "toggle", scope: "session", kind: "skill", name: "project-skill", enabled: false }, projectDir), /cannot be switched/);

    // Global must be user-only: a folder that carries a project layer is refused, not silently merged.
    await assert.rejects(run({ action: "read", scope: "global" }, projectDir), /project configuration/);
  } finally {
    await fs.rm(nativeRoot, { recursive: true, force: true });
    await fs.rm(projectDir, { recursive: true, force: true });
  }
});

/**
 * A project whose `.mcp.json` defines servers and whose `.omp/mcp.json` only switches some of them off
 * (the layout of a project with a local disable): OMP does not merge entries, the higher-priority one owns the name.
 */
test("installed OMP inventory: an MCP name with a definition and a by-name override is one disabled row, and the view is not incomplete", { skip: !available, timeout: 180_000 }, async () => {
  const nativeRoot = await fs.mkdtemp(path.join(os.homedir(), "omp-desk-inventory-test-"));
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-desk-inventory-project-"));
  const write = async (file: string, content: string): Promise<void> => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content); };
  const env = { PI_CONFIG_DIR: path.basename(nativeRoot), PI_CODING_AGENT_DIR: "", PI_CONFIG_FILES: "", OMP_AUTH_BROKER_URL: "", OMP_AUTH_BROKER_TOKEN: "" };
  try {
    await write(path.join(projectDir, ".mcp.json"), JSON.stringify({ mcpServers: {
      unity: { type: "stdio", command: "uvx", args: ["--python", "3.12", "--from", "mcpforunityserver==9.7.1", "mcp-for-unity"], timeout: 600000 },
      "symbols": { type: "stdio", command: "node", args: ["scripts/mcp-start.mjs", "symbols"], directTools: true },
      playwright: { type: "stdio", command: "node", args: ["scripts/mcp-start.mjs", "playwright"], directTools: true },
      omnisharp: { type: "stdio", command: "node", args: ["scripts/mcp-start.mjs", "omnisharp"], directTools: true },
      devtools: { type: "http", url: "http://127.0.0.1:3000/mcp" },
    } }, null, 2));
    await write(path.join(projectDir, ".omp", "mcp.json"), JSON.stringify({ mcpServers: { unity: { enabled: false }, devtools: { enabled: false }, playwright: { enabled: false } } }, null, 2));
    const snapshot = parseSnapshot(await runSettingsWorker({ bunPath, helperPath, packageRoot, cwd: projectDir, profile: "default", request: { action: "read", scope: "session" }, env }));
    assert.ok(snapshot, "the receipt parses as an inventory");
    const servers = snapshot.rows.filter(candidate => candidate.kind === "mcp" && ["unity", "symbols", "playwright", "omnisharp", "devtools"].includes(candidate.name));
    assert.deepEqual(servers.map(server => server.name).sort(), ["devtools", "omnisharp", "playwright", "symbols", "unity"], "one row per name");
    const named = (name: string): InventoryRow => servers.find(server => server.name === name)!;
    for (const name of ["unity", "devtools", "playwright"]) {
      assert.equal(named(name).state, "disabled", name);
      assert.equal(named(name).disabledReason, "entry", name);
      assert.equal(named(name).shadowed, false, name);
      assert.equal(named(name).toggle.mechanism, null, name);
      assert.deepEqual(named(name).sources.map(source => [path.basename(source.path ?? ""), source.role]), [["mcp.json", "disables"], [".mcp.json", "defines"]], name);
      assert.equal(path.basename(named(name).path ?? ""), ".mcp.json", "the row opens the file that defines it");
    }
    assert.equal(named("unity").detail, "stdio · uvx");
    assert.equal(named("playwright").detail, "stdio · node");
    assert.equal(named("devtools").detail, "http · 127.0.0.1:3000");
    for (const name of ["symbols", "omnisharp"]) {
      assert.equal(named(name).state, "active", name);
      assert.equal(named(name).toggle.mechanism, "mcp", name);
    }
    assert.equal(snapshot.incomplete.includes("mcp"), false, "an enabled: false entry is a switch, not a failed source");
  } finally {
    await fs.rm(nativeRoot, { recursive: true, force: true });
    await fs.rm(projectDir, { recursive: true, force: true });
  }
});

/**
 * OMP's precedence for one MCP name (verified against OMP 18.8.5, capability/index.ts and discovery/builtin.ts, mcp-json.ts): the provider's priority first
 * (native `.omp/` and `~/.omp/agent` 100, the standalone `.mcp.json` provider 5), then file order inside the provider (project before user). One name is one
 * row, owned by the first entry; a server another name duplicates connection for connection is the one OMP drops, and the row says which server it loses to.
 */
test("installed OMP inventory: one effective row per MCP name by OMP's precedence, a shadowed alias names its winner", { skip: !available, timeout: 180_000 }, async () => {
  const nativeRoot = await fs.mkdtemp(path.join(os.homedir(), "omp-desk-inventory-test-"));
  const agentDir = path.join(nativeRoot, "agent");
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-desk-inventory-project-"));
  const write = async (file: string, content: unknown): Promise<void> => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify(content)); };
  const env = { PI_CONFIG_DIR: path.basename(nativeRoot), PI_CODING_AGENT_DIR: "", PI_CONFIG_FILES: "", OMP_AUTH_BROKER_URL: "", OMP_AUTH_BROKER_TOKEN: "" };
  try {
    await write(path.join(agentDir, "mcp.json"), { mcpServers: { shared: { type: "stdio", command: "user-cmd" } } });
    await write(path.join(projectDir, ".mcp.json"), { mcpServers: {
      shared: { type: "stdio", command: "project-cmd" },
      layer: { type: "stdio", command: "standalone-cmd" },
      "dup-a": { type: "stdio", command: "same-cmd" },
      "dup-b": { type: "stdio", command: "same-cmd" },
    } });
    await write(path.join(projectDir, ".omp", "mcp.json"), { mcpServers: { layer: { type: "stdio", command: "omp-project-cmd" } } });
    const snapshot = parseSnapshot(await runSettingsWorker({ bunPath, helperPath, packageRoot, cwd: projectDir, profile: "default", request: { action: "read", scope: "session" }, env }));
    assert.ok(snapshot, "the receipt parses as an inventory");
    // Other ecosystems' user-level files of the real home (Claude, Codex, ...) also feed the list; the fixture's names are the ones asserted on.
    const all = snapshot.rows.filter(candidate => candidate.kind === "mcp");
    assert.equal(new Set(all.map(server => server.name)).size, all.length, "no name appears twice in the whole list");
    const servers = all.filter(candidate => ["shared", "layer", "dup-a", "dup-b"].includes(candidate.name));
    assert.deepEqual(servers.map(server => server.name).sort(), ["dup-a", "dup-b", "layer", "shared"], "exactly one row per name");
    const named = (name: string): InventoryRow => servers.find(server => server.name === name)!;
    const files = (name: string): Array<[string, string, string]> => named(name).sources.map(source => [path.basename(path.dirname(source.path ?? "")) === ".omp" ? ".omp/mcp.json" : path.basename(source.path ?? ""), source.level, source.role]);

    // The user-level file of the 100-priority provider beats the project's standalone `.mcp.json` (priority 5): provider before level.
    assert.equal(named("shared").detail, "stdio · user-cmd");
    assert.equal(named("shared").level, "user");
    assert.equal(named("shared").state, "active");
    assert.equal(named("shared").shadowed, false);
    assert.deepEqual(files("shared"), [["mcp.json", "user", "defines"], [".mcp.json", "project", "ignored"]]);
    // Inside one provider the project's `.omp/mcp.json` beats the standalone file.
    assert.equal(named("layer").detail, "stdio · omp-project-cmd");
    assert.equal(named("layer").level, "project");
    assert.deepEqual(files("layer"), [[".omp/mcp.json", "project", "defines"], [".mcp.json", "project", "ignored"]]);
    // Two names with one connection: OMP keeps the first and drops the second, and the row names the survivor.
    assert.equal(named("dup-a").state, "active");
    assert.equal(named("dup-a").shadowedBy, null);
    assert.equal(named("dup-b").state, "shadowed");
    assert.equal(named("dup-b").shadowed, true);
    assert.equal(named("dup-b").shadowedBy, "dup-a");
    assert.equal(named("dup-b").toggle.mechanism, null);
    assert.equal(snapshot.incomplete.includes("mcp"), false);
  } finally {
    await fs.rm(nativeRoot, { recursive: true, force: true });
    await fs.rm(projectDir, { recursive: true, force: true });
  }
});

test("installed OMP inventory: an unreadable MCP file marks the list incomplete and names the file and OMP's reason", { skip: !available, timeout: 180_000 }, async () => {
  const nativeRoot = await fs.mkdtemp(path.join(os.homedir(), "omp-desk-inventory-test-"));
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-desk-inventory-project-"));
  const env = { PI_CONFIG_DIR: path.basename(nativeRoot), PI_CODING_AGENT_DIR: "", PI_CONFIG_FILES: "", OMP_AUTH_BROKER_URL: "", OMP_AUTH_BROKER_TOKEN: "" };
  try {
    await fs.writeFile(path.join(projectDir, ".mcp.json"), "{ \"mcpServers\": { broken");
    await fs.mkdir(path.join(projectDir, ".omp"), { recursive: true });
    await fs.writeFile(path.join(projectDir, ".omp", "mcp.json"), JSON.stringify({ mcpServers: { ok: { type: "stdio", command: "ok-cmd" } } }));
    const snapshot = parseSnapshot(await runSettingsWorker({ bunPath, helperPath, packageRoot, cwd: projectDir, profile: "default", request: { action: "read", scope: "session" }, env }));
    assert.ok(snapshot, "the receipt parses as an inventory");
    assert.ok(snapshot.rows.some(candidate => candidate.kind === "mcp" && candidate.name === "ok"), "the readable file still lists its server");
    assert.equal(snapshot.incomplete.includes("mcp"), true);
    const reasons = snapshot.incompleteReasons.filter(entry => entry.view === "mcp").map(entry => entry.reason);
    const ours = reasons.filter(reason => /Failed to parse JSON in .*\.mcp\.json/.test(reason));
    assert.equal(ours.length, 1, `the broken file is named once, with what failed: ${reasons.join(" | ")}`);
    assert.equal(snapshot.incomplete.includes("skills"), false, "another view is not blamed");
  } finally {
    await fs.rm(nativeRoot, { recursive: true, force: true });
    await fs.rm(projectDir, { recursive: true, force: true });
  }
});
