---
status: implemented
date: 2026-10-08
---

# Stats dashboard in an editor

## Problem

OMP's usage dashboard is a local HTTP server. OMP Desk needs an editor entry point without losing ownership of a server when its editor closes or the extension host reloads.

## Goals and Non-goals

- Open the real `omp stats` dashboard inside an editor, including its same-origin EventSource live updates.
- Reuse an already compatible dashboard and one editor per window; never launch another child merely to reveal it.
- List owned servers as **Stats dashboard** in Processes with authenticated Stop and durable reload discovery.
- Closing the editor leaves the server running. Never signal a numeric PID or claim control of an independently started dashboard.
- No dashboard reimplementation, configurable public exposure, new process registry or session claims. Supported runtimes suppress native browser opening; unsupported builds require explicit modal consent before opening a browser as well.

## Current State

The detached broker already hosts PTY children, stores authenticated records before child launch and survives host reload. Processes enumerates those records and stops exact children through the broker. Installed OMP's stats server binds IPv4 loopback port 3847, identifies compatible dashboards with `x-omp-stats-dashboard: 3` and `x-omp-stats-hostname: 127.0.0.1`, and uses `/api/events` SSE. Its reuse check additionally requires status 200 and no CORS allow-origin header. Actual `omp stats` unconditionally opens a browser; the separate `omp-stats` entry does not. The dashboard does not set a frame-denying header. Installed package/Bun preload capability was proved with a harmless version probe; a separately installed compiled runtime lacked it.

## Implemented Design

A **Stats** Sessions view-title action invokes `OMP: Open Stats`. It was first placed in the Processes title; after release review the maintainer moved it to Sessions, the always-visible view, while its server is still listed and stopped in Processes. The same command remains available in the Command Palette.

A small host controller serializes open requests. It probes the fixed loopback `/api/stats/models` endpoint with a finite deadline and OMP's exact compatibility checks. Compatible responses open/reveal the editor without spawning. An HTTP response from another listener produces a clear occupied-port error; a connected non-HTTP or unresponsive listener produces a distinct not-responding error before launching.

Absent a listener, the controller resolves installed OMP with the existing resolver and launches a **stats-dashboard** PTY broker kind. Every launch mints a fresh `stats:<uuid>` slot, preserving retained broker recovery records. A separate fixed interprocess admission lock serializes discovery by record kind, preflight and publication/handshake; readiness waits outside the lock. Authenticated live stats brokers are adopted even when their staged digest differs; a record with a proved dead/recycled broker is retained as evidence without blocking a fresh slot. A still-live unreachable broker refuses a second launch. The registry is the only durable ownership source: the kind identifies deliberate standalone background work, without a session/shell catalog record. Protocol/runtime versions stay unchanged; older builds that do not know this kind see it as unreadable and fail closed. Existing kinds and owner-watch rules remain unchanged.

The launcher first stages/verifies the child-local opener preload and runs a harmless `--version` capability probe. Only its exact success marker admits `--preload` before the resolved OMP prefix. The preload suppresses only the exact PowerShell opener URL printed by that same Stats process; all other spawns pass through. Without verified support, a Start/Cancel modal explains native browser opening. Start runs unmodified `omp stats`; Cancel creates neither child nor editor. Consent is not persisted, and an already-ready dashboard bypasses the entire launch path. [ADR-0049](../decisions/0049-intercept-stats-browser-opener-via-preload.md) records the narrow matching, safe degradation and preferred upstream `--no-open` replacement.

Readiness polls the identity-header endpoint, never treating a mere open port as readiness. Timeout or child exit produces an actionable error; the authenticated broker remains listed whenever termination cannot be confirmed. Exited brokers receive authenticated `shutdown(requireStopped: true)` and their exact generation's disappearance is awaited; records do not disappear and are never deleted by the controller. Running servers remain after editor close and extension disposal. Processes discovers the kind on activation/reload, labels it independently from sessions/shells and uses the existing broker stop/shutdown flow. Stats records are in-use independently of session catalog readiness, never orphaned, and bulk-stoppable only when their child has exited. Stop never modifies session or shell mappings.

The editor is a dedicated singleton WebviewPanel. Its only content is an iframe whose URL is obtained through `vscode.env.asExternalUri` from the fixed dashboard origin. CSP defaults to none, permits the exact mapped frame origin and a nonce stylesheet; no host bridge or credentials are exposed. The iframe allows scripts and same-origin operation, enabling the dashboard's own same-origin fetch/EventSource. The outer page has no dashboard API proxy. Closing the panel only disposes presentation. Reload discovery requires Processes listing and command-driven reattach, not automatic dashboard start or restored-tab ownership.

A compatible dashboard started outside this profile is reused but is not given a fake broker or Stop action: only processes this extension actually owns are listed/controlled. With the native CLI, a compatible server racing preflight can cause a redundant, tracked `omp stats` process that does not own the listener; its output and identity headers do not prove which process serves the port. Processes Stop controls the exact broker child, not an unowned listener. Native OMP may reclaim an older/OMP-identifiable listener racing preflight; serialized preflight narrows but cannot eliminate that residual native behavior.

## Alternatives

- Separate detached spawn/registry: rejected because it duplicates authentication, durable identity and cleanup.
- Pipe-child specialization: unnecessary; the CLI works in an existing PTY and needs no RPC negotiation.
- Sessions row: falsely suggests a session/profile-specific conversation. A Processes action avoids new inventory rows.
- Stop on editor close: rejected by the requested background lifecycle.
- Full webview HTML rewrite/proxy: duplicates OMP and risks breaking relative fetch/SSE.

## Risks and Open Questions

The installed isolated proof verified mapped iframe origin, dashboard headers and live SSE. ConPTY proves exact root exit, not absence of escaped descendants. Compatible external dashboards remain unowned. Preload matching depends on private native output/opener formatting; a future changed opener can pass through and open a browser, with suppression unconfirmed in Output and a definite miss requiring consent on the next fresh launch. Automated installed proof is restricted to the positively verified global-runtime suppression path; unsupported behavior is unit-tested, never launched.

## Rollout and Verification

Implement broker kind/Processes projection, controller and iframe, command contributions, focused behavior tests and documentation. Run typecheck and targeted tests after integration (no full suite). Package/install a task-owned isolated VSIX, prove dashboard and Processes screenshots, second-click same broker/server identity, tab-close persistence, window reload listing/reattach, live SSE and Stop. Leave no owned proof servers or windows running. Main-profile installation is excluded by this package's explicit safety contract.

## Implementation Evidence (2026-10-08)

An independent Verifier used a private baseline containing this package's source and command/activation seams. Typecheck passed and all 189 tests across eight assigned test files passed. The private Windows x64 VSIX SHA-256 was `b7f79e1870530f04a7d36a81cd2dc88f9fadc6b6e765eb7e48f5df01fde9b067`; installed files matched the packaged files except VS Code's added package metadata. Post-proof edits change documentation only and are not claimed as rebuilt artifacts.

The installed isolated window's actual Processes title action opened the real OMP 18.6.3 dashboard. Read-only network observation captured ten EventSource messages from its own `/api/events` request. Screenshots showed the dashboard, distinct Stats row, reload reattachment, Stop control, fresh restart and occupied-port error. Repeat open, editor close/reopen and Developer: Reload Window retained the same broker generation, exact root creation tuple and single listener. Authenticated UI Stop removed the row and ended that root/broker, without deleting its record; restart minted a fresh slot while retaining the earlier evidence.

An independently owned unrelated HTTP fixture produced the actionable conflict error without a new Stats record, child or editor. The production preload's suppression was observed on the fresh restart; its first-launch output was not captured before reload. The unsupported launch path was never exercised. Both Stats instances, the fixture, isolated window and CDP listener were gone at completion; the main-profile process set was unchanged. Exact-root absence does not claim that escaped descendants cannot exist.


## Related Decisions

- [ADR-0047](../decisions/0047-host-stats-in-the-existing-pty-broker.md)
- [ADR-0049](../decisions/0049-intercept-stats-browser-opener-via-preload.md)
- [Processes design](2026-10-07-processes-view.md)

## Architecture Review

- Reviewer: architect
- Outcome: accepted after two independent review rounds.
- Notes: fresh slots/admission locking corrected the retained-record deadlock; explicit Stats classification and fail-closed older-kind behavior corrected the other material findings. The coordinator selected harmless preload probing, exact opener suppression, per-start fallback consent and the residual native reclaim policy in ADR-0049. The confirming review accepted the architecture; stale decision wording was corrected, cheap dead-PID filtering was added and an observed unchanged opener is remembered as unsupported for this binary during the window lifetime (not as consent).
