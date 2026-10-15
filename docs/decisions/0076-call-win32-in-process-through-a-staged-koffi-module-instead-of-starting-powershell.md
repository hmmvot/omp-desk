---
status: proposed
date: 2026-10-15
---

# ADR-0076: Call Win32 in process through a staged koffi module instead of starting PowerShell

## Context and Problem Statement

Desk answers its Windows questions (a lease mutex, a process's creation time and descendants, the owner and access list of a path, the server of a pipe) by starting `powershell.exe`. Each answer is one Win32 call. On the maintainer's machine a PowerShell start costs 0.73–0.81 s wall and 1.2–1.6 s CPU (0.21 s the evening before), and Windows Defender spends about 2.1 s of CPU on each start; every reload showed the 5 s lease probe timing out in every window and restore steps of 13–42 s. Desk starts one PowerShell every 15 s per window with the Sessions view visible, and a chain of them at every restore and launch. The cost is per start and is set by the machine, not by the script. The [design](../designs/2026-10-15-native-windows-checks-without-powershell.md) has the inventory and the measurements.

Requirements: no PowerShell start on a recurring, restore or launch path; the same answers, refusals and fail-safe `unknown` verdicts as today's scripts; the staged, hashed, verified trust model of [ADR-0012](0012-run-child-process-entries-from-staged-copies.md); both `win32-x64` and `win32-arm64` in the VSIX, no download at run time; buildable on GitHub's `windows-latest` and locally without a C toolchain (the maintainer declined one for [ADR-0029](0029-report-uncontained-pty-tree-stop-as-unknown.md)).

## Considered Options

- **Keep PowerShell and start it less** (longer cache, fewer rows, a resident helper): lower load, but the restore path is a chain of mandatory starts and the first start of a resident helper is the same 0.8 s or more.
- **A native helper executable (C or Rust) that Desk stages and spawns:** 98 ms cold and 16 ms warm per start on this machine, crash-isolated, a natural fit for ADR-0012. Still one process creation per question (and whatever per-process cost the machine adds), and it needs an MSVC or Rust build for two architectures, ARM64 cross tools in CI, and a second review surface.
- **A Node-API addon written for Desk:** in process, only the needed calls, no third-party binary. Needs the same toolchain and per-architecture build, cannot be built or run for arm64 on this machine, and puts hand-written C in the extension host.
- **koffi, a prebuilt FFI addon, called from TypeScript:** in process (0.04 ms for the lease call, 1.1 ms for a nine-path ACL read, 9 ms for a process tree), no build step, both architectures prebuilt and integrity-pinned in the lockfile, loads in Node, Electron's Node and Bun. Third-party native code in the host, and a generic FFI primitive instead of a minimal one. Chosen.
- **`pwsh` 7:** 0.4 s, not installed by default; the helpers are written for 5.1.

## Decision Outcome

1. **Mechanism.** Desk ships `out/native/koffi.node` (one file per VSIX, the target's architecture, version 3.3.3 exactly) and calls `kernel32`, `advapi32` and `ntdll` through it from `src/host/win32-native.ts`, the only module that touches the FFI. It uses the raw addon through `process.dlopen`; koffi's JavaScript wrapper is not shipped.
2. **Same answers.** The module reproduces each script's contract, call by call (design, "Module"): `OpenMutexW(SYNCHRONIZE)` with `TryOpenExisting`'s mapping (`FILE_NOT_FOUND`, `PATH_NOT_FOUND`, `INVALID_NAME` absent; `ACCESS_DENIED` held; else error); `OpenProcess(QUERY_LIMITED)` + `GetProcessTimes` for the FILETIME string (`INVALID_PARAMETER` gone, any other failure unknown); one Toolhelp snapshot walked in memory for descendants; `GetNamedSecurityInfoW(OWNER|DACL)` with every allow and deny ACE (object and callback forms included) as raw mask and flag, SIDs formatted from the binary form, the token SID from `GetTokenInformation`. The typed results are the ones `queryPtyProcessIdentity`, `queryPtyProcessTree`, `readStorageSecurity` and the lease probe already return, so no consumer changes meaning.
3. **Staged and verified like every loaded file.** `koffi.node` is copied to `<globalStorage>/runtime/<sha256>/koffi.node` by the existing content-addressed staging; each process re-reads and re-hashes the copy immediately before its one `dlopen` (the broker gets `--native` and `--native-sha256`, replacing `--helper` and `--helper-sha256`). A loaded DLL is held open, so it is never loaded from the install folder (a `--force` reinstall must still succeed).
4. **Order of verification.** ADR-0012's access verification of the staged layout needs the security read, which needs the module. The module is loaded from the verified-by-hash copy first, and the layout is then verified by the module's own reads; a refusal marks the module unusable (every reading `unknown`, staging refuses as it does for a loose tree today) and nothing else is staged. In an environment where another account can already write the runtime directory, a swap between the hash read and the DLL load would run in the extension host once before the refusal. The same verify-then-execute gap exists for every staged helper today and is usable only by principals the rule would refuse; the new ordering widens it only for a tree that is already misconfigured. A one-shot child process that verifies the layout natively before the host loads anything was considered and not taken: it adds a process start and a second copy of the staging path to protect against a misconfiguration that is refused one step later.
5. **Fail-safe.** A module that cannot be loaded (hash, architecture, `dlopen`, quarantine by security software) is one log line naming the cause. Every reading is then `unknown` and every private-storage verification refuses, so no session starts. There is no PowerShell fallback: it would keep the scripts, their staging and a second implementation of every check.
6. **Slices.** Lease probe and loader; process identity (including the control channel's generation read and the claim start time); owner and ACL reads (private storage, executable trust); the peer proof (`CreateFileW` overlapped, server pid and creation time from that one handle, relayed by worker-thread loops) only if a prototype passes the existing control-client protocol tests. The obsolete scripts are deleted with the slice that obsoletes them. The owner-watch helper, the WinRT toast and the one-time font discovery stay on PowerShell (not recurring, not on the restore path); `icacls.exe` (a store's one-time rewrite) and `taskkill.exe` stay.
7. **Build.** `npm ci` provides the x64 addon; `scripts/native-assets.mjs` provides arm64 from the locked tarball, checking its recorded integrity. Neither needs a compiler. The VSIX gate checks the PE machine type of the packaged addon.

### Consequences

- Positive: no PowerShell start in steady state or on the restore and launch paths (the peer proof included once slice 4 lands); a lease probe, a creation-time reading and a security read cost microseconds to a millisecond instead of 0.7 s and more each, whatever else the machine is doing; no resident process; +1 MB per VSIX.
- Negative: one third-party native binary in the extension host, pinned by version and integrity; a generic FFI, so correctness rests on Desk's TypeScript decoding native memory (bounds-checked, tested against crafted blobs); a security product that blocks the DLL stops every session start, with a clear log line and no fallback; arm64 is packaged but not runnable on the development machine.
- Negative: the verification order in decision 4 runs trusted code before the layout check for the first load of a build.
- Negative: Desk's own Windows knowledge moves from readable scripts into TypeScript over struct layouts; the real-Windows tests (a held mutex, a real ACL, a real process tree, a real pipe) carry the proof that replaces "the script was the oracle".

## Related Documents

- [Native Windows checks without PowerShell](../designs/2026-10-15-native-windows-checks-without-powershell.md)
- [ADR-0012](0012-run-child-process-entries-from-staged-copies.md), [ADR-0054](0054-verify-private-windows-storage-with-security-identifiers.md), [ADR-0046](0046-probe-omp-session-lease-for-external-writers.md), [ADR-0035](0035-distinguish-a-recorded-process-from-a-later-occupant-of-its-pid.md), [ADR-0006](0006-host-generated-key-peer-verified-pipe.md), [ADR-0074](0074-run-chat-brokers-on-the-sessions-own-bun-runtime-with-code-exe-as-fallback.md), [ADR-0029](0029-report-uncontained-pty-tree-stop-as-unknown.md)

## Architecture Review

- Reviewer: architect
- Outcome: pending
- Notes: submitted to an independent reviewer; not yet reviewed.
