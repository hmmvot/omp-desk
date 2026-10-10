---
status: implemented
date: 2026-10-10
---

# One Sessions view across every window of the profile

## Problem

Sessions is meant to be one view of the profile's work, but today it depends on which window you look at.

1. **Different folders per window.** The folders VS Code has open are derived per window and never shared ([ADR-0045](../decisions/0045-derive-window-folders-per-window-and-pin-with-identity-ids.md)). A project open only in window B is absent from window A unless it is pinned, so A cannot show B's sessions.
2. **Different row text per window.** The window that runs a session shows its live status (Working, Needs your answer, Idle). Every other window can only say "Running · in another window", and it hides the unread mark.
3. **A click in the wrong window only explains.** Clicking a session another window holds shows "This session is open in another VS Code window" and a **Switch to Window** button. The user has to confirm, then find the tab; the confirmation is itself the annoyance.

## Goals and Non-goals

- Goals:
  - With the same display mode (flat or by folder) every window of the profile shows the same folders, the same sessions in the same order, and for each session the same row text and status icon. A session open in another window (relative to the viewing window) is marked by one extra badge after the status, never by a different row icon. The folder set is the union of the folders open in any live window (after agent-root substitution, deduplicated by path identity), the pinned folders and the folders of live sessions.
  - Other windows' folders look like this window's and like pinned ones: no separate section, label or icon. Which window holds a session or a folder is said in the tooltip.
  - A click or Open on a session another window holds **switches at once, with no notification and no confirmation**: the owner window comes to the front and selects the session's tab. A message appears only when switching is impossible, and says why.
  - A window that closes or crashes stops contributing its folders after a bounded delay, and nothing it published ever becomes a pinned folder.
- Non-goals:
  - No change to claims, session ownership, Stop's authority or the catalog's rules ([ADR-0034](../decisions/0034-store-sessions-in-one-profile-catalog.md), [ADR-0039](../decisions/0039-refuse-only-on-a-verified-live-writer-the-extension-owns.md)); registry data is advisory and never ownership evidence.
  - Window folders are still never persisted as pinned folders and never change VS Code workspace roots.
  - No Win32 foreground helper, no spawned process, no cross-window RPC channel.
  - Editors that only show history (no writer, no claim) are not routed across windows; see [Scope of switching](#scope-of-switching).

### What "identical" means

*Parity* is the equality of the **underlying rows and their presentation**: the same folders, the same sessions in the same order, and the same label, icon, description and accessibility text per session, derived from the same shared inputs. Permitted per-window differences are listed under [Per-window differences](#per-window-differences-that-remain): selection, the actions a row's menu offers, tooltips that name windows, the held-elsewhere badge after the status, Blocked (this window's own failed attempt), the collapsed state of an unpinned folder and a folder's Reconnect Terminal entry. Collapsing is window-local state that changes which rows are *visible*, not which rows exist; the user did not ask for shared expansion, and ADR-0045 already keeps it per window.

Parity is *eventual with a bound*, not instantaneous; the bounds are in [Convergence and expiry](#convergence-and-expiry).

## Current State

- The session list is already profile-wide: index entries live in the shared catalog and every window adopts changes through the catalog watcher (`src/host/profile-catalog.ts`). The read marker (unread) is shared catalog state.
- `LauncherFolders` merges this window's folders, the pinned folders and this window's live-session folders (`src/views/launcher-folders.ts`); `AgentRootResolver` substitutes an open folder's agent root (`src/views/agent-root.ts`).
- Claims carry the holder UUID, pid, creation time, an owner generation and the owner's saved-workspace or single-folder URI (`src/host/session-claim.ts`); `src/host/claim-watch.ts` watches the claims directory.
- A row another window holds is the `otherWindow` state. Its click showed a message and a **Switch to Window** button that called `vscode.openFolder(uri, { forceNewWindow: false })`.

## Proposed Design

### Window registry

Each extension host publishes one JSON record in the shared global storage of the profile, `<global storage>/window-registry/<holder id>.window`, where the holder id is the id its claims already carry:

| Field | Meaning |
| --- | --- |
| `version` | `1`; a reader ignores any other value |
| `holderId`, `pid`, `startedAt` | identity of the extension host that wrote it; `holderId` must equal the file name |
| `updatedAt` | the lease: last write |
| `windowUri` | the saved workspace or single-folder `file` URI, else `null` (same rule as claims); `null` is **authoritative** (see Focus) |
| `label` | the window's VS Code workspace name, for tooltips |
| `folders` | the `file` folders open in the window, in VS Code's order, **as opened** (before agent-root substitution) |
| `liveCwds` | working directories of the sessions this window runs or is launching |
| `rows` | `{ [tabId]: { status, incarnation, lastActivityAt } }` for the sessions this window runs; `status` is `starting`, `stopping`, `restoring`, `running`, `working`, `background`, `question` or `waiting`; `incarnation` is the run's `sessionIncarnation`; `lastActivityAt` is the owner's reading of the conversation's last activity (ISO string or `null`) |

**Schema and limits** (`parseWindowRecord`, `boundWindowSnapshot`). A record is at most 512 KiB, at most 64 folders, 256 live cwds and 512 rows, each string at most 4096 characters, ids `[A-Za-z0-9-]{1,100}`, incarnations `[A-Za-z0-9._:-]{1,300}`, `pid` a positive integer, times finite ISO strings. A window bounds its own snapshot before writing, so every record it writes is one every reader accepts: strings are never truncated (a truncated path would name another folder), an entry that does not fit is **dropped whole**, and the rows, folders and cwds together stay within 384 KiB. Rows are taken first because they are small and because a row that was left out would show a different status elsewhere than in its owner; the 512-row limit is therefore a capacity limit (more than 512 sessions held by one window at once is outside what is supported: the surplus shows Running in the other windows). A file is read with a bounded read that stops at the limit, so an oversized or hostile file is never loaded. A file that is oversized, not a regular file, malformed, of another version, or whose `holderId` differs from its name is ignored (and swept when stale); a reader never interpolates a record's content into a path.

**Advisory only.** UUIDs and pid existence are not authentication, and any process of the same user can write a record. Registry data therefore only *shapes display and navigation*: it never decides ownership, never admits or refuses a launch, and a row's published status is applied only to a session the shared catalog already lists and only while the run's incarnation in the catalog equals the published one. A forged record can show a wrong label, folder or window URI until it expires or is overwritten; the documented residual risk is spoofed display and a navigation request to a `file` URI the user could open anyway.

**Publication** (`src/host/atomic-file.ts`, `replaceFileAtomic`). A window's writes are serialized on one promise chain, so an older write can never finish after a newer one; each write stages `<record>.<uuid>.tmp` (opened with the exclusive flag, closed) and renames it over the record, retrying a rename that a reader's open handle blocks (`EPERM`, `EBUSY`, `EACCES`) a few times, the same convention as claims. A write is scheduled when the window's own snapshot changes (debounced 250 ms) and as a renewal every 15 s; a window also rewrites on regaining focus. The window publishes its snapshot *before* repainting its own tree, so its own view and everyone's derive from the same record. On a normal close `removeSync` stops scheduling, marks the window removed, deletes the record, and a write that was in flight deletes its own result, so a closing window cannot bring its record back.

**Liveness.** A record of another window counts while *all* of these hold: `now - updatedAt <= 60 s`; `updatedAt` is not more than 5 s ahead of the reader's clock (a record stamped further ahead is not trusted at all, which prevents a backward clock change from keeping a hung or pid-reused record alive for hours); and its pid answers `process.kill(pid, 0)` (`EPERM` counts as alive). The lease is checked against the clock on every read of the registry's cache, so a record expires from view without a disk read.

**Cleanup.** A reader sweeps a file that is not live (dead pid, lapsed lease, corrupt, mislabeled, oversized, or a stranded `.tmp`) once the file's own modification time is also older than a lease. This does not depend on the pid: an unchanged expired record is removed although an unrelated process now holds its pid. The reader stats the file again at that moment, so a slow-but-live owner that rewrote it is not swept; in the narrow window between a sweeper's stat and delete a renewing owner can lose its file, in which case it republishes at its next write (at most 15 s). Records are advisory, so this costs a short flicker, never a wrong ownership decision.

**Order.** The union is ordered by window `startedAt` (then holder id), each window's folders in its own VS Code order; this window's own record takes its place in that order. Every window therefore derives the same list. It replaces ADR-0045's "this window's folders first". The live-session cwds follow the same window order, each window's list in its publisher's order, and this window reads its own list through the same path, so the publisher and every reader order identically.

### Convergence and expiry

Bounds, measured on one machine. "Strict" parity (the same text, status and order in every window at every instant) cannot be guaranteed by any design that has no shared transaction across windows; the table states what each kind of input actually converges in.

| Event | Visible in every other window |
| --- | --- |
| a window's snapshot changes (folder added, published status or activity time changes) | about 0.4 s: 250 ms write debounce + 150 ms watch debounce, then one directory re-read |
| a watch event is missed | at the next focus or view visibility, or the next 15 s heartbeat re-read: at most 15 s |
| a window crashes or is killed | at most about 15 s (the next heartbeat re-read finds the pid gone); its file is swept after a lease |
| a window hangs (pid alive, no renewal) | at most about 75 s: the 60 s lease plus up to one 15 s scan to repaint |
| a window closes normally | immediately: its record is deleted and the watch fires |
| claim changes (a session starts or stops in another window) | the claim watcher's event (about 0.2 s); a missed event: while the Sessions view is visible, every heartbeat re-observes **every** row, so at most 15 s plus one observation; a hidden view re-observes the rows shown as held by another window or Checking, and is brought up to date when it is shown |
| a state a window derives from the machine's files (transcript file missing or title changed, external lease probe, a failed observation) | the same: a visible view re-reads every row's ownership, conversation activity and session-file header each heartbeat, so a failed observation is retried at the next one; a hidden view when it is shown. These inputs are not published (they are facts of the shared machine each window reads itself; publishing one window's probe result would make it an authority). **Blocked** is not converged at all: it records one window's own failed attempt and stays until that window's next attempt or restart |
| clock jumps forward | records can look expired until their owners' next write (at most 15 s); a repaint follows the next re-read |
| clock jumps backward | records stamped more than 5 s ahead are ignored, and the writers' next write (at most 15 s) restamps them |

So: what the owner publishes (status, activity time, folders) and what the claims say converge within about 0.4 s normally and 15 s worst case for a crash or a dropped event; what a window derives from the machine's files converges within one heartbeat plus one observation for a visible Sessions view, and when the view is next shown otherwise. Between a change and its convergence two windows can show different text; that interval is the bound above. The one declared exception is **Blocked**, which is one window's own record of its own failed attempt and does not converge (see Per-window differences).

**Registry expiry never frees a claim.** A claim stays authoritative on its own evidence (holder and generation, process generation) under ADR-0039. When a record expires, the rows that were shown with its published status fall back to Running (the generic state of a claim-held row), and the folders it contributed leave the union; nothing about claims, brokers or the catalog changes.

### Folder union

`LauncherFolders` takes `windows(): { here: boolean; paths: string[] }[]` instead of the window's own paths. Sources, in order: folders open in any live window (agent-root substitution applied by the reader, so the shown path depends only on the file system and the shared `omp.useAgentRootFolder` setting), then the other pinned folders in stored order, then live-session-only folders. Deduplication, identity-derived ids, `openedPaths` and pin matching are unchanged.

`LauncherFolder` gains `openHere` and `openElsewhere` (`open` stays "open in some window"). The tooltip names them (`Open in this window`, `Open in another window`, both). A live-session-only folder's tooltip no longer says "in this window".

**Settings.** `omp.showWorkspaceFolders` and `omp.useAgentRootFolder` are `application` scoped: a folder or workspace override could otherwise make two windows disagree about the union. Application scope is wider than the profile (it applies across the user's VS Code profiles, which keep separate registries); that is intentional and the cost is small: both are display preferences with defaults of true. A previous workspace or folder override is ignored from now on; a user value keeps working.

**Agent roots of other windows' folders.** Foreign folders are resolved by the reader with the same resolver. The resolver forgets every root it is not asked about, so each resolution is given the **complete** set of live roots (every window's `folders`). Resolution is repeated on the registry heartbeat as well as on a registry change, focus and view visibility, so a marker added or removed while two windows are open reaches both windows within the heartbeat (at most 15 s) without either being focused; an answer that differs repaints, and a stale probe result is discarded by the resolver's newest-wins rule. Until the first answer a foreign folder shows as itself.

**Limitation (live sessions of a window that is gone).** A window's live-session working directories ride in its record, so they expire with it. A session whose host process outlives its window (a detached broker after a window close or crash) keeps running, but its unpinned folder is listed again only when some window has that folder open, the folder is pinned, or a window adopts the session. This matches today's behavior for a closed window; it is documented rather than fixed because deriving folder membership from broker evidence would add a second authority for it (the Processes view still lists such a broker).

### Same row status and order in every window

For a row the claim says another window holds, the observing window keeps the `otherWindow` state internally (menu contract, no Forget or Delete, Stop on the recorded host) but **shows the holder's published status**: the same label, icon, description and accessibility text the owner window shows. The shown state and the order are a function of shared inputs only (`shownSessionState`, `PeerRow`):

| Input | Source | Rule |
| --- | --- | --- |
| claim held by another window | the claim read in this window (holder, generation) | enters `otherWindow` |
| activity status | the holder's registry row, **only** while its `incarnation` equals the one the catalog records for the session and the record is live | otherwise `running` |
| unread | the shared reply read marker in the catalog, **not published** | `waiting` + unread is shown as Unread reply; any other status carries the "Unread ·" description prefix, exactly as in the owner |
| starting, stopping, restoring | published by the owner for the exact incarnation | shown as such |
| stopped, draft, blocked, checking | derived from the catalog, the session file and ownership probes, as before | unchanged; each window computes them from the same shared files |
| order in flat mode | the shown state, and the conversation activity time: for a row another window holds with a current publication, **only** the owner's published `lastActivityAt` (a published `null` means no activity; the reader's own reading is not a fallback). Without a current publication (none yet, or a stale incarnation) the row shows Running and the time comes from the reader's own reading of the same session file, which is the same file the owner reads. The owner publishes the reading it orders by | the same facts decide order and the "x minutes ago" text in every window |

Three kinds of state are not shared as facts, and parity for them is bounded or declared rather than exact: **Checking** (the first ownership probe of a row in this window), what a window derives from the machine's files (a missing transcript, an external lease probe, a failed probe) and **Blocked** (see Per-window differences). A rival's failed probe or attach never becomes a global status, and a published status is only the *owner's* account of its own session. Their bounds are in the convergence table.

**Fencing.** A status is bound to the run's incarnation, so a status from an earlier run (stop and relaunch, a re-attach) is not applied to a later binding. A conversation rebound inside one host is fenced by the binding generation where it could matter, in the owner's request handler (see Incarnation and binding). The unread mark is derived by every reader from the shared reply markers rather than published, so a window that clears the mark is believed everywhere without a second authority.

#### Row icon and the held-elsewhere badge

A row's icon is always the session's **status icon**, the same icon every window shows for that status (a Working row has the Working icon in the window that runs it and in every other window). That a session is open in *another* window (relative to the viewing window) is shown by an additional mark **after** the status, never by replacing the icon. A tree item has one icon and descriptions cannot render codicons, so the mark is the row's file decoration, which the view already uses for the unread dot: a one-character badge `⧉` (U+29C9, two joined squares) at the right end of the row, with the tooltip "Open in another window". The holder window shows nothing extra. An unread row in another window shows `●⧉` (the blue unread dot, then the glyph; the dot's colour applies) with the tooltip "Unread reply; open in another window", and the holder window shows `●` alone. A decoration with no colour leaves the label's colour alone, so the held-elsewhere badge does not tint the title. The decoration is a view-only mark; it is not part of the shared row text (label and description are identical in every window). A glyph rather than a codicon is the limit of the decoration API (badge text of at most two characters), and the glyph's rendering depends on the UI font; this is stated here because it is a visible design choice.

**ADR-0034 amendment.** ADR-0034 forbids publishing per-window status observations. This design publishes only the owner's *own* activity and its own reading of the conversation's last activity for sessions it holds, bound to the run's incarnation, display-only, and expiring with its record; unread, ownership and admission stay on the shared data. The restriction against a rival's probe or attach result becoming global state is retained.

### Click switches windows

```mermaid
sequenceDiagram
  participant A as Window A (clicked)
  participant S as global storage
  participant B as Window B (owner)
  A->>A: click row; re-read the claim (fresh); held by another window?
  A->>S: write window-requests/<B holder>.<id>.request (atomic; names the run)
  A->>A: vscode.openFolder(B uri, forceNewWindow true)
  Note over A,B: VS Code focuses B, which already has that folder or workspace
  S-->>B: directory watch (and a scan at B's start)
  B->>B: still the holder of this run, editor present? select that tab
  B->>S: write <B>.<id>.response, delete the request
  S-->>A: A reads the response; says why only on a failure
```

No dialog, notification or button precedes or follows a successful switch. The old confirmation path (notification with **Switch to Window**, `forceNewWindow: false`) is removed; the `Switch to Window` context-menu command remains as an explicit alias of the same silent switch.

#### Scope of switching

Switching covers a session another window **holds through a claim** (a verified writer or an operation in flight, ADR-0039): the registry knows it from the claim and the owner's published row. A session whose editor another window merely shows as history has no claim and no published row, so it is not discoverable and is **not routed**: Open or a click in this window opens the history here, as it did. Publishing editor presence for those tabs (with several passive copies of one session) would add an editor-presence authority that no requirement asked for; this is an explicit scope choice.

#### Plan

`planWindowSwitch` (pure) takes the fresh claim, the incarnation this window's catalog records for the session, the claim holder's liveness and the registry:

| Situation | Result |
| --- | --- |
| claim gone, held by this window, holder unverifiable, or holder pid not alive | `stale`: no switch; the ordinary open path continues if the claim was released, otherwise a short "no longer open in another window" message and a refresh |
| holder has a live registry record with a `file` URI, not shared by another live window | `switch` to that URI |
| holder's record says `windowUri: null` (unsaved multi-root window) | `manual`, reason no URI; the record is authoritative, so a stale claim URI is **not** used |
| another live window has the same URI | `manual`, reason ambiguous: `openFolder` cannot address a holder id and could focus the wrong window |
| holder has no usable registry record (started before this change, or in its first seconds) | `switch` to the claim's own URI, if it is a `file` URI; otherwise `manual` |

URIs are compared by `windowUriIdentity` (decoded path, lower-cased on Windows, no trailing slash), which is what VS Code's window routing treats as the same place; two spellings of one folder therefore count as the same window. `manual` posts the request first, so the tab is already selected in the owner when the user goes there, then says why it cannot bring the window forward and that the Window menu does it. A non-`file` URI is never dispatched to `openFolder`.

**Entry point.** A click or Open on a session routes to the owner whenever the row is not running in *this* window and a fresh claim read shows a live claim of another window of this extension, whatever the row currently displays. A row that this window still shows as Checking, Stopped or Running therefore behaves like an `otherWindow` row; the claim, not the cached row state, decides.

#### Request

`<global storage>/window-requests/<holder id>.<request id>.request` holds `{ version, id, to, from, tabId, incarnation, binding, createdAt }`, written atomically. Limits as for records: at most 8 KiB (read with a bounded read, so an oversized file is never loaded), identifiers `[A-Za-z0-9-]{1,100}`, the file name's holder and id equal the payload's `to` and `id`, a tab id of at most 200 characters, an `incarnation` grammar, `binding` null or a `[A-Za-z0-9._-]{1,200}` token. Only the holder it names acts on it. The requester waits 5 s counted from posting and arms an absolute withdrawal timer at that moment, independent of the focus change it also asks VS Code for, so a hung or slow `openFolder` cannot leave the request actionable; the owner additionally ignores a request older than 6 s (the wait plus a second) or stamped more than 5 s ahead, which only matters for a requester that died, and asks again whether the request is still wanted after its slowest step (the claim read) and before it selects. Garbage older than two minutes is swept by any poster.

**Incarnation and binding.** The fence is the *run of the session*, not the claim's owner generation alone: `sessionIncarnation(entry)` is `<ownerGeneration>_<host startedAt>.<host pid>` from the catalog entry. A stop and a relaunch and a re-attach change at least one part, so a request or a published status for an earlier run never applies to a later one. The requester names the incarnation its own catalog records. A conversation rebound inside one host (a native handover A to B and back to A) keeps the incarnation, so the owner also publishes, per row, the **binding** of the editor serving it (`binding`: `<editor slot id>.<binding generation>`, where the generation is a per-slot counter that the handover increments), and the requester copies the token it saw published for that run into its request (`null` when it saw none, in which case the request is fenced by the run alone). The owner refuses a request whose generation is not the current one; this is an identity comparison, not a timestamp. Observers' display of a published status is fenced by the incarnation only: after A to B to A the owner republishes both rows within the write debounce, so a stale status can be shown for about 0.4 s.

**Deduplication, concurrency and recovery.** One draining queue serves every scan and watch event of a window: at most 4 requests are served at once and 64 wait; the rest stay on disk for a later scan and expire within the lifetime. An owner marks each request file in flight, remembers the names it completed for as long as the request could still be acted on (so a request whose cleanup failed is never served twice, however many others completed meanwhile), and deletes a request after its response is written. A request posted before the owner's watcher started is served by an initial scan. A dropped directory event is recovered by a rescan on the owner's **focus** (the switch itself focuses the owner, so this fires within the request's lifetime), on the 15 s heartbeat, and on view visibility; the heartbeat alone would be too slow for a 5 s request, which is why focus is the recovery that matters. A request addressed to a holder id nobody serves (the owner's extension host restarted and has a new holder id) is never served: the requester times out, and a retry re-reads the claim and mints a fresh request for the new holder.

**Selection only.** The owner's handler (`selectHeldSessionTab`) is not "a click in the owner": it neither opens, launches, resumes, stops, changes a mode, acquires a claim nor forwards another request. It reads the claim, then asks whether the requester still waits (so a requester that withdrew while the claim read stalled is never served), and then, with no further await before the first command, checks all of the following; it checks them again after selecting and reports success only if they still hold:

1. the tab id is in this window's index and this window has the editor for it;
2. the incarnation the request names equals the one this window's catalog records for the session;
3. the claim names this window as holder **and** its owner generation equals the one this window's catalog records;
4. this window has a live host for the session (`hasLiveHost`);
5. the editor slot's binding is the session's and, when the request names the binding generation the requester saw published, is exactly that token: the same editor slot and the same generation (a native handover and back changes the generation; a replaced editor is another slot).

It then selects that exact existing editor: it reveals the panel it already holds or, for an editor VS Code restored but has not revived, selects the tab with the tab-group API, which is the user's own click on that tab. Reviving the editor is VS Code's reaction to the tab becoming visible, and its serializer path (`openRestoredTabIfUncovered`) opens a session when this window has no live host for it. Two things keep that path from starting anything because of a request: check 4 requires a live host when the request is served, and the tab is entered in `requestSelections` before it is selected. The serializer revival that the selection triggers consumes the mark and, when the tab has no live host by then, opens nothing; the mark is **not** released on elapsed time, so a revival that comes late is still covered, and an explicit Open of the tab clears it. A host that exits meanwhile is therefore not restarted by the request; the tab's restore then waits for the user's own Open. The mark is also kept when the selection command was issued but the tab is not active afterwards (another selection can win while the revival is already scheduled); it is dropped only when there was no tab to select. (A mark whose revival never comes stays until then or until the window ends, and only affects a later revival of that same tab while it has no live host.) The handler itself calls no launch, restore or mode-change function. It then waits up to 1.5 s for its window to report focus. If any check fails it selects nothing and answers `ok: false`. A forged or replayed request can therefore at most move editor focus in a window that really holds that session (a same-user residual risk), and can never start, stop, or admit anything.

**Response.** `{ version, id, ok, focused }`, at most 1 KiB, correlated by file name (`<to>.<id>.response`) *and* by the `id` inside; a response whose id differs is ignored and the requester keeps waiting. It is written atomically, read once and deleted by the requester. A forged acknowledgement is not proof of focus or ownership: the requester uses it only to choose what to say. The requester's outcome is `served` (the tab is selected and the window reported focus: say nothing), `unfocused` (selected, but the owner could not confirm its window is in front: say so), `refused` (the owner no longer holds that run or has no editor: say so) or `timeout` (no answer: say so).

#### Focus

`vscode.openFolder(uri, { forceNewWindow: true })`. The prototype (VS Code 1.141.0, Windows 11) showed this focuses the window that already has the folder or workspace and, unlike `forceNewWindow: false`, cannot replace the clicking window when the owner has just closed (it opens a new window then). The request is posted first so the tab is selected whichever finishes first.

The requester waits up to 5 s from posting for a correlated response (a bounded `stat` poll of one file; an uncorrelated one is ignored) and reports only what did not complete: no answer ("that window did not respond"; older builds never answer), a refusal (that window no longer holds the session or has no editor for it), or an owner that selected the tab but could not confirm its window came forward.

#### Prototype result (30-minute spike, two windows of one profile, VS Code 1.141.0, Windows 11)

A throwaway extension in an isolated test profile watched a command file and ran `vscode.commands.executeCommand("vscode.openFolder", uri, options)` in a window, logging `window.state.focused` per window:

| Call from window A (foreground) | Outcome |
| --- | --- |
| `openFolder(B folder, { forceNewWindow: false })`, B open | B `focused = true` about 100 ms later, A `false`; no new window |
| `openFolder(C folder, { forceNewWindow: false })`, C not open | **A's own window was replaced by C** (A's extension host restarted) |
| `openFolder(B folder, { forceNewWindow: true })`, B open | B focused, A not focused; window count unchanged |
| `openFolder(A folder, { forceNewWindow: true })`, A not open | a new window opened; the calling window stayed |
| `openFolder(multi.code-workspace, { forceNewWindow: true })` twice | first call opened the workspace window; second only focused it |

Conclusion, limited to these cases: the route focuses an existing window for one matching folder or workspace, and `forceNewWindow: true` is the safe flavour. It was exercised with the clicking window in the foreground, which is what a real click gives. Whether Windows flashes the taskbar button instead of raising a window when another application is in front was **not** observed and is an assumption. Two windows with the same URI were not tested; that case goes to the manual route (ambiguous). The owner selects its tab through ordinary extension logic, so no foreground trick is added.

### How fast the switch is, and what must not block it

A switch has three parts that run at once: the requester posts the request and asks VS Code to open the owner's folder (which brings the window forward), and the owner reads the request, selects the tab and answers. Measured in the isolated test profile with 5 windows (timestamps are the log's own milliseconds; the `window timing:` lines of the OMP Desk output log keep them for later reports): the owner sees the request 50 to 100 ms after it is posted (the directory watch's 150 ms debounce is 30 ms for the request directory), selects the tab 30 ms later and the requester has the answer about 210 ms after posting.

What made a real switch take up to 22 seconds was not any of that. Deciding whether another window's claim is live needs the holder process's **start time** (a claim's identity is the pair pid and start time, ADR-0039), and the only way to read it is a PowerShell command (`ps` elsewhere): 200 to 450 ms here, seconds on a machine with a real-time scanner. It was run **synchronously, on the extension host's event loop, and without memory** by every verdict: twice on the click itself (the open and the switch plan), and then twice for every row held by another window on every claim change. A switch changes claims, so every window ran 8 to 17 such commands in a row (about 4.8 s of a frozen extension host per window here, measured), the owner included, which is why the tab selection and the answer waited too. A profile-wide list made it worse: the rows of every window are in every window.

There are now two verdicts, by what they are for:

- **Admission** (`claimHolderMayBeAlive`, unchanged): whether a launch, a stop, a delete, a rename, an editor's controller election may proceed. It reads the start time itself, now, at each verdict, as ADR-0039 requires. These are user actions, one or a few at a time.
- **Display and navigation** (`claimHolderSeemsAlive`, new): which row says "open in another window", whether a click switches windows, which window a switch is planned for. It reads the start time **off the event loop** (an asynchronous command) and keeps the reading for 20 s (10 s for a reading that found nothing). It never decides admission: a click that wrongly treats a holder as gone only goes on to the ordinary open, whose admission refuses a live holder; one that wrongly treats a gone holder as live sends a request that nobody answers, and says so.

A reading is a sample of whatever process held the pid when it was taken, so it only speaks for a claim that **existed then**: a claim filed after the sample may belong to a newer process that reused the pid, and gets a reading of its own, and a command already running is joined only by a claim filed before it started. A verdict that a claim is **not** its holder is therefore never made from a reading older than the claim, so a live holder cannot be shown as gone because of a reading of a previous process with its pid. Concurrent verdicts about one holder share one command, an older command that finishes after a newer one never replaces what the newer one saw, a holder whose process is gone is never read (`process.kill(pid, 0)`, free) and its reading is dropped, and a stale claim of a reused pid costs one command per reading, not one per row per change.

The request directory's watch debounce is 30 ms instead of the default 150 ms, since a person waits behind it.

Measured in the isolated test profile with 5 windows after the change: click to request posted 6 ms (it was 168 to 330 ms), request seen 50 to 100 ms later, tab selected 30 ms after that, answer 210 ms after posting, and no synchronous command in a switch (one asynchronous command per window, 280 ms, off the event loop). The `window timing:` lines of the OMP Desk output log keep these steps for later reports.

### Per-window differences that remain

The selected/highlighted row; which actions a row's menu offers (an owner offers Close and Reload, another window Stop and Switch to Window); a folder's Reconnect Terminal entry (folder shells belong to a window); the collapsed state of an **unpinned** folder (kept per window since ADR-0045; pinned folders' state is shared); tooltips that name windows; the held-elsewhere badge (see Row icon and the held-elsewhere badge); and **Blocked**, which is the observation of *this window's own* failed attempt to open a session (`availability: failed` is deliberately window-local, ADR-0034): the window that failed shows Blocked with the reason, the others show the row's shared state. The last item needs the maintainer's acceptance, like the scope limits under Risks.

## Alternatives

- **Put window records in the profile catalog.** Rejected: the catalog is a durable transactional store with merge rules; heartbeats would churn its revisions in every window and a crash would leave records no one cleans.
- **Pin every open folder** (what the user wanted to avoid): folders would outlive their window and never expire.
- **Derive foreign folders from claims.** Rejected: a claim exists only for sessions, so an open folder without a running session would still differ between windows, and claims cover only the folders of their sessions.
- **Bring the window forward from the owner** (the owner calls a focus API): VS Code exposes none to extensions; only the main process focuses windows, and `openFolder` reaches it.
- **Win32 `SetForegroundWindow` helper:** fragile, needs a spawned process and is outside the agreed scope.
- **Published status derived from the claim:** the claim has no activity data; sharing it through the claim would turn every activity change into a claim write.
- **Poll the registry only on events** (no heartbeat): a crashed window produces no event, so its folders would stay until some unrelated refresh.
- **Publish editor presence for history-only tabs** to route them too: a second authority and several passive copies per session, not requested; rejected for now.
- **Keep the confirmation and add auto-switch behind a setting:** the user finds the confirmation unwanted; two paths would keep the dead one alive.

## Risks and Open Questions

- **Brief divergence.** See the convergence table. Agent-root answers for a foreign folder arrive after one probe; until then it shows as itself.
- **Foreground restriction.** Windows may deny a foreground change. The owner's handler waits up to 1.5 s for its window to report focus and answers `focused: false` otherwise; the requester then says the window may need to be brought forward by hand. Not being able to prove focus is a platform limit: `window.state.focused` is the only evidence an extension has, and a denied raise cannot be told from a slow one beyond that wait.
- **Periodic work.** One tiny write per window every 15 s and an event in every other window that re-reads the directory; while a window's Sessions view is visible, one re-observation of every row's ownership and conversation activity (a claim read and an `fstat` per row, at most four at a time) every 15 s. The signature check keeps repaints to real changes. This is the price of the bounded convergence of the table; a hidden view does none of it.
- **Older builds** neither publish nor serve requests: their folders are absent, their rows show Running, and a click ends with "that window did not respond".
- **Same-URI windows and unsaved multi-root windows** cannot be brought forward by `openFolder`; the user is told and the tab is already selected.
- **Same-user spoofing** of registry records and requests is documented as residual: display and focus only, never ownership.
- **`deactivate` is best effort.** A kill leaves the record until the pid probe drops it.

## Rollout and Verification

Implemented in one change: registry, atomic-file and request modules with unit tests (merge, expiry, skew, pid probe, cleanup, serialized writes, byte budget and drop-not-truncate, removal during a write; dedup with agent roots; identical tree output, text and order for two simulated windows with divergent local observations; request routing to the right holder only, expiry, forged and uncorrelated files, refusal, no answer, unfocused owner, stale owner, ambiguous and null URIs; selection-only handler refusals), then installed two-window observation in the isolated `manual` profile (results recorded in the change's report).

## Related Decisions

- [ADR-0056](../decisions/0056-publish-window-state-in-a-leased-registry-and-switch-windows-by-request.md) (this design's decision; amends ADR-0045's per-window folders, the ADR-0045 click shortcut and, narrowly, ADR-0034)
- [ADR-0045](../decisions/0045-derive-window-folders-per-window-and-pin-with-identity-ids.md), [ADR-0034](../decisions/0034-store-sessions-in-one-profile-catalog.md), [ADR-0039](../decisions/0039-refuse-only-on-a-verified-live-writer-the-extension-owns.md)
- [Window folders design](2026-10-07-window-folders-and-other-window-state.md)

## Architecture Review

- Reviewer: architect
- Outcome: accepted
- Notes: Seven independent review rounds (blocker B1 and material findings M1 to M10 in round 1; B1, M2, M3, M7 to M9, N1 in round 2; selection-only revival, exact binding identity, request lifetime, concurrency and convergence findings in rounds 3 to 6) were each addressed in code, tests and this text; round 7 confirmed with no remaining finding. Acceptance of the architecture does not approve the declared scope limits, which the maintainer decides: history-only editors are not routed, the unpinned folder of a session whose host outlived its window is not listed, 512 held sessions per window, Blocked stays window-local, focus cannot be proven under a Windows foreground denial, an observer can show a stale status for about 0.4 s after a native handover, and a selection mark whose revival never comes persists until that tab is revived or opened.
