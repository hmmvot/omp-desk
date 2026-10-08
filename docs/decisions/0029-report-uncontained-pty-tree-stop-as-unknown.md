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

## Related Documents

[Sessions design](../designs/2026-09-26-sessions-and-in-tab-terminal.md), [ADR-0024](0024-own-omp-pty-for-in-tab-terminal.md), [ADR-0012](0012-run-child-process-entries-from-staged-copies.md).

## Architecture Review

- Reviewer: independent architect (initial review and three corrective passes).
- Outcome: accepted after correcting matched-room claim release, identity-safe signalling, unknown-record retention across every retirement path, dead-broker slot replacement and unauthorized generic-signal stopping.
- Notes: This accepts the conservative safety behavior, **not** ADR-0024's positive whole-tree stop criterion. The user declined the compiler prerequisite; Job Object containment and installed-Webview acceptance remain open.
