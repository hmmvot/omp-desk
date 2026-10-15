<#
.SYNOPSIS
Starts a throwaway VS Code with OMP Desk and its own OMP state, apart from your everyday VS Code and OMP.

.DESCRIPTION
Each -Name is a separate test environment under -Root:
  data\   VS Code user data (settings, OMP Desk's own storage and session index)
  ext\    VS Code extensions
  agent\  OMP's default-profile directory (logins, settings, sessions), passed as PI_CODING_AGENT_DIR

A fresh environment is OMP as a new user sees it: no provider login and no sessions. Log in through CDP (see
-RemoteDebuggingPort), and use -Reset to return to a clean OMP.

The window never shows on your screen and cannot take the foreground or keyboard focus. VS Code is started on a
separate, hidden Windows desktop (CreateDesktop, named omp-desk-test-<Name>, in your window station) through
CreateProcess with that desktop in STARTUPINFO. Windows never activates a window outside the input desktop, so
nothing the test VS Code or the processes it starts (OMP, terminals, helpers) do can touch your windows. This is the
only launch path. Nobody can click that window: drive it through the DevTools port (-RemoteDebuggingPort), which also
serves screenshots (Page.captureScreenshot; send Emulation.setFocusEmulationEnabled first or the frame can be stale),
and close it with -Stop or Browser.close over CDP. Processes started
from the window inherit the hidden desktop, so a browser or window that OMP opens appears there as well.

PI_CODING_AGENT_DIR does not move everything: OMP keeps installed plugins under ~/.omp/plugins whatever it says, finds the
user-level agents it hands to subagents in ~/.omp/agent/agents (the home folder, not PI_CODING_AGENT_DIR), and also reads
~/.claude, ~/.codex and ~/.gemini. A Plugins row switched in the Extensions view of a test window changes your real plugin
lock, and the Models and Agents editors list your real agents. -IsolateHome closes that: it gives the window its own home
folder (home\ next to agent\) through USERPROFILE and HOME, so every ~ lookup of VS Code, OMP and OMP Desk lands there.

Provider API keys in the environment (ANTHROPIC_API_KEY and similar) would give OMP models even without a login,
so they are removed from the launched VS Code unless -KeepProviderKeys is given.

The environment applies only when this VS Code starts. If the window for -Name is already running, VS Code reuses
it with the environment it started with; -Stop it first to change keys, or to reset.

A new environment starts with settings that keep VS Code's first-run prompts out of the way: no workspace trust,
no AI sign-in or Copilot chat, no welcome page. Edit them in that window as usual; the script never rewrites them.

A VS Code with a downloaded update that waits for "Restart to Update" holds the vscode-updating mutex through its
installer, and a Code.exe started meanwhile waits 30 s and exits without a window or a log. The script stops before
launching when it sees that mutex. Finish the update, or pass -VsCodeDir with another install folder.

Keep -Root inside your user profile. OMP Desk refuses to start sessions when another user could replace a folder on
the path to its storage, which is the case for folders created directly under a drive root such as C:\tests.

.EXAMPLE
./scripts/test-vscode.ps1 -Name nologin -Vsix ./out/omp-desk-win32-x64-<version>.vsix -Folder ~/projects/demo
.EXAMPLE
./scripts/test-vscode.ps1 -Name nologin -Reset
.EXAMPLE
./scripts/test-vscode.ps1 -Name nologin -Stop
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
	# Launch with USERPROFILE and HOME (and HOMEDRIVE/HOMEPATH) set to <Root>\<Name>\home: nothing of the real home folder is read or written. -Reset deletes it too.
	[switch] $IsolateHome,
	# Stop the running window for -Name (its Code.exe processes, and any bun.exe broker, with their children) and start nothing.
	[switch] $Stop,
	# Chrome DevTools Protocol port on 127.0.0.1 for automated UI checks; applies only when this VS Code starts.
	[ValidateRange(1024, 65535)] [int] $RemoteDebuggingPort,
	[string] $Root = (Join-Path $env:LOCALAPPDATA 'omp-desk-test'),
	# VS Code install folder (the one with Code.exe and bin\code.cmd); default: the code.cmd found on PATH.
	[string] $VsCodeDir,
	# Log level of the OMP Desk output channel for this window (`--log=hmmvot.omp-desk:<level>`); without it VS Code's own level (Info) applies.
	[ValidateSet('error', 'warn', 'info', 'debug', 'trace')] [string] $DeskLogLevel
)
$ErrorActionPreference = 'Stop'

if ($VsCodeDir) {
	$code = Join-Path ([IO.Path]::GetFullPath($VsCodeDir)) 'bin\code.cmd'
	if (-not (Test-Path $code)) { throw "bin\code.cmd not found in -VsCodeDir '$VsCodeDir'." }
}
else {
	$command = Get-Command code.cmd -ErrorAction SilentlyContinue
	if (-not $command) { throw 'code.cmd is not on PATH. Install VS Code with "Add to PATH", or add its bin folder.' }
	$code = $command.Source
}

$base = Join-Path ([IO.Path]::GetFullPath($Root)) $Name
$data = Join-Path $base 'data'
$extensions = Join-Path $base 'ext'
$agent = Join-Path $base 'agent'

# A running window for this environment keeps its environment, and deleting state under it breaks the open sessions.
# A Chat's background broker may run on bun.exe (ADR-0074), outliving the window it was started from: its command line
# names this environment's data directory too, and it belongs to the environment as much as a Code.exe does.
$running = @(Get-CimInstance Win32_Process -Filter "Name = 'Code.exe' OR Name = 'bun.exe'" |
	Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($data, [StringComparison]::OrdinalIgnoreCase) -ge 0 })
if ($running.Count -gt 0 -and -not $Stop) {
	if ($Reset -or $ResetVsCode) { throw "VS Code for '$Name' is running. Stop it (-Stop), then reset." }
	Write-Warning "VS Code for '$Name' is already running; it keeps the environment it started with."
}

if ($Stop) {
	if ($running.Count -eq 0) { Write-Host "VS Code for '$Name' is not running."; return }
	foreach ($process in $running) { cmd /c "taskkill /PID $($process.ProcessId) /T /F >nul 2>&1" }
	Write-Host "Stopped VS Code for '$Name'."
	return
}

if ($ResetVsCode) { foreach ($dir in $data, $extensions) { if (Test-Path $dir) { Remove-Item -Recurse -Force $dir } } }
if ($Reset -and (Test-Path $agent)) { Remove-Item -Recurse -Force $agent }
$fixtureHome = Join-Path $base 'home'
if ($Reset -and (Test-Path $fixtureHome)) { Remove-Item -Recurse -Force $fixtureHome }
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
if ($IsolateHome) {
	New-Item -ItemType Directory -Force -Path $fixtureHome | Out-Null
	$drive = [IO.Path]::GetPathRoot($fixtureHome).TrimEnd('\')
	Set-LaunchVariable 'USERPROFILE' $fixtureHome
	Set-LaunchVariable 'HOME' $fixtureHome
	Set-LaunchVariable 'HOMEDRIVE' $drive
	Set-LaunchVariable 'HOMEPATH' $fixtureHome.Substring($drive.Length)
}

# Every test window lives on its own hidden desktop; see .DESCRIPTION.
$desktopName = "omp-desk-test-$Name"
if (-not ([System.Management.Automation.PSTypeName]'OmpDesk.DesktopLauncher').Type) {
	Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

namespace OmpDesk {
	public static class DesktopLauncher {
		[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
		struct STARTUPINFO {
			public int cb;
			public string lpReserved;
			public string lpDesktop;
			public string lpTitle;
			public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute;
			public int dwFlags;
			public short wShowWindow, cbReserved2;
			public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
		}

		[StructLayout(LayoutKind.Sequential)]
		struct PROCESS_INFORMATION {
			public IntPtr hProcess, hThread;
			public int dwProcessId, dwThreadId;
		}

		[DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
		static extern IntPtr CreateDesktopW(string name, IntPtr device, IntPtr devmode, int flags, uint access, IntPtr security);
		[DllImport("user32.dll", SetLastError = true)]
		static extern bool CloseDesktop(IntPtr desktop);
		[DllImport("user32.dll")]
		static extern IntPtr GetProcessWindowStation();
		[DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
		static extern bool GetUserObjectInformationW(IntPtr handle, int index, StringBuilder info, int length, out int needed);
		[DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
		static extern bool CreateProcessW(string application, StringBuilder commandLine, IntPtr processAttributes,
			IntPtr threadAttributes, bool inheritHandles, uint creationFlags, IntPtr environment, string currentDirectory,
			ref STARTUPINFO startup, out PROCESS_INFORMATION process);
		[DllImport("kernel32.dll")]
		static extern bool CloseHandle(IntPtr handle);
		[DllImport("kernel32.dll")]
		static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
		[DllImport("kernel32.dll")]
		static extern bool GetExitCodeProcess(IntPtr handle, out uint exitCode);
		delegate bool WindowProc(IntPtr window, IntPtr parameter);
		[DllImport("user32.dll")]
		static extern bool EnumDesktopWindows(IntPtr desktop, WindowProc callback, IntPtr parameter);
		[DllImport("user32.dll")]
		static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);

		const uint GENERIC_ALL = 0x10000000;
		const uint CREATE_UNICODE_ENVIRONMENT = 0x400;
		const int STARTF_USESHOWWINDOW = 1;
		const short SW_SHOWNOACTIVATE = 4;
		const int UOI_NAME = 2;
		const uint WAIT_TIMEOUT = 258;

		// True once the process owns a window on the desktop, which means it has attached to it.
		static bool HasWindow(IntPtr desktop, int processId) {
			bool found = false;
			EnumDesktopWindows(desktop, delegate (IntPtr window, IntPtr parameter) {
				uint owner;
				GetWindowThreadProcessId(window, out owner);
				if (owner == (uint)processId) found = true;
				return !found;
			}, IntPtr.Zero);
			return found;
		}

		// Starts the process on the named desktop (created if missing) of the current window station, with this
		// process's environment, and returns its id. A new process opens its desktop by name when it starts, and a
		// desktop with no handle and no process is destroyed, so the handle is kept until the process has a window
		// there or has ended.
		public static int Start(string application, string commandLine, string desktopName) {
			StringBuilder station = new StringBuilder(256);
			int needed;
			if (!GetUserObjectInformationW(GetProcessWindowStation(), UOI_NAME, station, station.Capacity * 2, out needed))
				throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot read the window station name");
			IntPtr desktop = CreateDesktopW(desktopName, IntPtr.Zero, IntPtr.Zero, 0, GENERIC_ALL, IntPtr.Zero);
			if (desktop == IntPtr.Zero)
				throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateDesktop '" + desktopName + "' failed");
			try {
				STARTUPINFO startup = new STARTUPINFO();
				startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
				startup.lpDesktop = station + "\\" + desktopName;
				startup.dwFlags = STARTF_USESHOWWINDOW;
				startup.wShowWindow = SW_SHOWNOACTIVATE;
				PROCESS_INFORMATION process;
				// No handle inheritance: the caller's pipes must not stay open for as long as the window lives.
				if (!CreateProcessW(application, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero, false,
					CREATE_UNICODE_ENVIRONMENT, IntPtr.Zero, null, ref startup, out process))
					throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateProcess failed");
				CloseHandle(process.hThread);
				try {
					DateTime deadline = DateTime.UtcNow.AddSeconds(60);
					while (WaitForSingleObject(process.hProcess, 0) == WAIT_TIMEOUT && !HasWindow(desktop, process.dwProcessId)) {
						if (DateTime.UtcNow > deadline)
							throw new TimeoutException("The process did not open a window on desktop '" + desktopName + "' within 60 s.");
						System.Threading.Thread.Sleep(50);
					}
					uint exitCode;
					// A nonzero exit this early is a failed start; zero is a hand-off to a window already running.
					if (WaitForSingleObject(process.hProcess, 0) != WAIT_TIMEOUT && GetExitCodeProcess(process.hProcess, out exitCode) && exitCode != 0)
						throw new InvalidOperationException("The process ended at startup with exit code 0x" + exitCode.ToString("X") + ".");
				}
				finally {
					CloseHandle(process.hProcess);
				}
				return process.dwProcessId;
			}
			finally {
				CloseDesktop(desktop);
			}
		}
	}
}
'@
}

function ConvertTo-CommandLineArgument([string] $Value) {
	if ($Value -and $Value -notmatch '[\s"]') { return $Value }
	'"' + (($Value -replace '(\\*)"', '$1$1\"') -replace '(\\+)$', '$1$1') + '"'
}

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
	# The OMP Desk output channel is a LogOutputChannel: VS Code's own --log flag sets its level for this window.
	if ($DeskLogLevel) { $launchArgs += "--log=hmmvot.omp-desk:$DeskLogLevel" }
	if ($Folder) { $launchArgs += (Resolve-Path $Folder).Path }

	# code.cmd only relays to Code.exe; start Code.exe itself, as the relay does.
	$exe = [IO.Path]::GetFullPath((Join-Path (Split-Path $code) '..\Code.exe'))
	if (-not (Test-Path $exe)) { throw "Code.exe not found next to $code." }

	# While an update of this VS Code is staged (a background update waiting for "Restart to Update"), the installer
	# holds the "<win32MutexName>-updating" mutex, and a starting Code.exe waits 30 s for it and then exits with no
	# window and no log. Say so now instead.
	$product = Get-ChildItem -Path (Split-Path $exe) -Directory |
		ForEach-Object { Join-Path $_.FullName 'resources\app\product.json' } | Where-Object { Test-Path $_ } | Select-Object -First 1
	if (@($running | Where-Object { $_.Name -eq 'Code.exe' }).Count -eq 0 -and $product) {
		$info = Get-Content $product -Raw | ConvertFrom-Json
		if ($info.win32MutexName -and $info.win32VersionedUpdate) {
			$held = $null
			try { $held = [Threading.Mutex]::OpenExisting("$($info.win32MutexName)-updating") }
			catch [Threading.WaitHandleCannotBeOpenedException] { }
			catch [UnauthorizedAccessException] { throw "The installer of a VS Code update holds the '$($info.win32MutexName)-updating' mutex." }
			if ($held) {
				$held.Dispose()
				throw "VS Code at $(Split-Path $exe) is waiting to install an update (the '$($info.win32MutexName)-updating' mutex is held), so a new window would exit after 30 s without opening. Finish the update (restart VS Code from its 'Restart to Update' prompt), or pass -VsCodeDir with a VS Code install that has no update pending."
			}
		}
	}
	Set-LaunchVariable 'VSCODE_CLI' '1'
	Set-LaunchVariable 'ELECTRON_NO_ATTACH_CONSOLE' '1'
	$commandLine = (@($exe) + $launchArgs | ForEach-Object { ConvertTo-CommandLineArgument $_ }) -join ' '
	$launchedPid = [OmpDesk.DesktopLauncher]::Start($exe, $commandLine, $desktopName)
}
finally {
	foreach ($entry in $saved.GetEnumerator()) { [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, 'Process') }
}

Write-Host "Test VS Code '$Name'"
Write-Host "  OMP state:   $agent"
Write-Host "  VS Code:     $data"
Write-Host "  Window:      hidden desktop '$desktopName' (Code.exe pid $launchedPid); drive it over CDP, close it with -Stop"
if ($removed.Count -gt 0) { Write-Host "  Not passed:  $(($removed | Sort-Object) -join ', ')" }
