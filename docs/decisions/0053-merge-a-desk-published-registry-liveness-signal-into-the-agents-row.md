---
status: accepted
date: 2026-10-09
---

# ADR-0053: Merge a Desk-published registry liveness signal into the Chat Agents row

## Context and Problem Statement

The Chat Agents row, pinned above the composer, and its detail tabs must show every subagent that is actually working. Until now they showed only OMP's RPC roster: `get_subagents` on attach, then `subagent_lifecycle` and `subagent_progress` frames.

### Where OMP 18.8.5 loses a resumed subagent

Paths below are under `@oh-my-pi/pi-coding-agent/src` unless another package is named.

- **The receipt hides the path.** `IrcBus.#deliver` (`irc/bus.ts:97-186`) hands a message for a live subagent to `session.deliverIrcMessage`, which returns `"injected"` or `"woken"` (:171-173). `irc/messaging.ts:93-95` prints "Delivered to X." for both.
- **The steer starts no monitor.** `IrcBridge.deliver` (`session/irc-bridge.ts:176-240`) reads `host.isStreaming()`, which is `agent.state.isStreaming || #promptInFlightCount > 0` (`session/agent-session.ts:6015-6017`). That is also true while a finished run is still unwinding.
  - If the session is streaming, a parent's message is steered into the running loop and the call returns `"injected"` (:208-227).
  - `attachIrcWakeTurnMonitor` (`task/executor.ts:3083-3182`) runs only on the `"woken"` path, so no `subagent_lifecycle started` is emitted.
- **The skipped observer.** On the woken path, `#startTurnObservation` returns without calling the observer while an earlier observation's turn is still open (`session/agent-session.ts:1371-1373`). The prompt still runs, without a monitor.
- **The registry stays idle.**
  - `finalizeSubagentLifecycle` forces the registry ref to `idle` without checking `isStreaming` (`task/executor.ts:3423-3433`); `markResultAccepted` does check (`registry/agent-registry.ts:239`).
  - The ending loop picks the late steer up and continues in the same run (`pi-agent-core/src/agent-loop.ts:1797-1802`). It emits no new `agent_start`, so the ref stays `idle` (`registry/agent-registry.ts:341-346`).
- **The RPC roster never reads the registry.** `RpcSubagentRegistry` (`modes/rpc/rpc-subagents.ts:118-127, 202-260`, built at `modes/rpc/rpc-mode.ts:1412`) builds `get_subagents` and its frames only from executor monitor frames, and drops progress for unknown ids (:236).
  - OMP documents the gap at `modes/interactive-mode.ts:1361-1363`: "the observer registry only hears task-executor lifecycles".
  - Its TUI badge reads the registry instead, but counts only `kind === "sub" && status === "running"` (`pi-tui` `running-subagent-badge.ts`). It therefore misses the steered resume too.

### The observed failure

In an owned demo project, the parent's `write agent://<id>` returned "Delivered". The subagent then ran `sleep 45` for 45 s. Throughout, `get_subagents` returned `[]` and no `subagent_lifecycle` frame arrived. The registry ref read `idle` with `session.isStreaming === true`, and the Agents row was empty.

OMP Desk passes OMP's RPC roster through as it receives it, so it inherits the gap. Desk had one gap of its own: host-control's `hasLiveSubagents` counted `running` and idle-with-queued refs, but not a resumed idle ref. Desk cannot wait for an upstream fix. It already loads its own OMP module into every Chat child (`src/omp/host-control.ts`, `-e`), and that module already reads `AgentRegistry.global()`.

## Considered Options

- **Keep the RPC roster only.** This adds no new source, but the row stays wrong whenever the gap is hit, and an ordinary user flow hits it.
- **Extend the host-control `subagentWork` poll to return the live list.** That 3 s poll already runs for every verified Chat child. However:
  - the row would lag by up to 3 s;
  - verified host control is optional (an unverified launch still has a working RPC stream);
  - ADR-0003 and ADR-0006 scope that pipe to read-only native-state answers, not Chat roster content.
- **Read subagent session files from the host.** This is a second reader that infers liveness from file growth. It cannot tell a steered turn from a finished one, and it races the writer.
- **Publish a liveness signal from the Desk OMP module on the session's own RPC stream (chosen).** The module observes the registry and each subagent binding's run events. It writes a bounded publication with `ctx.ui.setStatus`, which OMP's RPC mode forwards as a fire-and-forget `extension_ui_request` (`modes/rpc/rpc-mode.ts:1492-1500`). It is event-driven and needs no new process, channel or upstream change.

## Decision Outcome

Chosen: **a Desk-published registry liveness signal, merged into the RPC roster by the host and the page.**

### Liveness derivation

One function, `subagentLiveState` (`src/omp/agent-liveness.ts`), classifies a registry ref against what the process's subagent bindings observed. Host-control's `subagentWork` answer and native settle state use the same function (`hasLiveSubagents` → `isLiveSubagentRef`). The notification and the row therefore share one derivation. They may differ briefly, because they sample through different channels at different times.

A `kind: "sub"` ref is:

- `running` when its status is `running`, unless its result was accepted and its session no longer streams (the registry's own "stale accepted run");
- `idle`-live when its status is `idle` and either:
  - messages are queued for it; or
  - its session streams **and** its own binding observed `agent_start`, `turn_start` or `tool_execution_start` after `lifecycle.terminalAt`, the time it left `running`. This is the steered resume. A finished run that is merely unwinding also streams, but starts no new work, so it does not count.
- not live otherwise. Parked, aborted, advisor and main refs never count.

This rule is a Desk heuristic. It is not parity with OMP's TUI, which counts only `running`.

### Publisher (OMP side)

- **Observing bindings.** `registerAgentLiveness` runs in every binding of the module. OMP rebinds `-e` factories to each subagent session, and `ctx.agent` names the binding's agent (`extensibility/extensions/types.ts:466-483`). Each subagent binding records, in a `globalThis` store shared by the process's bindings:
  - when it last saw its own session start a run, a turn or a tool (`workAt`);
  - the latest tool name and intent.

  It then nudges the publisher.
- **Activity resets.** A registry `status_changed` that leaves `running` clears the stored tool and intent, so a resumed run never shows the finished run's activity. A settled `agent_end` keeps only `workAt`.
- **Who publishes.** Only the first binding whose `session_start` context has `mode === "rpc"` (`modes/rpc/rpc-mode.ts:1621`) and `agent.kind === "main"` creates the publisher. The native TUI, print and json modes, and subagent bindings never publish, so no status text appears in a terminal.
- **Recomputation.** The publisher subscribes to `AgentRegistry.global().onChange`. Each registry event or binding edge schedules one coalesced recomputation: 150 ms, or 1 s for an activity-only change. It publishes only when the set changed, including any agent's `state`, so the `running` → `idle` edge at finalisation always republishes.
- **Timers.** They exist only while needed:
  - a 2 s re-check while any agent is `idle`-live, because OMP emits no registry event when that streaming ends;
  - a 2 s retry after a failed publication, even for an empty set;
  - a 10 s repeat of a non-empty set.

  Nothing is scheduled while no subagent is live.
- **Publication format.** A publication is `{v: 1, instance, seq, sessionId, agents}`:
  - `instance` is random per publisher;
  - `seq` is monotonic and consumed only by a successful write;
  - `sessionId` is the main session manager's id at publication time;
  - `agents` holds at most 32 entries, each `{id, agent, state: "running" | "idle", sessionFile?, tool?, intent?}`.

  `id` and `sessionFile` with control characters are refused. Other text is bounded and stripped of control characters.
- **Size bound.** Encoded text is at most 16 KiB. An oversized set sheds detail deterministically: intents, then tools, then session files, then trailing entries in registry order. It never skips the publication.
- **Write.** The publication is written with `ctx.ui.setStatus("omp-desk.agent-liveness", text)`.

### Host and page (Desk side)

- **Identity guard.** `RpcSession` intercepts that status key before the status line. `AgentLivenessGuard` accepts a publication only when:
  - its `sessionId` equals the session the host bound;
  - its `seq` is newer than the last accepted one of the same `instance`. A new instance, from a restarted process, starts a new sequence.

  Everything else is dropped, and the text never reaches the status line.
- **Frame.** An accepted publication becomes the Chat frame `agents_liveness`. The shared reducer applies it on the host and, after forwarding, on the page.
- **Merge** (`reduceAgentLiveness` and `reduceAgentFrame`, `src/chat/agents.ts`):
  - **RPC rows stay authoritative.** A published id that already has an RPC row keeps that row; only its `liveState` is annotated. No agent appears twice, and a publication never removes an RPC row.
  - **Registry rows.** A published id without a row becomes a `running` row with `origin: "registry"`. It carries the published activity and the type, description and assignment remembered from the spawn. A registry row that the next accepted publication omits is removed.
  - **OMP frames win.** Any later RPC frame for the id takes the row over. A terminal lifecycle frame removes the row, with one exception: if the newest publication already reported the agent `idle`-live, OMP's run ended while a resumed one goes on, so the row becomes a registry row. Stdout frames are totally ordered, because `setStatus` and the roster share rpc-mode's `output`. Either arrival order therefore converges: a publication reporting `idle` after the terminal frame re-adds the row.
  - **Snapshots and resync.** A `get_subagents` snapshot replaces only OMP's rows. A resync's phase reset clears all rows. The guard then re-applies its newest accepted list, unless the attach reported a truncated replay, in which case it waits for the next publication.
- **Consumers.** Detail tabs, the collapsed summary and the child-transcript allow-list see the merged roster. OMP may still refuse a transcript for an agent its RPC roster never saw (`modes/rpc/rpc-subagents.ts:262-268`).

### Invariants

- At most one publisher writes to a given stdout at a time. The last instance wins.
- The signal is trusted at the RPC stream's trust level; any in-process extension could write the key. Its effect is limited to Agents-row display and the child-transcript allow-list.
- RPC subagent ids and registry ids share one namespace, because the spawn tree shares the root observability bus.

### Guarantees and failure modes

- Rows are bounded at 32 registry rows. Every registry row is removed by the next accepted publication that omits it, or by a terminal RPC frame unless the agent was reported `idle`-live.
- A resumed agent appears within about 150 ms to 1 s of its first observed turn or tool. It disappears within about 2 s of its session ceasing to stream.
- Remaining failure modes:
  - A subagent without a Desk binding cannot show a resumed run (isolated worktree runs get none: `task/isolation-runner.ts:461-462`). It falls back to the RPC-only behaviour; a running one appears without a tool and with at most the registry's activity gist.
  - After a truncated replay, or on a first attach (publications replayed before the host binds its session are dropped), registry rows are absent until the next accepted publication: at most 10 s while anything is live, or the next edge.
  - If OMP left `isStreaming` true after a resumed run, the row and `subagentWork` would persist as long as that state lasts. This is [INFERENCE]: not observed on 18.8.5.
  - Changes to `ctx.ui.setStatus` forwarding, `ctx.agent`, extension rebinding, or `AgentRegistry` `list`/`onChange` and the ref fields read (`status`, `session.isStreaming`, `session.queuedMessageCount`, `lifecycle.acceptedAt`/`terminalAt`) degrade to the RPC-only roster. A ref without a numeric `terminalAt` is never `idle`-live by the streaming rule (fail closed).

### Consequences

- Positive:
  - A steered or unobserved subagent appears as running with its current tool and intent, and disappears when it stops.
  - The notification path and the row share one derivation, and `hasLiveSubagents` now counts the resumed agent.
  - Nothing new is opened: no channel, pipe, process or file reader.
- Negative:
  - There is a second roster source. It is bounded and identity-guarded, and OMP's roster wins every conflict it can see.
  - Publications enter the broker's replay ring, which holds 2048 lines or 4 MiB (ADR-0038). A publication is due on every membership edge (150 ms) and every tool start of any live subagent (1 s), so a process publishes about once a second during subagent work, plus one every 10 s while any subagent is live. These lines are evictable, but they compete for ring capacity.
  - A registry row has no native elapsed time or progress counters, and the row shows none rather than an estimate.
  - Native Terminal mode is unchanged: it has no RPC stream to carry the signal.

### Retirement

- The publisher and merge exist only for an OMP gap. Retire them once OMP's RPC roster reports resumed subagents itself:
  - either by deriving `get_subagents` and lifecycle frames from `AgentRegistry` `status_changed`;
  - or by emitting `subagent_lifecycle started` (or a state frame) and resetting the ref to `running` when a steer resumes a finished subagent.
- Until then, the 2 s `idle`-live re-check stays. It is the only way Desk learns that a resumed run ended. It is to be retired with the publisher, or earlier only once the publisher can no longer derive `idle`-live from a resumed run, i.e. OMP resets the ref to `running` when a steer resumes a finished subagent and back to `idle` with a `status_changed` when that run ends. Started or terminal RPC frames alone do not qualify: while the ref stays `idle`, removing the re-check would leave a finished resumed agent shown as running for up to the 10 s repeat.
- The upstream issue is drafted but not filed yet.

## Related Documents

- [Tool-style TODO and Agents rows with detail tabs](../designs/2026-10-06-todo-agents-rows.md), [Native transcript, AGENTS and TODO parity](../designs/2026-10-01-tui-parity-transcript.md).
- [ADR-0038](0038-host-chat-over-rpc-ui-on-a-broker-pipe-child.md) (RPC chat and the replay ring).
- [ADR-0003](0003-native-host-control-pipe.md) and [ADR-0006](0006-host-generated-key-peer-verified-pipe.md): the `-e` module and its pipe. The pipe is unchanged; ADR-0003 carries a narrow amendment note for this.
- [ADR-0051](0051-rewind-chat-in-place-through-a-desk-registered-omp-command.md): the same module's RPC-mode command.

## Architecture Review

- Reviewer: architect
- Outcome: round 1 accept-with-changes; round 2 accept-with-changes, minor findings only, "can be accepted once N1–N3 are addressed".
- Notes: round 2 found every round-1 finding resolved. Its minor findings were applied after the review and were not re-reviewed:
  - N1: the tighter early-retirement condition above;
  - N2: a converted registry row drops the finished run's RPC activity;
  - N3: a missing `terminalAt` fails closed;
  - N4–N6: the citation path, the truncated and first-attach wording, and the no-binding wording.

  Round 1 asked for the following, all addressed above:
  - the state on the wire, and terminal-frame conversion for either arrival order;
  - the work-after-`terminalAt` discriminator in place of bare `idle` and streaming;
  - accurate guarantees, deterministic overflow shedding and failure retry;
  - re-applying the list after a resync;
  - corrected wording for the rejected alternative and for TUI parity;
  - the trace moved into this ADR;
  - the ADR-0003 note, the stated invariants and the retirement criterion.
