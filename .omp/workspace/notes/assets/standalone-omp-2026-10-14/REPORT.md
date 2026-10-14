# Standalone omp.exe: "unknown flags: --define, --preload" (2026-10-14)

Installer: winget `can1357.oh-my-pi` is the portable raw `omp-windows-x64.exe` (SHA256 matched a direct download); `install.ps1` without bun installs the same binary to `%LOCALAPPDATA%\omp\omp.exe`; mise `github:` too. No MSI/setup exists.
Cause: OMP 18.10.3 (Bun 1.4.3) compiled program parses `--define`/`--preload` as OMP flags and exits 2. It honours both through `BUN_OPTIONS` (spaces/unicode need backslash escaping; quoted `--preload "p"` is silently ignored).
Fix: ADR-0075. bun-shim keeps argv; compiled/unknown launchers get BUN_OPTIONS only after a nonce probe (`omp --version` + media/runtime-probe.mjs), else no flags and a notice. Modules restore the inherited BUN_OPTIONS.
Proof: `npm run test:e2e -- 15-standalone-omp` with the winget Links dir first on PATH (hidden desktop, throwaway VS Code copy, mutex ompdesksatest): FAILED on pre-fix HEAD ("OMP exited with code 2. Error: unknown flags: --define, --preload"), PASSED on the fixed tree (Chat reply, host control verified, no --preload/--define on omp.exe command line).
Run from bash: use `;` as PATH separator with Windows-style paths.
