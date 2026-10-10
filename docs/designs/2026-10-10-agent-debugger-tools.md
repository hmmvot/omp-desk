---
status: accepted
date: 2026-10-10
---

# Agent debugger tools over VS Code's debug API

## Problem

The user wants an agent skill that takes a bug, finds the suspect code, reproduces the bug under a breakpoint and then hands the paused program to the user. The agent today has no access to the debugger the user sees in VS Code. OMP has its own DAP client (`debug` tool), but it would own the only connection to the program, so the user could not take over in VS Code's Run and Debug UI, and Microsoft's Unity adapter (`vstuc`) may only be run inside VS Code under its license.

## Goals and Non-goals

- Goals:
  - The agent of a Chat session can list debug configurations and sessions, set and remove its own breakpoints, start a named configuration or a Desk attach preset, wait for a stop, read threads, stack, scopes and variables, evaluate an expression when the user allows it, step or continue, and hand the paused session to the user.
  - Everything goes through VS Code's own debug sessions, so the user sees the same breakpoints, stack and paused state in Run and Debug and can take over at any time.
  - The transport is adapter-agnostic; which operations work depends on the adapter's capabilities, and an unsupported operation returns a clear result. Only a replaceable layer knows about Unity.
  - The host tool channel is reusable for later VS Code capabilities; each later capability still needs its own design and permissions.
- Non-goals:
  - Starting the reproduction itself (Play Mode, scenes, input). That belongs to the skill and the user's Unity tooling.
  - Subagents (`task`) and terminal `omp`: installed OMP 18.8.5 passes RPC host tools only to the main session (`task/executor.ts` receives only eval-defined `customTools`).
  - Terminal-mode (native PTY) sessions: they are not RPC sessions.
  - Arbitrary inline launch configurations, `setVariable`, editing `launch.json`, removing the user's breakpoints, fetching source by `sourceReference`.
  - A sandbox. Named configurations can run programs and tasks and save files; the agent can also edit the workspace. The permissions below are consent prompts, not isolation.

## Current State

- Installed OMP 18.8.5: `set_host_tools { tools }` (name, label, description, JSON-Schema `parameters`, `hidden`, `loadMode`) answered with `{ toolNames }`; `host_tool_call { id, toolCallId, toolName, arguments }`, `host_tool_cancel { id, targetId }` from OMP; `host_tool_update { id, partialResult }`, `host_tool_result { id, result, isError? }` from the host (`modes/rpc/rpc-types.ts:67, 437, 770-810`). One bridge lives for the whole RPC process (`rpc-mode.ts:1408`); registration replaces its adapters (`2131-2135`) and the active set before the next model call (`session/session-tools.ts:2251-2300`); a call already running keeps its adapter. OMP removes a pending call and rejects it at once on abort, sends `host_tool_cancel`, and ignores a later result for an absent id (`modes/rpc/host-tools.ts:99-158`). No timeout. Adapters are `concurrency: "shared"`, with no approval field. The bridge and its tools survive same-process `new_session`, `switch_session` and tree navigation (`session/agent-session.ts:9674-9779, 11194-11382, 12187-12193`).
- In Desk, OMP's RPC client is the detached `managed-rpc` broker: reloading or closing a window does not disconnect OMP (`src/broker/pty-broker.ts:8-12`). Every authenticated `rpc-attach` gets a subscriber; only `rpc-write` checks input ownership (`pty-broker.ts:1026-1077`). `RpcHandle` attaches even when its input claim is refused and records `inputOwned` (`src/host/rpc-handle.ts:92-95, 251-263`); `RpcChannel` does not expose it (`src/host/rpc/protocol.ts:65-78`).
- The ring pins unanswered waiting `extension_ui_request` dialogs, releases them on the host's response or OMP's cancel, and reports a soft `pinnedOverflow` (`src/broker/rpc-ring.ts:95-96, 151-154, 319-342`; `src/broker/rpc-child.ts:214-220`). Pins replay only when their `seq` is after the attach cursor (`rpc-ring.ts:235-263`). Surviving brokers are content-staged copies of the build that started them.
- `RpcSession` attaches, dispatches lines as they arrive, then verifies identity in `#resync` (`src/host/rpc/session.ts:1283-1350, 1411-1477`); Desk refuses identity-changing Chat operations and treats a changed session file or id as divergence (`1369-1376`).
- The Chat page renders unknown tools with a generic card (`src/webview/components/tool-renderers.tsx:656-689`). No `vscode.debug` usage exists in `src`.

## Proposed Design

### 1. Host tool channel

**Registry.** A host-side registry of Desk tools: name, label, description, parameter schema, `loadMode`, and `execute(args, context)`, where `context` carries an abort signal, `update(partial)`, and `checkExecutor()` (below). Results are text content plus an error flag.

**Broker capability and retention.** A new broker advertises `hostToolRetention` in `rpc-attached`. Its ring pins a `host_tool_call` that has a string `id` until either a `host_tool_result` with that `id` is written to OMP's stdin or OMP emits `host_tool_cancel` with that `targetId`. Malformed calls are not pinned. Thresholds are soft, like the dialog budget: 32 calls or 1 MiB; beyond them the ring keeps pinning and reports `hostCallOverflow` in the attach answer, which the host logs. With an older broker (no capability) the host registers no Desk tools, ordinary Chat keeps working, and the Chat shows once that a session started by an earlier Desk build must be restarted to use debugger tools. Desk never restarts a managed child for this.

**Executor gate.** Only an `RpcSession` that (a) has finished `#resync` with a verified session identity, (b) holds broker input on its current connection and (c) has not diverged may execute host calls. Ownership is live: `RpcHandle` consumes every authenticated input-owner event the broker broadcasts (takeover, release, disconnect; `src/broker/pty-broker.ts:864-867, 1114-1135`), compares the owner with its own frontend id, clears ownership on connection close, disconnect, disposal and every `input-not-owner`/`no-input-owner` refusal, and notifies `RpcSession` at once; `RpcChannel` exposes the current value and a change event. Each admission records the connection generation and owner generation it ran under. A read-only subscriber neither executes nor answers. `checkExecutor()` re-checks (a)-(c), the same owner generation, and cancellation; tools call it right before every side effect, after every user confirmation, and when a serialized action leaves its queue. Losing the gate aborts running calls and stops queued ones; nothing admitted under a lost owner generation starts again. Each of them still gets a terminal error result in the outbox (below), delivered once the gate holds again.

**Call states.** Per `RpcSession`, keyed by host call id: `buffered`, `queued`, `running`, `completed` (result not yet accepted by the broker), `delivered`, `cancelled`. Calls and cancels that arrive before `#resync` completes are buffered; buffered cancels are applied first, so a cancelled call is never started. After resync:
- a buffered call whose `seq` is at or before the first attach's `latestSeq`, and a call first seen in the replay of a reconnect within the same `RpcSession`, are answered with an error without execution: "This request was received from an earlier attachment; Desk did not execute or re-execute it.";
- every other call is executed.

There are two kinds of cancellation. **OMP's cancel** (`host_tool_cancel` with a known `targetId`) is terminal and needs no answer: it aborts a running call's signal, marks a buffered or queued call cancelled so it never starts, stops progress updates and retires an undelivered result. **Local cancellation** (gate loss, disabling the tools, a window shutting down) leaves OMP still waiting, so every such call gets exactly one terminal error result, kept in the outbox until delivered, cancelled by OMP or the child exits. When a DAP request had already been sent, the result says its effect is unknown rather than claiming it was undone. In short: every admitted call not cancelled by OMP produces exactly one result, even one that never left its queue. A known call seen again in a replay is ignored. A completed result is re-sent under the same id after each reconnect, once the gate holds, until `writeLine` resolves; a duplicate is harmless because OMP ignores results for absent ids. Undelivered results are never evicted: they leave the outbox only when accepted, cancelled by OMP, or when the child exits; above 32 outstanding results the host logs a soft-threshold warning. A bounded cache of 256 delivered ids only serves deduplication. Nothing is ever re-run.

**Registration.** `#resync` sends `set_host_tools` and requires a successful response whose `toolNames` contains the expected names before the tools are treated as available and the session is published as live. A rejected registration makes the debugger unavailable for that session and leaves ordinary Chat working; a timeout leaves availability unknown and every host call is refused until a later registration succeeds. Settings changes re-send it on the live session, serialized and coalesced. Every execution also checks the current settings, so a call selected before a settings change is refused if the tools were disabled. Disabling aborts running calls. Registration is per OMP process, not per conversation; Desk keeps its refusal of identity-changing Chat operations, and on divergence the gate fences execution. A same-file rewind keeps the registration and does not undo or replay debugger effects.

**Without a window.** While no window holds the session, OMP keeps waiting on a pending call. There is no Desk route for Esc then; reopening the session (the call is answered with the error above), or stopping the session ends the wait. Closing only the Chat editor keeps the `RpcSession` and does not affect calls.

### 2. Debug coordinator (window lifetime)

Registered at extension activation:
- a `DebugAdapterTracker` factory for `*` and `onDidStartDebugSession`/`onDidTerminateDebugSession`, building a registry keyed by debug session id: name, type, folder, parent, origin (started by Desk for conversation X, or by the user), state (`running`, `transitioning`, `stopped { reason, threadId, generation }`, `unknown`, `terminated`). A tracker exists only for sessions that start after activation;
- sessions that existed before activation (seen through `activeDebugSession`/`onDidChangeActiveDebugSession` without an installed tracker) are listed as "untracked: debugger state is not available in this extension-host lifetime" and every operation that needs stop state on them is refused. The list is not claimed to be complete. Desk never restarts a user's debugger;
- each `stopped`/`continued`/`terminated` event and each execution-changing control Desk dispatches advances the session's generation. A dispatched `continue`/`step`/`pause` marks the session `transitioning`, so a cached stop cannot satisfy a new wait. For `continue` and steps the transition ends on the first of: a newer `stopped` or `terminated` event; the adapter's successful response (seen by the tracker), which means running, because DAP does not require a `continued` event after them; a failed response, which restores the previous state; a timeout, which leaves the state `unknown` until the next event. A `pause` response is only an acknowledgement: the transition ends on `stopped`, `terminated`, a failed response or the timeout. User actions are observed through tracker messages as far as they are visible; reads are not atomic against them;
- every read captures the session id and generation when it starts and checks both again after each awaited adapter reply; a reply from an older generation is rejected ("the program ran since; read the stack again"), never relabelled. Frame and variable references returned to the agent carry their generation, and using an older one fails the same way;
- per debug session, mutating actions (`control`, `evaluate`, breakpoint changes) are serialized; launches go through a window-level launch coordinator, because no session id exists before a start; reads are not serialized;
- adapter requests time out after 10 s; inspection is bounded by total requests and bytes as well as returned text; a timeout or cancel does not undo a request already sent, and nothing is retried automatically.

**Control grant.** A conversation (session file id) may mutate a tracked debug session only if that conversation started it through `vscode_debug_start`. Sessions the user started, sessions of other conversations and untracked sessions are read-only to the agent; there is no adoption in this version. `vscode_debug_handoff` revokes the grant terminally for that debug session, and the conversation's breakpoints pass to the user: they stay in VS Code but leave the conversation's ownership, so the agent can no longer remove or change them. Every queued action re-checks the grant before dispatch.

### 3. Debug tools

Prefixed `vscode_debug_` (OMP has its own `debug` tool), `loadMode: "discoverable"`. Every operation on a session takes an explicit debug session id; none falls back to `activeDebugSession`, and `stopDebugging` always gets a session.

| Tool | Behavior |
|---|---|
| `vscode_debug_configs` | Named configurations per workspace folder (compounds marked unsupported), Desk presets available here, and current debug sessions with origin and state |
| `vscode_debug_breakpoints` | `list` (user's and this conversation's), `add` (file, line, condition, positive integer `hitCount`, logMessage), `remove`, `clear` for this conversation's breakpoints. `hitCount` is converted to a decimal hit condition; arbitrary hit-condition text is not accepted. Breakpoints are window-wide in VS Code, so they apply to every debug session. States per debug session: requested, verified, unverified with the adapter's message (from `getDebugProtocolBreakpoint` and tracker `breakpoint` events). Unverified is not an error: an adapter may verify later, for example when Unity loads the assembly |
| `vscode_debug_start` | Start a named configuration (folder + name) or a Desk preset through the launch coordinator: a fresh per-attempt marker property is added, `debug.startDebugging` is called, and sessions carrying the marker are awaited for a bounded time. Outcomes: started (with session ids and a grant); VS Code refused (`false` or an error); VS Code reported success but no session carrying the marker appeared ("session not identified", no grant); outcome unknown (timeout). No fallback to the active session and no retry. Compounds are refused |
| `vscode_debug_wait` | Wait for a stop or termination of one session, with timeout (default 600 s, max 3600 s), progress updates and cancel. Returns at once if the session is already stopped at a generation newer than the one the agent passes |
| `vscode_debug_inspect` | `threads`, `stack`, `scopes`, `variables` (depth and count limits), `evaluate` (policy below). Frames without a local path show their name and say the source is not available |
| `vscode_debug_control` | `continue`, `next`, `stepIn`, `stepOut`, `pause` through VS Code's own debug commands (`workbench.action.debug.continue`, `stepOver`, `stepInto`, `stepOut`, `pause`) with an explicit `{ sessionId, threadId }` context, so VS Code's Run and Debug state stays coherent; raw `customRequest` is not used for control. Because those commands fall back to the focused thread when the context cannot be resolved, Desk first confirms in the same generation that the thread exists in that session and refuses otherwise. `stop` uses `debug.stopDebugging(session)` |
| `vscode_debug_handoff` | Reveal the stopped frame in an editor, show Run and Debug and a notification with the agent's message. Revokes the conversation's control grant and breakpoint ownership for that session (see above); reads stay allowed |

Operations an adapter does not support return "not supported by this debugger (<type>)".

### 4. Settings and permissions

All settings have `application` scope, so a repository's settings cannot change them.
- `omp.agentDebugger.enabled` (default `false`): register the debug tools in Chat sessions.
- `omp.agentDebugger.start`: `ask` (default) or `allow`. The confirmation names the folder, configuration or preset, type and request, and program if any.
- `omp.agentDebugger.expressions`: `off`, `ask` (default) or `allow`. Covers `evaluate`, breakpoint conditions and log messages, because all of them run code in the debuggee. The confirmation shows the debug session and the exact expression.
- After a confirmation, and when a queued action runs, the tool re-checks cancellation, the current setting, the executor gate, the control grant and the session's state and generation before acting.

### 5. Chat

One-line Overview rows (for example "Wait for stop · 2m 13s"), arguments and result in Detailed.

### 6. Unity layer (replaceable)

With the Microsoft Unity extension (`visualstudiotoolsforunity.vstuc`) installed, Desk offers an `Attach to Unity Editor` preset (`type: "vstuc"`, `request: "attach"`, optional `endPoint`). The descriptions tell the agent that a script breakpoint is verified only after Unity loads its assembly and that the Editor must use Debug code optimization. Whether `vstuc` attaches to a batch-mode Editor is unknown until observed. Replacing `vstuc` (for example with a fork of the MIT `walcht/unity-dap`) changes only this layer.

## Alternatives

- **OMP's own `debug` tool with a Unity adapter.** OMP owns the only connection, the user cannot take over in VS Code, and `vstuc`'s license forbids running its adapter outside VS Code.
- **Desk-hosted MCP server.** Reaches subagents and terminal `omp`, but adds a process or port, authentication and lifecycle, and still needs routing to the window that holds the debug session. Kept as a later option.
- **One `vscode_debug` tool with an `action` field.** One large schema and weaker validation per action.
- **Arbitrary inline configurations.** Rejected: the agent could launch any program through any debugger.
- **The broker answers calls itself when no window holds the session.** Would end waits sooner, but the broker would need tool semantics and a timeout policy. Rejected for now.

## Risks and Open Questions

- Adapters answer `customRequest` differently; Unity may not report a stack until symbols load. Checked on a real Unity project before acceptance.
- `vstuc` with a batch-mode Editor is unobserved. Observed so far: a batch-mode Unity 6000.4 Editor started with `-debugCodeOptimization` advertises `[Debug] 1` over UDP multicast and listens on 56000 + PID % 1000.
- Soft retention thresholds keep the never-evict behaviour of dialogs; a flood of pending calls is reported, not cut off.
- **Control route gate.** Driving `continue`/steps through VS Code's debug commands with an explicit `{ sessionId, threadId }` context is chosen so Run and Debug stays coherent (VS Code's raw `custom` request path skips the continuation bookkeeping its own `continue`/`next` methods do). Before commit 3 is accepted, the installed VS Code must show, with two debug sessions running, that the command acts on the given session and thread and that Run and Debug leaves the paused state. If that cannot be shown, the control tool goes back to design instead of falling back to raw requests.

## Rollout and Verification

Commits, each with its own tests:
1. This design and its ADR.
2. Host tool channel: broker capability, pinning and release, `inputOwned` on `RpcChannel`, executor gate, call states, registration. Tests: ring pin/release by result and by cancel, detached cancel, duplicate cancel/result, oversized call, overflow; buffered call plus cancel before resync; replay boundary; completion while detached; accepted write with lost acknowledgement; reconnect with a cursor past the call; read-only subscriber does not execute; ownership loss aborts and still answers; disconnect with a queued call; disable with a pending call; old broker gets no tools.
3. Debug coordinator and tools over `vscode.debug`, tested against a fake debug API (immediate stop before wait, termination during wait, an adapter that never sends `continued`, a failed `continue` response, user continue during an `evaluate` confirmation, parallel controls, late start after cancel, compound refused, start returning `false`) and in the test VS Code window on a Node program, including the two-session control-route proof above.
4. Chat renderers and settings with confirmations.
5. Unity layer for `vstuc`.

Acceptance: in the isolated test VS Code window with `vstuc`, the agent of a Chat session attaches to the Unity Editor of a test project, sets a breakpoint, waits while a test or Play Mode reaches it, reads the stack and variables, and hands off; the user then sees the paused session in Run and Debug.

## Related Decisions

- [ADR-0055](../decisions/0055-expose-vscode-capabilities-as-rpc-host-tools-run-by-the-owning-window.md)
- [ADR-0038](../decisions/0038-host-chat-over-rpc-ui-on-a-broker-pipe-child.md), narrowly amended by ADR-0055 for broker retention of host calls and host-tool execution.

## Architecture Review

- Reviewer: architect
- Outcome: round 1 (2026-10-10): accept after fixes, nine material and three minor findings. Round 2: accept after fixes, seven material (live input ownership, never evicting undelivered results, terminal cancel, untracked pre-activation sessions, control grant, generation checks on async replies, numeric hit count) and three minor findings. Round 3: accept after fixes, two material (response-aware transitions and a control route that keeps VS Code's state coherent; local cancellation still owes a result) and two minor findings. Round 4: **accept**, with two minor clarifications (pause acknowledgement, the `unknown` state) applied.
- Notes: architectural acceptance only. The installed two-session control-route proof and the Node and Unity acceptance runs are implementation gates and have not been exercised. Implementation is paused by the user's decision (2026-10-10).
