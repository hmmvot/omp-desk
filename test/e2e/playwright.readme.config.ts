import { defineConfig } from "@playwright/test";
import { join } from "node:path";

// The README screenshots (`npm run readme:screenshots`) run the end-to-end harness on the README scene instead of the
// plain fixture workspaces: global setup reads these variables (see readme/scene.ts). The run has its own results folder and its
// own test-environment root, so it neither shares state files with a suite run nor sweeps (or is swept by) its environments;
// the root is short because the staged PTY runtime needs room under the 260-character path limit.
process.env.E2E_SCENE = "readme";
const results = join(__dirname, "..", "..", "out", "readme-results");
process.env.E2E_RESULTS_DIR = results;
process.env.E2E_ROOT ??= join(process.env.LOCALAPPDATA ?? "", "odt-readme");

/** Same global setup (hidden desktop, guards, VSIX) as the suite; one spec that captures the images. */
export default defineConfig({
	testDir: join(__dirname, "readme"),
	testMatch: "*.spec.ts",
	outputDir: join(results, "readme-artifacts"),
	globalSetup: join(__dirname, "global-setup.ts"),
	workers: 1,
	fullyParallel: false,
	retries: 0,
	timeout: 600_000,
	expect: { timeout: 60_000 },
	reporter: [["list"]],
});
