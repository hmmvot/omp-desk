import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { runSettingsWorker } from "../host/omp-settings-worker.ts";
import { isRecord as record } from "../shared/guards.ts";

/**
 * The Models and Agents editors' worker (`/agents` in Chat) against the installed OMP, in the two layouts a package manager can leave it in.
 *
 * `bun install -g` puts `@oh-my-pi/pi-utils` and the other dependencies beside `pi-coding-agent`. `npm install -g` puts them inside it,
 * with nothing beside it. The npm layout is rebuilt here from the installed package without installing anything: a `pi-coding-agent`
 * folder of links to the installed package's own files, plus the `node_modules/@oh-my-pi` links an npm install has inside it.
 */
const packageRoot = process.env.OMP_SETTINGS_TEST_PACKAGE_ROOT ?? path.join(os.homedir(), ".bun", "install", "global", "node_modules", "@oh-my-pi", "pi-coding-agent");
const bunPath = process.env.OMP_SETTINGS_TEST_BUN ?? path.join(os.homedir(), ".bun", "bin", process.platform === "win32" ? "bun.exe" : "bun");
const helperPath = fileURLToPath(new URL("./settings-worker.ts", import.meta.url));
const available = existsSync(packageRoot) && existsSync(bunPath) && existsSync(path.join(path.dirname(packageRoot), "pi-utils"));

/** The names of the agents the worker's snapshot lists. */
async function agentNames(root: string, scratch: string): Promise<string[]> {
  const agent = path.join(scratch, "agent");
  const cwd = path.join(scratch, "project");
  await fs.mkdir(agent, { recursive: true });
  await fs.mkdir(cwd, { recursive: true });
  const receipt = await runSettingsWorker({
    bunPath, helperPath, packageRoot: root, cwd, profile: "default", request: { action: "read" },
    env: { PI_CODING_AGENT_DIR: agent, PI_CONFIG_FILES: "", OMP_AUTH_BROKER_URL: "", OMP_AUTH_BROKER_TOKEN: "" },
  });
  assert.ok(record(receipt) && record(receipt.snapshot) && Array.isArray(receipt.snapshot.agents), "the worker returns a snapshot with agents");
  return receipt.snapshot.agents.map((item: unknown) => (record(item) ? String(item.name) : "")).sort();
}

test("lists the same agents from an npm-style install, whose dependencies are inside the package, as from a Bun-style one", { skip: !available && "no installed OMP with Bun to read", timeout: 240_000 }, async () => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "omp-agents-layout-"));
  try {
    const beside = await agentNames(packageRoot, path.join(scratch, "bun"));
    assert.ok(beside.length > 0, "OMP bundles agents, so the list is not empty");

    const nested = path.join(scratch, "npm", "node_modules", "@oh-my-pi", "pi-coding-agent");
    await fs.mkdir(path.join(nested, "node_modules", "@oh-my-pi"), { recursive: true });
    await fs.copyFile(path.join(packageRoot, "package.json"), path.join(nested, "package.json"));
    await fs.symlink(path.join(packageRoot, "src"), path.join(nested, "src"), "junction");
    for (const dependency of ["pi-utils", "pi-ai", "pi-catalog", "pi-tui"]) {
      await fs.symlink(path.join(path.dirname(packageRoot), dependency), path.join(nested, "node_modules", "@oh-my-pi", dependency), "junction");
    }
    assert.equal(existsSync(path.join(path.dirname(nested), "pi-utils")), false, "nothing sits beside the package, as in an npm install");

    assert.deepEqual(await agentNames(nested, path.join(scratch, "npm-run")), beside);
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
});
