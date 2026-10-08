---
status: superseded
date: 2026-09-24
---

# ADR-0004: Allow a Model-Control Race with Native OMP Session Transitions

> Narrowed further by [ADR-0038](0038-host-chat-over-rpc-ui-on-a-broker-pipe-child.md): model and thinking changes move from the host-control pipe to serialized rpc `set_model`/`set_thinking_level` in the only process serving a non-switching session, so the race this record waived no longer exists for chat controls. The accepted rationale is preserved as history.

## Context

The user requires GUI controls for the **same native OMP process** and requires this product to remain an extension only: do not modify or reinstall the OMP core. OMP 18.2.11 exposes `pi.setModel` and `pi.setThinkingLevel` to loaded extensions, but does not expose a public atomic mutation guard across native session transitions. In particular, `session_switch` fires before the resumed model is restored; cancellation/rollback lacks a matching settlement event, and some transition paths bypass cancellable before hooks (`packages/coding-agent/src/session/agent-session.ts:9617-9632,9745-9795,9888-9968,5119-5120`). Therefore the transition-exclusion condition in [ADR-0003](0003-native-host-control-pipe.md) cannot be met by an extension alone.

On 2026-09-24 the user explicitly accepted that **a GUI model/thinking change may race an internal OMP session switch** and rejected changing OMP itself. This is a deliberate relaxation of that one corner-case invariant, not permission to weaken session-file single-writer ownership, approval handling, local-only transport, or IPC authentication.

## Decision

Keep ADR-0003's authenticated pipe, endpoint checks, protected token, request-id ledger and secret-handling requirements. Replace **only** its atomic cross-transition exclusion, mandatory true-settled gate, commit-time epoch/revision fence against native transitions, and unconditional epoch invalidation claims with best-effort observation: serialize concurrent **pipe** mutations, reject detectable stale host/process/session/revision immediately before dispatch, invoke OMP's public `setModel`/`setThinkingLevel`, and read back the **last-observed** actual model/thinking/session afterward. A native TUI `/resume`, new session, branch, tree or reset can overtake the call between checks without a detectable event; do not promise to detect every rollback or to keep the selected value in force. Return an explicit stale/uncertain outcome when a transition is observed or the result is ambiguous; do not blindly retry. A `false`/throw from `pi.setModel` is a failed outcome, not success merely because a snapshot was obtained. No second OMP process, terminal keystrokes, private-field monkey-patching or OMP core patch is introduced.

The extension UI must show the **last-observed actual host value**, not an optimistic guest-local setting or a promise it will remain unchanged. Do not disable model/thinking controls because a stronger native-transition API is absent. Request-ID reservation, payload-conflict detection and at-most-once invocation/result replay apply **unconditionally**, including stale/uncertain outcomes during the accepted race: record the outcome, and a duplicate request ID or retry must never invoke the setter again. Preserve all local-only transport, credential, approval and session-file single-writer protections.

## Alternatives

- Patch OMP's core session-transition API to provide an atomic guard: would remove the race but explicitly rejected by the user for this extension-only project.
- Keep host controls read-only: fails the required model/thinking GUI behavior.
- Route `/model` through simulated terminal typing or start a second RPC process: breaks the native same-process requirement and would introduce broader races.

## Consequences and Verification

A concurrent native session transition is a documented product limitation; its frequency is not assumed. Prove ordinary model and thinking changes by reading back the host and preserving them through GUI ↔ terminal reveals and Webview reload. Exercise a concurrent transition: it may produce the old value, new value or explicit uncertainty, but the UI must never imply that an unverified value is active. A false/throw from OMP must be reported as failure. Keep separate tests for wrong key/fake endpoint, at-most-once request IDs even during the race, stale pre-dispatch generation and single-writer session ownership; this decision waives none of them.

## Related Documents

- [ADR-0002](0002-local-collab-gui-native-omp.md)
- [ADR-0003](0003-native-host-control-pipe.md) — supersedes only its cross-transition exclusion, commit-time native-transition fence and true-settled-gate clauses in Decision Outcome and Feasibility Gate; all other security and ownership conditions remain.
- [Development design](../designs/2026-09-24-omp-vscode-development.md)
- [ADR-0026](0026-best-effort-native-tui-switch-ownership.md) supersedes **only** this record's assertion that extension-scoped session-file writer exclusion also covers user-typed native TUI session transitions. The model/thinking race waiver, at-most-once requests, actual readback, authenticated channel, approvals and strict extension-issued launch/Reload claims above remain operative; native terminal actions are now explicitly the user's responsibility.

## Architecture Review

- Reviewer: architect
- Outcome: reviewed; accepted after clarifying the precise ADR-0003 override and unconditional request-ID idempotence.
- Notes: The architect confirmed the user-approved race is confined to native OMP session transitions. The extension must keep mutual authentication, credential/owner safeguards, at-most-once invocation and actual readback; it cannot assert that every native reset or rollback was detected.
