import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ROLE_NOTES } from "../protocol/role-notes.ts";

const packageRoot = process.env.OMP_SETTINGS_TEST_PACKAGE_ROOT ?? path.join(os.homedir(), ".bun", "install", "global", "node_modules", "@oh-my-pi", "pi-coding-agent");
const bunPath = process.env.OMP_SETTINGS_TEST_BUN ?? path.join(os.homedir(), ".bun", "bin", process.platform === "win32" ? "bun.exe" : "bun");
const probe = fileURLToPath(new URL("./resolution-chain.probe.ts", import.meta.url));

test("the followed-role probe agrees with the installed OMP for every combination of set roles", { skip: !existsSync(packageRoot) || !existsSync(bunPath), timeout: 120_000 }, () => {
  const output = execFileSync(bunPath, [probe, packageRoot], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const line = output.split(/\r?\n/).findLast(item => item.startsWith("CHAIN_PROBE "));
  assert.ok(line, "the probe reports");
  const report = JSON.parse(line.slice("CHAIN_PROBE ".length)) as { checked: number; problems: string[]; lists: Record<string, boolean>; advisor: { consulted: string[]; used: string }; memory: { consulted: string[]; used: string } };
  assert.deepEqual(report.problems, []);
  assert.ok(report.checked > 500);
  // Nothing set: advisor only ever consults slow (never default), memory consults the whole chain.
  assert.deepEqual(report.advisor, { consulted: ["slow"], used: "builtin" });
  assert.deepEqual(report.memory, { consulted: ["tiny", "smol", "default"], used: "builtin" });
  // The unassigned-role table (item 6) lists a built-in list exactly where OMP ships one.
  for (const [id, note] of Object.entries(ROLE_NOTES)) assert.equal(report.lists[id], note.list, `built-in list of ${id}`);
});
