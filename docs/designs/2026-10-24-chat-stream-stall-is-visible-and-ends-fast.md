---
status: proposed
date: 2026-10-24
---

# A stalled broker-to-host stream is visible, ends within seconds, and a prompt that reached OMP is not sent twice

## Problem

A long Chat session (a 44.6 MB session file) stopped showing replies. OMP received the prompts and answered them, but the stream from the detached broker to the extension host stalled for about two minutes. The host gave up on two prompts after its 30 s command deadline (`DEFAULT_COMMAND_TIMEOUT_MS`) and reported them as unconfirmed ("may not have been delivered"); the user sent them again. Then the broker closed the consumer with `the consumer fell behind the retained lines and must reattach` (`RpcSubscriber.takeNext`, ring of 2048 lines / 4 MiB), the host reattached, and the answers appeared. The host log had no line about the stall, the close or the reattach, and the same close was found in the logs of four brokers before. Nothing in the log could say what had held the stream up.

## Goals and Non-goals

- Goals:
  1. Every close by the broker and every reattach is in the host log with its reason, the last sequence number, the lines replayed and the duration; a link that delivers nothing while the child is alive is logged within seconds with its measurements and is shown to the page as a reconnecting notice that clears when frames resume.
  2. A prompt whose answer did not arrive is looked up in the session file before it is called unconfirmed; found, it is delivered and the transcript is shown from the file until the stream recovers, so the user does not send it again.
  3. A consumer that cannot drain its socket is closed by the broker after about 10 s, with its own reason, instead of waiting for the ring to evict its cursor; the check of pending rows saved on another branch reads the session file, not the whole transcript, for a large session. (The user also asked for a rebuild from the file after such a close and after `unknown_since`. Review showed that a reattach already reads only the entries after its cursor, and that `unknown_since` is the one case where the file is known to disagree with the process, so neither was changed; see Current State.)
  4. Per-frame processing time and bytes per second are measured in the frame pumps on both sides, so the next occurrence names its trigger.
- Non-goals: changing the ring size or the pace bound; changing the command deadline; changing what a frame is; a new transport; making a large `get_entries` smaller on OMP's side.

## Current State

- `RpcLineRing` keeps 2048 lines / 4 MiB; each consumer has one cursor (`RpcSubscriber`) that sends replay and live lines in order and stops at `RPC_PACE_BYTES` (2 MiB) of unflushed socket data, resuming on the socket's `drain` event. A cursor that falls behind eviction is closed with the fell-behind reason. A consumer paced for a long time was left alone until the ring evicted its cursor, minutes later on a quiet session.
- The host's watchdog (`#lastActivityAt`) fires on 90 s of silence; any frame, including the frames of a large answer, resets it.
- A command deadline passes a send to the page as `unconfirmed`; `#lostPromptCheck` looks only at the stream.
- A reattach and a reload read `get_entries { since: cursor }` after painting the file's tail, so they ask for the entries after the file's last one, not the transcript. A full `get_entries` (tens of MiB of `rpc_chunk` lines for the incident's file, through the cursor that carries prompt responses) comes from `unknown_since` (the process refused the cursor), from a deferred full read, and from `#dropPendingSavedElsewhere`, which runs when a ring replay leaves pending rows in a session with branches.
- The host logs nothing when the broker closes the connection (`RpcHandle.closeChannel` only publishes the event), nothing when the reattach starts or finishes, and no traffic figures.

## Cause

**Not proven.** Two candidates fit what was logged, and the new measurement is meant to settle which:

1. The host's own full `get_entries` (`unknown_since`, or `#dropPendingSavedElsewhere`) queued a chunk train of tens of MiB in the single per-consumer cursor ahead of the prompt responses. Frames flow, so the watchdog never fires, the responses wait behind the train, the 30 s deadline passes, and a later burst evicts the cursor from the ring. This is consistent with the log (responses missing while OMP answered, the close only minutes later) and with a 44.6 MB file. It is inferred from the code and the symptom, not observed.
2. A write-queue stall in the broker's socket (`writableLength` staying high although the kernel took the bytes, or a missed `drain`). The logged `fell behind` close can only be raised by `takeNext`, which the pump reaches only while the queue is below the pace bound, and every ring line pumps every consumer, so a pump that "never resumes" does not fit the incident as logged; this candidate survives only as a queue that stays high, or as a host that was not reading, which is candidate 1's consumer side. The measurement separates them: the host's busy time and unread bytes against the broker's unflushed bytes at the close, and `missedDrains` (the queue found empty with no drain reported since the pace began, counted apart from a queue merely partly flushed).

A test reproduced neither: a real broker with a stuck reader closes the consumer as paced (see Verification), which shows that the stall is bounded now, not which cause it had.

## Proposed Design

### Broker (`src/broker/rpc-ring.ts`, `src/broker/pty-broker.ts`)

- `RpcSubscriber` records when a pump stopped at the pace bound (`pacedAt`) and clears it when a pump goes below the bound. `enforcePace(limitMs)` is called by a timer while any consumer is paced: a consumer whose queue is below the bound is pumped (a resumed drain that never came, counted), one that has stood at the bound for `limitMs` is closed with `RPC_PACED_REASON` and the kind `paced`. The timer runs only while someone is paced; its period is a quarter of the limit, between 50 ms and 1 s.
- The limit is `RPC_PACED_CLOSE_MS` = 10 s, taken from `--rpc-paced-close-ms` (200 ms to 10 min) so a test can use a short one. It is a broker launch argument like the other `--rpc-*` options; an older broker has no such option and keeps its behaviour.
- The other forced close, a cursor evicted from the ring, keeps its reason and now has the kind `fell-behind`.
- `RpcSink.close(reason, forced)` records `lastForcedClose = { reason, atMs }` in the broker. The next `rpc-attached` answer carries `lastForcedClose: { reason: "fell-behind" | "paced", ageMs }` when the broker has closed a consumer, so the host that reattaches knows why it was closed even though the wire carries no reason: the transport ends the connection and the handle sees only "the peer closed the connection".
- Measurement: `RpcSubscriber.stats` counts lines, bytes, pumps, busy time and the slowest pump, pace stops and resumes without drain. The broker logs one summary line per consumer at close (`rpc consumer summary: …`) and, while a consumer stays paced, one line per timer tick (`rpc consumer paced N ms: …`). Every pump is timed with `performance.now()`; there is no allocation in the pump beyond a counter increment.

### Wire contract (amends ADR-0038 §1; no protocol version bump)

- `rpc-attached.lastForcedClose?: { reason: "fell-behind" | "paced"; ageMs: number }` is an additive optional field. `parsePtyFrame` ignores a missing field, a reason it does not know and a non-numeric age (the attach still works). An older broker sends none; a newer broker with an older host is harmless: the older parser copies only the fields it knows.
- `PtyLaunchSpec.rpcPacedCloseMs` becomes `--rpc-paced-close-ms` on the broker's command line. It is not part of the broker's identity, so a running older broker is not replaced.

### Host transport (`src/host/pty-ipc.ts`, `src/host/rpc-handle.ts`, `src/protocol/rpc.ts`)

- Each connection keeps a read-side meter: frames, characters, reads, busy time (parse plus listeners), the slowest read and frame, the time of the last frame, and the socket's `bytesRead`, `readableLength` and pending write bytes. `PtyConnection.traffic()` and `RpcChannel.traffic()` return a snapshot; a test double may omit them.
- `closed` events carry the transport's detail text; `attach` returns `lastForcedClose` from the frame.

### Host session (`src/host/rpc/session.ts`)

1. **Visibility.** At Info: `the broker connection closed: <detail>; last seq N, M lines since the attach; <traffic>`, `reattach started: last seq N`, `reattached: replay from seq … (the broker holds … to …; …); the broker closed a consumer as paced (its socket did not drain) 2 s earlier`, `reattach finished in N ms after K attempts: last seq A to B, L lines received, phase live`, `reattach failed …`. Traffic is one line: frames, characters, busy time, slowest read and frame, time since the last frame, kernel bytes read, bytes waiting in the socket, bytes waiting to be sent.
2. **Stall monitor.** A 1 s timer (armed with the watchdog) compares the time since the last frame with the age of the oldest pending command (a slash prompt, a command with its own timeout and any wait while a dialog is open are exempt; `sentAt` restarts when a dialog settles). Three cases, none of which replaces a connection: (a) a command has waited 5 s and frames still arrive: one Info line per command, `the answer to X has not come for N ms, but frames are still arriving` (candidate 1); (b) a command has waited 5 s and nothing arrives: one Info line per stall with the link's traffic, a `get_state` probe (its own 15 s deadline; an unanswered one logs a warning and nothing else, because OMP answers it from its serial command queue and a probe it holds is not proof of a dead link; the existing watchdog replaces a connection that stays silent), and `linkStalled` for the page, cleared with `frames resumed after N ms` when any frame arrives; (c) OMP is working and sends nothing for 5 s with no dialog open: one Info line per silence, no probe and no notice, because a long tool is normal. `link_stalled` is a host-owned frame (`ChatEventFrame`), carried in the snapshot head only while set, shown in the banner of a live conversation (it replaces a read-only reason's text while it lasts; a failure outranks it).
3. **A prompt whose answer did not come.** When a `prompt` send times out as `unconfirmed`, the host refreshes its history reader and looks for a user message with the same text and a timestamp at or after the send (less 1 s). Found, the send resolves as `accepted` and the ledger entry is no longer unconfirmed; while the link is stalled and the window is live the transcript is applied from the file and re-read every 2 s so the reply shows without the stream, and frames resuming stop that (during a reattach nothing is applied: the delta read that follows brings the row, and an older read must not move the cursor back; legacy-id files are not applied). Not found, the send stays `unconfirmed` as before. OMP writes the user message before it answers, so a message on disk was delivered whatever the link did to its response. The match is by text and time because a user message entry in the files read here holds only role, content and timestamp, no request id. `steer` and `follow_up` sends have no ledger entry and are not covered: OMP writes them when it delivers them. A message of the same text sent twice within a second can be matched by the first copy. All reads that refresh the history reader go through one queue (`#serialDisk`) so two refreshes never index the same bytes twice.

4. **Large sessions.** `#dropPendingSavedElsewhere` (the check that pending rows were saved on another branch) no longer sends a full `get_entries` for a session file of 8 MiB or more (`largeSessionBytes`; a full answer is 8 MiB of chunk lines, four times the pace bound and twice the ring): it asks the history reader for the newest 400 entries off the active path (`recentOffPath`). A reattach, with or without a close by the broker, is unchanged: it reads only the entries after its cursor. `unknown_since` stays with the process, the authority on the cursor it refused.
5. **Measurement at Debug.** While frames arrive the monitor logs one `traffic: …` line every 5 s at Debug (the cumulative counters above, so a rate is the difference of two lines); the Info lines above carry the same counters at the moments that matter.

### Page and docs

`linkStalled` joins the snapshot head and the banner. The troubleshooting guide lists the new log lines and what each means; the changelog has one Fixed entry.

## Alternatives

- **Split prompt responses from the bulk lane.** A second cursor for responses removes candidate 1 at its root but changes the ring's contract (ADR-0038 §1 and the design's retention rules) and every consumer; not justified before the measurement says which candidate happened. The file-served large-session read removes the biggest producer of bulk lines from the same cursor.
- **Raise the ring or the pace bound.** Delays the fall-behind and keeps the stall; the symptom is a missing reply for minutes, not an eviction.
- **Close on `RPC_PACE_BYTES` at once.** A slow but live consumer would be dropped on every large replay; the 10 s stand at the bound is the point where a drain would have come.
- **Probe with a new command instead of `get_state`.** `get_state` is answered by OMP on every protocol and the host already treats it as a liveness read; no new command is needed, and the probe has its own 15 s deadline.
- **Match the prompt in the file by request id.** The entry carries none in the files read here. Text and time are what the file has.
- **Reload on a stall without a probe.** A transient hold-up of a second or two would reset a working connection.

## Risks and Open Questions

- **Cause open** (see Cause). The host's busy time and unread bytes, the broker's unflushed bytes and `missedDrains`, and the `frames are still arriving` line separate the candidates in the next log.
- A host event loop blocked for more than 10 s (another extension, a debugger pause) now makes the broker close the consumer; the close is lossless while the ring retains the lines and the reattach is cheap.
- `lastForcedClose` is broker-wide and not cleared: a reattach of another window within the age shown can log a close that was not its own. The log line says "a consumer" and gives the age, and nothing acts on it.
- The probe is `get_state`, which waits in OMP's serial command queue; a link probe that does not (the broker's `status` round trip) is the better instrument and is left for a later change if the monitor's lines show a need.
- A message sent twice with the same text inside the 5 s window can be matched by the first copy: the second is reported delivered although only one reached the file. The ledger entry's `sentAt` bounds the window; a prompt sent twice in 5 s with identical text is the user's own duplicate.
- Reading a 44 MB file in the host for `recentOffPath` / `snapshot` costs an indexed refresh, not a full parse; the history reader already indexes by line offsets. The off-path read is bounded at 400 entries.
- `linkStalled` is a new snapshot field: an older page ignores it, an older host sends none. Both parsers tolerate the other.
- A broker that is older than this build keeps its old close behaviour (no paced close, no `lastForcedClose`); the host-side visibility and the file-served paths work with it.

## Rollout and Verification

One change: broker (ring, options, attach field), host transport meter, session behaviour, protocol and page banner, docs. Unit tests: ring (paced limit, restart on drain, resume without drain, kind of a fell-behind close, pump statistics); broker argument bounds; `rpc-attached` field parsing; the transport meter; the history reader's `indexedBytes` and `recentOffPath`; the session with a fake channel and clock (close and reattach lines, the starved-command log and probe, the quiet-session line, a dialog, link-stalled banner on and off, file-confirmed prompt, later reply followed from the file, no full read after a paced close or after `unknown_since`); chat model, parser and banner. A real-broker test (`src/host/rpc-handle.test.ts`; it needs the built `out/pty/pty-broker.js`, and `--rpc-paced-close-ms` is a test seam, production always uses 10 s): a consumer that stops reading is closed as paced after the shortened limit, the next attach reports `lastForcedClose.reason = "paced"`, and the reattached window receives the lines after its cursor. The host-side recovery from that close is the fake-channel session test above: the real-broker test stops at the handle because the stand-in child does not speak the chat protocol.

## Related Decisions

- [ADR-0038](../decisions/0038-host-chat-over-rpc-ui-on-a-broker-pipe-child.md) (§1 ring and pacing; amended here by the paced close and `lastForcedClose`).
- [Page heartbeat](2026-10-23-page-heartbeat.md) (same diagnostic approach for the page).

## Architecture Review

- Reviewer: architect
- Outcome: first pass accept with changes (4 material, 8 should-fix, 10 nit findings; `local://stall-review.md` of the session that wrote this note). Applied in the text and code: M2 (the quiet path is one line per silence, exempt while a dialog is open, no probe), M3 (`unknown_since` stays with the process), M4 (candidate 2 rewritten, `missedDrains` counted only for an empty queue with no drain reported), S1 (the timer's resume goes through the broker's own pump path), S2 (no rebuild block on reattach), S3 (applied only while stalled and live, legacy skipped, 1 s window), N10. Applied differently: M1 (the dead exemption table is gone; an unanswered probe only warns and never replaces the connection, instead of the broker `status` probe the review recommended). Not applied, left for the reviewer's confirmation pass: S4 (serialise inside `HistoryReader`), S5 (per-consumer attribution), S6 (typed `byClient`), S7/S8 record updates (`docs/architecture.md` §136 and §182, an ADR-0050 note), N1-N9. Status stays `proposed` until a confirmation pass.
