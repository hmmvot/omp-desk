---
status: proposed
date: 2026-10-15
---

# Native Windows checks without PowerShell

## Problem

Desk answers four kinds of Windows question by starting `powershell.exe` and reading what a staged script prints:

- *does a live OMP hold this session's lease?* (a named mutex);
- *what is this process's kernel creation time, and what are its descendants?* (process identity and stop evidence);
- *who owns this path and who may write it?* (private storage, staged copies, the Bun executable);
- *is this pipe server the process we launched?* (the host-control peer proof).

Each answer is one Win32 call. Each is paid for with a PowerShell start. Measured on the maintainer's machine on 2026-10-15 (single runs, no loops):

| Measurement | Result |
| --- | --- |
| `powershell -NoProfile -Command 1` | 0.73–0.81 s wall, 1.2–1.6 s CPU (0.21 s wall the evening before) |
| `pwsh` 7, same command | 0.39 s wall, 0.4 s CPU |
| `cmd /c exit` | 16 ms CPU |
| Windows Defender CPU for one PowerShell start (`MsMpEng.exe`, 2 s tail) | about 2.1 s, against about 0.19 s for 3 idle seconds |
| `MsMpEng.exe` since boot (18 min uptime) | 992 CPU-seconds, the most of any process |
| 6 concurrent PowerShell starts | 0.88–0.90 s each (no CPU queueing; the cost is per start) |
| The lease helper, 1 name, from the same spawn the extension uses | 0.87 s |
| One security read of 9 real paths, today's PowerShell reader | 0.90–1.08 s |
| Windows PowerShell's engine assemblies (`System.Management.Automation`, `Microsoft.PowerShell.ConsoleHost`) | no NGEN root on this machine, so the engine is JIT-compiled on every start (a machine-side cause; not fixable by Desk) |

The user's logs show the effect. After every reload or resume the session-lease probe hits its 5 s bound (every window, every time), restore steps take 13–18 s (admission), 33–42 s (reconcile) and 15–28 s (spawn), and a host-control generation probe once timed out. The same helper runs in 0.2–0.9 s when nothing else is starting. A PowerShell start is an unbounded-latency step on this machine whenever the machine is busy, and Desk starts one every 15 s per window with a visible Sessions view, plus a chain of them at every restore.

## Goals and Non-goals

- Goals:
  - No `powershell.exe` start on a recurring path (the 15 s lease probe, the Processes reader and display reads) or on the restore and launch path (private-storage verification, identity readings, executable trust, the peer proof).
  - The same answers and the same refusals as today's scripts, the same fail-safe `unknown` verdicts, the same staged, hashed, verified trust model for code the extension loads.
  - Both `win32-x64` and `win32-arm64` in their VSIX, no download at run time, buildable in GitHub CI on `windows-latest` and locally without a C toolchain.
- Non-goals:
  - Machine-side fixes (NGEN, Defender exclusions): not Desk's to apply.
  - Replacing `icacls.exe` (only when a store is not yet limited; one start, once per store, not PowerShell) or `taskkill.exe` (stop and Kill).
  - Replacing the long-lived owner-watch helper (`pty-owner-watch.ps1`, one process per folder-shell broker, ADR-0030), the WinRT toast script (ADR-0042, event-driven) or the one-time terminal font discovery (first terminal pane of a window). Each is neither recurring nor on the restore path; see Inventory. They stay and are recorded as follow-ups.

## Current State

### Inventory of PowerShell starts

Every `windowsPowerShellExecutable()` caller and every `startToolSpawnTrace("powershell", …)` user, classified by how often it runs and whether it sits on the restore or launch path:

| Site | What it asks | Frequency | Restore / launch path | Disposition |
| --- | --- | --- | --- | --- |
| `omp-session-lease.ts` → `session-lease-probe.ps1` | `OpenMutex` of up to 200 lease mutexes | every 15 s heartbeat per window with the Sessions view visible (verdict TTL 2 s); once per explicit launch (`fresh`) | launch (the explicit-launch lease question) | slice 1 |
| `pty-identity.ts` → `pty-process-probe.ps1 generation` | creation FILETIME of a pid | restore attach and reconcile per row; Processes reader and display reads; every 250 ms inside `waitForPtyProcessGone` during stop | restore, stop | slice 2 |
| same, `tree` | descendants of a pid | stop and Kill evidence | stop | slice 2 |
| `control-client.ts` → `verified-pipe.ps1 generation` | creation FILETIME right after a host's pid resolves | per host launch and re-adopt | launch, restore | slice 2 |
| `session-claim.ts` `readCreationTime` | process start time (ISO) | this process once at activation; a claim holder per ownership verdict and per display read | activation, restore, every row observation | slice 2 |
| `private-storage.ts` `readStorageSecurity` (inline script) | account SID, every ACE, owner, for N paths | broker state directory once per window at activation (every attach awaits it); every `stageRuntimeAssets`/`stageRuntimeTree` (four per window); the PTY runtime proof | restore, launch | slice 3 |
| `executable-trust.ts` → `readStorageSecurity` | same, for the Bun executable and its directories | every Bun-eligible Chat start | launch | slice 3 |
| `control-client.ts` → `verified-pipe.ps1 bridge` | open a pipe once, read the server pid from that handle, relay frames | one long-lived process per host-control connection | restore, launch (after restore ends) | slice 4 |
| `pty-owner-watch.ts` → `pty-owner-watch.ps1` | hold a synchronize handle on the owning VS Code main, wait | one per broker that supervises a folder shell; lives with the broker | shell open | out of scope |
| `desktop-notifications.ts` | WinRT toast | per notification | no | out of scope (WinRT) |
| `terminal-fonts.ts` | installed font families via `System.Drawing` | once per window, on the first terminal pane | no | out of scope |
| `private-storage.ts` `applyIcaclsDefault` | rewrite a store's rules | only when a store is not limited yet | rare | stays (`icacls.exe`, not PowerShell) |
| `session-kill.ts` | `taskkill /T /F` | stop, Kill | stop | stays (not PowerShell) |

Everything that reads a process or an access list is one kernel call behind a script. The contracts around those scripts are already narrow: `queryPtyProcessIdentity`/`queryPtyProcessTree` return tri-state readings, `readStorageSecurity` returns a typed `PrivateStorageSecurityRead`, `ControlPeerBridge.open` returns a channel, and the lease probe is a `LeaseProbe` function. A native backend slots in behind each.

## Proposed Design

### Mechanism: Win32 called in process through a staged `koffi.node`

[koffi](https://koffi.dev) (MIT) is a dynamic C FFI shipped as one Node-API addon per platform (`@koromix/koffi-win32-x64`, `@koromix/koffi-win32-arm64`, 1.0 MB each, prebuilt by its author). It loads with `process.dlopen` and needs none of its JavaScript: the raw addon exposes `load`, `func`, `struct`, `decode`, `view`, `alloc` and asynchronous calls. Desk ships only `koffi.node`, stages it like every other asset it loads, and calls `kernel32`, `advapi32` and `ntdll` from TypeScript.

Measured once each on the maintainer's machine:

| | Spawn | In process |
| --- | --- | --- |
| Lease probe | PowerShell 870 ms | `OpenMutexW` 0.04 ms; `dlopen` 1–2 ms once per process |
| 9-path owner and ACL read | PowerShell 900–1080 ms | 1.1 ms (decoded in TypeScript) |
| Creation time of a pid | PowerShell start, 0.7 s and more | 0.09 ms |
| Descendants (448-process table) | PowerShell with WMI, longer than a start | 9 ms |
| A native helper `.exe` doing the lease call | 98 ms cold, 16 ms warm per spawn | n/a |

The raw addon loads in all three runtimes Desk runs in: Node, Electron's Node (the extension host), and Bun (the Chat broker). Read-back equivalence was checked against today's reader on nine real paths including `C:\Windows`: the same principals, masks and owners (the .NET reader returns the entries in canonical order, the kernel in stored order; every check Desk makes is per entry, so order carries no meaning).

### Module

`src/host/win32-native.ts` is the only module that touches the FFI. It exports:

```ts
export interface Win32Native {
  /** OpenMutexW(SYNCHRONIZE): "held", "absent" or "error"; never takes or waits on the mutex. */
  mutexState(name: string): "held" | "absent" | "error";
  /** OpenProcess(QUERY_LIMITED) + GetProcessTimes: found(FILETIME decimal) | gone | unknown. */
  processCreation(pid: number): ProcessCreationReading;
  /** One Toolhelp snapshot, walked in memory: every live descendant of a pid. */
  processDescendants(pid: number): Promise<ProcessTreeReading>;
  /** Account SID, plus owner and every allow/deny ACE for each path, as the typed reading readStorageSecurity returns. */
  readSecurity(paths: readonly string[]): Promise<Win32SecurityRead>;
  /** Slice 4. */
  openVerifiedPipe(...): ...;
}
export function loadWin32Native(asset: StagedRuntimeAsset): Win32Native;   // hash, dlopen, bind
export function win32Native(): Win32Native | null;                         // the process's instance
```

Semantics are fixed to today's, call by call:

- **Lease.** `Mutex.TryOpenExisting(name, Synchronize)`: `ERROR_FILE_NOT_FOUND`, `ERROR_PATH_NOT_FOUND` and `ERROR_INVALID_NAME` are *absent*; `ERROR_ACCESS_DENIED` is *held* (the object exists; an elevated OMP); anything else *error*, which leaves the name out of the answer exactly as `!LEASE error` does. The 5 s bound, the one-line failure log and the backoff are unchanged; a name that is not `Global\omp-file-lock-` plus 32 hex digits is refused before any call.
- **Creation time.** `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION)`; `ERROR_INVALID_PARAMETER` is *gone* (the helper's `PROCESS_QUERY_FAILED`); `ERROR_ACCESS_DENIED` and every other failure is *unknown*, as a helper that exited without an answer was. The value is `GetProcessTimes`' creation FILETIME as a decimal string, the same string the helper printed (`StartTime.ToFileTime()`). `session-claim`'s ISO form is derived from it.
- **Descendants.** One `CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS)`, breadth-first in memory, with a visited set (the PowerShell walk had none; a reused parent pid could loop it). A failed snapshot is *unknown*.
- **Security read.** `GetNamedSecurityInfoW(OWNER | DACL)`; every `ACCESS_ALLOWED`, `ACCESS_DENIED`, their object, callback and callback-object forms are entries, with the raw access mask and the allow/deny flag (as `GetAccessRules(true, true, SecurityIdentifier)` produced); audit, alarm and label ACEs are not entries. SIDs are formatted in TypeScript from the binary form. The token SID is `OpenProcessToken` + `GetTokenInformation(TokenUser)`. A path whose descriptor cannot be read has `entries: null`, a path whose owner cannot be read `owner: null`, each failing alone, exactly the report shape `parseStorageSecurity` produced. Display names (`SID (DOMAIN\name)`) come from `LookupAccountSidW`, called in the thread pool, and a SID that does not resolve stays bare; names are diagnostic only (ADR-0054).
- **Blocking.** Calls that cannot wait on anything outside the process (open mutex, open process, process times, the token) are synchronous. Calls that can stall in the filesystem or the security subsystem (`GetNamedSecurityInfoW`, `LookupAccountSidW`, the snapshot) run on koffi's worker threads so a slow path never stalls the extension host's event loop, the stall the 2026-10-13 catalog work removed elsewhere.

### Loading and trust

ADR-0012 stages every file Desk loads, because a `--force` reinstall cannot rename the extension folder while any process holds a file inside it, and a mapped DLL is held. `koffi.node` is therefore never loaded from the install folder:

1. The build copies the target's `koffi.node` to `out/native/koffi.node` (x64 from the installed optional package; arm64 fetched by `scripts/native-assets.mjs`, pinned by version and by the integrity hash already recorded in `package-lock.json`).
2. At activation the extension stages it with the existing content-addressed copy (`<globalStorage>/runtime/<sha256>/koffi.node`), verifies the copy's hash immediately before `process.dlopen`, and loads it once per process. The broker receives the staged path and digest on its command line (`--native`, `--native-sha256`, replacing `--helper`/`--helper-sha256`), re-reads and re-hashes immediately before its own `dlopen`.
3. **Order.** The staging's access verification (ADR-0012 decision 5, ADR-0054) needs the security read, which needs the module. The first verification of a layout therefore runs *after* the verified-by-hash copy is loaded, not before; if it refuses, the module is marked unusable (`win32Native()` returns `null`, every reading is `unknown`, staging refuses as it does today for a loose tree) and nothing else is staged or started. The consequence, stated in the ADR: in an environment where another account can already write the runtime directory, a swap in the instant between the hash read and `LoadLibrary` would run in the extension host once before the refusal. The same non-atomic verify-then-execute gap exists today for every staged helper (ADR-0074, "usable only by principals the rule admits"); the new ordering widens it only for a tree that is already misconfigured, and the refusal that follows is unchanged. The alternative, a one-shot child process that verifies the layout natively before the parent loads, is recorded in the ADR and not taken.
4. An unavailable module (hash mismatch, arch mismatch, `dlopen` failure, an antivirus that removed the file) is one log line with the cause, never a retry loop and never a silent success: every reading is `unknown`, every private-storage verification refuses.

### Packaging, build and CI

- `package.json` gains one exact devDependency, `koffi` 3.3.3 (and with it the two platform packages as optional dependencies, recorded with their integrity hashes in the lockfile). `npm ci` on `windows-latest` installs the x64 addon; `scripts/native-assets.mjs` provides the arm64 addon by downloading the locked tarball, checking its recorded `sha512` integrity and extracting `koffi.node`. No C toolchain is needed locally or in CI.
- `esbuild.mjs` copies `out/native/koffi.node` for `OMP_DESK_TARGET` (the host architecture when unset) and deletes the `.ps1` helpers it copied for these slices.
- `docs/publishing.md` lists `out/native/koffi.node` in each VSIX and checks that the x64 package holds the x64 addon and the arm64 package the arm64 one (PE machine type). `THIRD_PARTY_NOTICES.txt` gains koffi's MIT notice.
- No workflow change: CI already runs `npm ci`, `npm run build` and the test suite on `windows-latest`; the real-Windows tests run there too.

### Slices

1. **Loader and lease probe.** `win32-native.ts` (load, `mutexState`), the staging and activation wiring, `powershellLeaseProbe` becomes `nativeLeaseProbe` over `mutexState` (the line protocol and `parseLeaseReport` go with the script), `session-lease-probe.ps1` deleted. The real-mutex test's holder becomes a Node child that creates the mutex through the same module.
2. **Process identity.** `processCreation` and `processDescendants` behind `queryPtyProcessIdentity`, `queryPtyProcessTree`, `queryControlProcessGeneration` and `readProcessCreationTime`; the `PtyProbeHelper` parameter disappears from the readers and every caller (`pty-client`, `pty-runtime`, `local-kill`, `pty-broker`, wiring), the broker's `--helper` pair becomes `--native`; `pty-process-probe.ps1` and the generation mode of `verified-pipe.ps1` are deleted.
3. **Security reads.** `readStorageSecurity` and `executable-trust` read through `readSecurity`; the inline script, `parseStorageSecurity`'s process-output path and the `PrivateStorageCommandResult` plumbing for the reader are removed; the typed report replaces the JSON round trip where the probe contract allows (the probe interface tests use keeps its shape).
4. **Peer proof.** `openVerifiedPipe`: `CreateFileW` on the pipe with overlapped I/O, `GetNamedPipeServerProcessId` and the creation time read from that one handle, then two worker-thread loops (read, write) on overlapped events. Implemented only after a prototype shows the relay passes the existing control-client protocol tests unchanged; if it does not, `verified-pipe.ps1 bridge` stays, the design records it as the one remaining restore-path start, and the claim of this design is narrowed in the document, not silently.

Each slice ships with unit tests behind injected backends, real-Windows tests beside the existing real-mutex and real-ACL tests, the deletion of what it obsoletes, documentation and a CHANGELOG line, and one commit.

## Alternatives

- **A native Node-API addon written for Desk (C, MSVC).** The same in-process numbers, a smaller attack surface (only the calls Desk needs) and no third-party binary. Rejected: it needs MSVC with the ARM64 cross tools in CI and locally (the maintainer previously declined a C++ toolchain, ADR-0029; this machine has x64 tools only and cannot build or test arm64), a per-architecture build step Desk does not have today, and a second review surface for memory-safety of hand-written C. koffi puts the same calls in reviewed TypeScript.
- **A native helper `.exe` (C or Rust), staged and spawned.** Isolates a crash and fits ADR-0012 exactly (hash, spawn). Measured 98 ms cold and 16 ms warm per start: 50 times cheaper than PowerShell, but still a process creation on every probe, so it still pays whatever per-process cost the machine adds (Defender charged about 0.7 s of CPU for `cmd /c exit` in the same measurement), and still needs a build for two architectures.
- **A resident PowerShell helper that answers many requests.** Removes the recurring starts but keeps the 0.8 s first start on the restore path and 60–80 MB resident per window. Considered, not taken.
- **Reduce the cadence or batch more.** Fewer starts, same cost each; the restore path is a chain of mandatory ones. Not a fix.
- **`pwsh` 7.** 0.4 s, not installed by default, and the staged helpers are written for 5.1 (`windows-powershell.ts`).

## Risks and Open Questions

- **Third-party native code in the extension host.** koffi is a generic FFI: any code in the host could call any export. Code in the extension host already runs with the user's rights and can spawn anything, so no boundary moves; the control is that Desk loads exactly the hashed bytes it shipped, pinned by version and integrity in the lockfile and the build.
- **Antivirus.** A DLL load can be blocked or quarantined by a product that distrusts an unsigned FFI library. The failure is one clear log line and every check reading `unknown` or refusing (no session starts); there is deliberately no PowerShell fallback, which would keep the code this removes. Whether Defender on the maintainer's machine scans or objects at load is observed in the smoke test.
- **FFI memory safety.** TypeScript decoding native memory (ACLs, snapshot rows) can read out of bounds if written wrongly. Every length is checked against the ACL's own declared size before it is read, with tests over crafted blobs; native memory returned by the system is freed in `finally`.
- **arm64 is built and shipped but cannot be run here.** Struct layouts are koffi's to translate; the Win32 types used (`ULONG_PTR`, `PROCESSENTRY32W`) are the only pointer-sized fields. The PE machine type of the packaged addon is checked in the VSIX gate; an arm64 run is the maintainer's.
- **Name lookups.** `LookupAccountSidW` can wait on a domain controller for an unresolvable domain SID; the call runs on a worker thread and the name is diagnostic, the same exposure the `Translate` call in today's script had.
- **Sizing.** +1 MB per VSIX, about 1–2 ms of load, no resident process.

## Rollout and Verification

Slices in the order above, each committed separately on `main`, none pushed. Checks per slice: `npm run typecheck`, the focused test files (`omp-session-lease`, `pty-identity`, `private-storage`, `executable-trust`, `control-client`, `runtime-assets` and the new `win32-native` test), the real-Windows tests, and a diff of readings against the removed scripts on this machine before they are deleted. After the last slice: one hidden test window (`scripts/test-vscode.ps1`, CDP), showing the `tool spawn: powershell` lines gone from steady state and the restore step timings before and after, then the VSIX build. The full `npm test` and e2e suites are not run without the maintainer's agreement.

## Related Decisions

- [ADR-0076](../decisions/0076-call-win32-in-process-through-a-staged-koffi-module-instead-of-starting-powershell.md) (this design's choice)
- [ADR-0012](../decisions/0012-run-child-process-entries-from-staged-copies.md), [ADR-0054](../decisions/0054-verify-private-windows-storage-with-security-identifiers.md), [ADR-0046](../decisions/0046-probe-omp-session-lease-for-external-writers.md), [ADR-0035](../decisions/0035-distinguish-a-recorded-process-from-a-later-occupant-of-its-pid.md), [ADR-0006](../decisions/0006-host-generated-key-peer-verified-pipe.md), [ADR-0074](../decisions/0074-run-chat-brokers-on-the-sessions-own-bun-runtime-with-code-exe-as-fallback.md), [ADR-0029](../decisions/0029-report-uncontained-pty-tree-stop-as-unknown.md)

## Architecture Review

- Reviewer: architect
- Outcome: pending
- Notes: submitted to an independent reviewer; not yet reviewed.
