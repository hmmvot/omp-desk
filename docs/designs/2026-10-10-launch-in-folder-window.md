---
status: implemented
date: 2026-10-10
---

# Start a session in the window that suits its folder

## Problem

A session is a process the extension starts for a folder, and the window that starts it also shows its editor. Since [ADR-0056](../decisions/0056-publish-window-state-in-a-leased-registry-and-switch-windows-by-request.md) every window lists every folder open in any window, so the user can start a session for a folder from a window that does not have that folder open. Two things go wrong:

1. The session's editor is in a window whose workspace has nothing to do with the folder. The user has to move it, or live with a window that is not the project's.
2. For a **Unity project** it is worse: the Unity extensions (vstuc, C# Dev Kit) only work in a window whose workspace root is the Unity project folder. A session that edits C# in a window without that root has no Unity tooling at all. The OMP session's working directory is usually the repository root (the *agent root* of [ADR-0045](../decisions/0045-derive-window-folders-per-window-and-pin-with-identity-ids.md)'s substitution, e.g. `D:/Workspace/wh2` for the opened `D:/Workspace/wh2/WH2`), which carries `AGENTS.md`, so only the window choice may change.

## Goals and Non-goals

- Goals:
  - A launch starts in the most suitable window: a window that has the launch's folder open, or, for a Unity project, a window that has the project folder open, or a new window opened on it.
  - The launch behaves exactly as if it had been done in that window: its own ordinary path and admission, its own messages; the target window comes to the front with the new session's tab; the requester shows nothing when that works.
  - A session never starts twice because of this routing, and never silently starts in the wrong window when the right one does not answer.
  - One setting, `omp.launchInFolderWindow` (default true), turns it all off.
- Non-goals:
  - Revealing a session that is already open somewhere keeps [ADR-0056](../decisions/0056-publish-window-state-in-a-leased-registry-and-switch-windows-by-request.md)'s switch.
  - Restoring editors after a reload, and the in-editor Resume, never route (they are not a user's choice of where to start).
  - The session's working directory never changes: it stays the Sessions folder. Only the window changes.
  - No change to claims, ownership or Stop ([ADR-0034](../decisions/0034-store-sessions-in-one-profile-catalog.md), [ADR-0039](../decisions/0039-refuse-only-on-a-verified-live-writer-the-extension-owns.md)).

## Decision

### Which launches route

Every explicit launch that creates a writer for a folder, from every entry point that reaches it:

| Launch | Entry points | Routed as |
| --- | --- | --- |
| New Session | title button, folder row, "New Session…" row, Go to Session's New Session, the command | `new-session` (folder id) |
| Resume Session from folder history | title button, folder row, command | `resume-folder` (folder id): the **whole flow**, scan and picker included, runs in the target window |
| Open a stopped or draft row | click, second click, Open, Open in Chat/Terminal | `open-session` (tab id, `opened` or `resumed`, optional view) |

A first click (`opened`, history view) routes only when this window has no editor for the session; a click on a session this window shows is a reveal. A session another window **holds** is switched to as before; the claim read decides, and routing never applies to it. That fresh claim read comes first on every explicit open, **including Open or Show in Chat or Terminal**, before any Unity question is asked and before anything is launched or changed here.

**One deliberate exception: Add Selection / Add File to Session.** That command inserts references into an editor of *this* window (the accepted design of editor context excludes sending to another window), so choosing New session there, or a stopped session, launches in this window as before, whatever the folder's windows are. It does not route and does not ask the Unity question. It is the one entry point that stays local.

### Where it starts

*Launch workspace*: the folder the target window must have open.

- **Ordinary folder:** the Sessions folder `F` itself, matched like the list matches it (an opened folder shown as `F`, or `F` itself).
- **Unity launch:** the Unity project folder `U`, matched **exactly** against a window's own workspace roots. `F` open (or shown as an agent root) without `U` as a root does not count: the Unity extensions need `U` itself.

A launch is a Unity launch when `F` is a Unity project, or an opened folder `F` stands for is one (`openedPaths`), or `F` has Unity projects below it. A Unity project is a directory with `ProjectSettings/ProjectVersion.txt` and `Assets/`. The search is bounded: `F` itself, then two levels down, skipping dot-directories and `node_modules`, `Library`, `Temp` and `Logs` (any case), never descending into a project it found, and reading at most 400 directories; an unreadable directory has no projects. Answers are cached per folder for a minute. One project is used. Several are asked about once with a QuickPick (dismissing it starts nothing) and the answer is remembered per folder (`globalState`, shared by the profile's windows, at most 64 folders). None: the launch is ordinary.

Decision, in order (`planLaunchRoute`, `planFolderLaunch`):

1. `omp.launchInFolderWindow` is off, or there is no registry: here.
2. This window has the launch workspace open: here (no change).
3. Another live window has it: the one that gained the focus most recently (`focusedAt`, below); a window that published none ranks last, then earlier start, then lower holder id, so the answer does not depend on listing order. That window is asked.
4. Nobody has it: an **ordinary** folder starts here (it is only pinned, or kept visible by a session); a **Unity** project opens a new window on it.

A window on an **older build** is never chosen in step 3. After a reinstall under a running window (the extension's files on disk no longer hold the bytes its host started from, `packageChangedOnDisk()`), that window refuses to build a new view and shows "OMP was updated while this window was open" instead, so a launch handed to it would end in that notice. Such a window publishes `stale: true` in its registry record (as soon as it sees the change, not at the next heartbeat; the 10 s package poll finds it) and every window leaves it out of the candidates. If it was the only kind of window that has the launch workspace, the launch starts **here**, for a Unity project too (a new window on the project would only focus the stale one), and the user is told once per such window: "The VS Code window with <folder> runs an older OMP Desk build; reload it (Developer: Reload Window). The session opened here." A record that has no `stale` field was written by a build that predates it, which is older than the installed one by definition, so it reads as stale. A session a stale window already holds is still switched to by a click (ADR-0056): its existing editors work, and a select request never creates a view.

The registry record gains `focusedAt`: when the window last gained the focus (ISO, `null` if never or by an older build). It is read by the launch decision and never shown, so a change of it does not repaint other windows.

### Launch request (a window that has the folder)

The request directory of [ADR-0056](../decisions/0056-publish-window-state-in-a-leased-registry-and-switch-windows-by-request.md) carries a second kind. Every request has `kind`; `select` is the existing one, `launch` is new:

`{ version, kind: "launch", id, to, from, createdAt, workspace: { path, match: "folder" | "root" }, launch }` with `launch` one of `{ kind: "new-session", folderId }`, `{ kind: "resume-folder", folderId }`, `{ kind: "open-session", tabId, verb, mode }`. Limits as for selects: at most 8 KiB, ids `[A-Za-z0-9-]{1,100}`, folder ids `folder:` plus `[A-Za-z0-9._-]{1,100}`, a tab id of at most 200 characters, a workspace path of at most 4096.

Lifetimes: a select keeps its 6 s request lifetime and 5 s answer wait. A launch's lifetime is **11 s** and its answer wait **10 s**, counted from posting, with the same withdrawal timer: the receiver acknowledges **on admission** (it has validated the request and begun the launch), not when OMP is ready, so a normal answer takes a few hundred milliseconds, but the receiver may be a window busy loading a large workspace. The receiver keeps its answer to the focus wait of at most 1.5 s as for a select.

**Receiver** (`serveLaunchRequest`). Admission is the receiver's own. It first waits for what a window that has just started lacks, by awaiting the initializations themselves rather than guessing a time: the catalog is loaded, its own folders are published in the registry, the other windows' records are read (a window that has just started has read none, so the folder the request names, open only in another window, would be unknown to it), and its agent roots are probed (one fresh probe, which is quick). The probe's promise settles only once the **newest** probe has published, so a probe superseded by an overlapping one (another incoming launch, a focus refresh) is still a readiness barrier. A launch addressed to a window during its start is therefore treated exactly like a pending one, whichever transport brought it. It then refuses unless all hold:

1. this window itself has the request's workspace open (same match rule);
2. the folder or session the request names is one it shows **and stands under that workspace**: the folder is the workspace itself (`folder`), or the workspace is a Unity project the folder stands for (`root`: the folder is the project, an opened folder it stands for, or holds it within two levels). The receiver recomputes this itself. Having the workspace open and knowing the folder are not enough, so a request cannot start an unrelated known folder or session in a window that merely has some other workspace;
3. the requester still wants it (`stillWanted`).

After the last asynchronous step it checks 1 and that the target is **the one it validated**, synchronously, immediately before beginning: the session is still listed with the same working directory, the folder is still shown at the same path. A root removed, a folder dropped or moved, or a session re-homed while the receiver waited starts nothing. The launch is the function a click in this window runs, never routed again. Whether the session is live here is decided at that moment, not earlier: a session that is **live in this window** is only revealed (the ordinary open does that), and a requested view is never applied to a live session, including one that went live while the open itself waited for the editor to be revived or revealed, or whose start an earlier launch of the same session already had in flight, or the startup restoration supplied while the open waited for it (the open joins or adopts that writer and reveals it), so a request cannot stop or replace a running writer. The requested view is applied only by creating a new writer in it; a routed open never switches a writer afterwards. The policy travels with the request through every continuation of the open (`keepLiveView` of `openSession`, `openSessionInMode`, the folder-history Resume and `openTab`), separately from `noRouting`, which only says "do not route again" and also serves the local Add Selection / File exception. That includes `switchSessionMode` on an editor whose session is stopped: its closing `openTab` carries the policy too, because it cannot rely on the editor still being there after its awaits (a closed editor makes `openTab` derive the profile's default view). The answer `{ ok: true }` is written without waiting for the launch; whatever the launch reports (a refused claim, a failed start) it reports in the receiver, as for a click there. The request queue's duplicate rule applies: one request is served at most once while it could be acted on.

**Requester** (`routeLaunchToFolderWindow`, `deliverRequest`). It posts the request, then starts bringing the target forward (`vscode.openFolder(uri, { forceNewWindow: true })`; manual when the target has no `file` URI or shares it with another window) **and** waiting for the answer at the same time. The wait ends at an absolute deadline counted from posting however the focus command behaves (it may never settle), a timer armed at posting withdraws the request at that deadline, and every path that stops waiting without an answer withdraws it too (timeout, unreadable answer, failed focus). Shows nothing when the answer is `served`. **It never launches locally after handing over**: a window that did not answer may still start the launch, and two sessions are worse than none.

| Outcome | Message in the requester |
| --- | --- |
| timeout | "did not respond in time. Nothing was started from here; check that window before trying again"; the request is withdrawn |
| refused | "could not start the session (it may have closed the folder just now). Nothing was started; try again" |
| focus command failed | "could not bring the window forward … the session may have started there; check that window before trying again" (the receiver may have acted before VS Code failed); the request is withdrawn |
| answer unreadable | the same hedge; the request is withdrawn |
| unfocused / manual | the session is starting there but the window could not be brought forward |

There is no automatic retry and no fallback, with one exception that is not a fallback after uncertainty: a window that is on an older build and was not yet known to be (the race before its record says so, or a window of a build that publishes nothing and answers anyway) answers a launch request first thing, before it begins anything, with an explicit **refusal that carries a reason**, `{ ok: false, refusal: "stale-build" }`, and the requester then starts the launch in its own window and says so as above. This keeps the at-most-once rule: the answer is written by the addressed receiver for this very request id and only after it decided to begin nothing, a request is served at most once (a retry of the file or a second scan finds it completed), and the requester acts only on that answer, never on a timeout, an unreadable answer or a failed focus. So exactly one of the two windows starts the session. A refusal without a reason, and everything else above, keep the rule as written. The same holds for a pending launch a window on an older build claimed (it refuses with the same reason, deletes the pending file and the requester starts here). An older build that does not know the reason either times out (the requester says so) or serves the launch, as before. A retry (the user's) plans again from fresh data.

### Pending launch (a Unity project nobody has open)

No window can be addressed by holder id yet. The requester leaves a **pending launch** and opens a new window:

1. `pending-launches/<key>.<id>.pending` (in the profile's global storage), `key` the first 32 hex characters of the SHA-256 of the project folder's identity key (the same string both sides derive from the path), content as a launch request with `to: "pending"`.
2. `vscode.openFolder(U, { forceNewWindow: true })`, started together with the wait for the answer (see the requester above). If a window for `U` is just starting, VS Code focuses it instead of opening a second one.
3. The new window scans the directory at start, on every directory event, on focus, on a folder change and on the heartbeat. It considers only files whose key is one of **its own roots'** keys and **claims** one by exclusively creating `<key>.<id>.claimed` (`wx`). Exactly one window can: the claim is not a rename, because two windows can both rename one file on Windows (a first implementation that renamed served the same launch twice in several runs of the three-window race test). Work is one draining queue, deduplicated by file name and capped at 16 waiting, so repeated scans or a flood of files cannot pile work up; the rest stays on disk for a later scan.
4. **Claiming is not admitting.** The claimant does **not** delete the pending file when it claims. It serves the launch as an ordinary launch request addressed to itself, whose `stillWanted` is true only while the pending file still exists and is within its lifetime. When the requester gives up (60 s from posting) it withdraws the file, so a window that claimed it but is still waiting for its folder refuses instead of starting a session nobody waits for. Once the launch is admitted or refused the claimant writes the response to `window-requests/pending.<id>.response`, then deletes the pending file and, only when that deletion succeeded, the marker. The marker is the durable record that the launch was served: if Windows refuses the deletion (the file is held open, say), the marker stays until the sweep, so neither this window nor another can claim the same launch again; a launch is also never served once it is older than its lifetime. A launch whose admission began before the withdrawal can complete a moment after it: the window is the few milliseconds between the receiver's last look and the withdrawal, and the requester's message hedges (check that window).
5. The requester waits up to **60 s** (a cold window with a Unity workspace may take that long). On timeout it withdraws the pending file and says the new window did not respond in time.

A pending launch is dropped unserved when older than 65 s. Every window's scan (it runs on the heartbeat too) deletes pending and claimed files older than ten minutes, whatever their key. A window that crashes between claiming and finishing leaves a marker that blocks only that launch, which its requester has long given up on.

**A second launch while the window starts.** A second launch for the same project either sees the new window in the registry (an ordinary hand-over, which the receiver treats with the same readiness wait, so it is not refused for a folder list that has not filled in yet) or leaves another pending launch; `openFolder` focuses the starting window, which claims both. The order of arrival is not promised.

### Window, working directory

The Unity window's workspace is `U`; the session's working directory is `F`. The session row is listed under `F` in every window; the window that runs it shows the editor. This is deliberate: OMP loads the repository's `AGENTS.md` and `.omp` from the working directory.

### Security

Any process of the same user can write these files. A forged launch request can start an idle session (no prompt) in a folder that stands under a workspace the receiving window itself has open, or open an indexed session of such a folder (revealing it, never changing a live session's view); the same user can start `omp` directly. The receiver never starts anything outside what it can do from its own Sessions: it checks the folder or tab against the workspace it names and against its own roots, not each separately. A forged pending launch can make a new window start an idle session in a folder it has open, bounded by the same checks and by the 65 s lifetime. A flood of forged requests is bounded by the request queue (at most four served at once, sixty-four waiting); starting that many sessions is within what the same user can do. Registry data and requests stay advisory and never admit or refuse a launch.

### Settings

`omp.launchInFolderWindow` (boolean, default true, `application` scope so every window of the user's profile agrees). When off, every launch starts in the window the user used and nothing is posted.

## Alternatives

- **Carry the whole launch in the request, including a picker's answer.** Rejected: Resume Session's scan and QuickPick are UI of the window that launches; running the whole flow in the target keeps one code path and no second description of a candidate.
- **Create the draft in the requesting window and ask the target to open it.** Rejected: a request that is never answered would leave a stray draft row in every window.
- **Fall back to launching locally when the target does not answer.** Rejected by the requirement: a slow window may still start the session.
- **Rename-based claim for pending launches.** Rejected: a first implementation that claimed by renaming the pending file served the same launch twice in several runs of the three-window race test (on Windows a second window's rename of the already renamed file succeeds); an exclusive create is decided by the file system.
- **Treat an opened ancestor as having the Unity project open.** Rejected: the Unity extensions need the project as workspace root.
- **Always ask which project when several.** Rejected: one question per folder, remembered, is enough.

## Risks and Open Questions

- **A window that closes between planning and delivery** makes `openFolder` open a new window on its folder, and the request times out unanswered; the message says nothing was started. A retry then routes to the new window.
- **Two sessions on a race.** A request answered after the requester timed out (the receiver passed its `stillWanted` check just before the withdrawal) starts a session while the requester says it did not respond. The window is the few milliseconds between the receiver's last look and the withdrawal; the messages tell the user to check that window. A focus command that fails after the receiver already acted is reported the same hedged way.
- **Add Selection / Add File to Session stay local** (see Which launches route): a Unity project's session started from there runs in this window, without Unity tooling, until the user starts it from Sessions. This follows the accepted rule that references are inserted into this window's editors.
- **Unity detection is a heuristic.** Projects deeper than two levels are not found (the launch is ordinary then); a repository with several projects asks once.
- **A slow Unity window start** beyond 60 s is reported as not responding although the window may still be loading; its pending launch has been withdrawn, so it starts nothing late.
- **Same-URI windows and unsaved multi-root windows** cannot be brought forward; the launch still starts there and the requester says so.
- **Older builds** neither claim pending launches nor answer launch requests; the requester reports a timeout. The ones that predate the build state are not handed launches at all (they read as stale), until reloaded.

## Rollout and Verification

Unit tests: Unity detection against a real temporary tree (a project, an agent root over a WH2-like child, two projects, none, excluded directories, depth limit, nested project, cache), the routing decision and request handling (here, other window, two targets, no target, refusal, timeout, duplicate delivery, stale and withdrawn requests, forged files, exact workspace match, the Unity cases including a new window and its timeout), pending launches (claim by exactly one of three racing windows, claim after the watcher started, another window's key, expiry, withdrawal, forged files), the registry's `focusedAt`. Then installed two-window observation in the isolated `manual` profile, with a fake Unity tree inside a fake repository.

## Related Decisions

- [ADR-0057](../decisions/0057-start-a-session-in-the-window-that-suits-its-folder.md) (this design's decision; extends ADR-0056's request channel)
- [ADR-0056](../decisions/0056-publish-window-state-in-a-leased-registry-and-switch-windows-by-request.md), [ADR-0045](../decisions/0045-derive-window-folders-per-window-and-pin-with-identity-ids.md), [ADR-0039](../decisions/0039-refuse-only-on-a-verified-live-writer-the-extension-owns.md)
- [One Sessions view across every window of the profile](2026-10-10-multi-window-sessions.md)

## Architecture Review

- Reviewer: architect
- Outcome: accepted
- Notes: Seven independent review rounds (round 1 found eleven issues: an action not bound to the workspace it was served for, a stale admission check, unbounded delivery, a claimed pending launch that could not be cancelled, the Add Selection / File entry point, explicit-mode opens, setting text, unfocused new windows, startup readiness, an unbounded pending queue, missing sweeping; later rounds: a cleanup failure that could allow a second claim, a stale target and live-session decision across admission waits, a readiness barrier a superseded probe did not provide, and the reveal-only rule that had to follow the open through every continuation) were each addressed in code, tests and this text; round 7 found no remaining blocking finding. Acceptance of the architecture does not approve the declared scope limits, which the maintainer decides: a Unity project is a heuristic (two levels, ProjectSettings/ProjectVersion.txt and Assets), Add Selection / Add File to Session always run in the window the user used, the requester's message after a timeout or failed focus cannot tell whether the receiver already acted, and a launch whose admission began just before the requester withdrew it can still start.
