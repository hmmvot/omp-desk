---
status: accepted
date: 2026-10-19
---

# Chat shows what OMP's terminal UI shows of the session: failures, the goal, the modes and the question's details

## Problem

OMP's terminal UI prints an extension's failure in the transcript, keeps the goal, fast mode and the usage-limit stage in its status line, and shows an `ask` option's preview and a countdown to the question's time limit. Chat consumed the frames and fields that carry these (OMP 18.11.1 `rpc-mode.ts:1654`, `rpc-frame.ts:277-299`, `get_state` at `rpc-mode.ts:2029-2068`, `AskOption.preview`/`timeout` in `wire/frames.ts`) and dropped them: `toChatEventFrame` is an allow-list, `parseStateData` kept none of the new fields, `normalizeAskRequest` kept an option's `description` only. A plugin that throws, an event OMP could not send and a goal that eats a token budget were invisible, and a reply whose `message_end` was lost stayed on screen as the live one.

## Goals and Non-goals

- Goals: an `extension_error` is a transcript notice like the terminal UI's line; an `rpc_frame_error` is a notice naming the dropped frame type plus a log line, and a drop that leaves the model behind the session is made up from the file; the footer shows the goal (with its budget), fast mode, slow mode and the usage-limit stage; an `ask` option's preview and the question's time limit are shown; `prompt_result.error` is kept for whoever renders a failed prompt.
- Non-goals: a live tokens-per-second figure (see below); a countdown for `select`, `confirm` and `input` dialogs; the per-reply usage strip and the provider-error row (another package); `/btw` and live voice frames; `config_warnings_changed` and the advisor events, which carry no payload.

## Current State

`session.ts` special-cases a navigation's own `extension_error` (Desk's `/rewind` and `/clear` report refusals through a thrown command, `NAVIGATE_ERROR_PATH`/`CLEAR_ERROR_PATH`) and sends every other frame through `toChatEventFrame`, which returned `null` for `extension_error` and `rpc_frame_error`. `get_state` is parsed into `ChatLiteState` (model, thinking level, queue, context usage). `goal_updated` already becomes a transcript row, and `model.goal` carries the raw goal for snapshots, with no reader.

## Proposed Design

**Notices.** `src/protocol/frame-notices.ts` turns `extension_error` into `Extension "<path>" error (<event>): <text>` and `rpc_frame_error` into `OMP dropped a "<type>" event: <reason>`, both as `notice` frames with a fixed `source` heading (`Extension error`, `Frame dropped`). The text is stripped of control sequences and bounded (path 200, event 64, error 1,000 characters). The page draws these two sources as plain text, so a path with underscores or an error with markup is shown as written. The two Desk command paths return `null` exactly as before, whether or not a navigation is in flight. The model says an identical notice of these sources once in a row.

**Dropped frames.** OMP shortens an oversized `agent_end` instead of dropping it. Under the negotiated protocol 2 (the only one Chat runs on) OMP reassembles a frame up to 64 MiB; only a frame above that ceiling, or one that is not a record, becomes `rpc_frame_error`, and an oversized `response` returns as a failed response instead. `RpcSession#onDroppedFrame` logs a warning, applies the notice and, for the types in a short list (`agent_start`/`agent_end`, `turn_*`, `message_start`/`message_end`, `tool_execution_start`/`tool_execution_end`, `auto_compaction_end`, `queue_update`), requests the same disk reconcile an `agent_end` asks for. The two frames whose state lives outside the file get the follow-up their normal arm has: a lost `auto_compaction_end` clears a pass still marked `working` (otherwise the Chat would refuse prompts and show "compacting" for good) and reads `get_state`; a lost `queue_update` reads `get_state`. A lost `message_end` first turns the last streamed snapshot into the pending row the frame would have made (`finalizeDroppedStream`, the `message_end` reducer path), so the half-finished reply is neither shown as live nor duplicated when the file read lands, and the session publishes one authoritative snapshot. The streamed snapshot's `stopReason` is provisional, so that path leaves `lastAgentOutcome` as it was. A lost `tool_execution_end` leaves the tool listed as running until the turn's `agent_end` clears it; the file read shows its result.

**State.** `ChatLiteState` gains `goal`, `fastMode`, `slowMode` and `usageLimit`, parsed by `src/chat/host-signals.ts` (shared by the host parser and the page parser: the host normalises and omits a malformed field, the page re-validates strictly and rejects the state). The goal follows OMP's goal segment: shown while goal mode is on (`GoalModeState.enabled`) or the goal is paused, not for a dropped goal or goal mode off. It is seeded by `get_state` at attach and after each refresh, and `goal_updated` rewrites `state.goal` from the event's own `state`. Fast and slow mode and the usage limit have no event; they are as current as the last `get_state` (attach, `session_settled`, after commands and compaction). `HostSignalChips` draws them beside the pickers: `Goal 12.3k/50k`, `Fast`, `Slow` (hidden while the usage limit is the low-priority stage, whose label already says it), and the usage-limit label in OMP's words (`formatUsageLimitLabel`).

**Ask.** `ChatUiOption.preview` and the request's `timeoutMs` are kept (preview 20,000 characters per option and 128 KiB per dialog, the rest of the options show without one; timeout up to 24 hours, positive integers). The host stamps `expiresAt = now + timeoutMs` when the frame arrives; the page shows `min(timeoutMs, expiresAt − now)` so a skewed clock cannot overstate it. The preview of the highlighted option (pointer, keyboard focus; the recommended option, else the first, until one is chosen) is drawn as Markdown under the list. OMP answers and sends `cancel` at zero; the page changes nothing at zero.

**Prompt errors.** `prompt_result.error` (`message`, `provider`, `model`, `httpStatus`, `retryable`) is parsed, bounded and kept in `lastPromptResult.error` on host and page. It adds nothing of its own to the transcript: the failed reply already carries the message, and the provider-error row of the reply-metadata package can read provider, model, status and retryability from `lastPromptResult` while the page stays attached (a reload loses it; the snapshot does not carry it).

## Alternatives

- **A new frame type for a dropped message end** that the page reduces itself: rejected for a host-side finalize plus one snapshot, because the case is rare and a new frame needs a page parser and a reducer branch on both sides for no extra behaviour.
- **A tokens-per-second chip.** `get_state.tokensPerSecond` is one sample computed at read time from the last assistant message (`token-rate.ts`); Desk reads state on discrete events (attach, settle, commands, compaction), never per token, so the chip would show a stale figure and repeat what the per-reply row shows. Not parsed.
- **Markdown for the extension error text.** Rejected: an extension path with `_` would be emphasised and its text could carry formatting the extension did not mean.
- **A countdown for every dialog.** `select`, `confirm` and `input` default to a cancellation on timeout, not an answer; the surprise is the ask's automatic answer. Left out.
- **The goal chip from `goal_updated` alone.** There is no event at attach, so a session that already had a goal would show none until it changed.

## Risks and Open Questions

- A goal change that lands between a `get_state` request and its answer can be overwritten by the older answer until the next refresh; goals change rarely and the next refresh corrects it.
- `expiresAt` is stamped on arrival; a question replayed after a reconnect is stamped again, so its countdown can show more time than OMP has left. OMP's `cancel` still closes the card on time.
- The reconcile after a dropped frame is bounded by the existing reconcile attempts; if the file does not yet hold the entry, the pending row shows as *not yet saved* by the existing rule.
- Frames from older OMP builds without these fields leave every chip hidden.

## Rollout and Verification

One change: parsers, model, host session, page parser, components, styles, guide, changelog and the `docs/README.md` map. Verified by unit tests for the parsers, the model and the session against the fake channel (extension error, both Desk command paths, dropped `message_end`, `message_update`, `auto_compaction_end` and `queue_update`, seeded and updated goal, ask with preview and timeout, prompt error), by a page test in headless Chromium for the chips, the preview, the countdown and the plain-text notices, and by `npm run typecheck`.

## Related Decisions

None.

## Architecture Review

- Reviewer: reviewer (independent agent)
- Outcome: accepted with changes
- Notes: no material issue; three should-fix findings (dropped `auto_compaction_end` wedging the compacting state, provisional `lastAgentOutcome` after a dropped `message_end`, protocol-2 wording of when a frame becomes `rpc_frame_error`) and five nits were applied to the design and code.
