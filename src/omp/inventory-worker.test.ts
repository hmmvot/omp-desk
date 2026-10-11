import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runSettingsWorker } from "../host/omp-settings-worker.ts";
import { parseSnapshot } from "../host/inventory/inventory-runtime.ts";
import { BUILTIN_SWITCHES } from "./inventory-switches.ts";
import type { InventoryRow, InventorySnapshot } from "../host/inventory/inventory-model.ts";

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
    assert.deepEqual(await run({ action: "toggle", scope: "global", kind: "skill", name: "custom-one", enabled: false }), { changed: true });
    assert.equal(row(await read("global"), "skill", "custom-one").state, "disabled");
    assert.deepEqual(await run({ action: "toggle", scope: "global", kind: "skill", name: "custom-one", enabled: true }), { changed: true });
    assert.equal(row(await read("global"), "skill", "custom-one").state, "active");

    // A malformed existing VS Code MCP config is an omission, not an empty list.
    await write(path.join(projectDir, ".vscode", "mcp.json"), "{ not json");
    assert.ok((await read("session", projectDir)).incomplete.includes("mcp"), "a skipped malformed source marks the view incomplete");
    await fs.rm(path.join(projectDir, ".vscode"), { recursive: true });

    // A custom-directory skill that collides with a disabled native skill has no effective runtime name.
    await write(path.join(nativeRoot, "custom-skills", "dup", "SKILL.md"), "---\nname: demo-skill\ndescription: Colliding custom copy\n---\nbody\n");
    assert.deepEqual(await run({ action: "toggle", scope: "global", kind: "skill", name: "demo-skill", enabled: false }), { changed: true });
    const collided = (await read("global")).rows.filter(candidate => candidate.kind === "skill" && candidate.path?.includes("custom-skills"));
    assert.equal(collided.some(candidate => candidate.name === "demo-skill" && candidate.runtimeName !== null), false, "disabled by raw name: not an effective skill");
    assert.deepEqual(await run({ action: "toggle", scope: "global", kind: "skill", name: "demo-skill", enabled: true }), { changed: true });

    // Session scope sees the project's own skill and read-only project state.
    const session = await read("session", projectDir);
    assert.equal(row(session, "skill", "project-skill").level, "project");
    assert.equal(row(session, "plugin", "demo-plugin").toggle.mechanism, null, "plugins switch only from Global");

    // Global switches write the isolated user configuration and nothing else.
    assert.deepEqual(await run({ action: "toggle", scope: "global", kind: "skill", name: "demo-skill", enabled: false }), { changed: true });
    assert.deepEqual(await run({ action: "toggle", scope: "global", kind: "skill", name: "demo-skill", enabled: false }), { changed: false });
    assert.deepEqual(await run({ action: "toggle", scope: "global", kind: "extension-module", name: "demo-ext", enabled: false }), { changed: true });
    assert.deepEqual(await run({ action: "toggle", scope: "global", kind: "builtin-tool", name: "ast_grep", enabled: true }), { changed: true });
    const config = await fs.readFile(path.join(agentDir, "config.yml"), "utf8");
    assert.match(config, /skill:demo-skill/);
    assert.match(config, /extension-module:demo-ext/);
    assert.match(config, /unrelated:\s+keep: 1/, "unrelated keys survive");
    const after = await read("global");
    assert.equal(row(after, "skill", "demo-skill").state, "disabled");
    assert.equal(row(after, "builtin-tool", "ast_grep").state, "active");
    assert.deepEqual(await run({ action: "toggle", scope: "global", kind: "skill", name: "demo-skill", enabled: true }), { changed: true });
    assert.doesNotMatch(await fs.readFile(path.join(agentDir, "config.yml"), "utf8"), /skill:demo-skill/);

    // MCP: user-level denylist by name, per-entry flags and the server definitions untouched; re-enable clears it.
    const mcpBefore = JSON.parse(await fs.readFile(path.join(agentDir, "mcp.json"), "utf8")) as { mcpServers: Record<string, unknown> };
    assert.deepEqual(await run({ action: "toggle", scope: "global", kind: "mcp", name: "demo-mcp", enabled: false }), { changed: true });
    const mcpDisabled = JSON.parse(await fs.readFile(path.join(agentDir, "mcp.json"), "utf8")) as { mcpServers: Record<string, unknown>; disabledServers?: string[] };
    assert.deepEqual(mcpDisabled.disabledServers, ["demo-mcp"]);
    assert.deepEqual(mcpDisabled.mcpServers, mcpBefore.mcpServers);
    assert.equal(row(await read("global"), "mcp", "demo-mcp").state, "disabled");
    assert.deepEqual(await run({ action: "toggle", scope: "global", kind: "mcp", name: "demo-mcp", enabled: true }), { changed: true });
    assert.equal(row(await read("global"), "mcp", "demo-mcp").state, "active");

    // A project-defined server is disabled by name from the user file; the project file is untouched.
    await write(path.join(projectDir, ".omp", "mcp.json"), JSON.stringify({ mcpServers: { "project-mcp": { type: "stdio", command: "node" } } }));
    const projectMcpBefore = await fs.readFile(path.join(projectDir, ".omp", "mcp.json"), "utf8");
    assert.deepEqual(await run({ action: "toggle", scope: "session", kind: "mcp", name: "project-mcp", enabled: false }, projectDir), { changed: true });
    assert.equal(await fs.readFile(path.join(projectDir, ".omp", "mcp.json"), "utf8"), projectMcpBefore);
    assert.equal(row(await read("session", projectDir), "mcp", "project-mcp").state, "disabled");

    // Plugin: OMP's own lock file in the isolated root.
    assert.deepEqual(await run({ action: "toggle", scope: "global", kind: "plugin", name: "demo-plugin", enabled: false }), { changed: true });
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
