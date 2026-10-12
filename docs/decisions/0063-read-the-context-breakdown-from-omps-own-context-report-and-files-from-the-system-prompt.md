---
status: accepted
date: 2026-10-12
---

# ADR-0063: Read the context breakdown from OMP's own `/context` report only on the user's request, and the context files from the system prompt in `get_state`

## Context and Problem Statement

The Context view ([design](../designs/2026-10-12-context-view.md)) must show what fills a running session's context window and which context files OMP put into its prompt, without inventing numbers. Installed OMP 18.8.5 computes the category breakdown (system prompt, tools, system context, skills, messages, auto-compact buffer, free) in `AgentSession.getContextBreakdown`/`computeContextBreakdown`, but exports it nowhere structured: no RPC command, no `get_state` or `get_session_stats` field, no extension API (`ctx.getContextUsage()` carries tokens, window and percent only), and nothing on Desk's host-control pipe. Its only external surface is the builtin `/context`, which in RPC mode answers with one `command_output` text report. The context files are in `get_state.systemPrompt` (the rendered prompt) only as text. The question is how Desk obtains the breakdown and the files, and whether it may run the report without the user asking.

## Considered Options

- **Run `/context` automatically in the background** (every visible refresh): the numbers stay current, but `/context` is a prompt, that is a write-class command. Extension input handlers run before builtin dispatch, so a handler can rewrite it into a model turn or run side effects; the `command_output` frame carries no request id, so a silent capture is a prefix guess that can be mis-attributed across a timeout, a second reader or a maintenance pass; a swallowed report is also missing from the transcript that a reload would replay. Rejected by architecture review.
- **Run `/context` once, on an explicit user request, through the normal prompt path, and leave the frame in the Chat** (chosen).
- **Staged Bun worker calling `computeSessionContextBreakdown`** (ADR-0061's approach): structured, but computed from a fresh session-less settings load, not from the running session's tools, skills and messages.
- **Extend the host-control `-e` module and pipe** with a context message: amends ADR-0003/0006/0009 for a display feature; the module has no breakdown API either.
- **Estimate locally** (tokenizer, characters): numbers OMP does not provide.
- **Show only RPC-structured numbers** (usage, stats) and omit the categories: honest, but drops the part of the request that matters most.

## Decision Outcome

1. **Automatic reads are read-only and structured.** While the Context view is visible, `RpcSession.readContext()` sends only `get_state` (auto-compaction flag, the system prompt), `get_session_stats` and scans the session file (spend, compaction and `reset_boundary` entries). It never sends a `prompt`, and writes nothing to the session or the conversation.
2. **The category breakdown is OMP's `/context` report, read only on the user's explicit request** (the view's Read Breakdown action). `RpcSession.requestContextReport()` sends `prompt "/context"` with an internal id, exactly as typing it would, and takes the text of the one `command_output` frame that is a report (known report prefix) while the request waits. It does **not** consume the frame: the report renders in the Chat as the notice any command output is and replays like one, so nothing is hidden. The request is an operation retained from admission to its result, bound to the native epoch, session file, id and input-claim generation it started under; while it exists every other mutation (a second request, `maintain()`, rewind, clear, prompts) is refused as busy, held model and thinking choices wait for its end, and it is refused itself while a user message awaits OMP's acknowledgement, a turn, async pause, compaction, pass, rewind, clear or reconnect is in flight or when the command catalogue lacks an entry named `context` with source `builtin`. If the session or the claim moved on while it waited it returns a refusal and sends no abort. The report is the first one observed while the request waits (OMP's output has no request id), with its time and usage figure sampled when it arrived. If the acknowledgement does not say `agentInvoked:false` the text did not run as a command (an input hook rewrote it): the started turn is aborted and the request is refused. A pure `parseContextReport` turns the text into rows; labels are kept as OMP prints them, unknown lines are shown verbatim, a text without a known prefix is not a report, and the share of a row is computed from OMP's own token figure and window. No other source supplies a category number.
3. **The report is a dated snapshot.** The view labels it `as of <time>`, adds `; usage has changed since` when the live token figure differs from the figure the Chat state showed when the report arrived (a comparison the report cannot support exactly; no cause is claimed), and never refreshes or rewrites it by itself.
4. **Context files = `<file path>` blocks of the `<repo-rules>` section and `- path` lines of `<dir-context>` in `get_state.systemPrompt`**, parsed strictly (absolute Windows paths, bounded counts and sizes), described as paths extracted from the rendered prompt and not an authenticated list of loaded files (prompt text can carry the same markers), with the content length in characters and no token count. The state parser keeps the prompt blocks as bounded strings used only by this read.
5. **History = the session file.** The `readJournalCost` loop is extended to count `compaction` and `reset_boundary` entries and keep the latest of each; it is labelled with its scope (every branch, abandoned ones included) and the clear boundary is not presented as a completed clear. Shake leaves no record and is shown only as a pass this window saw.
6. **Read policy:** only while the view is visible, event-driven from the session's own outputs, never on a timer, never during a turn, a compaction or a maintenance pass, and a read is discarded whole when a turn began or the identity changed while it ran; the live header (usage, model, maintenance) comes from the `model.state` the Chat popover reads and needs no I/O.
7. **Boundaries kept:** no change to OMP, to `-e`, to the host-control protocol, to ADR-0052's rendering of ordinary `command_output`, or to Terminal mode (no context shown). Compact and Shake from the view reuse `runChatAction` for the viewed tab.

### Consequences

- Positive: every number is OMP's own; the view agrees with the footer popover and with the TUI's `/context`; no new protocol surface; failures degrade per group; the automatic reads leave transcript, session file and model untouched; the one write-class command is user-initiated, visible in the conversation and reload-stable.
- Negative: the breakdown is not automatic (one click and one notice in the Chat per reading) and can be stale, which the view says; dependence on the wording of a human report (mitigated by verbatim fallback and a contract test against the installed OMP); context files are derived from prompt text and can be mis-split by a file that contains OMP's block markers; the journal scan is O(file size) per deep read; Terminal sessions show nothing.

## Related Documents

[Context view](../designs/2026-10-12-context-view.md). Relies on [ADR-0038](0038-host-chat-over-rpc-ui-on-a-broker-pipe-child.md) (`RpcSession` and the internal-id command path) and [ADR-0052](0052-answer-terminal-only-commands-and-restore-the-queue-on-stop.md) (Chat quick actions); leaves [ADR-0003](0003-native-host-control-pipe.md) unchanged.

## Architecture Review

- Reviewer: architect
- Outcome: accepted after four rounds; the last returned no material findings.
- Notes: round 1 rejected the automatic background `/context` (the basis of the first version of this ADR); rounds 2 and 3 required the request to be a fenced operation (lifetime, user-input admission, input-claim generation, held choices) and the controller to fence results by attachment and revision rather than object identity.
