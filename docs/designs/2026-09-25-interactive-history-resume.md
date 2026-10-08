---
status: implemented
date: 2026-09-25
---

# Open OMP history in the native GUI through an extension-scoped claim

## Problem

A History row currently becomes an indexed `unmanaged` Sessions row on first click, but both clicks open a read-only text document rather than the OMP chat. This contradicts the user's confirmed contract: the extension opens any valid OMP session; it excludes duplicate writers **among its own windows**, while a concurrently running OMP outside the extension remains the user's responsibility. The original always-read-only rule was a response to a demonstrated external-writer collision, but it imposed a guarantee that the accepted extension-only claim cannot provide and removed the expected interactive workflow.

## Goals and Non-goals

- A History click opens the normal full-control editor Webview and an initially hidden native OMP host resumed by that row's exact JSONL path. A subsequent click on its indexed Sessions row reveals the same GUI tab, not a transcript document. Already persisted adopted rows become eligible without losing tab identity, session file, recorded profile or session directory.
- A restart restores an imported session through the same claim/reconcile/attach/launch path as an extension-created saved session. An extension-owned live writer, uncertain earlier extension launch or competing extension window remains a conflict; one file never gets two writers from this extension.
- No veto based solely on a possible external OMP writer: its process cannot be identified reliably by this extension's claim/recorded-host evidence. The user explicitly accepts responsibility for external concurrency.
- Preserve the existing provenance boundary for destructive history deletion; opening a foreign session for chat does not silently authorize deletion of its native transcript. Do not change native OMP or infer ownership from cwd, session ID or process lists.

## Current State

`HistoryTreeItem` runs `omp.openHistorySession`; `trackSession` retains the exact file and scope but records `origin: unmanaged`, no ownership and `read-only` availability. `openHistorySession` calls `openReadOnlyHistory`, which opens an `omp-session-readonly:` text document. Clicking its indexed Sessions row calls `openTab`, which diverts `unmanaged` back to the same document. The index's classification and `#openEntry` also refuse any claim or launch for this origin. Closing and forgetting adopted rows assume no writer of this extension ever existed. A persisted adopted row is forced read-only at load, regardless of its actual host record. The active product contract in `docs/product.md` accepts extension-only writer exclusion and explicitly leaves external OMP concurrency with the user; prior design/ADR prose claiming always-read-only conflicts with that contract and the user's correction.

## Proposed Design

Keep an origin/provenance bit distinguishing an imported file from a file this extension created; it is **not** an interactive-permission bit. On History click, retain `trackSession`'s exact-path lookup (including profile, cwd and parent session directory), but repeat the lookup after asynchronous header reading and insert synchronously so overlapping first clicks converge on one tab ID. Then call the common `openTab` route. Remove the read-only text-document branch/provider and dead transcript-only helpers. The normal panel is created before restore so an ownership conflict remains visible in GUI without starting a second host.

An imported entry receives its own persisted owner generation before the first claim. Migrate existing imported entries without changing their tab ID, exact path, profile or directory and without discarding recorded host/claim evidence from legacy entries. The index takes the same canonical-path claim with a per-extension-host holder as any other saved tab and reconciles **its own** recorded host. Before invoking the native launcher, persist a launch-pending record for that claim; if persistence fails, do not launch. A claim with an unaccounted launch attempt is not `no-recorded-host` evidence, even if the original extension window died and its holder can be replaced. Reconcile or fail closed rather than starting a second writer after an interrupted spawn. Only a fresh import with no previous launch attempt or a recorded, safely reconciled extension host may launch `omp --resume <exact file>` or attach. Its absence evidence says nothing about external OMP writers. A second extension window with the same persisted generation but a different live holder is refused. Close and Forget must release or retain claims by actual extension-writer state, not import provenance; deletion remains guarded by provenance independently.

Rows display Running/Saved/Blocked according to actual extension state, even for imported sessions; History discovery stops showing the file once indexed. Remove read-only-only accessibility text and the document command. Do not add a second native launcher or a fallback to a new empty session. Native OMP remains the sole writer of its transcript, and the GUI remains the existing Collab guest of that host.

## Alternatives

- Keep the text document or render it as a read-only chat: does not satisfy the required interactive continuation.
- Ignore claims for imported files: permits two windows of this extension to write one JSONL and violates the accepted guarantee.
- Block when an external OMP process appears to be running: process/Collab observations cannot prove that a particular arbitrary JSONL is held, and the user explicitly owns that risk.
- Reclassify every imported row as extension-created: makes destructive deletion eligible merely because the user opened a conversation; provenance must stay separate.

## Risks and Open Questions

A user may concurrently resume the same file in OMP outside the extension; this is accepted and must not be represented as prevented. An old extension-owned claim/host record may be unresolved; the extension must not discard it to force a launch. An already open read-only editor from the previous version may remain until closed; future clicks must focus the GUI rather than reopening it. No behavioral choice is left open.

## Rollout and Verification

1. Migrate the indexed import/restore lifecycle and all callers; remove obsolete read-only document routing and incidental text/tests. Preserve exact file/profile/session directory through launch and on restart.
2. Replace behavior tests that pinned read-only import with tests for first History click's indexed entry, overlapping first clicks converging on one tab ID, repeated click, restore of already persisted adopted rows, exact resume request, extension-window claim conflict, interrupted spawn-before-outcome and failed launch-pending persistence, and cleanup of a successfully stopped imported host. Preserve foreign-file deletion refusal.
3. Run typecheck, complete tests, build and VSIX packaging. Exercise the installed VSIX in an isolated VS Code profile by importing an owned test session file through History and observing the full GUI and a native reply; verify the second click focuses the same tab and a competing extension window is refused. Do not inspect/control the user's ordinary VS Code window without fresh explicit computer-control permission. Install the proven VSIX into the ordinary profile and verify the extension listing.

The installed VSIX was exercised in a protected isolated VS Code 1.139.0 profile against native OMP 18.3.0: a new History row for an owned JSONL moved into Sessions, opened one full-control Webview and resumed the exact file; a prompt sent through that Webview returned `HISTORY-GUI-OK`. A second click kept one editor; reopening that workspace restored the Running tab; a second window of the same profile, on a different workspace, displayed Blocked for the same file while the first stayed Running. The complete suite passed (638 passed, one skipped), and typecheck/build/packaging succeeded. An initial profile under a writable repository directory was refused by the existing private-storage ACL guard; the successful acceptance profile lived under the account's protected per-user application-data directory.

The earlier isolated run did not exercise clicking a saved row **while** its restart restore pass was still in flight. A user subsequently reported that precise overlap in the ordinary profile: the explicit click received the index's same-window duplicate refusal before the automatic pass published a panel. The repair makes explicit opening wait for the activation cohort's complete restore-and-panel handoff; it does not weaken the index's duplicate refusal or the cross-window claim. Source tests cover the pinned restore cohort and the existing in-flight duplicate guard; real-window restart/click acceptance for this repair must be recorded separately from the earlier run.

## Related Decisions

- [ADR-0018: Resume imported OMP history under extension-scoped claims](../decisions/0018-resume-imported-history-under-extension-claims.md) (accepted).
- [ADR-0011: Installed OMP without a version gate](../decisions/0011-use-installed-omp-without-version-gate.md) (superseded; original incident and surviving runtime invariants retained by ADR-0018).

## Architecture Review

- Reviewer: separate architect.
- Outcome: reviewed; P1 (durable launch-pending recovery) and P2 (concurrent import identity) addressed in the design before acceptance.
- Notes: The review approved the corrected invariants; the isolated installed-VSIX scenario above is separate implementation acceptance evidence.
