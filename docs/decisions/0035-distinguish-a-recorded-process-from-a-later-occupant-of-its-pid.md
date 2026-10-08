---
status: accepted
date: 2026-09-29
---

# ADR-0035: Treat a recorded process as gone only across a reboot, from the kernel creation time of its pid's occupant

> Ownership clauses narrowed by [ADR-0039](0039-refuse-only-on-a-verified-live-writer-the-extension-owns.md): reboot/absence and roomless-retention rules do not gate user actions, and explicit release is removed. PID ambiguity/reuse is unowned; accepted absence evidence still gates automatic relaunch only.

> Narrowly superseded by [ADR-0038](0038-host-chat-over-rpc-ui-on-a-broker-pipe-child.md) for the room clause: rows that record a child's kernel creation time are matched by that identity (no room needed), and the reboot/creation-time discriminator here applies only to legacy rows that recorded a pid without one. A roomless legacy launch still gets no automatic absence.

## Context and Problem Statement

A row records the process this extension launched: its pid, its Collab host identity, its room
generation and session id, and the wall-clock instant the launch observation was taken. Reconciliation
requires positive evidence of absence before it will call a recorded host gone, because releasing a
claim that a live writer still holds is what produces a second writer for one session.

A numeric pid is not a process identity. The operating system reuses it, and an unrelated OMP process
that happens to hold the number publishes its own room under it. After an operating-system reboot this
produced a real incident: two restored tabs reported their recorded pid alive with no room, one later
attached, and the other stayed held with its exact-file claim kept, because the absence rule requires
the recorded process to be *gone* and the numeric check could not tell the reuse from the original.

The first revision of this record accepted a bare comparison — "the occupant was created later than the
recorded observation, therefore the recorded process is gone" — and an independent architecture review
found that unsafe in one direction: `startedAt` is read from the wall clock *after* the launch (or after
a verified transfer), so a backwards clock adjustment between the recorded process's creation and that
stamp makes a still-live process compare later than its own record. With its room momentarily unlisted,
that frees an identified survivor. The review also noted that the same verdict reaches deletion
admission, so the consequence is not limited to a resume.

The choice is what evidence may establish "the recorded process is gone" for a row whose exact kernel
creation token was never captured, without either adopting a stranger's process or releasing a live
writer.

## Considered Options

- **Reboot-scoped comparison.** Require *both* that the machine booted after the row's own observation
  (`bootEpochMs`, derived from the operating system's monotonic uptime) *and* that the process now at the
  recorded pid was created after that observation. A reboot ends every process that existed before it, so
  a row stamped before the current boot cannot still be the process it recorded; the occupant's creation
  time then names the process that replaced it. Advantages: no schema change, no new durable field, no
  new transport, it repairs rows already written, and it removes the reviewers' scenario, because a row
  stamped *after* the current boot is refused outright — the remaining path needs two opposing clock
  adjustments instead of one. Disadvantages: still a wall-clock derivation rather than an identity, and a
  replacement that happened without a reboot is not detected.
- **Bare one-way creation-time comparison.** Rejected after review: a single backwards clock adjustment
  can free an identified survivor, which changes the accepted no-second-writer guarantee.
- **Persist an exact kernel creation token for every new launch.** The clock-independent option, and the
  one to prefer when it can be captured: a token written at launch is comparable by equality and needs no
  ordering assumption. Not adopted here because it cannot repair existing rows (a legacy discriminator
  would still be required), it must be captured on every launch path including a verified transfer and
  re-proved at attachment, and it would widen the durable row shape — a decision with its own migration
  consequences that this package must not take as a side effect.
- **Treat a missing Collab row, a TTL or a reboot count as absence.** Rejected: a transient publication
  gap would release a live writer's identity, and no timer distinguishes reuse from a surviving host.
- **Adopt or attribute the registry row by pid.** Rejected as the mechanism that produced the incident: a
  room may not be adopted, controlled or released on a numeric match. What remains is the conservative
  refusal — while the reboot test does not establish a replacement, a registry row naming the recorded pid
  still answers `live` and is described as the process this row launched, which blocks a second writer but
  never authorizes adoption, attachment or release.
- **Treat a failed or unsupported process read as gone.** Rejected: an unreadable process is not an
  absent one.
- **Clear the recorded host so the row reads `no-recorded-host`.** Rejected: it skips the live-target
  check and destroys the provenance refusal explanations depend on.

## Decision Outcome

Chosen: the reboot-scoped comparison, implemented as `recordedProcessGoneAcrossReboot`. A recorded pid
is read as the recorded process only while that test does not fire; when it fires, the unchanged combined
absence rule (`roomWithdrawn` **and** `processGone`, for a launch that recorded a matched room) decides.
A pid is never adopted, signalled or used as a transport, and a room proven by that test to belong to a
replacement is never attributed to this row; an inconclusive numeric match keeps its conservative `live`
refusal instead, which can only block, never authorize. A launch that recorded no room stays held by this
rule however its pid ends — the separate explicit release, not this rule, is its way out — and an
unreadable or inconsistent input keeps the row exactly as it was.

### Consequences

- Positive: a reboot's recycled pid stops holding a session forever, and the row can resume under its own
  existing claim, with no new durable state and no migration.
- Positive: a row stamped after the current boot is refused outright, so no single clock adjustment can
  turn a live writer into a freed one; the reviewers' surviving-host scenario is a test in the suite.
- Positive: a room that is still registered continues to win over any pid evidence, and a roomless launch
  is never freed by this rule at all.
- Negative: this is a best-effort discriminator, not an identity. A replacement created after the recorded
  process but no later than the stored observation is **not detected** (the safe direction — it keeps a
  claim), and two clock adjustments in opposite directions can still defeat the boot test, each half by its
  own threshold: the occupant comparison needs the backwards adjustment to exceed the interval from that
  process's creation to the stored observation, and the boot comparison — whose estimate is the current wall
  clock minus the monotonic uptime, so an adjustment already in effect cancels out of it — needs a *later*
  forwards jump larger than the interval from the real boot to that observation. It therefore does not
  promise that no writer exists, and the row's own claim, room and admission rules remain the authority.
- Negative: reconciling a row whose recorded pid is occupied can spawn the verified helper, at most once per
  reconciliation and only on the paths that need the pid disambiguated — a registry row naming that pid, or
  a pid the numeric liveness check reports alive. An exact recorded host is decided before this read;
  otherwise the pid-only registry branch may read the occupant before the recorded-instance check, and only
  when no registry row names the recorded pid does a still-registered recorded instance or a pid reported
  dead avoid the read.
- Negative: a pid reused by a stranger **without** a reboot is not freed by this rule; such a row stays
  conservatively `live`/`owner-unknown` — held, blocking a second writer and starting nothing — and this
  rule contributes no absence evidence for it, leaving the ordinary combined rule (its matched room
  withdrawn *and* its process gone) as the only automatic exit. This record frees nothing there, and the
  explicit release is not a way around a `live` reading: a registry row at the recorded pid, or the recorded
  `instanceId` still registered, is refused there as any other positive witness is. For a row that recorded
  both a `pid` and an `instanceId`, only a reading the reconciler reports as `owner-unknown` — the occupant
  holds no room of this launch — is one the user may release, while an attempt missing either field is
  admitted to the check regardless; both go through the separate explicit path the release record accepted
  in [ADR-0036](0036-release-an-unresolvable-launch-attempt-explicitly.md) provides for a recorded attempt,
  including a room-matched one, after its own fresh checks. Those checks still refuse a live session
  publishing the row's own session identity, a registered host with the recorded `instanceId`, a registry row
  at the recorded pid, a live broker-owned child and unreadable provenance
  ([ADR-0033](0033-release-stale-ownership-of-an-unidentified-launch-explicitly.md), narrowly amended by
  ADR-0036). Releasing an identified writer's claim on a timestamp alone, or widening this automatic rule,
  is what this record refuses to do.

## Related Documents

- [Design: post-reboot ownership recovery](../designs/2026-09-29-post-reboot-pid-reuse-ownership-recovery.md)
- [ADR-0031](0031-reattach-a-surviving-managed-host-through-its-broker.md) — attachment requires an exact
  recorded host and a verified transport.
- [ADR-0036](0036-release-an-unresolvable-launch-attempt-explicitly.md) — the explicit release for the
  states no observation can resolve.
- [ADR-0033](0033-release-stale-ownership-of-an-unidentified-launch-explicitly.md) — the explicit-only
  mechanism this record's sibling extends.

## Architecture Review

- Reviewer: architect (independent)
- Outcome: revised after review; the first revision was **not accepted** (high finding: a single clock
  rollback could falsely declare a live process gone, and the record understated it). The finding is
  addressed by the reboot scope and by an honest two-sided limitation statement.
- Notes: the reviewer also asked that the record stop rejecting every pid-only classification outright
  while the implementation deliberately keeps a conservative pid-only refusal for inconclusive readings;
  the decision text now states that boundary.
- Implementation repair (2026-09-29, before re-review): the implementation review of this record found the
  comparison's **direction** inverted in `recordedProcessGoneAcrossReboot` — it required the boot instant
  to be strictly *earlier* than the row's own observation, so the reboot case this record decides on was
  refused while a row stamped after the current boot was accepted, and the "Positive" consequence above
  ("a row stamped after the current boot is refused outright") did not hold in code. The predicate now
  requires the boot instant to be strictly *later* than the observation; the design record's rule text and
  the three test layers were corrected with it, and each affected assertion was shown to fail under the
  old inequality first.
- Re-review (2026-09-29, independent architect): verdict **reject —
  documentation not yet accurate**, with the repaired predicate itself accepted on inspection and on an
  exercised scenario (49 input combinations and 12 focused tests). Four of its findings were documentation
  corrections, applied in this revision: the explicit-release eligibility description, the obsolete
  all-null-only restriction in `architecture.md`, the categorical pid-attribution rejection, and the
  helper-cost description. The fifth — the missing-broker-record policy discrepancy — was escalated to the
  release records and is resolved as described below. The release eligibility has since been widened by the
  accepted ADR-0036, and is described under that current decision.
- Resolved by the release record, not here: the reviewer's finding that ADR-0033's "a missing broker record
  ... is a failed check" was not what the release probe did — `probeBrokerSlotForRunningChild` answered `idle`
  when the broker held no record for the row's recorded slot — is answered by the now-accepted
  [ADR-0036](0036-release-an-unresolvable-launch-attempt-explicitly.md) and by the probe's current answer: no
  retained record is a distinct `missing` result that only the user's own explicit release (and the later
  re-derivation of that same matching retirement) may accept as disclosed uncertainty, while a record that
  exists but proves a different slot, kind or child still refuses (`src/host/native-terminal.ts`). ADR-0033's
  refusal for that case is therefore superseded **by that record**, for the explicit path only — this
  record's own rule consults neither the release probe nor a broker record, so its text does not depend on
  the answer.
- Alignment re-review (2026-09-29, independent architect): verdict
  **accept with findings, none material**; the architectural decision, the strict discriminator and the
  automatic-versus-explicit-release boundary agree with inspected source, and the first rejection, the
  implementation repair and the second (documentation) rejection are preserved. Its three description
  findings are applied in this revision: the helper-cost consequence no longer claims every occupied-pid
  reconciliation is decided before the occupant read (the pid-only registry branch can precede the
  recorded-instance check), the second review's finding list is now reproduced as it actually was (four
  documentation corrections plus the escalated missing-broker question), and a stale above/below reference
  was corrected. This record's own automatic rule is unchanged by that review.
- Status: **accepted** after independent documentation re-review (2026-09-29;
  **accept with findings**, none material), with the applied
  corrections subsequently confirmed and no remaining findings in a final confirmation.
  The installed post-reboot acceptance run remains unobserved; acceptance records the architectural
  decision, not installed-runtime verification.
