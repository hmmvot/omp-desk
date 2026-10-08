---
status: accepted
date: 2026-09-24
---

# ADR-0009: Keep native tool selection read-only until session-atomic mutation exists

## Context and Problem Statement

OMP 18.2.11 synchronously enumerates registered and enabled tool names, but its public `setActiveTools(names)` setter cannot atomically compare the caller's expected session to the mutable current session at application. The authenticated pipe can pin a process, session file, epoch and revision before dispatch, yet the extension registration barrier, queued setter and prompt reconstruction are asynchronous. A concurrent native TUI `/new`, `/resume` or session switch can cause a GUI request for one tab to change another current session's tool capabilities. A later read-back may detect a mismatch but cannot prevent the change or safely undo it. [ADR-0004](0004-best-effort-host-model-transitions.md)'s user-approved waiver applies only to model and thinking transitions. The user separately declined this tool-selection race on 2026-09-24.

## Considered Options

- Enable GUI Apply/Paste through the existing authenticated pipe and at-most-once setter invocation/request-ID ledger, subject to [ADR-0006](0006-host-generated-key-peer-verified-pipe.md)'s remaining runtime gates: neither transport authentication nor replay protection makes the OMP setter session-atomic, guarantees successful application or eliminates unknown outcomes.
- Recheck immediately before the native setter: reduces a detectable window but cannot make the async OMP method an atomic expected-session operation.
- Expose only `listTools` with registered/active names and a deliberate clipboard copy of active names, leaving mutation to OMP's own TUI until OMP exposes an atomic owner-session contract.

## Decision Outcome

Keep **only the tool-selection surface** read-only. This narrowly extends [ADR-0003](0003-native-host-control-pipe.md)'s host-control method allowlist with `listTools` while retaining its existing model/thinking methods and [ADR-0004](0004-best-effort-host-model-transitions.md)'s separate mutation policy. Catalogue reads must pass [ADR-0006](0006-host-generated-key-peer-verified-pipe.md)'s peer verification, authentication, secret-handling and availability gates. `all` is bounded registered names; `active` is the enabled names reported by `getActiveTools`, including discoverable or mounted presentations, not necessarily directly provider-visible tools. A read may occur during a transition: it is neither proof of a settled selection, execution permission, approval nor durable restoration. Detectable owner/session mismatches are rejected, without claiming all transitions are detectable. The Webview shows names only: no schemas, descriptions, source paths, invocation, approval handling or settings writes. It refreshes on request, with no selection checkboxes, Apply or Paste. Copying observed active names to the clipboard requires explicit user action and never imports, applies, persists or automatically reapplies them. Project-level startup presets remain prohibited by [ADR-0008](0008-native-tool-selection-at-session-start.md).

### Consequences

- Positive: no extension path intentionally applies a tool selection to another native session; model/thinking changes remain only under their distinct accepted waiver.
- Negative: per-chat selection, cross-chat Paste and category/prefix toggles remain unavailable in the GUI; users may use the native TUI. A future change requires an independently proven atomic owner-session setter or an explicit new safety decision, not merely an extra post hoc check.

## Related Documents

- [Rejected startup-flag default](0008-native-tool-selection-at-session-start.md)
- [Authenticated host-control pipe](0003-native-host-control-pipe.md)
- [Host-generated key and peer-verified pipe](0006-host-generated-key-peer-verified-pipe.md)
- [Best-effort model/thinking transitions](0004-best-effort-host-model-transitions.md)
- [Development design](../designs/2026-09-24-omp-vscode-development.md)

## Architecture Review

- Reviewer: architect
- Outcome: accepted after material corrections to method scope, guarantee language and catalogue semantics.
- Notes: Independent decision and native source-contract review on 2026-09-24; not a certification of the concurrent source cutover or ADR-0006 runtime gates.
