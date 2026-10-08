import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { promisify } from "node:util";
import { windowsPowerShellEnvironment, windowsPowerShellExecutable } from "./windows-powershell.ts";

const run = promisify(execFile);
const roots: string[] = [];

after(async () => {
	await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })));
});

/**
 * A module folder shaped like the one PowerShell 7 puts first on `PSModulePath`: its
 * `Microsoft.PowerShell.Security` declares the Core edition and PowerShell 7, so
 * Windows PowerShell 5.1 finds it before its own copy and cannot load it.
 */
async function powerShell7ModulePath(): Promise<string> {
	const root = await mkdtemp(path.join(tmpdir(), "omp-pwsh7-modules-"));
	roots.push(root);
	const module = path.join(root, "Microsoft.PowerShell.Security");
	await mkdir(module);
	await writeFile(
		path.join(module, "Microsoft.PowerShell.Security.psd1"),
		`@{ ModuleVersion = '7.0.0.0'; CompatiblePSEditions = @('Core'); PowerShellVersion = '7.0'; NestedModules = 'Microsoft.PowerShell.Security.dll'; CmdletsToExport = 'Get-Acl' }\r\n`,
	);
	return root;
}

/** Read one directory's owner the way the private-storage owner read does. */
function readOwner(directory: string, env: NodeJS.ProcessEnv) {
	return run(windowsPowerShellExecutable(), ["-NoProfile", "-NonInteractive", "-Command", `(Get-Acl -LiteralPath '${directory}' -ErrorAction Stop).Owner`], {
		env,
		windowsHide: true,
		timeout: 30_000,
	});
}

describe("Windows PowerShell child environment", () => {
	it("drops PSModulePath in any letter case and keeps everything else", () => {
		const saved = { ...process.env };
		try {
			process.env.psmodulepath = "C:\\elsewhere\\Modules";
			process.env.OMP_KEEP_ME = "kept";
			const environment = windowsPowerShellEnvironment({ OMP_EXTRA: "extra" });
			assert.deepEqual(Object.keys(environment).filter(name => name.toLowerCase() === "psmodulepath"), []);
			assert.equal(environment.OMP_KEEP_ME, "kept");
			assert.equal(environment.OMP_EXTRA, "extra");
			assert.equal(environment.Path ?? environment.PATH, process.env.Path ?? process.env.PATH);
		} finally {
			for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
			Object.assign(process.env, saved);
		}
	});

	it(
		"lets Get-Acl load when the extension host inherited PowerShell 7's module path",
		{ skip: process.platform !== "win32" },
		async () => {
			const modules = await powerShell7ModulePath();
			const saved = process.env.PSModulePath;
			try {
				process.env.PSModulePath = modules;
				// The fixture reproduces the failure: inheriting the path breaks the module.
				await assert.rejects(readOwner(modules, { ...process.env }), /CouldNotAutoloadMatchingModule/);

				const { stdout } = await readOwner(modules, windowsPowerShellEnvironment());
				assert.match(stdout.trim(), /^[^\s\\]+\\[^\s\\]+$/, `Get-Acl answered ${JSON.stringify(stdout)}`);
			} finally {
				if (saved === undefined) delete process.env.PSModulePath;
				else process.env.PSModulePath = saved;
			}
		},
	);
});
