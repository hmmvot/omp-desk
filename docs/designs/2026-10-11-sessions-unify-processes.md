---
status: proposed
date: 2026-10-11
---

# One Sessions view for sessions, terminals and their background processes

## Problem

The side bar shows the same running things twice. Every OMP session and every folder terminal runs under a detached PTY broker, and the **Processes** view ([design](2026-10-07-processes-view.md)) lists those brokers next to a **Sessions** view that lists the sessions they host. A user has to look at two views to learn whether a session has a live process, a terminal that belongs to no session is only visible in Processes, the only way to stop everything is to stop rows one by one, and the Sessions title bar spends two of its few buttons (New Session, Resume Session) on actions the list already offers as rows.

The user asked for one view: merge Processes into Sessions, mark sessions that have a live process, show terminals that have no session separately, add a third **Terminals** layout that shows what Processes shows today, give the title bar **Stop Orphaned and Idle** and **Kill All**, and remove the New and Resume title buttons.

## Goals and Non-goals

- Goals:
  - Remove the Processes view, its commands, menus and welcome content. Everything it did stays available from Sessions.
  - A session row says, from state the window already holds, whether a background process backs it; its tooltip adds the process facts when the process reader has them.
  - A third `omp.sessionsGrouping` value, `terminals`, lists every background process of this profile (what Processes listed): each row opens what it stands for when clicked, and shows its folder the way a session row does.
  - In the flat and folders layouts, processes that no listed session row stands for (folder terminals, orphans, idle session processes, a Stats dashboard, previous-build processes) appear in one separate, collapsible **Terminals** group after the sessions.
  - Title buttons **Stop Orphaned and Idle** (the existing selection and semantics) and **Kill All** (below). New Session and Resume Session leave the title bar; their in-list rows stay.
  - Keep every safety invariant of the Processes design unless the user's Kill All decision changes it, and bound the polling cost of a view that is now always visible.
- Non-goals:
  - Ending a process by PID or process tree. ADR-0029, ADR-0037 and ADR-0039 still forbid it.
  - Stopping another live window's sessions or terminals through the broker on that window's behalf: Kill All asks the window to stop its own (see Multi-window).
  - Changing broker, registry or catalog formats, the staged runtime, or the classification rules of the Processes design (record liveness, the union of references, `orphaned` versus `unknown`).
  - Skills, Tools and MCP views: a separate package with its own design.

## Current State

- `src/host/broker-processes.ts` (the pure model: rows, classification, identity cache), `broker-process-records.ts`, `broker-process-stop.ts` (the broker-only authenticated stop), `broker-process-controller.ts` (single Stop, Stop Orphaned and Idle over ports), `process-wiring.ts` (reader ports, view, 5 s poll while visible, commands) and `src/views/process-tree.ts` (a flat tree provider) implement the Processes view. All are documented in the [Processes design](2026-10-07-processes-view.md) and `architecture.md`.
- `SessionTreeProvider` projects `omp.sessionsGrouping` `flat` (default) or `folders` from the index, this window's facts and per-row enrichment. A row's `contextValue` segments, `displayedState` and `getParent` serve `TreeView.reveal`, the pinned-selection rule and the Go to Session picker.
- Sessions held by another window are classified through claims (`otherWindow`) and the window registry ([ADR-0056](../decisions/0056-publish-window-state-in-a-leased-registry-and-switch-windows-by-request.md)). The existing `omp.stopSessionHost` and a single Stop on a row another window holds stop that session through the authenticated broker, with no request to that window; that remains the user's explicit action on one named row, and Kill All no longer uses it for a window that is alive and answering.
- Title bar of Sessions: New Session, Resume Session, Open Stats, one layout toggle; `omp.refreshProcesses` is also called from the Stats panel and from natural shell exit to keep the Processes view current.

## Proposed Design

### Layouts

`omp.sessionsGrouping` becomes `flat | folders | terminals` (unknown values still normalise to `flat`). The title bar has one button per layout the view is not showing (icon and tooltip name the layout it switches to), driven by one context key `omp.sessionsLayout` (replacing `omp.sessionsFlat`); the command palette offers the three layouts directly.

| Layout | Root of the tree |
|---|---|
| `flat` | session rows in the flat order, then the **Terminals** group when it has children, then the New Session… and Resume Session… rows |
| `folders` | folder nodes, then the **Terminals** group when it has children |
| `terminals` | one process row per live broker, in the model's order (orphaned, idle, unknown, in use, then newest first); no session rows, no New or Resume rows, no folder nodes |

The projection of session rows is the same in every layout, so `listedSessions`, `headlineFor`, `itemFor` and the Go to Session picker keep working while `terminals` is shown. Only what the tree serves differs, and `beginReveal` returns nothing in `terminals` (no session row is on screen), the pinned-selection rule does not run there.

### Process facts and marks on session rows

A session row marks its process in the tooltip and in its accessibility label. The row's own state decides whether a process exists, never the snapshot alone:

1. Evidence: this window runs the writer (`facts.running`) or an authenticated broker witnessed it (`ownedWriterPid`), and the status is one of `running`, `working`, `background`, `question`, `unread`, `waiting`, `restoring`, `stopping` gives `Process: running`. `otherWindow` gives `Process: held by another window`. `stopped`, `draft`, `blocked`, `checking`, `starting` and `externalOmp` claim none (an `externalOmp` writer is a plain `omp` outside this extension, not a Desk process).
2. When the last process snapshot has a row for the session (`host.tabId`) it only adds the uptime (`Process: running, up 2 h`), or says an idle process of a stopped session is idle (`Process: idle (its session ended), up 3 d`). A snapshot row alone never makes a stopped row's process.

The row's status icon and word are unchanged: a live status already carries a process-bearing icon, and the mark adds the explicit sentence plus the screen-reader text. No `contextValue` segment is added (the menu regexes anchor on its tail).

### The Terminals group and rows

A process row is *represented* by a session row when it is a `current` session process, `in-use`, whose host names a conversation that the view shows as a row, and whose child has not exited. Every other row is *loose*: a folder terminal, a Stats dashboard, an orphan, an `unknown` row, an idle session process (broker alive, child exited), a session process whose folder is not shown, a previous-build process.

- `flat` and `folders` serve the loose rows as children of the **Terminals** group node (id `omp.terminalsGroup`, description = count). It is absent when there are none. It is `Collapsed` by default; the user's expansion is kept by VS Code for the stable id.
- `terminals` serves every row, represented ones included, directly at the root.

A process row's label follows the flat list: `folder · what`, where the folder name is the owning shown folder's disambiguated name from `flatFolderLabels` (the same function, the same collision rules; a folder no shown folder owns falls back to its last path component) and `what` is the session title, `Terminal`, or the broker's own title for an orphan. A Stats dashboard and a row with no folder carry no prefix. The description, icon, tooltip, `contextValue` (`ompProcess.<stoppable|fixed>.<kind>.<state>`) and Copy Diagnostics text are the Processes view's, moved unchanged into the new row class.

**Click** (`omp.openProcess`, hidden from the palette; set as the row's command only when it can act):

| Row | Click |
|---|---|
| session with a conversation the view shows | the same function as a click on that session row (`clickSession`): reveal its tab, or switch to the window that holds it |
| folder terminal with an editor in this window | reveal that editor |
| folder terminal recorded but with no editor in this window and not held elsewhere | attach to it and open its editor (the exact slot, as Reconnect Terminal does) |
| folder terminal another window shows | a message naming that window's state; nothing is moved (there is no request channel for terminals) |
| Stats dashboard | `omp.openStats` (reuses the running dashboard) |
| orphan, unknown, previous-build process, session whose folder is not shown | no click action; Stop and Copy Diagnostics are in the row menu, and the tooltip says what the row is |

### Reading, polling and cost

The reader (`createBrokerProcessReader`) and its caches are as in the Processes design, except that a verified identity is trusted for 60 s of wall time instead of a number of ticks (so the interval of the tick no longer decides how long a recycled PID can show) and that a tick may read the child state of rows that never had one. `process-wiring.ts` (`registerSessionProcesses`) is the one owner of the reader: every read — the poll's and every controller's — runs through one queue and is published to the provider, so a list never shows an older read than an action just made.

Because Sessions is now the always-visible view, the cost rules tighten:

- No *background* read while the Sessions view is hidden. An explicit action (Stop, Stop Orphaned and Idle, Kill All, refresh) always reads fresh.
- Explicit (fresh) read: when the view becomes visible, on layout change, after any stop and on the internal refresh. A tick also reads the child state of a row whose child state was never read (once per row id: a new broker costs one authenticated attach, not one per tick).
- Ticks (no attach for an already read record, no identity probe for an already judged one; one directory listing plus a liveness check per record) run every 5 s in `terminals` and every 30 s in the other layouts, plus one debounced tick 2 s after a `refreshLauncher` (a terminal or session just started or stopped shows within seconds without a timer storm).
- A tick never queues behind another tick.

### Stop

`omp.stopProcess` (inline and menu on a stoppable process row) and its routes are unchanged: fresh derivation, then the `driven`, `recorded` or `broker` route (see the Processes design); a native session another window holds takes the `broker` route. The route decision and its execution are extracted from `stopProcess` into one function, `stopRow`, that single Stop, Stop Orphaned and Idle, Kill All and a stop another window asked for share, so there is one code path to the authenticated stops. `stopRow` answers per row whether the route confirmed the stop. **The writer's exit and the broker's exit are separate evidence**: a row's own flow (`driven`, `recorded`) proves the session's writer gone, and its shutdown acknowledgement is not an exit, so after such a flow the controller probes the broker's own process by its recorded identity (PID and creation time, `waitBrokerGone`, bounded at 10 s, independent of whether the record is still readable). A writer proven gone with a broker not proven gone is *stopped, but its background process could not be confirmed closed*, never plain stopped, on every route.

**Stop Orphaned and Idle** (`omp.stopOrphanedProcesses`, now a Sessions title button) is unchanged: its selection (`selectOrphanedAndIdle`), the single modal, the second derivation after the modal, graceful only.

### Kill All

`omp.killAll` ("Kill All", Sessions title button, Command Palette) ends every OMP process this profile has that this build can stop, from this window, in two tiers. This is the user's product decision of 2026-10-11 and deliberately replaces the Processes design's "no stop-everything action".

**Scope.** After one fresh read:

- *This window* — rows this window provably runs: a session it drives (a runtime of this window under that exact broker slot) and a folder terminal an editor of this window carries. A session that another window holds is that window's even when this window has an editor on it (`sessionRowWindow`: `heldElsewhere` wins over `open`).
- *Other windows* — stoppable rows whose window is `other-window`: sessions another window's claim holds and folder terminals recorded as open in another window.
- *Not run by this window* — every other stoppable row: sessions this window only shows (an editor with no runtime) or does not show, detached terminals, running sessions with no editor, orphans, idle processes, the Stats dashboard. A row's window is a record, not proof, so a row this window does not provably run is never stopped without the explicit choice below.
- *Cannot stop here* — rows with `stop.available === false` (a previous or incompatible build). They are not attempted and are named in the result.

**Confirmation, one modal.** The message states the counts by tier and kind; the detail says that running sessions and shells end, that a turn in progress is aborted, that conversations stay in OMP's session files and can be resumed, and that terminals lose their processes. The buttons are *Stop in This Window* (offered when the first tier is not empty), *Stop in All Windows* (offered when the second or third tier is not empty and says how many it adds, with the split between other windows and rows this window does not run) and the implicit Cancel. With all tiers empty nothing is asked: an information message says there is nothing to stop, or a warning names the rows of another version that cannot be stopped.

**Execution.** The choice fixes a set of row ids. The set is re-derived by one more fresh read; a row that is no longer in the chosen tiers or is gone is left alone (reported as changed). The set only shrinks: nothing that appears later is ever admitted. *Stop in This Window* sends no request to anyone. *Stop in All Windows* splits the set into three groups:

1. **This window's rows** (`planKillAll.here`: exact local identity) are stopped one after another by `stopRow`, so a session this window drives goes through its own stop lifecycle (`confirmAndStopRuntime` with captured transition facts under the per-tab gate: durable stopped intent, claim and host-control release, panel update) and a terminal through the broker route under its shell lifecycle.
2. **Rows another window may run** (`mayRunInAnotherWindow`: a row another window's claim or a recorded editor holds, and every live session process this window does not run, because a claim can read as `none` until it is observed) are not stopped from here. Every other live window of the profile (from the window registry read now) is *asked*, all windows at the same time and while this window stops its own rows, to stop the rows it runs among those identities, through its own lifecycle (below). Each window answers per row; the rows' verdicts come from those answers.
3. **Everything no window can run** (an orphan, an idle process, a detached terminal, the Stats dashboard) is stopped here by the authenticated broker, as before.

*Revalidation.* Immediately before each dispatch in group 1, before each fallback stop in group 2 and before each stop in group 3, the row is derived afresh (a non-fresh read of the live catalog) and must still be the same broker (row id, generation, PID and creation time) in a tier the choice covers; otherwise it is left alone and counted as changed. The *category* is revalidated too: a group 3 row (no window was asked about it) that has meanwhile become one another window may run (a detached terminal another window attached during the waits for the other windows' answers) is left alone and counted as changed. Earlier permission is never kept, and the row is not asked about late. The dispatched row is that fresh derivation, so its route is the current one.

*What an answer means.* A window's `unconfirmed` is the verdict of the window that runs the row. Its `stopped` is advisory: before the report counts the row as stopped, this window independently proves the broker the row showed gone by its process id and creation time (the probe the driven route uses, which does not depend on the broker's record being readable); a probe that fails or finds the broker alive keeps the row *not confirmed*, whatever the window said and whether or not the final read still lists it. `changed` (the owner runs it, but it is gone or changed while being prepared) leaves the row alone: nobody else may stop it on this request. A window whose request outcome is uncertain may still act on the request until its extension host is proven gone, so the row is left to it and reported with the reason: it took the request up and then stopped reporting (waiting on something, such as a long shutdown), its request could not be withdrawn, or the requester itself was not running for a while and the evidence of the take-up may be gone. The broker never acts concurrently with a request that may still be served. Only a row that **no window answers for** falls back to the authenticated broker, through the same revalidation: every live window answered `refused` (none provably runs it), or a window never took the request up (an older build, a window too busy to read it, an unwritable directory) as a requester that kept watching proved, or a window whose outcome was uncertain has an extension host that is positively proven gone (*Executor identity*, below). A row stopped by that fallback is reported as **stopped without its window** with the reason whenever a window should have answered (the row records another window, or a window did not answer), so the user can tell it from a process nobody ran.

*Fallback route.* The stop after a request no window answered for is explicit, not an ordinary Stop. When the fresh derivation shows a runtime of this window under that exact identity (it became locally driven meanwhile) it is stopped through this window's own lifecycle; otherwise it is the authenticated broker (graceful, bound to the row's exact slot, broker id, generation, PID and creation time), for every kind of row. It never takes the recorded reattach an ordinary Stop may choose, because that route consults the session's claim, and the claim of a live owner of an older build, which never answered, refuses it: the approved fallback could not stop that process.

*Executor identity.* A request is served by the addressed window's extension host. When a window is asked, its host is identified by the process id in the window's live registry record and the creation time the kernel reports for it (the same probe the broker identities use); that identity is kept for the whole Kill All. A request that may still be served is given up on only when that exact process is positively gone: the kernel no longer has it, or its id now belongs to a process created later. A lapsed registry lease, a record that vanished, an unreadable registry, a host that could not be identified when the window was asked, a missing probe helper and a probe that cannot decide are none of that, and leave the rows alone and reported: a hung or starved host can lose its lease, resume the request it took up after the requester stopped waiting and then stop the same processes, so a broker stop in the gap would run concurrently with it. An explicit cancellation acknowledgement by the owner is not part of the protocol.

*Forcing.* A process that does not stop gracefully gets the same Force Stop offer its own Stop gives, in the window the user is using. A window serving another window's request is graceful only, end to end: the capture of every row flow it runs (a driven Chat or native session, a recorded stop) carries `offerForce: false`, so the session's own flow never opens Force Stop or any other modal in that window, and a graceful stop that did not work ends the flow unconfirmed; the answer is `unconfirmed` and the report names the row. (The turn-abort consent of the Kill All modal is the user's and is carried: the modal says a turn in progress is aborted.) No PID is ever signalled.

**Report.** The report is per target. A row's route (or its window's answer) says whether it confirmed the stop: the row's own flow confirms the session's writer gone and the broker probe the broker's process gone; the broker route confirms the child gone and then the broker's process gone. The other window's answer is a request's result, not proof: its `stopped` is first checked by an independent broker-exit probe, and one fresh read after the last stop cross-checks it: a targeted row still present in that read is *still running*, whatever its route or window said. A row absent from it counts as stopped only when it was confirmed; otherwise it is reported as *could not be confirmed stopped* (an unreadable broker record is also absent from a read). If the final read itself fails the message says so and counts only what was confirmed. The result is one information message when everything is confirmed stopped (it still names the rows stopped without their window) and one warning otherwise, naming each row by title and the reason where a route or a window gave one (a window's reason is quoted with the window's workspace name), plus the not-attempted rows ("Not stoppable from here: …", also when they are the only rows). The detail goes to the Output channel. The window that served a request also says, in its own notification, how many of its processes it stopped on another window's behalf.

### Multi-window

*Learning.* Every window of the profile writes the same broker registry under the shared global storage and reads the same session catalog and shell-slot list; the window registry of ADR-0056 publishes which windows exist. A process this window does not show therefore already appears in its reader as `other-window` (a held claim, a shell slot recorded open in an editor) or `none` (nothing shows it). Kill All uses those two facts to size tiers 2 and 3 and to choose which rows to ask about; it adds no new publication. The registry read must succeed: when it fails, or a record in it could not be read, no window can be asked and the rows another window may run are left alone and reported (they are not treated as having no owner).

*Why a request.* The product decision of 2026-10-11 is that Kill All must not stop another live window's sessions or terminals through the broker on that window's behalf. A broker stop of a native session is a graceful ConPTY-level stop that records no stopped intent, releases no claim and bypasses the owner's per-tab gate; the owner would learn of it only through its exit handler, racing the broker's retirement. The owner's own lifecycle (native shutdown with stopped intent, Chat stop through `confirmAndStopRuntime` / `stopSessionHost`, the per-tab gate, the shell lifecycle) is the one that must run, in the window that has it.

*Request kind.* ADR-0056's channel gains a third kind, `stop` (version 1, in the shared claim-storage `window-requests` directory, addressed to the target's claim holder id like `select` and `launch`):

| File | Content |
|---|---|
| `<holder id>.<request id>.request` | `{ version, id, kind: "stop", to, from, createdAt, rows: [{ slot, brokerId, generation, ptyKind, tabId \| null }] }` |
| `<holder id>.<request id>.accepted` | `{ version, id, done }`, written by the receiver |
| `<holder id>.<request id>.response` | `{ version, id, ok, focused, rows: [{ state, reason }] }`, `state` one of `stopped`, `unconfirmed`, `refused`, `changed`, in the order of the request's rows |

A request carries only the row identities the requester was shown (slot, broker id, generation, type, conversation), at most 32 per request (a longer list is several requests, one after another), no repeats, no process ids, no mode and no force flag. The request is validated field by field (shapes, lengths, character sets) and bounded (32 KiB for any request, 16 KiB for a stop response, reasons at most 240 characters); an unreadable, oversized, malformed or foreign-addressed file is deleted unserved. A window serves only requests addressed to its own holder id, only from a requester that is another open window in the window registry, and only within the request's lifetime (9 s).

*Owner side.* The receiver first **takes the request up** by renaming the request file to `.accepted` (one atomic step; the requester's withdrawal is a delete of the request file, and exactly one of the two can win, so a request the requester gave up on is never acted on late). It then reads its own processes fresh and, for each named row in order: answers `changed` if no row equals the identity (slot, broker id, generation, type and conversation) or the row changed before it could be stopped; `refused` if the row exists but this window does not provably run it (`planKillAll.here`: a runtime of this window under that exact slot, broker id and generation, or a terminal editor of this window for that generation) or this build cannot stop it; otherwise it stops the row by the same `stopRow` as a Stop on that row, derived afresh immediately before, graceful only (its capture is asked for no Force Stop or other modal, so a failing driven Chat or native stop ends unconfirmed in this window too), and answers `stopped` (writer and broker proven gone), or `unconfirmed` with the reason. After each row it rewrites the `.accepted` file with the number finished (progress), then writes the response and removes the `.accepted` file. A window that cannot read its processes, or is still starting, answers `changed` or `unconfirmed` for every row and stops nothing.

*Requester side.* Before the window takes the request up the requester owns it: at 8 s it deletes the request file, and only a successful delete proves the window never acted (**not accepted**: it did not take the request up, or a window of an older build deleted a kind it does not know while the requester kept watching; both are reported as the window not taking the request up). A delete that keeps failing for 10 s more ends the wait as **uncertain**, never as not accepted: the file may still be served, so the window is treated as silent (below). Once taken up, the window is working: the wait ends with its answer, or as **silent** when the `.accepted` file has not changed for 45 s (one row can take a graceful stop plus a shutdown wait, about 25 s), or when the window answered that it could not serve. The whole wait, before and after take-up, ends at 10 minutes. The take-up marker is evidence for as long as a request can be active: the ordinary 2-minute sweep of request files leaves `.accepted` files alone until 15 minutes old, and a requester that observes no request, marker or response *and* was not running for more than 5 s between two of its own looks (its host was suspended, so a sweep may have removed the evidence) treats the outcome as uncertain rather than as never taken up. A response that is not a well-formed answer to this request (version, id, row count, states, sizes) is deleted and ignored.

*Failure modes.*

| Situation | What the requester does |
|---|---|
| No other live window | No request; every row falls back to the broker (rows another window is recorded to hold are reported as stopped without their window) |
| The window never takes the request up (old build, busy, directory not writable) | Withdraws it; its rows fall back to the broker, reported with the window named |
| The window took it up (or its request may still be served) and goes silent | Leaves its rows alone and reports them, until the window's extension host is proven gone by its process identity. A lapsed lease, a vanished record, an unreadable registry or an undecided probe prove nothing: the host may resume the request it took up. A later Kill All finds the window answering or its host gone |
| The window took it up (or its request may still be served), goes silent, and its host is proven gone (crashed host, closed window) | Falls back to the broker for its rows, reported as stopped without their window |
| The window registry cannot be read, or one of its records could not be | No request is posted and nothing another window may run is stopped: those rows are reported as left alone with the reason. Rows no window can run (orphans, idle processes, detached terminals, the Stats dashboard) are still stopped through the broker |
| The request file cannot be deleted (a lock) after the accept bound | Keeps trying for 10 s, then treats the window as silent, with the reason: the file may still be served, so its rows are left to it until its host is proven gone; there is never a broker stop concurrent with a request that may still be served |
| This window was suspended while the window worked, and the evidence of the take-up may have been swept | Treats the outcome as uncertain (silent), not as never taken up |
| A window answers `stopped` and the broker is still alive (a stale or forged answer, or a hidden record) | The independent broker probe decides: the row is reported as not confirmed stopped, whether or not the final read lists it |
| A detached terminal is attached by another window during the waits | Left alone (changed): it was not asked about, and the earlier permission is not kept |
| The window answers `unconfirmed` | Reports that window's reason; no broker stop; the final read decides whether the row still runs |
| The window answers `refused` for every row it cannot prove it runs | Those rows fall back to the broker |
| The window answers `changed` | Leaves the row alone and reports it |
| A forged request or response | A forged request can at most make a window stop processes of its own that the same user could stop with an ordinary Stop (it names no process the window does not itself run, and the window says in a notification what it stopped); a forged response proves nothing, since the final read decides, and can at worst make the requester skip a broker fallback or report a stop as unconfirmed |

*Races.* Two windows running Kill All at once each ask the other; each serves the other's request from its own request watcher while its own command runs, so neither waits on the other. Each row's stop is guarded by the owner's per-tab gate (window-local, which is now enough: only the owner stops its own rows), and a second stop of the same row finds it gone and answers `changed` or is reported by the final read. A window that is mid-stop when asked simply serves the request after its current flow (the watcher serves up to four requests at once). A shell editor of another window shows its process end through the owner's own shell lifecycle, as a Stop in that window does. Broker fallback is never used for a live window that is working, answering or whose request outcome is uncertain; where it is used, the broker's own identity re-verification (slot, broker id, generation, PID) at attach decides, and a row that changed is reported as such.

### Package contribution

- Views: `omp.processes` and `onView:omp.processes`, its `viewsWelcome`, `omp.refreshProcesses` (menu entries) are removed. `omp.refreshProcesses` stays as a hidden internal command (called by the Stats panel and by shell exit), not in the palette.
- Sessions title: `omp.newSession` and `omp.resumeWorkspaceFolder` leave the title bar and keep their commands and palette entries and every row and folder entry. Added in the navigation group: `omp.stopOrphanedProcesses` (clear-all) and `omp.killAll` (stop-circle). The layout buttons: each layout the view is not showing has its own title button (so two of `flat`, `folders`, `terminals` show at a time), and all three are in the palette.
- New commands: `omp.killAll`, `omp.showSessionsTerminals`, `omp.openProcess` (hidden). `omp.stopProcess` stays hidden and inline on stoppable process rows.
- Welcome content: the two folder welcomes gain `omp.sessionsLayout != terminals`; a new one for the `terminals` layout says that no background process is running.
- `omp.copyRowDiagnostics` stays for process rows under `view == omp.sessions`.
- The setting's enum gains `terminals` and its description names the three layouts.

### Code layout

- `src/views/session-order.ts`: the layout type and normaliser.
- `src/views/session-processes.ts` (pure, no editor API): the projection (represented versus loose rows, group membership, ordering), the process state words, session process marks and the label rules, tested without VS Code.
- `src/views/process-rows.ts`: the `ProcessTreeItem` and the group node (moved from `process-tree.ts`, which is deleted with its test).
- `src/views/session-tree.ts`: the layout, group and marks.
- `src/host/broker-processes.ts`: `planKillAll` (the tiers), `sessionRowWindow` (which window shows a session row), the exact broker identity (`BrokerIdentity`, `RowIdentity`, `rowIdentityOf`, `rowMatchesIdentity`, `sameBroker`), `mayRunInAnotherWindow`, and a catalog that decides `drivenHere` from the runtimes this window holds (`localRuntimes`, exact slot, broker id and generation, editor-only runtimes included) and trusts a terminal editor only for the generation it attached to. `broker-process-controller.ts`: `stopRow`, `killAll`, `settleRemoteRow` and `stopRowsOnRequest` (the owner's side). `window-requests.ts`: the `stop` kind (`postStopRequest`, `awaitStopAnswer`, `askWindowToStop`, the receiver's take-up and progress). `process-wiring.ts`: `registerSessionProcesses` (the serialized reader, poll, commands, ports, `serveStopRequest`). `src/extension.ts`: provider wiring, `omp.openProcess`, layout commands and context key, pinned-selection and notification-reveal guards, recorded-stop broker binding, identity-based driven capture, the window-request dispatch to `serveStopRequest`, removal of the Processes view.

## Alternatives

- **Keep Processes as a view and only add Kill All.** Leaves the duplicated list the user asked to remove.
- **Separate `Terminals` view for the loose rows.** A third list for what is mostly one or two rows; the user asked for a group inside Sessions and a layout for the full list.
- **Mark sessions with a badge or a `contextValue` segment.** The file-decoration badge already carries unread and other-window and takes one glyph; the `contextValue` tail is matched by anchored menu regexes. A tooltip sentence and the accessibility label cost nothing and break nothing.
- **Derive process presence only from the reader.** Needs a poll for every always-visible view and is wrong for the seconds around a start or a stop; the session status is already the truth the row shows.
- **Poll every tick with a fresh read.** An authenticated attach per broker every few seconds also resets each broker's no-client clock. Rejected, as in the Processes design.
- **Kill All through the broker for every window, with no request.** The first design: one transport the broker already offers. Rejected by the product decision of 2026-10-11, and for the reasons in Multi-window: it bypasses the owner's stop lifecycle for another live window's sessions and terminals.
- **A request with no take-up step** (answer only when finished, as `select` and `launch` do). The requester could not tell a window that never saw the request (safe to stop through the broker) from one that is mid-stop (must not be), so it would have to guess from elapsed time.
- **One request per row, or an answer per request.** A per-row request multiplies files and acceptance waits; a single yes or no hides which rows a window stopped.
- **Kill All by PID or tree.** Forbidden (ADR-0029, ADR-0037, ADR-0039).
- **Kill All in this window only, with no other-window tier.** Leaves detached and other-window processes running after a "kill all" that the user then has to hunt in Terminals.
- **Treat "no window shows it" as this window's.** A session another window holds reads as `none` until its claim has been observed, so this would stop another window's work without the explicit choice the user required.
- **Silent force.** The Processes design's rule stands: only an explicit Force Stop ends a process that did not stop when asked.

## Risks and Open Questions

- A mark derived from the status is as good as the status: for a few hundred milliseconds around a stop a row can claim a process that has just exited.
- A terminal held by another window cannot be revealed from here; Stop and Kill All still work. A later request kind could add a reveal.
- Kill All is a destructive action behind one modal; the modal states the counts and consequences and offers Cancel. Sessions stay resumable (their files are untouched).
- A hung or starved window whose lease lapsed *before* Kill All is not in the registry and is not asked; the rows it runs are stopped through the broker like a closed window's, because absence is all the requester can see. Once a request has been posted to a window, its outcome is decided by the process identity of its host, not by the lease, so a hung host that took the request up is left alone (and the user runs Kill All again after it recovers or the window closes) rather than given up on after its lease expires.
- A window of an older build (before this request kind) deletes the request without answering, so its rows are stopped through the broker and reported as without their window; that is the one case where a live window's processes are stopped by the broker, and the report names it.
- Every other live window is asked about every row another window may run, so a profile with many windows sends each of them a request (answered in milliseconds with `refused` when it runs none); the accept bound of 8 s applies once, in parallel, not per window.
- The request channel is a plain shared directory any process of the user can write: see the failure-mode table for what a forged request can do.
- Serial stopping makes Kill All proportional to the number of processes (a graceful stop and a shutdown wait each). The result message arrives once; a progress notification names the count.
- The 30 s tick in non-`terminals` layouts means a process started by another window can take up to 30 s to appear in the Terminals group (an explicit refresh, visibility or a layout change reads at once).
- `Stop in This Window` still leaves background processes; the result message says how many remain and that Kill All in All Windows ends them.
- A desktop notification for a session whose process has ended, activated while Sessions is in the Terminals layout (which serves no session row and, with the process gone, no process row), switches the layout to the session-serving layout the user used last (the flat list when none is known) and reveals the session's row; it launches nothing, and a layout change is the one side effect (the user can switch back with the title-bar button).
- A requester suspended for longer than the stall bound (5 s between two looks) cannot prove that a window never took its request up, so it leaves that window's rows alone and says the outcome is uncertain, even when the window in fact never saw the request; a later Kill All settles it.

## Rollout and Verification

1. Land the pure projection, `planKillAll` and the controller's `stopRow`/`killAll` with tests: represented versus loose rows, label and folder rules, group membership by layout, session marks per status and evidence, `planKillAll` tiers (this window by exact identity, other window, not run here, not stoppable), the modal's button set by tier, the re-derivation after the choice, the revalidation before each dispatch, the per-target report from a fresh read, a stop that fails, a vanished row, a cancelled modal, a final read that fails; the exact local identity (slot, broker id and generation; editor-only runtimes; a terminal's generation); the broker's exit as separate evidence on every route; and the stop request kind: request validation and bounds, the take-up and withdrawal race, progress and silence, per-row answers and chunking (`window-stop-requests.test.ts`), the owner's eligibility (exact identity, stale identity refused or changed, never forcing), and the requester's aggregation with the fallback to the broker route and its notes; a request that cannot be withdrawn and a wait bounded before take-up; take-up evidence surviving another window's sweep and a suspended requester treating missing evidence as uncertain; the revalidated category of a row nobody was asked about; the explicit fallback route (no recorded reattach, local lifecycle when it became driven); a peer's `stopped` verified by the broker-exit probe; graceful-only captures on a request; the pure notification reveal plan (`session-order.test.ts`); and a request that may still be served (a lapsed lease, an undecided or failing probe, an unidentified host) left alone until its host is proven gone, a registry that cannot be read leaving the rows another window may run alone, and the executor identity and proof (`peer-executor.test.ts`, `window-registry.test.ts`).
2. Land the provider changes with provider tests for the three layouts' roots, the group, `getParent`, no reveal in `terminals`, and mark repaint.
3. Land the wiring, package contribution, removal of the Processes view and docs.
4. `npm run typecheck`, the targeted tests, and an isolated VS Code window: the three layouts, process marks, clickable session and terminal rows, Stop Orphaned and Idle on an idle process, Kill All in one window, and Kill All with a second isolated window present (the all-windows offer), only on processes of the isolated profile.

## Related Decisions

- [ADR-0060](../decisions/0060-merge-background-processes-into-sessions-and-kill-all-through-authenticated-routes.md) records the lasting choices: Sessions is the one place, the shared reader, and Kill All's scope and its stop request to other windows with the broker only for rows no window answers for.
- [Processes view design](2026-10-07-processes-view.md): its classification, reader, authenticated stop routes and presentation words remain operative; its separate view, its poll rule, its titles and its "no stop-everything action" are superseded here.
- [ADR-0029](../decisions/0029-report-uncontained-pty-tree-stop-as-unknown.md), [ADR-0037](../decisions/0037-stop-a-recorded-broker-owned-managed-child-without-a-chat-runtime.md), [ADR-0039](../decisions/0039-refuse-only-on-a-verified-live-writer-the-extension-owns.md): no PID signalling; unchanged.
- [ADR-0015](../decisions/0015-serialize-tab-lifecycle-through-one-gate.md): every session stop still runs under the per-tab gate.
- [ADR-0056](../decisions/0056-publish-window-state-in-a-leased-registry-and-switch-windows-by-request.md), [ADR-0057](../decisions/0057-start-a-session-in-the-window-that-suits-its-folder.md): the window registry and request channel; extended here with the `stop` kind (amendment lines in both).

## Architecture Review

- Reviewer: independent `architect` agent, two rounds (2026-10-11).
- Outcome: round 1: accept after fixes (nine findings, F1-F9, all addressed in this revision and its code). Round 2: **not accepted**; five material findings remain, so this design and ADR-0060 stay `proposed`: (R2-1) a native session held by another window is stopped through its broker's graceful stop (a ConPTY close), which is not the owner's native shutdown lifecycle and records no stopped intent, a semantic change that needs the product owner's decision; (R2-2) the owning window's reconciliation of a remote broker shutdown is not implemented or proven (the broker can retire before the owner's exit handler runs), and the per-tab gate is window-local; (R2-3) `drivenHere` is derived from the slot only, and local editor-only runtimes are not represented; (R2-4) a driven or recorded route proves the writer gone, not the broker retired, so a broker hidden by an unreadable record can still be reported as stopped on those routes; (R2-5, addressed after the review) a notification with no retained editor reveals the session's process row in the Terminals layout.
- Notes: after round 2 the code gained a per-target local-eligibility check before each dispatch, broker-exit evidence on the broker route, and the notification reveal fallback. The product owner then decided (2026-10-11) that Kill All must not stop another live window's processes through the broker: it asks the window through a new `stop` request kind, which removes the broker-route semantics of R2-1 and the owner-convergence problem of R2-2 (the owner stops its own rows through its own lifecycle), and the same revision carries exact local broker identity and editor-only runtimes (R2-3) and independent broker-exit evidence on the driven and recorded routes (R2-4). This revision has not been re-reviewed.
