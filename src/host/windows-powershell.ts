/**
 * The one way this extension starts Windows PowerShell 5.1 for its own work: helper
 * scripts, process and ACL readings, toasts and font discovery.
 *
 * The executable is the copy in `System32`, never one found earlier on `PATH`: a
 * developer toolchain (Git's `usr/bin`, a portable distribution) can ship a different
 * `powershell.exe`. `pwsh` is deliberately not used either: the staged helpers are
 * written for the PowerShell that ships with Windows, and PowerShell 7 is a different
 * runtime with a different C# compiler version.
 *
 * The child's environment has no `PSModulePath`. PowerShell 7 sets that variable to
 * its own module folders, and every process started beneath it inherits them: VS Code
 * opened with `code .` from a PowerShell 7 prompt, or a CI step whose shell is `pwsh`.
 * Windows PowerShell 5.1 then finds PowerShell 7's `Microsoft.PowerShell.Security`
 * first and cannot load it, so `Get-Acl` and every other cmdlet in a 7-only copy of a
 * built-in module fails. Without the variable, 5.1 builds its own default module path.
 */

import { join } from "node:path";

/** The operating system's own Windows PowerShell 5.1. */
export function windowsPowerShellExecutable(): string {
	const root = process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows";
	return join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

/**
 * This process's environment for a Windows PowerShell 5.1 child, without
 * `PSModulePath` (in any letter case, as Windows treats names), plus `extra`.
 */
export function windowsPowerShellEnvironment(extra: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = {};
	for (const [name, value] of Object.entries(process.env)) {
		if (name.toLowerCase() !== "psmodulepath") environment[name] = value;
	}
	return { ...environment, ...extra };
}
