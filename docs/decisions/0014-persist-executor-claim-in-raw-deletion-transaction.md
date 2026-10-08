---
status: superseded
date: 2026-09-25
---

# ADR-0014: Persist the raw-deletion executor claim in its transaction descriptor

> Superseded by [ADR-0038](0038-host-chat-over-rpc-ui-on-a-broker-pipe-child.md): the raw Collab recorder family this transaction served is removed, so its executor-claim descriptor has no consumer. Native history deletion keeps its non-recorder checks (ADR-0027). The record is preserved for its rationale on cross-process ownership and recoverable frozen sets.

## Context and Problem Statement

A raw-recording deletion freezes exact epoch targets and may outlive the window that started it. Native history deletion also needs a creation barrier between its raw preflight and native transcript removal. A retention timer, another window, and an explicit Retry can all encounter the same pending transaction. Producer-stop proof permits removal of a target's bytes; it does not prove that the operation which owns the session-wide barrier has finished. A process-local set does not exclude another extension host, and a short-lived filesystem coordinator lock cannot cover the native operation without blocking unrelated progress.

The accepted [raw recorder design](../designs/2026-09-24-raw-session-recorder.md) requires one recoverable, immutable frozen set, positive producer-stop proof, truthful partial results, and hard shared capacity. An unreadable or uncertain owner must fail closed. A vanished namespace is not, by itself, proof that its original targets were removed. The external roomless OMP writer limitation remains separate and unchanged.

## Considered Options

- Hold the session coordinator throughout native deletion: excludes concurrent extension operations, but holds a filesystem lock across long-lived native work and creates avoidable lock-order and crash-recovery problems.
- Use only process-local operation tokens: prevents overlap within one extension host but lets different windows execute the same transaction concurrently.
- Add a separate executor lease/guard file: permits cross-process exclusion but creates a second durable authority whose partial publication and cleanup must be reconciled with the transaction descriptor.
- Record the executor claim and lifecycle on the existing transaction descriptor: one discoverable authority, serialized claim transitions, and no additional persistent file.

## Decision Outcome

Use the existing session-digest deletion descriptor as the sole authority for the frozen target set and cross-process execution ownership. Session-wide creation exclusion applies only to manual delete-all and full-history deletion; automatic expiry coordinates and fences its exact expired epochs without disabling creation or non-target epochs. Recovery preserves the transaction's original reason and scope and never promotes expiry to delete-all. The transaction ID, immutable session binding and targets never change during a retry. An optional `retryable` fact distinguishes a prepared live operation from an owner-handed-off terminal partial; absence means prepared or unknown, not abandonment. An optional executor claim records an operation token, process ID and non-null process generation. A process-local token capability complements, but never replaces, this durable cross-process claim.

Before acquiring a claim, gather any required owner/claim stop evidence without holding the filesystem coordinator. Under that coordinator, re-read the descriptor and compare the exact transaction, session, owner and observed claim tuple; stale evidence never authorizes a changed claim or successor descriptor. Check current-executor ownership independently from the original producer or transaction owner's liveness. Write the claim atomically to that same descriptor before an operation executes or adopts the transaction. Every entry path—preflight, direct delete, explicit Retry and automatic recovery—uses the same eligibility and acquisition rule. A live or uncertain competing executor keeps the operation pending; a dead executor can be superseded only with positive proof for its exact recorded process generation.

A live prepared operation retains its applicable barrier while native removal is in progress. Only its exact owning capability can commit, cancel, or hand off a terminal partial. A partial handoff sets `retryable` and releases that claim in one descriptor transition. Cancellation ends the current attempt; it does not revoke the deletion authorization the user already confirmed or undo bytes already removed. If rollback succeeds before removal, clear its barriers and descriptor and leave the raw bytes intact. If rollback or cleanup fails, retain the same prepared descriptor and frozen authorized set without granting retry merely because cancel was requested. The live owning operation may finish its own cleanup; another explicit Retry or automatic recovery cannot take over a live or uncertain owner. Positive death proof for the recorded owner permits recovery against exactly the already authorized targets, with the ordinary producer-stop and deletion proofs. Successful finalization clears required fences and guards and removes the captured descriptor last under the coordinator. Cleanup failure preserves discoverable authority. Original frozen targets and producer-stop proofs remain mandatory on every retry.

The implementation and its verification are not certified by this proposed ADR. Independent source review and real multi-window/runtime checks are separate gates.

### Consequences

- Positive: a single durable authority coordinates recovery and session creation without a second guard/lease file or a long-held lock; an abandoned partial can be retried without stealing a live operation.
- Negative: extra serialized descriptor transitions and exact owner-generation checks; unknown liveness, an orphaned coordinator lock, or missing handoff can defer deletion until safe recovery is possible.
- Negative: an early implementation that checks only a local token, a stale stopped-process boolean, or the original owner while ignoring the current executor is not compliant with this decision, even if single-process tests pass.

## Related Documents

- [Raw session recorder design](../designs/2026-09-24-raw-session-recorder.md)
- [ADR-0007: Native file evidence with guarded restore](0007-native-file-evidence-and-guarded-restore.md)
- [Architecture](../architecture.md)

## Architecture Review

- Reviewer: independent architect
- Outcome: accepted as a document after corrective re-review; no remaining material findings.
- Notes: First review found F1 (expiry must not acquire session-wide creation exclusion) and F2 (cancellation after failed cleanup needed a defined recovery outcome). Both were corrected at lines 23 and 27 and accepted on SHA-256 `89dec5d071acd728e5437a007dc1f7029f1b1c3e3b54528b862921a7c15b2f66`. This reviews the decision, not the implementation or runtime behavior.
