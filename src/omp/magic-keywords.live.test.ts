import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The installed OMP's magic keywords against the recording `src/shared/magic-keywords.ts` was written for. A difference means OMP
 * changed (a keyword, a boundary rule, the mask, the gradient): review it against the shared module, then
 * `UPDATE_OMP_MAGIC_KEYWORDS_FIXTURE=1` rewrites the recording.
 */
const packageRoot = process.env.OMP_SETTINGS_TEST_PACKAGE_ROOT ?? path.join(os.homedir(), ".bun", "install", "global", "node_modules", "@oh-my-pi", "pi-coding-agent");
const bunPath = process.env.OMP_SETTINGS_TEST_BUN ?? path.join(os.homedir(), ".bun", "bin", process.platform === "win32" ? "bun.exe" : "bun");
const available = existsSync(packageRoot) && existsSync(bunPath);
const RECORDING_URL = new URL("./fixtures/omp-magic-keywords.json", import.meta.url);

const record = (): { version: string } => {
  const script = fileURLToPath(new URL("./magic-keywords-recorder.ts", import.meta.url));
  const result = spawnSync(bunPath, [script, packageRoot], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 120_000 });
  assert.equal(result.status, 0, `magic-keywords-recorder.ts failed: ${result.stderr.slice(0, 600)}`);
  return JSON.parse(result.stdout) as { version: string };
};

test("the installed OMP's magic keywords are the committed recording (changes need a review of src/shared/magic-keywords.ts)", { skip: !available, timeout: 130_000 }, () => {
  const live = record();
  if (process.env.UPDATE_OMP_MAGIC_KEYWORDS_FIXTURE === "1") { writeFileSync(RECORDING_URL, JSON.stringify(live)); return; }
  const recorded = JSON.parse(readFileSync(RECORDING_URL, "utf8")) as { version: string };
  assert.deepEqual({ ...live, version: "" }, { ...recorded, version: "" },
    `OMP ${live.version}'s magic keywords differ from the recording of OMP ${recorded.version}. Review what changed against src/shared/magic-keywords.ts, then rerun with UPDATE_OMP_MAGIC_KEYWORDS_FIXTURE=1.`);
});
