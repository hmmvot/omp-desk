---
status: accepted
date: 2026-10-07
---

# ADR-0045: Derive window folders per window and pin them under identity-derived ids

## Context and Problem Statement

Sessions should show the folders VS Code has open without the user adding them, while the durable, profile-wide folder list (ADR-0034) keeps its meaning. Three things must hold at once: a folder open in one window must not appear in other windows or outlive its workspace unless the user says so; a folder must keep one id and one tree row when it moves between "open" and "pinned"; and a folder both open and pinned must appear once.

## Considered Options

- **Derive per window, pin by registering under an identity-derived id.** The displayed list is recomputed per window from VS Code's folders, the pinned list and live sessions. A folder's id is a hash of its filesystem identity, and Pin stores the record under that same id. No window folder is persisted; no id mapping is stored; existing pinned records keep their random ids and are matched by path.
- **Auto-pin every opened folder.** One list, but every opened folder would leak into every window and stay forever; removes the difference between "open here" and "kept".
- **Window folders with random ids plus a path-to-id map.** Needs a second store and still changes the node id when the folder is pinned unless the map is rewritten atomically with the catalog.
- **Rewrite stored ids to the derived form (migration).** Clean ids everywhere, but a catalog migration across windows of different builds for no behavioral gain.

## Decision Outcome

Derive per window; pin under the identity-derived id (first option). `windowFolderId(path)` is `folder:` plus the first 32 hex characters of SHA-256 over `folderIdentityKey(path)`; every new pinned record uses it, so Pin, Add and a folder registered after a new session all mint the same id for the same directory in every window. Pins of one folder from two windows carry the same id and merge to one record in the keyed catalog merge. The merge reports no conflict for a record equal to the other side's (this relaxation applies to every keyed collection that uses it: folders, editor-slot bindings and shell slots; session rows keep the old rule); a concurrent pin that differs in the stored path spelling or the collapsed flag records one conflict entry and the last writer wins. A record minted by an earlier build keeps its id and is matched to an open folder by path identity; unpinning such a folder while it is open gives its node the derived id once, carrying its collapsed state across. A live-session folder whose recorded working directory is a spelling that string folding cannot match to a shown folder (a junction) gets its own heading under an alias id, so ids in the list are unique. Collapsed state is durable for pinned folders and per-window (workspace state) for the others. Remove is merged into Unpin because both only drop the pinned record.

### Narrow amendments to earlier decisions

- **ADR-0020 and ADR-0025 (explicit-only folder membership).** Sessions no longer lists only folders the user added: the open folders of the current window appear as well, per window and never persisted. Everything else in those decisions stays: folder navigation is separate from session ownership, removal (now Unpin) is metadata-only, and a folder is never a writer.
- **ADR-0034 (profile-wide collapse state).** Collapsed state stays profile-wide for pinned folders only; unpinned folders keep it per window. The folder list stays one transactional catalog key for pinned folders.
- **ADR-0039 (Blocked with Stop).** A verified live rival holder is shown as its own row state, **Open in another window**, instead of the generic Blocked. The refusal rule is unchanged (only a verified live writer excludes admission, and Stop on the rival's recorded host stays available), and the safety rules of claims are untouched. One addition: Open and a click on such a row show a short message that the session is open in another window instead of attempting the open, because the row says the holder is known. This is a message shortcut over the same claim read, not an authority; the claim is re-read first, and every other launch path still passes through claim admission.

### Amended by ADR-0056

[ADR-0056](0056-publish-window-state-in-a-leased-registry-and-switch-windows-by-request.md) changes three things above. (1) Window folders are still never persisted or pinned automatically, but every window publishes its own in an expiring registry record and every window shows the union, in window-start order; "per window" now describes where a folder is open, not who sees it. (2) The message shortcut for **Open in another window** rows is gone: Open and a click switch to the owning window at once, with no message, no confirmation and no Switch to Window button; a message appears only when switching is impossible, and says why. The claim is still re-read first and nothing is launched. (3) `omp.showWorkspaceFolders` and `omp.useAgentRootFolder` are application scoped. Unpinned-folder collapse stays per window.

### Consequences

- Positive: Pin never changes a row's id or a command argument; no migration; no extra store; two windows pinning the same folder converge on one record, and a conflict is recorded only for a concurrent pin that differs in spelling or collapsed flag.
- Negative: a re-added folder gets back its former id, so a stale argument from before an unpin resolves to the re-pinned folder (the same directory); legacy-id folders change id once if unpinned while open; every folder list read folds paths through the filesystem (the cost the folder registry already paid on Add).

## Related Documents

- [Window folders, pinned folders and the "Open in another window" row state](../designs/2026-10-07-window-folders-and-other-window-state.md)
- [ADR-0020](0020-separate-folder-navigation-from-session-ownership.md), [ADR-0025](0025-bind-editor-slots-to-current-conversations.md), [ADR-0034](0034-store-sessions-in-one-profile-catalog.md), [ADR-0039](0039-refuse-only-on-a-verified-live-writer-the-extension-owns.md)

## Architecture Review

- Reviewer: architect
- Outcome: accepted after fixes
- Notes: The review found the model sound and asked for the supersession of ADR-0020/0025/0034 and the ADR-0039 amendment to be recorded here, unique ids for live-session folders, identity-based comparison of live-session directories and the identity memory with its invalidation; all are applied and described in the design.
- Confirming review: a second architect review of the revised design and this record passed after its documentation fixes were applied (stale-state wording, the ADR-0025 reciprocal note, the merge-conflict scope, the number of ownership reads, the legacy-id and alias-heading edge cases). It found no blocker and confirmed that no ADR-0034 or ADR-0039 rule is weakened.
