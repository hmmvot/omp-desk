---
status: accepted
date: 2026-09-25
---

# Restore OMP editor tabs through VS Code's webview lifecycle

## Problem

The session index retains logical sessions, but its startup pass cannot preserve which WebviewPanel editors were actually open, their groups, or their selection. It creates panels only after native session restoration succeeds. A full VS Code restart may therefore lose open editors, and a failed or slow native restore can leave no editor at all. An earlier handoff prevented one same-window duplicate restore but did not solve editor persistence.

## Goals and Non-goals

- Restore open OMP editor identities in their original VS Code groups; leave explicitly closed editors closed and do not steal focus from other editors.
- Keep an editor present with an honest loading, draft, blocked, or failed state when native ownership or relay recovery is unavailable.
- Preserve the single-writer claim, exact-session identity, and the existing policy of reconciling indexed native hosts on startup.
- Persist no Collab capability link, credential, transcript, or runtime snapshot in VS Code webview state.
- Do not guess which editors were open in an older extension build that never serialized them. Users reopen wanted rows once after upgrading.

## Current State

`src/extension.ts` registers a launcher, captures indexed tab IDs and restores native sessions before creating panels only for successful restores/attachments. `retainContextWhenHidden` preserves a hidden document within a running window, not across a full restart. Neither a `WebviewPanelSerializer` nor webview `setState` exists. `SessionIndex` includes rows for editors explicitly closed by the user and cannot be used as a journal of open VS Code editors.

## Proposed Design

VS Code owns open editor existence, group, position and selected editor. `SessionIndex` owns logical tab ID, original session file, native host evidence and claim. The extension's in-memory map owns the current panel and host handle. Register `onWebviewPanel:omp.session` and a serializer for `omp.session` at activation. The existing single-acquisition guest bridge stores only `{ version: 1, tabId }`, obtained from extension-authored bootstrap identity, before requesting a link, including in a loading or failed document.

Deserialization validates state against the current workspace index and immediately adopts VS Code's supplied panel: install its listeners and a restrictive loading or noninteractive error document, then complete the serializer callback **without waiting** for native ownership or relay readiness. A relay-unavailable document has no network permission until the exact assigned relay is known. Both new and revived panels share guarded disposal, CSP-bound content and guest readiness. Unknown or stale state never guesses a row or launches a host. Activation still reconciles native ownership once, but no longer creates or focuses editor panels from every indexed row. Each bound panel reads the current host and latest settled outcome and listens for later native or relay transitions, including startup already settled before lazy deserialization; loading must resolve into actual connected, draft, blocked or failed state rather than stay generic forever. Deserialization and explicit clicks join one in-flight native operation, never interpret failure as owner absence, and do not independently release a claim. Explicitly opening an eligible draft still uses its established user-intent launch path even if passive revival already bound a panel.

The New Session command reserves its draft identity and presents a loading editor before awaiting relay readiness or host launch. A failed relay leaves that indexed draft and visible editor retryable rather than making the chat seem not to exist; the existing claim gates still decide whether a later launch is safe.

A saved hidden editor may deserialize lazily after an explicit launcher click created a transient panel for that same tab. The first valid saved editor to deserialize replaces the transient panel, reuses its native operation and retires it with identity-guarded cleanup. If VS Code restarts again before this happens, both the previously hidden saved editor and the transient panel can themselves be saved with the same tab ID. In that duplicate-saved case the first valid deserializer callback wins, later duplicates are retired without a second host, and the original group cannot be guaranteed because the earlier saved editor may not have been first to become visible. Otherwise original editor placement is preserved. Duplicate placeholders, potentially persistent across an intervening restart, and unsent transient composer text loss are accepted limits of this minimal policy.

## Alternatives

Recreating all indexed panels repeats already-closed editors and cannot recover editor groups. An extension-owned open-editor journal duplicates VS Code's lifecycle and cannot reliably distinguish shutdown disposal from user closure. Persisting full guest/connection state leaks a write-capability link and risks replaying obsolete authority.

## Risks and Open Questions

VS Code invokes deserialization when a saved editor first becomes visible, so there is no global completion barrier. Panel binding and asynchronous callbacks must check exact panel identity; a close during native recovery must not recreate an editor or stop a different panel's recording. On a duplicate-saved collision the first deserialized editor's group, not necessarily the original hidden editor's group, wins. Old builds persisted tab IDs in the index but not webview-to-tab bindings or editor membership, so first-upgrade restoration cannot reconstruct historical open-editor membership. Real-window acceptance is required before claiming the restart behavior is verified.

## Rollout and Verification

Share identity and panel binding between creation and deserialization, remove startup-created panels/focus replay, retain native reconciliation and claim gates. Test identity-only state persistence, stale identity rejection, lazy and repeated-restart duplicate panel convergence, and exactly one native attempt. In an isolated VS Code window keep at least two OMP editors open in different groups, explicitly close a third OMP editor, and select an ordinary text editor before fully restarting. Check that text-editor focus and the two saved OMP editor memberships/groups remain; then select each saved OMP editor to force lazy deserialization and verify its exact session identity and a usable guest or bounded failed/blocked state, while the closed one stays closed. Separately exercise a launcher click before lazy deserialization, another restart before duplicate convergence, closing an editor during pending native recovery, relay failure, and a passive draft followed by explicit opening; none may start a second native host. Exercise a long transcript joining with latest messages initially visible. Typecheck, full suite, build and VSIX installation follow; no live GUI check uses the user's ordinary window.

## Related Decisions

- [ADR-0019: Let VS Code own the persistence of OMP editor panels](../decisions/0019-vscode-owns-omp-editor-persistence.md)
- [ADR-0015: Serialize one tab's lifecycle through a per-tab gate](../decisions/0015-serialize-tab-lifecycle-through-one-gate.md)
- [ADR-0018: Resume imported OMP history under extension-scoped claims](../decisions/0018-resume-imported-history-under-extension-claims.md)

## Architecture Review

- Reviewer: independent architect
- Outcome: accepted after corrective re-review
- Notes: M1 (serializer completion and settled result), M2 (repeat-restart duplicate precedence and group limit), and M3 (multiple open editors, lazy callback and failure acceptance) were resolved and independently confirmed. This accepts the design, not unverified runtime behavior.
