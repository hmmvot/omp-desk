---
status: accepted
date: 2026-10-21
---

# ADR-0082: Stop takes a message back out of the conversation when nothing was answered or done

> Amends [ADR-0052](0052-answer-terminal-only-commands-and-restore-the-queue-on-stop.md) (what Stop does) and reuses the mechanism of [ADR-0051](0051-rewind-chat-in-place-through-a-desk-registered-omp-command.md). Design: [Stop returns a message that was sent a moment ago to the composer](../designs/2026-10-21-stop-returns-a-fresh-message.md).

## Context and Problem Statement

A user sends a message and sees at once that it is wrong (a missing attachment, a typo, the wrong file) and presses Stop. Since ADR-0052 the turn stops and the queued messages come back to the draft, but the message that started the turn stays in the transcript and in the OMP session, so the model still sees it on the next turn, and its text is gone from the composer. Rewind removes it, but only after the stop has settled and through a picker.

When the Stop comes right away, the user means "take that back". Measured on OMP 18.12.2 over `omp --mode rpc-ui` (details in the design):

- An abort in the 0.7 to 1.6 s between the prompt and `agent_start` **drops the prompt before it reaches the agent**: nothing is written to the session file, and the prompt's own `prompt_result` arrives with `status: "aborted"` and `agentInvoked: true`. RPC mode never installs OMP's `setPromptDropped` hook, so that result is the only evidence.
- An abort after `agent_start` leaves the user message and an assistant message with `stopReason: "aborted"` (empty, or with partial text); a skill invocation is written as a `custom_message` of type `skill-prompt`, not a user message.
- An abort that arrives after the turn finished is a no-op that still answers success.
- Hidden messages that ride with a user message are written before it.

This is the first time Stop changes the session itself, so the rule has to be exact and fail closed: whatever is not clearly eligible must behave exactly as Stop does today.

## Considered Options

- **Time only (the first N seconds):** simple, but cannot tell a model still thinking from one that answered or acted, and removes a visible answer.
- **Output only (no answer, no action, whatever the time):** misses "right away" when the model has already started to write.
- **Hide the row in the page only:** the model would still see the message; against the requirement.
- **RPC `branch`/`fork`:** a new file and conversation identity; rejected for Rewind in ADR-0051 for the same reasons.
- **A new `withdraw` kind of the OMP-side command targeting the baseline:** would also remove the hidden messages written before the request and would need no change for a skill invocation, but changes the wire, the marker and the Undo vocabulary for a benefit Rewind itself does not have. Rejected for now; revisit if the hidden-notice gap proves to matter.
- **Wait for OMP's `setPromptDropped` over RPC:** not available in 18.12.2; the `prompt_result` is the observable evidence.
- **Return the draft from the stored entry (what Rewind does):** loses the typed text of an expanded template or skill and returns resized images; the host's ledger has the originals.
- **Deliver the removal as a second message after the Stop answer:** ends "Stopping…" sooner in a rare slow case, but adds correlation and ordering to a one-shot answer; the fence already covers the window.
- **A recovery card instead of appending when the composer has text:** an append overwrites nothing; the card is for Rewind, which replaces.
- **Show Stop from the send acknowledgement:** would reach the drop window by button; a UI change for a window of about a second, not part of this work.
- **Time and output together, with action as a hard veto (chosen):** the rule below.

## Decision Outcome

Chosen: **a Stop that interrupts a turn which has neither acted nor, beyond a short grace after the send, answered removes the message that started the turn from the active branch, through Rewind's mechanism, and returns it to the composer.**

**The rule.** A Stop *withdraws* the anchor when all of these hold:

1. An **armed anchor** exists and the request asked for it (`takeBack: true`) and OMP took `abort_and_restore_queue`. The anchor is the one `prompt` the host sent to start a turn, recorded in its ledger entry with request id, text, images, send time and a baseline (the newest durable entry then held). It exists only when no turn, pending row, queued message or other ledger entry existed at the send; a prompt sent during a turn is never one. Only text OMP turns into plain user input qualifies (`anchorKind`): not a builtin, extension or custom command, nor `!`/`$ ` local execution; a markdown command or prompt template and a listed skill invocation do. It is armed by the acknowledgement of its own `prompt` with `agentInvoked: true` and disarmed by a refusal, an `agentInvoked: false` answer, a `tool_execution_start`, a second user message, or the Stop that takes it. The plain `abort` fallback never withdraws.
2. After the stop has settled and the host re-read the branch, the entries since the baseline are bookkeeping and OMP's own messages, exactly one request (a user message, or a user-invoked skill invocation, whose text equals the anchor's), and after it only bookkeeping and at most one assistant message.
3. That assistant message, if any, has `stopReason: "aborted"`; any other reason means the turn ended by itself.
4. It has no tool call, server tool or unknown block, whatever the time.
5. It has no non-blank text, **or** the Stop came at most 5 seconds (`WITHDRAW_GRACE_MS`) after the send by the host's clock. Thinking blocks never count as an answer.

If only bookkeeping follows the baseline and the anchor's own `prompt_result` says `aborted` with `agentInvoked: true`, OMP dropped the prompt before dispatch: there is nothing to remove, and the typed text and images return from the ledger. Anything else is not eligible and the Stop is today's Stop, silently; only an eligible Stop whose action failed says so. The 5 seconds is a constant with a test, not a setting.

**The mechanism.** `RpcSession.abortAndRestore(requestId, { takeBack })`:

1. Takes the anchor before its first await (a second Stop with another request id finds none) and runs a monotone pre-check over what the live model already shows; a tool call, a second user message, a foreign entry, or text past the grace drops the anchor and the Stop proceeds with no extra wait. Otherwise it raises a **withdrawal fence**: every mutation is refused `busy` until the verdict, as during a navigation.
2. Sends `abort_and_restore_queue` as before, then waits, bounded, for the anchor's `prompt_result` and a settled session, and reconciles.
3. Decides with the pure `withdrawVerdict` (`src/chat/stop-withdraw.ts`): `remove`, `dropped` or `keep`.
4. `remove` calls `RpcSession.navigate` with `kind: "rewind"` on the request entry: the same refusals, CAS, fence, durable marker and re-sync as the picker's Rewind, so the removal survives a reload and Undo is offered. The OMP-side command also accepts a user-invoked skill invocation as a target (the picker's list is unchanged). The draft is the typed text and images from the ledger.
5. A navigation OMP did not answer in time returns the draft marked `unconfirmed`; a refusal returns `kept` (the message stays, no draft). The fence is released on every path.

**The wire.** `omp:chat-abort` gains `takeBack?: true`; `omp:chat-abort-result` gains `withdrawn?: { text, images?, unavailableImages?, unconfirmed? }` and `kept?: true`, both absent for an ineligible Stop. `ChatRuntime.#answerAbort` takes the whole outcome and never drops the draft: an answer the route cannot carry is resent without the draft's images and then with fewer queued entries. Only the page that pressed Stop receives the draft.

**The page.** `Composer.stop` sends `takeBack: true` and hands `[withdrawn, ...queued]` to the existing hand-back path (`offerQueuedForEditing`): after whatever the composer already holds, before queued messages, one undo step. A notice (`stop-withdraw`) says the message is back, with an `unconfirmed` variant, or warns that OMP could not take it out (`kept`). Undo of the move also clears the refill only when the composer was empty, the hand-over was the withdrawn message alone and the refill is unedited.

### Consequences

- Positive: a mistaken message can be taken back in one gesture, and the model never sees it.
- Positive: the removal is durable, undoable and fenced like Rewind, because it is Rewind's code path; no new session-file vocabulary.
- Positive: the rule fails closed. Every unproven case is today's Stop, and a tool call vetoes at any time because Undo cannot restore files.
- Positive: the draft always comes back when the message is removed or unconfirmed: a duplicate can be deleted, a lost message cannot.
- Negative: a hidden notice written before the message (a magic keyword's note, an attachment note, an image description, the eager TODO prelude) and the first-turn memory recall chosen from the message stay on the branch, as after Rewind; the recall can still shape later recall.
- Negative: a skill invocation needs the Desk OMP-side command of this build; a session started by an older build gets `kept`. A dropped prompt needs no command and still works.
- Negative: the Stop button appears only with `agent_start`, 0.7 to 1.6 s after a send, so the drop window is reached by the Command Palette's Stop Current Turn, not the button.
- Negative: other windows of the same session see the shorter branch and the Undo bar but do not receive the draft, and an Undo pressed from another window does not clear the first window's refill.
- Negative: the host holds a prompt's images in the ledger until the turn's `prompt_result`, the first tool call, a second user message, a refusal or the Stop; the ledger stays bounded at 64 and a disarmed entry keeps no images.
- Negative: a conversation read through a `get_entries` fallback can lack the baseline; the rule then keeps the message.

## Related Documents

- [Design: Stop returns a message that was sent a moment ago to the composer](../designs/2026-10-21-stop-returns-a-fresh-message.md).
- [ADR-0051](0051-rewind-chat-in-place-through-a-desk-registered-omp-command.md) (the mechanism this reuses), [ADR-0052](0052-answer-terminal-only-commands-and-restore-the-queue-on-stop.md) (Stop and the queue hand-back), [design: Rewind](../designs/2026-10-09-chat-rewind.md), [design: Edit and cancel queued messages](../designs/2026-10-07-edit-queued-messages.md), and [architecture](../architecture.md).

## Architecture Review

- Reviewer: architect (independent; not the author).
- Outcome: accept with changes. First pass: 4 material and 8 should-fix findings, all applied. The second pass is recorded in the design document.
- Notes: the findings changed the anchor's identity and one-turn-start rule, the disarming by `agentInvoked: false` and by refusals and tool calls, Undo with queued messages, the `unconfirmed` outcome, the positional tail rule, the definition of the baseline, the withdrawal fence, command texts, the exclusion of the plain-`abort` fallback, the `takeBack` flag, the skill invocation as a rewind target and the documented leftovers.
