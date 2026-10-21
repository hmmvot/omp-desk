---
status: accepted
date: 2026-10-21
---

# Stop returns a message that was sent a moment ago to the composer, and removes it from the conversation

## Problem

A message is sent from the Chat composer and the user notices at once that it is wrong: a missing attachment, a typo, the wrong file. They press Stop (button, `Esc`, **Stop Current Turn**). Today the turn stops, but the message stays in the transcript and in the OMP session, so the model keeps seeing it on the next turn, and the text is gone from the composer: the user has to retype it, or use Rewind (`Esc` `Esc`, pick the prompt, confirm) after the stop has settled.

When the Stop comes right away, the user means "take that back". The feature: a Stop on a turn that has done nothing the user would count as an answer or an action removes the message that started the turn from the conversation (from the OMP session, so the model never sees it, not just from the page) and puts it back into the composer to edit and send again.

## Goals and Non-goals

- Goals:
  - A Stop within a few seconds of sending, or while the agent has neither answered nor acted, removes the message that started the turn from the active branch of the OMP session and returns its text, images, file blocks, quotes and skill/command text to the composer of the page that pressed Stop.
  - The rule is precise, decided on facts the host holds and re-checks after the stop has settled, and fails closed: whatever is not clearly eligible behaves exactly as Stop does today.
  - Removal uses the existing in-place Rewind mechanism (ADR-0051), so it is durable (a reload or restart shows the shortened branch) and undoable (the Undo offer appears).
  - A removal that failed is said; a removal OMP did not confirm is said differently, and the message is returned in both cases, because a duplicate can be deleted and a lost message cannot.
- Non-goals:
  - Removing a message after the agent answered or acted beyond the grace window (Rewind does that on request).
  - Restoring files the agent changed (Rewind never does either); a tool call therefore vetoes the removal at any time.
  - Removing what OMP wrote *with* the message and *before* it: magic-keyword and attachment notices, image descriptions, the eager TODO prelude, and the first-turn memory recall chosen from the message. Rewind leaves them too; see Risks.
  - Showing the Stop button before the turn has started (it appears with `agent_start`, 0.7 to 1.6 s after a send in the recordings). The palette command and the page's Stop still reach that window when they are invoked; the host handles it.
  - A new setting. The feature is on; Undo is its escape hatch.

## Current State

All OMP facts below were measured on the installed OMP 18.12.2 with a scratch project over `omp --mode rpc-ui` (frames and session files recorded), and the code was read in the installed package (`session/agent-session.ts`, `modes/rpc/rpc-mode.ts`, `rpc-prompt-results.ts`, and `pi-tui` `chat/transcript-entry.ts`). The recordings ran with `--no-tools --no-extensions --no-rules --no-lsp --no-title` and a small model: tool calls, extension commands, titles and the Desk host-control module were not in them (those are covered by the code reading and by the proofs in Rollout and Verification).

**What OMP keeps when a turn is aborted.**

- `abort_and_restore_queue` (Desk's Stop since ADR-0052) calls `AgentSession.abort`, which waits for the agent to be idle, and answers `{steering, followUp}`.
- A prompt takes between about 0.7 and 1.6 s (recorded runs) to reach `agent_start` (memory recall and other setup). An abort in that window **drops the prompt before it reaches the agent**: no frame mentions its text, the file holds no message of it (in two recordings no file existed at all: the model and thinking-level entries live in memory and appear in `get_entries`), and the prompt's own `prompt_result` arrives later with `status: "aborted"`, `agentInvoked: true`. The abort answer can arrive before that `prompt_result` (measured: about 0.5 s earlier) or together with it.
- An abort after `agent_start` leaves, in the file, in order: a `custom` `memory_recall` entry, the **user message**, optionally `custom` bookkeeping (`system-prompt-digest`), an **assistant message with `stopReason: "aborted"`**: empty `content` when no stream had started, a partial text block and `errorMessage: "Interrupted by user"` after text. A thinking-only abort was not recorded (the two thinking recordings ended with empty content); OMP's code keeps whatever blocks streamed. After a fresh session's first reply OMP appends `credential_pin`, and `model_usage` once a reply settled; both are bookkeeping that Desk's reader does not load as chat rows, but the leaf id can name them.
- An abort that arrives after the turn finished by itself is a no-op: `abort_and_restore_queue` still answers success, and the branch ends with an assistant message `stopReason: "stop"` (and bookkeeping). The host must tell this from an interrupted turn.
- A skill invocation (`/skill:name …`) is written as a `custom_message` entry (`customType: "skill-prompt"`, `attribution: "user"`, `details.prompt` holding the typed text), followed by the aborted assistant message; there is no user message. OMP's own `navigateTree` treats such an entry as a user request: the leaf moves to its parent and the draft is the typed invocation (`isUserRequestEntry`, `userTurnDraft`); Desk's navigate command accepts user messages only.
- RPC mode never installs OMP's `setPromptDropped` hook (the terminal UI uses it to put a dropped prompt back into its editor), so a drop is visible only as that `prompt_result`.
- Hidden messages that ride with a user message (`prependMessages`) are written **before** the user message.
- A prompt that OMP answers with `agentInvoked: false` (an extension or builtin command) gets no `prompt_result` at all, and neither does a refused one.

**What Desk does today.**

- `ChatRuntime` handles `omp:chat-abort` through `RpcSession.abortAndRestore`: one `abort_and_restore_queue` per request id, the answer returns the withdrawn queue to the requesting page, which appends it to its draft (`mergeRestoredQueued`).
- `RpcSession` records the `prompt` commands it sends in a ledger entry `{requestId, text, sentAt, unconfirmed}`, removed at the prompt's `prompt_result`. It does not keep images or the branch position, and an entry whose prompt never gets a `prompt_result` stays until the 64-entry cap pushes it out.
- `RpcSession.navigate` is the single in-place move (ADR-0051): `/omp-desk-navigate` through `prompt`, a compare-and-swap on session and leaf, a durable marker, one re-sync through the reconcile serializer, the rewound prompt as a draft, an Undo offer derived from the marker. It refuses while a turn runs, the model is not settled, a prompt's fate is unknown or a live row is not yet reconciled, and fences every mutation while it runs. The move closes an open `/btw` side conversation and quiesces goals (`wrapSessionChange`), as the terminal UI's own navigation does.
- The page shows the Stop button and binds `Esc` only while the turn runs (`working`, set by `agent_start`).
- OMP's terminal UI has the same idea in its own way: `cancelPendingSubmission` restores the text of a submission whose turn has not started, and puts what the user typed since after it.

## Proposed Design

### The rule

Terms.

- The **anchor** is the one `prompt` the host sent to start a turn, recorded in the ledger entry with its request id, text, images, send time and **baseline** (the id of the newest durable entry the host held at that instant, `null` for an empty conversation). It is created only when, at the send, no turn ran (not working, not streaming), the model was settled and not paused on async work, no row was pending, the OMP queue was empty and **no other ledger entry existed** (so there is no second prompt whose fate is open). A prompt sent while a turn runs (steer, follow-up) is never an anchor.
- Only a message that OMP turns into plain user input qualifies: text that does not start with a command or a local-execution sigil (`!`, `$ `); text that starts with `/` followed by a name the catalog does not list (OMP takes it as text); a leading command the catalog lists with source `file` (a markdown command: its expansion is the user message; OMP 18.12.2 has no `prompt` source, and prompt templates fail the text comparison and are kept); and a message that invokes a listed skill (`/skill:name`, at the start or inside the text). Every other listed command (builtin, extension, custom, such as `/retry`, which schedules a turn) can act before it sends anything, so its text is never withdrawn.
- The anchor is **armed** by the acknowledgement of its own `prompt` unless that acknowledgement says `agentInvoked: false`. OMP 18.12.2 acknowledges a prompt that starts the agent *bare* (`{success: true}`, recorded); `agentInvoked` arrives with the `prompt_result`, so only a command OMP ran itself (`agentInvoked: false` in the acknowledgement), a refusal or an unconfirmed send disarms the anchor (it stays in the ledger as before, without images). A `tool_execution_start` and the Stop that takes it disarm it too; a second user message is caught by the Stop's pre-check and by the verdict. An anchor whose prompt never gets a `prompt_result` without having said so (an extension that consumed the text) stays armed until the ledger cap pushes it out: a later Stop then waits the 5 s and keeps silently.
- `elapsed` is the host's clock at the Stop request minus the anchor's send time (one clock, the host's; OMP's timestamps are not used).

A Stop **withdraws** the anchor when all of these hold:

1. **An armed anchor exists** and the request asked for it (`takeBack: true`, so a page of an older build never receives a draft it would drop) and OMP took `abort_and_restore_queue` (a plain `abort` fallback never withdraws: OMP's post-abort drain starts a new turn from a queue that is still there).
2. **The tail since the baseline is the anchor's turn and nothing else.** After the stop has settled and the host has re-read the branch, the baseline must be on the loaded branch (the leaf id can name bookkeeping Desk does not load, so the baseline is the last loaded entry, not the leaf). The loaded entries after it, in order, are:
   - before the request: bookkeeping (`custom`, `model_change`, `thinking_level_change`, anything Desk reads as `unknown`) and messages OMP writes by itself (`custom_message`, `message` with role `custom`, `hookMessage`, `developer`, `fileMention`); the same messages may follow the request, before the answer (`@file` contents, hook and next-turn messages: OMP writes them after the user message), never after the answer;
   - **the request**: exactly one entry. Either a `user` message, or a user-invoked skill invocation (`custom_message`, `customType: "skill-prompt"`, `attribution: "user"`). It is the anchor's if its text equals the anchor's text (trimmed) when the anchor is plain text or a skill message (`details.prompt` for the skill entry), and by position alone when the anchor is a template (OMP stored the expansion);
   - after the request: only bookkeeping (`custom`, `unknown`) and at most one `assistant` message.
   A second request, a tool result, a bash or Python execution, a compaction, a branch summary, a reset boundary, or a model or thinking-level change after the request disqualify.
3. **The Stop interrupted the turn.** The assistant message, if there is one, has `stopReason: "aborted"`. Any other reason means the turn ended by itself (a finished reply, an error): nothing was stopped, nothing is taken back.
4. **Nothing was done.** The assistant message has no tool call, server tool or unknown block. A tool call means the agent started doing something; it may have changed files or run commands, so the message that asked for it stays, whatever the time.
5. **Nothing was said, or it is still fresh.** The assistant message has no non-blank text block **or** `elapsed <= 5 s` (`WITHDRAW_GRACE_MS`). Thinking blocks (`thinking`, `redactedThinking`) and `fallback` markers are neither text nor action and never count: a model that has thought for 40 s without answering has not answered. Text that arrives after 5 s, between the Stop and its effect, keeps the message.

**Dropped before dispatch.** If after the settle only bookkeeping (`custom`, `model_change`, `thinking_level_change`, `unknown`) follows the baseline, and the anchor's own `prompt_result` says `status: "aborted"` with `agentInvoked: true`, OMP dropped the prompt and never wrote it. There is nothing to remove; the typed text and images return from the ledger. No `prompt_result` within the wait, or any other status, is unproven and the message stays silently, as today.

Everything else (no armed anchor, a turn that acted, an answer older than 5 s, a second request, a finished turn, a `completed` or `error` result) is **not eligible**: the Stop is exactly today's Stop, silently. Only an eligible Stop whose action failed (below) says so.

The 5 s is the one number. It is the user's "a few seconds" for the case where the model has already started to write; it never overrides rules 2 to 4. It is a constant with a test, not a setting.

Queued steers and follow-ups do not change the rule. The Stop still withdraws them through `abort_and_restore_queue` as today. A steer OMP delivered before the Stop is a second user message and disqualifies. A queue entry whose text equals a *dropped* anchor's text (the same prompt, queued instead of started) is returned once, not twice. When both come back, the composer receives the withdrawn message first and the queued ones after it (oldest first), in one hand-over, after whatever the composer already holds: the same rule as every Stop hand-back (OMP's terminal UI puts the recovered text before later typing; Desk keeps one rule for all hand-backs and never overwrites).

### The mechanism

`RpcSession.abortAndRestore(requestId, { takeBack })` (exactly once per request id, as today):

1. Before anything is written: take the **anchor** out of its ledger entry (a second Stop with another request id finds none and is today's Stop) and compute `elapsed`. Run the monotone pre-check over what the live model already shows after the baseline (durable rows, pending rows, the streaming assistant message, active tools): a tool call, a second user message, a foreign entry, or non-blank text with `elapsed > 5 s` can only get worse, so the anchor is dropped and the Stop proceeds exactly as today, with no extra wait. This keeps the long-turn Stop as fast as it is. Otherwise raise the **withdrawal fence**: every mutation (a send, a queue edit, a settings write) is refused `busy` until the verdict is out, as during a navigation; the Stop's own commands and the navigation are exempt.
2. Send `abort_and_restore_queue` as today.
3. If an anchor remains: wait (bounded, 5 s of the session's timers) until the anchor's `prompt_result` has been seen (stored per request id in a small bounded record, because the abort answer can come before it or after it), the model is not working, is settled and is not paused on async work; then `#reconcileSettled()`.
4. Decide with the pure `withdrawVerdict` over the loaded branch since the baseline, `elapsed` and the anchor's `prompt_result`: `remove` (with the request entry), `dropped` or `keep`.
5. `remove`: call the existing `RpcSession.navigate` with `kind: "rewind"`, the request entry as target, the current leaf as `expectedLeafId`, `summarize: false` and a fresh request id. It is the same code path as the picker's Rewind: refusals before any write, the session-wide fence while the command runs, the CAS inside OMP, the marker, the re-sync that every page sees as a snapshot. The OMP-side command accepts a user-invoked skill invocation as a target (OMP's own rule); the picker's target list is unchanged. On `done`, the draft is the anchor's **typed text and images from the ledger** (not the stored entry: OMP stores the expanded text of a prompt template or a skill, and normalised images), `unavailableImages: 0`.
6. `dropped`: no navigation; the draft comes from the ledger the same way.
7. A navigation OMP did not answer in time (`unconfirmed`, the fence stays up as it does for Rewind) returns the draft marked `unconfirmed`: the message may or may not be gone, and Undo or the transcript show which. A refusal (`stale`, `busy`, `restart-needed`, `target`, `failed`, `cancelled`) returns `kept`: the message stays, nothing was moved, no draft.
8. Release the withdrawal fence on every path.

The outcome rides the existing answer: `omp:chat-abort` gains `takeBack?: true`; `omp:chat-abort-result` gains `withdrawn?: { text, images?, unavailableImages?, unconfirmed?: true }` (the draft) and `kept?: true`. Both are absent for an ineligible Stop. `ChatRuntime.#answerAbort` applies the size rules it applies to the queue, but never drops the draft: an answer the route cannot carry is resent without the draft's images (counted as unavailable) and then with fewer queued entries; the text is bounded by `MAX_CHAT_TEXT_LENGTH`.

Only the page that pressed Stop receives the draft. Other pages of the conversation see the transcript change through the snapshot the navigation produces, and the Undo bar. An Undo pressed from another page does not clear the refill of the first (the same limit as Rewind's).

### The page

`Composer.stop` sends `takeBack: true` and receives the answer. A withdrawn draft is merged through the restore path that every other hand-back uses (`offerQueuedForEditing` → `mergeRestoredQueued`): placed after what the composer already holds, before the queued messages that came back with it, one undo step, the caret at the end. So:

- an empty composer becomes the message again, with its image chips, `[File #N: name]` blocks, quote lines and command text as they were sent (the draft is the sent text, which Desk composed from the draft in the first place);
- a composer that already holds a new draft keeps it, and the message is appended after it (nothing is overwritten, nothing needs a recovery card);
- a message that could not carry some images says so in the composer's attachment line (the existing sentence).

A notice on the composer notice surface says "Stopped. Your message is back in the composer." The conversation shows the existing "Rewound · Undo" bar for the marker. When the composer was empty before the hand-back, the hand-over held **only** the withdrawn message and the refill is still unedited, **Undo** also clears it (the Rewind rule: `rewoundRef`), so Undo never leaves the message in both places; a non-empty draft is never cleared by Undo, and a refill that carries messages the Stop took out of OMP's queue is never cleared (they would exist nowhere). `unconfirmed` says "Stopped. Your message is back in the composer. OMP did not confirm taking it out of the conversation, so it may still be there." `kept` says "Stopped. OMP could not take the message back out of the conversation, so it stays there." Neither names Rewind or Undo, which a skill invocation cannot use (the picker lists user messages only).

### Races and failure

- **The abort arrives after the turn finished.** The ledger entry is gone, or the assistant stop reason is not `aborted`: not eligible.
- **A second Stop for the same request id** returns the first outcome (the existing memo), and never navigates twice. A Stop with another request id while the first waits finds no anchor.
- **The Stop and a send race.** The withdrawal fence refuses sends as busy until the verdict, then the navigation fence until it ends; in the normal case a few hundred milliseconds. A send that got in before the fence is a second user message or a queued steer, and the rule keeps or hands back accordingly.
- **The window reloaded between the send and the Stop.** A new `RpcSession` has no ledger: no anchor, today's Stop.
- **OMP never answers the navigation.** It ends `unconfirmed` after its own 30 s, with the existing fence; the page gets the draft marked unconfirmed.
- **An OMP started by an older Desk build** has no `omp-desk-navigate` command, or one that refuses a skill invocation as a target: the navigation is refused (`restart-needed` or `target`): `kept`, the transcript is untouched. A *dropped* prompt needs no command and still works.
- **Hidden messages written before the request** stay on the branch after the move, as they do after Rewind. Documented, not changed.

### Where the code goes

- `src/chat/stop-withdraw.ts` (pure, tested): `WITHDRAW_GRACE_MS`, `anchorKind` (which texts qualify), `tailSince`, the monotone `mayWithdraw`, `withdrawVerdict`.
- `src/omp/navigate-command.ts` (+ `src/chat/rewind.ts` helper): the command also accepts a user-invoked skill invocation as a rewind target.
- `src/host/rpc/session.ts`: the ledger entry gains `anchor` (images, baseline, armed); the record of `prompt_result`s by request id; the withdrawal fence; `abortAndRestore` gains the steps above; `AbortRestoreOutcome` gains `withdrawal`.
- `src/host/chat-runtime.ts`, `src/protocol/chat-messages.ts`, `src/webview/lib/chat-client.ts`, `src/webview/components/Composer.tsx` (the abort request, answer and hand-over).
- Documentation: the Chat guide (Stop), the CHANGELOG, `architecture.md` (Stop paragraph), ADR-0082, and an amendment line in ADR-0052.

## Alternatives

- **Time only (the first N seconds).** Cannot tell a model that is still thinking from one that has answered or acted, and removes a visible answer.
- **Output only (no answer, no action).** Misses the user's "right away" when the model has already started to write; the grace window adds only text, never action.
- **Hide the row in the page only.** The model would still see the message: against the requirement.
- **RPC `branch`/`fork`.** A new file and a new conversation identity (rejected for Rewind in ADR-0051 for the same reasons).
- **A new `withdraw` kind of the OMP-side command targeting the baseline.** It would also remove the hidden messages written before the request and would need no change for a skill invocation. It changes the wire, the marker and the Undo vocabulary for a benefit that Rewind itself does not have. Rejected for now; the leftover is documented. Revisit if the hidden-notice gap proves to matter.
- **Wait for OMP's `setPromptDropped` over RPC.** Not available in 18.12.2; the `prompt_result` is the observable evidence.
- **Return the draft from the stored entry** (what manual Rewind does). Loses the typed text of an expanded template or skill and returns resized images; the ledger has the originals.
- **Deliver the removal as a second message after the Stop answer.** It would end "Stopping…" sooner in the rare slow case, but it adds correlation and ordering to a one-shot answer; the fence already covers the window.
- **A recovery card instead of appending when the composer has text.** Nothing is overwritten by an append; the card is for Rewind, which replaces.
- **Show Stop from the send acknowledgement.** Would reach the drop window by button. A UI change for a window of 0.7 to 1.6 s; not part of this work.

## Risks and Open Questions

- **Grace and acted turns.** The user's wording ("within a few seconds ... or as long as the agent has not yet answered or started doing anything") could be read as allowing a tool call inside the few seconds. The rule keeps a hard veto on tool calls: after a tool call the message is part of why files changed or commands ran, and Undo cannot restore files. The words "started doing anything" support it.
- **Leftovers the model can still see.** A hidden notice written before the message (a magic keyword, an attachment note, an image description) and the memory recall chosen from the message stay on the branch after the move, as they do after Rewind. The recall is bookkeeping OMP chose from the message and keeps for the session; it can still shape what the next turn recalls. The message itself is gone from the branch the model reads.
- **A wrong "same message" proof.** The text comparison fails closed: if OMP ever rewrites a plain message before storing it, the message stays and the Stop is today's Stop. The real-OMP proof covers text with file blocks, quote lines and an image.
- **Ledger memory.** The anchor holds a prompt's images until the turn's `prompt_result`, the first tool call, a refusal, or the Stop. The ledger is bounded (64) and an entry never keeps images once disarmed.
- **Wire compatibility.** `omp:chat-abort` and its result gain optional fields, and a page that does not send `takeBack` gets today's Stop.
- **A conversation read through a `get_entries` fallback** may carry fewer rows than the window: the baseline is then not on the branch and the rule says `keep`.
- **Other windows.** A page in another window of the same session sees the shortened branch and the Undo bar, not the draft.

## Rollout and Verification

1. Pure module and its table tests (every clause above: thinking, text beyond and inside the grace, tool call, second request, finished turn, dropped, harness messages before and after the request, a skill invocation, a template, which texts qualify).
2. `RpcSession` with `FakeRpcChannel`: persisted removal (the navigate command goes out as a rewind of the request entry, the model loses the message, the draft is the ledger's, images kept), dropped before dispatch (no navigation), text beyond grace, tool call, second user message, finished turn, a refused and an unconfirmed navigation, queued messages with the withdrawn one first and no duplicate, exactly once per request id, a second Stop that finds no anchor, the plain-`abort` fallback, no `takeBack`, an `agentInvoked: false` prompt that never gets a `prompt_result`, two quick prompts (the second is no anchor), the abort answer before and after the `prompt_result`, the fence refusing a send.
3. `navigate-command` test: a user-invoked skill invocation is a target, an agent-injected one is not.
4. `ChatRuntime`: the answer carries the draft; a route that cannot carry images gets the text.
5. Protocol parse and `ChatClient` tests; page test: an empty composer refilled, a typed draft kept with the message after it, Undo clearing an unedited refill and never a typed draft or a refill that carries queued messages, the `unconfirmed` and `kept` notices.
6. Real OMP, two scripted runs of the host session against a real `omp --mode rpc-ui` with the Desk host-control module, no tools: **dropped** (Stop before `agent_start`) and **persisted** (Stop after the user message's `message_end`); the session file read afterwards shows the active branch without the user message (the aborted turn lives only on the abandoned branch, behind the marker), for a plain message with a file block and an image, and for a skill invocation.
7. An installed proof in an isolated VS Code window with a real session.

## Related Decisions

- [ADR-0051](../decisions/0051-rewind-chat-in-place-through-a-desk-registered-omp-command.md): the mechanism this reuses; [design](2026-10-09-chat-rewind.md).
- [ADR-0052](../decisions/0052-answer-terminal-only-commands-and-restore-the-queue-on-stop.md): Stop and the queue hand-back; amended by a line pointing here.
- [Edit and cancel queued messages](2026-10-07-edit-queued-messages.md): the composer hand-over.
- ADR-0082 records the decision: Stop starts changing the session, on the evidence that an `aborted` prompt result with no run since the acknowledgement means OMP dropped the prompt.

## Architecture Review

- Reviewer: architect, two independent passes
- Outcome: both passes accept with changes. First pass (4 material, 8 should-fix findings) applied above. Second pass (1 material, 11 should-fix): applied: the acknowledgement of a prompt that starts the agent is bare (arming rule corrected after a recorded run), notices that no longer name Rewind or Undo, only open ledger entries block an anchor (an entry for a prompt OMP handled itself or refused no longer does), the request's own companion messages (`@file`) may follow it before the answer, the queue is returned on every failure after the abort succeeded, no `prompt` command source, compaction and maintenance preconditions, a second Stop with another request id is today's Stop (it passes the fence). Accepted as documented limits, not implemented: a Stop before the prompt's own acknowledgement arrives is today's Stop (the anchor is not armed yet); the page's Stop operation ends at `agent_end`, so the composer can look idle for the few hundred milliseconds the host still refuses a send as busy; a prompt followed by another typed prompt that OMP's input gate cancels loses the second as it does today; the anchor waits 5 s and keeps silently when the abort answer is slow; ADR-0051's rewind-target rule is amended by ADR-0082.
- Notes: the mechanism was also proven against a real `omp --mode rpc-ui` 18.12.2 with the Desk host-control module (three scripted runs: persisted message, prompt dropped before dispatch, skill invocation): the request entry left the active branch, the next turn's branch excluded it, the session file kept it only on the abandoned branch.
