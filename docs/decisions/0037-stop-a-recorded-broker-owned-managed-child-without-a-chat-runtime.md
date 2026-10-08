---
status: accepted
date: 2026-09-29
---

# ADR-0037: Stop a recorded broker-owned managed child without a chat runtime

> Stop/retention clauses narrowed by [ADR-0039](0039-refuse-only-on-a-verified-live-writer-the-extension-owns.md): Stop also works for a verified rival window without taking its claim; persist stopped intent before dispatch. An unconfirmed stop releases this window's operation lease and rechecks positive ownership instead of retaining uncertainty as Blocked. Authenticated exact target and truthful writer/tree outcomes survive.

> Narrowly superseded by [ADR-0038](0038-host-chat-over-rpc-ui-on-a-broker-pipe-child.md) for the Collab clause: `writerGone` no longer requires a freshly withdrawn room; it is proved by the broker's own exit report or by broker and child (pid + creation time) proven absent. The explicit authenticated stop without PID signalling, the distinct whole-tree outcome and the unconfirmed-stop retention remain; for a `managed-rpc` child the graceful stop closes stdin.

## Context and Problem Statement

A row may remain `owner-unknown` after a reload or restart even though its recorded PTY broker and managed OMP child survived. The panel and chat runtime that originally launched the child may no longer exist in this window. Releasing the claim while a positively running writer is proved would authorize overlap; refusing every action leaves no way to stop the recorded child.

The existing `decidePtyStop` contract in `src/host/native-terminal.ts` distinguishes whether the recorded writer is gone from whether its whole process tree is empty: a process that never published a matched Collab room remains unknown even if its root exits, and tree state is separately unproven (ADR-0029). The lasting choice is whether to offer an explicit broker-authenticated stop in the absence of a chat runtime, while preserving those outcome semantics.

## Considered Options

- **Explicitly stop only the row's recorded managed child through its recorded broker slot.** Advantages: the authenticated broker is the transport authority already recorded for this attempt; no panel runtime or inferred process identity is needed. Disadvantages: the user must authorize the stop, and an outcome other than `writerGone` leaves the claim held for recovery.
- **Signal a numeric PID or infer the process tree from descendants.** Rejected: a pid alone is not a transport proof, and neither PID signalling nor tree inference establishes the recorded managed child's identity or a truthful whole-tree outcome.
- **Launch a new process to restore control.** Rejected: that may create a second writer and does not stop or establish the recorded child.
- **Shut down the broker.** Rejected: broker shutdown is broader than the row's recorded child and does not supply the required child identity/outcome proof.
- **Substitute a legacy terminal transport.** Rejected: a recorded broker slot selects the broker as the only transport; absence or failure cannot authorize fallback to another transport (ADR-0031).
- **Keep the claim indefinitely with no stop action.** Rejected: a positively proven child owned by the recorded broker is actionable without the chat runtime, using explicit authority and bounded outcome semantics.

## Decision Outcome

Chosen: offer the explicit command `OMP: Stop This Session's OMP Process…` (`omp.stopSessionHost`) for a stale row whose recorded host is not resolvable, including from the command palette. This covers the reload/restart case where the panel and chat runtime are gone but the broker and child survived. It is not an automatic stop or a substitute for the explicit release path.

The confirmation is bound internally to the selected row's captured launch-attempt tuple (`startedAt` and `pid`) and durable broker slot. The dialog displays the working-folder name and the recorded pid, or `no recorded pid`; its detail names the full working directory, the recorded launch timestamp and the captured broker slot, so a pid-less attempt is distinguishable from another attempt in the same folder. The durable broker slot is resolved before the dialog and the action refuses to offer it at all when that provenance is unreadable or names no slot, because then this window has no authenticated way to reach the process.

The confirmation dialog itself stays outside the tab's lifecycle gate ([ADR-0015](0015-serialize-tab-lifecycle-through-one-gate.md)). Once admitted, `SessionIndex` re-reads the row and compares its `host.startedAt` and `host.pid` with `expect.attemptStartedAt` and `expect.pid`; a mismatch refuses before any claim or intent change and requires fresh confirmation. It then adopts or publishes the row's own claim for its exact session file, or its reserved draft identity when no file exists; an unreadable claim, a foreign owner generation or a live rival holder refuses. With the claim held, it persists the stopped intent **before** invoking the stop port. The port then re-reads durable broker provenance and compares its slot with the one captured before confirmation: changed, unreadable or missing provenance refuses without sending a stop, but leaves the stopped intent and the claim held and marks the row `owner-unknown`. An authenticated read-only `PtyBrokerClient.attach(slot)` without owner hints must then prove kind `managed-omp`, the recorded slot, broker id/generation/kernel identity, and child pid/kernel creation time through `provedBrokerPin`. A recorded pid must match; a pid-less attempt requires its own recorded slot. The handle is disconnected in `finally`.

The durable stopped intent is persisted before sending `handle.stop({ mode: "graceful" })`, so an interrupted explicit stop cannot become an automatic launch. The outcome uses `decidePtyStop` semantics from `src/host/native-terminal.ts`: `writerGone` requires the recorded process to be gone and its matched room freshly observed withdrawn. A launch that never published a matched room stays `owner-unknown` even if its root exits; root exit is not proof of writer absence (ADR-0029). Process-tree state remains separate and may be unknown.

On `writerGone`, the exact-file claim may be released, the recorded host cleared and the extension's conversation/editor-to-slot mapping forgotten. This does not erase the broker's retained recovery record or retire an unproven process tree; ADR-0029's retention rule remains operative while tree completeness is unknown. After claim acquisition and stopped-intent persistence, an unconfirmed stop or a transport refusal keeps the claim and the recorded host and marks the row `owner-unknown`; the separate explicit release remains available afterwards where eligible, and only after its own fresh checks. This stop never itself releases an unresolved claim. A refusal that never dispatched proves nothing was stopped, and is reported as such; a stop request whose delivery or answer could not be confirmed is reported as **unconfirmed** — the recorded process may have stopped or may still be running — never as "nothing was stopped".

The operation MUST NOT signal a numeric PID, infer descendants or whole-tree termination, launch a process, publish a synthetic runtime, substitute a legacy transport, shut down the broker, or stop/restart automatically.

### Consequences

- Positive: a recorded broker-owned managed child can be explicitly stopped after its chat runtime disappears, without weakening ADR-0031's broker-only transport proof.
- Positive: a lost answer is reported as the uncertainty it is, so the user is never told that nothing happened when the request had already been dispatched.
- Positive: successful writer absence and whole-tree termination remain distinct facts; uncertain outcomes keep the claim and host record available for recovery.
- Negative: when `writerGone` is not established, stopping leaves the row blocked and requires a separate explicit release if the user chooses to accept that residual uncertainty.
- Negative: this is a row-scoped explicit stop, not a universal process-tree termination or single-writer guarantee.

## Related Documents

- [Design: recovering a lost room link and releasing an unresolvable attempt](../designs/2026-09-29-lost-room-link-and-unresolvable-attempt-recovery.md).
- [ADR-0029](0029-report-uncontained-pty-tree-stop-as-unknown.md) — unknown tree outcome and retained recovery.
- [ADR-0031](0031-reattach-a-surviving-managed-host-through-its-broker.md) — recorded broker transport, authenticated attach and no fallback.
- [ADR-0036](0036-release-an-unresolvable-launch-attempt-explicitly.md) — separate explicit release of unresolved ownership.

## Architecture Review

- Reviewer: independent architect (v3 review, one corrective re-check and a final corrective confirmation).
- Outcome: accepted. The first revision's ordering description, its claim that the dialog names the slot, and its "nothing was stopped" wording after a stop error were rejected and corrected; the corrective re-check resolved the ordering and asked for two bounded corrections (the confirmation detail now names the full working directory, the recorded launch timestamp and the captured broker slot; a stop whose delivery or answer was not confirmed is reported as unconfirmed), and the final confirmation recorded **no remaining findings** and confirmed the accepted transaction ordering, the uncertainty reporting and the recovery after an unconfirmed Close Session.
- Limits confirmed: acceptance does not establish whole-tree termination or installed-window behavior, and it does not confer authority over another window's writer. Reviews were read-only against the current working tree; no installed-window run was performed.
