---
status: superseded
date: 2026-09-25
---

# ADR-0019: Let VS Code own the persistence of OMP editor panels

## Context and Problem Statement

The workspace session index records native OMP sessions, including ones whose editor was closed. It has no evidence of editor membership or groups. Its startup reconciliation cannot preserve editor placement and delays or omits panel creation when native restoration fails. VS Code provides `WebviewPanelSerializer` and webview `setState` for preserving an editor across process restarts, independently of the lifetime of the native OMP host. No stored state may contain a Collab link or other control capability.

## Considered Options

- Reopen every indexed session panel after restart: cheap but reopens explicitly closed editors, loses layout/selection and ties UI existence to successful native restore.
- Persist an extension-owned open-editor registry: duplicates VS Code's lifecycle and cannot reliably treat process shutdown differently from an explicit panel close.
- Use VS Code's `WebviewPanelSerializer` with a versioned, identity-only state object: preserves actual open editors and layout without using their state as native host authority; requires coordinated adoption and lazy-deserialization collision handling.

## Decision Outcome

Use the VS Code serializer. The guest persists exactly `{ version: 1, tabId }` from extension-authored bootstrap data through its single `acquireVsCodeApi` instance. Deserialization validates the ID against this workspace's session index, adopts VS Code's supplied panel and never initiates an independent native restore. VS Code owns editor existence and layout; `SessionIndex` remains authoritative for tab/session identity, owner evidence and claims. The activation pass may reconcile native hosts but may not recreate/focus all indexed editor panels. An editor remains visible with bounded loading, draft, blocked or failed state when host recovery is unavailable.

A lazy serializer callback can race explicit opening of the same indexed row. The first valid saved editor to deserialize takes precedence over a transient explicitly created panel and adopts its existing in-flight native operation; the transient panel is retired with guarded cleanup. If both panels are themselves saved by another restart before convergence, the first valid saved deserializer wins and later duplicates are retired without another native operation. This exceptional ordering may preserve the transient panel's group rather than the older original group. Temporary or persistent duplicate placeholders and unsent transient composer input loss are accepted, but a second native writer is not. Older builds persisted tab IDs in the session index but did not bind an open webview to its tab ID or record editor membership; do not infer open editors from index membership. The user can reopen wanted rows once after upgrading.

### Consequences

- Positive: VS Code restores the panels it actually had open in their groups while native recovery and cross-window ownership remain independent.
- Positive: explicitly closed editors stay closed; a failed native restore does not erase an editor.
- Negative: first-upgrade editor membership cannot be migrated from the older index; a transient explicit panel can be replaced by a lazily restored editor, and a duplicate-saved collision can preserve the first deserialized panel's group rather than the older original group.
- Constraint: no links, tokens, transcript, runtime snapshot or other capability-bearing state may be written to webview persistence.

## Related Documents

- [Restore OMP editor tabs design](../designs/2026-09-25-restore-native-editor-tabs.md)
- [ADR-0015](0015-serialize-tab-lifecycle-through-one-gate.md)
- [ADR-0018](0018-resume-imported-history-under-extension-claims.md)
- [ADR-0023](0023-reconnect-surviving-webviews-through-an-authenticated-bridge.md) supersedes only unconditional supplied-panel adoption for one-time migration of a validated legacy generic editor. VS Code still decides actual editor membership and normal serializer revival; the replacement exception may change order/pinning or discard unsent input, and an overlapping close cannot have a strict close-wins guarantee through public APIs. The original serializer/identity-only rationale above remains the default for all other panels.
- [ADR-0025](0025-bind-editor-slots-to-current-conversations.md) additionally narrows saved-editor duplicate arbitration to representations of the **same immutable editor slot**: a distinct passive B editor may preserve its unsent draft while the initiating A editor controls a verified B binding. VS Code continues to own both editors' existence; neither the index nor native process conjures a panel.

## Architecture Review

- Reviewer: architect
- Outcome: accepted after independent review
- Notes: The reviewer found no material issue with the authority split, identity-only state, lazy collision policy or migration limit; clarified that the prior index already stored tab IDs. Review covers the decision, not runtime acceptance.
