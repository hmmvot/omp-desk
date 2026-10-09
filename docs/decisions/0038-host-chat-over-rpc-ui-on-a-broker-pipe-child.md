---
status: accepted
date: 2026-09-29
---

# ADR-0038: Host chat over `omp --mode rpc-ui` on a pipe child of the detached broker

> Ownership clauses narrowed by [ADR-0039](0039-refuse-only-on-a-verified-live-writer-the-extension-owns.md): owner-unknown, blocked-orphan, stale reservation, release ceremony and retained uncertainty are removed. Unknown records are stopped/draft; verified legacy children are Running with one-step stop-and-continue. RPC transport, document identity and automatic relaunch evidence remain.

> UI and commitment 8 narrowed on 2026-10-01 by the implemented [compact-footer design](../designs/2026-10-01-compact-chat-footer.md): configuration snapshots, settings/tool/usage panels and notices history are removed. Pipe protocol 3 retains authenticated binding, file-evidence support and `listTools` for the independent clipboard command. Model/thinking controls are lazy, host-readback footer pickers; provider login is an extension command. Rpc chat, broker, shell and ownership contracts remain unchanged.

> Native TUI removal and legacy classification narrowly superseded by accepted [ADR-0040](0040-switch-one-editor-between-rpc-chat-and-native-pty.md): explicit native transport returns in the same editor; RPC Chat and security/removal decisions remain. Implemented in source with headless and owned real-OMP evidence; installed-window acceptance remains separate.

> §4 and §8 narrowly amended by [ADR-0051](0051-rewind-chat-in-place-through-a-desk-registered-omp-command.md): reconciliation treats a moved `leafId` (an empty delta or one that does not extend the leaf) as a rebuild, takes the disk window at the live leaf only when the disk agrees with the live cursor, otherwise reads `get_entries` trimmed to the same tail window, and `loadOlder` walks ancestors; disk-first stays. The `-e` module may register the RPC-only `omp-desk-navigate` command; the host-control pipe stays read-only.

## Context and Problem Statement

The chat editor is a Collab guest ([ADR-0002](0002-local-collab-gui-native-omp.md)): a loopback relay sidecar, a room and bearer link
obtained through `omp collab list|link`, sealed frames in the page, and a raw-receive recorder ([ADR-0014](0014-persist-executor-claim-in-raw-deletion-transaction.md),
[ADR-0016](0016-bind-recording-to-link-room-identity.md)). Readiness is "the room appeared", which produced the reported "waiting for local link"
state and a slow second tab (45 s polling deadline, out-of-process `omp` calls). Ownership absence is defined through the room
([ADR-0035](0035-distinguish-a-recorded-process-from-a-later-occupant-of-its-pid.md), [ADR-0036](0036-release-an-unresolvable-launch-attempt-explicitly.md),
[ADR-0037](0037-stop-a-recorded-broker-owned-managed-child-without-a-chat-runtime.md)), so a roomless launch can never be proved gone.

The user decided on 2026-09-29 to move the MVP to OMP's `--mode rpc-ui` and to remove Collab completely, with no fallback. Installed OMP 18.4.3
provides JSONL commands/events on stdio (`ready`, id-correlated responses, `prompt_result`, `session_settled`, `extension_ui_request/response`,
`get_state`, `get_entries {since}`, `set_model`, `set_thinking_level`, v2 `rpc_chunk` framing), but: stdin EOF disposes the session and aborts a
running turn; there are no signal handlers and no reattach; events carry no durable entry ids and persistence of `message_end` is queued;
OMP does not prevent two processes writing one file; opening an existing session and exiting appends `session_exit`. The extension must keep
chat processes alive across an extension-host restart and a full VS Code restart (its managed hosts are never auto-stopped).

Constraints: no OMP source change; no ACP (it forces `enableMCP:false`, disabling native MCP discovery); ConPTY cannot carry JSONL; the
single-writer session claim stays mandatory; MCP OAuth consent is out of scope (future companion OMP extension).

## Considered Options

- **A. `rpc-ui` child owned by the existing detached broker through a new `managed-rpc` pipe-child kind, host-owned `RpcSession`,
  disk-first history.** Reuses the detached supervision, authenticated reattach, slot locks and identity of ADR-0024/0031; survives host and
  VS Code restarts; readiness is the `ready` frame. Cost: a broker protocol addition, a client/session state machine, and a projection into the
  existing transcript rendering.
- **B. Spawn `rpc-ui` from the extension host directly (OMP's own `RpcClient` model).** Simplest; but EOF on host exit aborts the running turn
  and kills the session, so an extension-host restart destroys work. Rejected.
- **C. `rpc-ui` inside the existing ConPTY broker.** Reuses everything but corrupts JSONL (stderr merged, CRLF translation, echo). Rejected.
- **D. ACP.** Rejected: forces `enableMCP:false`.
- **E. Keep Collab.** Rejected by the user.
- **F. Read history only through `get_entries`.** Cannot show a stopped session and ties restore latency to OMP startup and large responses.
  Rejected in favour of reading the session JSONL first (A).

## Decision Outcome

Choose **A**, with these concrete commitments (details in the [design](../designs/2026-09-29-rpc-ui-chat-and-sessions.md)):

1. **Process model.** One `omp --mode rpc-ui --session <exact file>` process per conversation, `cwd` = the session header cwd when enterable (a new session starts without `--session` in the folder and learns its exact path from `get_state.sessionFile`, available before the file exists). The broker gains kind `managed-rpc` (pipes, no PTY, no screen model) through **additive, kind-gated frame types; `PTY_PROTOCOL_VERSION` and `PTY_RUNTIME_VERSION` are not bumped**, so surviving previous-build `managed-omp` and `folder-shell` brokers stay reachable. It keeps a bounded ring of stdout lines with monotonic sequence numbers (4 MiB / 2048 lines, sized against the existing `PTY_MAX_SEND_QUEUE_BYTES`; one per-connection cursor, replay and live delivery paced by `drain`), supersedes `message_update` per open `messageId`, pins unanswered `extension_ui_request`s in a reserved budget (never displaced; `pinnedOverflow` reported) and small open message/tool skeletons in a separate one outside eviction, sends lines as base64 fragments budgeted by encoded size under the 256 KiB IPC limit, gates stdin writes by input ownership, and keeps a stderr tail for diagnostics only. The broker — not each client — negotiates protocol v2 once after `ready`. Reattach reuses the authenticated record/HMAC/identity/slot-lock machinery. `managed-omp` remains a readable legacy kind that is never launched again.
2. **Lifetime.** A managed rpc child is never auto-stopped. Closing a tab detaches the view; the host keeps the session attached. Graceful stop
   is closing the child's stdin (a running turn is aborted and persisted as aborted); force stop keeps the ADR-0029 honesty. Turn cancellation is
   rpc `abort`, distinct from stopping the session.
   [ADR-0050](0050-retain-uncertain-input-and-confirm-exact-file-restart.md) adds separately confirmed recovery for an owned, saved Chat binding whose native state is unanswered. Reconnect retains the process; Restart retains complete bounded current/original text, obtains force-stop consent and proves exact-root exit before reopening the same file. It never automatically resends uncertain input or claims every independently running tool has stopped.
3. **Runtime ownership.** The extension host owns an `RpcSession` per running conversation; a Webview is a view. One pure reducer (`ChatModel`)
   runs in the host and the page. Rendering is extended by the [TUI-parity design](../designs/2026-10-01-tui-parity-transcript.md): local native entries, semantic transcript/tool cards, AGENTS/TODO HUDs and read-only child history replace the original `todo-plan` reuse; broker ownership and transport are unchanged.
4. **History and resync.** The session file is read directly first (fast paint; the only source for a stopped session; view-only never starts a
   process because opening in rpc-ui writes `session_exit`); then `get_state` and `get_entries {since}` add only the delta. Live frames feed pending rows
   reconciled to durable entries by role and message timestamp; unmatched rows are flagged, never dropped or duplicated. `message_update` frames are
   coalesced per `messageId` before crossing the Webview boundary.
5. **Witnesses.** Session-claim, per-tab gate, catalog and stopped-intent rules are unchanged. `RecordedHost` gets a persisted `transport: "rpc"` discriminator plus the child/broker identity; `instanceId`/`generation` stay as parse-only legacy fields, and legacy is `transport !== "rpc"`. Absence evidence is accepted per transport: rpc rows accept only the broker's report that the recorded child exited or the recorded broker and child (pid + kernel creation time) both proven absent; a legacy broker-owned row accepts an authenticated broker report that its recorded child exited (slot and pid matched); the room-based `recorded-host-and-process-gone` kind is kept only as a parse-only kind that the ADR-0035 discriminator can no longer satisfy in practice, and everything else stays `owner-unknown` or explicit Release. A live orphan child is blocked and never signalled. `omp collab list|link`, native-switch witnesses and the room-loss recovery are removed.
6. **Legacy.** Collab-era rows and hosts are shown as running-legacy or unresolved, blocked for mutation, with restored old tabs rendered as a fixed
   non-connecting explanation; the extension never kills, adopts-and-drives, migrates or duplicates them. The explicit user-confirmed Stop for a legacy broker child and
   the explicit Release remain, using only non-Collab witnesses.
7. **Removal.** Collab, the relay, the raw recorder family, the guest wire stack, the Hub, the Chat|TUI switch, draft-promotion lookups and the
   native-switch watcher are deleted with tests and docs, with no shim or fallback. The folder shell, catalog, claims, bridge stack, usage/settings/
   diagnostics panels and notifications stay.
8. **Host control.** The authenticated host-control pipe is kept for the config-layer snapshot (Settings), names-only tool catalogue and file-observation hooks,
   none of which rpc replaces. Its model/thinking mutation (`setModel`, `setThinking`, `listModels`, request ledger) is replaced by rpc `set_model`,
   `set_thinking_level`, `get_available_models`, `get_available_thinking_levels` and deleted.
9. **Non-goal.** MCP servers that need a fresh interactive OAuth consent are not supported by this change; a future companion OMP extension owns them.

### Consequences

- Positive: readiness is the child's `ready` frame, removing Collab polling and the relay; restore shows history from disk independent of OMP
  startup; absence proofs become positive kernel/broker facts, so the roomless-launch deadlock disappears; about 15.6k lines of Collab-only code are deleted; the
  extension host sees activity and approvals for sessions without an open tab.
- Negative: the broker protocol and client grow (additive kind-gated frames, fragmenting, new kind); `extension.ts` and `session-index.ts` need a coordinated cutover; chat content
  correctness depends on reconciling live frames with lagging persistence; stdout volume from unthrottled `message_update` frames must be bounded by supersession and coalescing; legacy processes started by the previous build can only be explained, not driven;
  settings/tool/file-evidence surfaces depend on the host-control module loading under rpc-ui (spike gate); OMP startup time (1.7–30 s observed) is outside our control.
- Supersedes ADR-0002 (Collab guest); narrowly ADR-0011 (roomless-launch rule, pinned guest grammar; the no-version-gate stance and F1–F3 remain); ADR-0004 (model mutation race, now rpc-serialized); ADR-0016 and ADR-0014 (raw recorder); ADR-0017 (Collab-specific bounded diagnostics, principle kept for owned
  surfaces); narrowly ADR-0021 (fileless draft lookup), ADR-0024 (TUI-in-chat, Chat|Terminal), ADR-0025/0026 (native switch), and the Collab-witness clauses of ADR-0031/0033/0035/0036/0037.

## Related Documents

- [Design: RPC-UI chat and Sessions](../designs/2026-09-29-rpc-ui-chat-and-sessions.md)
- [ADR-0024](0024-own-omp-pty-for-in-tab-terminal.md), [ADR-0031](0031-reattach-a-surviving-managed-host-through-its-broker.md), [ADR-0023](0023-reconnect-surviving-webviews-through-an-authenticated-bridge.md),
  [ADR-0029](0029-report-uncontained-pty-tree-stop-as-unknown.md), [ADR-0015](0015-serialize-tab-lifecycle-through-one-gate.md)

## Architecture Review

- Reviewer: architect (separate, disposable agent)
- Outcome: accepted after two review rounds; the choice of approach was never in question.
- Round 1 (accept-after-changes; approach unchanged): five material findings and sixteen minors. M1 the PTY protocol-version bump would strand surviving previous-build brokers — resolved by no bump, additive kind-gated frames and a previous-build-broker acceptance test. M2 fragment size versus the 256 KiB IPC limit and the wrong premise about backlog bounds — resolved by base64 fragments (≤128 KiB encoded) and drain-paced replay against the existing `PTY_MAX_SEND_QUEUE_BYTES`. M3 quadratic `message_update` volume filling the ring — resolved by per-`messageId` supersession, host-side batch coalescing, stripped `assistantMessageEvent`, and an S0 measurement. M4 `RecordedHost` schema and legacy discriminator — resolved by a persisted `transport: "rpc"` field and parse-only legacy fields. M5 pending dialogs lost to ring eviction — resolved by pinned dialogs. Minors m1–m16 (v2 required for binding, decoder reset on attach, blocking-read/serial-queue constraint, slash deny-list instead of catalog refusal, extra event mappings, epoch nonce, prompt exactly-once terminal outcome, keep `guest-config.ts`/`terminal-presence.ts`, real reconciler ports, reuse of `canonicalizeExistingAncestor`, header version < 3, reveal glue refinement, ADR-0011/0007/0028/0032 listing, `setTitle`, `PI_NO_PTY`, broker-death job-kill inference) were applied.
- Round 2 (confirming pass, accept-after-changes): M1–M4 confirmed resolved; two narrow material findings remained — R1 (pinned budget shared between dialogs and skeleton lines; missing `toolCallId` extraction) and R2 (legacy absence evidence contradiction across §4/§5/ADR) — plus minors m-a…m-f. The reviewer stated it would accept without another full pass once they were specified as it recommended. They were applied as specified (reserved dialog budget with `pinnedOverflow`, skeleton pin ≤64 KiB, `toolCallId` head pattern; per-transport absence-evidence table; per-connection cursor and honest quadratic-IPC wording; kind gating both ways and no new staged-tree file; ADR/ADR-0011 wording). **No third reviewer pass was run on those last edits**; they follow the reviewer's own recommendations verbatim.
- Open items carried into implementation (not review findings): slice S0 spike results must be recorded here before the implementation is accepted.
