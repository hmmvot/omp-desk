---
status: accepted
date: 2026-10-07
---

# Processes view: see and stop the extension's background brokers

> Shell-slot retention clauses below record the original design. The 2026-10-08 folder-shell lifecycle correction now retires slots after confirmed natural child exit, or after editor Terminate proves child absence and authenticated broker shutdown; successful Processes Stop also retires the slot. Descendant uncertainty remains truthful diagnostics, not a reason to retain an empty broker or report a failed shell stop. The immutable broker registry record is preserved. See [Current Architecture](../architecture.md#current-architecture).

## Problem

Every OMP session and every folder terminal runs under a detached PTY broker (a hidden `Code.exe` running the staged `pty-broker.js`, started with `--slot host:<id>` for a session or `--slot shell:<id>` for a folder terminal). Brokers survive window reloads and VS Code exit on purpose: that is what makes sessions recoverable. The same property means a user cannot see what is still running in the background and cannot stop a broker that has outlived its purpose. The only stop actions today hang off a Sessions row, so a broker with no row cannot be reached from the UI at all. A stopped folder terminal keeps its broker, empty but alive, by design: the broker cannot prove the process tree empty on Windows (ADR-0029), so it retains its record and waits for an explicit shutdown that nothing in the UI sends.

The Activity Bar container is also titled "OMP", which is the tool's name and says nothing about the product that lives there.

## Goals and Non-goals

- Goals:
  - Retitle the Activity Bar container, the settings section and the Output channel "OMP Desk", and update the README and CONTRIBUTING wording that names them. View ids, command ids and the command category `OMP` are unchanged.
  - Add a second collapsible view, **Processes**, below Sessions in the same container. One row per live broker of this extension in this profile, showing the kind (session or terminal), what it hosts, PID and uptime, whether a window has it attached or open, whether its OMP process or shell is still running, and a status that separates a broker the catalog references from an orphaned one.
  - Stop one process immediately, with no confirmation (an explicit action on one named row; a Force Stop is offered only if the graceful stop failed). Stop Orphaned and Idle Processes, which acts on many, asks once; Refresh sits in the view title.
  - Stopping uses only the existing authenticated stop paths and the existing Sessions state updates. No PID is ever signalled.
  - Rows this build cannot authenticate to (a predecessor build, or a broker of another protocol or runtime version) are listed with the reason they cannot be stopped here and their PID, so the user can end them by hand.
- Non-goals:
  - Ending any process by PID or process tree (`taskkill`, `TerminateProcess`). ADR-0029, ADR-0037 and ADR-0039 reject it, and the recycled-PID race of a check followed by a kill cannot be closed from outside the process. A handle-based kill mode in the staged helper, with its own ADR, is a possible later change.
  - Discovering brokers by scanning the process table. A broker with no record in this profile's registry is not listed.
  - Listing, repairing or retiring records whose broker process is gone. Those records are deliberate recovery metadata (`pty-registry.ts`); this view never removes one.
  - Releasing a folder terminal's shell slot after a stop. ADR-0029 keeps it while the tree is unproven; that rule is unchanged.
  - Stopping every process in one action (see Stop orphaned and idle).
  - Showing brokers of other VS Code profiles or of another extension.
  - Changing broker, registry or catalog formats, or the staged runtime.

## Current State

- `src/host/pty-registry.ts` keeps one immutable JSON record per slot under `<globalStorage>/pty/`: slot, kind, build digest, protocol and runtime versions, `brokerPid`, `brokerCreationTime` (kernel FILETIME of the broker, captured by the broker itself, nullable), `startedAt`, a title and the authentication token. `listPtyRecords` reads them. A record is removed only when the broker's child was never spawned, or by a caller that proved the broker gone; an explicit shutdown, a signal and the retention timer all keep it as recovery metadata. The registry therefore holds one record per broker ever stopped, and the reader below must not pay for them on every refresh.
- `PtyBrokerClient.connectRecord` proves a broker before trusting its token: protocol and runtime version equal this build's, the record names a creation time and a fresh kernel reading of `brokerPid` equals it, then an authenticated handshake naming the same slot and PID. A record with no creation time can never be authenticated.
- An attach without an owner hint (`attachRecord` with `owner` omitted) does not admit or disarm folder-shell owner cleanup (ADR-0030); it does reset the broker's no-client clock. `shellWriterFor`, `observeFolderShell` and `terminateFolderShell` always pass the owner hint and are not reused here.
- Stopping a terminal today: `terminateFolderShell` stops the child gracefully and never calls `shutdown`. The broker reports `tree: "unknown"` and `verified: false` on every stop (it never claims a proven-empty tree), so the slot-forget condition in that function is unreachable. Every stopped terminal therefore leaves a live, empty broker and a retained shell slot. Those idle brokers are the main population this view exists for.
- Session brokers are reachable from Sessions rows. `stopSessionHost` (modal, then `index.stopRecordedHost` behind the per-tab lifecycle gate and `stopBrokerOwnedHost`: stop the proven running child, then `shutdown`) serves a row this window does not drive, and `confirmAndStopRuntime` (modal, graceful stop, then an explicit Force Stop) a row it drives. Both capture their target before their modal and re-verify it afterwards (ADR-0039: a changed target is never stopped under an earlier confirmation) and update the row, claim, slot mapping and host control. `stopBrokerOwnedHost` refuses a broker whose child has already exited.
- A broker with no catalog row, no shell slot, or whose child has exited cannot be reached by any existing action.
- `queryPtyProcessIdentity` reads kernel creation times through the staged, digest-verified probe helper.
- The predecessor id `omp-vscode.omp-vscode` keeps its own global storage as a sibling directory (`predecessorStorageDir`). Its owner-only access has never been verified by this build, and the one-time import deliberately takes only the folder list because broker and shell records "authorize transports no record of this build proves".

## Proposed Design

### Naming

The view is **Processes**. "Brokers" is an implementation word the user never meets elsewhere in the product (Sessions, Chat, Terminal). What the user can reason about is "an OMP process that keeps running in the background after I close its window", and Task Manager has taught the word *process* for exactly that. The container title carries the product ("OMP Desk"), so "OMP Processes" would repeat it. The empty-state text explains the background nature.

### Components

1. `src/host/broker-processes.ts` — the pure model: row derivation and classification, the reader with its identity cache, formatting. No `vscode` import, every reading through a port. A row carries no token.
2. `src/host/broker-process-stop.ts` — the one new stop path (`stopBrokerThroughBroker`): attach to the recorded broker, stop its child if running, shut the empty broker down. Built on `PtyBrokerClient`, `PtyHandle` and `RpcHandle`.
3. `src/host/broker-process-controller.ts` — orchestration of Stop and Stop Orphaned and Idle over ports (the force and bulk confirmations, the existing row stop flows, notifications), testable with fakes.
4. `src/views/process-tree.ts` — `ProcessTreeProvider`, a thin `vscode.TreeDataProvider` over a snapshot.
5. `src/extension.ts` — one registration block, the port wiring, and a captured-target parameter on the two existing row stop functions.
6. Lossless reference reads: `BrokerSlotStore.references()` and `ShellSlotStore.references()`, each returning the slots it names and whether the stored value was fully readable.

### Where rows come from

- Source `current`: `PtyBrokerClient.list()` of this profile's storage. Source `predecessor`: `listPtyRecords` of the sibling predecessor storage, read only; no token from it is used and nothing in it is written, retired or authenticated against. A predecessor record this build cannot parse is ignored and counted.
- A record is a row only when its `brokerPid` is alive, the record carries a creation time, and a fresh kernel reading of that PID equals it. A dead PID, a recycled PID and a record with no creation time are not rows and are counted as hidden. Parsed records are cached by file name (records are immutable), so a refresh costs a directory listing, one liveness check per record and nothing else for a record already judged. A verdict of *gone* or *another process* is kept for good, keyed by the broker's id, PID and creation time (a broker never restarts and a creation time names one process lifetime), so each stopped broker costs at most one PowerShell probe ever. A *verified* reading is kept only while the PID stays alive, and dropped on every explicit read and every twelfth tick. Probes run at most four at a time. The caches affect only what is displayed; Stop re-reads fresh.
- The list itself authenticates to nothing. The extra facts below are read with one authenticated, owner-hint-free, read-only attach per row on an explicit read only (view opened, Refresh, after a stop, before a bulk action), at most four at a time, then disconnected. Predecessor rows and rows this build cannot authenticate to are skipped and have `child: unknown`. Ticks reuse the last answer.

### Row fields

| Field | Derivation |
|---|---|
| Kind | record kind: `managed-rpc`/`managed-omp` are *session*, `folder-shell` is *terminal* |
| Hosts | session: the row's headline and working folder; terminal: the folder of its shell slot; orphan: the record's own title, else the slot id |
| PID / uptime | `brokerPid`; uptime from `startedAt` (start time in the tooltip) |
| Child | `running` or `exited` from the authenticated status; `unknown` when not authenticated or not yet read |
| Window | session: this window runs or shows it (`launcherFacts`), or the Sessions provider's current claim facts say another window holds it; terminal: an editor of this window carries it, or the shell slot is recorded as open in an editor (`detachedAt === null`, which is not proof: it is also left set when a window ended abruptly), otherwise none |
| Status | see below |
| Flags | `older build` — record `treeDigest` differs from this build's packaged tree digest; `predecessor`; `no stop` — with the reason |

**In use** is a union, not a single lookup. A slot is referenced when it appears in any of: `brokerSlots` `byConversation` values whose conversation still has a row, `brokerSlots` `byEditor` values, any session index entry's recorded host (`host.rpc.slot`), and — for a terminal — the shell slot list. A conversation mapping whose row is gone references nothing (a stale mapping; `Forget` does not remove it), so the broker it names is orphaned. The launch path records the broker-slot mapping *before* it spawns the broker, and the row's host only afterwards (and not at all for an unconfirmed launch), so a classifier that read only row hosts would call a starting broker orphaned. A source is *fully read* only when none of these holds: the broker-slot table was structurally unreadable; it carries any unreadable or conflict-marker key (a malformed entry is persisted as a conflict marker and its slot is lost); the shell-slot value is not a list or dropped an element that did not parse; the session index reports a load error (it discards a whole snapshot on a schema mismatch); the catalog is still loading. Statuses:

- `in-use`: referenced;
- `orphaned`: not referenced by any source, and every source was fully read;
- `unknown`: not referenced, but the catalog is still loading or a source reported an unreadable or dropped entry (a mapping this build could not parse is not the same as no mapping).

Ordering invariant: the registry records are read first and the catalog (index, broker slots, shell slots) second, because the mapping is committed before the spawn: any record already seen then has its reference visible. Display ticks use this window's cached catalog; every explicit read, and every Stop and bulk action, refreshes the catalog after reading the records and re-derives the row.

Sorting: orphaned, then idle (child exited), then unknown, then in-use, then start time, newest first.

### Refresh and liveness

Registry files change only when a broker is claimed or retires, but a broker can die with no file change, so a file watcher alone cannot keep the view true. The view refreshes when it becomes visible, after every Stop, on the Refresh action, and on a 5 s timer that runs only while the view is visible (an in-flight refresh is never overlapped). A hidden view does nothing, which keeps the Sessions launcher's "nothing polls" rule in spirit.

### Stop

`omp.stopProcess` takes a row and runs:

1. **Fresh derivation.** Read records, refresh the catalog and re-derive. If the process is gone, the slot now names another broker (`brokerId` or generation differs) or the row cannot be stopped from here, nothing is stopped and the view says why.
2. **No confirmation for a single stop.** Stop is an explicit action on one named row, from its inline button or context menu, and is hard to trigger by accident, so it runs immediately. Safety comes from the fresh derivation above and from the identity captured here (slot, `brokerId`, generation, PID), which each route re-verifies before acting. The two prompts that remain are the second modal of the authenticated force stop (below, only after a graceful stop failed) and the one confirmation of Stop Orphaned and Idle, which acts on many processes. The process-tree caveat of ADR-0029 and the retained terminal record are documented here and in code comments, not shown to the user; the user-facing results are short (`Stopped the OMP session "X".`, or a plain reason when it was not stopped).
3. **Route**, decided from the fresh derivation:
   - **Driven by this window**, decided from the open tab states' runtime identity (slot, broker id and generation equal to the record), never from a mapping alone: the existing `confirmAndStopRuntime` with the *captured runtime, the `conflicting` flag and the transition facts passed in* instead of a boolean skip. The flag is read just before the stop, not recomputed at function entry, and the transition facts are read under `index.lifecycle.run(tabId, …)` exactly as today, so the force-stop target check keeps comparing against them. It refuses with a visible message (no stop) when the tab's runtime is no longer that object. Its own modal is skipped; its Force Stop prompt after a failed graceful stop is unchanged.
   - **Mapped row, not driven here, rpc transport, child running**: the existing `stopSessionHost` with the `{slot, attemptStartedAt, pid}` read just before passed in instead of a boolean skip. It refuses when the row's host attempt or broker-slot provenance differs from that reading. It updates `runIntent`, claim, mapping and the Sessions row exactly as Stop on that row does. It is graceful-only: a failed stop is reported as unconfirmed and no force is offered, as for the row's own Stop. A **native-transport** row not driven here is reattached first, as the row's own Stop does, and its runtime's passive flag and transition facts are then read and handed to `confirmAndStopRuntime`, so no prompt appears for it either.
   - **Everything else** — a terminal, an orphan, a mapping with no row or a row with no recorded host, or any broker whose child has exited: `stopBrokerThroughBroker`. It attaches to the recorded broker without an owner hint (`attachRpcRecord` for an rpc session, `attachRecord` otherwise), requires the handshake's slot, `brokerId`, generation and PID to equal the capture, then: if the child is running, stop it gracefully and require `pidGone`; if that fails, a second modal offers an **authenticated force stop** (`handle.stop({ mode: "force" })`, which the broker performs through its own handles, never by PID) and again requires `pidGone`. With the child gone, `shutdown({ requireStopped: true })`, then wait for the broker PID to disappear. The tree is reported as unknown, never empty (ADR-0029). The broker keeps its record; this view never touches one. A session slot with no row or no recorded host is forgotten from the broker-slot mapping once its writer is gone, as the row path does. A terminal's shell slot is kept. A session row whose child exited on its own keeps its run intent: stopping the empty broker changes no ownership fact the row's state is derived from, so this route writes no stopped intent.
4. The view and the Sessions launcher refresh (`refreshLauncher({ ownership: true })`).

### Stop orphaned and idle

`Stop Orphaned and Idle Processes` (view title) takes a fresh derivation and selects rows that are `orphaned` or whose child has `exited`, are authenticable, are not driven by this window and whose window is not this window. One modal states the counts by kind, that any OMP session or terminal still running inside them ends, and that an idle process open in another window loses its retained final screen. After the modal it re-derives once more and runs only rows that are still selected under the same rules, through the broker-only route, with no second prompts and no force. Failures are summarised in one message naming the rows left running. There is deliberately no "stop everything" action: ending live driven sessions in this and other windows through one confirmation is a product decision this design does not take.

### Package contribution

- Activity Bar container title, `contributes.configuration.title` and the Output channel: `OMP Desk`.
- View `omp.processes`, name `Processes`, below `omp.sessions`, collapsible; activation event `onView:omp.processes`; a `viewsWelcome` entry for the empty state.
- Commands `omp.refreshProcesses`, `omp.stopProcess`, `omp.stopOrphanedProcesses`, category `OMP`. `omp.stopProcess` is hidden from the Command Palette (it needs a row); an inline Stop on rows that can be stopped, Refresh and Stop Orphaned and Idle in the view title.
- The command category stays `OMP`: it is the namespace users type in the Command Palette and it is consistent across every command. Other user-facing names were checked: the Output channel was the only one still saying "OMP" for the product.

### Predecessor decision

Predecessor brokers are listed read-only, flagged, with no stop action and the reason; their records are never used to authenticate or signal, because that directory's owner-only access has never been verified by this build and the existing import already refuses to turn predecessor broker records into authority. The row shows the PID and the predecessor's id so the user can close the sessions in the old build or end the process in Task Manager (see [publishing notes](../publishing.md#moving-from-the-unpublished-local-build)).

## Alternatives

- **End the process tree by PID** (`taskkill /T /F` after a creation-time check) for brokers that cannot be authenticated. Rejected: it contradicts ADR-0029, ADR-0037 and ADR-0039 and the code's "no process id is signalled" invariants; the check and the kill are not atomic; `/T` follows parent links that are not creation-time checked. A handle-based mode in the staged helper with its own ADR could close this later.
- **Add a kill mode to the staged probe helper now.** Gives a tight check-and-kill window, but changes the staged runtime digest, gives a helper terminate rights for the first time, and needs its own ADR and security review. Deferred.
- **Process-table discovery** (a WMI command-line scan for `pty-broker.js`). It would find brokers whose record was lost, but needs a new script, a spawn per refresh and a way to prove a command line belongs to this profile. A lost record for a live broker is a registry bug, not a use case.
- **Authenticated status for every row on every tick.** Costs a handshake per broker per tick and resets each broker's no-client clock. Rejected; it is read on explicit refreshes only.
- **Classify orphaned by session-row hosts only.** Misclassifies a starting, unconfirmed or editor-only-mapped broker. Rejected for the union above.
- **Require `tree === "empty"` before `shutdown`.** The broker never reports it, so no terminal could ever be stopped. Rejected.
- **Release the shell slot after a stop.** ADR-0029 forbids it while the tree is unproven. Left unchanged; the slot limit pressure it implies already exists.
- **Name the view "Brokers".** Accurate to the code, opaque to a user. Rejected.
- **A file watcher for liveness.** Registry files do not change when a broker dies. Rejected as the only mechanism; the visible-only poll covers it.

## Risks and Open Questions

- A stopped terminal's shell slot stays recorded, so Reconnect Terminal still offers a terminal whose broker this view shut down, and fails honestly. This is unchanged behaviour that the view makes more visible. A product decision to amend ADR-0029's slot-release rule is outside this design.
- Windows cannot prove a detached descendant tree empty (ADR-0029). Every report says so; this view claims only that the broker's child is gone and the broker has shut down.
- A row can be `unknown` for a long time if the catalog reports a dropped entry; Stop remains available for it, Stop Orphaned and Idle skips it.
- The 5 s poll spends a few file reads per refresh while visible; the explicit-read attach is bounded to four at a time.
- Brokers this build cannot authenticate to can only be ended by hand; the row says so.

## Rollout and Verification

1. Land the model with tests: row derivation and classification (kinds, the union of references, unknown on unreadable sources, orphan, idle, ordering), hidden dead and recycled PIDs, records without a creation time not listed, the identity cache and its invalidation.
2. Land the broker-only stop with tests against the real in-repo broker fixtures where they exist, and fakes otherwise: running child (graceful, then shutdown), exited child (shutdown only), handshake mismatch refused, force only after a failed graceful stop and only on request.
3. Land the controller with fake ports: fresh derivation refuses a vanished or changed target, a captured runtime that changed is refused, Stop Orphaned and Idle never touches a driven or in-use running row, and a failure is reported.
4. Land the tree provider, package contribution, the captured-target parameters, wiring and docs; update `docs/architecture.md`, README, CHANGELOG.
5. Run `npm run typecheck` and the targeted tests, and prove in an isolated VS Code window: container title, Processes listing a session and a terminal process, Stop ending each at once, a process listing showing it gone, and the Sessions row reflecting the stop.

## Related Decisions

- [ADR-0012](../decisions/0012-run-child-process-entries-from-staged-copies.md), [ADR-0024](../decisions/0024-own-omp-pty-for-in-tab-terminal.md), [ADR-0029](../decisions/0029-report-uncontained-pty-tree-stop-as-unknown.md), [ADR-0030](../decisions/0030-watch-the-verified-owning-vscode-process-for-shell-grace.md), [ADR-0035](../decisions/0035-distinguish-a-recorded-process-from-a-later-occupant-of-its-pid.md), [ADR-0037](../decisions/0037-stop-a-recorded-broker-owned-managed-child-without-a-chat-runtime.md) and [ADR-0039](../decisions/0039-refuse-only-on-a-verified-live-writer-the-extension-owns.md) constrain stop behaviour, identity and ownership; none is changed. [ADR-0015](../decisions/0015-serialize-tab-lifecycle-through-one-gate.md) (per-tab gate), [ADR-0034](../decisions/0034-store-sessions-in-one-profile-catalog.md) (profile catalog) and [ADR-0040](../decisions/0040-switch-one-editor-between-rpc-chat-and-native-pty.md) (native stop rules) are respected by reusing the existing row stop flows.
- [Workspace-independent Sessions catalog design](2026-09-28-workspace-independent-sessions.md) records the predecessor-id import this design mirrors for discovery.

## Architecture Review

- Reviewer: architect
- Outcome: accepted after two review rounds.
- Notes: the first review of an earlier draft, which ended unauthenticable broker processes by PID, found two blockers (PID signalling contradicts ADR-0029, ADR-0037 and ADR-0039; the terminal graceful path could never reach `shutdown`) and five majors (authenticated force skipped, boolean skip parameter, under-specified orphan classification, record retirement, predecessor trust). This draft removes PID signalling, adds the authenticated force stop and `shutdown`, defines the union classification, uses captured targets, never touches records and lists predecessor brokers without a stop action. The confirming pass found no blocker or major; its two required corrections (records are retained on shutdown, and the reader must cache gone verdicts and parsed records because stopped brokers' records accumulate) and its clarifications (readability flag, captured `conflicting` flag, native reattach sub-path, run intent, idle-row modal text) are folded in above.

## Presentation amendment (2026-10-08)

The classification and authenticated stop policy above are unchanged. Visible rows no longer expose process IDs or connection identifiers: referenced running processes say Open in this window, Open in another window, or Running when no window is known. Orphaned and Idle retain short explanations. Plain-text hovers show kind, what is hosted, locale-formatted and relative start time, and uptime through the same pure duration formatter as Chat. Copy Diagnostics in the context menu copies the full token-free row through the extension's capability redactor. Unavailable-stop explanations use user-facing version and Task Manager guidance; identity/version fields remain in diagnostics. Successful single and bulk stops refresh the view without an extra toast, while unconfirmed or changed targets still warn and retain technical failure details in Output.

## Stats kind amendment (2026-10-08, accepted)

The accepted [Stats design](2026-10-08-stats-dashboard.md) adds a `stats-dashboard` broker kind and a distinct **Stats dashboard** Processes row. Its broker record itself references standalone background work; it needs no session or shell catalog mapping. A live record is never orphaned, and bulk Stop includes it only after its child exits. Both single and bulk Stop retain authenticated broker/root generation checks and never alter session/shell mappings for Stats. Older builds lacking the kind treat its record as unreadable rather than misclassifying it.

