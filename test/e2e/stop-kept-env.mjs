// Ends the VS Code that an `E2E_KEEP_ENV=1` run left running and deletes its profile: `npm run test:e2e:stop`.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const kept = join(repo, "out", "e2e-results", "kept-env.json");
if (!existsSync(kept)) {
	console.log("No kept end-to-end environment.");
	process.exit(0);
}
const state = JSON.parse(readFileSync(kept, "utf8"));
const result = spawnSync("powershell.exe", [
	"-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
	"-File", join(repo, "scripts", "test-vscode.ps1"), "-Name", state.name, "-Root", state.root, "-Stop",
], { cwd: repo, stdio: "inherit" });
if (result.status !== 0) process.exit(result.status ?? 1);
rmSync(state.base, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
rmSync(kept, { force: true });
console.log(`Removed ${state.name}.`);
