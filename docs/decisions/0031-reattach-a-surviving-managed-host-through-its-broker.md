---
status: accepted
date: 2026-09-27
---

# ADR-0031: Re-adopt a surviving managed host through its authenticated broker

> Ownership clauses narrowed by [ADR-0039](0039-refuse-only-on-a-verified-live-writer-the-extension-owns.md): unknown broker/legacy terminal/orphan observations do not retain a user-action veto. Exact authenticated transport pinning survives; verified legacy broker children are Running with one-step stop-and-Resume/Delete.

> Amended by [ADR-0038](0038-host-chat-over-rpc-ui-on-a-broker-pipe-child.md): authenticated broker re-adoption now also applies to `managed-rpc` slots and remains the only transport for them. Legacy `managed-omp` slots and hidden-terminal hosts are only *observed* (blocked, explained), never adopted or driven, and no verdict uses a Collab room.

> Narrowed by the [ADR-0035](0035-distinguish-a-recorded-process-from-a-later-occupant-of-its-pid.md) amendment of 2026-10-13 (accepted after independent architecture review): the "new independent kernel reading of the child's creation time" and the broker's kernel identity reading are replaced, for a current-build broker, by the token handshake (its MAC covers the broker's pid and creation time) and by the broker's authenticated attestation that it still holds its pipe child's process handle. Older brokers and pseudo-console children keep the reading, and a reading is never reused past the proof that took it.

> Amended 2026-10-28 (see the last Consequences bullet): the startup restore's attach may re-prove the pin on the authenticated connection its own reconcile kept, after a new `status`, instead of dialling a second time. Any doubt falls back to a fresh attach.

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
field on an authenticated connection that has just answered a new `status` (a fresh connection
otherwise; see the amendment of 2026-10-28) before publishing a runtime, so a target that changed
between the verdict and the attach is refused rather than adopted, and every refusal disconnects the
handle it opened.

A positively identified broker target never falls back to a legacy terminal after an authentication,
compatibility or identity failure, and the attach re-proves the pin on an authenticated
connection including a *new* independent kernel reading of the child's creation time: equality with
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
- Amendment (2026-10-15): the recorded OMP session id is a fence only when it exists. The id is recorded when the Chat's first `get_state` answers, which a reload right after New Session can precede; a live host whose pin (broker, generation, child pid and creation time) matches and whose id was never recorded is attached without an expected id, and the session learns the id from the process (a row with a file is checked against that file by the session itself). A host id that differs from a recorded one is still a refused switch, and a refusal tells the user to Stop or Kill the process. See [ADR-0021](0021-reattach-a-verified-live-draft-on-activation.md).
- Amendment (2026-10-17): the durable `stopped` intent is the user's decision, not any exit. When Windows ended the user session (logoff), every OMP child died with exit code 4 before the extension host did, and the exit handler recorded `stopped` for the two sessions whose window was still attached, so the next startup deliberately skipped them (the other tabs kept their `running` intent and came back). An exit now records `stopped` only for exit code 0 (OMP's own `/exit`, `/quit`, Ctrl+D, closed stdin); a non-zero code, a signal, no code, or a broker that said nothing leaves the intent as recorded, and the startup rule above then relaunches it with the usual absence evidence. The intent, the cleared host and the claim release are one write (`closeSession` with `runIntent: "unchanged" | "stopped"`), so a host killed in between can no longer leave a stopped intent with a retained host. Desk's Stop records its own stopped intent under the tab's gate, and Kill records it (`recordStopIntent`) before `taskkill`. Accepted consequence: a session that crashes at start is retried on each VS Code start. See [architecture](../architecture.md).
- Amendment (2026-10-19): two gaps in what a reload re-adopts. (1) A launch attempt (the record written before the launcher runs: no process, no broker identity) now carries the intent to run, restored when nothing started, and when its window ended before reading the outcome the next reconcile resolves it through the slot the launch reserved for the conversation (the conversation's own mapping, never one reached through an editor's mapping alone): the broker's own record and the child's creation time give the pin, and a running child of the same transport is `attachable` through it (the attach re-proves exactly that pin); a row that recorded a process, a legacy row, a slot holding another kind of host, and a slot known only through an editor stay `live`. Before, the row read as the user's stop beside a running writer, and Kill was the only way out. (2) An attach returns the session id recorded for the host, not the row's file id: a Chat clear rotates the process's id and the index records the attach's handle id, so the file id replaced the rotated one and the next reload failed `identity-mismatch` against the same process and file. A window whose installed package changed on disk also refuses every launch (not only the first staging of its entries), so such an attempt is not started by a drifted bundle in the first place. See [architecture](../architecture.md).
- Amendment (2026-10-28, accepted after independent architecture review, findings applied): **the startup restore attach may take the connection its own reconcile proved the pin on, instead of dialling again.** After a reload every restored tab connected to its broker twice (the reconcile's authenticated attach, closed on its verdict, then the attach's own), and with a busy host loop each connect cost hundreds of milliseconds. For the startup restore pass only (`SessionIndex.restoreAll` with the trace of the automatic pass; Open, Resume, Delete admission and every other reconcile are unchanged), a reconcile of a `managed-rpc` slot whose verdict is `attachable` parks its authenticated connection in a per-pass store (`ParkedRpcConnections`, `src/host/rpc-parked.ts`) under the pin it proved, and the attach (`attachRpcHost`) claims it for exactly that pin. What is reused is the authenticated socket, never a proof: the attach reads the record again and requires it to equal, field by field, the record the connection was opened from, passes the gates every attach passes (tree digest, runtime version, state access), asks the broker a **new** `status` on that connection (bounded to 5 s; a lost answer is a fresh attach, not a refusal), waits for the child identity, confirms the broker's identity (the kernel readings of a broker that attests nothing are taken again for this proof, exactly as over a new connection), and only then settles its pin proof against the handle it adopted (a proof is bound to the handle it was started on, so a switch back to a fresh connection restarts it). Every other outcome closes the parked connection and runs the unchanged fresh attach, which alone decides: a socket that closed, a record that changed, a pin that differs from the one the connection was parked under, a status that failed or timed out, a time limit of 30 s, a connection nobody claimed when the pass ends (the pass releases the store), and a connection offered after the pass ended. A connection stays authenticated while open because every frame is sequence-numbered and MAC'd with the session key derived from the record's token, and a replaced broker closes the socket; the pin is still proved by an answer given now. Concurrent reconciles of one slot still share one probe flight: a probe that wants its connection kept joins only a flight that parks into the same store, one that does not may join any flight. A row resolved through the slot of an unread launch attempt (no recorded process) is `attachable` by the read-only slot probe, which keeps nothing: its attach dials its own connection as before. Review notes (2026-10-28, independent architecture review, accept with findings): a claimed connection is closed on every early return of the attach; the 5 s bound on the kept `status` and the extension's per-pass wiring have no automated test. Consequence: a `managed-rpc` restore row costs one dial instead of two; the kernel readings and every ownership rule are as before. See the [design](../designs/2026-09-27-broker-aware-restart-recovery.md) (section 2) and the [ADR-0035](0035-distinguish-a-recorded-process-from-a-later-occupant-of-its-pid.md) amendment of 2026-10-13 (consumer 1).

### Amendment note (2026-10-21)

At a full application restart a surviving managed host is re-adopted by **its home window** (the window that last drove the session, recorded on the row), not by whichever window has a restored editor for it; another window's editor shows the saved history read-only. See [ADR-0080](0080-hand-over-a-live-session-through-a-taken-up-request-that-detaches-the-holder-without-stopping-it.md) (amendment of 2026-10-21). A row with no recorded home keeps the earlier rule.

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
