---
status: superseded
date: 2026-09-25
---

# Hydrate large chats without rendering old messages first

> Narrowly superseded by [ADR-0038](../decisions/0038-host-chat-over-rpc-ui-on-a-broker-pipe-child.md) and its [RPC-UI chat and Sessions design](2026-09-29-rpc-ui-chat-and-sessions.md) for guest snapshot-chunk buffering: history is painted from the session file first and reconciled with rpc `get_entries`. The bounded recent window of cards and the orphan-result placement (`transcript-window.ts`) remain operative.

## Problem

Joining a session with a long transcript visibly builds the chat from its earliest messages, delaying the useful recent conversation. The guest currently publishes a growing copied entry array on every ordered snapshot chunk; React repeatedly scans and renders the entire accumulated history. A bottom-follow effect runs only after rendering, so it cannot prevent the old-first progression or the full initial DOM cost.

## Goals and Non-goals

- On opening or restoring a chat, show its recent messages immediately after the complete native snapshot is received, rather than painting every older prefix.
- Bound initial rendered rows while keeping earlier messages accessible and preserving chronological reading order, tool pairings, live updates and a user's chosen scroll position.
- Keep the native OMP transcript and Collab protocol authoritative. Do not claim to reduce native host launch time or wire transfer duration without measurement.
- No new OMP API, transcript truncation, reversed historical storage or secret persistence.

## Current State

The guest receives a `welcome` with an `entryCount`, followed by ordered `snapshot-chunk` frames ending at `final` or the promised count. Each chunk appends into a private array but also clones/publishes the entire prefix. The transcript renderer maps all entries to React rows and follows the bottom in a normal effect. Empty, interrupted and reconnecting handshakes follow existing protocol safeguards.

## Proposed Design

Buffer the initial chunk train privately and publish the immutable entry array once at completion; preserve the loading phase and the existing promised-count, final-marker, stale-chunk, reconnect and timeout rules. Subsequent single `entry` frames remain live updates. Index **renderable rows** over the complete replica; hidden developer and custom entries consume no row budget. Pair a tool result into a visible assistant call's card using the full replica. If a result's call is outside the mounted window, show its labelled orphan tool card **at the result entry's chronological position**, and count that card in the initial visible-row budget; remove it when earlier-history expansion reveals its owner, preserving the reader's visible anchor. The transcript initially renders a bounded suffix of those display rows, with an explicit earlier-history control that progressively prepends them. Active tools have one representation, either their visible committed owner's card or a pending tail card when that owner is outside the window. The initial bound becomes a stable first-visible row identity: live appends extend the visible range instead of evicting what the user is reading; expansion moves that bound earlier, retains the visible anchor and pixel offset even across concurrent live updates, and an authoritative reconnect resets the window to the recent tail. New messages append in chronological order. Land at the bottom before first paint when joining or reconnecting; follow new messages only while bottom-locked.

This removes repeated full-prefix copying and DOM rendering during the initial transfer; it does not make the host send the last chunk first. If the native snapshot transfer itself dominates startup, separate diagnostics are needed rather than presenting this as a wire-latency fix.

## Alternatives

Reversing the entire chat changes established conversational reading order rather than fixing old-first loading. CSS reverse flow has scroll and accessibility pitfalls. Rendering all history at once still scales initial Markdown and DOM work with lifetime history. Requesting a tail-first native OMP API is unavailable under the installed wire contract and would introduce a new host dependency.

## Risks and Open Questions

Long snapshots must still reach the guest completely before recent messages can be known; only client-side publication/render cost is reduced. Incremental older-history expansion must preserve the viewport and remain accessible by mouse and keyboard; appends cannot unmount the row the user is reading. Changes to snapshot publication must not expose a partial stale train after reconnection or lose ToDo/Plan projection.

## Rollout and Verification

Add behavioral tests showing no old-prefix publication before snapshot completion, one final complete snapshot, and safe reconnect/count completion. Test a boundary cutting between an assistant tool call and its result: a visible call pairs exactly once, while a hidden call's result gets one budgeted orphan card at its own chronological position before a later user or stream; many orphan results cannot exceed the initial visible-row budget, and revealing the owner removes the orphan without shifting the reader's anchor. Test a tail of non-rendering metadata and a scrolled-away user reading the same mounted row while live entries arrive, including after older-history expansion and overlapping updates; verify reconnect resets to the tail. Run typecheck, targeted tests, full suite and Webview build once integrated. Exercise a long chat in an isolated actual VS Code window: recent content appears as a stable initial viewport, earlier content can be loaded and read, and a new streaming turn follows the bottom unless the user scrolled away. Compare host-launch and guest-live diagnostics before claiming end-to-end latency improvement.

## Related Decisions

- [ADR-0002: Local Collab guest for native OMP GUI](../decisions/0002-local-collab-gui-native-omp.md)

## Architecture Review

- Reviewer: independent architect
- Outcome: accepted after corrective review of orphan-card chronology and row budget
- Notes: F1 (renderable rows/result pairing), F2 (stable first-visible boundary), and the later orphan-card chronology/budget gaps were all closed in the design and independently confirmed by the same reviewer. Source repair and runtime acceptance are separate.
