---
status: accepted
date: 2026-10-10
---

# ADR-0056: Publish window state in a leased registry and switch windows by request

## Context and Problem Statement

Sessions should read the same in every VS Code window of the profile. Two things are per window today and cannot be: the folders VS Code has open (ADR-0045 derives them per window and never shares them), and the live status of a session, which only its owner window knows. Clicking a session another window holds can only explain and ask for confirmation; the user wants that window in front with the tab selected, with no confirmation. VS Code gives an extension no API to focus another window or to message it, and a window that crashes announces nothing.

## Considered Options

- **A leased per-window record in global storage, a request file for tab selection, `vscode.openFolder` with `forceNewWindow: true` for focus.** Reuses the claims pattern (shared directory, atomic files, debounced `fs.watch`), needs no process and no foreground trick; liveness is a lease plus a pid probe.
- **Window records in the profile catalog.** One store, but a transactional durable store with merge rules is the wrong place for heartbeats; every renewal would be a catalog revision in every window, and a crash leaves records nobody removes.
- **Auto-pin open folders.** Folders would never expire and every window would show them forever; the user rejected it.
- **Derive other windows' folders and status from claims.** Claims exist per running session only, so an open folder without a session still differs, and activity would turn every change into a claim write.
- **Win32 foreground helper or a loopback RPC between windows.** Fragile or a new attack surface; out of agreed scope.

## Decision Outcome

First option.

- Every extension host publishes `window-registry/<holder id>.window` (versioned, bounded: rows are budgeted first and an entry that does not fit is dropped whole, never truncated; reads are bounded): identity, `updatedAt`, window URI (`null` is authoritative) and label, the `file` folders as opened, the working directories of its live sessions and, for each session it runs, a status and its own reading of the conversation's last activity, both bound to the run's **incarnation** (owner generation plus host start and pid). Writes are serialized, atomic (exclusive stage, then rename with the Windows retry convention of claims), rewritten on change and as a 15 s renewal; a window publishes before it repaints itself; a normal close removes the record and cancels any write in flight.
- Another window's record counts only while it is within a 60 s lease, not stamped more than 5 s ahead of the reader, **and** its pid exists. Stale files are swept by any reader once their modification time is also a lease old, independent of the pid. Registry expiry never frees a claim: ownership stays with claims and process generation (ADR-0039). Bounds, scan included: about 15 s for a crash, about 75 s for a hung host, immediate for a normal close.
- The merged list is ordered by window start so every window derives the same union; agent-root substitution (over the complete live root set, re-probed on every heartbeat) and deduplication stay on the reader's side. The settings `omp.showWorkspaceFolders` and `omp.useAgentRootFolder` are `application` scoped.
- A row a claim shows as held by another window is shown with the holder's published status only while that status's incarnation equals the one the catalog records for the session; otherwise as Running. A row's order and age come from the owner's published last-activity time only. The unread mark is not published: every window derives it from the shared reply markers. While a window's Sessions view is visible a 15 s heartbeat re-observes every row, so even a missed claim event or a failed observation is repaired within one heartbeat plus one observation.
- A click or Open on a session this window does not run, while a fresh claim read shows a live claim of another window, **switches at once, with no notification or button**: it re-reads the claim, writes `window-requests/<holder id>.<id>.request` (naming the run and the editor binding (slot and generation) the holder published for it), arms a 5 s withdrawal timer from that moment, and calls `vscode.openFolder` with the owner's saved workspace or single-folder URI and `forceNewWindow: true`. The owner serves only a **selection-only** request, through one bounded queue: it selects the editor it already has, only while the requester still waits and, read together after a fresh claim read, the claim names it as holder under the generation its catalog records, its catalog records the requested run, it has a live host for the session and the editor binding is the slot and generation the request names (all checked again after selecting, and the serializer's restore of that tab is deferred until its revival, however late); it refuses otherwise and never launches, stops, acquires a claim, changes a mode or forwards a request. The correlated, bounded response also says whether its window reported focus. The requester says something only when switching is impossible or incomplete and why: no usable URI, two windows with the same URI identity (`openFolder` cannot tell them apart), an owner that did not answer, one that no longer holds the run, or one that could not confirm its window came forward.
- Presentation: a row's icon is always the session's status icon; a session open in another window is shown by a `⧉` file-decoration badge after the status (with the unread dot first when unread), nothing extra in the holder window. **Blocked** (this window's own failed attempt) stays window-local.
- Scope: sessions held through a claim. A history-only editor in another window has no claim and is not routed.

### Narrow amendments

- **ADR-0045 ("derive per window, never share window folders").** Window folders are still never persisted and never pin themselves, but each window now publishes its own as an expiring record and every window derives the union. The "this window's folders first" order becomes window-start order. ADR-0045's per-window setting scope becomes application scope for the two folder settings.
- **ADR-0045 message shortcut and the "Switch to Window" confirmation.** A click or Open on a row displayed as held by another window no longer shows a message; it switches to that window (the confirmation, its notification button and `forceNewWindow: false` are removed). Claim admission is unchanged: the claim is re-read first and nothing is launched.
- **ADR-0034 ("shared facts and window-local facts are separate").** The owner's own activity and its reading of a conversation's last activity for a session it holds are published, bound to the run's incarnation, display-only and expiring with its record; the observing window falls back to Running when the publication is absent or its incarnation does not match. Unread, ownership, admission and a rival's probe or attach results are not published and never become global state.
- **ADR-0039.** Unchanged: registry data and requests are advisory, never ownership evidence, and cannot admit or refuse a launch. The evidence rule for admission (pid and process start time must match, read at the verdict) is unchanged too. Only what is *shown* and which window a click goes to use a reading of the start time that is taken off the event loop and kept for 20 s, valid only for claims that existed when it was taken (see [How fast the switch is](../designs/2026-10-10-multi-window-sessions.md#how-fast-the-switch-is-and-what-must-not-block-it)); it never admits or refuses a launch, a stop or a deletion.

### Consequences

- Positive: identical Sessions content in every window without persisting anything about windows; no new process; the same watcher pattern as claims; a safe focus route; no confirmation step.
- Negative: a periodic write per window and an event in every other window; a bounded delay (about 0.4 s normally, 15 s for a missed event or crash, 75 s for a hung host) before a published change shows elsewhere; what a window derives from its own local probes (a missing transcript, an external lease probe) converges at that window's next refresh, with no fixed bound while it is in the background, so strict instantaneous parity is not promised; history-only editors in another window are not routed; unsaved multi-root windows and windows sharing one URI cannot be focused (the tab is still selected, and the user is told why); the unpinned folder of a session whose host outlived its window is listed again only when its folder is opened or pinned; older builds neither publish nor answer requests; Windows may deny a foreground change, which the owner reports as "could not confirm focus"; same-user processes can spoof records and requests, which can only mislead display and focus.

## Related Documents

- [One Sessions view across every window of the profile](../designs/2026-10-10-multi-window-sessions.md)
- [ADR-0045](0045-derive-window-folders-per-window-and-pin-with-identity-ids.md), [ADR-0034](0034-store-sessions-in-one-profile-catalog.md), [ADR-0039](0039-refuse-only-on-a-verified-live-writer-the-extension-owns.md)

## Architecture Review

- Reviewer: architect
- Outcome: accepted
- Notes: Seven independent review rounds (blocker B1 and material findings M1 to M10 in round 1; B1, M2, M3, M7 to M9, N1 in round 2; selection-only revival, exact binding identity, request lifetime, concurrency and convergence findings in rounds 3 to 6) were each addressed in code, tests and this text; round 7 confirmed with no remaining finding. Acceptance of the architecture does not approve the declared scope limits, which the maintainer decides: history-only editors are not routed, the unpinned folder of a session whose host outlived its window is not listed, 512 held sessions per window, Blocked stays window-local, focus cannot be proven under a Windows foreground denial, an observer can show a stale status for about 0.4 s after a native handover, and a selection mark whose revival never comes persists until that tab is revived or opened.
