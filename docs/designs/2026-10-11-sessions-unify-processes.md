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
  - A new request kind between windows (see Multi-window).
  - Changing broker, registry or catalog formats, the staged runtime, or the classification rules of the Processes design (record liveness, the union of references, `orphaned` versus `unknown`).
  - Skills, Tools and MCP views: a separate package with its own design.

## Current State

- `src/host/broker-processes.ts` (the pure model: rows, classification, identity cache), `broker-process-records.ts`, `broker-process-stop.ts` (the broker-only authenticated stop), `broker-process-controller.ts` (single Stop, Stop Orphaned and Idle over ports), `process-wiring.ts` (reader ports, view, 5 s poll while visible, commands) and `src/views/process-tree.ts` (a flat tree provider) implement the Processes view. All are documented in the [Processes design](2026-10-07-processes-view.md) and `architecture.md`.
- `SessionTreeProvider` projects `omp.sessionsGrouping` `flat` (default) or `folders` from the index, this window's facts and per-row enrichment. A row's `contextValue` segments, `displayedState` and `getParent` serve `TreeView.reveal`, the pinned-selection rule and the Go to Session picker.
- Sessions held by another window are classified through claims (`otherWindow`) and the window registry ([ADR-0056](../decisions/0056-publish-window-state-in-a-leased-registry-and-switch-windows-by-request.md)). The existing `omp.stopSessionHost` already stops a session another window holds, through the authenticated broker, with no request to that window.
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

`omp.stopProcess` (inline and menu on a stoppable process row) and its routes are unchanged: fresh derivation, then the `driven`, `recorded` or `broker` route (see the Processes design); a native session another window holds takes the `broker` route. The route decision and its execution are extracted from `stopProcess` into one function, `stopRow`, that single Stop, Stop Orphaned and Idle and Kill All share, so there is one code path to the authenticated stops. `stopRow` answers per row whether the route confirmed the stop.

**Stop Orphaned and Idle** (`omp.stopOrphanedProcesses`, now a Sessions title button) is unchanged: its selection (`selectOrphanedAndIdle`), the single modal, the second derivation after the modal, graceful only.

### Kill All

`omp.killAll` ("Kill All", Sessions title button, Command Palette) ends every OMP process this profile has that this build can stop, from this window, in two tiers. This is the user's product decision of 2026-10-11 and deliberately replaces the Processes design's "no stop-everything action".

**Scope.** After one fresh read:

- *This window* — rows this window provably runs: a session it drives (a runtime of this window under that exact broker slot) and a folder terminal an editor of this window carries. A session that another window holds is that window's even when this window has an editor on it (`sessionRowWindow`: `heldElsewhere` wins over `open`).
- *Other windows* — stoppable rows whose window is `other-window`: sessions another window's claim holds and folder terminals recorded as open in another window.
- *Not run by this window* — every other stoppable row: sessions this window only shows (an editor with no runtime) or does not show, detached terminals, running sessions with no editor, orphans, idle processes, the Stats dashboard. A row's window is a record, not proof, so a row this window does not provably run is never stopped without the explicit choice below.
- *Cannot stop here* — rows with `stop.available === false` (a previous or incompatible build). They are not attempted and are named in the result.

**Confirmation, one modal.** The message states the counts by tier and kind; the detail says that running sessions and shells end, that a turn in progress is aborted, that conversations stay in OMP's session files and can be resumed, and that terminals lose their processes. The buttons are *Stop in This Window* (offered when the first tier is not empty), *Stop in All Windows* (offered when the second or third tier is not empty and says how many it adds, with the split between other windows and rows this window does not run) and the implicit Cancel. With all tiers empty nothing is asked: an information message says there is nothing to stop, or a warning names the rows of another version that cannot be stopped.

**Execution.** The choice fixes a set of row ids. The set is re-derived by one more fresh read; a row that is no longer in the set's tier or is gone is left alone (reported as changed). Each remaining row is stopped one after another by `stopRow` — the existing routes, so a session this window drives goes through its own stop lifecycle (`confirmAndStopRuntime` with captured transition facts under the per-tab gate: durable stopped intent, claim and host-control release, panel update), a session another window holds goes through `stopSessionHost`'s recorded-host path, and everything else through the broker-only authenticated stop. A recorded-host stop binds to the exact slot, attempt and broker id and generation the row was derived from, and the attached broker's own identity is proven against the row's recorded identity before anything is sent. A process that does not stop gracefully gets the same Force Stop offer its own Stop gives; Kill All never forces silently. No PID is ever signalled. The existing driven stop records its stopped intent after the writer is confirmed gone (the order a single Stop already has); Kill All inherits that order and does not change it.

**Report.** The report is per target. A row's route answers whether it confirmed the stop (the row's own flow confirms the session's writer gone; the broker route confirms the child gone); one fresh read after the last stop then cross-checks. A targeted row still present in that read is *still running*, whatever its route said. A row absent from it counts as stopped only when its route confirmed it; otherwise it is reported as *could not be confirmed stopped* (an unreadable broker record is also absent from a read). If the final read itself fails the message says so and counts only what the routes confirmed. The result is one information message when everything is confirmed stopped and one warning otherwise, naming each row by title and the reason where a route gave one, plus the not-attempted rows ("Not stoppable from here: …", also when they are the only rows). The detail goes to the Output channel. A native session another window holds is stopped through its authenticated broker, not by reattaching it here (its claim refuses a reattach).

### Multi-window

*Learning.* Every window of the profile writes the same broker registry under the shared global storage and reads the same session catalog and shell-slot list; the window registry of ADR-0056 publishes which windows exist. A process this window does not show therefore already appears in its reader as `other-window` (a held claim, a shell slot recorded open in an editor) or `none` (nothing shows it). Kill All uses exactly those two facts to size tier 2; it adds no new publication.

*Requesting.* No request is sent to another window. Stopping a process held elsewhere needs only the authenticated broker, which any window of the profile can reach; the existing Stop on an `otherWindow` row already works this way. The other window finds out the way it learns about any exit: its broker subscription reports the child gone, or its next ownership observation or registry heartbeat shows the row stopped, and it updates itself. ADR-0056's request channel is therefore not extended: it exists to make a window *do* something a requester cannot (select a tab, open a folder), and a stop is something every window can do.

*Races.* Two windows running Kill All at once each re-verify identity (slot, broker id, generation, PID) at attach; the loser finds the broker gone or replaced and reports it as not stopped by this window (the final read decides). A window whose own flow is mid-stop is protected by its per-tab gate, which is window-local: it does not order a stop another window sends through the broker. The owner window is expected to observe the exit through its broker subscription or its next ownership observation; that convergence is not yet proven for a remote shutdown (see Risks). A shell editor of another window shows the process exit in the editor, not a Terminate confirmation, and retires its slot by the shell-lifecycle rule of the 2026-10-08 amendment.

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
- `src/host/broker-processes.ts`: `planKillAll` (the tiers) and `sessionRowWindow` (which window shows a session row). `broker-process-controller.ts`: `stopRow`, `killAll`. `process-wiring.ts`: `registerSessionProcesses` (the serialized reader, poll, commands, ports). `src/extension.ts`: provider wiring, `omp.openProcess`, layout commands and context key, pinned-selection and notification-reveal guards, recorded-stop broker binding, removal of the Processes view.

## Alternatives

- **Keep Processes as a view and only add Kill All.** Leaves the duplicated list the user asked to remove.
- **Separate `Terminals` view for the loose rows.** A third list for what is mostly one or two rows; the user asked for a group inside Sessions and a layout for the full list.
- **Mark sessions with a badge or a `contextValue` segment.** The file-decoration badge already carries unread and other-window and takes one glyph; the `contextValue` tail is matched by anchored menu regexes. A tooltip sentence and the accessibility label cost nothing and break nothing.
- **Derive process presence only from the reader.** Needs a poll for every always-visible view and is wrong for the seconds around a start or a stop; the session status is already the truth the row shows.
- **Poll every tick with a fresh read.** An authenticated attach per broker every few seconds also resets each broker's no-client clock. Rejected, as in the Processes design.
- **Kill All through a request to every other window** (ask each window to stop its own sessions through its own lifecycle). A new request kind, a response protocol, timeouts and a stale-window problem, for an action the authenticated broker already allows from anywhere.
- **Kill All by PID or tree.** Forbidden (ADR-0029, ADR-0037, ADR-0039).
- **Kill All in this window only, with no other-window tier.** Leaves detached and other-window processes running after a "kill all" that the user then has to hunt in Terminals.
- **Treat "no window shows it" as this window's.** A session another window holds reads as `none` until its claim has been observed, so this would stop another window's work without the explicit choice the user required.
- **Silent force.** The Processes design's rule stands: only an explicit Force Stop ends a process that did not stop when asked.

## Risks and Open Questions

- A mark derived from the status is as good as the status: for a few hundred milliseconds around a stop a row can claim a process that has just exited.
- A terminal held by another window cannot be revealed from here; Stop and Kill All still work. A later request kind could add a reveal.
- Kill All is a destructive action behind one modal; the modal states the counts and consequences and offers Cancel. Sessions stay resumable (their files are untouched).
- **Open (round 2).** A native session held by another window is stopped through its broker's graceful stop, not the owner's native shutdown lifecycle (no stopped intent, no claim release by the owner), and the owner window's convergence after a remote shutdown is unverified; the per-tab gate protects only a window's own stops. `drivenHere` is slot equality; an editor-only runtime of this window is not a "this window" target. Driven and recorded routes prove the writer gone, not the broker retired.
- Serial stopping makes Kill All proportional to the number of processes (a graceful stop and a shutdown wait each). The result message arrives once; a progress notification names the count.
- The 30 s tick in non-`terminals` layouts means a process started by another window can take up to 30 s to appear in the Terminals group (an explicit refresh, visibility or a layout change reads at once).
- `Stop in This Window` still leaves background processes; the result message says how many remain and that Kill All in All Windows ends them.

## Rollout and Verification

1. Land the pure projection, `planKillAll` and the controller's `stopRow`/`killAll` with tests: represented versus loose rows, label and folder rules, group membership by layout, session marks per status and evidence, `planKillAll` tiers (this window by exact identity, other window, not run here, not stoppable), the modal's button set by tier, the re-derivation after the choice, the per-target report from a fresh read, a native session another window holds, a stop that fails, a vanished row, a cancelled modal, a final read that fails.
2. Land the provider changes with provider tests for the three layouts' roots, the group, `getParent`, no reveal in `terminals`, and mark repaint.
3. Land the wiring, package contribution, removal of the Processes view and docs.
4. `npm run typecheck`, the targeted tests, and an isolated VS Code window: the three layouts, process marks, clickable session and terminal rows, Stop Orphaned and Idle on an idle process, Kill All in one window, and Kill All with a second isolated window present (the all-windows offer), only on processes of the isolated profile.

## Related Decisions

- [ADR-0060](../decisions/0060-merge-background-processes-into-sessions-and-kill-all-through-authenticated-routes.md) records the lasting choices: Sessions is the one place, the shared reader, and Kill All's scope and no-request multi-window stop.
- [Processes view design](2026-10-07-processes-view.md): its classification, reader, authenticated stop routes and presentation words remain operative; its separate view, its poll rule, its titles and its "no stop-everything action" are superseded here.
- [ADR-0029](../decisions/0029-report-uncontained-pty-tree-stop-as-unknown.md), [ADR-0037](../decisions/0037-stop-a-recorded-broker-owned-managed-child-without-a-chat-runtime.md), [ADR-0039](../decisions/0039-refuse-only-on-a-verified-live-writer-the-extension-owns.md): no PID signalling; unchanged.
- [ADR-0015](../decisions/0015-serialize-tab-lifecycle-through-one-gate.md): every session stop still runs under the per-tab gate.
- [ADR-0056](../decisions/0056-publish-window-state-in-a-leased-registry-and-switch-windows-by-request.md), [ADR-0057](../decisions/0057-start-a-session-in-the-window-that-suits-its-folder.md): the window registry and request channel; not extended.

## Architecture Review

- Reviewer: independent `architect` agent, two rounds (2026-10-11).
- Outcome: round 1: accept after fixes (nine findings, F1-F9, all addressed in this revision and its code). Round 2: **not accepted**; five material findings remain, so this design and ADR-0060 stay `proposed`: (R2-1) a native session held by another window is stopped through its broker's graceful stop (a ConPTY close), which is not the owner's native shutdown lifecycle and records no stopped intent, a semantic change that needs the product owner's decision; (R2-2) the owning window's reconciliation of a remote broker shutdown is not implemented or proven (the broker can retire before the owner's exit handler runs), and the per-tab gate is window-local; (R2-3) `drivenHere` is derived from the slot only, and local editor-only runtimes are not represented; (R2-4) a driven or recorded route proves the writer gone, not the broker retired, so a broker hidden by an unreadable record can still be reported as stopped on those routes; (R2-5, addressed after the review) a notification with no retained editor reveals the session's process row in the Terminals layout.
- Notes: after round 2 the code gained a per-target local-eligibility check before each dispatch (a terminal another window attached during the batch is left alone and reported), broker-exit evidence on the broker route (a child stopped but a broker not proven gone is reported as not confirmed), and the notification reveal fallback. R2-1 to R2-3 and the driven/recorded half of R2-4 are open; see Risks.
