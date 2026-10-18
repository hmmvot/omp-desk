---
status: accepted
date: 2026-10-18
---

# Fork, Branch and Clear for a session: typed commands, Sessions menu and the Chat

Requested by the maintainer (2026-10-18): `/fork` and `/branch` in the Chat, a **Fork** and a **Branch** entry and a **Clear** entry (`/clear`) in the context menu of a session in the Sessions view.

## Problem

- Typed `/fork` is refused today with "This command changes the session's identity or file, so it is not available in the chat. Use the Sessions panel instead." (`DENIED_SLASH_COMMANDS.fork`), and the Sessions panel has no Fork. OMP's own `/fork` moves the running process onto the new file, which Desk cannot do: a Chat tab is bound to one file (ADR-0038, ADR-0025).
- `/branch` typed with no arguments already opens the in-page Rewind picker (`isRewindCommand`, ADR-0051); there is no way to reach it from the Sessions view.
- `/clear` (ADR-0059) runs only when typed into that session's composer; the Sessions menu has no entry for it.

## Maintainer's decisions (binding)

1. **Fork opens in a new tab.** The original tab, its OMP process and its file are not touched. The fork is a separate Desk session: its own OMP process, its own row, its own Chat tab beside the original. Both can be continued.
2. **Fork is for live sessions only**, like `/clear`: it needs the session's running chat process. A stopped session gets no Fork entry.
3. **Branch** shows the session in the Chat (opens or reveals it) and opens the Rewind message picker, exactly as typed `/branch` does.
4. **Clear** in the context menu asks first with a modal dialog; after Yes it runs the same path as typed `/clear` (same refusals, same deferral). Typed `/clear` stays unconfirmed.

## Goals and Non-goals

- Goals: the three typed commands and three menu entries behave as above; typed `/fork pane|window|tab` is refused with one line; a busy session is refused with OMP's own sentence; the new session carries the original's whole history and a parent link OMP itself recognises.
- Non-goals: forking at an earlier message (OMP's RPC `fork {entryId}`; Rewind covers "go back" in place); forking a stopped session; forking a Terminal-mode session; renaming the fork; a fork-tree view; opening the fork in another window.

## Current State (measured against the installed OMP 18.11.1 and this tree)

- Typed slash handling: `deskSessionCommand` (`src/chat/desk-commands.ts`) recognises `/clear`, `/new`, `/delete`, `/fresh`; `ChatRuntime.#serveDeskCommand` answers them, `runDeskAction` (wired in `extension.ts`) runs `new-session`/`delete-session`. `classifySlashInput` still denies `fork`, so the page refuses `/fork` before sending. Slash suggestions list the four Desk commands with Desk descriptions (`DESK_COMMANDS`, `slash-completion.ts`); `fork` is not listed and is removed from OMP's catalogue by `slashSuggestions`.
- Sessions rows carry `contextValue = ompSession.<forgettable|held>.<state>.<resumable|live-only>.<deletable|file-kept>.<materialized|fileless>.view-<chat|terminal|none>`. Live states are `running|working|background|question|unread|waiting`. Rename, Reload and Close (`2_manage`) find their row by `sessionTargetFromArgument(index, argument)`: a `SessionTreeItem`, a tab id string, else the editor in front, else a showing panel, else `index.activeTabId` (so the palette works on the session in front). `ompDesk.rewindConversation` acts on `activeChatTab()` only.
- A new Desk session is `index.createDraft({cwd, scope})` (a fileless draft row and claim), then `openTab(…, "started")`; the process starts without a session flag and `RpcSession` learns the exact file from `get_state` (`#boundFile` null → `identity` event → the index records it). An existing file is `trackSession` + `openTab(…, "resumed")` with `--session <file>`.
- `rpcOmpLaunchSpec` states "`--fork` … never used" (ADR-0038 era), because no Desk flow needed it.

### OMP facts

| Fact | Source (OMP 18.11.1 package source) |
| --- | --- |
| TUI `/fork` (no arguments) refuses while streaming: "Wait for the current response to finish or abort it before forking.", then `session.fork()` rewrites the process onto a new file | `modes/controllers/command-controller.ts` `handleForkCommand` (1399-1415) |
| RPC `fork {entryId?}` calls `session.fork(entryId, {requireIdle: true})`, which also moves the RPC process onto the new file | `modes/rpc/wire/commands.ts` 272, `agent-session.ts` `fork` (10019) |
| `SessionManager.fork()` (live) mints a new session id and file, sets `parentSession` to the old id, keeps title, rewrites the same entries | `session/session-manager.ts` 2429-2469 |
| **OMP's own `/fork pane\|window\|tab` leaves the source untouched**: it flushes the source session, then starts a second `omp … --fork <absolute source session file>` in a new multiplexer pane. It may run mid-turn (with a confirmation) because the source is not switched | `command-controller.ts` `#handleForkTerminalCommand` (1439-1566), argv built at 1519 |
| `--fork <path or id>` calls `SessionManager.forkFrom(source, cwd, sessionDir, undefined, {repairInterruptedTail: true})`, then the process runs on the fork. `forkFrom` copies every non-header entry to a new `<timestamp>_<id>.jsonl` in the cwd's session directory (or `--session-dir`), header `parentSession = source header id`, title and title source copied, artifacts copied, tool calls the source left unresolved paired with unknown-outcome results; a missing source throws `ForkSourceNotFoundError` ("Session … not found") | `main.ts` `createSessionManager` (1212-1243), `session-manager.ts` `forkFrom` (4018-4081) |
| The fork's model and thinking level are restored from the copied entries (`hasExistingSession`), without `--model`/`--thinking`; passing them marks the cache shape as changed and drops the inherited prompt-cache key, which is why OMP's pane fork has to add `--prompt-cache-key` by hand | `sdk.ts` 2015-2066, `main.ts` `buildSessionOptions` 1425-1439 |
| `--fork` is a flag of the root command, accepted in every mode (`--mode rpc-ui` included); it is absent from `omp --help` but used by OMP itself (above) and named in its changelog | `cli/flag-tables.ts` 137, 392 |

## Proposed Design

### The mechanism: Desk starts the fork process with OMP's own `--fork <source file>`

Fork = a **new Desk session whose OMP process is launched with `--fork <absolute path of the source session file>`**. The original process, tab and file are never touched; the source is only read, by OMP, exactly as in OMP's own pane/window fork. `--fork` writes the fork file (new id, `parentSession` header link, copied title, copied history and artifacts) before the process serves RPC, so the file is one OMP itself produced and recognises (`parentSession` is written by `SessionManager.forkFrom`; whether OMP's resume picker groups it under the original was not observed).

The new row is created the way New Session creates one: `index.createDraft({cwd: <the live process's cwd>, scope: <the original row's scope: profile and session directory>})`, then the editor is opened in the column of the original tab (`createSessionInColumn`). The only difference is the launch: `LocalLauncher.launch` asks a small window-scoped registry, `PendingForks`, for the fork source of this tab (keyed by tab id, in memory) and passes it as `forkFrom` to `launchRpc`; `rpcOmpLaunchSpec` emits `--fork <source>` instead of `--session`/`--session-dir` (a `--session-dir` is still emitted so the fork lands in the same directory as a new session of that row would).

- The identity is learned from `get_state` like any new session; `RpcSession` reconciles the copied history through `get_entries`. The draft becomes a materialized row (OMP's own title, `parentSession` in the file), so a reload or reopen resumes it with `--session <file>` and never forks again.
- `PendingForks` is kept until the fork has shown a file: `LocalLauncher.launch` peeks it for every launch of a fileless draft and forgets it when a launch finds the row materialized (`sessionFile !== null`) or native. Nothing is spent by `running`: `launchRpcHost` reports `running` once the broker reports the child's pid, while `--fork`'s own failures (`ForkSourceNotFoundError`, an unresolvable source) happen later, in the child. A fork process that exits before the identity is learned therefore leaves a fileless draft whose next Resume or Restart forks again from the same source, never an empty ordinary session; the entry is inert once the row has a file or is gone (tab ids are unique), so a leaked entry costs a map slot until the window ends. It is memory only: a window reload before the identity was learned restores a plain draft, the same loss any unlearned new session has, and the file written by a fork whose process was lost is an ordinary OMP session in OMP's history that Desk never deletes.
- **The first launch of a fork draft is Chat-only in this window** (like `/new`'s exception to ADR-0057 routing in ADR-0059): `--fork` exists only in the rpc launch. A native launch (**Open in Terminal** on a draft) forgets the source and starts an ordinary session rather than ignoring it silently; the action runs in the window that holds the original's live process, so no routing decision is needed.
- `rpcOmpLaunchSpec` keeps refusing the other session flags: `--fork` is emitted only when `forkFrom` is set, never with `sessionFile`, never with `--continue` or bare `--resume`.

### Preconditions of a fork (the host decides, with OMP's own sentence)

A new `RpcSession.forkSource()` returns `{status: "ready", file, sessionId, cwd}` or a refusal, from host-known state like `/clear`'s `#clearBlock`:

- not live, identity not verified, a mutation fence or another transition → `not-live`/`busy`;
- a response is streaming or working, compaction or maintenance running, async work paused, a dialog open, the session not settled or a message queued/unconfirmed → `busy`, shown as OMP's own sentence **"Wait for the current response to finish or abort it before forking."** (`FORK_BUSY_SENTENCE`);
- no durable entry yet or the file does not exist (`fs.stat`) → "This session has no saved messages yet, so there is nothing to fork.";
- the file must hold the entry the live conversation is at (`src/host/fork-source.ts`: `HistoryReader.snapshot(1, liveLeaf)` reports the leaf it could use, which differs from the asked one while the disk trails the process): OMP's writer is asynchronous and `--fork` reads the file, whereas OMP's own pane fork calls `sessionManager.flush()` first. A mismatch waits up to 2 s for the writer, then refuses "OMP is still saving this session. Try again in a moment." (see Risks).

The original is never fenced: the checks and the launch of the fork race only against the original's own writer, which is exactly the situation of OMP's `--fork` from another terminal.

### Entries

| Surface | Behaviour |
| --- | --- |
| Typed `/fork` (no argument) | `deskSessionCommand` gains `fork`. `#serveDeskCommand` refuses arguments with "/fork takes no arguments here: the fork opens in a new Chat tab." (this covers `pane`, `window`, `tab`: OMP's terminal-multiplexer placements), then `forkSource()` refusals are told in the Chat footer; otherwise it runs the Desk action `fork-session` for the tab. Every outcome is `explained`: nothing reaches OMP as a prompt. |
| `ompDesk.forkSession` — **Fork Session** | Sessions row (`view/item/context`, live rows owned by this window), Chat editor title menu, palette (acts on the session in front). Same extension function as the typed command: target by `sessionTargetFromArgument`; a verified survivor not yet attached is reattached first, exactly as Rename does; Terminal-mode sessions and stopped rows are refused with a sentence; failures are toasts. |
| `ompDesk.branchSession` — **Branch…** | Sessions row and palette. Requires a live Chat conversation of this window (a Terminal-mode or stopped session is refused with a sentence: Branch never switches a view or starts a process). Shows the session in Chat (`openSessionInMode(…, "chat", "show")` reveals the open editor or reopens a closed one onto the running conversation), waits for the page's ready announcement (as `deliverInsertion` does), then posts the new panel action `open-rewind`, which the composer's registered handlers turn into `onRewind()`, the very function typed `/branch` calls. Not on the Chat editor title menu: **Rewind Conversation…** is already there. |
| `ompDesk.clearSession` — **Clear Context…** | Sessions row, Chat editor title menu and palette. A modal warning "Clear the context of the OMP session «title»?" with detail "OMP forgets the conversation so far: later replies no longer see it. The session, its file and its title stay, and the earlier messages stay in the transcript behind a “Context cleared” divider." and the button **Clear Context**. After the button, `ChatRuntime.clearConversation(tabId)` runs the same flow as typed `/clear` (`RpcSession.clear` with the deferral callback, the `CLEAR_*` sentences of `src/chat/clear.ts`; jobs and queued work refuse or defer as for typed `/clear`). Typed `/clear` is unchanged and unconfirmed. Outcomes are told to every route of the conversation (footer feedback, as now) and, for a menu or palette run, also as a toast so a closed editor still gets the answer. |

Menu placement: a new `2_conversation` group between `1_open` and `2_manage` (Fork Session `@1`, Branch… `@2`, Clear Context… `@3`) in the Sessions row menu. Three `when` clauses, as the tree already has per command: Fork and Branch `viewItem =~ /^ompSession\.[^.]*\.(running|working|background|question|unread|waiting)\.[^.]*\.[^.]*\.materialized\.view-(none|chat)$/` (live states of this window; an `otherWindow` row is a separate state; fileless live drafts have no history to fork or rewind), Clear the same without `materialized`. `view-none` includes a live row whose editor is closed, so the command still refuses a Terminal-mode host (`liveChatTarget` does).

### Slash completion

`DESK_COMMANDS` lists `/fork` with a Desk description ("Fork this session into a new Chat tab; the original keeps running"). `classifySlashInput` keeps `fork` in the denied list (the session never forwards a `/fork` prompt if the page's interception is bypassed), exactly as `clear`/`new`/`delete`.

### Files

New: `src/chat/fork.ts` (vocabulary: sentences), `src/host/fork-source.ts` (the disk check), `src/host/pending-forks.ts`. Changed: `desk-commands.ts`, `slash-completion.ts`, `protocol/messages.ts` and `webview/lib/panel-actions.ts`, `Composer.tsx` (`open-rewind`), `host/rpc/session.ts` (`forkSource`), `host/chat-runtime.ts` (typed `/fork`, `clearConversation`), `host/slash-registry.ts` (`fork-session` action), `host/rpc-launch.ts` (`forkFrom` in the spec and the request, `--fork`), `runtime/local-launcher.ts` (passes `forkFrom`, settles the registry), `runtime/session-runtime.ts` and `runtime/local-conversations.ts` (the `ConversationPort` methods), `extension.ts` (the three commands, `deliverPanelAction`, the window's `PendingForks`), `package.json` (commands, menus, palette).

## Alternatives

1. **RPC `fork` on the live process, then re-attach.** Rejected by the maintainer's decision: it moves the original's process onto the fork file, so the original tab would have to be reopened on the old file (a second process on a file whose lease the first just left) and the user's tab would silently become the fork.
2. **Desk copies the session file itself** (read to the leaf, write a header with a new id and `parentSession`). Rejected: it is a second writer of OMP's file format (title slot, blob references that `forkFrom` resolves, artifact directory, repair of unresolved tool calls, version migration), against Desk's rule that no extension code edits OMP's session files directly (the stopped rename goes through OMP's own storage code). Any format change in OMP would silently produce forks OMP rejects or misreads.
3. **A bounded Bun helper that calls `SessionManager.forkFrom`** (the stopped-rename pattern), then `trackSession` + resume the new file. Equivalent file, no extra live start, and it keeps the fork's exact path known before the process starts; rejected because it imports a private class from the installed package source, so it fails on a compiled-only install (`resolveOmpPackageRoot` is null) and on any internal rename, while `--fork` is a command-line surface OMP itself builds on (it passes it to the pane fork). It also adds a staged asset, a packaging entry and a second code path to maintain.
4. **A short-lived `omp --fork … --mode rpc` that only writes the file, then a normal resume.** Rejected: a full OMP start (extensions, MCP servers, model resolution; the login helper's own startup notes show the quirks) only to learn a path that the real process learns anyway.
5. **Persist the fork source on the draft row.** Rejected: it adds a field to the shared, versioned session catalog and the launch request for a value that is meaningful only for the first launch; a memory-only registry gives the same result for every case that matters and a lost entry degrades to a plain draft.

## Risks and Open Questions

- `--fork` is not in `omp --help`. It is parsed by the root command, used by OMP's pane fork and named in its changelog (18.8.x). If a later OMP removed it the fork process would exit with a usage error; the Chat tab then shows the ordinary start failure with the process's own error, and no other Desk flow is affected. No version gate (ADR-0011).
- The source file is read while its writer is alive. Mitigated by the idle/settled preconditions and the live-leaf check; the residual window is a message appended between the check and OMP's read, which `forkFrom`'s `repairInterruptedTail` handles as it does for OMP's own forks of running sessions. `[INFERENCE]` `HistoryReader`'s leaf equals the live conversation's leaf for every entry type OMP writes; the real-window proof exercises the common path, and a mismatch refuses visibly rather than forking silently.
- A fork carries OMP's title, so the two rows and tabs share a name. OMP's own fork does the same; renaming is the user's action.
- A fork copies artifacts and the whole entry tree (sibling branches too), as OMP's `/fork` does; a very large session makes the fork's start slower than a new session. The ordinary start progress ("Starting…") covers it.

## Rollout and Verification

1. Unit: `deskSessionCommand`, slash completion, `RpcSession.forkSource`, `rpcOmpLaunchSpec` (`--fork` only with `forkFrom`), `PendingForks`, `awaitForkDisk`, `ChatRuntime` routes (refusals, arguments, busy sentence, action run, `clearConversation` incl. deferral), `LocalLauncher` passes the fork source until the row has a file and forgets it on a resume or native launch, panel-action wire, `contributions.test.ts` (menus, palette, when clauses), `session-tree.test.ts` menu table.
2. Chromium page test: `open-rewind` opens the picker through the composer handler.
3. Hidden-window end-to-end (`scripts/test-vscode.ps1`, the real extension, real OMP, mock provider): Fork from the context menu yields a second row and a second Chat tab whose transcript is the original's history while the original's file, process and tab are unchanged; the file's header names the original as parent; Branch opens the picker; Clear shows the dialog and Cancel changes nothing.
4. Docs: guide pages for Sessions and Chat, keyboard-shortcuts/commands lists, `architecture.md`, CHANGELOG.

## Related Decisions

[ADR-0038](../decisions/0038-host-chat-over-rpc-ui-on-a-broker-pipe-child.md) (one process, one file; narrowly amended by this design for the `--fork` launch form, recorded in that ADR), [ADR-0051](../decisions/0051-rewind-chat-in-place-through-a-desk-registered-omp-command.md) (Rewind and `/branch`), [ADR-0059](../decisions/0059-clear-chat-in-place-through-a-desk-registered-omp-command.md) (`/clear`), [ADR-0057](../decisions/0057-start-a-session-in-the-window-that-suits-its-folder.md) (windows), [ADR-0011](../decisions/0011-use-installed-omp-without-version-gate.md). No new ADR: the choice is local to one launch argument; this design records it.

## Architecture Review

- Reviewer: reviewer agent `ForkBranchClear.ForkDesignReview` (separate, disposable; read the installed OMP 18.11.1 source and this tree)
- Outcome: **accepted with changes**; all findings resolved in this text.
- Notes: the mechanism (`omp --mode rpc-ui --fork <absolute source file>`, parsed by the root command, written by `SessionManager.forkFrom` before RPC starts, model and thinking restored from the copied entries, `--session-dir` compatible) was verified against the installed source. Resolved: (1) material, the fork source is no longer spent by `running` but kept until a launch finds the row materialized or native, so a fork process that dies early is retried instead of becoming an empty ordinary session; (2) material, the menu is three `when` clauses (Fork and Branch need `materialized`, Clear does not) and `view-none` still refuses a Terminal-mode host in code; (3) a native launch of a fork draft forgets the source, and the first launch is stated to be Chat-only; (4) `forget` is wired (the launcher drops the source of a materialized or native launch; the entry is inert afterwards); (5) ADR-0038 §1 is narrowly amended for the `--fork` launch form and the mis-citation is removed. Unverified by the reviewer and not claimed: `--fork` absent from `omp --help`, the exact OMP release that added it, and the resume picker grouping a fork under its parent.
