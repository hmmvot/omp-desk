---
status: accepted
date: 2026-10-28
---

# ADR-0084: Run helper processes through one per-window scheduler with cross-window slots

## Context and Problem Statement

A window starts short-lived OMP processes (provider usage, the default profile's model catalogue, settings reads, the inventory and served-model workers, version probes of other installs) for facts shown beside a Chat. After a reload every window starts its set when its tabs go live, at the same time as the restore the user waits for. A start analysis (2026-10-23) found about two dozen at once. The decision is where the policy lives and whether it reaches across windows. See the [design](../designs/2026-10-28-helper-process-scheduler.md).

Requirements: nothing the first view does not need starts during the restore; bounded concurrency; windows do not all start together; a cancelled window leaves no helper behind; no new interprocess protocol.

## Considered Options

- **Per-call-site guards (status quo).** Each site dedupes its own reads. No place bounds the total or defers it; the multiplication across tabs and windows stays.
- **One scheduler per window, with the startup restore as its gate.** One place for bounds, deferral, sharing, cancellation and the log. Does not by itself spread windows.
- **The same, plus cross-window slots on the existing PTY slot lock.** Bounds the whole machine's background helpers at two with an existing, stale-safe lock and no protocol. A slot is a file operation per background helper, and a throttle only (fail-open).
- **A coordinator window or a broker service that runs helpers for all.** Strongest, but a new request protocol, a failure mode when the coordinator closes, and a trust surface; disproportionate for diagnostics-grade facts.
- **Share helper results across windows through a file.** Fewer processes, but `omp usage` is folder-scoped (extension discovery) and its reports carry account labels; the catalogue boolean is cwd-scoped and gates the sign-in prompt. Not safe or worth it.

## Decision Outcome

One `HelperScheduler` per window, with two classes (`visible`: on screen now, bound only by the window's limit of 2 at once; `background`: after `startupRestoreOver` plus a 2 s settle, at most 1 at a time), sharing by key within the window, cancellation on dispose, and for background runs one of two cross-window slots built on `acquirePtySlotLock` (bounded 30 s wait, fail-open). A catalogue read asked for as a hint joins a read in flight; only a credential change repeats it. Explicit user actions, the restore pipe's own processes and the launch path are outside it.

### Consequences

- Positive: the machine runs at most two background helpers however many windows reload, none of them during its window's restore; the active tab's quota is not delayed; one info line and per-helper debug lines make the next start analysis possible; closing a window ends its helpers.
- Negative: background facts appear later (after restore, settle and slot); a slot is a file write per background helper; the PTY slot lock is now used by two features, so a change to its file layout must consider both; the lock takes a dead holder over only when no live process has its process id, and Windows reuses ids, so a lock of a dead window can keep a slot busy until the 30 s wait runs out (facts late, never lost); windows still run their visible helpers at once; executable resolution and the launch path's own helpers are not scheduled.

## Related Documents

[Design](../designs/2026-10-28-helper-process-scheduler.md); [ADR-0060](0060-merge-background-processes-into-sessions-and-kill-all-through-authenticated-routes.md) for the earlier use of the startup restore gate by display-only reads; [ADR-0047](0047-host-stats-in-the-existing-pty-broker.md) for the PTY slot lock's other user.

The cross-window slots are indexed in [Architecture: Cross-window invariants](../architecture.md#cross-window-invariants).

## Architecture Review

- Reviewer: `reviewer` agent (independent, read-only, one pass, covering this ADR and its design)
- Outcome: accept with changes; applied, no material finding.
- Notes: see the design's Architecture Review for the findings. Two points bear on this record: the stale-lock takeover by process id (Windows reuses ids, so a lock of a dead window can hold a slot until the wait runs out; added to the design's Risks and to the Negative consequences below) and that the promotion of a queued background run is by key.
