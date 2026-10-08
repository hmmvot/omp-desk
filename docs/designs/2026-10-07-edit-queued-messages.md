---
status: accepted
date: 2026-10-07
---

# Edit and cancel queued messages from the Chat dock

## Problem

While a turn runs, Enter steers it and Alt+Enter queues a follow-up. Chat shows only the count: the composer footer's `queued ×N` chip. The user cannot see what is queued, cannot remove a message they regret, and cannot pull one back to edit it. The native TUI can: it lists the pending messages and Alt+Up moves them back into the editor.

## Goals and Non-goals

- **Goals**
  - List the queued messages, steering then follow-up, each kind distinguished, in a compact row at the bottom of the chat column directly above the composer, in the flat tool-row style of the TODO and Agents rows. One line per message, truncated with an ellipsis, the exact text in the tooltip.
  - **Remove** (×) takes one message out of OMP's queue.
  - **Edit** takes one message out of OMP's queue and puts its text and images into the composer, **appended** to any draft.
  - **Edit all** does that for every queued message, in queue order.
  - The list is the host's readback of OMP's queue, never a local copy. A message OMP delivered between the click and the command is reported as already sent, never dropped, duplicated or reported as removed.
  - The row obeys the dock's bottom-anchor rule: its appearance, growth and disappearance do not move the line the transcript shows at its bottom edge.
- **Non-goals**
  - No change to OMP. No promote-to-steering action (`promote_queued_message` exists but was not asked for), no Alt+Up key, no reordering.
  - No queue shown for subagents, and nothing OMP's TUI keeps outside the agent queue (its compaction-time queue has no RPC surface).
  - No local queue: a message is queued only by OMP.

## Current State

The host reads `queuedMessageCount` from `get_state` and from `queue_update` (which carries the lists but was reduced to `steering.length + followUp.length`: `src/host/rpc/protocol.ts`). The footer chip and `ChatLiteState.queuedMessageCount` are the only consumers. The composer's header comment states that OMP's `queuedMessageCount` "stays the only queue the UI shows".

### Verified against the installed OMP

Installed OMP is `omp 18.6.3` (package `@oh-my-pi/pi-coding-agent`, first on `PATH`; an older `18.0.4` build of the official launcher is also on `PATH`, not examined). Paths are relative to the package's `src` directory. `--mode rpc-ui` runs the same `runRpcMode` as `rpc` plus a tool-UI context (`modes/rpc/rpc-mode.ts:1326-1330,1612-1614`), so every command below exists in it.

| Need | OMP surface | Reference |
| --- | --- | --- |
| Read the queue: contents | `get_state.queuedMessages: { steering: string[]; followUp: string[] }`, "displayable queue-chip text for pending user-authored messages … accepted verbatim by `remove_queued_message`" | `modes/rpc/rpc-types.ts:180-183`; `modes/rpc/rpc-mode.ts:2022,2039`; wire `modes/rpc/wire/state.ts:43-44,130`, `rpc-wire.generated.ts:417-421` |
| Read the queue: live | `queue_update` event `{steering, followUp}`, coalesced, emitted on enqueue, delivery, remove, clear and session switch | `session/agent-session-events.ts:84-88`; `session/agent-session.ts:8824-8843`; wire `events.ts:155-158`, `rpc-wire.generated.ts:974-978` |
| Read the queue: **ids** | **None.** A message is identified by its chip text and its queue | `rpc-types.ts:42`; `agent-session.ts:8909-8917` |
| Remove one item | `remove_queued_message {message, queue}` → `{removed, images?, imagesDropped?}`; removes the **first** match (raw submitted text first, then chip text), with its hidden companions; a missing or already delivered target changes nothing and answers `removed:false` | `rpc-types.ts:42,295-302,383-386`; `rpc-mode.ts:1893-1905`; `agent-session.ts:8846-8875,8926-8932`; wire `commands.ts:50-55` |
| Clear or dequeue all **without aborting** | **Not exposed.** `abort_and_restore_queue` withdraws every user-authored message, **then aborts the run** and returns `{steering, followUp}` as `{text, images}` | `rpc-types.ts:46,304-312`; `rpc-mode.ts:1920-1927`; wire `commands.ts:69-73`. (`session.clearQueue()` is not an RPC command.) |
| Promote follow-up to steering | `promote_queued_message {message}` (unused here) | `rpc-types.ts:43,387`; `agent-session.ts:8883-8902` |
| How the TUI dequeues | Alt+Up (`app.message.dequeue`, bound at `input-controller.ts:657-658`) pops the **last** queued message (steering first) back into the editor: `handleDequeue` → `popLastQueuedMessage`. Esc restores **all**: `clearQueue` + abort. Both go through `#restoreEntriesToEditor`: texts oldest→newest joined with a blank line and placed **before** the current draft; images go back to the pending-image buffer and every `[Image #N]` marker is shifted by the number of images already pending. The TUI's pending band groups the queue as "Steering" and "After yield" | `modes/controllers/input-controller.ts:657-658,1621-1649,1971-1994,2002-2044`; `modes/utils/ui-helpers.ts:1100-1124`; `agent-session.ts:8933-8963` |
| What `get_state` exposes | `queuedMessageCount` (includes agent-authored and next-turn entries: `agent-session.ts:8798-8804`), and `queuedMessages` (user-authored only; includes steering the running response already took, which stays listed until the transcript records it: `agent-session.ts:8813-8822`) | `rpc-types.ts:175,183` |

Consequences that shape the design:

1. **Per-item removal is supported**, so cancel and edit are exact: no dequeue-all-and-requeue is needed (it would not have been race-safe: the queue can drain between the clear and the re-queue, and a re-queue loses steering/follow-up position).
2. **There is no dequeue-all that leaves the run alone.** "Edit all" is therefore a sequence of per-item removals in queue order. Each removal reports its own `removed`, so a message delivered mid-sequence is reported, not lost.
3. **Identity is text, not an id.** Two identical messages are interchangeable; removing "the second" removes the first identical one, which has the same text (its images may differ: an accepted, documented edge).
4. **A listed steering message can be un-removable**: `getQueuedMessages` includes steering the stream has already claimed (`agent-session.ts:8817`), but removal only searches the queue itself (`8867`). OMP answers `removed:false`; the page reports "already sent or no longer queued", which is accurate: the running response already holds it.

## Proposed Design

### Data: the host readback

- `ChatLiteState.queuedMessages?: { steering: readonly string[]; followUp: readonly string[] }` (`src/chat/model.ts`). `parseStateData` fills it from `get_state`; the `queue_update` frame now carries it (replacing the whole list and the count); snapshots carry it through `ChatLiteState`. One source: the list and the footer chip cannot disagree about when they were read.
- `normalizeQueuedMessages` bounds the readback (50 per kind, 128 KiB of UTF-8 JSON bytes in total, so a snapshot head fits the bridge route's 256 KiB frame) but **never edits a message's text**: OMP matches the exact string, so stripping a control character or trimming would turn a listed message into one that can no longer be removed. A message that does not fit is left out of the list rather than listed in a form that cannot be acted on, and is counted in `queuedMessages.unlisted`, which the row header shows.

### Wire: two messages

- Page → host `omp:chat-queue-remove { requestId, epoch, purpose: "cancel" | "edit", items: [{queue, text}] }`. A mutation like `chat-steer`: parsed by `parseChatWebviewMessage` (texts together bounded to 128 KiB of JSON bytes), carried by the panel route and the bridge (`chat-queue-remove` operation), fenced by epoch and by the host's read-only/mutation gates, exactly-once per `requestId`.
- Host → asking page `omp:chat-queue-result { requestId, epoch, purpose, results: [{status, images?, imagesDropped?}] }`, one entry per item in request order and **no message text** (the page holds the texts), so the answer stays small on every route. Status is `removed`, `gone` (OMP answered `removed:false`: not in the queue any more), `unknown` (the answer was lost: never resent) or `failed` (OMP refused the command, or it was never sent: still queued).

### Host

`RpcSession.removeQueued(requestId, items)` sends one `remove_queued_message` per item, **sequentially in the given order** (OMP runs them in its serial command queue), maps each answer, and never retries. After the first unconfirmed command it sends nothing more: the remaining items are `failed` (never sent, still queued), which bounds a request to one command timeout. It does not touch the model: OMP's own `queue_update` (emitted before the command's response on the same stream) updates the readback. `ChatRuntime` answers the asking route only, with the request's own epoch. Images travel only for `edit`. If the route cannot carry the result (`too-large`), it is resent without images and flagged `imagesDropped`; if the asking route cannot take it at all, the command is reported `unconfirmed` (logged), never `accepted`. Every refusal (read-only route, no live session, stale epoch, mutation fence) answers that route with `failed` for each item.

### Page

- `ChatClient.removeQueued(purpose, items)` resolves with the host's results; it rejects nothing: a refused page (not live, read-only) and an unreachable host resolve `{ ok: false, reason }`, a silent host resolves every item `unknown` after 90 s. An answer is matched by request id and purpose, and its entries are paired with the request's items by index.
- `QueuedMessages` (`src/webview/components/QueuedMessages.tsx`) renders in `.omp-dock` between the HUD rows and the composer:

```
 ≔ Queued   1 steering · 2 follow-up                      ✎ Edit all
     Steering   fix the lint                                  ✎  ×
     Follow-up  second line                                   ✎  ×
     Follow-up  Please also double check that every one of t… ✎  ×
```

  It is the HUD rows' layout (column width, 26 px header, 20 px lines, hover, theme variables only) in normal flow with no scroll region. The number of lines is capped by a share of the viewport (25%, at most 6 including `+N more`); Edit all always takes every message, hidden ones included. Items are buttons with accessible names that include the message; all actions are disabled while a removal is pending and when the conversation is not writable (the list stays visible).
- After a removal it shows a one-line status (role `status`, dismissable) only when something needs saying: `N queued message(s) was/were already sent or is/are no longer queued, so it/they could not be removed/edited.`, `OMP did not confirm whether … was removed` (the tooltip carries the exact texts, so an unconfirmed message cannot be lost), `… could not be removed and is still queued`, `Some images could not be restored to the composer.`
- **Edit** hands only the `removed` entries to the composer (`lib/queue-restore.ts`). The composer appends them after its draft, separated by a blank line (the TUI prepends; the user asked for append, and a draft is never overwritten): each message's `[Image #N]` markers are renumbered onto fresh numbers of the draft, its images are attached again, an image the text never mentioned gets a marker at the end of its message so it is still sent, and a marker with no image behind it stays plain text and is never given a number a real image now owns. The caret goes to the end and the textarea is focused. Nothing is sent. If the restored images push the draft over the per-message budget, **Send** says so instead of sending a message the host would refuse.
- Submission does not populate this queue optimistically. The composer waits for a correlated native admission outcome, retaining editable text/images in the meantime; only `queue_update` or state readback establishes what is queued. Unconfirmed original input remains in a persistent recovery card, never automatically resent. Add to draft reuses the same append-and-renumber merge as Edit, without overwriting newer work or duplicating an identical still-held message.

### Bottom anchor

The row is ordinary flow inside `.omp-dock`, so `TranscriptScrollController`'s existing resize handling is the anchor (the TODO/Agents design's rule). The list height is fixed per row (20 px lines, 26 px header) and capped, so it never reflows from content; the status line is one clipped 20 px line. No scroll code is added; a browser test pins the bottom line to ≤ 1 px, following and detached, while the row appears, shrinks, shows a notice and disappears.

## Alternatives

- **Dequeue all with `abort_and_restore_queue`, then re-queue the rest.** Rejected: it aborts the running turn, and re-queueing is neither atomic nor order-preserving across the steering/follow-up split, and a message delivered in between would be duplicated or lost.
- **Model removal as optimistic local state.** Rejected by the requirement: the list is OMP's readback; a click changes it only through OMP's own `queue_update`.
- **Carry the removed content in the model (a `pendingEditorText`-style frame).** Rejected: the model is shared by every route of a conversation, so every page would append the dequeued text. A reply to the asking route only keeps the edit in the window where the user clicked.
- **Clamp message text for display in the model.** Rejected: removal needs the exact text.
- **Overwrite the draft like `set_editor_text`.** Rejected: the user asked for append.

## Risks and Open Questions

- **Text identity.** OMP matches the submitted text first and the chip text second, and removes the first match (`agent-session.ts:8909-8917`). Two identical messages are interchangeable, but a message whose raw text equals another message's chip text can be removed in its place: the list then shows the wrong row disappearing while the text restored is the clicked one. OMP's answer carries no text, so the host cannot do better. Accepted: there is no id.
- **Older OMP.** `remove_queued_message` and `queuedMessages` exist in 18.6.3; a child that lacks them refuses the command (`failed`: "could not be removed and is still queued") and lists nothing (the chip still counts). Not exercised against the `18.0.4` binary also on `PATH`.
- **Lost result.** If the host or the link dies after OMP removed a message and before the answer arrives, the page reports `unknown` after 90 s and the notice's tooltip carries the exact texts it holds (cut at 4000 characters); images are lost. A routine epoch change during the round trip is *not* such a case: the answer is matched by request id.
- **Not listed.** A message too large to list, or past the 50-per-kind / 128 KiB limits, stays queued but cannot be edited or removed here; the header says how many (`N not listed`). "Edit all" takes every *listed* message.
- **`gone` is not always "sent".** OMP answers `removed:false` for a message it delivered, one the running response already took, and one removed elsewhere (the TUI, another window); the notice says "already sent or no longer queued".

## Rollout and Verification

Single slice: model/protocol, session, runtime, messages and client, row and composer hand-over, styles, tests, `architecture.md` paragraph. Verified by: `src/chat/queued-messages.test.ts` (bounds, reducer, message grammar), `src/host/chat-runtime-queue.test.ts` (real `RpcSession` over the fake channel: readback; cancel sends the right command; order; images only for edit; the already-delivered race; unknown halts the request; refused; exactly-once; epoch; the answer goes to the asking route only, with the request's epoch and no text), `src/webview/lib/queue-restore.test.ts` and `queue-view.test.ts` (draft merge, notices), `src/webview/queued-messages-ui.test.ts` (owned Chromium: list, tooltip/ellipsis, cancel, edit appending to a draft even when the epoch moved meanwhile, image re-attach and send, Edit all, already-sent notice, read-only, +N more, no transcript jump). Installed isolated-window acceptance is not part of this slice.

## Related Decisions

[ADR-0038](../decisions/0038-host-chat-over-rpc-ui-on-a-broker-pipe-child.md) (rpc-ui chat), [Tool-style TODO and Agents rows](2026-10-06-todo-agents-rows.md) (dock rows and bottom anchor), [Paseo-style chat](2026-10-04-paseo-style-chat.md) (composer, dock).

## Architecture Review

- Reviewer: architect (separate session, read-only; OMP 18.6.3 sources re-checked)
- Outcome: accepted after two material findings were resolved and the minor ones answered.
- Notes:
  - **M1, a confirmed removal could be discarded by the page.** Resolved: the host answers with the *request's* epoch and the page correlates the answer by `requestId` alone (a reconcile bumps the epoch during a normal round trip, so the epoch no longer decides anything after the command ran); an epoch change no longer settles a pending removal; the host stops after the first unconfirmed command (later items are `failed`: never sent), so a request takes at most one command timeout, and the page waits 90 s, well past that; the fallback to other routes is removed (their clients hold no pending request); every refusal path (read-only route, no session, stale epoch, mutation fence) answers the asking page with `failed` for each item instead of leaving it to time out.
  - **M2, bounds above the bridge's frame.** Resolved: the readback is bounded in UTF-8 JSON bytes (128 KiB in total, so a snapshot head fits the narrowest route's 256 KiB frame), a removal request is bounded the same way, and the result carries no message text (one `{status, images?}` entry per requested item; the page already holds the texts). Messages left out of the list are counted (`unlisted`) and shown in the row header.
  - **Minor.** The OMP match order (raw submitted text before chip text) is documented under Risks; refusals answer the page; `gone` is worded "already sent or no longer queued"; the composer defers a restore while an IME composition is open; the TUI line references were corrected.
  - **Not taken.** A bounded set of timed-out request ids to accept a late answer. The host bounds a request to one command timeout and the page waits three times that, so a late answer needs the child or link to stall mid-command.
