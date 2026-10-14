# Emulates inno-updater's capture-and-kill (microsoft/inno-updater src/process.rs): candidates by image NAME, kept only when
# QueryFullProcessImageName equals the update target path; then TerminateProcess. -Rename also does the three-way rename of
# the main executable (Code.exe -> old_Code.exe) while it runs, as the updater does. Never selects by name alone.
param([Parameter(Mandatory)][string]$CodePath, [switch]$Rename, [switch]$DryRun, [switch]$Restore)
$target = [IO.Path]::GetFullPath($CodePath)
$name = [IO.Path]::GetFileName($target)
if ($Restore) { $d = Split-Path $target; $o = Join-Path $d "old_$name"; if (Test-Path $o) { Move-Item -LiteralPath $o -Destination $target -Force; "restored $name from old_$name" }; return }
$candidates = @(Get-CimInstance Win32_Process -Filter "Name = '$name'")
$captured = @($candidates | Where-Object { $_.ExecutablePath -and [string]::Equals([IO.Path]::GetFullPath($_.ExecutablePath), $target, 'OrdinalIgnoreCase') })
"candidates named ${name}: $($candidates.Count); captured (path equals target): $($captured.Count): $(($captured | ForEach-Object ProcessId) -join ',')"
if ($DryRun) { return }
if ($Rename) {
	$dir = Split-Path $target; $old = Join-Path $dir "old_$name"
	if (Test-Path $old) { Remove-Item $old -Force }
	Rename-Item -LiteralPath $target -NewName "old_$name"
	"renamed running $name to old_$name"
}
foreach ($p in $captured) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 800
"remaining captured: $(@($captured | Where-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }).Count)"
