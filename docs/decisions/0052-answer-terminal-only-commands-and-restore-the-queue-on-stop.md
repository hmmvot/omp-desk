---
status: accepted
date: 2026-10-09
---

# ADR-0052: Answer terminal-only commands in Chat, restore the queue on Stop, and keep `queue_update` ahead of older state reads

## Context and Problem Statement

Chat is an `omp --mode rpc-ui` child ([ADR-0038](0038-host-chat-over-rpc-ui-on-a-broker-pipe-child.md)). Bringing more of the terminal UI's everyday controls into Chat raised four questions:

1. **Terminal-only slash commands.** OMP's builtin registry mixes commands rpc mode runs (they have a text-mode `handle`) with commands only the TUI implements (`/hotkeys`, `/copy`, `/settings`, `/branch`, and others). Sent over rpc, an unhandled builtin is not run: OMP passes the literal text to the model as a prompt. The set changes between OMP releases.
2. **What Stop does with queued messages.** Plain `abort` leaves the steering and follow-up queues in place, and OMP's post-abort drain immediately starts a new turn on a queued steer, so the message the user wanted to stop runs anyway. The TUI's Escape instead withdraws the queue into the editor. OMP 18.8.5 exposes the same behavior to rpc as `abort_and_restore_queue`.
3. **Which queue readback wins.** The queue dock lists only what OMP reports: `get_state.queuedMessages` and the `queue_update` event. A reproduction against OMP 18.8.5 (a steer during a long `eval`, then `abort`) showed OMP write a `get_state` answer after a `queue_update` that had already emptied the queue, yet still listing the steer. The host folded that answer as authoritative. OMP coalesces `queue_update` against its own last emission, so it never sent another, and the dock kept listing a message the transcript already showed as delivered.
4. **Page-initiated actions that reach OMP or outside the machine.** Compact, model and thinking cycling, HTML export and share are TUI keys or commands. The page is untrusted relative to the host ([ADR-0017](0017-never-forward-capability-bearing-error-text.md) spirit).

## Considered Options

- Terminal-only commands: (a) send everything and let the model see the text; (b) a static Desk list of TUI-only names; (c) read the installed OMP's builtin registry and answer the unhandled ones locally.
- Stop: (a) keep `abort` and let a queued steer run; (b) `abort` then remove queued messages one by one; (c) `abort_and_restore_queue`, returning the withdrawn messages to the composer that pressed Stop; (d) (c), falling back to plain `abort` when the installed OMP does not know the command.
- Queue authority: (a) every `get_state` answer replaces the queue; (b) only `queue_update` drives the queue, ignoring `get_state`; (c) `queue_update` wins over any `get_state` answer to a read sent before it, and a later read is applied; (d) an upstream OMP change carrying a queue revision in both `get_state` and `queue_update` (not available in OMP 18.8.5).
- Page actions: (a) the page sends rpc commands or paths; (b) the page names one of a fixed set of actions, and the host asks for consent and chooses every argument.

## Decision Outcome

**Terminal-only commands: (c).** A staged helper (`media/slash-registry.mjs`) reads the installed OMP package's builtin registry under OMP's own Bun, at most once per minute and once per install root and version. A prompt, steer or follow-up whose leading `/name` resolves (names and aliases) to a builtin without a `handle`, and that no extension advertises under the same name, is never written to OMP. The host answers it in one transcript line, and runs a Desk equivalent where one exists: keyboard shortcuts, Source Control, the Skills and Tools view, provider login, or Models settings. Identity-changing builtins keep their existing deny-list refusal. While the registry is unknown, nothing is classified as terminal-only and text is sent as before. The page result is `explained`, so the route shows no second, generic refusal.

**Stop: (d).** Every Stop path (button, `Esc`, `omp.stopTurn`) sends `abort_and_restore_queue` once per request id. The withdrawn messages (steering, then follow-ups, oldest first, with their images where OMP could carry them) go to the requesting page and are appended to its draft, never sent again. Entries beyond the host's cap of 64 or images it cannot hand back are flagged as truncated or dropped and reported in the composer, never dropped silently. A queued steer therefore never starts a new turn after Stop; this deliberately differs from plain `abort`. A steer that OMP had already delivered before the abort is in the transcript and is not restored. OMP withdraws the queue before it waits for the turn to stop, and the command waits behind any serial command, so its answer is awaited longer than the longest serial command (a manual compaction) instead of the ordinary 30-second command deadline. An OMP that answers `Unknown command: abort_and_restore_queue` (before 18.8.5) gets a plain `abort`: the turn stops, and its queue stays in OMP, where the dock keeps listing it and OMP may still run it.

**Queue authority: (c).** The host counts `queue_update` frames. Every command records the count when it is written. When a `get_state` answer arrives, and a `queue_update` was folded after that read was sent, the answer's queue fields (`queuedMessages`, `queuedMessageCount`) are replaced by the queue the model already holds, and the rest of the state is applied. A read sent after the last `queue_update` is OMP's newest statement and is applied whole. OMP also does not emit `queue_update` for every delivery of a steer it took into a streaming response (agent-core `appendMessage` drops a live-steered entry without a queue notification). So when the transcript records a user message while the dock lists anything, the host reads the state back. The dock therefore never keeps a message already shown in the transcript, lists each message once, and loses none: a read or event still reports every message OMP holds. This rests on an invariant of OMP 18.8.5: every addition to a queue emits `queue_update` synchronously, and only removals can happen without one. An OMP that adds queued messages silently would break the rule, and (d) would then be the fix.

**Page actions: (b).** The page may send only `omp:chat-command` with one of `compact`, `cycle-model`, `cycle-thinking`, `export-html` or `share`, and no arguments. The host requires a live conversation and the existing writer election, and refuses a passive editor. Compact asks for optional instructions in an InputBox. Export asks for the file in a save dialog. Share asks in a modal confirmation that names what is uploaded. Cycling is one explicit keypress or Alt+click, as in the TUI.

### Consequences

- Positive: typed TUI commands never become accidental model prompts, and the classification follows the installed OMP without a Desk release.
- Positive: Stop matches the TUI's Escape. The user decides what to do with withdrawn input instead of watching it run.
- Positive: the dock converges on OMP's real queue even when OMP's answer and event order disagree.
- Negative: the registry read starts one Bun process per OMP install change. A failed read clears the previous install's list, so only the classification is disabled (logged), and that install is not read again until it changes or the extension restarts.
- Negative: withdrawing the queue needs OMP 18.8.5 or newer. With an older OMP, Stop still stops the turn, but a queued steer may run afterwards, as with plain `abort`.
- Negative: an abort that never answers (a wedged child) keeps the Stop request pending for up to the compaction deadline plus two minutes; past that the page is told the outcome is unconfirmed, and messages OMP withdrew by then are not recovered.
- Negative: a `get_state` answer whose queue really is newer than an earlier, still-unfolded `queue_update` keeps the event's value until the next read or event. The user-message readback bounds that window.

## Related Documents

[Edit and cancel queued messages](../designs/2026-10-07-edit-queued-messages.md), [ADR-0038](0038-host-chat-over-rpc-ui-on-a-broker-pipe-child.md), [ADR-0050](0050-retain-uncertain-input-and-confirm-exact-file-restart.md), [ADR-0051](0051-rewind-chat-in-place-through-a-desk-registered-omp-command.md), and [architecture](../architecture.md).

## Architecture Review

Independent review (reviewer subagent, 2026-10-09) against the OMP 18.8.5 source and a recorded RPC trace of the stuck-steer reproduction: accept with changes. It confirmed the queue-authority rule, the terminal-only classification and the guest parser routing. Its findings were applied: the abort answer is no longer subject to the 30-second command deadline; an OMP without the command falls back to plain `abort` instead of a generic refusal; entries and images cut at the host's caps are flagged; a failed registry read clears the previous install's list and is not retried for the same install; and the OMP invariant behind queue authority and the upstream option are recorded.
