---
status: superseded
date: 2026-09-26
---

# ADR-0024: Own the OMP PTY outside the Webview and render it in the chat editor

> Narrowly superseded by [ADR-0038](0038-host-chat-over-rpc-ui-on-a-broker-pipe-child.md) for everything that put the native TUI in the chat editor: the Chat | Terminal switch, the managed `managed-omp` PTY child and its Collab pairing. Still operative by reference: the detached, authenticated broker, staged runtime, identity and slot-lock machinery (now also hosting the `managed-rpc` pipe child), the folder shell, and ADR-0029/0030 semantics.

> Partly reinstated by accepted [ADR-0040](0040-switch-one-editor-between-rpc-chat-and-native-pty.md): managed native PTY and same-editor Chat/Terminal presentation, without Collab or same-PID view switching. Implemented in source with headless and owned real-OMP evidence; installed-window acceptance remains separate. Folder-shell authority remains separate.

> Narrowly amended by accepted [ADR-0043](0043-place-session-mode-actions-in-editor-title.md) for managed in-pane controls: mode navigation and Copy Screen move to the native editor title. [ADR-0044](0044-resynchronize-on-stream-discontinuity-and-retain-broker-ownership.md) refines stream recovery and broker-authoritative frontend ownership. Mode/writer lifecycle and independent folder-shell authority remain unchanged.

## Context and problem statement

The accepted native host runs in a hidden VS Code `Terminal`, while its Collab guest renders the GUI in a Webview editor. VS Code's terminal API can reveal the terminal in an editor group, but it opens a **different editor tab** and does not expose an existing ordinary terminal's bidirectional PTY stream to the Webview. The user requires the genuine native OMP TUI and chat to replace one another **inside the same editor tab**, with no second OMP writer. Closing the editor must leave the process running; a verified surviving host must be reattachable across an extension-host restart.

## Considered options

- Keep the hidden VS Code terminal and show it in the editor area: preserves VS Code's renderer and current host lifetime, but cannot satisfy same-tab switching or supply its stream to xterm.js.
- Launch OMP under an extension-owned PTY broker independent of the editor/extension-host lifetime and render its output in xterm.js inside the existing Webview: gives one true TUI and one GUI in one editor, but adds a process supervisor, native PTY packaging, screen-state recovery and lifecycle migration.
- Run `rpc-ui` and imitate a TUI: cannot render the native TUI of the same interactive OMP process.

## Decision outcome

For new managed hosts, resolve the installed OMP as before and launch its actual executable under a supervised, extension-owned PTY broker. Preserve exact PID/process generation, local Collab overlay, authenticated native host-control bootstrap, profile/cwd/session arguments, and SessionIndex writer claims. The broker owns the child and PTY across Webview closure and extension-host-only reload; the editor is merely a generation-authenticated terminal frontend. Bundle a terminal renderer in the existing chat Webview with permanent **Chat | Terminal** controls. Hidden views do not become writer processes. One active frontend controls PTY input/resize; a reconnect receives a consistent bounded screen snapshot/replay. Closing a managed chat editor detaches; it does not stop the broker or OMP. An explicit verified Close/Reload, or native OMP exit, changes process lifecycle. A complete VS Code exit need not preserve the native PID: on a later activation adopt a proven surviving broker/OMP writer or verify that it stopped before any new exact-file writer is started. Uncertainty retains the claim and a blocked row; explicitly stopped rows never auto-restart.

Extend ADR-0023's authenticated, versioned document bridge with **separately authorized terminal I/O DTOs**, rather than assuming existing model/thinking/Tools requests can execute terminal commands. Panel-bound Webviews may use the verified VS Code message channel; after an extension-host-only restart, a surviving page without a panel handle uses its existing authenticated bridge. The extension host gates either path on actual editor membership, current document incarnation, workspace/index owner, native PID **and creation time**, broker generation and the reserved draft or exact-file claim. Terminal input/resize is permitted for a verified fileless draft with its reserved claim; this does not lift the materialized-file gate for model/thinking/Tools. Only the broker holds PTY/process capabilities; Webview persisted state remains identity-only, and a retired document or editor binding cannot issue input. Broker-client transport is independently authenticated and generation-fenced; a broker PID or disconnected frontend is not evidence that its OMP child exited.

`Open Terminal` in a **folder's** context menu opens a separate shell PTY at that folder, not the managed host's TUI. Running `omp` there is a user-owned terminal operation and does not automatically adopt the extension's Collab/host-control capabilities or create a managed Sessions row. Its saved file can later be discovered by the folder's ordinary Resume. The project does not need a second VS Code integrated terminal rendering the managed OMP process.

Folder-shell editors have a distinct lifecycle from managed chat editors. VS Code exposes only post-disposal events for a WebviewPanel; an active shell's native tab-close cannot be vetoed. Persist the exact recoverable shell slot **before** awaiting the post-close prompt and retain it through any detached, pending, interrupted or uncertain-stop state until the exact tree's exit is proved. Only an affirmative Confirm authorizes stopping the verified shell process tree (including manually launched OMP); Keep Running creates a new editor attached to the **same** broker/PID/screen, not a new shell. A dismissed/interrupted prompt, failed recreation or failed/uncertain stop keeps the shell slot reachable. The folder's conditional **Reconnect Terminal** context action selects a detached shell (picker if multiple) and attaches only to its verified broker; `Open Terminal` still launches a new shell. A clean shell exit needs no confirmation. A **proven full VS Code exit** can retire the shell broker's own tree after finite orphan grace; frontend/extension-host loss alone cannot start that grace or terminate a managed OMP broker.

On the current prebuilt Windows ConPTY backend, [ADR-0029](0029-report-uncontained-pty-tree-stop-as-unknown.md) narrowly governs the **incomplete** tree-stop implementation: an explicit Confirm attempts termination and preserves the slot with `tree: unknown` or `remaining` when exact descendant exit cannot be proved. This does not remove the positive exact-tree criterion above. [ADR-0030](0030-watch-the-verified-owning-vscode-process-for-shell-grace.md) defines the distinct owning-instance lifetime evidence and finite shell-only orphan grace; a frontend or extension-host disconnect is never sufficient.

This decision supersedes ADR-0002's hidden VS Code terminal ownership but **retains** its local-only Collab guest, one native OMP process, authoritative host dialogs and protected control link. Existing processes under the old VS Code terminal cannot have their PTY taken over: leave them intact until they exit and use the new launcher only for subsequent sessions. Do not use process restart as an invisible migration.

Apply ADR-0012 to the new broker **and its entire native runtime load tree**: stage its JS entry, PTY addon, helper executables/DLLs and other runtime-loaded files from a verified, content-identified private copy outside the installed extension directory, retaining copies while a child may still use them. Select and prove a matching broker runtime/native-addon ABI on packaged Windows before enabling launch, reattachment or reinstall. An incompatible surviving broker must be retained and reported unavailable, not silently restarted over its still-running writer. VS Code continues to own editor membership and serializer revival under ADR-0019.

### Consequences

- Positive: the user can switch between native TUI and GUI within the very same editor tab without changing the live PID.
- Negative: package and supervise a native PTY implementation and independent broker; preserve an authentic screen, lifecycle, process-identity and credential boundary across reload. Verify Windows runtime/package compatibility and do not claim unexercised cross-platform parity.
- Negative: VS Code no longer owns the managed terminal's own persistence or rendering. `vscode.Terminal.processId`, `.dispose` and terminal-close events must be replaced in affected code, without weakening ownership proofs. A folder shell is intentionally not a hidden managed agent.

## Related documents

[Sessions and in-tab terminal design](../designs/2026-09-26-sessions-and-in-tab-terminal.md); [ADR-0029](0029-report-uncontained-pty-tree-stop-as-unknown.md); [ADR-0030](0030-watch-the-verified-owning-vscode-process-for-shell-grace.md); [ADR-0002](0002-local-collab-gui-native-omp.md); [ADR-0012](0012-run-child-process-entries-from-staged-copies.md); [ADR-0019](0019-vscode-owns-omp-editor-persistence.md); [ADR-0023](0023-reconnect-surviving-webviews-through-an-authenticated-bridge.md).

## Architecture review

- Reviewer: independent architect (initial review, re-review, shell-close review and corrective confirmation).
- Outcome: accepted after resolving private native runtime staging, authenticated terminal bridge, broker-orphan reconciliation and every post-disposal folder-shell recovery branch.
- Notes: Review accepted the architecture, not a packaged PTY runtime or installed-Webview acceptance result.
