---
status: accepted
date: 2026-10-08
---

# ADR-0047: Host Stats in the existing PTY broker

## Context and Problem Statement

A Stats editor may close while its dashboard keeps running. Reload must retain authenticated Stop and Processes discovery. The existing detached broker and registry already provide these guarantees for PTY children; installed OMP's `stats` CLI works in a PTY.

## Considered Options

- Extend the broker with a `stats-dashboard` PTY kind: reuse staged runtime, authenticated identity/Stop, slot locking and durable records.
- Add a standalone detached child and registry: duplicates lifecycle/security and risks untracked children.
- Add a pipe child: avoids a terminal but introduces another child implementation for a CLI with no machine-readable pipe protocol requirement.

## Decision Outcome

Use `stats-dashboard` in the existing broker/registry, with a fresh slot per launch, a separate fixed discovery/admission lock and fixed loopback dashboard endpoint. Retained records are evidence, never deleted to make a slot reusable. A standalone Stats record is its own durable reference, not a conversation/shell mapping. Processes lists it as **Stats dashboard**, never orphaned, and uses existing authenticated exact-child stop and broker retirement; bulk Stop selects it only when idle and never changes session/shell mappings. The editor only embeds presentation; tab close and extension disposal do not stop the server. A compatible independently started dashboard is reused without claiming process ownership. [ADR-0049](0049-intercept-stats-browser-opener-via-preload.md) defines the verified preload and explicit native-browser fallback admission.

### Consequences

- Positive: no second registry, authenticated stop survives reload, no session claims or dashboard fork.
- Negative: inherits the existing truthful ConPTY root-versus-tree stop limitations. External dashboards have no extension-controlled Stop. The fixed local port means unrelated listeners must be reported, not replaced.

## Related Documents

- [Stats dashboard design](../designs/2026-10-08-stats-dashboard.md)
- [ADR-0049](0049-intercept-stats-browser-opener-via-preload.md)
- [ADR-0024](0024-own-omp-pty-for-in-tab-terminal.md)
- [Processes design](../designs/2026-10-07-processes-view.md)

## Architecture Review

- Reviewer: architect
- Outcome: accepted after two independent review rounds.
- Notes: fresh slots and a separate admission lock correct the retained-record/fixed-slot deadlock without deleting evidence. The launch policy is defined by accepted ADR-0049; the confirming review found no remaining architectural blocker.
