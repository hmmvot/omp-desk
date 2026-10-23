<#
.SYNOPSIS
Stops a test VS Code environment when the end-to-end run that owns it dies without its teardown.

.DESCRIPTION
Waits for -ParentPid (the Playwright process of the run) to exit and polls -ReapFile every -IntervalMs. -ReapFile is a
JSON file {name, root} that the suite writes while its environment runs and deletes once it has stopped the environment
itself (or deliberately keeps it for `E2E_KEEP_ENV=1`); when it is gone this script ends. When the parent exits while the
file is still there, the run was killed (a job limit, Task Manager's End task): the script stops the environment with
scripts/test-vscode.ps1 -Stop (the window, its Chat brokers, which are detached by design, and the OMP processes), deletes
the environment's profile folder and the file.

The suite starts this script through `cmd /c start`, not as its own child: Node ends its direct children together with
itself (a job object closed with the process), and a reaper that dies with the run cleans up nothing. The foreground
watchdog is such a child and ends with the run for the same reason.
#>
[CmdletBinding()]
param(
	[Parameter(Mandatory)] [int] $ParentPid,
	[Parameter(Mandatory)] [string] $ReapFile,
	[int] $IntervalMs = 2000
)
$ErrorActionPreference = 'Stop'
try { $parent = [Diagnostics.Process]::GetProcessById($ParentPid) } catch { $parent = $null }
# Waiting on the process handle sees a process that is gone even while another handle to it keeps its record alive.
while ($parent -and -not $parent.WaitForExit($IntervalMs)) {
	if (-not (Test-Path $ReapFile)) { return }
}
if (-not (Test-Path $ReapFile)) { return }
$environment = Get-Content -Raw $ReapFile | ConvertFrom-Json
& (Join-Path $PSScriptRoot '..\..\scripts\test-vscode.ps1') -Name $environment.name -Root $environment.root -Stop
# What the run's own teardown would delete next: the environment's profile (only a folder this suite names, never another).
if ($environment.name -like 'e2e-run-*') {
	$base = Join-Path $environment.root $environment.name
	for ($attempt = 0; $attempt -lt 10 -and (Test-Path $base); $attempt++) {
		Remove-Item -Recurse -Force $base -ErrorAction SilentlyContinue
		if (Test-Path $base) { Start-Sleep -Milliseconds 500 }
	}
}
Remove-Item $ReapFile -Force -ErrorAction SilentlyContinue
