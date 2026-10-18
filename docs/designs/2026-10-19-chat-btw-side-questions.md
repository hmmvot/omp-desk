---
status: accepted
date: 2026-10-19
---

# `/btw` side questions in Chat: a panel over the composer that streams the answer outside the transcript

Requested by the maintainer (2026-10-19) as part of closing the gaps between OMP Desk's Chat and OMP's terminal UI (TUI): "`/btw` side questions in Chat". OMP 18.11.1 answers a side question from the session's current context without adding to it, and offers the same feature to RPC hosts; Desk uses none of it.

## Problem

In OMP's TUI `/btw <question>` asks the model something about the conversation **without touching it**: the question and the answer never enter the session's transcript or journal, and the answer streams into a panel while the main turn may still run. `/btw` alone browses the session's earlier side questions, a follow-up continues one topic, Escape cancels, a key copies the answer.

In Desk's Chat none of this exists. Measured from the installed sources (OMP 18.11.1):

- `/btw` is a TUI-only builtin: its registry entry has `handleTui` and no `handle` (`slash-commands/builtin-lifecycle.ts:438-449`), so `rpc-ui` mode does not run it (`acp-builtins.ts:66`: `if (!command?.handle) return false`, and the text then goes to the model as an ordinary prompt). The host helper `media/slash-registry.mjs` reports it as `handled: false`, so `tuiOnlyCommand` (`src/host/slash-registry.ts`) answers a typed `/btw` with the generic guidance line "`/btw` was not sent: it works only in OMP's terminal UI. Switch this editor to Terminal to use it." Nothing reaches OMP, and `btw` appears in neither the slash list nor the Commands list.
- OMP **does** offer the feature to RPC hosts (`modes/rpc/rpc-btw.ts`, `rpc-mode.ts:2584-2593`, `rpc-types.ts:142-145,591-620`): the commands `btw {question, recordId?}`, `btw_cancel {recordId?}`, `get_btw_history`, and the frames `btw_delta {recordId, delta}`, `btw_record {record}` and a `notice` with `source: "btw-history"`. Desk has no `btw` command in `RpcCommand` (`src/protocol/rpc.ts`); its frame allow-list (`toChatEventFrame`, `src/protocol/rpc.ts`) drops both `btw_*` frames, but the generic path **accepts any `notice`** and would append the history-save failure as a raw OMP line in the transcript (`src/chat/model.ts`), which §2 prevents.

## Goals and Non-goals

Goals:

- `/btw <question>` typed in the Chat composer (between turns **and while a turn runs**) asks a side question; its answer streams into a panel in the Chat's bottom block as Markdown, and **never enters the session transcript**, the Chat's rows, the journal, the queue or the turn state.
- Cancel a running side question (a button, and `Esc` in the panel), without touching the main turn; a main-turn Stop does not cancel it and a side question does not block the main turn.
- `/btw` with no text opens the panel on the session's **history** of side questions (the same sidecar the TUI reads and writes), newest first; one topic is shown with its newest 20 turns; a **follow-up** continues a topic from the panel; **Copy** takes the latest non-blank answer.
- The panel survives what the Chat survives: a reload of the page, a second page on the same conversation, an extension-host restart (it shows what OMP holds, not what the page remembers: the host reads OMP's history once per session, §6).
- Fixed, bounded sentences for every refusal; no raw OMP text is shown except the model error of a failed side turn, as plain text.

Non-goals:

- **Branch** (the TUI's `b` key promotes a finished side answer into the session as a branch): RPC has no command for it (`rpc-types.ts` lists three `btw` commands only), and Desk must not write the journal itself.
- Side questions about a **focused subagent**'s transcript (the TUI scopes history by `focusedAgentId`; the RPC controller asks the main session only).
- A button or a menu entry that opens the history: the entry points are the typed `/btw`, the Commands list and the slash picker, like every other Desk command (`docs/guide/chat.md`, Slash commands). Adding one is a visual-design choice for the maintainer.
- Rendering `btw_delta` into the main transcript, the context ring, the cost line or the quota line (OMP's side turns are not in the session's journal; whatever OMP reports about their cost is not Desk's to estimate).
- Dictation hold keys, the TUI overlay chrome (anchor, fullscreen, nativeRendering).

## Current State

What exists and is reused:

- **Desk-owned slash commands** are answered by the host before anything is sent: `chat-runtime.ts` `handleMessage` checks `deskSessionCommand` (`/clear /new /delete /fresh /fork`) and then `tuiOnlyCommand` for `omp:chat-prompt`, `-steer` and `-follow-up`, whichever the page chose (running or idle), and answers `explained` (the composer starts no turn state) or a refusal with a fixed sentence in the footer (`command_feedback`). The slash picker (`DESK_COMMANDS`, `slash-completion.ts`), the Commands list (`DESK_GUI`, `command-list.ts`) and the command chips (`commandResolver`, `source: "OMP Desk"`) all read one catalogue.
- **The host owns the conversation; the page replicates it.** `RpcSession` (`src/host/rpc/session.ts`) writes commands (`#send`, id-correlated, 30 s deadline that waits while a dialog is open), folds frames (`#onFrame`) and emits `RpcSessionOutput`; `ChatRuntime` turns outputs into `omp:chat-*` messages for every attached page and re-sends state when a page attaches (`resend`, `#sendSnapshot`). Every page message carries the conversation epoch; a message of another epoch is dropped (`ChatClient.handle`).
- **A dock above the composer** (`App.tsx`: `HudDock`, `QueuedMessages`, `RewindBar`, `Composer`) in the column's flow; the transcript's bottom anchor absorbs its height.
- **`PacedMarkdown` / `Markdown`** render streamed and settled Markdown (code blocks, tables, links, diagrams), `CopyButton` copies source text.

What OMP does (verified in the installed sources, not assumed):

1. **One side question at a time.** `RpcBtwController.ask` (`rpc-btw.ts:63-101`) refuses with `A /btw question is still running; cancel it first` while one runs or starts. `recordId` continues an existing topic (`Unknown /btw topic: <id>` otherwise). It needs `session.model` (`No active model available for /btw.`) and a writable history (`Could not save /btw history: …`).
2. **Frame order.** `ask` writes the first checkpoint, emits `btw_record` (the record, its latest turn `running`), and returns `{record}` as the `btw` response; the turn itself starts on a macrotask, **after the response is written** (`rpc-btw.ts:95-96`). Every text delta is a `btw_delta {recordId, delta}` appended to the **latest turn's** answer; every terminal change (`complete`, `cancelled`, `error`) is a `btw_record` with the full record (`#finish`, `:233-251`); the last record frame of an id wins. The final `answer` of a completed turn is the model's reply text, which may differ from the concatenated deltas (`:226`), so the terminal record **replaces** the streamed copy.
3. **Side turns run beside the main turn.** `AgentSession.runEphemeralTurn` (`agent-session.ts:11186-11200`): "does not block on, or interfere with, any in-flight main turn", the session's history is **not** modified, the snapshot includes the in-flight assistant text. No `message_*`, `agent_*` or `prompt_result` event is emitted for it.
4. **Cancel overtakes.** `btw_cancel` is in `BACKGROUND_COMMANDS` (`rpc-mode.ts:420-425`): it runs at once, even while a `btw` is still starting (`cancel` bumps an epoch; the starting `btw` fails with `The /btw question was cancelled before it started`).
5. **History is a sidecar**, `<artifacts dir>/btw-history/entry-<id>.json`, shared with the TUI (`session/btw-history.ts`). A record is `{id, leafId, question, answer, status, createdAt, updatedAt, error?, followUps?: BtwHistoryTurn[]}`, status `running | complete | cancelled | error | interrupted` (`pi-tui/src/overlays/btw-history.ts`). `get_btw_history` returns them newest first, re-read from disk when idle, with the running topic's live partial answer; a record `running` on disk that no process runs is recovered as `interrupted`. It is a session-local sidecar: **never the main session journal** (`btw-history.ts:96`).
6. **Session changes close it.** Every `new_session`, `switch_session`, `open_session`, branch/fork, extension-initiated session change and process exit calls `btw.close()` first, which cancels a running question and lands its terminal checkpoint (`rpc-mode.ts:1631-1633,1699-1704,1958-1985,1997-1998`); Desk's own Rewind runs through those, so it ends a running side question too, while Stop does not (§5).
7. **Old OMP.** A child without the commands answers `Unknown command: btw` (the same shape Desk already tolerates for `abort_and_restore_queue`, `session.ts:1076`).

## Proposed Design

### 1. Command routing: the host serves a typed `/btw`

A new pure module `src/chat/btw.ts` (no host, no `vscode`; imported by host, page and tests) defines the command token rule, the view types, the reducer and the fixed sentences below.

`btwCommand(text): { question: string } | null` — only a **leading** `/btw` token counts (after the whitespace the send trims; case-insensitive; the same token rule as `deskSessionCommand`, so `/btw-it` and `explain /btw` are text); the question is the rest, trimmed (empty: open the history).

`ChatRuntime.handleMessage`, in the block that already serves Desk commands for `omp:chat-prompt`, `-steer` and `-follow-up`, tests `btwCommand` **first**, before `deskSessionCommand`, `classifySlashInput` and `tuiOnlyCommand`, and calls the new `#serveBtwCommand`. It is therefore independent of the page's choice of `prompt`/`steer`/`follow_up`, of whether a turn runs, and of `routesAsPrompt` (a `/btw` typed during a turn is **never** sent to OMP as a prompt: it is not a command OMP's RPC mode runs). Like the other Desk commands it is served once per `tabId:requestId` (`#settingsRequests`).

Outcome mapping (what the page's send promise sees):

| Case | Host | Page result |
| --- | --- | --- |
| a question, OMP started it | `session.btw.ask(question)` accepted | `explained`: the draft is consumed, no turn state starts; the panel shows the answer |
| a question, refused (busy, no model, history unsaved, unsupported, not confirmed in time) | `#tell` the fixed sentence in the footer | `refused`: **the draft is kept**, so the question is not lost (unlike `/clear`, whose text has no value) |
| a question with images attached | `#tell` the `images` sentence; nothing is asked | `refused`: the draft and the images are kept (the side turn takes text only; dropping them silently would lose them) |
| no question | `session.btw.history()` then the records are posted with `show: "history"` | `explained` |
| no live session / read-only route | the existing gates before this block (`CHAT_NOT_LIVE_SENTENCE`, route read-only) | `refused` |

`/btw` is added to `DESK_COMMANDS` (`slash-completion.ts`: name `btw`, source `OMP Desk`, description "Ask a side question that stays out of the conversation, or browse earlier ones", hint `[question]`). It needs no `DESK_GUI` row: a command that takes arguments is completed into the draft when picked, and a `text` command is available during a turn anyway. That also makes `/btw ` a command chip (`commandResolver` takes every `OMP Desk` entry, matched in any case).

Alternatives for the routing are in "Alternatives".

### 2. Host: `BtwChannel` owned by `RpcSession`

New `src/host/rpc/btw.ts`, a `BtwChannel` constructed by `RpcSession` with two injected capabilities (so it is testable without a child): `send(command): Promise<BtwReply>` (the session's `#send`, returning the response's `success`, `data`, `error`, or a transport failure kind) and `emit(output)`.

State: `records: BtwRecordView[]` (newest first, bounded) and `loaded: boolean` (OMP's history was read once, §6). It is **a cache of OMP's sidecar**, never authoritative; `history()` replaces it.

- `onFrame(frame)` — called from `RpcSession.#onFrame` for `btw_record`, `btw_delta` and the `notice` frame with `source: "btw-history"` (OMP raises it when a checkpoint or the final history write fails: `rpc-btw.ts:158,246`), **before** the generic allow-list: none of them reaches `toChatEventFrame` or the reducer, so a storage failure of an aside is neither a transcript row nor raw OMP text (the answer is still shown from the live record). `btw_record`: `btwRecordFromOmp` (shape-checked and bounded; an invalid record is dropped), upsert by id, `emit({kind: "records", replace: false, records: [record]})`. `btw_delta`: append to the latest turn of the known record **if it is running** (a delta for an unknown id is dropped: OMP always sends the record first), `emit({kind: "delta", recordId, at, delta})` where `at` is the answer's length before the append.
- `ask(question, recordId?)`: `send({type: "btw", question, recordId?})`. Success → `{status: "started"}`. A failed response is mapped to a **fixed reason** by its exact OMP message: `A /btw question is still running…` → `busy`; `Unknown /btw topic…` → `unknown-topic`; `No active model…` → `no-model`; `Could not save /btw history…` → `storage`; `The /btw question was cancelled before it started` → `cancelled`; `Unknown command: btw` → `unsupported`; anything else → `failed`. A transport timeout → `unconfirmed` (the frames still arrive if OMP started it; the panel then shows it). A closed or non-owned writer → `not-live`. The OMP wording is matched, not displayed; a different wording of a later OMP lands in `failed`, which is true and safe.
- `cancel(recordId?)`: `send({type: "btw_cancel", recordId?})`; the answer's `cancelled: boolean` is returned (the terminal `btw_record` does the visible work).
- `history()`: `send({type: "get_btw_history"})`; the records replace the cache (for a record both hold, the **fresher** copy wins: more turns, else more text while both run, else the finished one, else `updatedAt`), `loaded` becomes true, `emit({kind: "records", replace: true, records, omitted})`.
- No `reset()`: the cache lives and dies with its `RpcSession`, whose session file is fixed for its life (see §6).

`RpcSession` gets one public `btw` accessor, a `case "btw_record" | "btw_delta"` in `#onFrame`, and one new `RpcSessionOutput` member `{type: "btw"; epoch; output}`. The new `RpcCommand` members are `btw`, `btw_cancel`, `get_btw_history` (`src/protocol/rpc.ts`).

`ChatRuntime.#onOutput` maps the output to `omp:chat-btw` / `omp:chat-btw-delta` messages and `#broadcast`s them to **every** page of the conversation (the side question is the conversation's, like a dialog); a page that attaches or gets a new snapshot is sent the current records (`resend`, and after every `#sendSnapshot`, posted directly and not through the `#deliver` fallback) when the channel is loaded, so a reloaded or second page sees the running answer.

### 3. Wire (`src/protocol/chat-messages.ts`)

Host → page (epoch-tagged, validated by `parseChatHostMessage`; the page drops another epoch's message):

| message | content |
| --- | --- |
| `omp:chat-btw` | `{epoch, records, replace, omitted?, show?: "history"}`: `replace` swaps the whole list (history load, attach, snapshot), otherwise each record is upserted by id; `show` asks the panel to open on the list |
| `omp:chat-btw-delta` | `{epoch, recordId, at, delta}`: text appended to the latest turn of `recordId` |
| `omp:chat-btw-result` | `{epoch, requestId, status: "accepted" \| "refused", reason?}`, the answer to a panel request (below), `reason` from the fixed vocabulary |

Page → host: **one** mutation message `omp:chat-btw-request {requestId, epoch, op: "ask" | "cancel" | "history", question?, recordId?}`, minted and validated like `omp:chat-queue-remove` (`requestId` is the exactly-once key; `question` is bounded by 8 000 characters; `recordId` by the OMP id grammar `^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$`). The typed `/btw` is the **only** path without it (it rides the text path above); the panel's follow-up input, Cancel and History use this message. Every gate it crosses answers it with an `omp:chat-btw-result` `refused` (reason `not-live`) like `omp:chat-queue-remove` does (`#failQueueRemove`): no conversation, a read-only route, no session, an epoch that moved; a request never goes unanswered at a gate. It is routed like the other mutations: the page-side bridge map (`bridge.ts`), the guest dispatcher's chat-message set (`guest-dispatcher.ts`) and the two tables of accepted chat messages in `extension.ts`, all of which already name `omp:chat-queue-remove`; the parsers live in `src/protocol/btw-messages.ts`.

**Wire records are normalised**, not OMP's raw shape: `BtwRecordView = {id, turns: BtwTurnView[], omitted?: number}` with `turns` oldest first (the record's own turn, then its follow-ups), `BtwTurnView = {question, answer, status, createdAt, updatedAt, error?, clipped?: true}`. `leafId` is dropped (nothing in Desk can use it).

**Bounds** (a page message must fit the bridge's frame ceiling, 256 KiB of ASCII-escaped JSON; `BRIDGE_CHAT_CHUNK_BYTES` ≈ 248 KiB): at most 50 records; at most 20 turns per record (the **newest**; `omitted` counts the older ones); a turn's answer is clipped to 64 000 characters (`clipped: true`; a clipped turn receives no more deltas on the wire, and the terminal record carries the clipped text), a question to 8 000, an error to 500, ids to the grammar; a `replace` message carries records newest first until about 192 KiB of **wire bytes** (`btwWireBytes`: `JSON.stringify` with every non-ASCII UTF-16 unit counted as the six bytes `asciiJsonText` makes of it, the bridge's own measure), `omitted` counting those left out. A single record that alone exceeds the budget (64 000 non-ASCII characters are 384 KB on the wire) goes out through `fitBtwRecord` with every answer cut (to 16 000, 4 000, 1 000, then 200 characters, whichever first fits) and flagged `clipped`; the same function fits every single-record message the channel emits, and the host's own cache stays complete. A `post` that still comes back `"too-large"` is **dropped**, and never answered by re-sending the snapshot (the generic `#deliver` fallback would loop, because the snapshot is followed by the same records); the next terminal record or `replace` heals the page.

### 4. Page: a store and a panel, outside the `ChatModel`

The transcript's model, snapshot rows and reducer (`src/chat/model.ts`) are **not touched**: a side question is not a conversation entry, and putting it in the model would put it in every snapshot, the find index, rewind, the context ring and the cost line. `ChatClient` owns one `BtwClient` (`src/webview/lib/btw-client.ts`, `useSyncExternalStore`-compatible, DOM-free) that `handle` routes the three host messages to, and that posts `omp:chat-btw-request`.

State (pure reducer `reduceBtw` in `src/chat/btw.ts`, shared with the host cache so both fold records the same way): `{epoch, records, panel: null | {kind: "record", id} | {kind: "history"}, notice: string | null, pending: boolean}`.

- Records `replace: false`: upsert by id. If the record's **latest turn is `running` and it is new** (an id not known, or one more turn than known) the panel shows that record: the user just asked, or another page of the conversation did. Records `replace: true`: swap; if a record is running the panel shows it (a reloaded page returns to the answering question), `show: "history"` opens the list, a shown record that is gone closes the panel. An old finished topic never opens by itself.
- `omp:chat-btw-delta`: applied when `recordId` is known, the latest turn is `running` **and** its answer length equals `at`; otherwise ignored (the terminal `btw_record` replaces the whole record, so a lost or reordered delta heals itself; nothing is retried). The `running` condition matters because a cancelled or failed turn keeps an empty answer, so the length alone cannot tell it from a follow-up whose first record was lost.
- A snapshot that adopts a **new epoch** resets the store; the host sends the current records right after every snapshot (when the channel is loaded), so the page is authoritative again at once. A host message of another epoch is dropped, as every other host message is.
- "Running" is shown only while the conversation can still be answering: a record whose latest turn is `running` is **displayed as interrupted** when the phase is `stopped`, `failed`, `view-only` or `legacy` (the child is gone; OMP's own recovery says the same on the next history read).

`BtwPanel` (`src/webview/components/BtwPanel.tsx`) renders in `App.tsx`'s dock between `QueuedMessages` and `RewindBar`, in the column's flow (the transcript's bottom anchor absorbs its height), `role="region"`, `aria-label="Side question"`:

- **Header**: the topic's first question (one line, clipped), a status ("Answering…", "Cancelled", "Failed", "Interrupted"), and buttons **History** (when there is more than one record), **Copy** (the latest non-blank answer's source text, `CopyButton`), **Cancel** (a running topic) and **Close**.
- **Body**: every turn of the topic, oldest first: the question (plain text, quoted style) and the answer (`PacedMarkdown` while that turn runs, `Markdown` otherwise; Markdown's existing link/code/diagram handling applies); an error shows as a plain-text line under its turn. The body has its own `max-height` (the smaller of 40 % of the viewport and 420 px, scrolling inside, never beyond the dock) and follows the streaming tail unless the reader scrolled up.
- **Follow-up row** (a topic whose latest turn is not running): a one-line growing textarea, `Enter` sends a follow-up in this topic (`omp:chat-btw-request {op: "ask", recordId}`), `Shift+Enter` a new line; disabled with the reason while a question runs. A refusal's fixed sentence shows in the panel, the input keeps its text.
- **History view**: the records newest first, each with its first question, status, turn count and a relative time; a click shows that topic; **Back** returns.
- **Keys and focus**: opening the panel from a typed `/btw` does not steal the composer's focus. With focus **inside** the panel, `Esc` cancels a running topic, else closes the panel. The panel reports the `Esc` owner (`reportComposerPopupOpen("btw", focusInside)`, a new member of `ComposerPopupOwner`, the way the find bar reports `open && barFocused`) only while focus is inside it, so `Esc` there never also stops the main turn and `Esc` in the composer still does. Cancel and Close are real buttons in the tab order; the status line is `role="status"`.
- It is hidden when the conversation is not writable only in what needs the writer: Cancel, the follow-up row and History refresh are disabled with the existing "not accepting input" reason; reading what is shown never is.

### 5. Interaction with a running turn

- A side question and the main turn are independent in OMP (item 3). Desk adds **no** coupling: the working state, queue, Stop, settlement and `agent_end` handling ignore `btw_*` frames (they are consumed in `#onFrame` before the reducer and the settle watcher).
- **Stop** (button, `Esc`, `abort_and_restore_queue`) does not cancel a running side question; the panel's **Cancel** does. This differs from the TUI, where a single Escape reaches the side panel first; Desk's `Esc` is already overloaded (dialog, popup, find bar, turn) and the panel takes it only while focus is in it.
- `/btw` sent while a main turn runs reaches the host as `steer` or `follow-up`; the interception in §1 happens first, so the text is **never** queued, steered or shown as a user message.
- The side model sees the in-flight partial assistant text (OMP's snapshot), so a question about "what you are doing now" works; Desk does nothing to enable or hide it.
- A `/btw` while a side question already runs is refused (`busy`, the draft kept); the panel shows the running topic.

### 6. Lifecycle

- **Identity.** One `RpcSession` is bound to one session file for its whole life (`#boundFile` is set once, `session.ts:774,2066`; `/new`, Resume and Fork start another `RpcSession`), and OMP keys the sidecar by that file's artifacts directory (`btw-history.ts:80-86`), so the cache stays valid across `/clear`, `/fresh`, which keep the file. OMP's own `btw.close()` on `new_session`, `switch_session`, `open_session`, branch/fork, an extension-initiated session change and process exit (and so Desk's Rewind, which navigates through them) cancels a running question first and lands its terminal `btw_record`; Desk shows that as the usual terminal record.
- **First read.** `BtwChannel.loaded` is false until a `get_btw_history` succeeded. `RpcSession` issues it once after the first baseline of a live session (background, failure ignored: the channel stays not loaded and the next `/btw` or a resync retries). `ChatRuntime` sends a page the cache as `replace` (on attach and after every snapshot) **only when loaded**, and the read itself emits the `replace` to every page. So an extension-host restart, which builds a new `RpcSession` for the surviving child, shows the page OMP's records, a still-running answer included, instead of an empty list.
- **A resync** (broker reattach with a gap in the frame ring): the session reads the history again once after the baseline when the channel was loaded, so a missed terminal record or delta is repaired.
- **Disposal**: `BtwChannel` has no timers and no listeners of its own; it dies with the session.

### 7. Fixed sentences (`src/chat/btw.ts`, shared by host `#tell` and the panel)

| reason | sentence |
| --- | --- |
| `busy` | A side question is still answering. Cancel it first. |
| `no-model` | OMP has no active model for a side question. |
| `unknown-topic` | That side conversation no longer exists. Type /btw to see the current list. |
| `storage` | OMP could not save the side-question history, so it did not start the question. |
| `cancelled` | The side question was cancelled before it started. |
| `unsupported` | This OMP version has no /btw over RPC. Update OMP, or use Terminal mode. |
| `unconfirmed` | OMP has not confirmed the side question. If it started, its answer appears in the panel; it was not resent. |
| `failed` | OMP could not start the side question. |
| `not-live` | This conversation is not accepting input right now. (The sentence of `CHAT_NOT_LIVE_SENTENCE` in `chat-runtime.ts`; the page-imported `btw.ts` carries its own copy of the text, since it cannot import the host module.) |
| `images` | A side question takes text only. Remove the attached images and send it again. |
| `too-long` | A side question is limited to 8,000 characters. Shorten it and send it again. |

A `failed` side **turn** (`status: "error"`) shows OMP's own error text under its question, clipped to 500 characters, as plain text (never Markdown): it is the provider's reason the model call failed and hiding it would leave nothing to act on. The record stays in the history.

### 8. Files

New: `src/chat/btw.ts` (+`.test.ts`), `src/host/rpc/btw.ts` (+`.test.ts`), `src/protocol/btw-messages.ts` (+`.test.ts`; the btw parsers, called by `chat-messages.ts` with the epoch already checked), `src/webview/lib/btw-client.ts` (+`.test.ts`), `src/webview/components/BtwPanel.tsx`, `src/webview/btw-styles.ts` (imported by `styles.ts`).

Edited: `src/protocol/rpc.ts` (three `RpcCommand` members), `src/protocol/chat-messages.ts` (union members and two parser cases, the table in the header comment), `src/host/rpc/session.ts` (frame case, `btw` accessor, output member, first read and resync repair), `src/host/chat-runtime.ts` (`#serveBtwCommand`, `omp:chat-btw-request` handling and its answers at every gate, output mapping, re-send), `src/webview/lib/chat-client.ts` (route the three messages to `BtwClient`), `src/webview/App.tsx` (panel in the dock), `src/webview/lib/composer-overlay.ts` (the `btw` owner of the `Esc` signal), `slash-completion.ts` (`DESK_COMMANDS`; `command-list.ts` needs no row: an entry that takes arguments is completed into the draft, and a text command is available during a turn), the routing tables above (`bridge.ts`, `guest-dispatcher.ts`, `extension.ts`), `docs/guide/chat.md`, `docs/architecture.md`, `CHANGELOG.md` (Unreleased), `docs/README.md`.

## Alternatives

- **Put the side question in the `ChatModel`** (an `ephemeral` card or a new `btw` field of the snapshot). Rejected: it would ride every snapshot and chunk, be searched by Find, counted by the row windowing, and invite the reducer to treat a side answer like a turn; the whole point is that it is outside the conversation. A separate small store keeps the transcript code untouched and the page's wire additive.
- **Let the page parse `/btw` and send `omp:chat-btw-request` directly (no host interception of text).** Rejected as the only path: a typed command also arrives from the palette, a restored draft, history recall and a queued "send now", all of which funnel through `handleMessage`; the host is where every other Desk command is answered, and the page's text path already exists. The page-side message is kept for the panel's own actions (follow-up, cancel, history) which have no text form.
- **Make `/btw` a `DeskSessionCommand`.** Rejected: that type models commands that take **no** arguments (`hasArguments` is a refusal there); `/btw`'s argument is the whole point.
- **Send `/btw …` to OMP as a prompt and let OMP's RPC mode run it.** It does not: the builtin has no text-mode handler, so the text would reach the model as a prompt and **enter the transcript**, the opposite of the feature.
- **Open the answer in an editor tab or a VS Code view** (like the subagent transcript tabs). Rejected: a side question is a quick aside next to the composer; a tab breaks the flow, needs a second page, a second store and a host message route, and the maintainer's Chat keeps its asides in the dock (queue, TODO, Rewind).
- **Cancel the side question with the main Stop.** Rejected for now: OMP lets the two run independently on purpose, Stop already withdraws queued messages, and one key doing both would surprise a user who stops the turn but wants the aside.
- **Never read the history until the panel asks.** Rejected after review: an extension-host restart reattaches the child with a new `RpcSession` (empty cache), and a `replace` of an empty list would close a panel that shows a running answer. So the session reads `get_btw_history` **once** after its first baseline (one RPC and one small directory read per session lifetime; an old OMP answers `Unknown command` once and the channel stays "not loaded"), and a page is only ever sent a `replace` after that read.
- **Free-text OMP errors for every refusal.** Rejected: the project's rule is fixed, bounded sentences for diagnostics (ADR-0017's spirit); matching OMP's wording only to pick a fixed sentence keeps a changed wording harmless (`failed`).

## Risks and Open Questions

- **OMP's wording** is matched to pick the refusal reason; a different wording of a later OMP degrades to the generic `failed` sentence, it never mislabels a success. The matching is one small function, pinned by a test against the strings of the installed OMP 18.11.1 (copied from `rpc-btw.ts`), and is re-read with each OMP bump.
- **Bounds are a compromise.** A 64 000-character answer clip is far above a side answer's size and below the frame ceiling; the cost of the 4 000-character retry is a visibly shortened answer in a pathological message size (it is flagged `clipped`).
- **Two pages, one panel.** A new running record opens the panel on every page of the conversation; closing it is per page. A user with Chat in two editors sees the answer in both: intended (the question belongs to the conversation), and cheap.
- **`Esc` ownership** must not regress the existing ones (dialog, completion popup, find bar, rewind bar): the panel only takes `Esc` while focus is inside it, and a page test pins that `Esc` in the composer still stops the turn with the panel open.
- **No installed-OMP evidence yet** for the frame order on Desk's broker path (a missed `btw_record` before the `btw` response, a delta after a terminal record). The hidden-window end-to-end scenario against the real `omp` and the mock model server is part of the verification below; the reducers tolerate both orders.
- Open for the maintainer: an explicit toolbar button for the history, and whether `Esc` outside the panel should cancel a running side question first (the TUI's behaviour). Neither blocks this design.

## Rollout and Verification

Implementation order: `src/chat/btw.ts` and its tests; `BtwChannel` and tests over a scripted channel; protocol messages (after the files HostSignals owns are released); `RpcSession` and `ChatRuntime` wiring; `BtwClient`; the panel; catalogue entries; docs.

- `src/chat/btw.test.ts`: `btwCommand` (leading token, case, empty, `/btw-it`, prose); `reduceBtw` (upsert, new-running opens the panel, replace, delta with a matching `at`, a lost delta healed by the terminal record, interrupted display, bounds); the fixed vocabulary.
- `src/host/rpc/btw.test.ts`: `ask` mapping of every OMP error string and of a timeout; frame order (record before response, delta after terminal record dropped); history replace with a running live copy; clipping and the `omitted` counts.
- `src/host/chat-runtime-btw.test.ts` over the existing scripted-channel harness (`chat-runtime.test.ts`): a typed `/btw q` writes **one** `btw` command and **no** `prompt`/`steer`/`follow_up` (idle and while a turn runs), answers `explained`; a refusal answers `refused` with the sentence; `/btw` alone posts the history; a second page attaching receives the records; the panel's `omp:chat-btw-request` ops; the transcript rows, queue and turn state are unchanged by a whole ask.
- `src/protocol/chat-messages.test.ts` (or a new test file): the new messages round-trip and every malformed form is refused; `src/webview/lib/btw-client.test.ts`: the page rules above (epoch drop, `at` rule, snapshot reset, no panel for an old finished topic).
- `src/webview/chat-ui.test.ts` page tests in Chromium: the panel streams, completes, cancels, follows up, shows the history, copies; `Esc` inside the panel cancels or closes while `Esc` in the composer still stops a running turn with the panel open (the owner reports only while focus is inside); the panel and a queued message and a dialog coexist; 360 px width.
- Also pinned: the `notice` frame of a failed checkpoint is consumed (not a transcript row, `BtwChannel.onFrame` test and a `RpcSession` frame test); a panel request answered by each gate (no conversation, read-only, no session, epoch mismatch) with `omp:chat-btw-result` `refused`; a record larger than a message is cut by `fitBtwRecord` and a `too-large` post of a btw message never re-sends the snapshot; a delta on a cancelled or failed turn is ignored though the length matches; a recreated session with a still-running question sends `replace` only after reading OMP's history, and that `replace` carries the running record.
- One hidden-window end-to-end scenario (`test/e2e/scenarios/48-chat-btw.spec.ts`, real `omp`, mock model server, `scripts/test-vscode.ps1`, under the shared e2e lock): a side question during a running turn streams its answer, the main transcript and the journal do not contain it (no new row, `agent_*` untouched), Cancel ends it, `/btw` lists it afterwards, and a page reload during an answer returns to the panel (the page is rebuilt; the host's cache and the history read at attach are the authority, §6). An extension-host restart is proven at host level (a recreated `RpcSession` reads the history before the first `replace`), not in the window.
- `npm run typecheck`, the touched test files only.

## Related Decisions

- [ADR-0038](../decisions/0038-host-chat-over-rpc-ui-on-a-broker-pipe-child.md): the host-owned conversation and the `omp:chat-*` family.
- [ADR-0059](../decisions/0059-clear-chat-in-place-through-a-desk-registered-omp-command.md) and [`/fork`](2026-10-18-fork-branch-clear-session-actions.md): Desk-owned slash commands answered by the host.
- [`/review`](2026-10-18-chat-review-command.md): the dialog-aware command deadlines this design relies on for `btw` too.
- [Paseo-style chat](2026-10-04-paseo-style-chat.md): the dock, the semantic rows and the slash picker.

No new ADR: the lasting choices here are local to one feature and follow existing decisions (the side-question state stays outside `ChatModel` and its snapshot, the host cache is the page's authority while OMP's sidecar stays the source of truth, a refusal is a fixed sentence chosen by matching OMP's wording), and no dependency is added; this design records them, as the `/fork` design does.

## Architecture Review

- Reviewer: independent `reviewer` agents (a first pass and a confirmation pass over the revised text)
- Outcome: accepted after review. First pass: `accept with changes` — three material findings (the extension-host-restart goal was not reachable by the first design; OMP's `notice` frame for a failed history save would have written raw OMP text into the transcript; panel requests went unanswered at three gates), four should-fix items (a snapshot/`too-large` re-send loop and a character-based size budget; the delta rule needed a running turn; the `Esc` owner had to be focus-scoped; the ADR decision had to be stated) and five nits; all were resolved in this text (§§1-8, Alternatives, Verification). Confirmation pass: `accept with changes` with two remaining items (the `images` reason missing from the fixed table, and a stale page-to-host message name), both fixed.
- Notes: the OMP evidence (frame order, one-at-a-time, `btw_cancel` backgrounded, sidecar location, `btw.close()` on session changes) and the Desk facts (gate order, dispatch tables, `ChatClient` send path, dock order) were confirmed against the installed OMP 18.11.1 sources and the working tree by both passes. Implementation notes that deviate from the first wording: `fitBtwRecord` cuts a single over-large record instead of a clipped retry; the `images` and `too-long` reasons exist for the typed command.
