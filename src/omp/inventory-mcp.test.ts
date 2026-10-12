import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { excusedEntryWarnings, foldMcpServer } from "./inventory-mcp.ts";
import type { McpEntry, McpFoldHooks } from "./inventory-mcp.ts";

/** The entries OMP's dashboard loader returned for a project folder: `.omp/mcp.json` (OMP, priority 100) before `.mcp.json` (MCP Config, priority 5). */
const OVERRIDE = "D:\\project\\.omp\\mcp.json";
const DEFINITIONS = "D:\\project\\.mcp.json";
const base = { level: "project" as const, state: "disabled" as const };
const override = (name: string, shadowed: boolean): McpEntry => ({ ...base, name, path: OVERRIDE, provider: "native", providerName: "OMP", disabledReason: "item-disabled", shadowed, enabled: false, defines: false, raw: { enabled: false } });
const definition = (name: string, raw: Record<string, unknown>): McpEntry => ({ ...base, name, path: DEFINITIONS, provider: "mcp-json", providerName: "MCP Config", state: "shadowed", disabledReason: "shadowed", shadowed: true, enabled: undefined, defines: true, raw });
const projectDefinitions: Record<string, Record<string, unknown>> = {
  unity: { type: "stdio", command: "uvx", args: ["--python", "3.12"], timeout: 600000 },
  playwright: { type: "stdio", command: "node", args: ["scripts/mcp-start.mjs", "playwright"] },
  devtools: { type: "http", url: "http://127.0.0.1:3000/mcp" },
};
const hooks = (over: Partial<McpFoldHooks> = {}): McpFoldHooks => ({
  detail: raw => typeof raw.url === "string" ? `http · ${new URL(raw.url).host}` : `stdio · ${String(raw.command)}`,
  toolPrefix: name => `mcp__${name}_`,
  switchOf: () => ({ mechanism: "mcp", refusal: null }),
  excludedByProject: false,
  shadowedBy: () => null,
  ...over,
});

describe("one row per MCP server name", () => {
  // The three overrides as OMP flagged them: unity is the first partial entry; devtools and playwright are marked
  // shadowed because OMP treats two connection-less stdio entries as equivalent (capability/index.ts).
  const cases: Array<[string, boolean]> = [["unity", false], ["devtools", true], ["playwright", true]];
  for (const [name, flagged] of cases) {
    it(`${name}: the project override and the shared definition fold into one disabled row with the definition's command or url`, () => {
      const { row, ownerDisabledByFlag } = foldMcpServer([override(name, flagged), definition(name, projectDefinitions[name]!)], hooks());
      assert.equal(row.name, name);
      assert.equal(row.state, "disabled");
      assert.equal(row.disabledReason, "entry");
      assert.equal(row.shadowed, false, "an override is not a shadowed peer");
      assert.equal(row.detail, name === "devtools" ? "http · 127.0.0.1:3000" : name === "unity" ? "stdio · uvx" : "stdio · node");
      assert.equal(row.path, DEFINITIONS, "a click opens the file that defines the server");
      assert.equal(row.providerName, "MCP Config");
      assert.deepEqual(row.sources.map(source => [source.path, source.role]), [[OVERRIDE, "disables"], [DEFINITIONS, "defines"]]);
      assert.deepEqual(row.toggle.mechanism, null);
      assert.match(row.toggle.refusal!, /mcp\.json sets enabled: false for it without defining it/);
      assert.equal(ownerDisabledByFlag, false);
    });
  }
  it("a server only the shared file defines keeps its definition, state and ordinary switch", () => {
    const entry: McpEntry = { ...base, name: "symbols", path: DEFINITIONS, provider: "mcp-json", providerName: "MCP Config", state: "active", disabledReason: null, shadowed: false, enabled: undefined, defines: true, raw: { type: "stdio", command: "node" } };
    const { row } = foldMcpServer([entry], hooks());
    assert.equal(row.state, "active");
    assert.deepEqual(row.toggle, { mechanism: "mcp", refusal: null });
    assert.deepEqual(row.sources.map(source => source.role), ["defines"]);
  });
  it("a lower full definition under a full owner is an ignored source, not a second row", () => {
    const owner: McpEntry = { ...base, name: "s", path: "C:/a/mcp.json", provider: "native", providerName: "OMP", state: "active", disabledReason: null, shadowed: false, enabled: undefined, defines: true, raw: { command: "a" } };
    const lower: McpEntry = { ...owner, path: "C:/b/.mcp.json", provider: "mcp-json", providerName: "MCP Config", state: "shadowed", shadowed: true, raw: { command: "b" } };
    const { row } = foldMcpServer([owner, lower], hooks());
    assert.equal(row.detail, "stdio · a");
    assert.equal(row.state, "active");
    assert.deepEqual(row.sources.map(source => source.role), ["defines", "ignored"]);
  });
  it("a project disable by id keeps the refusal, and an owner flagged enabled: false asks for a force-enable", () => {
    const owner: McpEntry = { ...base, name: "s", path: "C:/a/mcp.json", provider: "native", providerName: "OMP", state: "disabled", disabledReason: "item-disabled", shadowed: false, enabled: false, defines: true, raw: { command: "a", enabled: false } };
    const folded = foldMcpServer([owner], hooks({ excludedByProject: true }));
    assert.match(folded.row.toggle.refusal!, /project's config disables it by name/);
    assert.equal(folded.ownerDisabledByFlag, true);
    assert.deepEqual(foldMcpServer([owner], hooks()).row.toggle, { mechanism: "mcp", refusal: null });
  });
  it("an owner without command, url or enabled: false leaves nothing loaded and says so", () => {
    const owner: McpEntry = { ...override("x", false), enabled: undefined, raw: { timeout: 5 } };
    const { row } = foldMcpServer([owner], hooks());
    assert.equal(row.disabledReason, "invalid-entry");
    assert.equal(row.detail, "no command or url");
    assert.match(row.toggle.refusal!, /no command or url/);
  });
  it("an owner OMP dropped for an equivalent connection is a shadowed row that names the server OMP keeps", () => {
    const owner: McpEntry = { ...base, name: "devtools-copy", path: DEFINITIONS, provider: "mcp-json", providerName: "MCP Config", state: "shadowed", disabledReason: "shadowed", shadowed: true, enabled: undefined, defines: true, raw: projectDefinitions.devtools! };
    const { row } = foldMcpServer([owner], hooks({ shadowedBy: entry => entry === owner ? "devtools" : null }));
    assert.equal(row.shadowed, true);
    assert.equal(row.shadowedBy, "devtools");
    assert.equal(row.toggle.mechanism, null);
    assert.match(row.toggle.refusal!, /OMP keeps the server devtools, which has the same command or url/);
  });
  it("a live owner is never marked as shadowed, whatever the hook would say", () => {
    const owner: McpEntry = { ...base, name: "s", path: DEFINITIONS, provider: "mcp-json", providerName: "MCP Config", state: "active", disabledReason: null, shadowed: false, enabled: undefined, defines: true, raw: { command: "a" } };
    const { row } = foldMcpServer([owner], hooks({ shadowedBy: () => "x" }));
    assert.equal(row.shadowedBy, null);
  });
  it("the whole omp-vscode entry set (three overrides over five definitions) yields five rows and none shadowed", () => {
    const all: McpEntry[] = [
      override("unity", false), override("devtools", true), override("playwright", true),
      definition("unity", projectDefinitions.unity!), definition("playwright", projectDefinitions.playwright!), definition("devtools", projectDefinitions.devtools!),
      { ...definition("symbols", { command: "node" }), state: "active", disabledReason: null, shadowed: false },
      { ...definition("omnisharp", { command: "node" }), state: "active", disabledReason: null, shadowed: false },
    ];
    const byName = new Map<string, McpEntry[]>();
    for (const entry of all) byName.set(entry.name, [...(byName.get(entry.name) ?? []), entry]);
    const rows = [...byName.values()].map(entries => foldMcpServer(entries, hooks()).row);
    assert.deepEqual(rows.map(row => row.name).sort(), ["devtools", "playwright", "symbols", "omnisharp", "unity"]);
    assert.equal(rows.filter(row => row.shadowed || row.state === "shadowed").length, 0);
  });
});

describe("warnings for by-name switches", () => {
  const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
  const invalid = `[OMP] Invalid item at ${OVERRIDE}: Must have command or url`;
  const entries = [override("unity", false), override("devtools", true), override("playwright", true), definition("unity", projectDefinitions.unity!)];
  it("does not count OMP's validation of an enabled: false entry as a failed source", () => {
    assert.deepEqual(excusedEntryWarnings([invalid, "[VS Code] Failed to read X"], entries, same), ["[VS Code] Failed to read X"]);
  });
  it("keeps the warning when more entries failed than there are by-name switches in that file", () => {
    assert.deepEqual(excusedEntryWarnings([invalid, invalid], entries.slice(0, 1), same), [invalid, invalid]);
  });
  it("keeps the warning of an entry that is not an enabled: false switch", () => {
    assert.deepEqual(excusedEntryWarnings([invalid], [{ ...override("unity", false), enabled: undefined }], same), [invalid]);
  });
});
