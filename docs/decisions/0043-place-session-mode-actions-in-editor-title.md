---
status: accepted
date: 2026-10-03
---

# ADR-0043: Place session mode actions in the active OMP editor title

## Context and Problem Statement

Managed session panes currently duplicate mode-switch and normal status rows above Chat and native Terminal. The user requests native VS Code editor title actions and full-height content, with only abnormal in-pane notices. The same editor and exact-writer-exit mode-switch contract of ADR-0040 must remain unchanged.

## Considered Options

- Keep webview controls: simple but duplicates chrome and violates the requested content layout.
- Put all actions in Sessions: not local to the active editor and not the requested title navigation.
- Drive editor-title actions from active OMP editor identity and mode: uses native theme/icons/tooltips and preserves the existing lifecycle commands.

## Decision Outcome

Choose the third option. Show Switch to Terminal for an active OMP Chat editor and Switch to Chat for an active OMP Terminal editor, in editor title navigation with the opposite-mode icon. Show Copy Screen in native Terminal's title overflow. Remove both managed in-webview header rows and normal live/grid indicators. Keep abnormal notices and the independent folder-shell header.

The shared terminal presentation now also removes the independent folder-shell header. Both surfaces keep full-height terminal content, expose grid and input ownership in a tooltip, and show Starting until readiness. Native Copy Screen remains in editor-title overflow; folder shells use terminal selection-copy shortcuts. Mode actions and writer ownership remain unchanged.

One active OMP editor resolver supplies both title context and command targeting, not the first visible split panel. Keep the existing OMP view-type gate and refresh on activation/deactivation, mode commit and disposal. Explicit target-mode switches reuse the per-tab lifecycle gate and its refusal reason. Copy remains allowed for read-only panes: a single-use, superseding, deadline-bound request is fenced to the panel/document/native mode/stream generation and replies over the panel or acknowledged bridge without mutation reservation. Bound the UTF-8 serialized reply envelope to 240 KiB; refuse an oversized copy with fixed feedback rather than truncate. The host clipboard API avoids lost webview user activation; terminal output cannot request copying. Success is transient host feedback.

### Consequences

- Positive: more content height, native editor affordances and correct split-editor targeting; no second mode lifecycle implementation.
- Negative: title context must refresh on actual editor activation and mode changes; copying requires a host/guest request because a title command lacks webview clipboard user activation.

## Related Documents

- [Native terminal UX design](../designs/2026-10-03-native-terminal-ux.md).
- [ADR-0024](0024-own-omp-pty-for-in-tab-terminal.md) is narrowly amended for its permanent in-pane controls clause as reinstated through ADR-0040, along with the same-editor design's top-right selector placement. [ADR-0040](0040-switch-one-editor-between-rpc-chat-and-native-pty.md) remains fully operative for mode and writer semantics.

## Architecture Review

- Reviewer: independent read-only architect.
- Outcome: accepted after actual review and addendum B; A1–A3 and the serialized-envelope copy bound were resolved. The resolver, authority refusal, passive copy and supersession scope are explicit above.
