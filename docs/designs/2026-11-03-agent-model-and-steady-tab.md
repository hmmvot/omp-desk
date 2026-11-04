---
status: accepted
date: 2026-11-03
---

# The agent's model and thinking level in the Agents row and its tab, and an agent tab that stays still

## Problem

Two reports from the maintainer (2026-10-09, re-checked 2026-10-19):

1. The model a subagent runs on, and its thinking level, are shown on the agent's card in the transcript (the route in `resolvedModelRoute`) but nowhere else: not in the Agents row of the HUD above the composer and not in the agent's own tab.
2. The tab of a running agent "blinks every few seconds, sometimes does not update, is sometimes empty and looks crooked".

## Goals and Non-goals

- Goals: the model and thinking level in the HUD Agents row, in the roster row of the Agents tab and in the title of an agent's tab, compact, with the whole text in a tooltip; an agent tab that changes nothing between two real updates, keeps its rows through a reconnect of the parent and does not lose the last words of an agent that stops.
- Non-goals: a new RPC command or host message (the data is already in the roster the page holds); changing how the host opens or titles detail tabs; changing the transcript card's route label; showing a model before OMP has sent the agent's first progress frame (the `started` lifecycle snapshot of `get_subagents` carries no progress; OMP's executor sets the fields during spawn setup, so a spawn-time label would need a change in OMP, not a guess in Desk).

## Current State

Data. OMP 18.13.3 reports a subagent's progress through `get_subagents` and `subagent_progress` frames. `progress.resolvedModelIdentity` (`provider/id` including routing), `progress.resolvedModel` (the selector, with a `:<level>` suffix), `progress.resolvedThinkingLevel` and `progress.resolvedModelIsFallback` are assigned by the executor during spawn setup (`src/task/executor.ts`) and re-derived on every session event, so they follow routing changes; Desk receives none of them before the first progress frame, because the `started` lifecycle snapshot of `get_subagents` copies `progress` from a registry entry that has none yet (`src/modes/rpc/rpc-subagents.ts`). Desk's `RunningAgent.progress` is an opaque record that passes these fields through unchanged, so the host needs no change (`src/host/detail-tabs.ts` opens `omp.detail` tabs that share the Chat page's snapshot and add no host command).

Tab. Measured with the e2e mock (a real OMP running the `task` tool, a subagent that works for 40 s) against the released build, the open tab of a working agent mutated its toolbar every 2 s: the periodic refresh set the Refresh button `disabled` and the body `aria-busy` for the duration of every read, 20 attribute mutations in 20 s with nothing new to show. Reading the code found three more causes of the other symptoms:

- a read's result always produced a new page object, so the body rendered again on every poll;
- a refresh that found a read in flight was dropped, including the final read after the agent stopped, so the last rows could be missing;
- while the parent reconnected (`starting`, `attaching`, `resyncing`) the body was replaced by a "Loading child history…" note, and the status read "no longer in the native registry" while the roster was merely being loaded again; both were "empty"/"wrong" states shown to a user who had been looking at history.

## Proposed Design

Model label. `agentModelLabel(progress)` in `src/chat/hud-summary.ts` (pure, tested) takes `resolvedModelIdentity` or, failing that, `resolvedModel` without a `:<level>` suffix that repeats `resolvedThinkingLevel`, bounds each text to 200 characters, and returns the chip text `model · level` (the model alone when no level is reported) and a tooltip (`Model: …`, `Thinking: …`, and `Served by fallback routing` when `resolvedModelIsFallback`). `null` until the progress carries a model, and then no chip is drawn (no placeholder). `agentRow` carries it as `AgentRow.model`.

Three places show it, all with the same chip: the HUD Agents row (`.omp-hud-model`, it shares the row's free width with the activity, both truncate with an ellipsis; the row tooltip gains the same lines), the roster row of the Agents tab and the title of an agent's tab (`.omp-detail-model`).

Steady tab. `ChildTranscriptBody` distinguishes three kinds of read:

- `user` (open, Refresh, Load earlier): busy state, disabled button and failure note, as before;
- `tick` (the timer, a return of the tab to visible): a background read. It shows nothing while it runs, changes nothing unless rows changed, and when it fails keeps the rows and the note as they are (only a user request or the final read says why a read failed). A tick that finds a read in flight is dropped, because the next one follows within two seconds;
- `final` (the read after the agent stops): never dropped. It has its own queue slot: if a read is in flight it runs when that read settles, after a user request queued meanwhile (a queued user request is replaced by a newer one; it never replaces the final read). The one exception is the timer's own rule: nothing background runs while the user is reading earlier history (Load earlier), so the final read is skipped then and Refresh brings the latest rows.

`appendChildPage` keeps the page's `entries` array when a read brought no row, and the body skips `setPage` when the page is the same, so a quiet read renders nothing. The body is a `memo` component so a parent snapshot change that does not touch the agent does not render it. A tab that was hidden catches up on `visibilitychange` instead of waiting for the next tick.

Settling. `AgentDetail` treats a reconnect and the reload of the roster (`agentAvailability: loading`) as one state, `settling`: the last status stays on screen, a body that was rendered outside a reconnect (`bodyShown`: the body is mounted, whether or not its first read has succeeded) stays mounted and its timer reads fail quietly and keep the rows, and only a tab that never rendered a body says "Loading child history…" (a tab whose very first read failed shows the read's own unavailable note instead, as before the change). "no longer in the native registry" is claimed only for a live, loaded roster that lacks the agent.

Layout. The model chip has `min-width: 0` and truncates; the assignment disclosure padding in the agent header is aligned with the other header lines.

Layout amendment (2026-11-04). The tab's page is the Chat page's layout, not a block of its own: `ChildTranscriptBody` takes `standalone` and runs its `Transcript` at depth 0 (the Chat's scroll controller that opens at and follows the tail, row windowing, Find; a child inside one of its calls still counts the tab as one level), the history of a running child has the `live` phase so its newest turn shows no reply footer, and the Refresh button is portalled into the header's first line. The transcript is the only scroller; the header, the Assignment disclosure (a tool row) and the notes take the transcript's own gutter (`--omp-detail-inset`), and the header reserves the scrollbar's width. The steady-tab rules above are unchanged: the header host is held in state, so the memoised body renders when it appears once and never for a header change, and the tests that watch the body's DOM also watch the relocated toolbar.

## Alternatives

- Poll `get_subagents` from the host and push the label: duplicates the roster the page already holds and adds a protocol message for a derived string.
- Show the thinking level only: the maintainer asked for the model first, and the level without it is ambiguous when routing changes it.
- Stop the timer while the page is hidden: kept as a catch-up on `visibilitychange` instead; a hidden webview already throttles timers, and the user's own Refresh stays available.
- Replace the periodic read by OMP's `subagent_progress` frames alone: the frames carry progress, not the child transcript, which has to be read from the child's file.

## Risks and Open Questions

- The fields are OMP-internal and verified for 18.13.3 only; a different name yields no chip (`null`), never an error, and the tests pin the field names.
- `resolvedThinkingLevel` was absent for the e2e mock's non-reasoning model (the chip showed the model alone); a reasoning model with a configured level shows `model · level`. The level's absence is not interpreted.
- A `final` read queued behind a slow in-flight read waits for it; `readSubagent` times out after 15 s, so the wait is bounded.

## Rollout and Verification

- `src/chat/hud-summary.test.ts`: the label from each field combination, the suffix rule, the bound and the fallback note.
- `src/webview/todo-agents-ui.test.ts` (Chromium): model rows and tabs, a long id truncating with its whole text in the tooltip, DOM node identity and a mutation observer showing no attribute or text change between background reads that bring nothing, a failed timer read that leaves the note alone, a reconnect that keeps the history and the last status, a final read that is not lost behind a read in flight or behind a Refresh the user queued meanwhile. `src/webview/chat-ui.test.ts` pins the chip in the existing HUD fixture.
- `test/e2e/scenarios/55-chat-subagent-tab.spec.ts`: a real OMP on the mock model spawns a subagent (`[agent:<name>]`, see `test/e2e/fixtures/mock-openai-server.ts`) that works for 40 s; the HUD row and the tab name `mock/mock-reasoner · high`, and over 20 s the tab's header, toolbar and rows keep their nodes with no attribute or child mutation on them; after the agent stops the tab shows its last words.

## Related Decisions

[Tool-style TODO and Agents rows with detail tabs](2026-10-06-todo-agents-rows.md) (the rows and tabs this extends). No ADR: no contract, protocol or dependency changes.

## Architecture Review

- Reviewer: independent `reviewer` agent (read-only), one pass over this document and the implementation.
- Outcome: accept with changes. Applied: the claim about when OMP knows the model (it is assigned at spawn setup; only the first frame reaches Desk) corrected here and in the user guide; the failure note of a background read gated to user and final reads; the final read given its own queue slot so a user request queued behind a read can no longer replace it, and a newer queued user request replaces an older one; `bodyShown` described as what it is; the document added to the index and the rollout list completed. The final read is still skipped while the user reads earlier history (the timer's own rule, now written down).
- Notes: the reviewer found no stale-closure or lost-`inFlight` race in the read machinery and confirmed the `settling` logic cannot hide "agent gone" indefinitely (the roster read is bounded by the RPC timeout).
