---
status: accepted
date: 2026-10-10
---

# ADR-0055: Expose VS Code capabilities as RPC host tools run by the session's authorized owning window

## Context and Problem Statement

The agent of a Chat session needs capabilities only VS Code has, starting with VS Code's debugger (see the [agent debugger design](../designs/2026-10-10-agent-debugger-tools.md)). The user must be able to take over the same debug session in VS Code's UI, and Microsoft's Unity debug adapter may only run inside VS Code. OMP's RPC client in Desk is the detached broker, so a call can outlive the window that received it, and several windows can subscribe to one session's stream.

## Considered Options

- **RPC host tools (`set_host_tools`) executed by the authorized owning window.** Supported by installed OMP 18.8.5, no new process or port, uses the existing authenticated broker pipe, and calls land in the window that holds the debug session. Main session only; terminal-mode sessions are not RPC sessions.
- **A Desk-hosted MCP server.** Reaches subagents and terminal `omp`, but adds a process or port, authentication, discovery and lifecycle, and still needs routing to the window that holds the debug session.
- **OMP's own DAP client (`debug` tool) with custom adapters.** OMP owns the only connection, the user cannot take over in VS Code, and running `vstuc`'s adapter outside VS Code is not allowed by its license.

## Decision Outcome

Accepted: RPC host tools.
- Only the `RpcSession` that has verified the session's identity and holds broker input executes and answers calls; read-only subscribers do neither. The gate is re-checked before every side effect; losing it stops running and queued calls, and each of them still gets exactly one error result.
- A new broker capability pins an unanswered `host_tool_call` until its result is written to OMP or OMP cancels it. Without that capability (a broker from an earlier build) Desk registers no tools.
- A call this `RpcSession` did not see live (one produced before it attached, or first seen in a reconnect replay) is answered with an error and never executed. A completed result is re-sent under its id until the broker accepts it. Nothing is re-run.
- The broker never answers calls itself. While no window holds the session OMP keeps waiting; reopening or stopping the session ends the wait.

This narrowly amends [ADR-0038](0038-host-chat-over-rpc-ui-on-a-broker-pipe-child.md): the broker ring retains a second kind of unanswered request, and the host executes OMP-requested tools. Later VS Code capabilities may use the same channel but need their own design and permissions.

### Consequences

- Positive: no new transport; the debugger the agent drives is the one the user sees; the channel is reusable.
- Negative: subagents and terminal sessions do not get the tools; sessions started by an earlier broker must be restarted to get them; a call can wait indefinitely while no window holds its session; retention thresholds are soft.

## Related Documents

- [Agent debugger tools design](../designs/2026-10-10-agent-debugger-tools.md)
- [ADR-0038](0038-host-chat-over-rpc-ui-on-a-broker-pipe-child.md)

## Architecture Review

- Reviewer: architect
- Outcome: round 1 (2026-10-10): the choice is sound, accept after fixes. Rounds 2 and 3: accept after fixes, addressed in the design. Round 4: **accept**.
- Notes: architectural acceptance; implementation is paused and its installed gates are not exercised.
