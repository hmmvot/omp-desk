---
status: accepted
date: 2026-09-30
---

# ADR-0039: Refuse only on a verified live writer the extension owns

> **Narrowly amended by [ADR-0045](0045-derive-window-folders-per-window-and-pin-with-identity-ids.md):** a verified live rival holder is a distinct row state, "Open in another window", rather than Blocked; Open and a click on it only explain. Refusal and Stop rules are unchanged.

> Native/legacy classification and same-window mode-replacement confirmation narrowed by accepted [ADR-0040](0040-switch-one-editor-between-rpc-chat-and-native-pty.md): native transport is explicit, idle mode switches are silent and busy switches require consent. Implemented in source; verified rival-window ownership remains protected and external/unverified writer risk is unchanged.

## Context and Problem Statement

Repeated upgrades stranded Sessions behind unauthenticatable old brokers and unresolved claims. Recorded PIDs and inability to prove absence are not ownership. The user explicitly accepts responsibility for unverified and external writers.

## Considered Options

- Fail closed on uncertainty or require explicit ownership release: rejected; both create dead ends contrary to the user's policy.
- Signal recorded PIDs: rejected; PID reuse can target an unrelated process.
- Protect only positively verified extension-owned writers: chosen.

## Decision Outcome

Open/Resume/Delete/Forget/Rename may refuse or require stopping first only on current positive evidence for the exact session: this window's own running runtime, a child verified alive under this extension's authenticated broker (RPC or legacy `managed-omp`), or another live extension window's claim holder whose process generation is verified alive now. Another live window remains **Blocked**, with explicit Stop available, not Resume/Delete/Forget.

Everything else is unowned: missing/unreadable/unreachable/unauthenticatable/mismatched brokers, dead or ambiguous/reused PIDs, unresolved launches, stale/dead/unverifiable holders and unreadable claim storage. User actions proceed immediately with ordinary confirmations; no Stale reservation state, release command or uncertainty notification. This grants permission, not a claim that external writers are absent.

A verified writer owned here is **Running**, including legacy children. Resume and Delete offer one confirmation naming pid N, stop the exact verified writer through RPC close or the existing authenticated legacy broker stop (and empty-broker shutdown), then continue. Stop remains available. A changed positive target is never stopped under an earlier confirmation. An unconfirmed stop is reported truthfully; continuation rechecks current positive ownership rather than preserving uncertainty as a veto.

Claims are re-read and replaced under the identity mutex. Only verified-live rivals exclude admission; holder identity includes process creation time (older records require a creation time no later than their publication). Unusable storage/mutex permits a process-local lease without modifying that namespace; any readable verified-live rival still excludes. An unresolved launch releases its lease, so an unconfirmed attempt cannot itself become positive ownership. This intentionally accepts the residual inter-window unrecorded-launch race.

A lease is held only while a writer is positively verified or an operation is in flight. An unresolved launch, failed attach/restore, or unconfirmed stop whose recheck does not re-verify the writer releases its operation lease under the mutex. ADR-0021's failed-attach reservation retention and ADR-0037's unconfirmed-stop claim retention are superseded. A surviving child of a dead broker and an unverified legacy hidden-terminal host are unowned. Verification binds durable slot provenance and managed kind, broker PID/creation/generation and child PID/creation; a numeric PID alone is never a writer witness.

Per-tab serialization, exact-file binding, document generation fencing, authenticated transport identity and truthful partial-deletion/stop outcomes remain integrity requirements. An unowned draft/stopped editor can become this window's controlling editor; duplicate editors of a live local conversation and verified rival owners remain fenced. The automatic activation gate remains narrower than user permission: only running intent with accepted absence evidence auto-relaunches; stopped or uncertain rows never silently spawn, but explicit Resume is available.

Read-only/view-only Open is never an ownership refusal; only Open that launches a fileless draft is admitted as Resume. Rival Stop uses the row's recorded broker without taking the rival claim and records stopped intent before dispatch. Claim-storage failure does not relax catalog integrity (ADR-0034); sticky import disagreements are metadata, not an ownership veto. Two windows proceeding on local-only leases can overlap an unrecorded launch, a risk the user accepts.

### Consequences

- Sessions cannot be trapped by uncertainty; stale metadata is silently replaced when proceeding.
- The extension protects its own proven active writers, not global single-writer exclusion. Overlapping unverified writers can corrupt or race deletion on the user's responsibility.
- Delete retains its exact-path confirmation and transaction. Drafts have no transcript to delete; Forget removes their row.

## Related Documents

Supersedes ADR-0033 and ADR-0036 and the explicit-release mechanism in their recovery designs. Narrows ownership uncertainty and absence prerequisites in ADR-0011, 0018, 0021, 0025, 0027, 0031, 0034, 0035, 0037 and 0038, and the Sessions, broker-restart, post-reboot, workspace-independent and lost-room/RPC-UI designs. Their exact transport, stop truthfulness, file transaction and editor identity requirements survive. Product and implemented architecture link here rather than reinstating historical refusal clauses.

## Architecture Review

- Reviewer: separate architect (independent)
- Outcome: accepted after an alignment round and a confirming spot check; no remaining material findings.
- Notes: review addressed live-holder generation, mutex-local integrity, unconfirmed lease release, exact broker tuple, one-step actions, rival-window exception, and automatic-versus-explicit admission.
