---
status: accepted
date: 2026-10-03
---

# ADR-0042: Submit Windows desktop toasts through encoded PowerShell WinRT and protocol activation

## Context and Problem Statement

The user requires actual Windows desktop notifications for top-level OMP sessions waiting for input, replacing the existing in-VS Code turn notification. Clicks must return to the session. No new native dependency is permitted, and untrusted title/question data must never become script source or shell commands.

The machine's registered Start application identity is `Microsoft.VisualStudioCode`. A short-lived Windows PowerShell probe called WinRT ToastNotificationManager.Show with that identity; notification history returned the exact own tag/group/XML (`bg_175`, historyCount1/matchingCount1). The probe removed only its own entry. This is real OS delivery evidence, not a mocked API response. A PowerShell script-file probe also exposed non-BOM UTF-8 text decoding; production must preserve Unicode independently of that file encoding.

## Considered Options

- Keep VS Code information messages: not the requested OS desktop surface.
- Add a native notification package/helper binary: unnecessary dependency/toolchain/package burden.
- Install an extension-specific AUMID shortcut: additional machine authoring not needed while the registered VS Code identity is proved.
- Interpolate event content into a PowerShell command: command injection/process-argument disclosure and Unicode hazards.
- Static encoded PowerShell WinRT script, stdin data and protocol activation: direct supported OS API, no native addon, bounded short-lived process and no event data in executable source.

## Decision Outcome

Use a constant PowerShell script encoded UTF-16LE for `-EncodedCommand`, launched from the system PowerShell path with `-NoProfile -NonInteractive`, `windowsHide` and no shell. Read stdin bytes with strict UTF-8 into the JSON record; end stdin, discard stdout/stderr and kill on a 10 s deadline. Strip invalid/control/bidi text, repair lone surrogates, bound first lines by code point and XML-escape text/attributes. Submit using the proved `Microsoft.VisualStudioCode` AUMID only with Stable's `vscode` scheme. Other platforms/products are a fixed-log no-op; never substitute a VS Code notification.

At toast time, use `vscode.env.asExternalUri` on the owning window's identity-only extension URI; serialize its unmodified result with `toString(true)` so query separators and VS Code-added routing parameters remain available to ordinary protocol URL query consumers. Do not cache or rebuild the external URI. Register UriHandler synchronously with `onUri`. Public routing goes to the topmost window, not necessarily the origin. The user accepted this disclosed limitation: reveal the exact retained panel with `reveal(viewColumn,false)`; absent a panel, select/reveal an indexed Sessions row only or log. Do not invoke Resume, attach, launch, change mode or create a writer. Foregrounding and first-click confirmation are runtime observations, not guarantees from internal APIs.

This choice does not change OMP itself. Chat completes only on actual settle with a fresh non-aborted prompt result or live assistant outcome. Autonomous continuations do not earn another prompt ticket and RPC removes streamed `agent_end.messages`; fresh `message_end` enums plus an unstreamed final-abort veto cover both paths without reading historical payloads. The [Sessions work-status design](../designs/2026-10-04-sessions-startup-and-work-status.md#shared-activity-truth) amends native completion to retain a fresh non-aborted `agent_end`, including `willContinue:true`, provisionally until authenticated SDK idle and all jobs/result deliveries drain; a new start or abort cancels it. A cancelled self-continuation that never starts is not distinguishable. Current-run live assistant freshness, final-abort veto, main TUI/session scoping and no `session_stop` hook remain required. Its 32-entry `nativeActivity` method is called only under a locally recorded positive launch capability; protocol 3 and existing kind-only wire shapes remain unchanged. New work detail is separately recorded-capability/request-gated as described in that design. The exact observable native wait set is built-in ask and the tool approval gate during a main run; all other native dialogs are disclosed limits. Disabled/suppressed events are consumed once.

### Consequences

- Positive: genuine Windows toast/history surface, safe data boundary, no new native dependency or long-lived helper, protocol-based session return.
- Negative: Windows policy can suppress presentation, lock-screen content and notification history retain display questions, and EDR/ASR policy can reject encoded PowerShell commands. A valid application identity is required; no OS policy bypass or unproved product-AUMID guess is allowed.
- Limits: public URI routing cannot guarantee the originating window/profile or activate a handle-less surviving webview. Native plan approval, extension/command/hook/custom dialogs and waits after settle are unobservable; old staged modules retain controls without native toasts. Font, PTY ownership and lifecycle remain untouched.

## Related Documents

- [Windows desktop session notifications design](../designs/2026-10-03-windows-desktop-session-notifications.md)
- [Current architecture](../architecture.md)
- [ADR-0006 authenticated control channel](0006-host-generated-key-peer-verified-pipe.md)

## Architecture Review

- Reviewer: independent architect, completed.
- Outcome: accepted after corrections; the design records the finding triage. The user explicitly accepted the public-routing limits and the recommended non-mutating Sessions-row fallback.
- Notes: tightened signal causality, positive native capability, bounded replay, exact native limits, URI routing, Unicode/stdin safety and policy/privacy disclosure. Preserve distinct-event toasts rather than coalescing or overwriting them. Installed isolated trigger/suppression evidence and repaired exact-toast-URI retained-editor/indexed-row activation passed; the frozen proof and unchanged lifecycle observations are recorded in the design. Physical/global clicks were not exercised. Commit and primary-profile installation of this package were withheld pending the user's decision.
- Final canonical checks, the packaged extension and an isolated fresh/reused/hidden/supported-reloaded Chat proof passed, including fixed decision logs and a new exact tagged WinRT entry. Separate bounded read-only qualification matched the current cache response's exact SHA256 to built/installed guest bytes. The design records the earlier served-resource artifact as observed-with-raw-CDP without claiming raw-reload causality; no bundle cache-busting or change to this accepted delivery mechanism was introduced. The verification receipts are not kept in the repository.
- Current Sessions work-gating amendment is implemented and accepted on a coordinated run. Its carried-forward actual asynchronous case completed after 73.7 seconds, showed Waiting for subagents while pending, submitted no premature completion and earned exactly one tagged completion at true idle. Focus/visibility ask suppression, one away-editor ask submission, silent abort and silent native history reattachment passed. Tagged WinRT history is not physical banner proof; positive new-capability native background-work gating remains source-tested only. The [Sessions design evidence](../designs/2026-10-04-sessions-startup-and-work-status.md#implementation-evidence) records corrected clocks, canonical checks, exact packaged/built/installed hashes and same-artifact peer receipts without changing this accepted delivery mechanism.
