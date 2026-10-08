---
status: superseded
date: 2026-09-28
---

# Explicit release of an unidentified launch attempt's stale ownership

> Superseded by [ADR-0039](../decisions/0039-refuse-only-on-a-verified-live-writer-the-extension-owns.md). The explicit-release command, state and ceremony are removed. This document preserves historical rationale/reviews, not current operations; uncertainty permits ordinary actions immediately.

> Amended by [ADR-0038](../decisions/0038-host-chat-over-rpc-ui-on-a-broker-pipe-child.md) and its [RPC-UI chat and Sessions design](2026-09-29-rpc-ui-chat-and-sessions.md): witness checks use broker and kernel identity only; there is no room registry.

> **Amended by the accepted [ADR-0036](../decisions/0036-release-an-unresolvable-launch-attempt-explicitly.md), which
> current source implements:** the release no longer stops at an *unidentified* attempt. Eligibility now admits any
> recorded attempt whose row reads `owner-unknown` (as well as one missing `pid` or `instanceId`); a materialized
> session file is not required (a reserved draft identity suffices); the target check uses the recorded session id
> first and the file header as its fallback, rather than the exact file's own id alone; and a **missing** broker
> record — which the check section below still describes as `unknown` — is now the one accepted uncertainty, a
> distinct `missing` result disclosed to the user instead of a refusal. Every other part of this design, including
> the explicit-only mechanism, the attempt binding and the refusals for a registered instance, a registry row at the
> recorded pid, a live managed child and unreadable provenance, remains in force as written.

## Problem

A user's row (a materialized transcript) became
permanently unusable after an interrupted launch. Its durable record is the state
`SessionIndex.#openEntry` writes *before* the launcher runs when a window died in between: a launch
attempt with **no process identity at all** — `host.pid`, `host.instanceId` and `host.generation` all
`null`, `host.startedAt` recorded, `host.sessionId` set from the row — plus the claim that attempt
was made under, whose holder is now dead. The file was modified 32 s after the marker, so a native
process may well have started and appended.

Every path refuses that row, and correctly so under the current rule: `reconcileOwner`
(`src/host/native-terminal.ts`) answers `unknown` for `recordedPid === null`, so
`classifySessionAvailability` yields `owner-unknown`, `#openEntry` reports a conflict instead of
launching, `decideSessionDeletion` refuses without accepted absence evidence, and `SessionIndex.remove`
refuses because the row's own stale claim still stands. There is no user action anywhere in the
extension that can clear this state: the row is *permanently* blocked until the process identity of
a process this window never observed is somehow proven gone, which nothing can do.

The user has now decided the policy: **absence of a positive live witness must not mean "impossible"
forever. It permits an *explicit* recovery that discloses the residual risk truthfully.** This is a
deliberate narrowing of the earlier "a roomless or identity-less launch is never declared absent"
rule ([ADR-0011](../decisions/0011-use-installed-omp-without-version-gate.md),
[ADR-0018](../decisions/0018-resume-imported-history-under-extension-claims.md),
[ADR-0027](../decisions/0027-delete-discovered-history-under-exclusive-extension-claim.md),
[ADR-0031](../decisions/0031-reattach-a-surviving-managed-host-through-its-broker.md)) for exactly one
case — an *unidentified* attempt — and only through one explicit action. The choice itself is recorded
in [ADR-0033](../decisions/0033-release-stale-ownership-of-an-unidentified-launch-explicitly.md).

## Goals and Non-goals

- Goals:
  - One explicit, user-facing action releases the stale ownership of an unidentified attempt: same
    row, exact file, current claim authority rechecked under the tab's lifecycle, whether the row's
    durable intent is `running` or `stopped`.
  - That action refuses when it finds positive evidence of a live writer: a matching live Collab
    session for the exact session id and header directory, a live managed child still owned by the
    row's recorded broker slot, a live rival extension claim holder, or a malformed/unreadable
    provenance or registry. A failed or ambiguous check is a *failed check*, never a free session.
  - After a completed release the row behaves like any other user-stopped row: Open, Resume, Forget
    and Delete are available again, and each admitted action that touches the file re-derives live
    ownership from scratch under its own authority (Open/Resume and Delete take their own canonical
    claims and re-run the same check; Forget only drops the row, which it may do once this row's
    claim is gone).
  - Nothing is ever started, stopped, killed or deleted *by the release itself*, and no activation or
    editor restore may ever launch a released row. The release records what it is, in words, without
    claiming a process was stopped or that no writer exists.
  - An interrupted release is recognizable and repeatable, and the state is escapable in all cases.
- Non-goals:
  - No widening to *other* unknown owners: a roomless launch that recorded a pid, a live host of
    another window, a claim of another owner generation, a client-side uncertainty or an unreadable
    registry all keep today's refusals.
  - No new global conflict ledger, no automatic migration, no auto-launch, no ownership policy change
    for Close/process replacement or for native conversation transfer.
  - No touching of any process other than by the extension's own existing launch/attach paths, and no
    change to what a normal Open/Resume/Delete/Forget does after a release beyond the fresh
    live-target recheck the deletion transaction gains below.

## Current State

- `src/host/session-index.ts` owns the durable row (`SessionIndexEntry`: `host`, `ownership`,
  `runIntent`, `availability`), the owner-absence vocabulary (`OwnerAbsenceEvidence`,
  `acceptOwnerAbsenceEvidence`, `absenceEvidenceForRecordedHost`), the pure classifier
  `classifySessionAvailability`, and the admitted open path `#openEntry` (which acquires the
  canonical claim *before* it reconciles, records the identity-less attempt before launching, and
  keeps that attempt — and the claim — when a launch outcome is unconfirmed). `#reportStoppedEntry`
  re-derives a stopped row's availability without taking a claim, launching or attaching.
  `remove` refuses while a claim this row acquired still stands (`#claimGuardingRemoval`).
- `src/host/native-terminal.ts` implements `createOwnerReconciler`/`reconcileOwner` over explicit
  ports (`resolveExecutable`, `listHosts`, `brokerSlot`, `probeBroker`, `findTerminal`), the legacy
  terminal attach, the broker attach, and the read-only broker probe `probeManagedBrokerHost`.
- `src/host/session-lifecycle.ts` decides deletion (`decideSessionDeletion`) and runs the deletion
  transaction: it gathers facts and decides **before** it acquires the deletion claim, then
  `revalidateFrozenTarget` re-checks the file, header, profile and the presence of *some* claim
  before removing anything. It does not reconcile the writer again under that claim.
- `src/extension.ts` registers the row commands, wires the reconciler ports, keeps a per-tab last
  restore outcome that a row's presentation prefers over its stored availability, and serializes
  opens per tab; `src/views/session-tree.ts` projects a row's state and its `ompSession.*` menu tokens;
  `package.json` gates the context menus on those tokens.
- Tests pin the current refusals: `session-index.test.ts` (the interrupted-attempt fixture at
  ~1849-1898, `acceptOwnerAbsenceEvidence`), `session-tree.test.ts` (blocked-row projection),
  `native-terminal.test.ts` (roomless launch retention).

## Proposed Design

### 1. The durable release record

The row gains one optional field, recorded only by the release:

```ts
export interface RecordedRetirement {
	/** `host.startedAt` of the attempt this release authorized. */
	readonly attemptStartedAt: string;
	/** OMP session id that attempt recorded, or `null`. */
	readonly sessionId: string | null;
	readonly releasedAt: string;
	/** `true` only after the release finished: no claim of this attempt stands. */
	readonly claimReleased: boolean;
}
```

`SessionIndexEntry.retirement: RecordedRetirement | null`. It is an *authorization record*, not
proof: it says "the user explicitly released this exact attempt after a fresh best-effort check".
It preserves the attempt itself (`entry.host` stays as provenance, which is also what keeps later
passes on the reconciling path), and it is matched by the exact attempt tuple (`attemptStartedAt` +
`sessionId`), so it can never authorize a successor attempt. It is cleared when the row records a
new attempt or a new host.

**It deliberately leaves `ownership.releasedAt` untouched.** That field means "the claim was released
after a confirmed stop", and the generic `claim-released` evidence is accepted from the timestamp and
the host's start time alone; writing it here would hand a risk-authorized release the confirmed-stop
evidence semantics. The release is recorded only in `retirement`.

`claimReleased` is a *completion* fact, not an intention: it stays `false` until the claim removal
actually succeeded (see §2), so a crash at any boundary leaves a state the action can safely repeat.

The unidentified attempt itself is named by one exported predicate so every layer agrees on the shape:

```ts
export function isUnidentifiedLaunchAttempt(host: RecordedHost | null): boolean;
// host !== null && host.pid === null && host.instanceId === null && host.generation === null
```

### 2. One explicit action: `SessionIndex.releaseStaleOwnership`

It runs under `withinTabLifecycle` and in this order:

1. Re-read the row. Refuse a tab this window runs (`#live`), a row that is not a materialized
   unidentified attempt, a row whose durable intent or availability is missing a checkable session
   identity, and a row whose release already *completed* (`retirement !== null &&
   retirement.claimReleased`). A row with a matching `retirement` that is still `claimReleased:
   false` is **retryable**, not refused, and a row whose attempt or session id changed since the
   recorded release is refused as a changed target.
2. Read the canonical claim of the row's exact identity (file). Refuse an unreadable claim record, a
   claim of another owner generation, and a live rival holder of this generation. Take the identity's
   own claim under its lock: adopt an existing same-owner claim with `adoptExistingClaim` (which
   refuses a rival live holder and a foreign generation), or publish one with `acquireClaim` when the
   canonical claim is *currently absent* — a row that recorded none, and a retry whose previous run
   already removed it. The branch is decided from the claim's presence now, never from what the row
   recorded earlier. The claim is held throughout the check and the commit. A retry re-checks the
   holder and generation here exactly as a first attempt does.
3. **While holding that claim**, ask the reconciler for an explicit-recovery verdict
   (`OwnerReconcileRequest.explicitRecovery: true`, §3), which runs the fresh target check. Only
   `free` carrying the evidence item of §3 for this exact attempt authorizes the release; `live` and
   `unknown` refuse with their own bounded detail, and only a claim *this call* published is given
   back — an adopted reservation stays exactly where it is.
4. Persist, while the claim is still held: `entry.retirement = { attemptStartedAt, sessionId,
   releasedAt: now, claimReleased: false }`, `entry.runIntent = "stopped"`, the row's availability
   and a bounded `entry.detail`. A failed write rolls the in-memory change back, gives the claim
   back only if this call published it, and reports the failure — a failed persistence must never
   leave a startable row.
5. Release the claim. On success (or when the claim was already gone because a previous retry had
   released it), persist `claimReleased: true` and report
   "No matching live session was found, so this row's ownership reservation was released. No process
   was stopped and no session was started." A release that fails leaves `claimReleased: false` and
   reports that the reservation is still held, so the action can be run again; a claim this owner no
   longer holds counts as released. If *this* completion write fails, the row is left with
   `claimReleased: false` and the truth — the reservation was released but recording it failed — and
   the next run republishes a claim for the duration, re-runs the check, releases it again and
   records the completion, which is why that boundary needs no separate recovery path.
6. Do not open, attach, delete or start anything.

**Every refusal keeps the row's own reservation.** The claim this action adopts is *kept* when the
check refuses, when provenance is unreadable, and when the first persistence fails — releasing it
would erase the reservation an unresolved writer may still hold, which is the opposite of what a
refusal means. Only a temporary claim this action published itself (because the canonical claim was
currently absent) is given back on those paths. `adoptExistingClaim` rewrites the adopted record to name this window's
holder lease exactly as a failed draft reattach does; the reservation itself stays.

### 3. Reconciliation: explicit eligibility, then post-release authorization

The reconciler keeps its current answers for every case except an *unidentified* attempt. Those two
questions are deliberately separate:

- **Eligibility for the check** — the check may run only when either the row carries a `retirement`
  for this exact attempt, or the caller is the release action itself (`explicitRecovery: true`). A
  `running`-intent interrupted attempt is therefore checkable by the release action; the action does
  not need a persisted release to obtain its answer, and the answer it obtains does not make the row
  startable. The action validates the answer itself, against the same attempt tuple it read from the
  row's recorded host, because the release it is about to write does not exist yet.
- **Emission for a released row** — the evidence item is emitted for an automatic caller only while
  the row's durable intent is `stopped` (the release writes that intent together with the record), so
  a row whose intent says "run" stays `owner-unknown` in an automatic pass even if a release exists.
  An automatic pass may therefore *report* a released row (`#reportStoppedEntry` classifies it and
  starts nothing), but it can never launch or attach one: launching is the existing stopped-intent
  admission rule, which only an explicit Open/Resume overrides.
- **Acceptance** — the index accepts the item only together with the `retirement` for the same
  attempt (§1), so the item alone authorizes nothing.

When the check runs, it is fresh on every pass — never cached, never inherited — and answers:

1. no recorded session id, no session file, or a file whose own header does not carry that session id
   → `unknown` (ambiguous target);
2. a registry row publishing that exact session id (and, when the header carries a directory, the
   same normalized directory) → `live`;
3. otherwise the row's broker provenance is consulted (§6): a verified running managed child → `live`,
   unreadable or malformed provenance or a probe that cannot answer → `unknown`, no recorded slot →
   continue;
4. otherwise `free` carrying

```ts
| {
    readonly kind: "released-unidentified-attempt";
    readonly attemptStartedAt: string;
    readonly sessionId: string;
  }
```

`acceptOwnerAbsenceEvidence` accepts that item only when the subject's recorded host is the same
unidentified attempt (matching `startedAt` and `sessionId`) **and** the subject carries a `retirement`
for that same attempt. One shared helper derives the tuple, so the reconciler's emission, the release
action's matching, and the index's re-validation cannot disagree. Because it is the only item that is
an authorization rather than an observation, it is the only one that names a durable record; the
generic `claim-released` item keeps its confirmed-stop meaning and cannot be satisfied by a release.

### 4. Row command, menus and wording

- `sessionItemState` gains one state, `"stale"` (label "Stale reservation", warning icon), decided
  **before** the generic blocked branch *and before* the cached restore outcome, so a previously
  recorded conflict cannot hide it: a row is `stale` when it is a materialized session, is not the
  row this window runs, is not `failed`, has an unidentified attempt, and its release is absent or
  unfinished (`retirement === null || !retirement.claimReleased`).
- That row's own command and its one context-menu contribution are the new
  `omp.releaseStaleOwnership` ("Release Stale Session Ownership"); Open/Resume/Forget/Delete/Rename
  are **not** contributed for it, because an attempt with no durable release authorization yet
  refuses them, and a menu that can only refuse is not truthful. A row whose release was *recorded*
  but not finished keeps the same menu as a presentation choice: its later Open, Resume or Delete is
  already admitted, subject to its own current claim authority and fresh checks, but the release
  action is the one that also clears the reservation itself.
- The command shows one modal confirmation **before** it checks anything, worded prospectively with
  the bounded risk: OMP will be checked for a live session with this file's id; if one is found
  nothing is released; if none is found this row's ownership reservation is released and the row
  becomes stopped; nothing is started or stopped; a previous process that publishes no Collab room
  cannot be seen by that check, may still be running and may still be writing this file, and a
  native or external writer can enter afterwards — resuming or deleting later could then lose or
  overwrite history. No lifecycle lock is held while the dialog is open. On success the command
  clears this tab's cached restore outcome (the obsolete conflict a release supersedes),
  refreshes the launcher, and shows the §2 message.
- After a completed release the row is an ordinary `stopped` row (`availability: "saved"`, intent
  stopped) and every ordinary contribution applies. Its tooltip must not claim the process exited:
  for a released row it states that the reservation was released by an explicit action, that the
  earlier process was not verified stopped, and that it may still be writing this file.

### 5. What each later action does

- **Open / Resume**: the explicit `SessionIndex.restore` path (`resumeStopped`) reconciles the
  released attempt freshly (§3) while holding its own new claim; `free` → the normal launch, which
  records a new attempt and clears `retirement`; `live`/`unknown` → the normal conflict.
- **Delete**: the transaction gains a **fresh reconcile under the deletion's own held claim**,
  immediately before destructive I/O: `revalidateFrozenTarget` must additionally validate that the
  observed claim is this deletion's own — its holder lease is this window's, and its generation is the
  row's recorded one, accepted only as *this operation's* authority `claimIsThisDeletions` (the
  confirmation's preflight keeps the stricter foreign-generation refusal, so a claim this window holds
  for another purpose, such as an in-flight Resume of a discovered file, still refuses) — then re-run
  the reconciler for the frozen target and re-apply `decideSessionDeletion` with the fresh verdict and
  that claim. A writer that appeared between the confirmation preflight and the
  claim acquisition, or a released attempt whose session is publishing again, then refuses the
  removal before any file is touched. Target freezing, artifact/backup handling, the exclusive claim
  held through finalization and partial-failure recovery are unchanged.
- **Delete wording**: when the accepted evidence is the release item, the decision detail and the
  confirmation notes must say that the deletion is authorized by the user's explicit release, that no
  matching live witness was found but that this is *not* proof no writer exists, and that a
  roomless/unidentified process or a native/external command may still be writing the file — never
  "no extension writer is alive" or "proof that no writer is alive".
- **Forget**: the completed release leaves no claim to guard, so `SessionIndex.remove` drops the row
  and leaves the file and transcript in place, exactly as before. Forget acquires no claim and runs no
  reconciliation, because it neither reads nor writes the transcript.
- **Close/Reload** are never offered for a `stale` row (it has no runtime), and a released row's Close
  behaves like a stopped row's.

### 6. Broker provenance, without turning unknown metadata into absence

The release check needs a provenance answer that the current `brokerSlot(request): string | null`
port cannot give, because the durable slot table drops malformed entries and reports the result as
"no slot". The reconciler therefore gains a recovery-facing port whose answer is a bounded category:

- `none` — this row recorded no broker slot. That is **not** proof that nothing was launched (a legacy
  hidden-terminal launch records none, and a window that died may not have got that far); the check
  continues on the registry result alone.
- `unreadable` — the durable table or the row's mapping could not be read as recorded provenance →
  `unknown` (refuse).
- `slot(slot)` — a slot is recorded: probe it read-only for a running managed child
  (`probeBrokerSlotForRunningChild`: `readRecord`, then `attach` with no owner hint, disconnect in
  `finally`, never launch, never adopt, never take over): verified running managed child → `live`;
  authenticated non-running child or a non-managed slot → continue; unreadable record, no
  authentication, a running child without a process id, or a missing state → `unknown`.

### 7. Truthful wording inventory

Every surface that describes a released row or its deletion must match what was actually
established; the concrete edits are part of this design:

- the release confirmation (prospective, §4) and its success message ("No matching live session was
  found…" rather than "no writer is alive");
- the stopped-row tooltip for a row with a `retirement`;
- the deletion decision detail and confirmation notes for release-authorized evidence;
- the extension's deletion modal line that currently reads "Proof that no writer is alive", which
  gains the release-authorized variant.

## Alternatives

- **One-click Open/Resume/Delete that also releases** (fold the release into each command). Rejected:
  it would lose the single-effect separation this design relies on — the risk authorization would
  become part of a launch or a deletion, so the release's own refusal and its partial outcome would
  have to be reported from inside that operation, and Delete would have to disclose the release before
  its own confirmation rather than as its own audited step.
- **Treat "no live writer found" as permission for any unresolved owner.** Rejected: it converts a
  failed or absent observation into permission, and would unlock the roomless-pid, foreign-generation
  and unreadable-registry cases ADR-0011/ADR-0018/ADR-0031 deliberately keep closed.
- **Treat a live matching process id as attachable permission.** Rejected: liveness is neither the
  transport nor the process generation an attach must prove (ADR-0031), and current claim,
  registry-failure and identity checks are independent gates precisely so no single one can pass a
  writer.
- **Clear the recorded host so the `no-recorded-host` fast path applies.** Rejected: that path skips
  the live-target check entirely, so a roomless-but-live writer would become resumable with no check
  at all, and the row would lose the provenance the refusal explanations state.
- **Delete the claim file directly.** Rejected: it bypasses the identity mutex and the holder rules
  that make an extension-side takeover safe, so a rival window's live reservation could be broken.
- **Report the release as a confirmed stop** (`closeSession(confirmedStopped: true)`). Rejected: its
  claim release is legitimate, but `confirmedStopped: true` would fabricate the "a native process was
  observed stopping" premise for every confirmed-stop consumer.
- **Remember the release's negative result as authorization for later actions.** Rejected: a room that
  appears after the release must block the later Open, Resume or Delete, so each of those re-runs the
  check under its own claim (Forget removes no transcript and keeps its own claim guard).
- **Keep the permanent block.** Rejected by the user's decision.

## Risks and Open Questions

- Accepted residual risk (user policy): an already-running writer that publishes no Collab room can
  survive the check, and a native or external writer can start immediately afterwards. The check is an
  observation, not an occupancy lock; every surface says so in words and the release never claims the
  process is gone.
- Cost: one registry read plus at most one read-only broker attach per release and per admitted
  action that touches the file. Nothing is cached for authorizing decisions: an unchanged attempt
  tuple does not mean an unchanged live-host set.
- An unfinished release leaves the row presented as `stale` — a presentation choice, not a statement
  that its later actions are refused: Open, Resume and Delete are already admitted for it, each
  subject to its own current claim authority and fresh check, and the release action is what finishes
  the removal. Forget is refused until the claim is gone.
- `releasedAt` keeps its confirmed-stop meaning and is never written by this release; `retirement` is
  the only record added. If a later feature needs one place for release reasons, `retirement` is the
  migration point.

## Rollout and Verification

Source order: `retirement` + `isUnidentifiedLaunchAttempt` + the evidence item and its acceptance +
`releaseStaleOwnership` in `session-index.ts`; the unidentified-attempt branch, the provenance port and
`probeBrokerSlotForRunningChild` in `native-terminal.ts`; the post-acquisition reconcile and the
release-authorized wording in `session-lifecycle.ts`; wiring, the command, the modal and the cleared
outcome in `extension.ts`; the `stale` state, tokens and tooltip in `session-tree.ts` and
`package.json`; focused tests in the four matching suites.

Verification is behavioral: the interrupted-attempt fixture is re-pointed to the new policy (startup
still launches nothing and keeps the claim; the release refuses on a matching live host, a live broker
child, unreadable provenance, a registry failure and a rival holder; the release succeeds when the
check is clear, for both `running` and `stopped` intents; an interrupted release is retryable;
Open/Resume/Delete then work and each refuses again the moment a matching live witness appears,
including one that appears between a deletion's preflight and its claim acquisition); the tree
projects `stale` ahead of a cached conflict and offers exactly one contribution; acceptance refuses
the new item without a matching release and the generic `claim-released` item is unaffected; and the
reconciliation unit tests cover every refusal branch. A separate isolated installed-profile run then
exercises the real fixture.

## Related Decisions

- [ADR-0033](../decisions/0033-release-stale-ownership-of-an-unidentified-launch-explicitly.md) — the
  decision this design implements.
- [ADR-0011](../decisions/0011-use-installed-omp-without-version-gate.md) as incorporated by
  [ADR-0018](../decisions/0018-resume-imported-history-under-extension-claims.md) — the retained
  unaccounted-launch rule this narrows for one attempt.
- [ADR-0027](../decisions/0027-delete-discovered-history-under-exclusive-extension-claim.md) —
  deletion's evidence requirement and its claim-held transaction, which this design strengthens with a
  fresh post-acquisition reconcile.
- [ADR-0031](../decisions/0031-reattach-a-surviving-managed-host-through-its-broker.md) — the broker
  probe this check reuses; a proven live target still never falls back, and missing metadata is never
  proof.
- [ADR-0017](../decisions/0017-never-forward-capability-bearing-error-text.md) — every new reason is
  bounded text this extension authored.
- [ADR-0024](../decisions/0024-own-omp-pty-for-in-tab-terminal.md),
  [ADR-0029](../decisions/0029-report-uncontained-pty-tree-stop-as-unknown.md) — nothing here stops or
  replaces a writer.

## Architecture Review

- Reviewer: architect
- Outcome: rejected in rounds 1–3 (every finding applied); round 3 left four wording corrections that
  this revision applies — awaiting a fourth confirmation pass.
- Notes: Round 1 required D1 (separate explicit-release eligibility from post-release authorization so
  a `running`-intent attempt is recoverable), D2 (a pending/completed release protocol with idempotent
  retry at every persistence/claim-removal boundary and UI reachability for an unfinished release),
  D3 (a fresh reconcile plus exact held-claim validation inside the deletion transaction), D4 (leave
  `ownership.releasedAt` untouched and prove the legacy `claim-released` item cannot be satisfied by a
  release), D5 (clear the obsolete cached restore outcome; test the whole startup-conflict → release →
  stopped sequence), D6 (prospective and truthful wording on the release, deletion and row surfaces),
  D7 (no caching of authorizing checks) and D8 (a broker-provenance category that distinguishes absent
  from malformed provenance). Round 2 confirmed D3–D8 resolved and added: D9 (a refusal must keep the
  row's *own* adopted reservation; only a temporary claim this call published is given back — see §2),
  D1/D2 wording corrections (§2, §3, §4 and the Risks), and one ADR/design mismatch about Forget that
  is now stated identically in both documents. Round 3 confirmed D1–D8 (including the corrected
  bootstrap wording) and made four further corrections, all applied here: the numbered §2 steps now
  say an *adopted* reservation is kept on every refusal (the D9 blocker), the acquisition branch is
  stated as the claim's current absence, the two remaining universal statements about later actions
  were qualified to Open/Resume/Delete (Forget keeps its own claim guard), and the "two dialogs"
  characterization of folding the release into each command was replaced with the single-effect and
  reporting rationale the ADR records. Round 4 then accepted the ADR and accepted this design with two
  minor wording items, both applied: the explanatory parenthesis now ties temporary claim publication
  to the claim's current absence, and the summary below is normative rather than a completion claim.
  The implementation must follow these requirements and be verified through the scenarios listed under
  Rollout and Verification.
