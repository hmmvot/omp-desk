<#
.SYNOPSIS
Starts a throwaway VS Code with OMP Desk and its own OMP state, apart from your everyday VS Code and OMP.

.DESCRIPTION
Each -Name is a separate test environment under -Root:
  data\   VS Code user data (settings, OMP Desk's own storage and session index)
  ext\    VS Code extensions
  agent\  OMP's default-profile directory (logins, settings, sessions), passed as PI_CODING_AGENT_DIR

A fresh environment is OMP as a new user sees it: no provider login and no sessions. Log in from that window to
build a state worth keeping, and use -Reset to return to a clean OMP.

Provider API keys in the environment (ANTHROPIC_API_KEY and similar) would give OMP models even without a login,
so they are removed from the launched VS Code unless -KeepProviderKeys is given.

The environment applies only when this VS Code starts. If the window for -Name is already running, VS Code reuses
it with the environment it started with; close it first to change keys, or to reset.

A new environment starts with settings that keep VS Code's first-run prompts out of the way: no workspace trust,
no AI sign-in or Copilot chat, no welcome page. Edit them in that window as usual; the script never rewrites them.

Keep -Root inside your user profile. OMP Desk refuses to start sessions when another user could replace a folder on
the path to its storage, which is the case for folders created directly under a drive root such as C:\tests.

.EXAMPLE
./scripts/test-vscode.ps1 -Name nologin -Vsix ./out/omp-desk-win32-x64-<version>.vsix -Folder ~/projects/demo
.EXAMPLE
./scripts/test-vscode.ps1 -Name nologin -Reset
#>
[CmdletBinding()]
param(
	[Parameter(Mandatory)] [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]*$')] [string] $Name,
	# VSIX to install before launch; without it the window keeps the extension installed earlier.
	[string] $Vsix,
	# Folder to open; without it VS Code restores its last window.
	[string] $Folder,
	# Delete this environment's OMP directory first: no logins, settings or sessions.
	[switch] $Reset,
	# Also delete VS Code user data and extensions: a first VS Code start, OMP Desk's storage included.
	[switch] $ResetVsCode,
	[switch] $KeepProviderKeys,
	# Chrome DevTools Protocol port on 127.0.0.1 for automated UI checks; applies only when this VS Code starts.
	[ValidateRange(1024, 65535)] [int] $RemoteDebuggingPort,
	[string] $Root = (Join-Path $env:LOCALAPPDATA 'omp-desk-test')
)
$ErrorActionPreference = 'Stop'

$command = Get-Command code.cmd -ErrorAction SilentlyContinue
if (-not $command) { throw 'code.cmd is not on PATH. Install VS Code with "Add to PATH", or add its bin folder.' }
$code = $command.Source

$base = Join-Path ([IO.Path]::GetFullPath($Root)) $Name
$data = Join-Path $base 'data'
$extensions = Join-Path $base 'ext'
$agent = Join-Path $base 'agent'

# A running window for this environment keeps its environment, and deleting state under it breaks the open sessions.
$running = @(Get-CimInstance Win32_Process -Filter "Name = 'Code.exe'" |
	Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($data, [StringComparison]::OrdinalIgnoreCase) -ge 0 })
if ($running.Count -gt 0) {
	if ($Reset -or $ResetVsCode) { throw "VS Code for '$Name' is running. Close that window, then reset." }
	Write-Warning "VS Code for '$Name' is already running; it keeps the environment it started with."
}

if ($ResetVsCode) { foreach ($dir in $data, $extensions) { if (Test-Path $dir) { Remove-Item -Recurse -Force $dir } } }
if ($Reset -and (Test-Path $agent)) { Remove-Item -Recurse -Force $agent }
New-Item -ItemType Directory -Force -Path $data, $extensions, $agent | Out-Null
$settings = Join-Path $data 'User\settings.json'
if (-not (Test-Path $settings)) {
	New-Item -ItemType Directory -Force -Path (Split-Path $settings) | Out-Null
	$defaults = [ordered]@{
		'security.workspace.trust.enabled' = $false
		'chat.disableAIFeatures' = $true
		'workbench.startupEditor' = 'none'
		'workbench.welcomePage.walkthroughs.openOnInstall' = $false
	}
	[IO.File]::WriteAllText($settings, ($defaults | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
}

# The launched VS Code inherits this process's environment. Change it only for the launch and restore it, because a
# script run as ./scripts/test-vscode.ps1 shares the caller's session.
$saved = @{}
function Set-LaunchVariable([string] $Key, [AllowNull()] [string] $Value) {
	if (-not $saved.ContainsKey($Key)) { $saved[$Key] = [Environment]::GetEnvironmentVariable($Key, 'Process') }
	[Environment]::SetEnvironmentVariable($Key, $Value, 'Process')
}
# Remove all of these from the launch. VSCODE_* would hand the command to the VS Code that owns this terminal.
# OMP_*/PI_* would point OMP elsewhere.
$drop = '^(VSCODE_|ELECTRON_|OMP_|PI_)'
if (-not $KeepProviderKeys) {
	$drop += '|_API_KEY$|_API_TOKEN$|_AUTH_TOKEN$|^AWS_|^GOOGLE_APPLICATION_CREDENTIALS$|^GOOGLE_CLOUD_|^AZURE_OPENAI_'
}
$removed = @()
foreach ($key in [Environment]::GetEnvironmentVariables('Process').Keys) {
	if ($key -match $drop) { Set-LaunchVariable $key $null; $removed += $key }
}
Set-LaunchVariable 'PI_CODING_AGENT_DIR' $agent

try {
	$profileArgs = @('--user-data-dir', $data, '--extensions-dir', $extensions)
	if ($Vsix) {
		$package = (Resolve-Path $Vsix).Path
		& $code @profileArgs --install-extension $package --force
		if ($LASTEXITCODE -ne 0) { throw "Installing $package failed (exit $LASTEXITCODE)." }
	}
	elseif (-not (Get-ChildItem -Path $extensions -Directory -Filter 'hmmvot.omp-desk-*' -ErrorAction SilentlyContinue)) {
		Write-Warning "OMP Desk is not installed in '$Name' yet; pass -Vsix."
	}
	$launchArgs = @($profileArgs) + '--new-window'
	if ($RemoteDebuggingPort) { $launchArgs += "--remote-debugging-port=$RemoteDebuggingPort" }
	if ($Folder) { $launchArgs += (Resolve-Path $Folder).Path }
	& $code @launchArgs
}
finally {
	foreach ($entry in $saved.GetEnumerator()) { [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, 'Process') }
}

Write-Host "Test VS Code '$Name'"
Write-Host "  OMP state:   $agent"
Write-Host "  VS Code:     $data"
if ($removed.Count -gt 0) { Write-Host "  Not passed:  $(($removed | Sort-Object) -join ', ')" }
