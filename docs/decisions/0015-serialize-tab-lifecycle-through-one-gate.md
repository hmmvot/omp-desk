---
status: accepted
date: 2026-09-25
---

# ADR-0015: Serialize one tab's lifecycle through a per-tab gate

## Context and Problem Statement

One tab's lifecycle facts are changed by operations that await: draft promotion
(header read, draft-claim adoption, canonical claim migration), runtime
replacement (restore or attach, launch, live-record publication), terminal close
(runtime clear, stop proof, claim release, control cleanup), native session
deletion (claim acquisition, file removal, release, row drop) and row removal.
Each was written assuming nothing else changes those facts while it awaits, and
nothing enforced it.

The accepted P2 finding from the independent review of the draft-promotion repair
is the concrete result: `SessionIndex.promoteDraft`
can resume after a close or a relaunch has completed, and then bind the *previous*
host's session file to the *replacement* runtime — or re-bind a tab the user
closed and destroy the recorded release that no writer is alive. The tab's file
identity is what the panel, the raw recorder and every later fact bind to, so the
damage is user-visible. The same review found the exposure on the deletion,
deferred-adoption, restore and deferred-reconciliation paths, which is why the
decision is a rule about operations rather than a check at one call site.

A predicate cannot repair it after the fact: `promoteDraftClaim` releases the
reserved draft claim while acquiring the canonical one
(`src/host/session-claim.ts:693-716`), so a promotion that has passed that point
cannot be undone without inventing provenance and rollback rules for claims. The
requirement is an ordering rule between whole operations.

Constraints: keep the canonical-claim-before-draft-release order, exact-file
identity, the single-writer rule, explicit and shared session directories, bounded
event-driven promotion, and every existing refusal outcome; keep user dialogs, the
raw-recorder deletion transaction's own cross-process authority (ADR-0014) and
promotion discovery sleeps outside the gate; keep one writer for product source.

## Considered Options

- **Option 1 — per-tab lifecycle gate shared by promotion, runtime transitions,
  close, removal and native deletion.** A serial queue per tab, owned by
  `SessionIndex` and reused by the extension and by the deletion module; a
  promotion re-reads its captured runtime inside the queue. Cheap, local, and it
  makes those operations linearizable in request order. Queues are per tab, but
  shared resources (the index's single persistence chain, the claim directory,
  native readiness and stop proof) can still delay several tabs, and the gate
  promises no bounded completion.
- **Option 2 — staged promotion with an invalidate-on-close token and a two-phase
  commit.** Split promotion into preparation and commit, keep both claims until the
  commit, revalidate a monotonic runtime token after each await, and return only a
  canonical claim this transaction provably created. It would use `acquireClaim`
  for preparation and split the current `promoteDraftClaim` sequence — which
  acquires the canonical claim and *then* releases the draft before returning
  (`src/host/session-claim.ts:702-716`) — keeping the draft held through the final
  validity check and the synchronous commit, so a close observed before that commit
  (including during the preparation awaits) wins. It needs acquisition provenance
  (today `acquireClaim` returns indistinguishable created/adopted handles,
  `src/host/session-claim.ts:531-593`), cancellation ownership for a leftover
  canonical claim, and post-commit cleanup rules — a larger change to claim error
  ownership than this defect requires. Kept as a viable but larger alternative, not
  chosen.
- **Option 3 — a post-await predicate in `promoteDraft` plus best-effort
  rollback.** An unconditional canonical release can free a reservation that was
  adopted from the same holder rather than created by this transaction, and a
  released draft handle cannot be re-armed, so compensation is fallible rather
  than atomic. Not chosen: safe compensation requires Option 2's protocol.
- **Option 4 — reuse an existing exclusion (`#restoring`, `#persistChain`, the
  promoter's pass map, the per-identity claim locks).** Each excludes a different
  and smaller set of operations; none spans runtime replacement plus index, claim
  and file mutation. Rejected as insufficient.

## Decision Outcome

Option 1. `SessionIndex` owns one `TabLifecycle` (`index.lifecycle`) and exposes
`withinTabLifecycle` as the single dispatch — the same gate the extension host
takes for the transitions the index cannot see — and every per-tab lifecycle
mutation runs through it:

- promotion and deferred adoption run their whole mutation region inside the gate
  and re-read the facts they depend on once admitted (the captured runtime for a
  watch promotion; the row, the directory and the absence of a live record for a
  deferred adoption);
- restore and attach hold the gate from the claim read through runtime
  publication, re-fetch the row by id on admission, and keep the duplicate-restore
  refusal booked before the gate;
- terminal close captures the exact runtime, coalesces a duplicate notification for
  it, and inside the gate verifies it is still the tab's runtime before clearing
  anything or releasing a claim;
- native deletion runs its post-dialog transaction under the gate, joining a
  caller's lease and passing it to the row drop, with the dialog, the read-only
  inspection and the raw-recorder preflight outside;
- row removal and the per-tab body of deferred reconciliation hold the gate.

The resulting guarantee is local linearizability in request order: a promotion and
a runtime transition of one tab are ordered, never interleaved. Whichever reaches
the gate first wins. If the transition wins, the queued promotion rejects its
captured runtime and mutates nothing. If the promotion wins, it completes, and a
queued close then releases the canonical claim it created — when the stop is
confirmed and the release succeeds, under the existing claim policy — so a later
permitted reopen resumes exactly the promoted file. A physical terminal-close
notification therefore does not retroactively cancel an already-admitted
promotion, and this ADR does not claim that it does.

An operation that already holds its tab's gate passes its lease down instead of
re-entering: `promoteDraft`, `promoteDeferredDraft` and `closeSession` accept one,
`dropDeletedSession` joins the deletion's. A lease for another tab, or one the gate
is not currently running, is rejected.

### Consequences

- Positive: the "promotion adopts a file for a host this window no longer runs"
  class of defect is closed by construction for every trigger route, not by a
  predicate per call site; a new caller inherits the exclusion instead of
  re-deriving it.
- Positive: the change is local to the tab. Different tabs do not queue behind each
  other *in the gate*, and no claim format, policy or refusal outcome changes.
- Negative: a lifecycle operation can now wait for another one of the same tab —
  a promotion can wait for a stop, a close can wait for a promotion's claim
  migration, a native deletion can wait for a restore. Waiting is what prevents the
  stale bind, but the gate adds no timeout of its own and promises no bounded
  completion: queued operations share the index's persistence chain and await real
  filesystem, claim, readiness and storage work that carries no enclosing deadline,
  and a step that cannot settle delays the operations behind it.
- Negative: the gate is not a cross-process mechanism. What arbitrates two windows
  is still the durable claim; the gate orders one extension host's operations only,
  and it does not replace ADR-0014's raw-deletion transaction.
- Negative: `handleTerminalClosed` clears the runtime at admission rather than at
  notification, so a tab whose close is queued still reports as running until its
  operation is admitted. Every consumer of that fact (deletion, deferred adoption)
  becomes more conservative, never less.
- Negative: the guarantee is limited to the extension's own operations and the
  index's durable mutations. It is not a proof that a lone cwd-matching file in a
  tab-keyed isolated directory belongs to the current run; external writers that
  ignore extension claims remain neither observed nor excluded by this gate or the
  durable claim; a crash between the two claim identities is still not atomic; and
  the pre-existing loss of a canonical claim handle on a draft-release failure
  (`src/host/session-claim.ts:311-332`) is not repaired.

## Related Documents

- [Design: serialize one tab's lifecycle so draft promotion cannot bind a replaced host's file](../designs/2026-09-25-draft-promotion-lifecycle-serialization.md)
- [Architecture](../architecture.md) — describes the current, pre-change behavior.
- [ADR-0007: Native file evidence with guarded restore](0007-native-file-evidence-and-guarded-restore.md)
  — observation and restore limits that this decision does not change.
- [ADR-0014: Persist the raw-deletion executor claim in its transaction descriptor](0014-persist-executor-claim-in-raw-deletion-transaction.md)
  — a distinct cross-process protocol; this decision orders only the native side of
  a deletion and keeps the raw executor and its frozen targets outside the gate.

## Architecture Review

Reviewed on 2026-09-25 by a separate architect,
read-only against the frozen
baseline: "retain Option 1, but resolve M1 and M2 before acceptance. The selected
close ordering is correctly stated; no reconsideration of that accepted behavior is
needed."

- M1 (MATERIAL) per-tab independence and bounded waits were overclaimed: the
  index's single persistence chain and untimed store write, and the reconciler,
  launcher, storage and native readiness/stop waits, are shared or unbounded. The
  Consequences and Option 1 now say what is per-tab, what is shared, and that no
  bounded completion is promised; the gate is never released by a timeout while its
  operation may still mutate.
- M2 (MATERIAL) native deletion was not in the declared lifecycle scope, and
  gating only the final row drop could not exclude a restore from adopting the
  deletion's own claim. The decision now includes the post-dialog deletion
  transaction, with lease passing into `dropDeletedSession`, the dialog outside and
  ADR-0014's raw transaction preserved.
- N1–N4 (NON-MATERIAL) option-2/option-3 wording, the prospective tense of
  "will be serialized", the qualification of the close-then-reopen example, the
  related-document links and this review record are applied. The close-ordering
  statement and the explicit
  limit that a close notification does not cancel an admitted promotion were
  confirmed correct and are unchanged.

- Re-review (confirmation pass, 2026-09-25):
  original M1 and M2 resolved,
  Option 1 retained, N1–N4 resolved, and the close-ordering statement confirmed
  again. It found one new MATERIAL wording defect: the revised Consequences said
  external writers "remain excluded only by the claim", which overstates a
  cooperative claim. Corrected to "remain neither observed nor excluded by this
  gate or the durable claim", preserving the limitation recorded in
  `docs/architecture.md` and ADR-0007/ADR-0014.

Outcome: findings resolved; re-review confirmed with that one correction applied,
so this record is marked `accepted`. Acceptance of this decision is not
certification of the implementation, the full test suite, or the isolated
live-window run, and it is not a claim about code that does not exist yet.
