<#
.SYNOPSIS
Reports whether named OMP session-lease mutexes exist, without ever taking one.

.DESCRIPTION
Reads mutex names from stdin, one per line, and opens each with SYNCHRONIZE access only
(OpenMutex through Mutex.TryOpenExisting). The handle is closed immediately; nothing is
created, waited on or held, so a probe can neither block an OMP process nor make one believe
a session is taken for longer than the handle exists.

Every answer is a `!`-prefixed line on stdout:
  !LEASE held|absent|error <name>   one per input name, in input order
  !DONE <count>                     the number of names answered
  !ERROR <code>                     a refusal; nothing else is printed after it

A name must be exactly `Global\omp-file-lock-` followed by 32 lower-case hex digits; anything
else is refused with `!ERROR bad-name` before a single mutex is opened.
#>
$ErrorActionPreference = 'Stop'
$names = New-Object System.Collections.Generic.List[string]
while ($true) {
	$line = [Console]::In.ReadLine()
	if ($null -eq $line) { break }
	$name = $line.Trim()
	if ($name.Length -eq 0) { continue }
	if ($name -cnotmatch '^Global\\omp-file-lock-[0-9a-f]{32}$') {
		Write-Output '!ERROR bad-name'
		exit 2
	}
	$names.Add($name)
}
foreach ($name in $names) {
	$verdict = 'error'
	$handle = $null
	try {
		if ([System.Threading.Mutex]::TryOpenExisting($name, [System.Security.AccessControl.MutexRights]::Synchronize, [ref]$handle)) {
			$verdict = 'held'
			$handle.Dispose()
		} else {
			$verdict = 'absent'
		}
	} catch [System.UnauthorizedAccessException] {
		# Access denied is only ever answered for an object that exists (an OMP running elevated).
		$verdict = 'held'
	} catch {
		$verdict = 'error'
	}
	Write-Output "!LEASE $verdict $name"
}
Write-Output "!DONE $($names.Count)"
