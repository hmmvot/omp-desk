---
status: accepted
date: 2026-10-09
---

# ADR-0051: Rewind Chat in place through a Desk-registered OMP command with a durable marker

## Context and Problem Statement

Chat needs the TUI's in-place rewind: move the active branch of the same session file to an earlier entry, keep the later messages as a sibling branch, and put a rewound prompt's text and images back into the composer.

OMP 18.8.5 offers no RPC command for this.

- **RPC `branch` and `fork`** create a new session file. The slash command `/branch` (alias `/rewind`) is the TUI's in-place rewind selector and has no RPC handler.
- **`AgentSession.navigateTree`** does the in-place move. Extensions reach it only through `ExtensionCommandContext.navigateTree`, which exists only while a registered extension command runs from `prompt("/name …")`.
- **The leaf it sets is memory-only.** After a restart the leaf is the last entry in the file, so a bare rewind reverts unless something is appended first. OMP itself appends a custom entry after its own leaf move in turn recovery.
- **`get_entries {since}`** reports a bare leaf move only through `leafId`, and Desk's delta reconciliation ignored an empty delta.

The evidence is in the [design](../designs/2026-10-09-chat-rewind.md#current-state).

## Considered Options

- **RPC `branch`:** available, but it moves the process to a new file, drops images and changes the editor's conversation identity, against Chat's no-identity-change rule.
- **RPC `get_tree`:** reads the tree; it cannot move the leaf.
- **Wait for an upstream `navigate_tree`:** the cleanest route, but it does not exist in the installed OMP, and the user needs the feature now.
- **A command on the authenticated host-control pipe:** pipe handlers have no command context, so they cannot call `navigateTree`, and the channel is deliberately read-only.
- **A Desk-registered OMP extension command:**
  - The existing `-e` module registers `omp-desk-navigate` in RPC mode; the host sends it through `prompt`.
  - A compare-and-swap guard on session id and leaf runs inside OMP.
  - A `custom` marker entry is appended after every real move.
  - No upstream change; the same file and process; an exact, durable outcome.
  - Cost: one `custom` entry per navigation, and the command name is visible in the RPC command catalog.
- **Editing the JSONL from the host and restarting OMP:** a second writer and a lost process. Rejected.

## Decision Outcome

Chosen: **a Desk-registered OMP extension command with a durable marker.**

- **Registration.** The host-control module registers `omp-desk-navigate` from its first `session_start`, only when `ctx.mode === "rpc"`. The registration needs only the module loaded with a non-absent bootstrap; it does not use the host-control pipe or its key.
- **Host checks before sending** (`RpcSession.navigate`): the live catalog lists the command with `source: "extension"`; the session is live, identity-verified, idle, settled, not paused on async work, not compacting, with no queued messages, no open dialog, no prompt of unknown fate and no unreconciled live row; the model's leaf equals `expectedLeafId`; the target is a loaded user prompt (rewind), the `from` of the Undo marker (undo) or a known branch tip (switch).
- **Handler checks inside OMP:** idle with no pending messages, the same session id, the same leaf (or only OMP's `model_usage` bookkeeping after it, which OMP appends after a reply settles), and the same per-kind target rules on the full branch. Refusals throw a fixed `omp-desk-navigate:<code>` before anything moves.
- **The move and the marker.** After `navigateTree`, the handler takes `from` and `to` from OMP's `session_tree` event. Whenever the leaf moved, even if `navigateTree` threw or another append raced it, it appends a `custom` entry `omp-desk/navigation` with `{v, requestId, kind, from, target, to, summarized, raced?}`. `summarized` records whether a summary was written.
- **Fence.** While the command runs, every mutating `RpcSession` operation answers busy. When no answer comes in time, the fence stays until the late result arrives, the marker is seen, or this `RpcSession` ends (process exit, or a re-attach after a window reload).
- **Wait.** The prompt is sent without `streamingBehavior`. The command's `prompt_result`, an acknowledgement with `agentInvoked: false` and an error acknowledgement each end the wait. Evidence that the text reached the model (`agentInvoked: true`, or a user message carrying the request id) aborts that turn and reports failure.
- **Outcome and re-sync.** The re-sync runs through the one reconcile serializer, which now treats a moved `leafId` as a rebuild and takes the disk window at the live leaf only when the disk agrees with the process, else `get_entries` trimmed to the tail window. Success is a marker with the request's `requestId` on the re-synced active path: the leaf or an ancestor of the leaf.
- **Undo** is offered when, walking back from the leaf (the leaf included) past metadata such as `session_exit`, the first other entry is a rewind or switch marker. The page and the host apply the same rule to the entries Desk models, and the handler applies it to the full branch, so Undo survives a window reload and a process restart.
- **Entry points.** `/rewind` and `/branch` typed alone, Esc Esc in an empty idle composer, a prompt's Rewind action and **OMP: Rewind Conversation…** all open the same Rewind. `/branch` keeps OMP's meaning, the in-place rewind; it is never routed to the RPC `branch` fork.
- **Editor text.** The draft for edit and resubmit is taken from the target entry the host holds, because the extension wrapper drops `editorText` and `editorImages`; stored `blob:` images are resolved like disk paint.
- **Replacement.** `RpcSession.navigate` is the only host interface, so an upstream `navigate_tree` can replace the command without page or protocol changes.

### Amendments

- **ADR-0038 §4.** Disk-first history stays. A moved leaf is now re-synced: a rebuild at the live leaf, validated against the live cursor, with a tail-window `get_entries` fallback; `loadOlder` walks the ancestors of the requested row.
- **ADR-0038 §8 and ADR-0003.** The `-e` module may register this one RPC-only internal command. Its mutation travels over RPC stdin, which the broker restricts to the owning host; the authenticated host-control pipe stays read-only.

### Consequences

- Positive:
  - Rewind, Undo and branch switching share one exact, race-checked mechanism.
  - The rewound branch survives a reload or restart, and so does the Undo offer.
  - Leaf moves made by OMP's own turn recovery are now shown too.
  - An older or foreign process without the command is refused instead of receiving the command as model text.
- Negative:
  - Every navigation adds one `custom` line to the session file.
  - The command name appears in the RPC command catalog. Desk hides and refuses it in the composer.
  - Summarize can be neither cancelled nor given custom instructions.
  - A navigation closes an open `/btw` side conversation and quiesces goals (`wrapSessionChange`).
  - A third-party `input` hook can intercept or rewrite the command; the host detects a fall-through but the aborted prompt stays in the transcript. A rewrite that drops the request id is caught only by the final `prompt_result`.
  - The fence belongs to one `RpcSession`. A window reload during a summarizing navigation re-attaches without it, so an immediate send could start a turn on the old branch while the leaf moves. This residual risk is accepted; closing it needs a navigation-in-progress signal from OMP.
  - Undo to a tip that is a user message lands on its parent.
  - The approach depends on OMP keeping `ExtensionCommandContext.navigateTree`, `appendEntry`, the `session_tree` event and extension command dispatch through RPC `prompt`. A change surfaces as `unsupported` or a refused outcome, never as a silent wrong move.

## Related Documents

- [Design: Rewind a Chat conversation in place](../designs/2026-10-09-chat-rewind.md).
- [ADR-0038](0038-host-chat-over-rpc-ui-on-a-broker-pipe-child.md), [ADR-0003](0003-native-host-control-pipe.md), [ADR-0006](0006-host-generated-key-peer-verified-pipe.md).

## Architecture Review

- Reviewer: architect (independent; not the author), two passes.
- Outcome: accepted with changes.
- Notes: The first pass found six material defects (leaf-move re-sync, success on the active path, fence and busy checks, the wait protocol, the branch rule, and the ADR-0003/0038 amendments). The second pass confirmed all resolved against the working-tree code and OMP 18.8.5 and required two wording corrections, applied: `/branch` is OMP's in-place rewind, not a fork, and the fence lasts for one `RpcSession`. Main then mapped `/branch` to Desk's Rewind.
