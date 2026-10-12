import { defineConfig } from "@playwright/test";
import { join } from "node:path";

const results = join(__dirname, "..", "..", "out", "e2e-results");

/**
 * The browser is not launched by Playwright: global setup starts VS Code on a hidden Windows desktop through
 * scripts/test-vscode.ps1 and the tests attach with `chromium.connectOverCDP`. One worker, files run in name order:
 * every scenario shares the one VS Code profile and some need it in a known state.
 */
export default defineConfig({
	testDir: join(__dirname, "scenarios"),
	outputDir: join(results, "artifacts"),
	globalSetup: join(__dirname, "global-setup.ts"),
	workers: 1,
	fullyParallel: false,
	retries: 0,
	// The machine running the suite is often CPU-saturated: only the budgets a scenario defines are strict.
	timeout: 180_000,
	expect: { timeout: 30_000 },
	reporter: [["list"], ["json", { outputFile: join(results, "report.json") }]],
});
