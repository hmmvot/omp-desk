import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { claudeRegistryBindsFolder } from "./inventory-guards.ts";

const registry = (entry: Record<string, unknown>) => ({ version: 2, plugins: { "p@m": [entry] } });

describe("Global folder provenance", () => {
  it("detects a project- or local-scoped Claude entry bound to the folder, ignoring case and separators", () => {
    assert.equal(claudeRegistryBindsFolder(registry({ scope: "project", projectPath: "C:\\", installPath: "C:/cache/p" }), "c:/"), true);
    assert.equal(claudeRegistryBindsFolder(registry({ scope: "local", projectPath: "D:/Work/Proj/", installPath: "x" }), "d:\\work\\proj"), true);
  });
  it("compares physical identities when given a canonicalizer (junction or symlink aliases)", () => {
    const canonical = (resolved: string): string => resolved.toLowerCase().replace("alias", "real");
    assert.equal(claudeRegistryBindsFolder(registry({ scope: "project", projectPath: "D:/real/proj", installPath: "x" }), "D:/alias/proj", canonical), true);
    assert.equal(claudeRegistryBindsFolder(registry({ scope: "project", projectPath: "D:/real/proj", installPath: "x" }), "D:/alias/proj"), false);
  });
  it("ignores user-scoped entries, other folders and malformed registries", () => {
    assert.equal(claudeRegistryBindsFolder(registry({ scope: "user", projectPath: "C:/", installPath: "x" }), "C:/"), false);
    assert.equal(claudeRegistryBindsFolder(registry({ scope: "project", projectPath: "D:/other", installPath: "x" }), "C:/"), false);
    assert.equal(claudeRegistryBindsFolder(registry({ scope: "project", installPath: "x" }), "C:/"), false);
    for (const bad of [null, "x", {}, { plugins: [] }, { plugins: { a: "b" } }]) assert.equal(claudeRegistryBindsFolder(bad, "C:/"), false);
  });
});
