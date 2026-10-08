---
status: superseded
date: 2026-09-25
---

# Serialize one tab's lifecycle so draft promotion cannot bind a replaced host's file

> Ownership clauses narrowed by [ADR-0039](../decisions/0039-refuse-only-on-a-verified-live-writer-the-extension-owns.md): an unconfirmed restore releases its lease and no longer leaves owner-unknown/held reservation. Exact host/file and lifecycle authorization checks survive; automatic versus explicit admission remains distinct.

> Narrowly superseded by [ADR-0038](../decisions/0038-host-chat-over-rpc-ui-on-a-broker-pipe-child.md) and its [RPC-UI chat and Sessions design](2026-09-29-rpc-ui-chat-and-sessions.md): the bounded materialization lookup is replaced by an exact binding to `get_state.sessionFile`. The per-tab lifecycle gate of ADR-0015 remains operative.

## Problem

A fresh OMP tab starts as a *draft*: a tab identity, a reserved draft claim, and a
session directory the host writes into. Promotion — binding the tab to the exact
session file the host materialized — is asynchronous: a bounded pass watches for
the file, and `SessionIndex.promoteDraft` awaits a header read, a draft-claim
adoption and a canonical claim migration before it writes anything into the index.

Nothing excluded the tab's *runtime* transitions from that window. Two can happen
while a promotion is inside those awaits:

- a terminal close (`handleTerminalClosed`) clears the runtime, stops the host and
  calls `SessionIndex.closeSession`, which releases the tab's claim, deletes the
  live record and records `releasedAt` — the evidence that the previous writer is
  gone;
- a relaunch (`openTab` → `SessionIndex.restore`) publishes a replacement runtime
  for the same tab, adopts the same claim identity and sets a new live record.

`attemptDraftPromotion` checked the captured runtime only before the binding, and
`SessionIndex.promoteDraft` re-read nothing after its awaits: it mutated whichever
`#live` record now occupied the tab and overwrote the entry's ownership. A
promotion resuming after a close therefore re-bound a tab the user closed
(destroying `releasedAt`, leaving a canonical claim no host holds), and one
resuming after a relaunch bound the *previous* host's file to the *replacement*
runtime — the file identity the panel, the raw recorder and every later fact bind
to. That is the accepted P2 finding from the independent review of the
draft-promotion repair.

The finding is not a missing predicate. `promoteDraftClaim` acquires the canonical
claim and releases the draft one, and a released draft handle cannot be re-armed
(`src/host/session-claim.ts:693-716, 736-750`); a check placed after
`promoteDraft` returns can only report damage. What was missing is an ordering
rule between the operations that mutate one tab's lifecycle facts.

Reviewing those paths for this design found the same exposure elsewhere, which is
why the fix is a rule and not a call-site check:

- `deleteManagedSession` re-gathers its authorization, takes the canonical claim
  with *this window's own holder lease*, unlinks the transcript, releases the claim
  and then drops the row (`src/host/session-lifecycle.ts`). `acquireClaim` lets the
  same holder and generation adopt an existing claim, so the durable claim does not
  exclude a restore *in this window*: a restore that won the tab first could
  otherwise start a host for a transcript that is being unlinked.
- Deferred recovery read the directory and promoted from a row it had inspected
  several awaits earlier, so a launch, a close or a promotion in between could
  leave the adoption describing facts that no longer held. The absence evidence it
  acted on is stale in a second way too: an unconfirmed restore keeps its claim,
  records the host it could not confirm and leaves the row `owner-unknown` with *no*
  runtime and *no* live record, so a pass that only re-checks those two absences
  would adopt a file for a row nobody has proven safe.
- `restore`/`restoreAll` captured an entry, then ran a long reconcile-claim-launch
  region on that captured object, so a removal completing inside that window could
  leave a host and a live record for a row the index no longer had.
- `reconcileDeferred` rewrote a draft row's availability from a classification
  computed before its own awaits, so a promotion that won the same tab in between
  could have its result overwritten.

## Goals and Non-goals

- Goals:
  - One tab's lifecycle operations — draft promotion, runtime
    publication/replacement, terminal close, deferred adoption, row removal, and
    the whole native deletion transaction — never interleave; each either observes
    the state the previous one committed or is rejected by it.
  - A promotion whose captured runtime was replaced or cleared before it entered
    its own mutation region adopts nothing and takes no claim.
  - A promotion that entered first keeps its result: a close that arrives during it
    is ordered after it and releases the claim the promotion created, and a later
    reopen resumes exactly the promoted file.
  - Every trigger route of promotion (launch-time watch, post-turn watch, status
    and error single attempt, deferred pass) shares the same coordination.
  - Behavior that already works is unchanged: exact-file identity, the
    canonical-claim-before-draft-release order, no cwd fallback outside the tab's
    own isolated directory, bounded event-driven passes, and the existing refusal
    outcomes (duplicate restore, claim conflict, unconfirmed stop, adopted rows
    read-only).
- Non-goals:
  - Making a physical terminal-close notification retroactively cancel a promotion
    that already passed its commitment point. See *Ordering*.
  - Changing claim semantics or the claim file format, the isolated-directory
    fallback policy, adopted-session policy, external-writer exclusion, or
    crash-atomicity between the two claim identities and the persisted memento.
  - Bounded *completion*: the gate adds no timeout of its own and only ever
    releases after its operation has settled. See *Waiting*.
  - Replacing the raw-recorder deletion transaction's own cross-process
    coordinator/executor ownership (ADR-0014); this design keeps it outside the
    gate and preserves its preflight and frozen targets.

## Current State

- `src/host/draft-promotion.ts` owns the promotion *decision*: exact-file rules,
  the bounded pass, and `stillCurrent()` checked before the directory read. It had
  no lifecycle exclusion, and the binding it calls awaits three times inside the
  index.
- `src/host/session-index.ts` owns every durable per-tab mutation. `#restoring`
  only excludes a duplicate restore of one tab, `#persistChain` only orders
  memento writes, and the claim locks in `session-claim.ts` cover one claim
  mutation per filesystem identity. None is a lifecycle transaction.
- `src/extension.ts` owns `NativeHostRuntime` and the VS Code terminal events.
  Runtime publication happens on attach and launch; the terminal-close handler
  cleared the runtime synchronously and then awaited stop proof, control release,
  `closeSession` and the panel disconnect. Those assignments are the only runtime
  ones (`tabState(...).runtime = ...`, `state.runtime = null`).
- Status and error reports call `attemptDraftPromotion` outside the pass map, and
  deferred recovery called `index.promoteDraft` directly, so a fix limited to the
  watch path would have left bypasses.

## Proposed Design

### One coordinator per index

A new module `src/host/tab-lifecycle.ts` provides a per-tab serial queue:

- `TabLifecycle.run(tabId, operation)` queues `operation` behind every operation
  already requested for that tab and returns its `Promise`; operations for one tab
  run one at a time, in request order, and a rejected operation does not wedge the
  ones after it. Queue entries are dropped once a tab's operations have settled.
- The running operation receives an opaque `TabLifecycleLease`;
  `TabLifecycle.holds(lease)` is true only for the lease of the operation running
  for that tab right now.
- Different tabs never wait for each other *in the gate*. They can still wait
  behind the same shared resource — the index's single `#persistChain` and the
  store write it awaits, and the claim directory — so the queue is per tab, but
  progress is not independent of the rest of the window.

`SessionIndex` creates one `TabLifecycle` and exposes it as `index.lifecycle`, plus
`SessionIndex.withinTabLifecycle(tabId, lease, operation)` as the one
implementation of "hold this tab" for the index *and* for a module the index does
not own. One coordinator per index is what makes the coordination structural
rather than a convention.

### Ordering

Two orders are possible, both safe, decided by whoever reaches the gate first:

- **Runtime transition first.** A close or relaunch that obtains the tab's gate
  changes the runtime (or the index's live record) before the queued promotion is
  admitted. The promotion re-reads its captured runtime *inside* the gate, sees it
  is no longer the tab's, logs that the host it described is gone, and returns
  without touching a claim, the entry or the live record.
- **Promotion first.** A promotion that obtains the gate runs its whole mutation
  region — header read, draft adoption, canonical acquisition, draft release,
  entry and live-record update, persistence. A close that arrives meanwhile is
  queued and, once the promotion has settled, releases the canonical claim the
  promotion created and records the release *if the stop is confirmed and the
  release succeeds*; otherwise the claim is retained under the existing
  unconfirmed-stop policy and a later reopen may be refused. A later reopen that
  is permitted resumes exactly that file.

A physical terminal-close notification therefore does **not** cancel a promotion
that has already passed the gate: it is ordered after it. What this design buys is
that no promotion writes into a runtime that replaced its captured one, and that
no close, relaunch, removal or deletion consumes a half-migrated claim state — not
that a close request observed at any time wins.

### What each operation holds the gate for

- **Draft promotion** (`SessionIndex.promoteDraft`): the whole method — entry
  re-read, header read, claim adoption, canonical migration, entry/live update,
  persistence — with the captured runtime re-checked by the caller inside the same
  lease (`src/host/draft-promotion.ts`). The directory discovery and the pass's
  sleeps stay outside it.
- **Deferred adoption** (`SessionIndex.promoteDeferredDraft`, called from
  `adoptDeferredSessionFile`): the row re-read, the directory listing *and* the
  promotion are one gated operation, so the discovery cannot describe facts that
  changed before the binding. It refuses while this window holds a live record for
  the tab, because a host this window runs materializes its own file and only that
  host's promotion may bind it. And it requires the authorization the report
  produced: `DeferredReconciliation.authorization` is a signature of the row facts
  the classification was computed for (binding, identity, availability, ownership,
  recorded host), `reconcileDeferred` derives it inside the same gated region as
  the classification, and `promoteDeferredDraft` re-derives it inside the
  adoption's own lifecycle. A launch, a close, a promotion or an unconfirmed
  restore that changed the row in between therefore refuses the adoption instead
  of overriding it — which is what makes "no runtime and no live record"
  insufficient on its own, since an unconfirmed launch leaves exactly that state
  with an unresolved owner. The external world is still not re-observed under the
  gate; a change there is the reconciler's subject and the pass's own next run.
- **Restore and attach** (`#restoreEntry`, reached by `restore` and by each tab of
  `restoreAll`): from the claim read through reconciliation, launch/attach, the
  live record, the recorded host and the persistence. The duplicate-restore
  reservation is taken *before* the gate, so two overlapping restores of one tab
  still report a duplicate instead of running twice. Once admitted, the row is
  re-fetched by id and the restore refuses if it is no longer this index's row for
  that tab.
- **Terminal close** (`handleTerminalClosed`): the handler captures the exact
  runtime the event speaks for and coalesces a duplicate notification for the same
  runtime (keyed by tab *and* runtime, so a close for a replacement is still a
  close). Inside the gate it re-checks that the captured runtime is still the
  tab's; only then does it clear the runtime, record the outcome, prove the stop,
  release control material, call `closeSession` and disconnect the panel. A close
  whose runtime was already replaced does nothing at all.
- **Row removal** (`remove`, `dropDeletedSession`): the whole method, so a removal
  cannot delete a row out from under a promotion that is about to take the
  identity the row guards.
- **Native deletion** (`deleteManagedSession`): the post-dialog transaction —
  re-gathering authorization, taking the canonical claim, unlinking the transcript
  and its artifacts, releasing the claim and dropping the row — as one gated
  operation, with the row drop joining the caller's lease instead of re-entering.
  The confirmation dialog, the read-only inspection and the raw-recorder preflight
  stay outside the gate, and the raw commit/rollback phases run after it.
- **Deferred reconciliation** (`reconcileDeferred`): the per-tab body, with the
  "still a draft and no live record" facts re-read inside the gate, so a promotion
  that won the gate is never clobbered by an availability re-derivation computed
  from the pre-promotion row.

### Lease passing instead of re-entry

An operation that already holds its tab's gate must not call `run` for that tab —
that would queue behind itself. Three index methods accept an optional final
`lease` parameter: `promoteDraft`, `promoteDeferredDraft` and `closeSession` (the
ones an extension-side gated operation calls), and `dropDeletedSession` joins the
deletion's lease. A lease for another tab, or one the gate is not currently
running, is rejected with a session-index error rather than silently skipping the
exclusion. A fabricated lease is therefore rejected too: the gate, not the caller,
decides whether a lease is real.

### Interface invariants

- An awaited callback under the gate must not itself wait for work queued behind
  that gate. The launch and attach paths obey this by leaving the materialization
  watch **detached** — it is never awaited from inside the restore that started it,
  and it acquires its own later lease. The reconciler port only observes native
  state; the store write only writes the memento; panel disposal clears panel and
  activity state and is not a native close.
- Ownership across windows is still the durable claim. The gate orders one
  extension host's operations and is not a cross-process mechanism.

### Waiting

The gate adds no timeout and never releases while its operation may still mutate.
The promotion's retry budgets and the claim module's bounded lock wait are
unchanged, but they bound *those* steps only: a gated operation also awaits real
filesystem work, the claim directory, native readiness and stop proof (which
sleeps while proving an exit), `SecretStorage`/`Memento` operations, and the
extension's own reconciler and launcher ports, none of which carries an enclosing
deadline. What can be promised is ordering and fail-closed behavior, not bounded
completion: promotion discovery sleeps and user dialogs stay outside the gate, a
timeout never unlocks a gate whose operation might still be mutating, and a step
that cannot settle delays the operations queued behind it for that tab.

### Alternatives

- **A runtime predicate inside `promoteDraft` only, checked after its awaits.** The
  claim migration has already happened; the draft handle is released and cannot be
  re-armed, and releasing the canonical claim unconditionally can release a claim
  that was adopted from the same holder rather than created here. A predicate plus
  best-effort compensation is not an atomic undo.
- **A staged promotion with an invalidate-on-close token and a two-phase commit.**
  This is the design that would deliver the stronger "a close observed before the
  staged commit wins, including during the preparation awaits" guarantee. It would
  use `acquireClaim` for preparation and split today's `promoteDraftClaim` sequence
  — which acquires the canonical claim and *then* releases the draft before
  returning (`src/host/session-claim.ts:702-716`) — keeping the draft held through
  the final validity check and the synchronous commit. That needs acquisition
  provenance (today `acquireClaim` returns indistinguishable created/adopted
  handles), cancellation ownership for a leftover canonical claim, and post-commit
  cleanup rules. It remains viable and is a larger change to claim error ownership
  than this defect requires; it was not chosen.
- **Reusing `#restoring`, `#persistChain`, the promoter's pass map, or the claim
  locks.** Each excludes a smaller and different set; none covers runtime
  replacement plus index, claim and file mutation together.
- **Gating only the assignment `state.runtime = ...`.** A replacement process and
  its claim work may already have started; the gate must begin at the lifecycle
  operation, not at its last field write.
- **Serializing all tabs through one global gate.** Correct but needlessly
  blocking: a long restore or stop of one tab would delay every other tab's
  promotion, and it hides the per-tab nature of the invariant.

## Risks and Open Questions

- Holding the gate across a launch, a stop proof or a native deletion means another
  lifecycle operation for that tab waits for it. That wait is what the ordering
  requires; a promotion queued behind them re-reads the runtime, so a long wait
  cannot produce a stale bind.
- `handleTerminalClosed` clears the runtime at admission rather than at
  notification, so a tab whose close is queued still reports as running
  (`launcherFacts().running`, `windowHostRunning`) until its operation is admitted.
  Every consumer of that fact becomes more conservative, never less.
- Pre-existing and unchanged: `promoteDraft` converts a `ClaimPromotionError`
  (canonical claim acquired, draft release failed) into an ordinary
  `not-materialized` result and does not retain that handle
  (`src/host/session-claim.ts:311-332`); a crash between the two claim identities
  is not atomic; a lone cwd-matching file in a tab-keyed isolated directory is
  still not provably this run's; `closeSession` retains a claim on an unconfirmed
  stop; external writers that do not honor claims are not excluded.
- The deferred pass does not re-run the reconciler under the gate. It refuses when
  the row changed since the classification it carries an authorization for, so a
  stale verdict delays an adoption rather than authorizing one; what no gate can
  observe is the external world itself — a writer that started after the
  reconciler answered — which stays the reconciler's subject and the claim's
  limit.
- A caller that holds a lease and forgets to pass it down will wait for itself. The
  gate rejects a lease it is not running, and only the four methods above take one.

## Rollout and Verification

Implemented in this order:

1. `src/host/tab-lifecycle.ts` with the gate, the lease and its unit tests
   (`src/host/tab-lifecycle.test.ts`): one operation per tab in request order, a
   rejection does not wedge the queue, lease identity, and tabs independent.
2. `SessionIndex` owning the gate and routing its lifecycle mutations through it,
   with `withinTabLifecycle` as the single dispatch, the in-gate row re-reads, and
   the lease parameters.
3. `attemptDraftPromotion` binding inside the gate with the in-gate runtime
   re-read; `extension.ts` taking the gate for the terminal close, the deferred
   adoption and the deletion's tab-state cleanup.
4. `session-lifecycle.ts` running the native deletion under the gate, joining a
   caller's lease and passing it to `dropDeletedSession`.

Verification, with real session files and real claims in temporary directories and
in-memory Memento adapters (`SessionIndexStore` stand-ins — the VS Code memento
itself is exercised by the maintainer's acceptance run, not here):

- `src/host/tab-lifecycle.test.ts` — the gate's own contract: one operation per tab
  at a time in request order, a rejection does not wedge the queue, lease identity,
  and tabs independent.
- `src/host/draft-promotion.test.ts` — "lifecycle coordination":
  - *arrival-acknowledged* barrier at the canonical claim acquisition: the claim
    module's own per-identity mutex (`claimMutexPath`, taken the documented way for
    a higher layer) holds the canonical identity, and the test waits for an
    acknowledged effect — the reserved identity's claim record, published before the
    migration — with a bounded probe that fails rather than proceeding blind. This
    is an acknowledged *post-header, pre-binding* barrier with the canonical
    acquisition blocked, not an instruction-level arrival signal inside
    `promoteDraftClaim`: it proves the real promotion passed the header read and
    reached the claim work while binding is still impossible. The close must not
    complete while the hold stands (a bounded window is given to it, with the hold
    released in `finally`), and only after the release does the promotion bind and
    the close release exactly that claim;
  - a close that won the tab's lifecycle: the promotion refuses with the
    *in-gate* message (asserted distinct from the earlier check's message, which
    must not appear), binds nothing, takes no claim for the file, and does not
    disturb the close's `releasedAt`;
  - a close *and* relaunch that won the tab's lifecycle: the promotion refuses,
    exactly one host was started, and the replacement's claim on the identity
    stands.
- `src/host/session-index.test.ts` — "lifecycle coordination":
  - a promotion parked *after* its claim migration, at its memento write, is not
    interleaved by a queued close (asserted after the close's own turn has had the
    chance to run), which then releases the promoted claim, and a later reopen
    launches one host for exactly that file;
  - a relaunch of a tab this window runs starts no second host, and the live record
    is proved to hold the *promoted* claim (only releasing it frees the file);
  - a promotion queued behind the batch restore that launched its host binds the
    exact file and deadlocks nothing;
  - a promotion queued behind a row removal adopts nothing and leaks no claim;
  - a restore queued behind a row removal refuses instead of opening a detached
    row and never calls the launcher;
  - a deferred adoption is refused while this window runs the host, leaving the
    host's claim untouched;
  - a deferred adoption whose authorization a later *unconfirmed* restore made
    stale is refused: the row keeps `owner-unknown`, the candidate file is not
    bound, no canonical claim is taken, and the claim the unconfirmed launch kept
    stands;
  - the same fixture with a current authorization *is* adopted, so the rule refuses
    staleness rather than the flow;
  - a lease the tab's lifecycle is not holding — a fabricated one, or one for
    another tab — is rejected instead of being accepted as "already held", so the
    exclusion cannot be skipped by presenting a token;
  - a native deletion queued behind a restore is refused (`live-in-window`) rather
    than unlinking the transcript that host runs.

Failing-before evidence, and it is deliberately narrow: with the gate's *queue*
disabled (operations run immediately, leases still valid) eight tests fail — the
arrival-acknowledged claim-acquisition barrier, both transition-first promotion
tests, the promotion-parked-at-its-memento-write test, the removal-queued promotion
and restore tests, the deletion-versus-restore test, and the gate's own
request-order test. The two deferred-authorization tests are not sensitive to that
switch and are instead checked against the rule itself: with the signature
comparison removed, the stale-authorization test fails and the current-authorization
test still passes. Local gate: `node --test` on those three files plus
`tsc -p tsconfig.json --noEmit`. The raw-recorder deletion suite, which consumes
`deleteManagedSession`, is run too because the deletion now takes the gate.

The header read has no injectable seam, so no barrier sits at that specific await:
it is covered structurally instead — the gate is held for a promotion's whole
mutation region, and `src/host/tab-lifecycle.test.ts` proves that one tab runs one
operation at a time, in request order, while the two barrier tests above show the
exclusion on real in-flight steps of the same operation. A close or relaunch
arriving during the header read is therefore queued behind the promotion, which is
the property the barriers demonstrate at the adjoining awaits and the gate test
demonstrates for every await inside the operation.

Not covered here, and left to the maintainer's isolated real-window run: the
extension's own event wiring — a duplicate terminal notification and an unconfirmed
stop, which have no test seam without `vscode`; the materialization watch fired from
inside a launch/attach callback (the batch test above queues it from the caller,
which is the same pre-`#live` ordering but not the same call site); the pending
session against a replaced runtime; the recorder binding to the promoted file; and
the full suite and VSIX build.

## Related Decisions

- [ADR-0015: Serialize one tab's lifecycle through a per-tab gate](../decisions/0015-serialize-tab-lifecycle-through-one-gate.md)
- [Architecture](../architecture.md) — describes the behavior before this change;
  its promotion paragraph and the relationship to ADR-0007/ADR-0014 belong to the
  maintainer's documentation pass.
- [ADR-0007: Native file evidence with guarded restore](../decisions/0007-native-file-evidence-and-guarded-restore.md)
  — observation and restore limits this design does not change.
- [ADR-0014: Persist the raw-deletion executor claim in its transaction descriptor](../decisions/0014-persist-executor-claim-in-raw-deletion-transaction.md)
  — the raw-recorder deletion transaction stays its own cross-process authority;
  this gate only orders the native side of a deletion.
- [Raw session recorder design](2026-09-24-raw-session-recorder.md) — the recorder
  binds a recording to the tab's exact session file, which is why a stale bind is
  user-visible.

## Architecture Review

Two separate architecture reviews were run on the first revision (2026-09-25), one
per document, both read-only against the frozen baseline, followed by a
confirmation pass on the revision.

- Design reviewer: an independent architecture review of the design —
  "retain the per-tab coordinator and the promotion-first ordering, but close the
  mutation/admission gaps below and correct the liveness claims". Five MATERIAL and
  three NON-MATERIAL findings on the first pass, all resolved; the confirmation pass
  then found two more MATERIAL findings and two NON-MATERIAL ones, resolved in this
  revision:
  - M1 native deletion was outside the declared scope → the whole post-dialog
    deletion transaction is now gated, with its own lease joined by the row drop,
    the dialog and the raw preflight outside, and the extension's tab-state cleanup
    inside the same operation.
  - M2 restore/restoreAll did not re-fetch the row after queue admission → the row
    is re-read by id inside the gate and an absent row refuses.
  - M3 deferred authorization: moving discovery under the gate fixed stale
    discovery but not stale *authorization*, because an unconfirmed launch or
    restore leaves a row with no runtime and no live record while nothing has been
    proven about its host → `DeferredReconciliation.authorization` (a signature of
    the row facts the classification was computed for, derived inside the same gated
    region) is now required by `promoteDeferredDraft` and re-derived inside the
    adoption's lifecycle; the regression the reviewer named is a test.
  - M4 boundedness was overstated → the *Waiting* section distinguishes the gate's
    per-tab queue from shared resources and from external waits without enclosing
    deadlines, and promises no bounded completion.
  - M5 the verification evidence overstated its barriers → the claim-acquisition
    barrier now waits for an acknowledged effect with a bounded probe and releases
    the hold in `finally`; the memento-write barrier is described as what it is,
    *after* the claim migration; the detached watch fired from inside a launch
    callback is explicitly kept as an owner-run item.
  - N1 the staged alternative was mis-stated ("even after commitment") → now
    "before the staged commit, including during the preparation awaits", with the
    `acquireClaim`-vs-`promoteDraftClaim` split named and the provenance and
    leftover-ownership costs stated.
  - N2 callback obligations were implicit → one interface-invariant section, with
    the correct leased-method count.
  - N3 the pre-existing partial-migration ownership failure is listed as a residual
    rather than implied to be repaired.
  - N4/N5 wording: the Memento adapters are named as adapters, and the staged
    alternative's claim-mechanics sentence is exact.
  - Pass 3 (confirmation of the M3/M5 revisions): no remaining MATERIAL findings;
    the design may be accepted as a design. One NON-MATERIAL precision note applied
    — the claim-acquisition barrier is described as an acknowledged post-header,
    pre-binding barrier with the canonical acquisition blocked, not as an
    instruction-level arrival signal inside `promoteDraftClaim` (the reserved
    identity's record is published during draft acquisition, and `acquireClaim`
    publishes before finishing its own cleanup).
- ADR reviewer: an independent architecture review of the ADR — "retain
  Option 1, but resolve M1 and M2 before acceptance":
  - M1 per-tab independence and bounded waits were overclaimed → the ADR states
    what is per-tab, what is shared, and that completion is not bounded.
  - M2 native deletion was missing from the universal mutation claim → the ADR
    includes it, with the dialog and ADR-0014's raw transaction explicitly outside.
  - N1–N4 wording, prospective tense, related-document links and the review record.
  - Confirmation pass: original M1/M2 and N1–N4 resolved; the close-ordering
    statement confirmed again; one new MATERIAL wording defect found — the revised
    Consequences said external writers "remain excluded only by the claim", which
    overstates a cooperative claim — and corrected to "neither observed nor
    excluded by this gate or the durable claim".

Outcome: the design's pass-1 and pass-2 findings were resolved, the pass-3
confirmation found no remaining material findings, and this design is therefore
`accepted` as a design; the ADR was confirmed with its wording correction applied
and is `accepted`. Acceptance of either document is not certification of the
implementation, the live window, or the full suite: the isolated real-window run,
the full test suite and the VSIX build remain the maintainer's.
