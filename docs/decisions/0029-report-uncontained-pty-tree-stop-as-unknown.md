---
status: accepted
date: 2026-09-27
---

# ADR-0029: Report uncontained PTY tree stops as unknown and retain recovery

> Managed-writer/transfer clauses narrowed by accepted [ADR-0040](0040-switch-one-editor-between-rpc-chat-and-native-pty.md): no Collab withdrawal, best-effort native identity transfer, and exact-root exit before extension-owned replacement. Implemented in source; the Windows whole-tree limitation remains unchanged.

> Folder-shell recovery clauses narrowed by the explicit 2026-10-08 product requirement: confirmed natural child exit retires its shell slot and broker; confirmed editor Terminate retires them after exact-child absence and authenticated `requireStopped` shutdown. Unknown or remaining descendants stay diagnostic evidence, never an empty-tree claim. A genuine child-stop/shutdown failure keeps recovery and Processes Stop. The broker's immutable registry record remains on disk. See [Current Architecture](../architecture.md#current-architecture) for implemented behavior; historical shell-slot retention clauses below no longer describe these successful exit paths.

## Context and Problem Statement

[ADR-0024](0024-own-omp-pty-for-in-tab-terminal.md) requires a folder shell's explicit Confirm to stop its exact process tree, including a manually launched OMP, and release its recoverable slot only after positive tree-exit proof. The installed Windows `node-pty` 1.1.0 ConPTY backend starts the root immediately with no private Job Object. A live `Win32_Process` parent-ID traversal can lose a still-running grandchild when its intermediary exited before inspection; `ClosePseudoConsole` covers only clients still attached. Thus an empty late snapshot plus a dead root is **not** proof that the launched tree ended. An earlier broker implementation incorrectly reported `tree:'empty', verified:true` on that evidence.

The kernel-backed solution is creation-time membership in a private no-breakaway Windows Job Object, retained by the broker and queried after `TerminateJobObject`. That requires a modified, reproducibly built native PTY addon and additional staging/ABI verification. This workstation has Python and a Windows SDK but no verified MSVC C++ toolset or project `node-gyp`. On 2026-09-27 the user explicitly chose **not** to install C++ Build Tools after being told that the full tree-stop criterion would remain unmet. Do not replace this decision with an unverified descendant-kill script or an automatic process stop.

## Considered Options

- Assign a private, non-breakaway Job Object during `CreateProcessW` (two STARTUPINFOEX attributes or create suspended/assign/resume), then terminate/query job membership: provides the positive ordinary OS-child-tree guarantee, but requires a native dependency patch and compiler/system installation that the user declined here. It cannot contain unrelated service/UAC/scheduler work merely triggered by a shell command.
- Infer success from root exit, ConPTY close or an empty live-parent snapshot: easy but can silently leave a detached child alive while reporting full success; reject.
- Retain the prebuilt native addon; attempt to stop the matched root without directly signalling descendant snapshot PIDs, and report `tree:'remaining'` for observed survivors or `tree:'unknown'` otherwise, always `verified:false` without kernel group ownership: chosen safety-preserving, incomplete behavior. Closing ConPTY can affect still-attached clients, so this does not promise effects limited to the root.

## Decision Outcome

For the current Windows prebuilt `node-pty` path, never claim positive exact-tree termination from a live process-table walk. An affirmative Confirm authorizes an explicit shell-stop attempt; separately, **proven full VS Code exit after finite shell-only orphan grace** authorizes the previously accepted automatic attempt. Neither frontend/extension-host disconnection nor a generic broker signal proves full exit or authorizes stopping a managed OMP host. A natural root exit needs no stop authorization but does not prove descendant exit. Any direct root termination or force escalation must target the original retained process handle, or validate PID/creation time and terminate through the **same opened process handle**; a saved numeric PID is not safe after an asynchronous wait. ConPTY closure can affect still-attached clients. Snapshot descendant PIDs are never kill authority. If identity-safe escalation is unavailable, refuse it and report uncertainty, never signal a possibly reused PID.

Every broker retirement path—natural root exit, explicit shutdown, signal handling, full-exit grace and retention expiry—must preserve durable recovery metadata while tree completeness is unknown. Unknown/remaining must not release the shell slot or be presented as a completed exact-tree stop; Reconnect may show the retained screen and diagnostic state when the root is dead, not resurrect that process or promise eventual proof. A broker crash may make the live endpoint unreachable, but its slot/record remains discoverable for diagnosis. An inaccessible broker, elapsed timer or complete window exit cannot promote unknown to verified. For a managed exact-file writer **being explicitly stopped or replaced**, independently prove that the previously matched exact native process is gone **and** its matched Collab room has withdrawn before releasing that writer's claim or launching a successor; a roomless launch remains owner-unknown. Native conversation A→B is different: the same process remains alive serving B, and ADR-0025's fresh settled B-room/host/header witness plus durable A retirement—not PID absence—is the authority to release A's conversation claim. Neither rule establishes full-tree proof or introduces a global external-writer scan.

This is a **deliberate, user-approved gap**, not satisfaction of ADR-0024's positive exact-tree-stop acceptance criterion. The previously accepted goal remains an open gate. A future implementation needs the native Job Object integration, its reproducible build/toolchain and ADR-0012-staged binary proof, plus a separate recovery policy for broker crashes; do not silently enable `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, which would permit automatic termination outside the explicit-close/full-exit policy.

### Consequences

- Positive: the implemented broker reports no false `verified:true`, never signals a stale numeric PID, and retains unknown slots as recoverable records rather than silently replacing them; focused native-process tests exercise those gates. Installed-Webview acceptance remains separate.
- Negative: Confirm may stop the root while leaving descendants unproven, so the slot can remain indefinitely and a complete VS Code exit need not end every shell descendant. This mode cannot honestly claim that Open Terminal's exact-tree stop criterion is delivered.
- Compatibility: no system-wide C++ workload install and no native addon fork in this iteration. The PTY and rendering features can still be exercised, but their lifecycle documentation must label the Windows uncontained-tree limit.

## Amendment 2026-10-30 (accepted after one independent architecture review, findings applied): a process older than the stopped child is not a survivor of its stop

> Scope: the descendant reading of a stop (`queryPtyProcessTree`, `src/host/pty-identity.ts`) and the verdict the broker builds from it (`performStop`, `src/broker/pty-broker.ts`). The decision outcome above is unchanged: the verdict is never `empty`, `verified` stays `false`, and no process id is signalled.

**Observed.** A CI run on the Windows runner (the 0.4.13 release, attempt 2) failed the end-to-end test that stops a managed child with no descendants: the stop read `remaining`, the test expected `unknown`. The child starts nothing: sampling the process table every 2 ms around ten forced stops on the maintainer's machine never showed a row below it, and each stop read `unknown`. A `remaining` verdict needs a live row whose parent id is the child's id, and the only such row can be a stale one: the table stores a parent as a number and keeps it after the parent exits, so a long-lived process whose creator had id X still names X when a later, unrelated process is given X. The runner reuses ids freely (67 of the 488 test-file processes in that run had an id another test-file process of the same run had held). On the maintainer's machine, 84 of 518 readable processes had a parent that no longer ran.

**Consequence.** The false `remaining` is not only a test failure. A native Terminal's Force Stop (`src/runtime/local-stop.ts`) answers "Some commands are still running. Nothing was restarted; try Stop again." when `remainingPids` is not empty, and the stale row stays for as long as the old process runs, so Try Again reads the same.

**Decision.** A child cannot be older than the process that started it. The broker passes the child's kernel creation time (read when the child started, `nativeCreationTime`) to the reading. The walk reads the creation time of each row it would report and drops a row created before the process it names as its parent, together with everything below it:

- the root's bound is the child's own creation time; below a reported row the bound is that row's, so an intermediate id that was reused cannot adopt an old process either;
- a row whose creation time cannot be read (`unknown`) cannot be ruled out and is reported, and what is below it is held to the nearest bound that was read;
- a row that has exited since the snapshot (`gone`, which includes a process held only by an open handle) is not reported, and the rows that name it are still walked under the bound that was read: a process it left running is a genuine descendant;
- when the child's creation time was never read, nothing can be ruled out and the walk is by id alone, as before.

An unrelated old process whose creation time can be read is therefore no longer reported as a survivor; one whose creation time cannot be read (another account's, an elevated one) still is. The tree stays `unknown` and the broker keeps its record, because an empty answer is still not proof of an empty tree. The principle is [ADR-0035](0035-distinguish-a-recorded-process-from-a-later-occupant-of-its-pid.md)'s: an id alone is not an identity. The comparison is not: ADR-0035 decides on equality of a recorded creation time, and its review refused a one-way ordering of creation times as a proof of identity, because a kernel creation instant is read from the system clock and a step backwards between two starts reverses their order. Here that failure is bounded: a genuine descendant that compares older than the child is dropped, so the verdict falls from `remaining` to `unknown`, never to `empty` or `verified`, and no signal is sent; but that descendant is then not reported, and the Force Stop refusal rests on that report.

**What this does not exclude.** A process started by a new holder of the child's id after the child ended is newer than the child and is reported. The window opens when the child ends, not at the exit proof: the tree is read even when the child has been gone for a long time, so a stop on an already-exited child whose id a long-lived process now holds can still read `remaining`. The cost of the rule is one `OpenProcess` and `GetProcessTimes` per row that names a walked process as its parent, a handful at most.

**Tests.** `src/host/pty-identity.test.ts`: a fixed process table (a stale orphan and everything below it, a reused intermediate id, an unreadable and a malformed creation time, a row that exited with a live row below it, the root's own instant, a cyclic table, a failed snapshot and a missing root creation time) decides the walk without any id reuse; two real-process checks (a real child of a live process is kept; an orphan an exited parent left running is named by id alone and dropped when the root is later than its kernel creation time).

**Review.** One independent architecture review (2026-10-30): accept with changes, no material finding. Four should-fix items (a row that exited dropped the live rows below it; the window the rule cannot exclude was understated; the clock-step caveat of ADR-0035's review was missing; a real-process test compared against `Date.now()` instead of the orphan's kernel creation time) and two nits (an exact-array assertion on a live table; "no longer reported" overstated for unreadable rows) are applied.

## Related Documents

[Sessions design](../designs/2026-09-26-sessions-and-in-tab-terminal.md), [ADR-0024](0024-own-omp-pty-for-in-tab-terminal.md), [ADR-0012](0012-run-child-process-entries-from-staged-copies.md).

Shell slots and broker records are indexed in [Architecture: Cross-window invariants](../architecture.md#cross-window-invariants).

## Architecture Review

- Reviewer: independent architect (initial review and three corrective passes).
- Outcome: accepted after correcting matched-room claim release, identity-safe signalling, unknown-record retention across every retirement path, dead-broker slot replacement and unauthorized generic-signal stopping.
- Notes: This accepts the conservative safety behavior, **not** ADR-0024's positive whole-tree stop criterion. The user declined the compiler prerequisite; Job Object containment and installed-Webview acceptance remain open.
