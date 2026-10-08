---
status: implemented
date: 2026-10-08
---

# Preserve uncertain input and explicitly restart an unresponsive RPC session

## Problem

Native transcript events can continue while RPC commands remain unanswered. Reattaching the same process repairs transport loss, but does not necessarily repair its command dispatcher. A successful page post or broker write acknowledgement is not proof that OMP admitted a message. Clearing that draft or briefly displaying a timeout can lose the only usable copy of uncertain input.

## Goals and Non-goals

- Keep text and attachments editable until a correlated admission result; prevent duplicate submit routes while awaiting it.
- Distinguish refused input from uncertain delivery, retain the original when later edits change the draft, and never resend automatically.
- Retain a truthful, explicitly dismissible recovery notice across state reconciliation.
- Keep same-process Reconnect available. Offer a separately confirmed Restart for an unanswered state request when the controlling editor has an exact saved conversation and positively owned runtime.
- Preserve the saved conversation, the current draft and pending/recoverable text before replacing the document. Refuse replacement when complete bounded text capture fails. Disclose and obtain consent for attachments that the existing text handoff cannot carry.
- Do not patch OMP, infer native idle from streaming activity, automatically terminate a process, weaken ownership/role checks, or launch a successor before exact-root exit is proved.

## Current State

OMP 18.6.3 starts ordinary commands and user-input handlers through one serial dispatcher tail. User-input admission is backgrounded only after its handler starts. A pending earlier command can therefore delay both state reads and later input while independently emitted transcript events continue. State reads await goal reconciliation; model reads await registry refresh. Neither source inspection nor the affected conversation identifies the first blocking dependency. A successful long-tool scenario is a counterexample, not evidence that a reported wedge was repaired.

The extension has same-process Reconnect and an explicitly confirmed Reload. Reload requires live state, confirmed abort and settlement, so it cannot recover a dispatcher that cannot answer those requests. Existing authenticated Force Stop can end an exact owned writer without those native RPC prerequisites, with separate consent and truthful exit evidence. Ordinary force Stop still does not automatically reopen a session.

Document handoff now carries bounded current, pending-original and recoverable text with attachment counts, not image bytes. Bridge document credentials cannot be rebound to a new incarnation, so Restart captures and holds the source before replacing its document.

## Accepted Design

### Admission and uncertain input

The host replies to the submitting page with `omp:chat-send-result`, correlated by the page's request id. Status is accepted, refused or unconfirmed; it carries no arbitrary diagnostic prose. Admission is distinct from the later native `prompt_result`. Once submitted, a routine epoch change does not erase correlation. A bounded client deadline reports uncertainty, never retries and never manufactures native queue state.

The composer retains the submitted draft and images while allowing edits and Stop. Only accepted admission can clear a draft, and only if its revision is unchanged. A refused edited message or any unconfirmed message gets a recovery card containing the original text and retained image payload. Add to draft reuses the existing append-and-renumber merge without overwriting new work; an identical still-held message is not duplicated. Dismiss is explicit. Native command feedback likewise remains until dismissed; transient model/thinking control feedback retains its own existing lifecycle.

### Text handoff

The in-memory draft capture/reply/restore contract carries pending-original and recoverable text records, attachment counts and uncertainty status. The aggregate text bound and control-character rules remain; records are bounded and validated on both boundaries. Never trim a capture into apparent completeness. A pending admission is captured as uncertain. Restore creates recoverable cards, not automatically submitted text. Current draft restoration remains separate from those records.

Capture is a short transaction bound to the exact document, request and content revision. Before any destructive stop, freeze document-local input mutation and capture the complete state. Pending image reads, IME composition, queued-edit replies or already deferred inserts make capture unavailable until they settle. While frozen, editing, attachment and recovery actions are disabled; input-admission completion cannot clear or duplicate a captured original, and programmatic insertion/prefill does not mutate the frozen draft. Cancellation, refusal or a failed stop releases the transaction and restores ordinary editing. The host rechecks the same document and binding before disposal; it never treats a stale earlier snapshot as the content now being destroyed.

The handoff does not persist content in Webview state, logs or disk. Image bytes remain document-local under the existing contract. Restart discloses their loss before consent; restored text retains a persistent reattachment warning. A missing, invalid, oversized or unanswered capture refuses Restart while the original document remains available.

### Explicit Restart

A validated page action follows the existing Resume lifecycle-event route, rather than a second process controller. A failed state-read notice offers Reconnect and Restart, retaining Restart through same-native resynchronization and clearing it after authoritative recovery. Continued transcript output does not prove command responsiveness. The host revalidates the controlling editor, committed binding generation, same runtime generation, exact saved file and readable session header before and after consent.

The Restart confirmation explicitly authorizes ending the captured unresponsive writer and resuming that same saved conversation. It warns that uncertain input may already have been admitted, in-flight tool effects or unsaved replies may be lost, and commands/tools started by OMP may continue running separately and may still modify files. This fallback is limited to the owned Chat/RPC generation and its committed saved binding; native Terminal survivor guards are unchanged, and no descendant is terminated. Use the existing authenticated broker stop and exact-root exit proof without requiring another native state read or abort acknowledgement. If exact writer exit cannot be proved, retain the current view and report the refusal; no successor is launched. Successful replacement retains the held claim and uses the existing exact-file launch/index replacement path. No automatic retry or replacement follows ordinary Stop, Close, transport recovery or an uncertain exit.

## Alternatives

- Treat page delivery as admission: rejected because transport acceptance does not establish native acceptance.
- Retry uncertain input: rejected because a delayed admission could duplicate it.
- Reconnect forever: retains a useful transport recovery path but cannot promise dispatcher recovery.
- Route the failed banner to existing Reload unchanged: rejected because its live-state prerequisites are precisely what failed.
- Automatically kill and relaunch: rejected; process and tool effects require explicit consent and positive exit evidence.
- Rebind credentials to keep the old document alive: rejected; the existing incarnation boundary remains unchanged.
- Add image-byte persistence or a new chunked attachment handoff: outside this change; the existing disclosed attachment boundary is retained.

## Risks and Open Questions

The reported incident's first unanswered command is unknown. Controlled finite dependency pauses demonstrate the dispatch boundary, not the original cause. Do not suppress legitimate state/catalog reads based only on that hypothesis. The process may still be doing useful work; Restart is explicit and explains its effects. Input captured while an acknowledgement is pending remains uncertain even if OMP later admits it. Full bounded text capture is a precondition, not an optimistic warning after destruction.

## Rollout and Verification

The DTO, client, composer and host routes were migrated together. Typecheck passed, and 430 focused tests passed across the initial seven-file feedback and repaired lifecycle/browser fixtures. They cover correlated admission, draft revisions, original recovery, complete frozen handoff, delayed edits and lifecycle refusal/consent/root-exit boundaries. Runtime acceptance used a fixed copied extension in one isolated development-host window with a copied OMP 18.6.3; it is not an installed VSIX claim. No main user session was a test target.

### Controlled native dependency evidence

A private content copy of OMP 18.6.3 held one catalog dependency for 40.002 seconds while 43 genuine tool-update frames continued. State and input responses did not arrive during that hold. Releasing it recovered the same process: catalog response in 5 ms, state in 25 ms and prompt admission in 26 ms; its prompt result completed 9.563 seconds later. The global native package remained unchanged. This demonstrates serial-dispatch head-of-line blocking and non-destructive recovery when a dependency resolves; it does not identify the reported incident's first blocking command or prove the extension's Restart acceptance. No unsupported suppression of catalog/state reads is introduced.

### Isolated development-host acceptance

All 15 runtime acceptance checks passed. A genuine unanswered state request retained the latest draft and uncertain original, with truthful Reconnect and Restart actions. Cancelling the actual Restart confirmation kept the same native root, saved conversation and guest document, released the capture freeze and preserved input. Finite dependency release recovered that same process.

A separately accepted Restart proved the exact old root exited before its successor started, reopened the same saved file and session history, and restored the latest current text and both uncertain originals into a fresh document. The first original had eventually been admitted once; the second was still blocked when the old root exited. The successor emitted no prompt frames, and saved-history counts showed no replay. The actual confirmation disclosed separately surviving tool/file effects.

One private helper error and two observer/selector false negatives were reconciled without changing product code, resubmitting uncertain input or repeating accepted Restart. Every tracked owned process and window was cleaned up, private authentication database sidecars were deleted, and all 3,151 global native package hashes remained unchanged. This proves controlled recovery behavior, not the original incident's unknown dependency or kernel-enforced tool-tree containment.

## Related Decisions

[ADR-0050](../decisions/0050-retain-uncertain-input-and-confirm-exact-file-restart.md), [ADR-0038](../decisions/0038-host-chat-over-rpc-ui-on-a-broker-pipe-child.md), [ADR-0040](../decisions/0040-switch-one-editor-between-rpc-chat-and-native-pty.md), [ADR-0039](../decisions/0039-refuse-only-on-a-verified-live-writer-the-extension-owns.md), and [queued message editing](2026-10-07-edit-queued-messages.md).

## Architecture Review

- Reviewer: separate read-only architecture specialist.
- Outcome: accepted with two material conditions, resolved in source; focused checks and isolated development-host runtime acceptance complete. Installed VSIX acceptance was outside this package.
- Notes: complete composer capture is bound to the exact source document/request through destruction, refuses unfinished reads/edits and freezes delayed admission/prefill/inserts. Confirmation explicitly discloses independently surviving tool/file effects. Ownership, exact-file, root-exit and credential-incarnation boundaries remain unchanged.
