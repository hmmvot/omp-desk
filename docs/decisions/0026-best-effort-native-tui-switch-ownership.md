---
status: superseded
date: 2026-09-26
---

# ADR-0026: Treat user-initiated native TUI switches as user-controlled operations

> Further narrowed by [ADR-0039](0039-refuse-only-on-a-verified-live-writer-the-extension-owns.md): held-uncertainty clauses for extension-initiated actions are superseded; only verified-live extension ownership may exclude. User responsibility for external writers survives.

> Superseded by [ADR-0038](0038-host-chat-over-rpc-ui-on-a-broker-pipe-child.md): there is no native TUI in the chat editor and hence no user-typed native switch to treat as user-controlled. The user-responsibility stance for writers outside the extension is kept in the product context.

## Context and problem statement

The installed OMP host can run `/resume B`, `/new`, fork and other session-changing commands in its own native terminal. The user wants the same real process and editor to follow a successful native switch, while A remains a stopped session. OMP 18.3.0 offers an optional awaited `session_before_switch` hook and an early `session_switch` event, but its hook is fail-open on error/timeout and post-event precedes possible rollback. Universal file-writer admission would require changing OMP core. The user declined that change and accepted potential overlapping writes/corrupt history during native commands. On 2026-09-26 the user explicitly narrowed the product responsibility further: **what the user types into a native terminal is the user's responsibility; do not add more admission machinery or block deletion merely because another managed OMP might type `/resume`**. At most show an error, close or disable an evidently broken tab. Extension-issued New/Resume/Reload still have their independent exact-file ownership contract.

## Considered options

- Make a mandatory fail-closed pre-write OMP core guard: could exclude overlapping native writers, but changes the installed OMP and contradicts the user's choice.
- Add a complex global conflict-reservation ledger, proactively veto native commands or block all deletion while any managed host runs: still cannot prevent a fail-open native hook or an outside writer, and the user explicitly rejected additional control of native terminal actions.
- Observe native transitions, bind only on verified settled identity, retain ordinary extension-issued claims, and show a visible noncontrolling/error state for clearly conflicting tabs: preserves the user's terminal autonomy and keeps extension-initiated operations strict within what the extension can actually control. Chosen.

## Decision outcome

Do not veto a user-typed OMP session transition to impose an extension claim, do not claim atomic pre-admission of B, and do not maintain a new cross-window global conflict-reservation ledger. Observe the native transition, fence stale A GUI/host-control/editor-document requests and correlate a new target from **its actual native identity**; never infer the latest JSONL or map a missing file to a free null claim. An early `session_switch`, cached link or generic later snapshot is not a settled success. Installed OMP 18.3.0 starts a replacement Collab room after its internal transition barrier; a fresh live Collab registry IPC snapshot is served only when its room is current and the session is not transitioning. Correlate that snapshot to the same OS PID and creation time, newer room generation of the same Collab instance, authenticated host-control exact B identity and B's validated header. Durably commit editor-slot→B and A's stopped/retired intent with this witness before releasing A's prior claim or offering Resume(A). If no valid fresh witness exists, keep A blocked rather than declaring it safely resumable or starting another host. A later user-typed return to A is a separate native operation under the same user-responsibility boundary.

After a native transition, attempt to associate B with an available canonical extension claim using normal exact-file semantics. If B is already live elsewhere, fail to obtain its claim, or cannot be safely attributed, **do not replace the incumbent or claim its B row**. Show the newcomer tab as visibly conflicting/noncontrolling and display a fixed-category error naming the possible duplicate writer and damaged history. Its terminal process is not silently killed or its transcript magically repaired; the user may explicitly choose Close Session with confirmation, after which stop must target only the verified newcomer and auto-close only that tab after positive PID/room withdrawal. If the user leaves it running, further native writes remain the user's responsibility. Do not silently suppress this conflict or pass the incumbent's GUI authority to the newcomer. A TUI path with no prospective file (`/new`, fork, branch/tree) may already write before posthoc classification; reserve the observed source/process generation, then use the verified actual target when available. If exact attribution or native room evidence fails, show a blocked tab and do not launch a second extension writer to compensate.

Strict canonical claims, held uncertainty after unknown native process stop, at-most-once host-control requests, local-only Collab, document-generation fencing and exact-file extension-issued New/Resume/Reload continue to apply to actions **initiated by the extension**. Those claims cannot prevent a user-controlled native TUI from entering a file after the claim check, or an independent OMP from doing so. A deletion confirmation must warn that user-controlled native terminal commands and independent OMP processes can enter/write the file during deletion. Known live/held extension owners still block deletion, but mere existence of another unrelated managed OMP does not. No guarantee of universal writer absence or pristine transcript follows from a successful extension claim.

This narrowly supersedes unconditional extension-writer exclusion statements in ADR-0004 and ADR-0018 **for user-initiated native TUI transitions only**. Their ordinary extension-issued admission, imported interactive Resume, external-writer responsibility, security and host-control at-most-once provisions remain. ADR-0025 independently specifies the settled B→A retirement witness and editor binding; this ADR does not relax it.

### Consequences

- Positive: native OMP retains its commands, without unreliable attempts to own user keystrokes or block unrelated history deletion.
- Negative: two managed OMP processes may write the same JSONL before the extension observes the conflict, while the user leaves a conflicted process alive, or during deletion; the file or its artifacts can be lost/corrupted. This is expressly the user's responsibility for native terminal actions. Showing an error or disabling a tab does not undo earlier writes.
- Negative: with no settled room or unresolvable target, A/B control and Resume stay blocked until trustworthy evidence arrives or the writer stops. This is a truthful degraded state, not successful rebind.

## Related documents

[Sessions and in-tab terminal design](../designs/2026-09-26-sessions-and-in-tab-terminal.md); [ADR-0004](0004-best-effort-host-model-transitions.md); [ADR-0018](0018-resume-imported-history-under-extension-claims.md); [ADR-0025](0025-bind-editor-slots-to-current-conversations.md); [ADR-0027](0027-delete-discovered-history-under-exclusive-extension-claim.md).

## Architecture review

- Reviewer: independent architect (initial review, re-review and latest review).
- Outcome: accepted after the user's later explicit native-command responsibility clarification and fresh review of the revised choice.
- Notes: Earlier review of the stronger prehook/conflict-ledger alternative is superseded; this acceptance is not runtime proof of native switch detection.
