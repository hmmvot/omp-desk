---
status: accepted
date: 2026-10-02
---

# ADR-0040: Switch one editor between RPC Chat and native broker PTY

## Context and Problem Statement

The user requires either Chat or unmodified native OMP TUI in the same existing session editor, a persisted profile-wide default, top-right controls in both views, and explicit context-menu entry points. OMP chooses interactive TUI or `--mode rpc-ui` per process; simultaneous extension-owned children would write the same native conversation twice.

ADR-0038 remains the decision for Chat's host-owned RPC architecture, but its removal of native TUI/Chat–Terminal mode is no longer the desired product behavior. The existing broker, PTY pipeline, xterm renderer, secure staged host-control extension and immutable editor-slot identity remain usable. The separate folder shell must not become a managed session or acquire OMP writer semantics.

Installed OMP 18.4.4 supplies public idle/queue/async-job state, abort, deferred irreversible `ctx.shutdown()` and title mutation. There is no supported extension transition barrier: `session_switch` precedes awaited work/rollback, and idle alone is only not streaming. Empty sessions may have allocated paths but no durable history. The user approves best-effort native switching and fresh fileless no-turn draft replacement, without OMP/private API changes or synthetic markers. `/restart` can lose control bootstrap; its uncontrolled force-stop has no automatic successor.

## Considered Options

- Switch the existing panel document and replace the process after exact writer exit: reuses current ownership/security/terminal machinery and meets same-tab/native requirements; needs transport-aware lifecycle/restore and truthful native observation limits.
- Add a second terminal editor or external VS Code terminal: simpler surface separation but violates same-tab behavior and fragments ownership.
- Keep RPC and TUI active for one session: fast toggles but violates single-writer invariants.
- Emulate the terminal from RPC events: retains one RPC process but is not the unmodified native TUI.
- Reinstate Collab/Hub/raw recorder: introduces removed, unnecessary transport and still does not avoid process exclusivity.

## Decision Outcome

Retain RPC Chat and add native `managed-omp` broker PTY mode to the same immutable editor slot. Actual mode is durable binding state; default mode is profile globalState. Replace the document credential/view within the same WebviewPanel. Host-retained bounded draft text is delivered only to a ready Chat document; attachment loss is explicit.

Fence all mutation/input independently of the lifecycle gate. Capture under the gate, release it for modal busy consent, reacquire and revalidate. Busy means not settled, including compaction, queued messages and public async-job running/pending-delivery state; missing state is busy. Native shutdown rechecks atomically, calls `ctx.abort()` only with consent and then requests `ctx.shutdown()`. Accepted shutdown cannot be withdrawn; show stopping/still-finishing and never start a successor until exact exit. Queued/background work may defer exit; late exit alone never starts a successor. RPC uses EOF after a final settled check, with its residual wake race disclosed.

Prove native settlement by matched broker child-exit state plus creation-time root absence, never ACK/EOF/bare-pid liveness. PTY stop closes ConPTY and is only an explicit force fallback; tree status remains truthful. Refuse content-without-file **before** settlement. Durable replacement keeps the best-known exact file/id and header cwd. Empty replacement is an explicit leased draft reset after exact root exit and absent file; preserve row/slot/claim, replace session identity, touch no disk. Hold the claim and running intent through replacement; atomically record mode/transport attempt before launch, or mark stopped/release on failure.

Reuse authenticated control and TerminalPane. Native control authority is per-launch process/recipient/control-slot with no session-file handshake expectation; session is observed state and credentials move with the process across row rebinds. Unavailable control (including `/restart`) explains native `/exit` or explicit tree-unknown force Stop. No automatic successor after uncontrolled force; a subsequent explicit Open is required and observed survivors refuse it. Distinguish unsupported methods from lost control.

[ADR-0050](0050-retain-uncertain-input-and-confirm-exact-file-restart.md) narrowly permits a successor after a separately confirmed Restart of an owned, committed, saved Chat/RPC binding whose native state is unanswered. It still requires complete frozen text capture, fresh target/role checks and exact old-root exit proof, and discloses independently surviving tools/file effects. Ordinary Force Stop and native Terminal survivor guards are unchanged.

Restore precedence is live host transport, saved actual mode, default. Reload keeps actual mode. The user's final clarification: normal Open/click reveals an existing tab unchanged; default applies only to tab opening/creation. Stopped single click never starts a child; Terminal shows retained screen/placeholder with explicit start actions. Explicit Open in Chat/Terminal switches an existing tab. Chat-only commands/keybindings are mode-gated so Escape reaches TUI.

Native `/resume`/`new`/branch/tree remain autonomous and best effort. Observed A→B acquires B's claim, moves the live host identity without claiming exit, retires A's host, advances the slot generation and releases A; rollback reverses it. A verified rival makes the newcomer passive/conflicting. Before extension launch, consult this window's authenticated native current-file observations to avoid a positively known own writer overlap; no global ledger/settled native witness. Terminal→Chat resumes the best-known file only after exact root exit; identity may still be stale/speculative.

### Consequences

- Positive: both real native and Chat surfaces are reachable without duplicate tabs, using existing staged/authenticated PTY and RPC machinery.
- Positive: a default is independent of workspace folders; all row-level lifecycle actions resolve the real transport.
- Negative: a view switch replaces the child and document; only bounded draft text travels, with the existing attachment limitation disclosed.
- Negative: native identity observation is best effort, especially during rollback; empty no-turn replacements change native identity because no file exists.
- Negative: Windows exact managed-root writer exit does not establish that every detached tool descendant is gone; ADR-0029's whole-tree limitation remains disclosed.
- Preserved: external/unverified native writers are user-controlled risk under ADR-0039; only positively owned writers are extension-controlled.

Upon acceptance, narrowly supersede ADR-0038's native removal and legacy classification; ADR-0025's witnessed native transfer; ADR-0029's Collab managed-writer/transfer clauses; and ADR-0039's legacy classification and mandatory confirmation for same-window mode replacement (busy consent replaces it; rivals remain blocked). Partly reinstate ADR-0024's managed native child without Collab or same-PID switching. ADR-0026 is already historical/superseded, not a current settled barrier. RPC Chat, removal of Collab/Hub/raw recorder, nonce security and truthful Windows tree limits remain unchanged.

## Related Documents

- [Same-editor design](../designs/2026-10-02-same-editor-chat-and-native-terminal.md)
- [ADR-0038](0038-host-chat-over-rpc-ui-on-a-broker-pipe-child.md)
- [ADR-0024](0024-own-omp-pty-for-in-tab-terminal.md), [ADR-0025](0025-bind-editor-slots-to-current-conversations.md), [ADR-0026](0026-best-effort-native-tui-switch-ownership.md)
- [ADR-0028](0028-stamp-document-nonce-on-renderer-created-styles.md), [ADR-0029](0029-report-uncontained-pty-tree-stop-as-unknown.md), [ADR-0039](0039-refuse-only-on-a-verified-live-writer-the-extension-owns.md)

## Architecture Review

- Reviewer: independent architect
- Outcome: accepted after material finding resolution and confirming F1/F3/F4 spot check.
- Notes: The architect confirms acceptability; the findings E1/E2 were resolved by the author. No further review required.
