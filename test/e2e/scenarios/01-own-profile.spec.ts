/**
 * The test window reads its own OMP profile, not the user's. OMP finds the user-level agents it hands to subagents in
 * `~/.omp/agent/agents` (the home folder, not `PI_CODING_AGENT_DIR`), so the launcher gives the window its own home folder
 * (`-IsolateHome`); the Agents editor then lists OMP's bundled agents and nothing else (see support/profile-guard.ts).
 */
import { test } from "../support/fixtures.ts";
import { agentSourceLabels, expectOwnProfile, openAgentsEditor } from "../support/profile-guard.ts";

test("the Agents editor lists only OMP's bundled agents: no agent of the real profile is read", async ({ desk }) => {
	const page = await desk.window("alpha-desk");
	await desk.ready(page);
	await openAgentsEditor(page);
	expectOwnProfile(await agentSourceLabels(page), 0);
	// A middle click closes the tab, so the editor groups are as the next scenario expects them.
	await page.getByRole("tab", { name: /^OMP Agents/ }).click({ button: "middle" });
});
