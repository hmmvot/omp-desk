---
status: accepted
date: 2026-09-27
---

# Broker-aware restart recovery, stopped-intent startup, and honest row actions

> Ownership clauses narrowed by [ADR-0039](../decisions/0039-refuse-only-on-a-verified-live-writer-the-extension-owns.md): an unavailable broker, lost legacy terminal or orphan child is unowned, not a retained conflict. Failed attach releases its operation lease and rechecks; transport pinning and automatic running-intent absence gates survive.

> Amended by [ADR-0038](../decisions/0038-host-chat-over-rpc-ui-on-a-broker-pipe-child.md) and its [RPC-UI chat and Sessions design](2026-09-29-rpc-ui-chat-and-sessions.md): broker-slot attach, stopped-intent startup and honest row actions carry over to `managed-rpc` slots; every Collab-room witness is removed.

## Problem

A full VS Code restart with one broker-owned PTY session and one older hidden-terminal session
reports `OMP: 2 OMP session(s) were left closed because another writer may own them`, and the older
editor shows a panel whose only explanation is `No session is attached … pid 31000 … still hosting
a Collab room`. Neither session can be recovered from the launcher, and one of them never needed to
be blocked at all.

Two independent defects produce that state:

1. **Ownership reconciliation still demands a legacy transport.** `reconcileOwner`
   (`src/host/native-terminal.ts`) answers `attachable` only when the exact recorded process and
   room are still publishing *and* `findTerminalForPid` finds the identical VS Code terminal in this
   window. For a host this extension launched under its own PTY broker there is no `vscode.Terminal`
   at all — the broker record is the transport — so a perfectly recoverable broker-owned survivor is
   downgraded to `live` and reported as a conflict. The supported attach path
   (`attachNativeOmpHostUnderBroker`) exists, but reconciliation never lets a broker-only survivor
   reach it.
2. **The durable stop intent is not enforced at startup.** `restoreAll` visits every indexed row and
   `#openEntry` proceeds to launch a materialized row whose verdict is `free` — including a row the
   user explicitly stopped. The declared rule ("stopped stays stopped across a full restart until
   Resume") is a comment, not an admission check.

Two further gaps are visible in the same user path and are part of this change: the row's own action
(the tree click / context menu) is a focus-only handler that cannot open, attach or resume anything,
and a blocked row offers no explanation of what Open would do, no bounded reason on its panel, and
an unconditional duplicate Rename contribution.

## Goals and Non-goals

- Goals:
  - A broker-owned survivor with no `vscode.Terminal` and no restored panel becomes `attachable` and
    is re-adopted on the same broker, child PID and session, with **zero** broker/OMP launches.
  - Reconciliation and attachment use the **same** verified transport: a verdict carries the
    transport it proved, the attach re-proves exactly that target, and a proven broker target never
    falls back to a legacy terminal.
  - An older hidden-terminal writer whose terminal handle is gone stays a retained, non-controlling
    owner: guarded, explained with a bounded reason in the tooltip and the panel, never killed,
    never duplicated, never forgotten.
  - The durable run intent is enforced at startup admission: a stopped row starts nothing, and an
    explicit Open/Resume is the only thing that starts it.
  - Row actions and menu contributions match the accepted Sessions contract, with no duplicate
    contribution and no action advertised without its prerequisite.
- Non-goals:
  - No PTY takeover of a legacy hidden terminal, no re-parenting of a surviving OMP child, and no
    termination of a process this window cannot drive (ADR-0024 keeps old hosts until exit).
  - No new durable schema, no persisted broker secret or handle in the session index, and no change
    to the claim/absence-evidence policy (`acceptOwnerAbsenceEvidence` and its callers are untouched).
  - No automatic editor creation at startup, and no change to native conversation transfer
    (ADR-0025).

## Current State

- `src/host/session-index.ts` owns the durable row: `runIntent`, `availability`, the recorded host
  (`pid`, `instanceId`, `generation`, `sessionId`), the exact-file claim and the owner generation. It
  classifies availability from a caller-supplied `OwnerReconciler` verdict, re-validating any
  `attachable` host against its own record (`describeAttachMismatch`).
- `src/host/native-terminal.ts` implements that reconciler, the legacy terminal attach
  (`attachNativeOmpHost`), and the broker launch/attach pair
  (`launchNativeOmpHostUnderBroker`, `attachNativeOmpHostUnderBroker`).
- `src/host/broker-slots.ts` keeps the durable `byConversation`/`byEditor` slot locator; a slot is a
  locator, never proof.
- `src/host/pty-client.ts` authenticates a recorded broker (kernel PID + creation time of the broker
  process, protocol/runtime compatibility, token/broker-id/generation handshake, slot/PID echo) and
  hands back a `PtyHandle` whose status carries the child's PID and the child creation time the
  broker read from the kernel.
- `src/extension.ts` wires the reconciler as a bare module-level adapter
  (`const reconciler = { reconcile: reconcileOwner }`), attaches through a panel-derived slot
  (`stateOf(tabId)?.bridge?.editorId`, empty before any panel exists), falls back to the legacy
  terminal whenever the broker path yields no runtime, and routes every row action through
  `focusSession`, which only reveals an already-open panel.
- `src/views/session-tree.ts` classifies rows and builds
  `ompSession.<forgettable|held>.<state>.<resumable|live-only>.<deletable|file-kept>`; `package.json`
  gates the context menus on those tokens and contributes Rename twice.

## Proposed Design

### 1. Reconciliation proves a transport, not just a process

`OwnerReconciler` stays the index's interface. The implementation becomes an activation-owned
instance built from explicit ports, so the policy is readable and testable without a live OMP, a
live broker or a real terminal:

```ts
export interface OwnerReconcilePorts {
  resolveExecutable(): Promise<OmpCommand>;
  listHosts(executable: OmpCommand): Promise<CollabHostRecord[]>;
  /** Durable broker slot this row's host is recorded under, or null. */
  brokerSlot(request: OwnerReconcileRequest): string | null;
  /** Read-only proof that one slot's recorded managed host is live and is this row's child. */
  probeBroker(slot: string, recordedPid: number): Promise<BrokerProbeResult>;
  /** The identical VS Code terminal of one pid in this window, or null. */
  findTerminal(pid: number): Promise<vscode.Terminal | null>;
}
export function createOwnerReconciler(ports: OwnerReconcilePorts): OwnerReconciler;
```

The verdict keeps its shape and gains the transport it was established on:

```ts
| { readonly kind: "attachable"; readonly host: OmpHostHandle;
    readonly pin: AttachPin; readonly detail: string }
```

`AttachPin` is a small, non-secret, transient target:

```ts
export type AttachPin =
  | { readonly kind: "broker"; readonly slot: string; readonly brokerId: string;
      readonly brokerGeneration: string; readonly brokerPid: number;
      readonly brokerCreationTime: string | null; readonly nativePid: number;
      readonly nativeCreationTime: string }
  | { readonly kind: "terminal" };
```

The index carries it unchanged through `SessionClassification.attachPin` into
`OmpHostAttachRequest.pin`; it neither interprets it, persists it, nor stores it in the row. The pin
is what makes "the attacher revalidates this target" enforceable instead of a promise: the attach
re-proves the same slot, broker identity/generation and child creation time before publishing a
runtime.

Decision order in the reconciler, once the registry row matches the recorded host exactly
(pid, instance id, normalized cwd, non-empty session id):

1. Resolve the durable slot. A recorded slot means this host is **broker-owned**: probe it, and
   answer from the probe alone. `attachable` (with a broker pin) when the probe proves a live
   managed child that is this row's PID with a non-null kernel creation time; otherwise `live` with
   a bounded reason the probe itself authored — never the broker client's, the helper's or an
   exception's own text, because that reason becomes a persisted row detail, a panel message and a
   notification (ADR-0017). No terminal is consulted, and no other transport is substituted.
2. With no recorded slot, look for the identical legacy VS Code terminal: found → `attachable` with
   a `terminal` pin (today's behavior); not found → `live` with the retained-writer explanation
   below.
3. No exact registry match keeps today's answers (`live`, `unknown`, `free` with combined absence
   evidence).

The "retained legacy writer" detail is the bounded explanation the panel and tooltip show:

> The OMP process this tab launched (pid N) is still hosting this session's Collab room, but its
> original hidden VS Code terminal is not in this window, so this window can neither drive nor stop
> it. Its claim is kept. Finish or exit that session in the window that started it, then Open this
> row again to recheck ownership.

### 2. The read-only broker probe

`probeManagedBrokerHost({ client, slot, recordedPid })`:

1. Read the slot's record: absent or unreadable is its own bounded answer, and never a fallback.
2. `client.attach(slot)` — attach, never launch; no owner hint, so the probe neither admits nor
   disarms any owner watch ([ADR-0030](../decisions/0030-watch-the-verified-owning-vscode-process-for-shell-grace.md)).
   A broker that does not answer is reported as a bounded category, not as its own error text.
3. Prove the attachment structurally: slot echoed by the broker, `kind === "managed-omp"` (a folder
   shell is never a session host), `state === "running"`, `nativePid === recordedPid`, and a
   non-null child creation time captured by the broker.
4. Independently read the live process generation of that PID through the staged probe helper — the
   same kernel reading that validated the broker's own PID — and require it to equal the broker's
   captured value. A PID that was reused fails here.
5. Return the broker pin, or a reason. The connection is disconnected in `finally` on both paths.

The same structural check runs at attach time (`verifyPinnedBrokerHost`), repeating step 4's
independent kernel reading on the fresh attachment and comparing every pin field; a target that
changed between the verdict and the attach, or one whose live generation no longer equals the
broker's captured value, is refused and its handle disconnected instead of adopted.

The host-control channel is unchanged and independent: `reconnectHostControl` already requires the
recorded control process id and re-verifies the stored process generation before granting controls.

### 3. The readiness gate does not latch a failure

`PtyBrokerClient.ready()` deliberately does not cache a *failure*: the usual cause is a staging or
self-check pass that has not finished, and the next call is the one that should see the fix. A window
that latched the first failure for the lifetime of the extension host defeated exactly that: a single
transient readiness failure — observed as `the runtime self-check failed with exit code 7` — left every
surviving broker unadoptable for the rest of the activation, so a broker-owned row stayed `live` and
reported "the PTY broker is not available in this window" for the whole session, including through an
explicit Open.

That observed exit 7 was not in fact transient, and the readiness gate was not its only cause: the
proof it refused had already been measured as unpassable in the extension host's own runtime, because
the self-check ran this runtime's own executable as its child, and an Electron-as-node child writes
nothing at all to its pseudo console ([ADR-0032](../decisions/0032-prove-the-pty-runtime-with-a-console-child.md)).
The gate now starts a console client instead, and a refusal reaches this window as the entry's own
one-line reason — `the runtime self-check failed with exit code 7: …` — instead of as its exit status
alone, so a readiness refusal names what the staged runtime actually measured.

`createPtyReadinessGate` (`src/host/pty-readiness.ts`) is the window-level policy over that client:

- it latches only a *proven* runtime, so nothing is staged twice per activation;
- it shares one attempt between every caller that arrives while a check runs;
- it keeps a *failed* check for a bounded window so a startup pass over many rows cannot run one
  staging attempt per row, and retries it afterwards;
- an explicit Open/Resume calls `invalidate()` first, because a user asking to recheck a session is
  never answered from a background pass's backoff;
- every retry is a readiness check only: it starts no broker, no OMP host and no session.

### 4. The handshake keeps its line boundaries

The handshake reads exactly one line — the broker's `hello-ok` — and leaves the rest of the chunk to
the authenticated frame reader. Because the line reader's `take()` removes the delimiter it split on,
putting that line back with `push()` spliced it into the bytes that arrived next: a broker that wrote
`hello-ok` and its first status frame in one TCP segment was then read as a single joined frame, and
the client closed the connection with `frame is not JSON`. It was intermittent (roughly one attempt in
five), it happened identically inside the extension host and in a standalone client, and it made a
perfectly authenticated, still-running broker look unauthenticated — the second half of the reported
"blocked survivor" symptom. `LineReader.unshift()` restores the delimiter, and the client's handshake
uses it, so the frame reader always sees the peer's own line boundaries.

### 5. Attachment follows the pin

`attachNativeOmpHostUnderBroker` takes the pin instead of a bare slot and re-proves it before
publishing the runtime; every refusal path disconnects the handle it opened (today a mismatch leaks
it). `attachHost` dispatches on the pin:

- `pin.kind === "broker"` → the broker path only. A refusal is reported as `unavailable`; it never
  falls back to a legacy terminal.
- `pin.kind === "terminal"` → the legacy path, exactly as today (exact-PID terminal adoption).

The panel-derived slot lookup (`stateOf(tabId)?.bridge?.editorId`) is no longer on the attach path,
which is what makes a broker-only survivor attachable before any editor exists.

The panel's transport is part of that target: an attached runtime carries the window's
**adopted loopback relay** (`NativeAttachRequest.relayUrl`), exactly as a launch does — never the
native Collab link's own origin. Installed OMP serves the link's wrapper over `http://`, and a panel
pinned to that origin cannot be prepared at all (`createGuestHtml` requires a loopback `ws://`
endpoint), so a correctly re-attached, host-control-verified session rendered only the bounded
"could not prepare this panel's local session connection" document while a freshly launched one
rendered its Chat | Terminal surfaces. The link stays what it is — a bearer capability for one room —
and the relay stays the only origin the guest is allowed to reach.

### 6. Stopped intent is an admission rule

`RestoreOptions` gains `resumeStopped`, set only by the explicit `SessionIndex.restore` path (a row
click, a Resume, a new session) and by a batch pass that a caller explicitly asked to start drafts
in. At the top of `#openEntry` — inside the tab's lifecycle gate, after the already-live check — a
row whose durable intent is `stopped` in a pass that may not resume it goes to
`#reportStoppedEntry` instead of any open path: the row's claim is read, never taken; the verdict is
obtained; and `classifySessionAvailability` decides exactly as it does for an open, so precedence
is unchanged (a missing materialized file is `failed`, an unreadable or foreign claim is
`owner-unknown`, unverified absence is `owner-unknown`). Then:

- classified `live` (a writer this window could attach is alive) → the row records `live` and the
  pass reports a `live` conflict: a writer of a stopped session is reported, never adopted.
- classified `owner-unknown` → the existing refusal: an uncertain earlier stop stays visibly held.
- classified `failed` → the missing-file failure an open would report.
- classified `saved` → the pass reports a new `stopped` outcome and the row stays stopped.
- classified `draft` (a fileless row, which starts nothing in this pass either way) → the draft
  outcome, and the stopped row never reaches the draft-reattach path, so a surviving writer of a
  stopped draft is not adopted either.

A running fileless draft is unaffected: the guard is keyed on the durable intent, so ADR-0021's
adopt-existing-reservation path still runs for it.

`RestoreReport` gains `stopped` (tab id + detail) and `RestoreOutcome` gains the `stopped` status, so
the launcher keeps showing a stopped row and a restored editor is told why it has no session instead
of waiting for a link that will never come.

### 7. Row actions and menus

Two commands with one implementation (`openTab`): `omp.openSession` ("Open Session") and
`omp.resumeSession` ("Resume Session"). Both are the admitted open path — attach first, launch
only on `free` — and the row's own command depends on its state: a stopped or draft row offers
Resume, everything else offers Open. A blocked row's Open re-runs reconciliation, explains through
the panel and the notification, and never starts a process.

The context-value tokens gain the materialization fact
(`ompSession.<forgettable|held>.<state>.<resumable|live-only>.<deletable|file-kept>.<materialized|fileless>`)
and the menu contributions become: Open (live states and blocked rows), Resume (stopped/draft),
exactly one Rename (live and stopped/draft states, never blocked), Close (live states), Reload (live
states of a materialized row), Forget (the existing forgettable token) and Delete (the existing
deletable token). The old imported-bookmark exception and the missing-transcript Forget-only case are
unchanged. The Close **command** re-checks before it asks: a row this window drives no transport for
is refused with the row's own reason and no confirmation dialog, because a modal that can only end in
"nothing was stopped" is worse than the sentence that says so.

For an owned host, the confirmed Close carries its existing per-tab lifecycle lease through
`SessionIndex.closeSession` while releasing the claim and recording stopped intent. It must not
request the same gate a second time: that would leave the row live with stopped intent after the
native process exits, and neither Close nor a later Resume could finish in that window.

## Alternatives

- **Treat any live matching Collab PID as attachable.** Rejected: liveness is not a usable transport
  and not a process generation; it would misrepresent legacy writers and PID reuse.
- **Probe by launching a broker into the slot.** Rejected: a probe must never create or adopt a
  writer, and `PtyBrokerClient.launch` can start one.
- **Require the surviving editor's panel before resolving the broker.** Rejected: editor membership
  is VS Code's, not ownership evidence, and a deliberately closed editor would strand a live writer.
- **Keep the legacy fallback after a failed broker attachment.** Rejected: it would silently drive a
  different transport than the verdict proved; a missing or unreachable record is uncertainty.
- **Persist the pin or broker secrets in the index.** Rejected: the index owns identity and claims,
  not transport; the pin is transient, and the token stays in private storage.
- **Make startup attach a stopped row because its writer is alive.** Rejected: the user's stop intent
  would be undone silently after every restart; the row is reported live instead, and Resume adopts
  it explicitly.
- **Release the claim of an unreachable legacy writer so Resume can start a second host.** Rejected:
  it erases writer-exclusion evidence (ADR-0024, ADR-0018).

## Risks and Open Questions

- The stopped reclassification runs inside the existing per-tab lifecycle gate (`#restoring` plus
  `withinTabLifecycle`), so an explicit Resume of the same tab is admitted either before or after it,
  never concurrently, and each reads the row's current state. Cross-window exclusion is unchanged and
  remains the exact-file claim's job; this pass takes no claim, so it can neither win nor lose that
  race by design.
- A broker probe costs one authenticated attach plus one helper spawn per indexed row that recorded
  a broker slot. It is bounded and read-only, but it is not free; if startup latency becomes
  visible, the probe can be cached per (slot, generation) for the pass.
- The legacy-writer explanation tells the user to finish the session in the window that started it.
  When that window is gone and the process is still alive, no extension-controlled recovery exists
  by design; the row stays blocked until the process exits.
- Installed VS Code acceptance (a real full restart with a broker survivor and a legacy survivor) is
  **not** covered here; it belongs to a separate isolated installed-window run.

## Rollout and Verification

Source order: reconciliation ports + probe/pin in `native-terminal.ts`; pin carriage and the
stopped-intent admission rule in `session-index.ts`; wiring, attach dispatch, row commands and the
stopped projection in `extension.ts`; tokens and menus in `session-tree.ts` and `package.json`;
focused tests in `native-terminal.test.ts`, `session-index.test.ts` and `session-tree.test.ts`.

Verification is behavioral and source-level: broker-only survivor attaches with zero launches;
wrong slot, folder-shell kind, exited child, null/mismatched child creation, changed pin and
independent-generation mismatch are refused without falling back; a stopped row starts nothing on a
restart pass and starts exactly once through Resume; the pin reaches the launcher; the menu token
matrix matches the intended action set. A separate isolated installed VS Code profile run then
exercises a real full exit/relaunch.

## Related Decisions

- [ADR-0024](../decisions/0024-own-omp-pty-for-in-tab-terminal.md) — the broker owns new managed
  writers; older hidden-terminal hosts are left until exit and never migrated.
- [ADR-0031](../decisions/0031-reattach-a-surviving-managed-host-through-its-broker.md) — the
  transport-evidence choice this design implements.
- [ADR-0021](../decisions/0021-reattach-a-verified-live-draft-on-activation.md),
  [ADR-0025](../decisions/0025-bind-editor-slots-to-current-conversations.md),
  [ADR-0018](../decisions/0018-resume-imported-history-under-extension-claims.md),
  [ADR-0029](../decisions/0029-report-uncontained-pty-tree-stop-as-unknown.md).

## Architecture Review

- Reviewer: independent architect (restart-package design review).
- Outcome: accepted after correction.
- Notes: The review found the core ownership contract, the transport-provenance rule, the transient
  pin, the probe evidence and the stopped-intent policy sound as written, with no blocker and no
  change to the accepted ownership scope. It required one material correction — the probe's failure
  reason must be a bounded category this extension authored, never the broker client's, the
  helper's or an exception's own text — which §1 and §2 now specify and the implementation enforces.
  Four clarifications were also applied: the attach verifier repeats the independent kernel reading
  (not only a pin comparison), §4 is phrased in terms of classified availability with unchanged
  precedence, the concurrency note names the per-tab lifecycle gate rather than a claim this pass
  never takes, and the decision links point at `docs/decisions/`.
