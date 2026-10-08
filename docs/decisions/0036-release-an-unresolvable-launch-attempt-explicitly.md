---
status: superseded
date: 2026-09-29
---

# ADR-0036: Release a launch attempt no observation can resolve, explicitly, on the user's authority

> Superseded by [ADR-0039](0039-refuse-only-on-a-verified-live-writer-the-extension-owns.md). The explicit-release ceremony, eligibility and uncertainty refusals are removed. The rationale and reviews below are historical; normal user actions now proceed on uncertainty.

> Amended by [ADR-0038](0038-host-chat-over-rpc-ui-on-a-broker-pipe-child.md): the "room-matched attempt" eligibility case and the room-based positive-witness refusals disappear with Collab; eligibility and refusals are computed from broker/kernel witnesses and the user-authority rule is unchanged.

## Context and Problem Statement

[ADR-0033](0033-release-stale-ownership-of-an-unidentified-launch-explicitly.md) accepted that an unreconcilable row must not be a permanent lock: the user may release this extension's reservation for one launch attempt after a fresh best-effort check, with residual risk disclosed. It limited eligibility to an attempt with no process identity, required a materialized session file, required a target check against that exact file, and refused when the broker record was missing.

Those boundaries leave rows no observation can resolve. This includes a launch that recorded a process but matched no room, and a room-matched attempt whose room closed but whose process cannot be proved gone or positively identified as a live writer of this session. A missing recorded broker record does not establish that its child stopped. ADR-0035's automatic absence rule remains deliberately narrow; the question is whether the user's explicit authorization should reach these unresolved recorded attempts and what uncertainty the check may leave.

## Considered Options

- **Extend the same explicit release to every recorded attempt still `owner-unknown`.** Eligibility is a recorded host whose `pid` or `instanceId` is null, or whose availability is `owner-unknown`. Advantages: no such unresolved attempt is permanently locked; the existing explicit, attempt-bound mechanism remains. Disadvantages: some shapes have no positive witness to check, so release can authorize a resume over a writer that may still be running.
- **Keep ADR-0033's narrower eligibility and refusals.** Rejected: room-matched unresolved attempts and missing-file drafts remain permanently blocked.
- **Release automatically once the recorded pid is gone or provably reused.** Rejected: this would broaden the automatic absence rule ADR-0035 deliberately narrowed.
- **Refuse every missing broker record as if its child might be running.** Rejected for the explicit release only: a missing record remains uncertainty, but the user may explicitly authorize release after that uncertainty is disclosed. Ordinary reconciliation, attachment and launch admission continue to refuse/answer unknown.
- **Stop a broker-owned child instead of releasing its claim.** A positive live child remains a refusal here; the separate explicit no-runtime stop is recorded in the accepted [ADR-0037](0037-stop-a-recorded-broker-owned-managed-child-without-a-chat-runtime.md).

## Decision Outcome

Chosen: extend the explicit release to a recorded launch attempt when `isUnresolvableLaunchAttempt(host, availability)` is true: `host !== null` and (`host.pid === null` or `host.instanceId === null` or `availability === "owner-unknown"`). This includes attempts that recorded both a process and a matched room but whose current ownership cannot be established. For an attempt with both `pid` and `instanceId`, eligibility additionally requires `owner-unknown`; missing either field admits the attempt to the check regardless of availability. Eligibility alone never authorizes release: a locally running host, or a positive writer witness found by the fresh check, refuses it.

The fresh best-effort check remains attempt-bound and is widened to available evidence: check the recorded session id first, then the file-header session id when needed; a header that conflicts with the recorded id refuses. A live Collab session publishing the target session id in its directory, a registered host with the recorded `instanceId`, a registry row at the recorded pid (unless ADR-0035's reboot-and-creation-time proof establishes the recorded process is gone), and a live managed child under the recorded broker slot refuse. Unreadable file/header or broker provenance, and an existing broker record that cannot be read or authenticated, refuse. An existing broker record that proves a **different slot, host kind or child** is a target-identity mismatch and remains a refusal; the missing-record exception never waives that. A missing broker record is accepted only as disclosed uncertainty for this explicit path and re-derivation of the same matching retirement; it is never treated as `idle`, and ordinary reconciliation, attachment and launch admission continue to refuse/answer unknown.

This decision supersedes exactly these ADR-0033 clauses:

1. **Eligibility limited to attempts with no process identity.** The eligibility above includes all recorded `owner-unknown` attempts.
2. **Materialization/session-file prerequisite.** A reserved draft identity is sufficient; a session file is not required.
3. **Target check limited to the exact file's own session id.** Check the recorded session id first, then the file-header session id; a fileless attempt may have no matchable identity.
4. **Missing-broker-record refusal.** Superseded only for this explicit release path, and only as disclosed uncertainty.

Everything else in ADR-0033 remains: the action is explicit-only, uses the row's own claim (or reserved draft identity), is bound to the exact attempt, performs fresh checks, never releases automatically, and is authorization rather than proof of absence. Later Open/Resume/Delete re-check under their own authority; the release never writes `ownership.releasedAt`.

### Consequences

- Positive: a row whose recorded attempt remains unresolvable can be explicitly released, including room-matched attempts and reserved drafts; a completed matching release can be re-verified idempotently rather than becoming a permanent lock.
- Positive: missing broker metadata is distinguished from an idle child and disclosed rather than silently interpreted as proof.
- Negative: the recorded process may have been observed running but was not confirmed stopped; it may still run or write despite no current positive witness. A fileless attempt with no recorded session id has no matchable session identity, so that part of the live-session check cannot be performed. Release authorizes this uncertainty rather than proving absence, and later Resume or Delete can therefore overlap a writer or lose history. This is a user-authorized risk, not a universal single-writer guarantee.
- Negative: every later Open/Resume/Delete must continue to perform its own ownership checks; the release itself starts, stops and deletes nothing.

## Related Documents

- [Design: recovering a lost room link and releasing an unresolvable attempt](../designs/2026-09-29-lost-room-link-and-unresolvable-attempt-recovery.md).
- [ADR-0033](0033-release-stale-ownership-of-an-unidentified-launch-explicitly.md) — accepted record, narrowly superseded by this decision for the four clauses enumerated above.
- [ADR-0035](0035-distinguish-a-recorded-process-from-a-later-occupant-of-its-pid.md) — the reboot-scoped automatic rule whose narrowness makes this explicit path necessary. ADR-0035's automatic reboot-scoped absence rule is unchanged; its earlier description of a room-matched attempt having no explicit escape is narrowed by the decision above, and its historical missing-record-as-`idle` finding is addressed by the distinct `missing` result described here. The four clauses enumerated above are the only ADR-0033 clauses this decision supersedes; everything else in that accepted record remains authoritative.
- [ADR-0037](0037-stop-a-recorded-broker-owned-managed-child-without-a-chat-runtime.md) — separate accepted stop path for a positively identified broker-owned child.

## Architecture Review

- Reviewer: independent architect (v3 review, two corrective re-checks and a final confirmation).
- Outcome: accepted after corrective reviews and final confirmation.
- Notes: confirmed exact eligibility, fresh positive-witness refusals, authenticated requested-slot/kind/recorded-child checks, attempt-bound retirement and idempotent re-verification. This decision narrowly supersedes four ADR-0033 clauses: unidentified-only eligibility; the materialized-session-file prerequisite; the exact-file-only session-identity check; and missing-broker-record refusal, only for explicit release and re-derivation of its matching retirement as disclosed uncertainty. All other ADR-0033 guarantees remain, including held own claims, explicit-only authorization, fresh later Open/Resume/Delete checks, no automatic release, and no `ownership.releasedAt` without a confirmed stop. Final focused verification passed 12 tests. No installed-window or real-room-closure run is claimed.
