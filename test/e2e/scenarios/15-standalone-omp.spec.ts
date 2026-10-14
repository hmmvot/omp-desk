/**
 * OMP's own compiled program (the winget portable package, the `omp.sh` binary install, a mise install) as the `omp` the
 * window resolves: Chat must start, answer from the mock model, and keep host control, without OMP's own parser ever
 * seeing Bun's `--define` / `--preload` (ADR-0075).
 *
 * Needs the suite started with the directory that holds that `omp.exe` first on PATH (global setup inherits PATH):
 *   $env:E2E_STANDALONE_OMP = "<dir of omp.exe>"; $env:PATH = "$env:E2E_STANDALONE_OMP;$env:PATH"; npm run test:e2e -- 15-standalone-omp
 * Without E2E_STANDALONE_OMP the scenario is skipped; it never fetches or installs OMP.
 */
import { execFileSync } from "node:child_process";
import { expect, test } from "../support/fixtures.ts";
import { deskLogLines } from "../support/desk-log.ts";

const STANDALONE = process.env.E2E_STANDALONE_OMP;

test.skip(STANDALONE === undefined, "E2E_STANDALONE_OMP names the directory of a standalone omp.exe that is first on PATH");

/** Command lines of every running process image named `omp.exe` under `directory`. */
function ompCommandLines(directory: string): string[] {
	const image = directory.replaceAll("/", "\\").replaceAll("'", "''");
	const script = `Get-CimInstance Win32_Process -Filter "Name = 'omp.exe'" | Where-Object { $_.ExecutablePath -like '${image}*' } | ForEach-Object { $_.CommandLine }`;
	const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true });
	return out.split(/\r?\n/).filter(line => line.trim() !== "");
}

test("Chat on a standalone omp.exe starts, answers, and gets host control without Bun flags on OMP's command line", async ({ desk, state }) => {
	const page = await desk.window("alpha-desk");
	await desk.ready(page);

	const chat = await desk.newChatSession(page, "alpha-desk");
	await expect(chat.getByRole("button", { name: "Mock Model" })).toBeVisible();
	await desk.send(chat, "standalone hello");
	await expect(chat.getByText("Mock reply to: standalone hello")).toBeVisible();
	await expect(chat.getByText(/OMP exited with code/)).toHaveCount(0);
	await expect(chat.getByText(/unknown flags/)).toHaveCount(0);

	// Host control reached the program through BUN_OPTIONS and was verified over its pipe.
	await expect.poll(() => deskLogLines(state.dataDir, /host control verified \(pid/), { message: "host control verified", timeout: 60_000 }).not.toEqual([]);
	expect(deskLogLines(state.dataDir, /host control delivered through BUN_OPTIONS/), "the launch carried the flags in BUN_OPTIONS").not.toEqual([]);
	expect(deskLogLines(state.dataDir, /host control not delivered|host control unavailable/), "nothing reported host control as missing").toEqual([]);

	// OMP's own command line carries none of Bun's flags.
	const lines = ompCommandLines(STANDALONE!);
	expect(lines.length, "the standalone omp.exe is the running process").toBeGreaterThan(0);
	for (const line of lines) {
		expect(line).toContain("--mode rpc-ui");
		expect(line).not.toMatch(/--preload|--define/);
	}

	// The same editor, switched to a native Terminal: the same program, the same carrier, a second verified channel.
	await page.locator("[id='workbench.parts.titlebar']").click({ position: { x: 5, y: 5 } });
	await page.keyboard.press("F1");
	const picker = page.locator(".quick-input-widget");
	await picker.locator(".quick-input-box input").fill(">OMP Desk: Switch to Terminal");
	await expect(picker.getByRole("option", { name: /Switch to Terminal/ })).toBeVisible();
	await page.keyboard.press("Enter");
	await expect.poll(() => deskLogLines(state.dataDir, /Native OMP launched from .*host control delivered through BUN_OPTIONS/), { message: "a native Terminal launch on the same carrier", timeout: 90_000 }).not.toEqual([]);
	await expect.poll(() => deskLogLines(state.dataDir, /host control verified \(pid/).length, { message: "the Terminal's host control verified", timeout: 90_000 }).toBeGreaterThanOrEqual(2);
	expect(deskLogLines(state.dataDir, /exited with code|unknown flags/), "no launch failed").toEqual([]);
	await expect.poll(() => ompCommandLines(STANDALONE!).filter(line => !line.includes("--mode rpc-ui") && line.includes("-e ")).length, { message: "the native omp.exe runs" }).toBeGreaterThan(0);
	for (const line of ompCommandLines(STANDALONE!)) expect(line).not.toMatch(/--preload|--define/);
});
