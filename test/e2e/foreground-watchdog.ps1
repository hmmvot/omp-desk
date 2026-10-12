<#
.SYNOPSIS
Fails an end-to-end run if a test VS Code window ever reaches the user's desktop.

.DESCRIPTION
Samples GetForegroundWindow every -IntervalMs (50 ms by default) on the desktop this script runs on, which is the
user's. The test VS Code runs on a separate hidden desktop (scripts/test-vscode.ps1), so no window of it should be seen
here: neither as the foreground window nor as a visible top-level window. Every ~250 ms the loop also enumerates the
visible top-level windows. A Code.exe whose command line names -Marker (the test root) is a violation: the watchdog
records it, terminates that process tree at once and keeps running so the report stays complete.

Writes -ReadyFile once the sampling loop is about to start (the suite does not launch VS Code before that).
Stops when -StopFile appears or -ParentPid exits, and then writes -ReportFile (JSON): samples, duration, foreground
changes, largest gap between samples, windows enumerated and the violations. The exit code is 3 on a violation, 0 otherwise; a nonzero exit without a report means the watchdog failed.
#>
[CmdletBinding()]
param(
	[Parameter(Mandatory)] [string] $Marker,
	[Parameter(Mandatory)] [string] $ReportFile,
	[Parameter(Mandatory)] [string] $StopFile,
	[Parameter(Mandatory)] [string] $ReadyFile,
	[int] $ParentPid = 0,
	[int] $IntervalMs = 50
)
$ErrorActionPreference = 'Stop'
Add-Type -ReferencedAssemblies System.Management -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Management;
using System.Runtime.InteropServices;
using System.Text;

public static class OmpDeskForegroundWatchdog {
	delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
	[DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
	[DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
	[DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
	[DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);

	static readonly Dictionary<uint, bool> verdicts = new Dictionary<uint, bool>();

	static bool IsTestWindow(uint pid, string marker) {
		bool known;
		if (verdicts.TryGetValue(pid, out known)) return known;
		bool result = false;
		try {
			string name = Process.GetProcessById((int)pid).ProcessName;
			if (name.Equals("Code", StringComparison.OrdinalIgnoreCase)) {
				using (var searcher = new ManagementObjectSearcher("SELECT CommandLine FROM Win32_Process WHERE ProcessId = " + pid))
				foreach (ManagementObject row in searcher.Get()) {
					string line = row["CommandLine"] as string;
					if (line != null && line.IndexOf(marker, StringComparison.OrdinalIgnoreCase) >= 0) result = true;
				}
			}
		} catch { }
		verdicts[pid] = result;
		return result;
	}

	static string Json(string s) { return "\"" + s.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\""; }

	public static int Run(string marker, string reportFile, string stopFile, string readyFile, int parentPid, int intervalMs) {
		var stopwatch = Stopwatch.StartNew();
		File.WriteAllText(readyFile, "ready");
		long samples = 0, changes = 0, enumerations = 0, visibleSeen = 0, maxGapMs = 0, lastTick = 0;
		uint lastForeground = 0;
		var violations = new List<string>();
		var foregroundPids = new HashSet<uint>();
		while (!File.Exists(stopFile)) {
			if (parentPid > 0) {
				try { Process.GetProcessById(parentPid); } catch { break; }
			}
			long now = stopwatch.ElapsedMilliseconds;
			if (samples > 0 && now - lastTick > maxGapMs) maxGapMs = now - lastTick;
			lastTick = now;
			samples++;
			uint pid; IntPtr fg = GetForegroundWindow();
			GetWindowThreadProcessId(fg, out pid);
			if (fg != IntPtr.Zero && pid != lastForeground) { changes++; lastForeground = pid; foregroundPids.Add(pid); }
			if (fg != IntPtr.Zero && IsTestWindow(pid, marker)) {
				violations.Add("foreground pid " + pid + " at " + now + " ms");
				Kill(pid);
			}
			if (samples % 5 == 0) {
				enumerations++;
				var offenders = new List<uint>();
				EnumWindows((h, l) => {
					if (!IsWindowVisible(h)) return true;
					uint p; GetWindowThreadProcessId(h, out p);
					visibleSeen++;
					if (IsTestWindow(p, marker) && !offenders.Contains(p)) offenders.Add(p);
					return true;
				}, IntPtr.Zero);
				foreach (uint p in offenders) { violations.Add("visible window of pid " + p + " at " + now + " ms"); Kill(p); }
			}
			System.Threading.Thread.Sleep(intervalMs);
		}
		var json = new StringBuilder();
		json.Append("{\"samples\":").Append(samples)
			.Append(",\"durationMs\":").Append(stopwatch.ElapsedMilliseconds)
			.Append(",\"intervalMs\":").Append(intervalMs)
			.Append(",\"foregroundChanges\":").Append(changes)
			.Append(",\"distinctForegroundProcesses\":").Append(foregroundPids.Count)
			.Append(",\"windowEnumerations\":").Append(enumerations)
			.Append(",\"visibleWindowsSeen\":").Append(visibleSeen)
			.Append(",\"maxGapMs\":").Append(maxGapMs)
			.Append(",\"violations\":[");
		for (int i = 0; i < violations.Count; i++) { if (i > 0) json.Append(','); json.Append(Json(violations[i])); }
		json.Append("]}");
		File.WriteAllText(reportFile, json.ToString());
		return violations.Count > 0 ? 3 : 0;
	}

	static void Kill(uint pid) {
		try {
			var info = new ProcessStartInfo("taskkill.exe", "/PID " + pid + " /T /F") { CreateNoWindow = true, UseShellExecute = false };
			Process.Start(info);
		} catch { }
	}
}
'@
exit ([OmpDeskForegroundWatchdog]::Run($Marker, $ReportFile, $StopFile, $ReadyFile, $ParentPid, $IntervalMs))
