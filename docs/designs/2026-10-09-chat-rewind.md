---
status: accepted
date: 2026-10-09
---

# Rewind a Chat conversation in place, with edit and resubmit

## Problem

The native TUI lets a user press `Esc` `Esc` on an empty editor, pick an earlier message and continue from there. Picking a prompt puts its text and images back into the editor ("edit and resubmit"). The later messages stay in the same session file as a sibling branch. Chat has no equivalent: a bad prompt can only be followed by another prompt, or by a new session. The user named this a must-have.

OMP 18.8.5's RPC protocol has no `navigate_tree` command, so the mechanism is the main design problem. The user interface is expected to change after the user tries it; the mechanism, protocol, state model, branch awareness and tests must not.

## Goals and Non-goals

- Goals:
  - Move the active branch of the **same** session file to an earlier entry, without a new process, file or editor identity.
  - Edit and resubmit: rewinding to a prompt returns its text and images to the composer. An existing draft is never overwritten.
  - The move is durable: a reload, restart or `/resume` shows the rewound branch.
  - Undo returns to the previous tip with the same mechanism, also after a restart.
  - Show where other branches exist and allow switching to one.
  - Say which files changed after the target; never restore files.
  - Refuse while a turn streams or compacts, in view-only sessions, and for a stale or foreign session.
- Non-goals:
  - A full tree browser (`/tree`), labels, or forks into a new file (OMP's RPC `branch` and `fork`).
  - Re-answering an `ask` result through rewind (OMP's two-phase protocol is TUI-only).
  - Automatic file restore (gated by the [reversibility design](2026-09-24-native-file-observation-and-reversibility.md)).
  - Custom summarization instructions.
  - Showing OMP's internal pruning (discarded empty stops, checkpoint rewinds) as branches. Main confirmed that only divergences the user made are branches.

## Current State

All OMP facts below were verified against the installed OMP 18.8.5 source and re-checked by the architecture review. OMP paths are relative to `pi-coding-agent/src`; Desk code is cited by symbol.

- **TUI rewind.** `SelectorController` calls `session.navigateTree(entryId, {summarize: false})` in place (`modes/controllers/selector-controller.ts`).
- **`AgentSession.navigateTree`** (`session/agent-session.ts`, about lines 11944-12234):
  - A user-message target moves the leaf to the target's **parent** and returns `editorText` and `editorImages`. Any other target becomes the leaf.
  - With `summarize`, it generates a branch summary with the session's model and appends a `branch_summary` entry at the new position. It skips the summary when there is nothing to summarize. The summary call cannot be cancelled over RPC: `abort()` does not reach its abort controller.
  - It emits the extension events `session_before_tree` (cancellable) and `session_tree` (`oldLeafId`, `newLeafId`, `summaryEntry`). It emits **no RPC frame**.
  - A navigation to the current leaf is a no-op, except for a user message, which always rewinds past itself.
- **The leaf is not persisted.**
  - `SessionManager.branch()` and `resetLeaf()` only call `#setLeaf`, which changes memory and appends nothing (`session/session-manager.ts`).
  - On load, the index makes every inserted entry the leaf in file order, so the leaf after a reload is the **last entry in the file**.
  - A clean process exit appends a `session_exit` `custom` entry at the leaf (`agent-session.ts`, dispose).
- **OMP moves the leaf by itself.** `discardAssistantTurn`, the accepted terminal empty stop (`session/turn-recovery.ts` about 1230-1283) and checkpoint rewind (`branchWithSummary`) move the leaf inside a turn, sometimes with no append. `turn-recovery.ts` appends `appendCustomEntry("accepted-terminal-empty-stop")` right after its own `branch()`: OMP already uses a custom entry to make a leaf move durable.
- **`get_entries {since}`** returns only entries appended after the cursor, plus the current `leafId` (`modes/rpc/rpc-compat.ts` `selectRpcEntries`). Before this change, Desk's `RpcSession.#reconcileEntries` returned early on an empty delta, so any bare leaf move was ignored, and its disk rebuild always took the last file entry as the leaf.
- **RPC alternatives.** `branch {entryId}` moves the process to a new session file and returns only text; images are dropped (`rpc-mode.ts`). `fork` also creates a new file. `get_tree` reads the tree but cannot move the leaf.
- **Extensions can navigate, but only from a command.**
  - `navigateTree(targetId, {summarize})` exists only on `ExtensionCommandContext` (`extensibility/extensions/types.ts`).
  - In RPC mode it runs inside `wrapSessionChange` (`modes/runtime-init.ts`, `rpc-mode.ts` about 1623-1645), which closes an open `/btw` side conversation and quiesces the goal controller, and returns only `{cancelled}`: `editorText` and `editorImages` do not reach the extension.
  - A command context exists only while a registered extension command runs from `prompt("/name args")` (`agent-session.ts` `#tryExecuteExtensionCommand`). Extension commands run before the streaming check.
  - The read-only context exposes `sessionManager.getSessionId/getLeafId/getEntry/getBranch`, `isIdle` and `hasPendingMessages`. `pi.appendEntry(customType, data)` appends a `custom` entry, a child of the current leaf, which the model never sees.
- **How RPC runs a prompt** (`rpc-mode.ts` `case "prompt"`, `rpc-prompt-results.ts`):
  - An extension command is "admitted": the acknowledgement has no `agentInvoked`, and one `prompt_result` with `agentInvoked: false` follows after the handler returns.
  - A thrown handler error becomes an `extension_error` frame with `extensionPath: "command:<name>"`, written before the `prompt_result`.
  - A third-party `input` hook that handles the text produces a "local" outcome: the acknowledgement carries `agentInvoked: false` and **no** `prompt_result` follows. An error acknowledgement has no result either. An input hook may also rewrite the text.
  - An extension command is listed by `get_available_commands` with `source: "extension"`. There is no hidden flag. An **unregistered** `/name` falls through to file commands and is then sent to the model as text.
- **Desk before this change.** The host-control module (`src/omp/host-control.ts`) is loaded with `-e` into every Chat child that has a control bootstrap and registered observation hooks only. `RpcSession` kept only the active branch; `HistoryReader` indexed `id`, `parentId`, type and coarse visibility without reading bodies. `/branch` and `/tree` were on the denied slash list. User rows had no rewind action.

## Proposed Design

### Mechanism (ADR-0051)

The host-control module registers one extension command, `omp-desk-navigate` (`registerNavigateCommand`, `src/omp/navigate-command.ts`). It registers it in its first `session_start` hook, only when `ctx.mode === "rpc"`, so the native TUI never lists it. The registration does not depend on the host-control pipe or its key: it needs only the module loaded with a non-absent bootstrap (a `rejected` bootstrap still registers it). The host sends it through the ordinary RPC `prompt` as `/omp-desk-navigate <json>`, with a compare-and-swap request:

```json
{"v":1,"requestId":"<32 hex>","kind":"rewind|undo|switch","sessionId":"…","expectedLeafId":"…|null","targetId":"…","summarize":false}
```

`runNavigateCommand` refuses by throwing `omp-desk-navigate:<code>`, from a fixed vocabulary, before anything moves:

- `bad-request`: the JSON is malformed. `mode`: the mode is not RPC.
- `busy`: `!ctx.isIdle()` or `ctx.hasPendingMessages()`.
- `session`: the session id differs. `stale`: the live leaf is not `expectedLeafId`.
- `target`: the target is unknown; for `rewind`, a target that is not a user message on the current branch; for `switch`, a target **on** the current branch (that would be an unlabelled rewind without its prompt).
- `stale` for `undo`: the target is not the `from` of the marker `undoMarker` finds on the current branch.

Then it calls `ctx.navigateTree(targetId, {summarize})` while collecting the `session_tree` events of this run. The `from` and `to` it records are the `oldLeafId` and the leaf after the move **as OMP reported them**, not the leaf it checked before the awaits inside `wrapSessionChange`. If the leaf did not move, it refuses `cancelled`, `unchanged` or `failed`. If the leaf moved, it **always** appends one navigation marker, even when `navigateTree` threw afterwards or another append raced it:

```json
{"type":"custom","customType":"omp-desk/navigation","data":{"v":1,"requestId":"…","kind":"rewind","from":"<old leaf>","target":"<target>","to":"<leaf before the marker>","summarized":false,"raced":true}}
```

`summarized` is whether a `branch_summary` was really written (the event's `summaryEntry`), not the request flag. `raced` appears when OMP's reported leaves differ from what the handler checked, or when no `session_tree` event was observed: the move is real and must be durable, but the host says it was not proven to be exactly the requested one.

The marker has three jobs:

1. **Durability.** It is the last line of the file and a child of the new leaf, so a reload derives the rewound leaf. It is a `custom` entry, so the model never sees it and the Desk transcript does not render it.
2. **Proof of the outcome.** The host looks for the marker carrying its own `requestId` **on the active path** (the leaf or an ancestor of it) after its re-sync. A goal continuation or a background wake may append after the marker before the host reads, so "is the leaf" would misreport a real move. Acknowledgements, `prompt_result` and `extension_error` are never proof.
3. **Undo.** `undoMarker(branch)` walks back from the leaf past metadata entries (`custom`, such as OMP's `session_exit`, and `model_change`, `thinking_level_change`, `service_tier_change`, `mode_change`, `label`). If the first other entry is a `rewind` or `switch` marker with a `from`, Undo is offered and targets `from`. The page, the host and the handler share this function, so Undo survives a window reload and a process restart. Any new conversation entry ends the offer.

The handler is authenticated only by the RPC stdin, which the broker already restricts to the owning host. Anything that can write a prompt can already do more than rewind, so no key is added. The JSON is not user text: Desk refuses the command name if a user types it and hides it from the slash list.

### Host command path (`RpcSession.navigate`)

`navigate({requestId, kind, targetId, expectedLeafId, summarize})` is exactly-once per `requestId` (32 lowercase hex, checked), separate from prompt admission. It is never written to the prompt ledger, never creates a pending user row and never sets the slash-identity arm.

1. **Refusals before any write** (`#navigationRefusal`), each with a fixed sentence:
   - `not-live`: no verified live session. `busy`: a mutation fence or another navigation (see the fence below).
   - `compacting`: `state.isCompacting` or maintenance is working.
   - `busy`: a turn is running or streaming, a dialog is open, messages are queued, the session is not settled (`!settled`) or is paused on async work (`asyncPaused`), a prompt's fate is unknown (an `unconfirmed` ledger entry), or a live row is not yet reconciled (a pending row that is neither flagged unsaved nor hidden). A rewrite would otherwise re-anchor that row onto the new branch. A row flagged unsaved is exempt, because it would otherwise block Rewind forever; it survives the rewrite unanchored and stays visible on the rewound branch.
   - `unsupported`: the live catalog has no `omp-desk-navigate` with `source: "extension"`. A process from an older build, or a same-named prompt template, would send the JSON to the model.
   - `stale`: the model's `leafId` is not `expectedLeafId`, unless only OMP's `model_usage` bookkeeping follows it (`leafReaches`; OMP appends it after a reply settles, sometimes after the page last read the leaf, and the handler applies the same rule); for `undo`, the target is not `undoOffer(...).from` of the loaded branch.
   - `target`: for `rewind`, not a durable user message on the loaded branch; for `switch`, not a tip in the model's branch points.
   The request waits for a reconcile already running, then checks again.
2. **Send and wait.** While `#navigation` is set, `#controlRefusal` answers `busy` to **every** mutating operation: prompts, steering, follow-ups, queue edits, Stop, settings, compaction. The prompt is sent with an internal id and **no `streamingBehavior`**, so a fall-through during a race fails with OMP's busy error instead of being queued as a steer. The wait is a small state machine (`NavigationWait`):
   - the command's `prompt_result` → `result` (or `fell-through` when it says `agentInvoked: true`);
   - an acknowledgement with `agentInvoked: false` → `local` (an input hook handled it; no result follows);
   - an acknowledgement with `agentInvoked: true`, or a `message_start` of a user message carrying this `requestId` → `fell-through`;
   - an error acknowledgement → `rejected`; a write that never left the host → refused at once with `not-owner`, `not-live` or `failed`;
   - no answer in 30 s (180 s with `summarize`) → `timeout`; a lost link → `lost`.
   `extension_error` frames from `command:omp-desk-navigate` are collected meanwhile. On `fell-through` the host sends `abort` at once.
3. **Re-sync through the one reconcile serializer** (`#reconcileSettled`, then `#runReconcile`). No second read path exists. The leaf-move rules apply to every reconcile, not only to navigations:
   - `#reconcileEntries` rebuilds when the delta does not extend the model's leaf **or when the delta is empty but `leafId` moved**. This also repairs bare leaf moves made by OMP's own turn recovery.
   - `#rebuild(live)` refreshes the `HistoryReader` and takes the disk window **at the live leaf** (`snapshot(rows, leafId)`) only when the disk agrees with the live response: its last entry is the live cursor and the live leaf is indexed. Otherwise it looks once more after 150 ms, then falls back to a full `get_entries`. The cursor becomes the live last id. ADR-0038's disk-first rule stays.
   - A full `get_entries` applied while a reader exists keeps only the same tail window as disk paint (`transcriptWindow`), so a long session is never repainted in full. Older rows load from disk: `HistoryReader.loadOlder(beforeId)` walks the ancestors of `beforeId`, so it stays on the active path even when the leaf is not the last line of the file.
   - Reconcile requests that arrive while the command runs are skipped; the navigation's own re-sync covers them.
4. **Outcome.**
   - `done`: a marker with this `requestId` is in the re-synced active branch. It carries `kind`, `summarized`, `raced` and, for a rewind, the draft (below).
   - `refused` with the extension's code when one was collected (coded refusals are thrown before anything moves, so they stand without the re-read); `failed` after a fall-through, or when the re-read ran and found no marker. A non-coded handler error after a real move (for example `appendEntry` throwing) is also reported `failed`; the re-sync still shows the moved leaf, which has no marker and reverts on restart.
   - `unconfirmed`: no answer and no marker, or the re-read failed. Nothing is retried.
5. **Fence after an unanswered command.** After `timeout` or `lost`, the handler may still be running (a summary cannot be cancelled). `#navigationFence` keeps every mutation refused as `busy` until the late `prompt_result` for that internal id arrives, a re-sync finds the marker, or this `RpcSession` ends (process exit, or a re-attach from a new extension host after a window reload). The page is told `unconfirmed`. `respondUi` is fenced only by the ordinary mutation fence, so a third-party `session_before_tree` dialog stays answerable during the move.
6. **Draft.** The draft is taken from the target entry the host holds before sending, because the extension wrapper drops `editorText` and `editorImages`. `blob:` image references are resolved with `resolveBlobImages` (`src/host/rpc/history-blobs.ts`), as disk paint does; any still unresolved are counted as unavailable.

`ChatRuntime` handles `omp:chat-navigate {requestId, kind, targetId, expectedLeafId, summarize}` (page → host) behind its existing route gate, which refuses view-only, read-only and not-live pages. It answers `omp:chat-navigate-result {requestId, status, reason?, kind?, summarized?, raced?, draft?}` to the origin page. A draft too large for the route is resent without images, counted as unavailable.

### Branch points

`computeBranchPoints(nodes, path)` (`src/chat/rewind.ts`) takes a node list `{id, parentId, role}` and the active path. An off-path child subtree of a path entry is a **branch only when its first message, past metadata and markers, is a user prompt**. Desk rewinds always abandon a subtree rooted at the target prompt; switch and Undo abandon one rooted at a marker followed by a prompt. OMP's own pruning leaves subtrees rooted at an assistant, tool-result or custom message and is excluded.

- A branch records its message and prompt counts, its first prompt id and preview, and its **tip**: the newest user, assistant or tool-result message in file order. Markers, `session_exit` and other metadata are never tips. Switching to a tip that is a user message rewinds past it, as navigation always does.
- `HistoryReader.snapshot` computes the points from its index and reads at most 40 first-prompt bodies for previews. A full `get_entries` computes them from the live entries.
- A point's `entryId` is the nearest message at or before the divergence on the active path. OMP appends `model_usage` bookkeeping after a reply and a rewind lands below it, but Desk does not load that entry, so the transcript could not place it. Points that share an anchor are merged.
- **Replayed rows from an abandoned branch.** A reattach (a window reload with the same OMP process) replays the broker's ring, which still holds the turns of a branch the user rewound away from. Those rows never match the active path. On the first unmatched reconcile pass, when the session is settled and has branches, one full `get_entries` drops the pending rows saved off the path (`dropPendingSavedElsewhere`), so they are neither shown nor flagged *not yet saved*.
- **Why a delta keeps the last value.** A delta that extends the known leaf can only add entries below it. A new off-path sibling needs a leaf move, which is a rebuild (above). OMP's in-turn pruning can create a sibling while the delta still extends the leaf, but such a subtree is never user-rooted, so it would not be a branch anyway.
- `ChatModel.branches` is a snapshot field, bounded to 200 points of 20 branches, replaced on every rewrite.

### Shared state model (`src/chat/rewind.ts`)

These pure functions serve the host (command QuickPick and checks), the page and the OMP-side handler:

- `rewindTargets(entries)`: durable user prompts on the loaded branch, oldest first, `{id, parentId, preview, images, timestamp}`.
- `rewindPreview(entries, targetId, cwd)`: the rendered messages and prompts that leave the active branch, the distinct paths of edit tools (through `toolPresentation`), and the count of command tools after the target.
- `navigationMarker(entry)`, `undoMarker(branch)`, `undoOffer(entries, leafId)`.
- `encodeNavigateCommand`, `parseNavigateArgs`, `navigateErrorCode`: the wire codec, shared with the handler.
- `rewindDraft(entry)`: text and images of a prompt.

Targets and previews are limited to the **loaded window** (the 100-card admission). An older prompt becomes a target after "Load older".

Page-only interaction state is a reducer, `reduceRewind` (`src/webview/lib/rewind-mode.ts`): `idle` → `picking {targetId, leafId}` → `pending` → `idle`. Picking is pinned to the leaf it started from: a snapshot that moves the leaf or drops the selected prompt ends it.

### UX

- **Entry points.**
  - `Esc` `Esc` within 500 ms in an empty composer while idle and with no popup open. While a turn runs, `Esc` keeps stopping it (the Stop path).
  - **Rewind to here** (codicon `discard`) in the hover actions of every user prompt.
  - `/rewind` and `/branch`, intercepted in the page before any send. In OMP 18.8.5 `/branch` (alias `/rewind`) is the TUI's in-place rewind selector and has no RPC handler, so Desk gives both names the same meaning. Neither is ever routed to the RPC `branch` command, which forks into a new file. With arguments, both are refused as before.
  - **OMP: Rewind Conversation…** (`omp.rewindConversation`): a host QuickPick of the loaded prompts, newest first, with relative time and the consequences in the detail line. It is the keyboard-only and accessible route. It is offered for the active Chat editor only when the conversation is live and the editor's route is writable (no `readOnlyReason`); the result and the draft go to that tab's writable routes, so the controlling editor's composer receives the prompt.
- **Picking.**
  - The transcript stays in place and scrolls the selected prompt into view. The prompt gets a focus ring and everything after it is dimmed.
  - A bar above the composer reads "Rewind to: ‹first line› · N messages leave this branch", with **Rewind**, **Rewind & summarize** and **Cancel**, and the keys `Enter`, `Shift+Enter`, `Esc`, `↑`/`↓`/`Home`/`End`. Clicking a prompt selects it; clicking it again rewinds.
  - When files changed after the target, the bar adds "Files changed after this point stay as they are", listing them (each opens the file) and the number of commands. Nothing is restored.
  - When the action is unavailable (working, compacting, view-only, unsupported), the bar says why instead of offering it.
- **After a rewind to a prompt.** The prompt's text and images fill the composer, ready to edit and send. A non-empty draft first moves to the recovery card, labelled as the draft from before the rewind. It is never overwritten.
- **Undo.** While `undoOffer` is set, a one-line notice reads "Rewound · Undo" (or "Switched branch · Undo"). Undo sends `kind: "undo"` to the marker's `from` and also clears the prompt the rewind put into the composer if it is still unedited. Sending a message ends the offer.
- **Branch points.** A line "⎇ N other branches · M messages" follows the card that holds the branch point. It opens an inline list (first prompt or "Branch", size); choosing one switches to its tip with `kind: "switch"`.

## Alternatives

- **RPC `branch`.** It creates a new session file, drops images and changes the editor's conversation identity, against Chat's no-identity-change rule. Rejected.
- **RPC `get_tree`.** It reads the tree but cannot move the leaf; the branch points are already computed from `get_entries` and the history index. Not needed.
- **Wait for an upstream `navigate_tree`.** This is the clean long-term route and would also return images. It is not available in 18.8.5. `RpcSession.navigate` is mechanism-agnostic, so an upstream command can replace the extension command later without page or protocol changes.
- **Navigate from the authenticated host-control pipe.** Pipe handlers have no `ExtensionCommandContext`; only a command run through `prompt` gets `navigateTree`. The pipe also stays read-only.
- **A separate full re-read after a navigation.** The first version of this design re-read everything with `get_entries`. It raced the reconcile serializer, could publish a stale disk snapshot and had no size bound. Rejected for leaf-move detection inside the one serializer.
- **Persist the leaf differently.** A label entry would attach user-visible labels to unrelated entries. Writing the JSONL from the host would create a second writer. Not persisting would silently revert the rewind after a restart.
- **Restart OMP on an edited file.** Writer conflict, a lost process and no images. Rejected.
- **A full-screen rewind overlay like the TUI.** In VS Code, in-place selection plus a QuickPick fits better and stays accessible.

## Risks and Open Questions

- **Marker entries** accumulate, one per navigation. The TUI `/tree` view may show them as metadata nodes.
- **A process started by an older build** has no command. Rewind is refused as `unsupported` ("Restart the chat to use Rewind") and nothing is sent.
- **Third-party `input` hooks** can handle or rewrite the command text. A handled text ends the wait as `local` and the marker decides. A rewritten text that reaches the model is detected by its user message carrying the request id or by `agentInvoked`, then aborted and reported `failed`; the aborted prompt stays in the transcript. A rewrite that drops the request id is detected only by the final `prompt_result`; if the wait times out first, no abort is sent.
- **Summarize** makes a model call that Desk can neither cancel nor instruct. Its timeout reports `unconfirmed` and keeps the fence until the result arrives.
- **A fence that never lifts.** If the late result is lost for good and no marker appears, mutations stay refused until this `RpcSession` ends; Restart clears it.
- **A window reload during a summarizing navigation.** The fence belongs to one `RpcSession`. A reload re-attaches a new `RpcSession` to the same broker-owned process with no fence, and OMP's RPC `prompt` does not refuse while a session change is in progress. A prompt sent immediately can start a turn on the old branch while `navigateTree` moves the leaf under it. This residual risk is documented, not closed: closing it needs a navigation-in-progress signal from OMP, a new surface for a narrow window (summarize, a reload inside the summary call, and an immediate send).
- **Replayed abandoned turns during a reattach.** Until the one full read that drops them completes, pending rows replayed from an abandoned branch can show briefly. The installed proof saw this once, for about a second, during the catch-up after a reload; they were never flagged *not yet saved*.
- **Undo past metadata Desk does not model.** The handler's `UNDO_TRANSPARENT` set also skips `label`, `service_tier_change` and `mode_change`, but the host and page never see those entries under their own type (`HistoryReader` drops them; `parseChatEntry` maps them to `unknown`), so Desk does not offer Undo after one. This is safe: Undo is withheld, never wrong.
- **`wrapSessionChange` side effects.** A navigation closes an open `/btw` side conversation and quiesces goals, as the TUI's own navigation does.
- **Undo is inexact for a user `from`.** When the previous tip is a user message (a prompt with no reply yet), `navigateTree` moves to its parent, so Undo lands one entry earlier.
- **Skill-prompt targets.** Only role `user` messages are targets; a user-invoked skill prompt is not restored as `/skill:name args`.
- **The `ask` re-answer protocol** is not offered.
- **The control generation changes** on every navigation, because the host-control `session_tree` observer fires. This is intended: it invalidates a pending native rename or stop confirmation for the moved branch.

## Amendments to accepted decisions

- **ADR-0038 §4 (history and resync).** Disk-first stays. Reconciliation additionally treats a moved `leafId` (empty delta or a delta that does not extend the leaf) as a rebuild, accepts the disk window at the live leaf only when the disk holds exactly what the process reported, and otherwise reads `get_entries`, trimmed to the same tail window. `loadOlder` walks ancestors.
- **ADR-0038 §8 and ADR-0003 (host control).** The `-e` module may register one RPC-only internal command, `omp-desk-navigate`. The command depends only on the module loading with a non-absent bootstrap, not on the pipe or its key, and it travels over RPC stdin. The authenticated pipe itself stays read-only.

## Rollout and Verification

1. Shared module and its tests: codec, targets, preview, marker, Undo walk-back, branch points.
2. OMP-side command against a fake `pi` and context: guard order, refusal codes, `from`/`to` from `session_tree`, a marker after a raced or throwing move, no registration outside RPC.
3. `RpcSession` with `FakeRpcChannel`: identity, stale leaf and busy refusals (ledger, pending, unsettled), the catalog source check, leaf-move detection with an empty delta, disk validation against the live leaf, marker on the path but not the leaf, an extension error, `local` and error acknowledgements as terminal, fall-through and abort, timeout and the persisting fence, Undo after a restart. `HistoryReader` snapshot at a leaf and ancestry `loadOlder`.
4. Runtime and page wire, then the UX: Composer Esc Esc and draft hand-over, the rewind bar and keys, the hover action, the slash interception, the Undo notice and the branch marker, tested in `chat-ui.test.ts`.
5. Command palette QuickPick.
6. Installed proof in an isolated VS Code window with a real OMP session: several turns including a file edit, every entry point, edit and resend, both branches in the session file, branch switch, Undo, a window reload showing what persisted, screenshots.

## Related Decisions

- [ADR-0051: Rewind Chat in place through a Desk-registered OMP command](../decisions/0051-rewind-chat-in-place-through-a-desk-registered-omp-command.md).
- [ADR-0038](../decisions/0038-host-chat-over-rpc-ui-on-a-broker-pipe-child.md): the RPC-UI chat this extends; §4 and §8 are narrowly amended above.
- [ADR-0003](../decisions/0003-native-host-control-pipe.md) and [ADR-0006](../decisions/0006-host-generated-key-peer-verified-pipe.md): the authenticated host-control channel, which stays read-only.
- [Edit and cancel queued messages](2026-10-07-edit-queued-messages.md): the composer hand-over this reuses.

## Architecture Review

- Reviewer: architect (independent; not the author), two passes.
- Outcome: accepted with changes.
- Notes: The first pass (ACCEPT WITH CHANGES) found six material defects: leaf moves outside the reconcile serializer, success judged only at the leaf, an incomplete fence and busy checks, an incomplete wait protocol, OMP's own pruning shown as branches, and missing amendments to ADR-0003 and ADR-0038. The second pass confirmed all six resolved against the working-tree code and OMP 18.8.5, and required two wording corrections, applied here: `/branch` in OMP is the TUI's in-place rewind (the RPC `branch` command is what forks), and the fence lasts for one `RpcSession`, not until the process ends, with the reload-during-summarize case recorded as a residual risk. Main then mapped `/branch` to Desk's Rewind. No further architecture round is needed unless the mechanism changes.
