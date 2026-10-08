import { execFile } from "node:child_process";
import { windowsPowerShellEnvironment, windowsPowerShellExecutable } from "./windows-powershell.ts";

let discovery: Promise<readonly string[]> | undefined;

/** Installed Nerd Font family names (Windows only). Read-only; one bounded lookup per extension host, never on a probe or render. */
export function installedNerdFonts(): Promise<readonly string[]> {
	if (discovery !== undefined) return discovery;
	if (process.platform !== "win32") return discovery = Promise.resolve([]);
	discovery = new Promise(resolve => {
		const script = "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding; Add-Type -AssemblyName System.Drawing; $f=New-Object System.Drawing.Text.InstalledFontCollection; @($f.Families | ForEach-Object {$_.Name} | Where-Object {$_ -match 'Nerd\\s*Font'} | Sort-Object -Unique) | ConvertTo-Json -Compress";
		execFile(windowsPowerShellExecutable(), ["-NoProfile", "-NonInteractive", "-Command", script],
			{ windowsHide: true, timeout: 5000, maxBuffer: 64 * 1024, encoding: "utf8", env: windowsPowerShellEnvironment() }, (error, output) => {
				if (error !== null) { resolve([]); return; }
				try {
					const value: unknown = output.trim() === "" ? [] : JSON.parse(output);
					const names = typeof value === "string" ? [value] : value;
					resolve(Array.isArray(names) ? names.filter((name): name is string => typeof name === "string" && name.length > 0 && name.length <= 128 && !/[\u0000-\u001f\u007f]/.test(name)).slice(0, 128) : []);
				} catch { resolve([]); }
			});
	});
	return discovery;
}
