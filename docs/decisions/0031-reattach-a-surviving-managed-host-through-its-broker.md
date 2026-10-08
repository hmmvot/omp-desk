---
status: accepted
date: 2026-09-27
---

# ADR-0031: Re-adopt a surviving managed host through its authenticated broker

> Ownership clauses narrowed by [ADR-0039](0039-refuse-only-on-a-verified-live-writer-the-extension-owns.md): unknown broker/legacy terminal/orphan observations do not retain a user-action veto. Exact authenticated transport pinning survives; verified legacy broker children are Running with one-step stop-and-Resume/Delete.

> Amended by [ADR-0038](0038-host-chat-over-rpc-ui-on-a-broker-pipe-child.md): authenticated broker re-adoption now also applies to `managed-rpc` slots and remains the only transport for them. Legacy `managed-omp` slots and hidden-terminal hosts are only *observed* (blocked, explained), never adopted or driven, and no verdict uses a Collab room.

## Context and Problem Statement

[ADR-0024](0024-own-omp-pty-for-in-tab-terminal.md) moved every new managed OMP host onto an
extension-owned, detached PTY broker with a durable record, precisely so a writer can outlive the
editor and the extension host. The legacy hidden VS Code terminal remains a supported *adopted*
transport for hosts started before that cutover, and it is never migrated or restarted silently.

The reconciler that decides whether a recorded host may be re-adopted was written for the legacy
transport: it answers `attachable` only when the exact recorded process and Collab room are still
publishing **and** `findTerminalForPid` finds the identical `vscode.Terminal` in this window. A
broker-owned host has no VS Code terminal, so after a full restart the supported broker attach path
is unreachable: the exact writer this extension started is downgraded to `live`, reported as a
conflict, and the user sees `N OMP session(s) were left closed because another writer may own them`
for a session that is recoverable. Attaching also resolved its slot from the current panel
(`stateOf(tabId)?.bridge?.editorId`), which is empty before any editor exists, and fell back to the
legacy terminal whenever the broker path produced no runtime — silently substituting a different
transport than the one a verdict proved.

The question is what evidence may re-adopt a surviving writer, and what happens when a legacy writer
is still publishing while its original terminal handle is gone.

## Considered Options

- **Require the identical VS Code terminal for every attach.** Safest for the legacy transport, but
  it permanently blocks recovery of every broker-owned survivor — the transport ADR-0024 introduced
  for exactly this lifetime. Reject.
- **Treat an alive recorded PID that OMP's registry still publishes as attachable.** Simple, and it
  would unblock the reported case, but liveness is neither a controllable transport nor a process
  generation: it would adopt a legacy writer this window cannot drive and cannot detect PID reuse.
  Reject.
- **Probe by launching or adopting a broker into the slot.** A launch can start a writer; a probe
  must only observe. Reject.
- **Two evidence paths, chosen by recorded provenance, both carrying the transport they proved:**
  a recorded broker slot is proved by a read-only authenticated attach (broker kernel identity,
  broker id/generation handshake, child PID, the child creation time the broker captured, and an
  independent kernel reading of that child's generation, with the slot resolved from the durable
  mapping rather than from any editor); no recorded slot keeps the legacy exact-PID terminal
  adoption. A proven broker target is never replaced by a legacy fallback. Chosen.

## Decision Outcome

A recorded broker slot is the provenance that selects the broker path; the absence of one keeps the
legacy path. The slot comes from the durable `byConversation`/`byEditor` mapping (the committed
controlling editor binding is the fallback), never from an editor that may not exist yet and never
from a scan by PID or session id.

`attachable` is answered only with a *verified, usable transport*, and the verdict carries that
transport as a small non-secret, transient pin: the slot, the broker's id, generation, PID and
creation time, and the child's PID and creation time, or the legacy-terminal discriminator. The
session index carries the pin unchanged from the verdict through classification into the attach
request; it never persists it, reads it, or stores it in a row. Attachment re-proves the pin field by
field on a fresh authenticated attachment before publishing a runtime, so a target that changed
between the verdict and the attach is refused rather than adopted, and every refusal disconnects the
handle it opened.

A positively identified broker target never falls back to a legacy terminal after an authentication,
compatibility or identity failure, and the attach re-proves the pin on a fresh authenticated
attachment including a *new* independent kernel reading of the child's creation time: equality with
the pin alone would not establish that the process id still denotes that generation. A missing or
unreadable retained record is uncertainty: the writer is kept and reported, never reinterpreted or
replaced. Attachment still spawns nothing and takes no claim; the index's exact-file claim and
`describeAttachMismatch` checks are unchanged.

A legacy writer whose original terminal is unavailable is a retained, non-controlling owner. It is
reported with a bounded reason, it is never killed, never duplicated and never forgotten, and its
claim is kept; the claim is released only by the existing matched-process-and-matched-room absence
proof, which can be re-established when the writer actually exits. The same rule holds at startup:
a row whose durable run intent is `stopped` starts and adopts nothing until an explicit Open/Resume
authorizes it, and an uncertain earlier stop stays visibly held.

### Consequences

- Positive: a broker-owned session survives a full application restart and returns to the same
  broker generation, child process and session with zero launches; a legacy survivor is honestly
  explained instead of misreported; the transport an attach drives is exactly the one a verdict
  proved; stopped rows stay stopped across restarts.
- Negative: a legacy writer whose terminal handle is gone cannot be recovered or stopped from this
  window at all — that is the accepted ADR-0024 boundary, now made explicit in the UI instead of
  being reported as a generic conflict. Reconciliation also costs one authenticated attach per
  recorded slot per pass.
- Compatibility: no durable schema change, no persisted secret, no change to claim or absence
  evidence, and unchanged behavior for a host that still has its legacy terminal.

## Related Documents

[Broker-aware restart recovery design](../designs/2026-09-27-broker-aware-restart-recovery.md),
[ADR-0024](0024-own-omp-pty-for-in-tab-terminal.md),
[ADR-0021](0021-reattach-a-verified-live-draft-on-activation.md),
[ADR-0025](0025-bind-editor-slots-to-current-conversations.md),
[ADR-0030](0030-watch-the-verified-owning-vscode-process-for-shell-grace.md).

## Architecture Review

- Reviewer: independent architect (broker-aware restart recovery design review).
- Outcome: accepted after correction.
- Notes: The review accepted the transport-evidence choice itself — broker provenance selects the
  broker path, missing provenance keeps the legacy path, and a proven broker target never falls
  back — and required the probe's failure reasons to be bounded, extension-authored categories
  rather than forwarded client, handshake, helper or exception text; the decision paragraph above
  states that requirement and the implementation enforces it at the probe boundary. It also asked
  the attach-time re-proof to repeat the independent kernel comparison explicitly, which it now
  does.
