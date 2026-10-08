---
status: superseded
date: 2026-09-28
---

# ADR-0033: Release an unidentified launch attempt's stale ownership only through an explicit user action

> Superseded by [ADR-0039](0039-refuse-only-on-a-verified-live-writer-the-extension-owns.md). Explicit ownership release and its command/state are removed; uncertainty immediately permits ordinary actions. The original rationale and reviews below are historical, not current product instructions.

> Amended by [ADR-0038](0038-host-chat-over-rpc-ui-on-a-broker-pipe-child.md): fresh positive-witness checks for the explicit release use broker and kernel identity only; the Collab room registry is no longer a witness source.

> **Amendment accepted in [ADR-0036](0036-release-an-unresolvable-launch-attempt-explicitly.md):** that decision
> narrowly supersedes four clauses of this record — eligibility limited to attempts with no process identity; the
> requirement for a materialized row/session file (a reserved draft identity suffices); the exact-file-only target
> check (recorded session id first, then file-header fallback, with no matchable identity for a fileless attempt);
> and refusal when the recorded broker record is missing, which applies only to this explicit path and treats a
> missing record as disclosed uncertainty, never as `idle`. Every other accepted clause remains in force exactly as
> written, and an existing broker record that proves a different slot, kind or child still refuses.

## Context and Problem Statement

A launch attempt this extension records before asking the launcher to run may carry no process
identity at all: the process id, Collab host identity and room generation are all empty, because the
window died between recording the attempt and learning what the launcher started. The current policy
treats such an attempt as unreconcilable — the death of a process that matched no room "proves nothing
about what it may have left behind" — so reconciliation answers *unknown* however the row is later
inspected. Nothing in the extension can clear that state, and one user's real transcript is
permanently locked out of Open, Resume, Forget and Delete as a result (row
`tab:c9ea3aa9-117e-4415-8a3d-843e2e3c5ddf`; marker recorded 2026-09-27T19:14:58Z with every identity
field null; the file was modified 32 s later; its claim holder PID 252112 is dead; no Collab host
publishes that session).

The user has decided that the absence of positive evidence must not make the state permanently
irrecoverable. Their policy: the extension does a best-effort check, refuses only what it can
confidently establish as a duplicate writer, and where no positive live witness exists it permits an
**explicit** recovery that discloses the residual risk instead of pretending proof exists. A choice
is needed about how far that permission reaches, what must be ruled out first, and what may never be
claimed about the outcome. The mechanisms that implement it are specified separately in the
[companion design](../designs/2026-09-28-explicit-recovery-of-an-unidentified-launch.md).

## Considered Options

- **One explicit, single-effect release, then the ordinary paths.** The user releases this
  extension's reservation for that exact attempt; Open, Resume and Delete afterwards are the ordinary
  admitted actions and re-run the same live check under their own authority, while Forget is the
  ordinary claim-guarded removal of the launcher row (it neither reads nor writes the transcript).
  Advantages: one action with one explanation; nothing is launched, stopped or deleted by the
  release; the release is the only thing that authorizes the exception, and an automatic pass may
  reclassify a released row but can never perform the release or launch/attach it; every later action
  that touches the file re-derives ownership from scratch. Disadvantages: two user actions to resume
  a stale row; one new durable record, one new row presentation and one new evidence item.
- **Broad negative authorization: treat "no live writer found" (or a live matching process id) as
  permission to act, for any unresolved owner.** Rejected: the first half turns a failed or absent
  observation into permission and would unlock the roomless-pid, foreign-generation and
  unreadable-registry cases that ADR-0011/ADR-0018/ADR-0031 keep closed; the second half adopts a
  writer on liveness alone, which is neither a transport nor a process generation. Both are wider
  than the policy the user set.
- **Treat the attempt as free by clearing its recorded host.** Rejected: the no-recorded-host path
  skips the live-target check entirely, so a roomless but live writer would become resumable with no
  check at all, and the provenance the refusal explanations depend on would be destroyed.
- **Delete the claim file directly.** Rejected: it bypasses the identity mutex and the holder rules
  that make an extension-side takeover safe, so a rival window's live reservation could be broken.
- **Report the release as a confirmed stop.** Rejected: it fabricates the premise of every
  confirmed-stop consumer (absence evidence, "the process exited" wording) for a process nobody
  observed ending.
- **Fold the release into each of Open/Resume/Delete.** Rejected: it would lose the single-effect
  separation this decision relies on — the risk authorization would become part of a launch or a
  deletion, so its own refusal and its own partial outcome would have to be reported from inside that
  operation, and Delete would have to disclose the release before its own confirmation rather than as
  its own audited step. It is a legitimate competing policy, not a broken one: the existing commands
  carry their own independent guards, and the release would still refuse a live writer.
- **Keep the permanent block.** Rejected by the user's decision.

## Decision Outcome

This decision creates **one narrow, explicitly user-authorized exception** to retaining an
unaccounted extension launch. An attempt whose recorded process id, Collab host identity and room
generation are all null — and only such an attempt, and only on a materialized row — may have this
extension's reservation released by one explicit user action. The action must, before it releases
anything:

- take this extension's canonical claim for the exact file under its normal holder rules, refusing a
  foreign owner generation and a live rival holder, and hold it throughout;
- perform a **fresh best-effort check of the exact target**: the file's own header must identify the
  session the attempt recorded, and a Collab session publishing that exact session id, or a running
  managed child still owned by the row's recorded broker slot, refuses the release. A read that fails,
  an ambiguous target, a missing broker record or an unreadable slot is a **failed check**, which
  never authorizes recovery;
- record, durably and before releasing the claim, what the release is: an explicit release of that
  exact attempt, together with a durable stopped intent;
- release only the claim it holds, then report that a reservation was released, that no process was
  stopped and that no session was started.

**No release ever establishes absence or termination.** The authorization is bound to the exact
attempt it names and is cleared by a new attempt, so it can never authorize a successor writer. A
later Open, Resume or Delete re-derives live ownership and re-runs the live-target check under its own
authority — never a remembered negative result — and a deletion additionally re-validates the live
target under the exclusive claim it holds before it removes anything. Forget is the ordinary
claim-guarded removal of the launcher row: it acquires no claim and runs no reconciliation, because it
neither reads nor writes the transcript, and after a completed release this row's claim is gone, so
it behaves exactly as it does for any other stopped row.

**Automatic passes may re-derive a released row but must never launch or attach it.** Activation, an
editor restore and a startup pass re-classify a released row only to report it; the prohibition on
starting it is the existing stopped-intent admission rule, which only an explicit Open/Resume
overrides — not the mere existence of the release record.

**Wording must stay truthful wherever a released row or its deletion is presented**: a process that
publishes no Collab room may still be running and may still be writing this file, another native or
external writer can enter after the check, and resuming or deleting later can therefore lose or
overwrite history. No surface may describe the release as a confirmed stop, as proof that no writer
exists, or as "no extension writer is alive".

This narrows, for this exact case only:

- ADR-0011's rule that such a launch is never declared absent, as incorporated by ADR-0018, and
- ADR-0027's refusal to delete an uncertain known writer.

It does **not** change anything else. ADR-0027's exact-file serialization, exclusive claim held
through finalization, target validation, deletion scope and partial-failure recovery remain
mandatory, and deletion still requires live-target revalidation under its own held claim before any
file is touched (the companion design states the required change; the current transaction does not
yet re-reconcile after it takes its claim). ADR-0031's identified-survivor transport proof, its
no-fallback rule and its stopped-intent admission remain unchanged; absent or missing broker metadata
is never proof of absence. Every other unknown owner keeps its existing refusal: a roomless launch
that recorded a process id, an alive process with no room, a foreign claim generation, a live rival
holder, an unreadable registry and an ambiguous target all still refuse.

### Consequences

- Positive: a permanently blocked real transcript has one truthful, retryable way out; the user sees
  the residual risk in words; nothing is started, stopped or deleted by the release; every later Open,
  Resume or Delete re-runs the same check, so nothing inherits a stale negative observation (Forget
  drops only the launcher row and keeps its own claim guard).
- Positive: the authorization is scoped to one attempt tuple, is durable, and is recognizable when the
  release itself is interrupted, so the state is neither permanent nor silently reusable.
- Negative: freeing a stale reservation can allow a second writer when the earlier process is alive
  but publishes no Collab room, and a writer can appear immediately after the check. That is the
  disclosed, user-accepted residual risk of this policy; the check is an observation, not an
  occupancy lock.
- Negative: the extension must carry a release record across the index, reconciliation, deletion,
  the row presentation and their tests, and every user-facing sentence about a released row must stay
  distinguishable from a confirmed stop.

## Related Documents

- [Design: explicit release of an unidentified launch attempt](../designs/2026-09-28-explicit-recovery-of-an-unidentified-launch.md)
  — the proposed companion design with the components, data flow, refusal branches, wording and
  verification this decision requires.
- [ADR-0011](0011-use-installed-omp-without-version-gate.md) — its retained unconfirmed-ownership
  rule and repair R1 are narrowed for an unidentified attempt only, and only through the explicit
  action above; its extension-scoped exclusion and the roomless-pid rule remain.
- [ADR-0018](0018-resume-imported-history-under-extension-claims.md) — retains uncertainty for an
  unaccounted extension launch; narrowed in the same narrow way, with its exact-file interactive
  Resume and extension-scoped writer exclusion intact.
- [ADR-0027](0027-delete-discovered-history-under-exclusive-extension-claim.md) — its
  uncertain-known-writer deletion refusal is narrowed for a released unidentified attempt; every
  other deletion requirement is unchanged and still mandatory.
- [ADR-0031](0031-reattach-a-surviving-managed-host-through-its-broker.md) — unchanged: a proved
  broker pin still selects the only transport, a missing record is uncertainty, and a proven target
  never falls back.
- [ADR-0017](0017-never-forward-capability-bearing-error-text.md) — every reason the design adds is
  bounded text this extension authored.

## Architecture Review

- Reviewer: architect
- Outcome: **accepted** in round 4, after rounds 1–3 rejected it and every finding was applied.
- Notes: Round 1 accepted the core choice and the narrow scope but rejected the record as written: the
  supersession boundary had to name ADR-0011 as incorporated by ADR-0018 and ADR-0027's
  uncertain-writer refusal; the record had to stop doubling as the implementation design; the claim
  that deletion already re-reconciles under its own claim was factually wrong and had to become a
  normative requirement; the truthful-wording requirement had to cover the row presentation and the
  deletion confirmation, not only the release notification; the release must not populate the
  confirmed-stop release field or satisfy legacy confirmed-stop evidence; the rejected alternatives
  had to be characterized against the code as it is; and automatic passes had to be described as
  allowed to reclassify (but never launch) a released row. Round 2 confirmed those resolved and left
  three textual corrections — the "two destructive dialogs" characterization of the integrated
  alternative, the phrase claiming an automatic pass cannot use the release, and an over-broad claim
  that Forget also re-runs the live-target check. Round 3 confirmed those and found one remaining
  universal statement here (the Consequences line about "every later action", now qualified to Open,
  Resume and Delete); that correction is applied in this revision, together with the companion
  design's remaining wording items.
