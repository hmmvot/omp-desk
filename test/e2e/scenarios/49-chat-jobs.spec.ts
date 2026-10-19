/**
 * Scenario: the Jobs row cancels a real background job (docs/designs/2026-10-19-chat-background-jobs.md). A real `omp` on the mock
 * model starts a real `async` bash job (the mock's `[bg:<command>]` marker); the job is a node process that records its own pid.
 * Cancel in the Jobs row sends OMP's own `/jobs kill <id>`: OMP answers `Cancelled background job <id>.`, the card's chip says
 * `cancelled`, the row goes once OMP has nothing pending, and the child process is really gone. The command is a builtin of OMP: it
 * never becomes a message to the model.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { RecordedRequest } from "../fixtures/mock-openai-server.ts";
import { expect, test } from "../support/fixtures.ts";

/** Whether a `node.exe` process has this pid (a reused pid of another program is not one). `tasklist` prints a CSV row of the match and an INFO sentence otherwise. */
function nodeAlive(pid: number): boolean {
	const listing = execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/FI", "IMAGENAME eq node.exe", "/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: true });
	return listing.includes(`"${pid}"`);
}

async function requests(mockUrl: string): Promise<RecordedRequest[]> {
	return await (await fetch(`${mockUrl}/__requests`)).json();
}

test("Cancel in the Jobs row ends a real background bash job through OMP's /jobs kill, and tells the model nothing", async ({ desk, state }) => {
	test.setTimeout(300_000);
	const scratch = mkdtempSync(join(state.resultsDir, "jobs-"));
	const pidFile = join(scratch, "sleeper.pid");
	let pid: number | undefined;
	try {
		// The sleeper is a real child process OMP has to end (nothing in this test waits on a timer): it writes its pid, then idles for two minutes.
		const pidPath = pidFile.replaceAll("\\", "/");
		expect(pidPath, "a path the marker and OMP's shell can carry unquoted").toMatch(/^[\w:/.-]+$/);
		const command = `node -e "require('fs').writeFileSync('${pidPath}',String(process.pid));setTimeout(()=>{},120000)"`;

		const page = await desk.window("alpha-desk");
		await desk.ready(page);
		// Run alone, this is the first session of a fresh environment: the runtime proof and the broker start are cold, and the machine is often busy.
		const chat = await desk.newChatSession(page, "alpha-desk", 120_000);
		const seen = (await requests(state.mockUrl)).length;
		await desk.send(chat, `[bg:${command}]`);

		// The card of the bash call says its job runs; the Jobs row is drawn.
		const card = chat.locator('.omp-native-tool[data-tool-name="bash"]');
		const chip = card.locator(".omp-job-chip");
		await expect(chip).toHaveAttribute("data-job-state", "running", { timeout: 120_000 });
		const id = await chip.getAttribute("data-job-id");
		expect(id, "the chip names the job").toMatch(/^[\w-]+$/);
		await expect(chat.getByText("Tool result received.")).toBeVisible({ timeout: 60_000 });
		const jobs = chat.locator('section[aria-label="Jobs"]');
		await expect(jobs).toBeVisible({ timeout: 30_000 });

		// The job is a live process.
		await expect.poll(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "", { timeout: 60_000, message: "the sleeper wrote its pid" }).toBe(true);
		pid = Number(readFileSync(pidFile, "utf8").trim());
		expect(Number.isInteger(pid) && pid > 0, "a pid").toBe(true);
		expect(nodeAlive(pid), "the sleeper runs before the cancel").toBe(true);

		// Expand the row and cancel the job from its own line.
		const toggle = jobs.locator(".omp-hud-toggle");
		if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
		await expect(toggle).toHaveAttribute("aria-expanded", "true");
		const line = jobs.locator(`li.omp-hud-job-item[data-job-id="${id}"]`);
		await expect(line).toContainText("bash:");
		const userRows = await chat.locator(".omp-user").count();
		await line.locator(".omp-hud-cancel").click();

		// OMP's own sentence, the chip, the row, and the process.
		await expect(jobs.locator(".omp-hud-jobs-feedback .omp-hud-job-outcome")).toHaveText(`Cancelled background job ${id}.`, { timeout: 60_000 });
		await expect(chip).toHaveAttribute("data-job-state", "cancelled", { timeout: 60_000 });
		await expect.poll(() => nodeAlive(pid!), { timeout: 60_000, message: "the sleeper process is gone" }).toBe(false);
		await expect(jobs, "the row goes once OMP has nothing pending").toHaveCount(0, { timeout: 60_000 });

		// A cancel is a command of OMP, not a message: no request carries it, no user row shows it.
		const prompts = (await requests(state.mockUrl)).slice(seen).map(request => request.fullUserText);
		expect(prompts.some(text => text.includes("/jobs kill")), "the model was told about the cancel").toBe(false);
		expect(await chat.locator(".omp-user").count(), "the cancel is no user row").toBe(userRows);
	} finally {
		if (pid !== undefined && nodeAlive(pid)) spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
		rmSync(scratch, { recursive: true, force: true });
	}
});
