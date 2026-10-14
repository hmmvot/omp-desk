/**
 * The only way this suite starts or stops a VS Code: scripts/test-vscode.ps1, which runs it on a hidden Windows
 * desktop (never on the user's), with its own user data, extensions and OMP agent directory. Nothing here uses
 * `code.cmd`, `Start-Process` or any other launcher.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { sleep } from "./time.ts";

export const REPO_ROOT = resolve(__dirname, "../../..");
const LAUNCHER = join(REPO_ROOT, "scripts", "test-vscode.ps1");

export interface RunResult {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

export function runPowerShell(args: readonly string[], timeoutMs = 240_000): Promise<RunResult> {
	const done = Promise.withResolvers<RunResult>();
	const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", ...args], { cwd: REPO_ROOT, windowsHide: true });
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", chunk => { stdout += chunk; });
	child.stderr.on("data", chunk => { stderr += chunk; });
	const timer = setTimeout(() => { child.kill(); done.reject(new Error(`PowerShell timed out after ${timeoutMs} ms: ${args.join(" ")}`)); }, timeoutMs);
	child.once("error", error => { clearTimeout(timer); done.reject(error); });
	child.once("close", code => { clearTimeout(timer); done.resolve({ code: code ?? -1, stdout, stderr }); });
	return done.promise;
}

async function launcher(args: readonly string[], timeoutMs?: number): Promise<RunResult> {
	const result = await runPowerShell(["-File", LAUNCHER, ...args], timeoutMs);
	if (result.code !== 0) throw new Error(`test-vscode.ps1 ${args.join(" ")} failed (exit ${result.code}): ${result.stderr || result.stdout}`);
	return result;
}

export interface LaunchOptions {
	readonly name: string;
	readonly root: string;
	readonly folder: string;
	readonly vsix?: string;
	readonly port?: number;
	readonly reset?: boolean;
}

/** Starts (or, for a running `name`, opens another window of) the test VS Code. */
export function startVsCode(options: LaunchOptions): Promise<RunResult> {
	// Debug by default: the scenarios read `window timing:` lines, which the Info level of the OMP Desk log leaves out.
	// `E2E_DESK_LOG_LEVEL=default` leaves VS Code's own level (Info) in place.
	const level = process.env.E2E_DESK_LOG_LEVEL ?? "debug";
	const args = ["-Name", options.name, "-Root", options.root, "-Folder", options.folder];
	if (level !== "default") args.push("-DeskLogLevel", level);
	if (options.vsix) args.push("-Vsix", options.vsix);
	if (options.port) args.push("-RemoteDebuggingPort", String(options.port));
	if (options.reset) args.push("-Reset", "-ResetVsCode");
	// A VS Code install other than the everyday one (a scratch copy), for scenarios that must not touch the real install and for a
	// machine whose own install is waiting for "Restart to Update" (test-vscode.ps1 refuses to start it).
	if (process.env.E2E_VSCODE_DIR) args.push("-VsCodeDir", process.env.E2E_VSCODE_DIR);
	return launcher(args);
}

/** Ends every Code.exe of the environment and what it started. Safe when nothing runs. */
export function stopVsCode(name: string, root: string): Promise<RunResult> {
	return launcher(["-Name", name, "-Root", root, "-Stop"], 120_000);
}

export async function freePort(): Promise<number> {
	const server = createServer();
	const listening = Promise.withResolvers<void>();
	server.once("error", listening.reject);
	server.listen(0, "127.0.0.1", listening.resolve);
	await listening.promise;
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("no TCP address for the probe socket");
	const closed = Promise.withResolvers<void>();
	server.close(() => closed.resolve());
	await closed.promise;
	return address.port;
}

/** Waits for the DevTools endpoint of a freshly started VS Code. */
export async function waitForCdp(port: number, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			const response = await fetch(`http://127.0.0.1:${port}/json/version`);
			if (response.ok) return;
		} catch { /* not listening yet */ }
		if (Date.now() > deadline) throw new Error(`no DevTools endpoint on port ${port} after ${timeoutMs} ms`);
		await sleep(500);
	}
}
