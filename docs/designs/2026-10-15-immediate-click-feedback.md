---
status: accepted
date: 2026-10-15
---

# Immediate feedback for clicks that start slow work

## Problem

Several actions in OMP Desk start work that takes seconds, and show nothing while it runs. The reported cases are **Resume** in the Chat composer and **Open** in the Sessions view: the user clicks, the button and the row stay exactly as they were for several seconds, and there is no way to tell whether the click registered. The cause is structural, not one slow step:

- Both paths run a chain of awaits in the extension host before anything visible changes: catalog readiness, the startup restore pass, the exit cleanup of an ended runtime, the owned-writer check (a reconcile that can start PowerShell process probes) and a **fresh PowerShell session-lease probe** ([ADR-0046](../decisions/0046-probe-omp-session-lease-for-external-writers.md)). Only then is the editor opened (Open) or the page re-rendered (Resume).
- The host's event loop itself stalls for 0.6 to 6.7 s in the logs, mostly outside any marked Desk operation, so even a host-side acknowledgement cannot be relied on to be quick.
- After the first change the page says "Catching up with the session…" (words that describe an attach, not a launch) and the Sessions row keeps saying **Stopped** until the index has finished admission, reconcile and a catalog write, and only repaints when an unrelated refresh runs: `SessionIndex` emits no change event.
- The composer's Resume button stays enabled and unchanged after the click. The inline Open button stays on the row, and when the row finally changes state it also changes position (non-stopped rows sort first), so a quick second click can land on another session's Open.
- The same silent wait exists in New Session (a catalog write first; a double click creates **two** sessions), Delete (up to about 10 s of checks before its confirmation), Forget, Kill, Close, Rename of a live row, Chat Stop, Export HTML, Reload All Windows, the inventory checkboxes and the Chat/Terminal view switch.

Numbers behind this, from the maintainer's logs: the lease probe took 0.2–3.6 s earlier on the day and hit its 5 s bound on every probe afterwards; process probes 0.2–9.4 s; the PTY runtime proof after window load 8.7–15.6 s; click to a running Chat 15–34 s. Reducing those steps is separate work (the lease probe has its own troubleshooting package); this design makes the wait **visible from the click**, with the current step, and makes duplicates harmless.

## Goals and Non-goals

- Goals:
  - Every in-scope action shows, **at the place of the click**, that it was accepted: within one frame in a Webview, and at the next tree repaint (under 100 ms where the host's event loop allows) in the Sessions view.
  - The feedback names the **current step** (for example `Starting · checking for another OMP process`), adds **elapsed seconds after 5 s** (`… · 7 s`) and shows an error **in the same place** when the action is refused or fails.
  - A repeated click on the same target is a guarded no-op that still tells the user what is already happening. New Session for a folder whose first new session is still starting does not reserve a second draft; it reveals the one that is starting.
  - A pending state cannot get stuck: it ends on completion, refusal, failure, a dismissed dialog, window or host reload, route loss and (in a page) a bounded stall timeout.
  - Operations that have no row or button of their own (Command Palette, Go to Session, keybindings, Export HTML, Reload All Windows) show **status-bar progress**; nothing else does.
  - The editor opens **before** the owned-writer check and the fresh lease probe on Open and Resume, so the user is looking at the session's history, with a pending state, while those checks run. This amends ADR-0046's recorded ordering; its guarantees are otherwise unchanged.
- Non-goals:
  - No change to ownership, admission, claims, run intent, the one-writer rule, the startup restore pass or the lease probe's behaviour or speed. Feedback is presentation only: nothing derives a row's state, published status or a decision from the pending registry, and it is never persisted. (One deliberate exception, the New Session single flight, is described and kept outside the registry.)
  - **Cancel before the launch starts** (an `AbortSignal` through the `SessionRuntime` port) is not part of this work; the decision is to do it later. No cancel affordance is added to a pending state here.
  - **Other windows do not show "Starting"** for a session launched in this window (the window registry record would change; later).
  - The lease probe's slowness (its own package).
  - No change to the content of the confirmations (Open Anyway, Stop and Open, Delete); only the order of the editor relative to the external-writer question changes.

## Current State

The two traces below were read against the source at the baseline of this work.

**Chat composer Resume.** `Composer.tsx` renders the button when the phase is `view-only` or `stopped`; `ChatClient.resume()` posts `omp:chat-resume` and keeps no state; `ChatRuntime.handleMessage` raises `resume-requested` (no request id); `extension.ts` `resumeFromChat` runs `timedLaunch(…, "resume")` and `openTab(…, "resumed")`. `openTab` awaits `ensureCatalogReady`, the ended-runtime cleanup (≤ 15 s), the in-flight join, and `openTabOnce`, which awaits the startup pass (for a row in its cohort), the legacy-host check, and `launcherOwnershipFacts(…, { fresh: true })` (claim read, `verifiedWriterPid`, the lease probe). Only then does it open the panel, call `showViewOnly(… "Starting the session…", phase "resyncing")` (not awaited; it re-reads the session file) and `sessionRuntime.open` (admission, reconcile, catalog write, launcher staging, host-control keys, runtime proof, spawn, conversation, run intent). The first visible change is the Resume button disappearing and the banner "Catching up with the session…".

**Sessions Open** (inline button, double click, Open in Chat/Terminal, Go to Session, a folder's history candidate): `openSession` first reads the claim (`heldByAnotherWindow`), may route to another window (`routeOpen`, up to 10 s), asks the external-writer question for a row *displayed* as `externalOmp` after a fresh probe, revives a restored tab (≤ 5 s), and only then reaches `timedLaunch` and `openTab`, so every step above precedes the editor.

**What exists to reuse.**

- `LaunchTimeline` (`src/host/launch-timeline.ts`) has a lap at every phase boundary of an explicit launch, logged as `window timing: <kind> <tab> running in N ms · …`. A lap on a tab with no run does nothing.
- `stoppingTabs` is a transitional row state, but a **published** one: `launcherFacts.stopping` makes the row `stopping`, and the row's state is what the window registry publishes to other windows (ADR-0056). It holds confirmed stops only.
- The tree renders `starting`/`stopping`/`checking` with a spinning icon. `SessionTreeProvider.setProcesses` shows the pattern for feeding it a snapshot that repaints only the rows whose words changed.
- `ChatRuntime` owns `#pages` and posts epoch-free messages (`omp:chat-code-theme`, re-posted from `resend` on attach); the page keeps such messages in a store separate from the chat model (`code-theme-store.ts`).
- Stats and Stop Process use Notification progress and single-flight.

## Proposed Design

### Constraints

1. **Presentation only.** The registry below is written by command entry points and read by renderers. `sessionItemState`, `launcherFacts.stopping`/`launching`, the window-registry publication, the click recognizer and every ownership, admission, lease and run-intent decision are **unchanged inputs**: pending text, icon and menu hiding are applied to the row's tree item after its state is derived.
2. **Only the Webview can promise one frame.** The extension host's event loop can be blocked for seconds, so a Chat button acknowledges in the page, in the click's own frame, before any host message. Tree and status-bar feedback is "before the first await of the command once its target is known", that is one host turn.
3. **One convention for display.** Every new pending text goes through one registry. `stoppingTabs` is **not** migrated: it is a published decision input (confirmed stops), not presentation.
4. **Host to page text is a bounded vocabulary** ([ADR-0017](../decisions/0017-never-forward-capability-bearing-error-text.md)): the page receives step **ids** from a closed union and maps them to words itself; reasons stay the existing fixed sentences.
5. **Layering** ([ADR-0065](../decisions/0065-enforce-one-import-direction-between-source-layers.md), [ADR-0066](../decisions/0066-extract-a-session-runtime-port-and-enforce-it-with-a-vscode-free-layer.md)): the vocabulary and text formatting are in `src/shared/`; the registry is VS Code-free in `src/host/`; the page message is in `src/protocol/`. The `SessionRuntime` port does not change.

### Vocabulary: `src/shared/pending-operation.ts`

One module, imported by the registry, the tree, the status-bar controller and the page.

- `PendingKind`: `open | resume | new-session | restart | view-switch | close | kill | delete | forget | rename | export | reload-windows | inventory-toggle`. There is deliberately no `stop` kind: a confirmed stop is `stoppingTabs`, which is a published row state, not presentation, and Close covers the pre-confirmation wait of the flows that end in one. `open` is a history open (the attempt may still launch, see below); `resume`, `new-session` and `restart` start a writer. `open`, `resume`, `new-session` and `restart` are the **launch family**: operations on one key in this family are one attempt, as `openTab` already treats them with `openingTabs`.
- Verbs: `open` → `Opening`; `resume`/`new-session`/`restart` → `Starting`; `view-switch` → `Switching view`; `close` → `Closing`; `kill` → `Killing`; `delete` → `Deleting`; `forget` → `Forgetting`; `rename` → `Renaming`; `export` → `Exporting`; `reload-windows` → `Reloading windows`; `inventory-toggle` → `Saving`. An `open` operation whose step has reached `admission` or later reads `Starting`, because from there it is launching. The stop family reads `Stopping` only from step `working`.
- `PendingStep`, a closed union, each with a lower-case phrase:

  | Step id | Phrase | Where it comes from |
  | --- | --- | --- |
  | `routing` | looking for the window that has it | `openSession` claim read and `routeOpen` |
  | `reserving` | reserving the session | New Session catalog write |
  | `waiting` | waiting for startup to finish | catalog readiness, startup pass, ended-runtime cleanup |
  | `ownership` | checking for another OMP process | owned-writer check and the fresh lease probe |
  | `confirm` | waiting for your answer | an open modal of the flow |
  | `admission` | claiming the session | `SessionIndex.restore` until the launcher takes the launch |
  | `prepare` | preparing OMP | launcher staging and host-control keys |
  | `runtime` | checking the runtime | broker client and PTY runtime proof, editor document, broker slot |
  | `spawn` | starting the background process | the broker launch call: resolution, the ADR-0075 probe, the ADR-0074 trust read and proof, the spawn and the handshake |
  | `boot` | OMP is starting | the process exists and OMP has not said `ready` (Chat: the conversation is `starting` or `attaching`; Terminal: host control is not verified yet); slice 7 |
  | `connect` | connecting | Chat only: OMP said `ready` and the conversation reads its first state (`resyncing`); slice 7 |
  | `checking` | checking | Delete/Close/Rename pre-checks, Forget reconcile, Kill identity probe |
  | `working` | working | the action's own execution (Stop, Kill, delete, forget, rename, export, reload, switch) |
  | `saving` | saving | inventory toggle |

- `pendingText(kind, step, elapsedMs)`: `<Verb> · <phrase>` plus ` · N s` when the elapsed time is at least 5 s and the step is not `confirm` (a user-answered modal's wait is not slowness and shows no seconds). After the registry's 60 s mark the phrase is prefixed `still `. Example: `Starting · checking for another OMP process · 7 s`.

### Registry: `src/host/pending-operations.ts`

A `PendingOperations` instance per window, in `WindowState`, built at activation and disposed with the window.

- `begin(key, kind, options) → handle`. `key` is the tab id for a session action, `folder:<id>` for a folder-level action, `window` for window-level ones (export, reload), `<inventory kind>:<row id>` for a toggle. `options`: `origin` (`row | composer | command`) and `requestId` (the Chat page's request id, or `null`). Synchronous; fires `onDidChange(key)`.
- **Origin is passed by the caller**, never derived from the argument's shape: `ompDesk.openSession` serves both the row's inline button and the palette, and Go to Session calls `clickSession` with a tree item. The registered handlers pass `row` when the command is invoked with a tree item by the view, `composer` from the Chat page, and `command` otherwise (palette, keybinding, Go to Session, the folder-history picker). The default is `command`.
- **Join per key and family.** A `begin` of an operation in the same family on the same key joins the operation in flight (reference-counted handle); a later `resume` joins and *upgrades* an earlier `open` (the double click's second click). Operations of another family on the same key are separate; the most recently begun one is displayed.
- `handle.step(step)`, `handle.end(status)` with `status` in `running | refused | failed | cancelled | handed-off`; the operation disappears when its last handle ends; `end` is idempotent. `registry.step(key, step)` sets the step of the displayed launch-family operation of a key (a no-op without one), so code that does not hold the handle (`openTabOnce`) can still name the step.
- `get(key)`, `list()`, `onDidChange`, `dispose()`.
- A 60 s mark per operation logs `window timing: <kind> <key> still at <step> after 60 s` once and turns the phrase into `still …`. It does **not** clear anything: the awaited work may still finish.
- No persistence, no catalog write, no cross-window record, no consumer that decides.

**Steps.** Steps that `openSession`/`openTab`/`openTabOnce` pass through themselves (`routing`, `waiting`, `ownership`, `confirm`, then `admission` once the ownership checks are done) are set by explicit `registry.step` calls at those places. The deeper steps come from the existing launch laps: `LaunchTimeline` gains one optional observer with two methods, `onLap(tabId, lap)` with `lap` a **closed `LaunchLap` union** (every lap name `launch-timeline.ts` callers use; a rename is a compile error) and `onAdd(tabId)` for the durations the broker launch reports after it returns (their keys stay free-form; any `add` means the launcher is past `spawn`). One table maps "lap X finished" to "step Y is now current": `admission`→`prepare` (staging follows), `stage`→`prepare` (host-control keys follow), `host control keys`→`runtime`, `runtime proof`/`editor document`→`runtime`, `broker slot`→`spawn`, any `add`→`connect`, `conversation`→`connect`. The laps `panel`, `draft` and `run intent` change no step: `panel` now fires before the ownership steps and must not advance them, and the operation ends in the entry wrapper's `finally`, not in a lap. The table has a test over every `LaunchLap`. `showViewOnly` is not awaited, so there is no history step. `LaunchKind` gains `restart` and `view switch` so those flows begin runs and therefore get the same laps (and, deliberately, `window timing` lines; today's header comment saying a mode switch adds no line is updated).

**Begin once the target is known, before the first await after it.** `begin` is the first statement after the command has its target: `openSession` after `tabIdArgument ?? pickIndexedTab` (a picker is the user's own wait, not slowness), `newSession` after the folder is chosen, `resumeFromChat`, `openSessionInMode`, the folder-history candidate, the restart flow. It is wrapped with the existing `timedLaunch` into one entry wrapper that also owns the single `finally` ending the operation. A hand-over to another window ends `handed-off`; a switch to the window that holds the session ends `running` at once. Other actions per the table in "Other actions".

### Editor first (the ADR-0046 amendment)

Today the editor opens only after the ownership checks, so on a click the user sees nothing for as long as those take. The amended order changes **only where the editor and the history paint sit in `openTabOnce` and where the external-writer question of `openSession` is asked**; every decision, claim, probe and write keeps its order relative to the others.

1. `openSession`: begin the operation (step `routing`), then the claim read, `routeOpen` and the revive of a restored tab, as today. The ask for a row *displayed* as `externalOmp` **leaves `openSession`** and becomes a flag (`externalRowClicked`) passed to `openTab`/`openTabOnce`, so a click on such a row still asks even for a stopped row's history view, but with the editor open. `ensureCatalogReady`, the ended-runtime cleanup, request numbering and the in-flight join in `openTab` are unchanged and still precede the editor: the editor is never created before the catalog is adopted (the startup cohort is fixed before that promise resolves, so an editor opened after it can never join the cohort).
2. `openTabOnce`, for an explicit open of a row with no running host here, after the startup-pass wait for a row in its cohort (that pass may be the row's own restore, so the editor waits for it as before): **the view-mode assignment moves up with the editor** (today it sits after the probe, and the default mode depends on the tab having no panel yet, so it must be decided and stored before the panel exists), a row-exists check precedes `openPanel` (the one after the probe stays), and then **the editor segment moves up**: `openPanel`, the `panel` lap, `refreshLauncher`, and the **history paint** (`showViewOnly`, not awaited, with the stopped or starting reason). The existing `lastOpenRequest <= lastEditorClose` guard keeps its meaning.
3. Then, in the order they have today: the legacy-writer "Stop and Open" check, the fresh lease probe and the external-writer question, the row-gone check, the rest of the attempt (`sessionRuntime.open`, admission and the launch).
4. **Open Anyway** upgrades the verb to `resumed` exactly as `openSession` does today for a confirmed click (`externalConfirmed ? "resumed" : verb`), and the pending banner replaces the history paint's reason, so "This session is stopped." never shows while it launches.
5. **Cancel** (of Open Anyway, or a declined "Stop and Open") starts nothing and writes nothing. **If the tab had no editor in this window when the attempt began and the row's run intent is not `stopped`, the editor is closed again.** "Created by the attempt" is recorded as a marker on the tab's state by whichever place opens the panel for the attempt, the editor segment above or the join branch of `openTab` (a repeated click while the first attempt runs opens a missing editor there), and is cleared when the attempt ends or the editor closes. The reason: opening the editor writes the editor-slot binding (`bindEditorSlot`, `setEditorMode`), a later reload would restore that editor into the startup pass, and that pass relaunches a row whose run intent is running without consulting the lease (ADR-0046's known limitation), which would silently undo the user's Cancel and fork the session. That outcome equals today's (no editor). **Otherwise the editor stays open showing the session's read-only history**, with the fixed sentence "Another OMP process is writing this session. It was not started here." through the existing `presentUnavailable` path; a stopped row's editor is never relaunched by the startup pass. The row's external state is refreshed as today.
6. **Closing the editor during the attempt is not a cancel.** Today the rest of the attempt runs either way ("an editor the user closed is not reopened … the rest of the attempt runs"), and an open modal is still answered. That stays; the operation ends with the attempt, and the row keeps showing it. (A real cancel is the later work.)

What does not change: ownership, the claim, admission, `verifiedWriterPid`, the fresh-probe-before-asking rule, the confirmation's text and trigger predicate, "a stopped row's plain Open never asks", Add to Session cancelling cleanly, and the known limitation for restored editors and automatic relaunches. What changes is that an editor and a read-only history view exist while the checks run, and the Cancel rule above.

### Sessions view (display layer only)

- The registry feeds the provider with a snapshot, `SessionTreeProvider.setPending(snapshot)`, as `setProcesses` does: the provider projects and repaints **only the rows whose text changed**. This replaces `refreshLauncher()` for pending changes, which also publishes the window snapshot, refreshes processes, inventory and context and reveals the active session, too heavy for every step or tick of a launch on a host that already stalls. Step changes coalesce to one repaint per turn.
- `SessionTreeItem` takes the row's pending operation after its state is derived. `item.state`, `facts`, the published status and the click recognizer's `argument.state` stay the real ones, so a double click still sees `stopped` and launches on its second click. The item's description becomes `pendingText(...)` (for the stop family only from step `working`; before that it reads `Closing · checking`, never `Stopping`, which is a published, confirmed state), its icon the spinning `sync~spin`, its tooltip adds the step and elapsed time. Its `contextValue` state segment is substituted (the forgettable/deletable/resumable segments are cleared too) unless the real state is `starting` or `stopping`: with **`pending-live`** when the real state is one that offers Kill (`running`, `working`, `background`, `question`, `unread`, `waiting`, `restoring`, `checking`, `otherWindow`) and with **`pending`** otherwise (a stopped or draft row being opened or deleted: nothing to kill). Kill's menu expression gains `pending-live` and nothing else; every other row action (Open, Rename, Close, Forget, Delete, Open/Show in Chat/Terminal, Reload) matches neither value and so vanishes from a row that is being acted on, which removes the double-submit target. The segment stays a middle segment, so the end-anchored expressions keep their shape. The `Opening` verb is shown for a history open, so a stopped row's plain Open never claims it is starting anything.
- A one-second ticker exists only while an operation older than 5 s exists and repaints rows whose text changed.
- **Position is fixed when the operation begins.** The provider remembers, per row with a pending operation, the group (`stopped`/`draft` or not) its order fact had when it first saw the operation, and uses that until the operation ends, so the row stays where it was clicked even when the index's `launching` or `running` fact flips earlier. The row then moves once, when the operation ends, as it does today. (It does not move while the user is acting on it, which is what made a second click land on another session's Open.)
- Aggregate progress: `window.withProgress({ location: { viewId: "ompDesk.sessions" } })` while the registry has an operation with a row (visible even when the row is scrolled away or its folder is collapsed).
- New Session: the folder row shows `New session · reserving the session` until the draft row exists, then the draft row carries the `Starting · …` text.
- **Reordering.** When an operation ends and the row's group changes, the projection reports the move as it does today for any state change (a structural change of the folder); it is not a repaint of one row. While the operation pends nothing moves.

### New Session single flight

The one decision this feature makes, kept **outside the registry** so the registry remains display-only: a per-folder single-flight map in the New Session command (`folderId → tabId | null`). `newSession` returns at once, after revealing, when the folder has an entry. The entry is taken right after the folder is resolved and **before `routeLaunch`** (a double click would otherwise route two launches), and cleared in the `finally` of the flow, which ends when that session's `openTab` returns (running, refused or failed). A launch routed to another window, or a New Session another window asks this one for (`window-routing.ts`), is not guarded by this map; that is acceptable. Once the draft exists the entry holds its tab id; a duplicate click then **reveals** that session (brings its editor forward, reveals its row in Sessions); before the draft exists the duplicate is only absorbed and the first click's own editor is the reveal. For display, the operation begins on `folder:<id>` (shown on the folder row as `reserving`) and, once the draft exists, a second `new-session` operation on the tab id (the launch family) takes over, the folder one ending then. A New Session for another folder is independent; `createSessionInColumn` (`/new`, delete-and-replace) reserves its own draft in place and is not guarded. A guard whose first session never settles holds only that folder until the window reloads; the sessions' own timeouts bound the launch, and Kill on the starting row remains available.

### Chat page

- **Page-local acknowledgement.** `ChatClient` owns a small `OperationStore` (not part of the chat model, so a `showViewOnly` epoch swap cannot erase it), with `getOperation`/`subscribeOperation`. `resume()`, `restart()`, `reconnect()` and `sendAbort()` record `{ kind, requestId, since }` in the click handler, before posting. The Composer's Resume button immediately becomes a disabled `Starting…` with the spinning codicon (reduced motion stops the spin, as elsewhere), the placeholder reads "Starting the session…", and a Stop button becomes `Stopping…` until the turn is no longer working or the abort result arrives. A second click is a no-op in the page.
- **Host acknowledgement and steps.** New epoch-free host-to-page message `omp:chat-operation` `{ operation: { kind, step, elapsedMs, requestId: string | null } | null, ended?: { requestId: string | null, status } }`; `kind`/`step`/`status` closed enums and `requestId` bounded in `src/protocol/chat-messages.ts`, validated by `parseChatHostMessage`. The page adds its own clock delta to `elapsedMs`, so nothing depends on the two clocks. `ChatRuntime` takes the registry as an option, posts the tab's operation to every page of the tab on change and from `resend` when a page attaches. `resume-requested` and `restart-requested` carry the request id so the entry wrapper begins the operation with it. A page that ignores the type (an older bundle behind a bridge route; unknown `omp:chat-*` messages are dropped) keeps the page-local state and its timeout; an older host sends nothing.
- **Refusals reach the page.** `ChatRuntime` refuses a resume or restart on the spot (`#tell`, for example "already running"); it now also posts `ended` with status `refused` and that request id, so the page does not wait out its stall timeout for an answer it already got.
- **Banner and errors in the same place.** While an operation is pending and the conversation is not live, the Chat banner shows `Starting the session · <phrase> · N s`, `role="status"`, `aria-busy`, instead of "Catching up with the session…" (which keeps meaning an attach). When the operation ends `refused` or `failed` the banner returns to the existing reason (`presentRestoreOutcome`, `presentUnavailable`, footer notices) and the button is available again; the notification the host already shows for launch failures stays, since the user may have moved away. An operation begun from another surface (the row's Open while this editor is visible) is shown the same way and also disables Resume here.
- **Elapsed seconds** come from a one-second ticker that exists only while the banner or button is pending.

### Status bar

`ProgressLocation.Window` progress, from one small controller in `src/wiring/` subscribed to the registry: **only** for an operation whose `origin` is `command`, where no row or button can show it. Title `<pendingText>` updated per step, ended with the operation. A one-second grace avoids flicker for operations that end at once. Operations from a row or the composer never show it.

### Other actions

| Action | Entry | Pending kind and steps | Shown at |
| --- | --- | --- | --- |
| Delete | `session-actions.ts` `confirmAndDelete` | `delete`: `checking` (writer check, deletion inspection, up to about 10 s), `confirm` (modal), `working`; a second Delete while pending is ignored | row |
| Forget | `session-actions.ts` `forgetSession` | `forget`: `checking` (reconcile), `working` | row |
| Kill (row, process row) | `session-actions.ts` `killSession` | `kill`: `checking` (identity probe), `working` (taskkill, gone-wait) | row |
| Close | `closeSession` → `confirmAndStopRuntime` | `close`: `checking` (transition facts before the modal), `confirm`, `working`; the confirmed stop keeps `stoppingTabs` as today | row |
| Rename | `renameSession` | `rename`: `checking` (writer check of a live row this window does not drive) | row |
| Chat Stop | composer | page-local `Stopping…` until the turn is idle or the abort result arrives | composer |
| Export HTML | `runChatAction` export | `export`: `working` | status bar (command origin) |
| Reload All Windows | `routing.reloadAllWindows` | `reload-windows`: `working` | status bar |
| Inventory checkbox | `inventory-controller.ts` `toggle` | `inventory-toggle`: `saving`, key `<kind>:<row id>` | row description `Saving <name>…`; a second toggle of that row is ignored until it finishes |
| View switch | `switchSessionMode` | `view-switch`: `checking` (transition facts, busy modal), `confirm`, `working` (graceful stop of the old process), then the launch steps from the timeline | the editor's banner and the row |

Each entry is a `begin`/`finally end` pair; a modal brackets itself with `step("confirm")` and back, so the wait is not read as slowness.

### Never stuck

| Holder | Cleared by |
| --- | --- |
| Host registry | the `finally` of the one entry wrapper (refusal, failure, a dialog dismissed, row gone, hand-over); window or host reload (in memory only); `dispose()` of the window. A closed editor does **not** end it: the attempt continues (above). The 60 s mark changes the words and logs; it never clears. |
| Page-local state | the host's `ended` or any later `omp:chat-operation`; the phase becoming `live`, `attaching` or `failed` (the host took over with its own banners); a route change or a lost host link (`guestTransport.onRouteChange`, as the footer does); **15 s with no host contact** → the fixed sentence "OMP Desk has not answered yet. It was not sent again." and the button is available again (a second click joins the attempt in flight); the page's own destruction when the editor closes. |
| Tree | derived from the registry snapshot at every projection; the position memory of a row is dropped when its operation ends. |
| Status bar | the progress's own promise resolves with the operation; the controller disposes with the window. |
| New Session single flight | the `finally` of the flow; window reload. |

Interactions: `openingTabs` and the index's duplicate-restore guard stay the authorities for de-duplication; the registry only displays them. The durable run intent and the catalog are untouched.

### Starting until ready (slice 7)

Measured on the maintainer's machine: a row turned `Running` 24 s before its Chat was live, and the whole start took 45 s. The entry returns when the broker has started the process (`running in N ms` in the log: 0.8 to 13 s) and the registry ended the operation there; OMP then needs 6 to 35 s more before it answers (`host control verified N ms after the command`), during which the page said "joining the session…".

- **Held operations.** `PendingOperations` takes an optional `launchReady(key)` returning `booting | ready | gone` (`src/host/launch-readiness.ts`, from the window's facts: Chat is ready when its conversation is `live`, `starting`/`attaching`/`resyncing` are booting; Terminal is ready when host control is verified, failed, or never carried (it has no other signal of OMP being up), and `gone` without a process). A launch-family or view-switch operation that has reached the launching steps and ends `running` while its writer is `booting` is **held**: it stays displayed, with its step, and ends `running` when the writer is ready or `failed` when it is `gone`. A second click that joins a held operation neither ends nor restarts it. The check runs when the launch says so (a conversation phase event, the end of the launch timeline's run, which host control verification ends) and once a second as a net, so an event nobody reports cannot leave a row starting. The existing bounds end it in the end: the Chat session's `ready` timeout fails the conversation, the control rendezvous wait fails the host control, a process exit makes the writer `gone`. Nothing else about the operation changes: it is presentation only, the 60 s `still` mark applies to it, and `end("failed")` of the entry still ends it at once.
- **Steps.** The conversation phase is the step once the process runs (`stepAfterChatPhase`): `starting` and `attaching` are `boot`, `resyncing` is `connect`; the laps put a launch in `boot` when the process exists. `spawn` reads "starting the background process". The Chat banner already shows the host's operation while the conversation is not live; the empty transcript now shows the same text in place of "joining the session…" (`Transcript` `startupText`), and keeps the old words for an attach nobody asked for (a reload).
- **What OMP exposes while it boots (verified against OMP 18.12.2).** In RPC mode OMP writes nothing to stdout until its `ready` frame. On stderr it writes, every 10 s from the start, `Still starting after Ns — phase: <open span path>` plus the path of its log file; with `PI_DEBUG_STARTUP=1` it streams `[startup] <phase>:start|done` markers, hundreds of them, for overlapping phases (plugin roots, model registry, extensions, skills, MCP, memory) with no marker for "checking providers" as one step; its log file holds provider discovery warnings. `ready` arrives in the middle of this (OMP goes on loading MCP tools and commands after it). Desk does not turn any of that into steps: the phase path is free text from OMP's internals, only visible after 10 s and naming one of several concurrent phases; the markers would need an environment variable on every launch and would fill the broker's stderr tail that exit reasons are read from; reading OMP's log file couples Desk to its format and location. So the boot is **one honest step**, `OMP is starting`, with the seconds. If OMP one day reports its progress through the RPC protocol (a frame before `ready`), it becomes steps here and nowhere else.
- **Not changed.** The error paths (a failed or timed out connection, a refused admission, a spawn failure) show where they did; the launch's own timeouts bound the work. Other windows still do not show `Starting` for a launch of this window. A restored session after a reload has no operation and shows what it showed.

### Slices

1. **Slice 1, Resume and Open feel immediate** (`efc7aac`): vocabulary, registry, timeline observer, entry wrappers (Open, Resume, Restart), tree display layer (text, icon, menus, fixed position, `setPending`, ticker, view progress), page store, `omp:chat-operation`, Composer and banner, status bar for command origin, and the Chat page's own **Stop** acknowledgement (page-local: the Stop button shows `Stopping…` in the frame of the click and returns with the next host state; it has no registry kind). Tests: registry, timeline mapping, tree, protocol, ChatClient, ChatRuntime, owned-Chromium composer harness, extension lifecycle.
2. **Slice 2, New Session single flight and editor first** (`0f46c41`): the guard with reveal; the new order in `openSession`/`openTabOnce` with the Cancel rule; the ADR-0046 amendment becomes operative.
3. **Slice 3, Delete, Forget, Kill, Close, Rename** (`38567f0`): the checks before a confirmation read `checking`, the confirmation `waiting for your answer`, the action `Deleting…`/`Killing…`/`Stopping…`; `PendingOperations.step` takes an optional kind for actions that are not launches.
4. **Slice 4, view switch** (`a606796`): a Chat/Terminal switch (and a Reload) is a `view-switch` operation, or the `resume` it ends in for a stopped session, with `checking`, `waiting for your answer` and `working`; it begins a `view switch` timeline run like Restart.
5. **Slice 5, Export HTML and Reload All Windows** (`1e16382`): command-origin operations under the key `window`, shown in the status bar after the grace; Export HTML shows from the end of its Save dialog.
6. **Slice 6, inventory toggles** (`697fcf8`): `InventoryController.toggle` begins an `inventory-toggle` operation at the click; the row reads `Saving <name>…` and a second switch of it is dropped (and the row repainted as it is) until the write is done.
7. **Slice 7, Starting until ready**: the held operation, the `boot` step and the startup text of the empty Chat transcript (above). Tests: registry hold, settle and poll, launch readiness and the chat-phase steps, the timeline observer's `onEnd`, the tree row at `boot`, the extension lifecycle (a launch stays pending through the conversation phases and ends on `live` or a failure), and the owned-Chromium page (the empty transcript names each step).

Each slice commits on its own with its focused tests.

## Alternatives

| Alternative | Verdict |
| --- | --- |
| A. More ad-hoc flags per action (another set like `stoppingTabs`, a boolean in `Composer`) | Rejected: no step names, no cross-surface view, each flag its own stuck-state risk. It is how the gap arose. |
| B. Host registry, page-local acknowledgement and `omp:chat-operation`, steps from timeline laps plus explicit steps at the entry points | **Chosen.** |
| B′. The same with explicit `pending.step()` calls at every phase boundary instead of laps | Viable; rejected for the launcher's deep steps because every boundary would carry two calls and `SessionIndex`/`LocalLauncher` a second dependency. The entry points, which have no lap, do call `step`. |
| B″. Feed the pending state through `sessionItemState` (new states) | Rejected after review: that function also feeds the window-registry publication (other windows would see it) and the click recognizer, and `stopping` would show before a stop is confirmed. |
| C. Persist "starting" in the catalog or run intent so every window shows it | Rejected: presentation in durable state survives crashes (stuck rows), needs the catalog write that is itself slow, and conflicts with ADR-0039/0056 semantics. Cross-window display stays a separate, later decision. |
| D. Notification progress for every click | Rejected for routine clicks: not at the place of the click, noisy, host-gated. Kept where it already exists (Stats, process stop, Resume Session's scan). |
| E. Only reorder the flow so the editor opens first | Not a substitute: the composer's button and rows without an editor still need an acknowledgement. It is part of this design (amendment above). |
| F. Status bar progress for every operation | Rejected by the maintainer: only operations without a row or button show it. |
| G. Cancel always leaves the early editor open | Rejected after review for rows whose run intent is not stopped: a reload would relaunch the session without the lease check, undoing the Cancel. The editor stays for stopped rows. |
| H. Cancel writes run intent `stopped` | Rejected: a lasting cross-window write the user did not ask for; the confirmation's Cancel adds nothing. |

## Risks and Open Questions

- **Cancel on a not-stopped row creates and closes an editor.** The user sees it appear and disappear. Accepted: it keeps the outcome of today (no editor) where leaving it would let a reload start a second writer.
- **Editor-slot binding is written earlier** than before (it moves with `openPanel`, ahead of the ownership checks). For a stopped row an editor VS Code restores is harmless. For a row whose run intent is not stopped, a window reload, or an extension-host restart while the question is still open, keeps the early editor (VS Code restores it, or it survives as a bridge page, ADR-0023), and the startup pass then relaunches the row without the lease check: ADR-0046's known limitation, now reachable before the user has answered. The window of exposure is the question's own duration; the Cancel rule covers the answered case. Closing the editor during the attempt removes the editor but not the attempt (above).
- **Row position** is held at the click-time group while an operation pends; the row jumps once when the operation ends. Accepted: it prevents the slide-under-pointer error.
- **Coupling of presentation to lap names.** `LaunchLap` is a closed union and the mapping table has a test over every lap, so a rename fails to compile or fails a test. Broker timing keys stay free-form; any of them only means "past spawn". `spawn` is long and coarse (resolution, probe, trust read, proof, spawn, handshake) because the launcher's laps do not split it; splitting it is separate.
- **`showViewOnly` re-reads the history** to paint "Starting…"; with a large file that read delays the first change. The page-local acknowledgement covers the wait; the read itself is not changed and is not awaited.
- **The host cannot acknowledge faster than its loop** (blocked up to 6.7 s in the logs). Only the page-local state meets one frame; tree and status-bar feedback is one host turn.
- **Bridge pages** after an extension-host restart (ADR-0023) on an older page bundle drop `omp:chat-operation`; they keep today's behaviour until reload.
- **Pending is local to a window.** A launch routed to another window ends here as `handed-off`; the receiving window shows its own pending state. "Starting" in other windows is later.
- **A launch that never settles** keeps its row, banner and (for New Session) the folder's single flight until the window reloads; the 60 s mark says `still …`, Kill on the starting row remains, the launch's own timeouts bound the real work.
- The lease probe's own slowness is unchanged here: the pending state shows its step but does not shorten it.
- **Diagnostics.** Restart and view-switch now begin timeline runs and add `window timing` lines.

## Rollout and Verification

Implemented in the seven slices above, one commit per slice on `main`, not pushed (`efc7aac`, `0f46c41`, `38567f0`, `a606796`, `1e16382`, `697fcf8`, and slice 7 in the commit that follows them). Cancel before the launch starts and the cross-window "Starting" display stay out of scope as decided.

- Unit: the registry (join and upgrade, step, end, idempotence, 60 s mark, dispose), the lap-to-step table over every `LaunchLap`, `pendingText` (elapsed after 5 s, `confirm` shows no seconds, `still`, `Opening` becoming `Starting`), tree display layer (state and published status unchanged, menus hidden, fixed position, stop family only `Stopping` from `working`), the `omp:chat-operation` parser, `ChatClient` page-local lifecycle (ack, host contact, refusal, stall timeout, route change), `ChatRuntime` posting, re-posting to attached pages and the refusal `ended`.
- Webview (owned Chromium harness, `chat-ui.test.ts` pattern): the Resume button is disabled with the spinner in the frame after the click with the host stubbed silent, the banner names the step, and the stall timeout returns the button.
- Extension lifecycle: with a lease observer that never resolves, the row is pending and the page received `omp:chat-operation` before the probe resolves; the **editor is open and showing history before the probe resolves**; Cancel of Open Anyway leaves the editor on a stopped row and closes the one this attempt created on a not-stopped row, and starts nothing in both; ADR-0046 cases still hold (no ask on a stopped row's history, ask on an externalOmp row click, Add to Session cancel, Open Anyway launches); a double click still launches; New Session twice for one folder creates one draft and reveals it; every exit path ends the operation.
- Smoke (one hidden test VS Code window): composer Resume, Sessions Open (inline and double click), New Session double click, Delete pre-check, Chat Stop, with first-visible-feedback timings and screenshots.
- Installed: the VSIX is built and installed in the main VS Code; the `window timing` lines report click to editor and click to running per click.

## Related Decisions

- [ADR-0046](../decisions/0046-probe-omp-session-lease-for-external-writers.md), amended by this design (ordering of the editor and the external-writer question; Cancel rule).
- [ADR-0039](../decisions/0039-refuse-only-on-a-verified-live-writer-the-extension-owns.md) (ownership unchanged), [ADR-0045](../decisions/0045-derive-window-folders-per-window-and-pin-with-identity-ids.md) (row-state precedence, unchanged), [ADR-0017](../decisions/0017-never-forward-capability-bearing-error-text.md) (bounded vocabulary), [ADR-0023](../decisions/0023-reconnect-surviving-webviews-through-an-authenticated-bridge.md) (bridge pages), [ADR-0065](../decisions/0065-enforce-one-import-direction-between-source-layers.md), [ADR-0066](../decisions/0066-extract-a-session-runtime-port-and-enforce-it-with-a-vscode-free-layer.md) (the port is not touched).
- [Detecting a session another OMP process is writing](2026-10-07-external-omp-session-lease.md), amended in step with ADR-0046.

## Architecture Review

- Reviewer: architect (an agent that did not write this document)
- Outcome: **accepted after two independent review passes.** First pass: not accepted as written (four material findings, eight should-fix items), resolved in the revision. Confirmation pass: acceptable after one material fix (A: the `pending` menu substitution had hidden Kill) and one tightening (B: "created by the attempt" must include an editor a repeated click opened through the join branch), both applied; minor item C and the lap, guard, reorder and `stop`-kind notes were applied too.
- Notes: the first pass confirmed the approach (display-only registry, page-local acknowledgement, epoch-free `omp:chat-operation`, steps from the timeline, layering). Resolved: **M1** (an editor left after Cancel is restored into the startup pass and relaunched without the lease check) by the Cancel rule; **M2** (an early editor before `ensureCatalogReady` would write the catalog before it is adopted) by dropping the early open in `openTab`; **M3** (an early open breaks the default view mode) by keeping the mode decision where it is; **M4** (pending inside `sessionItemState` leaks to other windows through the registry publication, breaks double-click and shows `stopping` before a confirmation) by making pending a display layer; S1 begin after the target is known; S2 the New Session guard is stated as the one decision and kept outside the registry; S3 timeline gaps (laps need a run, the `spawn` span, the `stage` mapping, typed laps); S4 a light `setPending` repaint instead of `refreshLauncher`; S5 refusal `ended` and the request id; S6 a closed editor is not a cancel; S7 join per family and the New Session key switch; S8 origin passed explicitly; nits N1 to N4. Left as decided by the maintainer: the editor opens first, the question is asked with it open, scope, status-bar rule, elapsed seconds.
- Confirmation pass resolved: **A** by the two substituted segment values `pending` and `pending-live` (Kill's menu expression gains `pending-live` only); **B** by the marker on the tab's state set by either opening place; **C** by the Risks entry on a reload or host restart while the question is open; the `panel`/`draft`/`run intent` laps change no step and the operation ends in the entry wrapper; the New Session guard is taken before `routeLaunch`; the reorder is a structural folder change when the operation ends; the unused `stop` kind is dropped. Implementation status is recorded under Rollout and Verification as slices land.
