import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { loadRecording, RECORDING_URL } from "./config-schema-fixture.ts";
import { VERIFIED_OMP_VERSION } from "./config-schema.ts";

/**
 * The installed OMP against what this editor was written for. `UPDATE_OMP_SCHEMA_FIXTURE=1` rewrites the recording
 * after a deliberate review of what changed.
 */
const packageRoot = process.env.OMP_SETTINGS_TEST_PACKAGE_ROOT ?? path.join(os.homedir(), ".bun", "install", "global", "node_modules", "@oh-my-pi", "pi-coding-agent");
const bunPath = process.env.OMP_SETTINGS_TEST_BUN ?? path.join(os.homedir(), ".bun", "bin", process.platform === "win32" ? "bun.exe" : "bun");
const available = existsSync(packageRoot) && existsSync(bunPath);
const run = (script: string): string => {
  const result = spawnSync(bunPath, [fileURLToPath(new URL(script, import.meta.url)), packageRoot], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 120_000 });
  assert.equal(result.status, 0, `${script} failed: ${result.stderr.slice(0, 600)}`);
  return result.stdout;
};
const installedVersion = (): string => (JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8")) as { version: string }).version;

test("the version the editor reports as verified is the one the committed recording was made from", () => {
  assert.equal(VERIFIED_OMP_VERSION, loadRecording().version);
});

test("the installed OMP's settings schema is the committed recording (changes need a review of the projection)", { skip: !available, timeout: 130_000 }, () => {
  const live = JSON.parse(run("./config-schema-recorder.ts")) as { version: string };
  const recorded = JSON.parse(readFileSync(RECORDING_URL, "utf8")) as { version: string };
  if (process.env.UPDATE_OMP_SCHEMA_FIXTURE === "1") { writeFileSync(RECORDING_URL, JSON.stringify(live)); return; }
  assert.deepEqual({ ...live, version: "" }, { ...recorded, version: "" },
    `OMP ${live.version}'s settings schema differs from the recording of OMP ${recorded.version}. Review what changed, then rerun with UPDATE_OMP_SCHEMA_FIXTURE=1.`);
});

test("the editor's visibility rules give OMP's own answers for every conditioned setting", { skip: !available, timeout: 130_000 }, () => {
  const result = JSON.parse(run("./config-conditions-probe.ts")) as { unknown: string[]; unused: string[]; missingInputs: string[]; mismatches: string[]; checked: number };
  assert.deepEqual(result.unknown, [], "every condition name OMP uses has a rule");
  assert.deepEqual(result.unused, [], "no rule is dead");
  assert.deepEqual(result.missingInputs, [], "every setting a rule reads exists");
  assert.deepEqual(result.mismatches, []);
  assert.ok(result.checked > 100, "the sweep compared OMP's predicates");
});
