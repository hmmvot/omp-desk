---
status: superseded
date: 2026-09-25
---

# ADR-0020: Keep user-added folder navigation separate from session ownership

## Context and Problem Statement

A user-added folder groups OMP sessions for navigation, but it is not a native OMP session or a writer. The existing index retains rows after an editor closes; VS Code alone persists actual open tabs ([ADR-0019](0019-vscode-owns-omp-editor-persistence.md)). OMP history files also live under profile-specific roots rather than necessarily inside their recorded working folder, and imported files must use the exact-file claim path ([ADR-0018](0018-resume-imported-history-under-extension-claims.md)). The sidebar must therefore represent user-added folders and current open editors without making either into an alternative session index.

## Considered Options

- Keep a small, workspace-scoped, versioned folder registry; project open editors under matching folders; query history on explicit Resume. Preserves one owner for each identity, but needs a deliberate folder picker and an exhaustive on-demand scan.
- Derive folders from every durable indexed session, and place History in the tree. Requires no new registry, but silently re-adds folders the user removed, displays closed tabs as running, and mixes discovery with editor membership.
- Persist a second open-tab/history database per folder. Makes local enumeration cheap, but cannot accurately track VS Code close/restart and external OMP file changes without competing lifecycle authority.

## Decision Outcome

Use a separate versioned folder registry in `context.workspaceState` for explicit folder membership, display order and presentation-only native tree collapse. The ordered records contain stable folder IDs, usable absolute paths and a collapsed flag, but no session IDs, host handles, transcript copies or claims. Its scope is the current VS Code workspace context. `SessionIndex` remains the only durable session identity and claim authority. VS Code WebviewPanel persistence remains the authority for open editors. Folder children project indexed rows only while their WebviewPanel is actually open, matching working directories by canonical equality. A folder-scoped, read-only scan resolves discoverable OMP roots and runs only when the user requests Resume; its selected exact file enters the existing `trackSession`/`openTab` path. Folder removal changes navigation only, never session lifetimes or disk contents.

### Consequences

- Positive: closed tabs and hidden history do not clutter the launcher; deleting a folder entry cannot destroy a session; existing cross-window claims and imported-session provenance remain intact.
- Negative: an open session in an unregistered folder is accessible via its editor but not shown in the sidebar. An exhaustive on-demand scan can be slower than a bounded cached History list and must disclose incomplete reads. The folder list does not automatically synchronize across unrelated VS Code workspace contexts.

## Related Documents

> **Narrowly superseded (proposed):** [ADR-0034](0034-store-sessions-in-one-profile-catalog.md) moves this decision to one profile-wide catalog. Its separation of folder navigation from session ownership, non-destructive folder removal and refusal to guess an unusable legacy cwd remain operative.

> **Narrowly amended by [ADR-0045](0045-derive-window-folders-per-window-and-pin-with-identity-ids.md):** the folder list is no longer only user-added folders. The current window's open folders are shown too (per window, never persisted) and the durable list is the list of pinned folders; Remove is Unpin.

[Workspace-folder launcher design](../designs/2026-09-25-workspace-folder-launcher.md), [ADR-0018](0018-resume-imported-history-under-extension-claims.md), [ADR-0019](0019-vscode-owns-omp-editor-persistence.md).

[ADR-0025](0025-bind-editor-slots-to-current-conversations.md) supersedes only explicit-only folder registration and open-editor-only child projection: a verified managed native switch can auto-add B's recorded folder, and indexed stopped rows remain visible. Folder metadata still has no native/session/editor claim authority, and Resume remains on-demand.

## Architecture Review

- Reviewer: independent architect
- Outcome: accepted after corrective clarification
- Notes: Initial F1 identified a contradiction between persisting collapse and restricting the registry to IDs/paths. Records now explicitly include presentation-only collapsed state; ownership and session data remain excluded.
