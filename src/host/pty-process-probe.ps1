<#
Process-ownership probe for the extension-owned PTY broker (ADR-0024, ADR-0012).

Driven by the broker entry with `-NoProfile -NonInteractive -ExecutionPolicy Bypass
-File <staged copy>`; the copy is re-hashed immediately before every spawn, so this
file is only ever run from the content-addressed staged tree.

  -Mode generation -TargetPid <n>
      Print `!GENERATION <filetime>`: the kernel creation time of that process as a
      FILETIME decimal string, the same value and format the host-control helper
      (`verified-pipe.ps1 -Mode generation`) reports, so an identity recorded by one
      can be compared with a reading taken by the other.

  -Mode tree -TargetPid <n>
      Print `!TREE <pid>[,<pid>...]` for every live descendant of that process, or
      `!TREE -` when it has none. Used as stop evidence: a process that is gone is
      not proof that its tree is, and a stopped shell must not leave children.

  -Mode identity
      Print `!SELF <pid> <filetime>` for this very PowerShell process, so a caller
      can prove the helper ran and read the clock source it depends on.

Every answer is a single `!`-prefixed line on stdout. A refusal is `!ERROR <code>`
with one of: BAD_ARGUMENTS, PROCESS_QUERY_FAILED, TREE_QUERY_FAILED. Exit codes:
0 normal; 15 the target process could not be read; 16 the process tree could not be
read; 20 bad arguments.
#>
[CmdletBinding()]
param(
	[ValidateSet('generation', 'tree', 'identity')]
	[string]$Mode = 'generation',
	[int]$TargetPid = 0
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::ASCII

function Emit([string]$line) {
	[Console]::Out.Write($line + "`n")
	[Console]::Out.Flush()
}

function Get-CreationFileTime([int]$processId) {
	if ($processId -le 0) { return $null }
	$process = Get-Process -Id $processId -ErrorAction SilentlyContinue
	if ($null -eq $process) { return $null }
	try {
		return $process.StartTime.ToFileTime().ToString([System.Globalization.CultureInfo]::InvariantCulture)
	} finally {
		$process.Dispose()
	}
}

function Get-DescendantPids([int]$rootProcessId) {
	# One snapshot of the process table, then an in-memory walk: the parent link is
	# only meaningful inside a single reading, and re-querying per level can both
	# miss and invent children while processes start and exit.
	$rows = @(Get-CimInstance -ClassName Win32_Process -Property ProcessId, ParentProcessId)
	$children = @{}
	foreach ($row in $rows) {
		$parent = [int]$row.ParentProcessId
		if (-not $children.ContainsKey($parent)) { $children[$parent] = New-Object System.Collections.Generic.List[int] }
		$children[$parent].Add([int]$row.ProcessId)
	}
	$found = New-Object System.Collections.Generic.List[int]
	$pending = New-Object System.Collections.Generic.Queue[int]
	$pending.Enqueue($rootProcessId)
	while ($pending.Count -gt 0) {
		$current = $pending.Dequeue()
		if (-not $children.ContainsKey($current)) { continue }
		foreach ($child in $children[$current]) {
			$found.Add($child)
			$pending.Enqueue($child)
		}
	}
	return $found
}

if ($Mode -eq 'identity') {
	$own = Get-CreationFileTime $PID
	if ($null -eq $own) {
		Emit "!ERROR PROCESS_QUERY_FAILED"
		exit 15
	}
	Emit ("!SELF " + $PID + " " + $own)
	exit 0
}

if ($TargetPid -le 0) {
	Emit "!ERROR BAD_ARGUMENTS"
	exit 20
}

if ($Mode -eq 'generation') {
	$creation = Get-CreationFileTime $TargetPid
	if ($null -eq $creation) {
		Emit "!ERROR PROCESS_QUERY_FAILED"
		exit 15
	}
	Emit ("!GENERATION " + $creation)
	exit 0
}

try {
	# `@(...)`: a PowerShell function unrolls its output, so a single child would
	# otherwise arrive as a bare integer with no `Count` of its own.
	$descendants = @(Get-DescendantPids $TargetPid)
} catch {
	Emit "!ERROR TREE_QUERY_FAILED"
	exit 16
}
if ($descendants.Count -eq 0) {
	Emit "!TREE -"
} else {
	Emit ("!TREE " + ([string]::Join(",", $descendants)))
}
exit 0
