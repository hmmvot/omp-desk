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

## Amendment 2026-10-13 (accepted after independent architecture review): an attesting broker's own report is the identity proof for re-adoption, the ownership probes and the stop's pin proof

> Scope: this changes how a window proves, for a **surviving current-build broker**, that the process behind a record is the broker it describes and that the broker's pipe child is the pinned one. Three consumers share that one proof (`connectRecord`, `provedBrokerPin`), and each is covered by this amendment:
>
> 1. **Re-adoption** (`attachRpcHost`, `attachNativeHost`): the attach that follows a restore. Rationale: this is where four PowerShell readings per row, sequential across rows, made a reload restore sessions 12–49 s late.
> 2. **The ownership-verdict probes** (`probeRpcHost`, `probeBrokerSlotForRunningChild`) that feed [ADR-0039](0039-refuse-only-on-a-verified-live-writer-the-extension-owns.md)'s refusals (Open, Resume, Delete admission). Rationale: a `live` or `attachable` verdict must rest on current positive evidence. For an attested pipe child the broker's authenticated status *is* current evidence: it holds the child's process handle at the instant it answers, which is stronger than a creation time read a moment earlier and compared afterwards. For every other child the reading is taken for that proof.
> 3. **The stop's pre-dispatch pin proof** (`stopBrokerOwnedHost`). Rationale: the stop is a request over the authenticated connection and the broker acts through its own handle; this window signals no numeric pid. The proof only guards "is this slot's child the one the row recorded", which the attested report answers with the same facts.
>
> Not changed: the reboot-scoped absence rule above; every reading an *absence* or *free* decision takes (`kernelProcessIdentity`, `recordedRootGone`, `waitForManagedRootExit`, the kill and process-list paths, `launchSlot`'s reading of a recorded broker); the claim-admission rule of ADR-0039 (the claim holder's start time read at the verdict).
>
> [ADR-0031](0031-reattach-a-surviving-managed-host-through-its-broker.md) required the attach to re-prove the pin "including a new independent kernel reading of the child's creation time". This amendment names what replaces that reading for an attested child (the broker's held process handle, reported in its authenticated status) and for the broker itself (the token handshake); ADR-0031 carries a pointer to it. Everything else in ADR-0031 stands.

### Context

Re-adopting one surviving session used four PowerShell identity readings: the broker pid and the child pid in the reconcile (`probeRpcHost`), then the same two again in the attach (`attachRpcHost`). With C# Dev Kit and Unity saturating the machine each reading took seconds, and a restore proves its rows one after another. The readings repeat what the authenticated broker already says about itself.

### Decision

1. **The broker's own statement replaces the readings when it attests it.** A broker of this build reports in its status, which is authenticated by the session key derived from the record's token, `attestation: { brokerSelfRead: true, childHandleLive }`. `brokerSelfRead` is a version marker: every broker since 0.1.0 refuses to start without its own kernel creation time and MACs it into `hello-ok`, so the field adds no new fact, it tells this host that the broker is new enough to be believed without a second reading. `childHandleLive` says the broker still holds its child's process handle and has not seen the child exit. Only a pipe child (`managed-rpc`) is held that way. A window re-adopts such a broker when the handshake and the status agree with the record (slot, broker pid, broker creation time) and the status agrees with the row's pin (broker id, generation, child pid, child creation time). It takes no kernel reading of the broker, and none of the child when `childHandleLive` is true and the child is `running`.
2. **Anything less is read through the kernel as before.** A broker that attests nothing (an older build), a malformed or unrecognised attestation (treated as absent, never as a refusal of the status, so a later broker may extend it), a status that disagrees with the handle, a child whose handle the broker no longer holds, and every pseudo-console child (a native Terminal) go through the existing readings and the existing creation-time comparisons. The probe helper is staged only when such a reading is needed, including in the stop path.
3. **A reading is shared only while it is in flight.** Concurrent proofs of one pid share one probe, and nothing is kept once it answers: every proof that starts afterwards reads the kernel again, so evidence is never older than the proof that uses it (ADR-0031's "new" reading, ADR-0039's current evidence). An earlier draft of this amendment reused a `found` reading for 60 s between the reconcile and the attach; it is withdrawn because a pid that changed hands inside that window would have been judged on the earlier process.
4. **No identity probe runs before the handshake.** A coarse in-process liveness check (`process.kill(pid, 0)`, `ESRCH` only) refuses a pid nobody holds before a socket is opened; the handshake does the rest. The state-directory access verification (PowerShell, once per client) still runs first and is unchanged.

### Why this holds against the threat model

- *A reused pid (the reboot incident).* The record's token is minted in the broker's memory and written to an owner-only record. The handshake is a mutual HMAC proof of that token: the client sends only a MAC over its nonce (nothing from which the token can be recovered), and the broker's `hello-ok` MAC covers its slot, both nonces, its pid and its creation time. A stranger that now holds the pid, or the port, cannot produce that MAC. A process that answers is the process that minted the token; a record left by a dead broker finds nobody (refused connection), another broker (it aborts on the broker id or generation), or a stranger that cannot answer (rejected, or the handshake bound). The window compares the pid and creation time inside the MAC with the record's, and the status with both. The kernel reading was a second witness to the same facts. Tests: a live pid (`process.pid`) with a closed port, with another broker on the port, and with a listener that does not hold the token are each refused with no reading.
- *Record substitution.* A record copied to another slot, or naming another broker or generation, fails the slot, id and generation checks in the handshake and against the row's pin; a record in a directory another account can write is refused by the state-directory access verification, which stays. A same-user process that reads the record already speaks as the broker, and, with this amendment, can also impersonate a broker that has died once its pid is reused; that is inside the same-user boundary [ADR-0006](0006-host-generated-key-peer-verified-pipe.md) excludes, not a new one.
- *The child.* A pid is only an identity while something reserves it. A pipe child's process handle is held by the broker from its spawn, so while `childHandleLive` is true no other process can have the pid, and the creation time the broker read while holding it names the child. Node sets the exit state and only then closes its handle, so a `true` flag means the Windows handle is open now. The window in which a dead child can still be admitted on a `running` status is the gap between the kernel ending the process and Node's exit callback; it is as small as the gap between a reading and its comparison in the old scheme. The identity adopted still names the dead process, nothing is signalled by pid, and the exit reaches the handle as an ordinary state push. With the flag false the kernel reading runs.
- *Why a pseudo-console child keeps its reading.* [ADR-0032](0032-prove-the-pty-runtime-with-a-console-child.md) records that the dependency reports a console child's exit when its output closes, which can be after the process ended, so the broker's `running` is not backed by a held handle there. The child's creation time is therefore still read, once for the reconcile and once for the attach, and the broker's own pid is believed on its attestation. A real-broker test asserts `childHandleLive` is `true` while a `managed-rpc` child runs, `false` after it exits, and `false` for `managed-omp` and folder-shell brokers.
- *An old broker lying or buggy.* Unattested brokers keep the old behaviour entirely; their statements are never believed in place of a reading.

### Consequences

- Readings per re-adopted row (reconcile plus attach): a `managed-rpc` row whose broker attests, 0 (was 4); one whose broker is from an older build, 4 (as before; concurrent proofs of the same pid share one probe); a native Terminal row, 2 (was 4: the child once for each proof, the broker not read).
- The probe helper (a staged copy, with two access verifications) is not staged on the trusted attach path. The attach gate waits only for hashing the packaged tree in place.
- The state-directory access verification (a few PowerShell runs, once per window; a window now starts it at activation so it overlaps the rest of activation) and the tree staging's access verification are unchanged, and are the PowerShell a trusted attach still waits on. Caching them touches the other-account boundary and needs its own review.
- The status gains one optional field; an older host ignores it and an older broker omits it, so no protocol version changes and mixed generations keep working.
- Smaller notes: a silent listener on a dead broker's port still costs the 10 s handshake bound; the stop path no longer stages the probe helper up front, it stages it when a reading is needed.

Status of this amendment: **accepted** after independent architecture review (2026-10-13); the review's findings were resolved before acceptance.

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
