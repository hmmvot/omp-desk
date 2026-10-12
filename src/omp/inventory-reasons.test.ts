import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OMISSION, projectFailure, projectWarning } from "./inventory-reasons.ts";

describe("failure reasons for the incomplete banner", () => {
  it("keeps the provider and the local file of the shapes OMP's MCP providers raise", () => {
    assert.equal(projectWarning("[MCP Config] Failed to parse JSON in D:\\project\\.mcp.json"), "[MCP Config] Failed to parse JSON in D:\\project\\.mcp.json");
    assert.equal(projectWarning("[VS Code] Invalid JSON in C:/p/.vscode/mcp.json"), "[VS Code] Invalid JSON in C:/p/.vscode/mcp.json");
    assert.equal(projectWarning("[Cursor] C:/Users/u/.cursor/mcp.json: invalid JSON"), "[Cursor] Invalid JSON in C:/Users/u/.cursor/mcp.json");
    assert.equal(projectWarning("[OMP] Invalid item at D:\\p\\.omp\\mcp.json: Must have command or url"), "[OMP] Invalid item at D:\\p\\.omp\\mcp.json: Must have command or url");
    assert.equal(projectWarning("[OMP] Failed to parse /home/u/.omp/plugins/installed_plugins.json"), "[OMP] Failed to parse /home/u/.omp/plugins/installed_plugins.json");
  });

  it("never forwards a payload OMP interpolates: plugin ids, URLs, parser text, server names, validator text it did not write", () => {
    const secrets = [
      "[Claude Code Marketplace] Invalid plugin ID format (missing @marketplace): https://host/p?token=SECRET",
      "[Claude Code Marketplace] Plugin tok-SECRET@m entry has no installPath",
      "[OMP] Failed to load: Error: connect ECONNREFUSED https://user:SECRET@host/x?key=SECRET",
      "[Skills] Failed to parse C:/s/SKILL.md: SyntaxError: Unexpected token SECRET in JSON",
      "[OMP] Invalid item at https://host/x?token=SECRET: Must have command or url",
      "[OMP] Invalid item at D:\\p\\mcp.json: header Authorization: Bearer SECRET is not allowed",
      "[claude-plugins] Skipping MCP server \"tok-SECRET\" in D:\\p\\.mcp.json: malformed env",
      "[Gemini CLI] Invalid config for server \"SECRET\" in D:\\u\\settings.json",
      "Failed to parse JSON in https://host/p?token=SECRET",
      "[OMP] Failed to load\n\u0007 SECRET",
    ];
    for (const raw of secrets) assert.doesNotMatch(projectWarning(raw), /SECRET|ECONNREFUSED|SyntaxError|Bearer/, raw);
  });

  it("falls back to a category with no payload, and says where the cause is", () => {
    assert.equal(projectWarning("[Claude Code Marketplace] Invalid plugin ID format (missing @marketplace): x"), "[Claude Code Marketplace] a plugin entry is invalid (details are in OMP's own log)");
    assert.equal(projectWarning("[OMP] Failed to load: boom"), "[OMP] failed to load (details are in OMP's own log)");
    assert.equal(projectWarning("Invalid config for server \"x\" in C:/p/a.json"), "reported a problem loading its sources (details are in OMP's own log)");
  });

  it("is one bounded line", () => {
    const long = projectWarning(`[MCP Config] Failed to parse JSON in C:/${"d/".repeat(300)}x.json`);
    assert.ok(long.length <= 300);
    assert.doesNotMatch(projectWarning("[A] Failed to load\n\tline two"), /[\n\t]/);
  });

  it("names a thrown loader by error class, not by message", () => {
    assert.equal(projectFailure("OMP's mcps loader", new TypeError("token=SECRET")), "OMP's mcps loader failed (TypeError; details are in OMP's own log)");
    assert.equal(projectFailure("OMP's mcps loader", "SECRET"), "OMP's mcps loader failed (error; details are in OMP's own log)");
    assert.equal(projectFailure("x", Object.assign(new Error("m"), { name: "Weird name SECRET" })), "x failed (error; details are in OMP's own log)");
  });

  it("recognises the warnings that make a list incomplete and ignores a missing optional file", () => {
    for (const warning of ["[MCP Config] Failed to parse JSON in x", "[OMP] Invalid item at x: y", "Invalid plugin ID format", "Plugin a entry has no installPath", "Invalid JSON in x"]) assert.match(warning, OMISSION);
    assert.doesNotMatch("[VS Code] Failed to read C:/p/.vscode/mcp.json", OMISSION);
  });
});
