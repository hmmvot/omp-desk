---
status: accepted
date: 2026-10-03
---

# ADR-0044: Resynchronize on stream discontinuity and retain broker ownership across blur

## Context and Problem Statement

Health/focus attach snapshots reset xterm and destroy scrollback. Focus-only ownership misreports DOM blur as read-only. Dense renderer sequences restart on pipeline rebuild while the broker's PTY generation stays stable. Each real pipeline registers one frontend; the broker owns competing input arbitration. These rules apply to managed native and folder-shell pipelines; shell header affordances and ADR-0030 grace remain unchanged.

## Considered Options

- Delete health probes: conceals host loss.
- Snapshot or require exact consumed-sequence equality on every probe: destroys local state during normal in-flight output.
- Ordered non-resetting probes, fresh stream identity and broker-authoritative ownership: preserve healthy state and explicit recovery/input fencing.

## Decision Outcome

Choose the third option. Mint the existing opaque generation as random 16-byte lowercase hex per TerminalPipeline. It identifies a renderer stream, not a stable PTY process; authenticated broker/process identity is unchanged. A separate epoch field is unnecessary. Remove the obsolete stable writer-generation helper and its tests rather than preserve an alias.

A distinct probe carries generation and consumed sequence. A mismatched generation or impossible higher consumed sequence obtains an attach snapshot; otherwise send non-resetting status with the current dense sequence on the same ordered route after queued output. The page detects an actual ordered status gap and requests attach without advancing past missing bytes. Healthy status never resets, re-pushes fonts or clears pending snapshot/recovery. While recovering, the page asks for attach rather than probe. All frames still answer the bounded host-liveness wait.

An attached stream change observed in data or ordinary status drops the frame and requests attach once. Only a snapshot-follows state adopts the new generation/sequence baseline; reset happens when its snapshot arrives. Non-attached availability/exit reporting remains truthful. State answers distinguish snapshot follows, snapshot failed and ordinary status. A failed attach answer ends pending recovery without a snapshot and retains the damage notice; status/ownership frames never clear it.

Forward authoritative broker input-owner and disconnect facts through the adapter. Never grant optimistically: successful broker claims and newer owner events decide permission. Another frontend's takeover immediately demotes the old pane. A visible eligible pane may acquire an unowned slot with takeover=false; only explicit real focus/activation intent permits takeover=true, including reclaim after another owner. DOM blur retains ownership. Hidden, read-only, removed or disconnected owners lose authorization and release their slot where reachable. Input/resize require the eligible authorized owner and stream generation; seen additionally requires actual focus. Desktop suppression keeps window/active-editor attention rules and never treats ownership as attention.

### Consequences

- Positive: scrollback survives healthy quiet/streaming probes; restart obtains a valid fresh sequence baseline; blur no longer masquerades as read-only while broker competitors remain fenced.
- Negative: the protocol cutover and all consumers migrate together. Genuine recovery snapshots still replace terminal-local scrollback.
- Snapshot recovery buffers the target frontend's concurrent output and maps the broker's UTF-16 snapshot cut to its dense renderer sequence, preserving post-cut bytes without pausing other panes.

## Related Documents

- [Native terminal UX design](../designs/2026-10-03-native-terminal-ux.md) and [ADR-0043](0043-place-session-mode-actions-in-editor-title.md).
- ADR-0024 is refined for stream/frontend ownership; ADR-0040 mode/writer semantics, ADR-0042 attention suppression and ADR-0030 folder-shell grace remain operative.

## Architecture Review

- Reviewer: independent read-only architect.
- Outcome: accepted after actual initial review and addenda B/C. R1–R4 and G1–G3 were resolved: explicit failed-snapshot state, deferred reset/new-stream recovery, shared shell scope, serialized copy bound in its related decision, and fresh pipeline generation instead of a second epoch. The corrected draft was reviewed before promotion; no routine extra review was requested.
