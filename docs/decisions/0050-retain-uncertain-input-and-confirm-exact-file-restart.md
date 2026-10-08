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
