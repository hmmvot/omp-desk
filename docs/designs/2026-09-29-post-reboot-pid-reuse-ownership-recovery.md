---
status: accepted
date: 2026-09-29
---

# Post-reboot ownership recovery: a reused pid is not the recorded process

> Ownership clauses narrowed by [ADR-0039](../decisions/0039-refuse-only-on-a-verified-live-writer-the-extension-owns.md): reused/ambiguous PIDs are unowned without a reboot proof or release ceremony for user actions. Absence evidence remains only an automatic-relaunch gate.

> Amended by [ADR-0038](../decisions/0038-host-chat-over-rpc-ui-on-a-broker-pipe-child.md): the room condition disappears; rows recording a child's kernel creation time are matched by identity, and this reboot discriminator remains only for legacy rows without one. See the [RPC-UI chat and Sessions design](2026-09-29-rpc-ui-chat-and-sessions.md).

## Problem

After an operating-system reboot, VS Code restored two OMP editor tabs whose rows still recorded the pid,
Collab instance, generation and session id of the host each had launched before the reboot. Both rows
reported the recorded pid as **alive** and **no Collab room** registered, so ownership reconciliation
answered `unknown` for both — the state that blocks a launch. One tab later attached successfully; the
other stayed held, with its exact-file claim kept.

The recorded number was alive because Windows had handed it to an unrelated process. Nothing in the row
says "this number now belongs to someone else", so the reconciler's numeric liveness check
(`isProcessAlive`, `src/relay/manager.ts`) read the reuse as the original host still existing, and the
absence rule — which requires the recorded process to be *gone* as well as the matched room withdrawn —
could never be satisfied. The claim then outlives the process it was taken for.

## Goals and Non-goals

- Goals:
  - A recorded launch whose pid the operating system has handed to a later process **across a reboot** is
    recognized as the recorded process being gone, so its row can be reconciled again (and, for a
    room-matched launch, released to a resume under its own existing claim).
  - A room that is still registered stays a writer of this session, whatever occupies the pid.
  - A surviving host whose room is not listed yet keeps blocking a second writer, and can be attached when
    its room appears — without a background timer and without ever launching a second process.
  - A launch that recorded no room stays held by this rule, however its pid ends — and now has an explicit
    user path out instead of a permanent lock (the companion design and the accepted
    [ADR-0036](../decisions/0036-release-an-unresolvable-launch-attempt-explicitly.md), which also admits an
    attempt that recorded no `instanceId`, or whose row currently reads `owner-unknown`). That path is the
    user's authorization and never this rule freeing the row.
  - Everything unobservable (an unreadable occupant, an unreadable registry, a platform with no reading, a
    row stamped after the current boot) keeps the row exactly as it was.
- Non-goals:
  - Adopting, signalling, stopping or replacing whatever process occupies a reused pid.
  - Weakening attachment: no new transport, no adoption by pid, no fallback when a proven transport fails
    (ADR-0031).
  - Persisting a process-creation token for future launches (see Alternatives).
  - Automatic recovery of any kind on a timestamp comparison alone.

## Current State

`reconcileOwner` (`src/host/native-terminal.ts`) decides one row's ownership from OMP's Collab registry
snapshot, the row's recorded host, its broker provenance and this window's terminals. Before this change
its last branches were:

- a registry row sharing the recorded **pid** answered `live` ("still hosting a Collab room") —
  attribution by numeric pid alone;
- a recorded pid that `isProcessAlive` reports alive with no room answered `unknown`;
- otherwise the combined evidence `absenceEvidenceForRecordedHost(recorded, { roomWithdrawn: true,
  processGone: true })` was produced, which requires the recorded `pid` *and* `instanceId`.

`RecordedHost.startedAt` is stamped by the index **after** a launch returns (or after adopting a verified
transfer), so it is a wall-clock observation boundary, not the process's kernel creation instant.

## Proposed Design

Two new observation ports and one new rule; no schema change, no new durable field, no new transport.

**A port for the occupant's creation time.** `OwnerReconcilePorts.processOccupation(pid)` returns
`{ kind: "observed", creationTimeMs }` or `{ kind: "unknown", detail }`. Production wires it in
`src/extension.ts` to `queryControlProcessGeneration(pid)` — the same verified helper the host-control pipe
authenticates with, already staged by activation — converted by `filetimeToEpochMs`
(`src/host/pty-protocol.ts`, the module that owns the FILETIME dialect). A non-Windows host, an unstaged
helper, a refused probe and an unusable value all answer `unknown`.

**A port for the boot instant.** `OwnerReconcilePorts.systemBootEpochMs()` returns
`Date.now() - Math.round(os.uptime() * 1000)` for a finite, nonnegative uptime and `null` otherwise — the
wall-clock instant this machine booted at, derived from the operating system's *monotonic* uptime, so a
later clock adjustment moves it with the clock instead of silently inventing a reboot.

**A reboot-scoped rule.** `recordedProcessGoneAcrossReboot({ recorded, occupantCreationTimeMs,
bootEpochMs })` (`src/host/session-index.ts`, next to `absenceEvidenceForRecordedHost`) answers `true` only
when all of these hold: the recorded `startedAt` parses; the boot instant is strictly later than it; and the
occupant's creation time is strictly later than it. A reboot ends every process that existed before it,
so a row stamped before the current boot cannot still be the process it recorded, and the occupant's
creation time names the process that replaced it. Every other answer — equal, earlier, unreadable,
malformed, or a row stamped after the boot — is `false`, "not proven gone", never "alive".

**Where it applies.** The reconciler reads the occupant at most once per reconciliation, and only while
something occupies the recorded pid — either a Collab registry row naming that pid or a pid the numeric
liveness check reports alive:

- the pid-only registry branch answers `live` only while the reboot test does not fire; when it does, the
  occupant's room is not this row's writer and the row's own room and process decide instead;
- the "alive but no room" branch answers `unknown` only while the reboot test does not fire;
- when it fires, the unchanged combined absence rule decides, and it still requires the row to have
  recorded a matched room.

**A surviving host with a late room.** The retry is the row's own open, which re-runs reconciliation: the
same process and room then answer `attachable` under the unchanged transport rules. No timer is added — a
recheck cannot authorize anything by itself, the launch path already waits for publication when it starts a
host, and an automatic background loop would be a new lifetime and a new failure surface for no additional
evidence. The `unknown` detail says so, so the state is visible and recoverable by the user's own action.

## Affected consumers (all of them, not only resume)

The verdict feeds more than an attach, and a wrong `free` would reach each of these:

- **Open/Resume and the activation restore pass** (`src/host/session-index.ts` `#reconcile`,
  `restoreAll`/`restore`): a `free` verdict plus accepted evidence is what admits a launch. The exact-file
  claim, the durable run intent and the batch duplicate rules are unchanged, so a `free` verdict does not
  by itself start anything.
- **Deferred draft re-derivation** (`reconcileDeferred`): re-derives availability only, starting nothing.
- **Deletion admission and its under-claim recheck** (`src/host/session-lifecycle.ts`): the same reconciler
  and the same `acceptOwnerAbsenceEvidence` rule decide whether removal is authorized, and a released row
  is described as an explicit release rather than as proof. The reboot scope is what keeps a wall-clock
  comparison from authorizing a deletion of a survivor's transcript; a roomless row still cannot be
  deleted on absence evidence, and now needs the explicit release instead.
- **The explicit release action** (`SessionIndex.releaseStaleOwnership`): it requires a `free` verdict
  carrying `released-stale-attempt` evidence for this exact attempt, not automatic combined process-and-room
  absence evidence, and refuses whenever its fresh check finds a positive writer witness.

## Alternatives

- **A bare one-way comparison without the boot requirement.** Rejected after independent review: one
  backwards clock adjustment between the recorded process's creation and the stored observation could
  release a live survivor.
- **Treat "no Collab row" as gone.** Rejected: a transient publication gap would release a live writer's
  identity (ADR-0031, ADR-0033).
- **A TTL, a reboot count, or a clock comparison that must also match.** Rejected: none of them
  distinguishes reuse from a surviving host.
- **Adopt or attribute a registry row by pid.** Rejected: a pid is not an identity; the fix is precisely to
  stop doing this for the reboot case.
- **Treat any probe failure as gone.** Rejected: an unreadable occupant is not an absent one.
- **Clear the recorded host to manufacture `no-recorded-host`.** Rejected: it would skip the live target
  check entirely and destroy the provenance the refusal explanations depend on.
- **Persist an exact creation token for new launches.** Not adopted here: it cannot repair rows already
  written, it must be captured on every launch path (including a transfer) and re-proved at attachment, and
  it would widen the durable row shape — a migration decision this change must not take as a side effect.
  It remains the clock-independent option to prefer when it is captured deliberately
  ([ADR-0035](../decisions/0035-distinguish-a-recorded-process-from-a-later-occupant-of-its-pid.md)).

## Risks and Open Questions

- **Two-sided wall-clock limit.** A replacement created after the recorded process but no later than the
  stored observation is not detected (it keeps a claim), and two clock adjustments in opposite directions
  can still defeat the boot test, each half by its own threshold: the occupant comparison needs the
  backwards adjustment to exceed the interval from the recorded process's creation to the stored
  observation, and the boot comparison — whose estimate is the current wall clock minus the monotonic
  uptime, so an adjustment already in effect cancels — needs a *later* forwards jump larger than the
  interval from the real boot to that observation. The rule therefore never promises that no writer
  exists.
- **No reboot, no automatic release by timestamp.** A pid reused by a stranger without a reboot keeps the
  conservative `live`/`owner-unknown` answer: the timestamp comparison contributes no absence evidence here,
  and the ordinary combined rule still decides on the recorded matched room withdrawn *and* the recorded
  process gone, so an occupant that later disappears can free such a row without another reboot. The
  explicit release is a *separate, user-authorization* path, not this rule, and the two must not be
  conflated. Its eligibility is `host !== null && (host.pid === null || host.instanceId === null ||
  availability === "owner-unknown")`: an attempt recording both a `pid` and an `instanceId` must currently
  read `owner-unknown`, while missing either field admits it to the check regardless of availability.
  Eligibility is not authorization — a locally driven host or a fresh positive writer witness refuses
  release, and in this no-reboot case a registry row at the recorded pid or the recorded `instanceId` still
  registered refuses it ([ADR-0036](../decisions/0036-release-an-unresolvable-launch-attempt-explicitly.md)).
  Widening this automatic rule, or releasing an identified writer's claim on a timestamp alone, is what both
  records refuse to do.
- **Cost.** Reading an occupant spawns the verified helper, at most once per reconciliation, and only on
  the paths that need the pid disambiguated — a pid-only registry match, or a pid the numeric liveness
  check reports alive. An exact recorded-host match decides before that read; otherwise the pid-only
  registry branch precedes the recorded-instance check, and without a pid-only registry match a registered
  recorded instance or a numerically dead pid avoids the read.
- **Non-Windows and unreadable helpers.** Every such case is `unknown`, so those platforms keep the
  pre-change behavior.
- **Residual uncertainty.** A `free` verdict never promises that no *external* writer exists; that is
  unchanged and remains disclosed by ADR-0018/ADR-0027.

## Rollout and Verification

- `src/host/pty-protocol.test.ts`: the FILETIME conversion, including truncation, pre-epoch and
  out-of-range values.
- `src/host/session-index.test.ts`: the rule's boundary cases — a reboot is required *strictly after* the
  row's own observation (a boot at, before, or unreadable is refused) and the occupant must postdate that
  observation (equal or earlier is refused) — plus unreadable inputs; a recycled pid's room-matched row
  resuming under the claim it already holds; a row stamped after the current boot staying blocked; a
  surviving host with an unpublished room starting nothing and attaching when the room appears on retry; a
  registered room staying live; a stale roomless attempt staying held by observation.
- `src/host/native-terminal.test.ts`: the reconciler with a real live pid — freed across a reboot, never
  attributing a foreign room at that pid, `unknown` for an unreadable occupant, for an earlier/equal
  creation time and for a post-boot observation, live for a registered room, attachable when the room
  appears, and held for a roomless launch. The occupied-pid cases use this test process's own pid, so the
  numeric liveness check is real rather than stubbed.
- Verification is source-level and focused; the installed-window, post-reboot acceptance run belongs to
  a separate isolated-profile run (no window control is available to this change).

## Related Decisions

- [ADR-0031](../decisions/0031-reattach-a-surviving-managed-host-through-its-broker.md) — attachment
  requires an exact recorded host and a verified transport, re-proved at attachment.
- [ADR-0033](../decisions/0033-release-stale-ownership-of-an-unidentified-launch-explicitly.md) —
  explicitly released ownership, narrowly superseded for eligibility by ADR-0036.
- [ADR-0035](../decisions/0035-distinguish-a-recorded-process-from-a-later-occupant-of-its-pid.md) — the
  lasting choice this design implements.
- [ADR-0036](../decisions/0036-release-an-unresolvable-launch-attempt-explicitly.md) — the explicit path
  for the states this rule deliberately leaves held.
- [Companion design: recovering a lost room link and releasing an unresolvable attempt](2026-09-29-lost-room-link-and-unresolvable-attempt-recovery.md)

## Architecture Review

- Reviewer: architect (independent design review)
- Outcome: revised after review; the first revision was **not accepted** (high finding: the claimed
  one-way safety did not hold under clock rollback, and the design omitted deletion as an affected
  consumer). Both findings are addressed above: the rule is reboot-scoped, its limit is stated in both
  directions, and the affected consumers — including deletion — are listed with the guards that remain.
- Notes: the reviewer also asked that the probe ordering be described accurately (the occupant is read at
  most once, and only for an occupied pid — a pid-only registry match, or a pid the numeric liveness check
  reports alive) and that the claim/admission rules be shown as unchanged, which the "Where it applies" and
  "Affected consumers" sections now state.
- Implementation repair (2026-09-29, before re-review): the source review of this revision found the
  comparison's **direction** inverted in the code — `recordedProcessGoneAcrossReboot` required the boot
  instant to be *earlier* than the row's own observation, which refused the actual reboot case (a row
  stamped before the current boot) and accepted a post-boot row, freeing a live writer's row on one clock
  adjustment. The predicate now requires the boot instant to be strictly *later* than the observation and
  refuses a row stamped after the current boot; this section's rule text was corrected to match, and the
  three test layers now assert the corrected direction — a pre-boot row is freed exactly when the pid's
  occupant postdates its observation (`src/host/session-index.test.ts`, `src/host/native-terminal.test.ts`,
  index-level restore and roomless fixtures). The affected assertions were shown to fail under the old
  inequality before the correction.
- Re-review (2026-09-29, independent architect, design re-review): verdict **accept
  with findings**. The repaired direction was verified against the predicate and exercised in the focused
  suite, and no normative sentence was found to require a boot *before* the observation. Its findings are
  addressed in this revision rather than deferred: the residual clock limit is now stated as the two
  separate thresholds it actually is (the boot comparison needs a later forwards jump larger than the
  boot-to-observation interval, and the backwards adjustment cancels from it); the occupant-probe gate,
  the probe cost and the port count now describe the source; and the "no reboot" risk was rewritten to stop
  asserting an escape the release does not offer to every reading, which the accepted
  [ADR-0036](../decisions/0036-release-an-unresolvable-launch-attempt-explicitly.md) has since settled
  exactly: eligibility reaches an `owner-unknown` reading, including a room-matched one, while a `live`
  reading stays refused as a positive witness. The installed post-reboot acceptance run remains outstanding.
- Alignment re-review (2026-09-29, independent architect, post-reboot design re-review): verdict
  **accept with findings**; the automatic
  predicate, its inconclusive boundaries and every listed consumer guard agree with inspected source, and
  the earlier reviews' account is preserved. Its findings are applied in this revision: the "no reboot" risk
  now states the release's actual eligibility (`pid` null, `instanceId` null, or a current `owner-unknown`)
  instead of claiming the `live` reading is out of reach, and no longer says the comparison is decided only
  by a later reboot; the affected-consumers entry for the explicit release now names the
  `released-stale-attempt` evidence for this exact attempt rather than "the answer"; the cost entry now
  describes the real probe ordering (an exact recorded-host match is decided first, and the pid-only
  registry branch precedes the recorded-instance check); and the boot-port entry matches the production
  rounding of the uptime-derived estimate.
- Confirming re-check (2026-09-29, independent architect, design confirmation): verdict
  **accept**, no remaining finding. Every applied correction was verified against source — the ordinary
  combined room-and-process absence rule still applies without reboot evidence, the eligibility predicate
  matches `isUnresolvableLaunchAttempt` and stays distinct from authorization, the release requires a `free`
  verdict with `released-stale-attempt` evidence matching this exact `attemptStartedAt` and `sessionId`, the
  probe ordering matches the reconciler, and the boot estimate matches the production finite/nonnegative
  uptime guard and `Math.round`. **Status: `accepted`** after a confirming re-check of these corrections,
  with no remaining findings; the installed post-reboot acceptance run remains unobserved.
