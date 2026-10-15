---
status: accepted
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
  - No `powershell.exe` start on a recurring path (the 15 s lease probe, the Processes reader and display reads) or on the restore and launch path (private-storage verification, identity readings, executable trust, the peer proof), with one exception: a folder shell's owner-watch helper (`pty-owner-watch.ps1`, one per folder-shell broker; the first attach of a folder shell awaits its readiness) stays on PowerShell and remains a launch-path start for that kind of session.
  - The same answers and the same refusals as today's scripts, the same fail-safe `unknown` verdicts, the same staged, hashed, verified trust model for code the extension loads.
  - Both `win32-x64` and `win32-arm64` in their VSIX, no download at run time, buildable in GitHub CI on `windows-latest` and locally without a C toolchain.
- Non-goals:
  - Machine-side fixes (NGEN, Defender exclusions): not Desk's to apply.
  - Replacing `icacls.exe` (only when a store is not yet limited; one start, once per store, not PowerShell) or `taskkill.exe` (stop and Kill).
  - Replacing the long-lived owner-watch helper (`pty-owner-watch.ps1`, one process per folder-shell broker, ADR-0030), the WinRT toast script (ADR-0042, event-driven) or the one-time terminal font discovery (first terminal pane of a window). None is recurring; only the owner-watch start sits on a launch path (a folder shell's first attach awaits its readiness), see Inventory. They stay and are recorded as follow-ups.

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
| `pty-owner-watch.ts` → `pty-owner-watch.ps1` | hold a synchronize handle on the owning VS Code main, wait | one per broker that supervises a folder shell; lives with the broker | folder shell: the first attach awaits the broker's owner-watch readiness (`admitOwner`) | out of scope: the one PowerShell start that stays on a launch path, for folder shells only; a follow-up |
| `pty-broker.ts` (every broker start) | own creation time, child creation time | once per broker start | restore, launch | slice 2 (the broker loads the addon) |
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
export function loadWin32Native(asset: StagedRuntimeAsset): Win32Native;   // PE machine, hash, dlopen, bind a fixed prototype table
export function win32Native(): Promise<Win32Native | null>;               // one shared load per process; null once settled unavailable
```

Semantics are fixed to today's, call by call; where the native reading differs it is stricter, and each delta is a test:

- **Lease.** `Mutex.TryOpenExisting(name, Synchronize)`: `ERROR_FILE_NOT_FOUND`, `ERROR_PATH_NOT_FOUND`, `ERROR_INVALID_NAME` and `ERROR_INVALID_HANDLE` (another object type holds the name; .NET returns false) are *absent*; `ERROR_ACCESS_DENIED` is *held* (the object exists; an elevated OMP); anything else *error*, which leaves the name out of the answer exactly as `!LEASE error` does. A name that is not `Global\omp-file-lock-` plus 32 hex digits is refused before any call. The call is synchronous and cannot hang, so the 5 s bound is not carried over; the verdict TTL, the failure backoff (for an unavailable module) and the one-line failure log are.
- **Creation time.** `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION)`; `ERROR_INVALID_PARAMETER` is *gone* (the helper's `PROCESS_QUERY_FAILED`); a process that has exited but is still referenced by an open handle (`GetExitCodeProcess` not `STILL_ACTIVE`, as libuv decides) is *gone* too, as `Get-Process` made it; `ERROR_ACCESS_DENIED` and every other failure is *unknown*, as a helper that exited without an answer was. The value is `GetProcessTimes`' creation FILETIME as a decimal string, the string the helper printed. `session-claim`'s ISO form is `floor(FILETIME / 10^4)` milliseconds.
- **Descendants.** One `CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS)` (retried on `ERROR_BAD_LENGTH`), breadth-first in memory, with a visited set (the PowerShell walk had none; a reused parent pid could loop it). A failed snapshot is *unknown*.
- **Security read.** `GetNamedSecurityInfoW(OWNER | DACL)`; every `ACCESS_ALLOWED`, `ACCESS_DENIED`, their object, callback and callback-object forms are entries with the raw access mask and the allow/deny flag; audit, alarm and label ACEs are not entries; an ACE type the module does not know refuses (`unknown`). Against `GetAccessRules(true, true, SecurityIdentifier)` the reading is the same or stricter: an object ACE on a file is reported (the .NET reader dropped it), ACEs for one SID are not merged (every check is per entry, so no effect), callback ACEs are reported by both. A NULL DACL is one `allow S-1-1-0 0xffffffff` entry, as .NET reports it, and an empty entry list stays unreadable (`parseWindowsAcl`'s rule), so neither can pass the store or ancestor checks. SIDs are formatted in TypeScript from the binary form. The token SID is `OpenProcessToken` + `GetTokenInformation(TokenUser)`. A path whose descriptor cannot be read has `entries: null`, a path whose owner cannot be read `owner: null`, each failing alone, exactly the report shape `parseStorageSecurity` produced. A reading carries SIDs only; `SID (DOMAIN\name)` display names (`LookupAccountSidW`, no backslash when the domain is empty, a SID that does not resolve stays bare) are resolved only for the SIDs a refusal message names; names are diagnostic only (ADR-0054).
- **Blocking.** Calls that cannot wait on anything outside the process (open mutex, open process, process times, the token) are synchronous. `GetNamedSecurityInfoW`, the snapshot and any name lookup run on koffi's worker threads (libuv's shared pool), so a slow path never stalls the extension host's event loop. Desk uses one lane for them: at most one call in flight, the rest queued, each request with a deadline after which its reading is `unknown`. A call past its deadline keeps the lane until it returns (it cannot be cancelled), so later readings answer `unknown` at their own deadlines and Desk never starts a second pool call; a name lookup after a refusal shares the lane, so a stalled lookup holds it too. An asynchronous koffi call cannot read the Win32 last error, so the lookups use fixed-size buffers, not the two-call sizing pattern.

### Loading and trust

ADR-0012 stages every file Desk loads, because a `--force` reinstall cannot rename the extension folder while any process holds a file inside it, and a mapped DLL is held. `koffi.node` is therefore never loaded by the extension host from the install folder, and ADR-0012's rule that nothing staged is loaded before the layout is verified is kept:

1. The build copies the target's `koffi.node` to `out/native/koffi.node` (x64 from the installed optional package; arm64 fetched by `scripts/native-assets.mjs`).
2. The staging copies it to the content-addressed location (`<globalStorage>/runtime/<sha256>/koffi.node`). Slices 1 and 2: the existing staging writes and verifies the layout with PowerShell first, as for every staged helper, then the host re-hashes the copy immediately before `process.dlopen` and loads it once per process. From slice 3 the one-shot verifier child (`Code.exe` as Node on an install-folder entry that loads the install folder's own `koffi.node`, the same trust root as `out/extension.js`) writes the staged copy itself, establishes the rules, verifies the layout natively and exits with the verdict, under the existing 20 s bound; only then does the host re-hash and load. A refusal, a start failure or a timeout settles `win32Native()` to `null`. The hash-to-load gap that remains follows a passed verification, so only principals the rule admits can use it (the Bun design, 2026-10-14, "usable only by principals the rule admits"). A rejected alternative, a child loading the *staged* copy, protects nothing (same-user code is inside ADR-0006's boundary) and a load before the verification lets a substituted DLL falsify its own verdict.
3. The broker receives the staged path and digest on its command line (`--native`, `--native-sha256`, replacing `--helper`/`--helper-sha256`), re-reads and re-hashes immediately before its own `dlopen`. Its `--self-check` and `--pipe-only` runs take the same pair, load the addon and read one creation time, and both stored proofs (the full one and ADR-0074's pipe-only one) include the addon digest, so a runtime that cannot load the addon is never "proven".
4. **One awaited loader.** `win32Native()` returns one shared promise, started first thing in activation (before `readProcessCreationTime(process.pid)` and `stateAccess()`); every reader awaits it and `null` is only the settled "unavailable" answer. `session-claim` caches a failed creation-time reading for the process lifetime, so a reader that raced an unfinished load would cost the window its creation time for good.
5. An unavailable module (hash mismatch, arch mismatch, `dlopen` failure, an antivirus that removed the file) is one log line with the cause, never a retry loop and never a silent success: every reading is `unknown`, every private-storage verification refuses.

### Packaging, build and CI

- `package.json` gains one exact devDependency, `koffi` 3.3.3 (its 20 platform packages are optional dependencies recorded with their integrity hashes in the lockfile). `npm ci` on `windows-latest` installs the x64 addon (the build fails clearly if the platform package is missing, e.g. `--omit=optional`, instead of falling back to koffi's source build); `scripts/native-assets.mjs` provides the arm64 addon by downloading the locked tarball, checking its recorded `sha512` integrity before writing anything, refusing on a mismatch, and extracting `koffi.node`. The expected SHA-256 of each architecture's `koffi.node` is pinned in the repository, so a version bump is a reviewed hash change. No C toolchain is needed locally or in CI.
- `esbuild.mjs` copies `out/native/koffi.node` for `OMP_DESK_TARGET` (the host architecture when unset; a single file where node-pty uses a per-architecture directory, because each VSIX holds one) and deletes the `.ps1` helpers it copied for these slices.
- `package-vsix.mjs` checks the PE machine type of the packaged addon (x64 `0x8664`, arm64 `0xaa64`) and its pinned digest, automatically; the loader checks the machine type before `dlopen`. `docs/publishing.md` lists `out/native/koffi.node` in each VSIX. `THIRD_PARTY_NOTICES.txt` gains koffi's MIT notice.
- No workflow change: CI already runs `npm ci`, `npm run build` and the test suite on `windows-latest`; the real-Windows tests run there too.

### Slices

1. **Loader and lease probe.** `win32-native.ts` (load, `mutexState`), the staging and activation wiring (staged by the existing staging, whose PowerShell verification runs before the host loads it), `powershellLeaseProbe` becomes `nativeLeaseProbe` over `mutexState` (the line protocol and `parseLeaseReport` go with the script; the 5 s bound goes, as a synchronous call cannot hang, and the failure backoff stays so an unavailable module is not asked and logged on every observation), `session-lease-probe.ps1` deleted. The real-mutex test's holder becomes a Node child that creates the mutex through the same module.
2. **Process identity.** `processCreation` and `processDescendants` behind `queryPtyProcessIdentity`, `queryPtyProcessTree`, `queryControlProcessGeneration` and `readProcessCreationTime`; the `PtyProbeHelper` parameter disappears from the readers and every caller (`pty-client`, `pty-runtime`, `local-kill`, `pty-broker`, wiring), the broker's `--helper` pair becomes `--native` (also on `--self-check` and `--pipe-only`, with the digest in the proof key; the attach tree digest then comes from `ptyPackagedTreeDigest` alone); `pty-process-probe.ps1` and the generation mode of `verified-pipe.ps1` are deleted. `session-claim`'s ISO string is `floor(FILETIME / 10^4)` milliseconds, which is what V8 made of PowerShell's 7-digit fraction, so claims filed by an earlier build still compare equal.
3. **Security reads and the verifier child.** `readStorageSecurity` and `executable-trust` read through `readSecurity`; the inline script, `parseStorageSecurity`'s process-output path and the `PrivateStorageCommandResult` plumbing for the reader are removed; the typed report replaces the JSON round trip where the probe contract allows (the probe interface tests use keeps its shape), and the NULL-DACL entry and the "empty means unreadable" rule are both kept and tested. The one-shot verifier entry (`Code.exe` as Node, loading the install folder's `out/native/koffi.node`) stages and verifies the koffi layout natively before the host loads its staged copy (ADR-0076 decision 4).
4. **Peer proof.** `openVerifiedPipe`: `CreateFileW` on the pipe with overlapped I/O, `GetNamedPipeServerProcessId` and the creation time read from that one handle, then completion by Windows thread-pool waits (`RegisterWaitForSingleObject`, koffi callbacks marshalled to the JS thread) so that no libuv pool thread is held per connection. Implemented only after a prototype shows the relay passes the existing control-client protocol tests unchanged and holds no pool thread per connection; if it does not, `verified-pipe.ps1 bridge` stays, the design records it as the one remaining restore-path start, and the claim of this design is narrowed in the document, not silently.

Each slice ships with unit tests behind injected backends, real-Windows tests beside the existing real-mutex and real-ACL tests, the deletion of what it obsoletes, documentation and a CHANGELOG line, and one commit.

## Alternatives

- **A native Node-API addon written for Desk (C, MSVC).** The same in-process numbers, a smaller attack surface (only the calls Desk needs) and no third-party binary. Rejected: it needs MSVC with the ARM64 cross tools in CI and locally (the maintainer previously declined a C++ toolchain, ADR-0029; this machine has x64 tools only and cannot build or test arm64), a per-architecture build step Desk does not have today, and a second review surface for memory-safety of hand-written C. koffi puts the same calls in reviewed TypeScript.
- **A native helper `.exe` (C or Rust), staged and spawned.** Isolates a crash and fits ADR-0012 exactly (hash, spawn). Measured 98 ms cold and 16 ms warm per start: 50 times cheaper than PowerShell, but still a process creation on every probe, so it still pays whatever per-process cost the machine adds (Defender charged about 0.7 s of CPU for `cmd /c exit` in the same measurement), and still needs a build for two architectures.
- **A resident PowerShell helper that answers many requests.** Removes the recurring starts but keeps the 0.8 s first start on the restore path and 60–80 MB resident per window. Considered, not taken.
- **Reduce the cadence or batch more.** Fewer starts, same cost each; the restore path is a chain of mandatory ones. Not a fix.
- **`pwsh` 7.** 0.4 s, not installed by default, and the staged helpers are written for 5.1 (`windows-powershell.ts`).

## Risks and Open Questions

- **Third-party native code in the extension host.** koffi is a generic FFI: any code in the host could call any export. Code in the extension host already runs with the user's rights and can spawn anything, so no boundary moves; the controls are the exact version and the lockfile integrity, a repository-pinned SHA-256 per architecture, one staged and hashed file, and a single module (`win32-native.ts`, enforced by `check-imports.mjs`) that binds a fixed table of prototypes.
- **Crash domain.** A decoding error in TypeScript over native memory now crashes the extension host and every extension in it, not a helper. TypeScript is no safer than hand-written C here, only easier to review and test; every length is checked against the structure's own declared size, with tests over crafted blobs, and native memory is freed in `finally`.
- **Antivirus and unsigned DLLs.** A DLL load can be blocked or quarantined by a product that distrusts an unsigned FFI library (neither shipped `koffi.node` is Authenticode-signed; node-pty's `conpty.node` is not either, so Terminals already depend on one). The failure is one clear log line, shown where the session fails to start, and every check reading `unknown` or refusing; there is deliberately no PowerShell fallback. New: Chat on Bun did not load a native module before, so such an environment now loses Chat too. Whether Defender on the maintainer's machine objects is observed in the smoke test.
- **arm64 is built and shipped but cannot be run here.** Struct layouts are koffi's to translate; the only pointer-sized fields are `ULONG_PTR` and the `PROCESSENTRY32W` ones. The PE machine type is checked by the build; GitHub's `windows-11-arm` runners could run the real-Windows tests [INFERENCE, not verified]; an arm64 run is otherwise the maintainer's.
- **Shared thread pool.** koffi's asynchronous calls run on libuv's pool, which every extension in the host shares (4 threads by default), and a Win32 call cannot be cancelled. Mitigation: at most one Desk call in flight, a deadline per reading that answers `unknown`, no account-name lookups on the admission path, and no pool thread held for a connection's life (slice 4's gate).
- **Sizing.** +1 MB per VSIX, about 1–2 ms of load, no resident process; one short-lived `Code.exe` per activation from slice 3.

## Re-adoption timing (measured 2026-10-15, hidden test window, warm reload of one live Bun-broker Chat)

The user's logs showed `reconcile 8.6 s` (two tabs, one shared promise) and `admission 4.7–18 s`. Each wait was a PowerShell run: the state-directory access check, the window's own and the owner's creation times (`claimHolderReady`, `claimHolderMayBeAlive`). With the checks native: `reconcile 118–138 ms` (`broker client 108–124` = the tree digest and the first load of the staged module, `record 2–7`, `connect 5–15`, `status 2–5`, `child identity 0`, `broker confirm 0`, `pin proof 0`), `admission 12–30 ms`, `attach 166–247 ms` of which `intent 155–219 ms` was a second full catalog write, and the whole tab 411–623 ms. Decisions, none of which changes an accepted ADR decision:

1. **Tree digest** stays a hash of the packaged tree at run time, started once at activation (about 30 ms for 3 MB), not a build-time file. It only decides "same build" for a broker that attests itself (ADR-0024, ADR-0035), and anyone who can edit the extension folder already runs code in the host; a build-time file would add a second thing to keep in step with the tree for a 30 ms saving.
2. **State-directory access** already starts at activation and is awaited only by what needs it (`connect` reports it `(shared)`). It now costs one native call, not an `icacls`/PowerShell run.
3. **The PTY runtime self-check** is not on the re-adoption path: `attachClient()` needs only the tree digest; the proof reused or run after the restore (`PTY runtime proof reused … ready in 253 ms`, `proved itself: self-check 4359 ms` came after `restore finished`).
4. **The child's identity** is the broker's attestation (ADR-0035 amendment 2026-10-13), 0 ms; a kernel read is a native call.
5. **Connection reuse** is not done: attach's `connect` is 6–23 ms, and sharing a connection across two authenticated protocol phases would couple them for nothing.
6. **The second catalog write** (`intent`, 155–219 ms) is removed: `LocalLauncher.attach` recorded `runIntent` and a detail, and the index then recorded the same intent with the adopted host in the write that follows. The index's one write remains (60–145 ms, the profile catalog's lock and `fsync`).

Found by the smoke run, not by the tests: `koffi.view` over a pointer makes an ArrayBuffer over external memory, which Electron's V8 refuses (`FATAL ERROR: Error::New napi_get_last_error_info`, the process aborts); Node does not. The native module now copies native memory with `RtlMoveMemory` into a `Buffer`, and `native-stage-client.test.ts` runs the stage child under VS Code's own `Code.exe` (`ELECTRON_RUN_AS_NODE`) when one is installed.

## Rollout and Verification

Slices in the order above, each committed separately on `main`, none pushed. Checks per slice: `npm run typecheck`, the focused test files (`omp-session-lease`, `pty-identity`, `private-storage`, `executable-trust`, `control-client`, `runtime-assets` and the new `win32-native` test), the real-Windows tests, and a diff of readings against the removed scripts on this machine before they are deleted. After the last slice: one hidden test window (`scripts/test-vscode.ps1`, CDP), showing the `tool spawn: powershell` lines gone from steady state and the restore step timings before and after, then the VSIX build. The full `npm test` and e2e suites are not run without the maintainer's agreement.

## Related Decisions

- [ADR-0076](../decisions/0076-call-win32-in-process-through-a-staged-koffi-module-instead-of-starting-powershell.md) (this design's choice)
- [ADR-0012](../decisions/0012-run-child-process-entries-from-staged-copies.md), [ADR-0054](../decisions/0054-verify-private-windows-storage-with-security-identifiers.md), [ADR-0046](../decisions/0046-probe-omp-session-lease-for-external-writers.md), [ADR-0035](../decisions/0035-distinguish-a-recorded-process-from-a-later-occupant-of-its-pid.md), [ADR-0006](../decisions/0006-host-generated-key-peer-verified-pipe.md), [ADR-0074](../decisions/0074-run-chat-brokers-on-the-sessions-own-bun-runtime-with-code-exe-as-fallback.md), [ADR-0029](../decisions/0029-report-uncontained-pty-tree-stop-as-unknown.md)

## Architecture Review

- Reviewer: architect (`NativeChecksArchReview`), 2026-10-15. First verdict: accept with required changes (M1–M7 material, O1–O10 optional).
- Resolved in this text: M1 (loading and trust: ADR-0012's order kept, PowerShell verification until slice 3, then a verifier child), M2 (ADR-0076 decision 10 lists the amended ADRs), M3 (the broker self-check pair and the proof key), M4 (bounded calls), M5 (a to d in "Module"), M6 (one awaited loader), M7 (goals, inventory), O1–O7, O9, O10.
- Open for the maintainer: a blocked unsigned DLL now also stops Chat (O9).
- Confirmation pass (same reviewer, read-only, checked against code): M1, M3, M5, M6, M7 confirmed resolved; four text-only requirements (R1 banners and index entry, R2 two citations, R3 the verifier child writes the staged copy, R4 the lane keeps its slot past a deadline) and three optional notes were applied; no further pass was required. Accepted on that basis; implementation follows.
