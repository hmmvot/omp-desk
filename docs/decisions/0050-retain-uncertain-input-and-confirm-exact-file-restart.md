---
status: accepted
date: 2026-10-08
---

# ADR-0050: Retain uncertain input and confirm exact-file Restart

## Context and Problem Statement

OMP can keep emitting transcript events while its serial RPC dispatcher cannot answer state or input commands. Same-process Reconnect cannot guarantee dispatcher recovery. A page post and broker write are transport receipts, not input admission, and a lost admission reply does not prove that input was rejected. Existing Reload requires responsive native state and therefore cannot be the recovery action for this failure.

## Considered Options

- Clear or retry on transport acceptance: simple, but silently loses or duplicates uncertain input.
- Reconnect only: useful for transport loss, but leaves a native command wedge without a usable recovery path.
- Automatically restart: may interrupt useful work and unpersisted effects without consent.
- Retain originals and offer a separately confirmed, exact-file Restart: keeps uncertainty truthful and uses existing ownership and positive exit boundaries.

## Decision Outcome

Choose correlated text-admission receipts and document-local original recovery, without automatic resend. Keep Reconnect, but offer explicit Restart when native state is unanswered and the controlling editor has a positively owned runtime and exact saved conversation. Consent authorizes stopping that captured writer and resuming the same saved file; it does not claim idle or empty tool trees. Revalidate editor role, binding/runtime generation and saved identity, and prove the exact old root exited before replacement. A missing file, changed target, uncertain exit or failed complete draft capture refuses replacement.

Extend the existing bounded in-memory text handoff with pending-original and recoverable records. Capture is bound to the exact document/request/revision and freezes every document-local content mutation through destruction; in-flight reads/edits make it unavailable until settled. Cancellation or refusal releases the freeze. Restore originals exactly once as uncertainty cards, not submitted input. Image bytes remain within the old document under the existing contract; their loss requires explicit disclosure/consent, and restored text retains a reattachment warning. Native timeout/command feedback remains explicitly dismissible.

This narrowly amends ADR-0040's no-successor-after-uncontrolled-force boundary only for the new, separately authorized Restart action. Ordinary Force Stop, Close and automatic transport recovery still launch no successor. ADR-0039's owner/role policy and the exact-root proof are unchanged. No native package patch or cached-idle substitution is introduced.

Restart consent explicitly warns that commands/tools started by OMP may continue running separately and still modify files. The fallback applies only to an owned Chat/RPC generation with a committed saved binding; it does not weaken native Terminal survivor guards or authorize descendant termination. Root exit and tool-tree completeness remain separate facts.

### Amendment (2026-10-13): Restart when the attached process no longer serves the conversation

Decided by the user on 2026-10-13 after a re-adopted Chat failed with `identity-mismatch` while its process was still writing the bound file; it supersedes [ADR-0059](0059-clear-chat-in-place-through-a-desk-registered-omp-command.md)'s statement that Restart is not an identity-mismatch recovery (see that ADR's Amendments list).

A Chat that failed with `identity-mismatch` (the first `get_state` of a new session in this host, a fresh launch, a successor or a re-adoption, reports another session file, or a provider id other than the expected one) or `identity-diverged` (a later check, including an in-session Reconnect, found the same) had no in-place remedy: Reconnect is refused for both codes, so the only recovery was Kill or Stop in Sessions and opening the session again. Restart now covers both codes. `RpcSession.restartOffered` is true for an unanswered native state request (unchanged) or a failed session with one of the two identity codes; `ChatRuntime` and `restartChat` gate on it before and after consent. The banner carries a `restart` action for the identity codes and shows no Reconnect for them. A page that survived Restart Extensions has no panel handle and still gets no Restart, as ADR-0023 leaves panel-only operations unavailable to it.

The target checks are unchanged in substance. The row's recorded provider id is compared with the session's expected `#boundId`, and the row's file with its bound file, never with what OMP reported; the saved header must still carry the row's durable id; the old root must be proved gone; the successor resumes the row's own file. One check changes form: a session that fails before it ever goes live in this host (the common case right after Reload Window) has no committed bridge document, because a document is committed only against a live host. `restartBinding` then derives the same binding fields (owner generation; pid, child creation time, slot, broker id and generation from the runtime; the row's file and durable id) instead of reading a committed one, captures them before consent and requires an equal derivation after it; a committed binding is still used whenever one exists. The same applies to an unanswered-state Restart of a session that never went live. Nothing is committed to the bridge for a failed session.

Two identity failures are offered Restart but refused by these checks, by design: a bound file that disappeared (`identity-diverged` from the file check; the header read fails) and a provider-id acceptance that failed after `#boundId` had already moved (the recorded id no longer matches). Kill or Stop and reopen in Sessions remain their remedy. Restart stops with the authenticated force stop, as for unanswered state and Kill: a graceful stop first would need a second fallback path or confirmation and up to 30 s of waiting, and the consent already discloses the loss of unsaved work. Consent for an identity failure adds that the exact recorded process now reports another conversation or identity and that stopping it ends whatever it runs. `#identityMismatch` logs, per tab, the file and id OMP reported and the ones the tab expected; the two refused cases above fail without passing through it and are not logged there. Mismatch acceptance is not broadened: reattach still fails closed. An unanswered-state Restart of a re-adopted session that never went live may stop a process that was only slow; consent and the Reconnect next to Restart cover that. If the log shows OMP rotating provider ids on its own for the same file, Restart would become a recurring step; accepting such rotations would reverse ADR-0059 and needs its own decision.

### Consequences

- Positive: uncertain input remains inspectable and editable; recovery has explicit user intent and preserves the saved conversation.
- Positive: the original ownership, credential-incarnation and exact-file launch conventions remain the only lifecycle controller.
- Negative: admission can be delayed by native serialization, and Restart can interrupt useful work. The notice cannot identify the unknown original dependency.
- Negative: existing text-only handoff cannot preserve image bytes. Complete bounded text capture and disclosed attachment loss are required before document replacement; larger or invalid captures refuse instead of truncating.

## Related Documents

[Native RPC recovery design](../designs/2026-10-08-native-rpc-recovery.md), [ADR-0038](0038-host-chat-over-rpc-ui-on-a-broker-pipe-child.md), [ADR-0040](0040-switch-one-editor-between-rpc-chat-and-native-pty.md), [ADR-0039](0039-refuse-only-on-a-verified-live-writer-the-extension-owns.md), and [queued message editing](../designs/2026-10-07-edit-queued-messages.md).

## Architecture Review

- Reviewer: separate read-only architecture specialist.
- Outcome: accepted with two material conditions, resolved in the implementation.
- Notes: complete source/document/request-bound composer capture freezes through destruction, refuses unfinished reads/edits, and restores originals once without submission. Consent explicitly discloses separately surviving tools and file effects. Native Terminal ownership/survivor and exact-root boundaries remain unchanged. Focused and installed acceptance are separate.
- 2026-10-13 amendment: accepted after independent architecture review (two rounds, read-only; no executable checks by the reviewer). Round 1 found three material issues: Restart was refused for the motivating post-Reload identity failure, because a session that never goes live in this host commits no bridge binding; the amendment overstated coverage and logging; ADR-0059 was rewritten in place without recording the decision. All three are resolved: `restartBinding` derives the same binding fields from the row and the runtime when none was committed (rechecked after consent; a committed binding is still preferred), the two refused identity cases and the force-stop rationale are documented, and ADR-0059 keeps its text with a dated Amendments entry. Safety is unchanged: only the exact recorded process is stopped, the successor resumes the row's own file, and nothing OMP reports is accepted or recorded.
