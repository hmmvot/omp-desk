---
status: superseded
date: 2026-09-26
---

# ADR-0025: Bind persistent editor slots to current OMP conversations

> Controller clauses narrowed by [ADR-0039](0039-refuse-only-on-a-verified-live-writer-the-extension-owns.md): an unowned stopped/draft editor can control its surface without a writer lease. Verified rival holders and duplicate live-local editors remain fenced; immutable slot identity and generation fencing survive.

> Narrowly superseded by [ADR-0038](0038-host-chat-over-rpc-ui-on-a-broker-pipe-child.md) for native A→B session switching inside one process and the settled-room transfer witness: rpc-ui serves one conversation per process and offers no in-process switch. The immutable editor slot versus mutable conversation binding, and passive editor roles, remain operative.

> [ADR-0040](0040-switch-one-editor-between-rpc-chat-and-native-pty.md) reinstates native A→B binding as best effort, not a settled-room witnessed transfer. Claim acquisition/host-identity move and generation fencing remain required. Implemented in source; installed-window acceptance remains separate.

> **Narrowly amended by [ADR-0045](0045-derive-window-folders-per-window-and-pin-with-identity-ids.md):** the folder list is no longer only explicitly or automatically registered folders; the current window's open folders are shown too (per window, never persisted) and the durable list is the pinned folders.

## Context and problem statement

The current tab ID is both the VS Code editor identity and the indexed conversation identity. The Sessions tree filters on open Webviews and hides an indexed host when its editor closes. Native OMP can change its current session within the same process through `/resume`, `/new` and related TUI actions, while the user requires the **same editor tab** to follow that process to conversation B and conversation A to remain a stopped, resumable row. Folder registration must follow B's verified recorded cwd without altering VS Code workspace membership. A tab ID cannot simultaneously mean immutable A, the enduring editor slot and mutable B.

## Considered options

- Keep tab ID as the conversation key; duplicate the old A record when B takes over: appears smaller but changes A's identity, claim/evidence/recording references and restoration state after the fact.
- Close A's tab and open B's tab: loses literal same-tab switching and any unsubmitted editor state.
- Keep an immutable VS Code editor slot, separate durable A/B conversation records and a generation-bound current binding: requires an explicit transfer lifecycle, but preserves all three ownership boundaries.

## Decision outcome

Keep VS Code as the authority for whether an editor exists, SessionIndex as the authority for native conversation identity and extension claims, and the OMP folder registry as navigation metadata. Add an explicit durable editor-slot→current-conversation binding that may move from A to B while the WebviewPanel and OS process stay put. Never infer the target from the newest file, folder alone or an old Webview credential. Preserve A as a stopped indexed row once its session writer retirement is confirmed, and use B's exact file/session ID/cwd, native process generation, Collab room generation and current editor document generation for all GUI controls and Reload. A previously closed editor does not remove a live or stopped conversation row. If a live editor was closed, its row reopens a fresh editor document attached to the same verified native process, not a new writer. A session with unknown ownership remains visible but blocked.

A successful native transfer is not established by the early `session_switch` event. Under installed OMP 18.3.0, a **fresh live Collab registry IPC snapshot** for B is served only when its replacement room is current and native `isSessionTransitioning` is false; the replacement launch also waits on the native transition barrier. Correlate that fresh B snapshot to the same OS PID/creation identity and Collab instance, a generation newer than A, authenticated host-control's current exact B file/session/cwd and B's validated header. Persist the editor binding and A's retired-writer intent with this positive normal-path witness **before** releasing A's canonical claim or making A explicitly resumable. A cached link, early event, generic later identity snapshot or room disappearance does not establish retirement. Missing room, mismatch, rollback or interrupted durable commit leaves A visibly Blocked, with its known claim held; B is not falsely published as an extension controller. A later user-typed transition back to A is the user's native TUI operation under ADR-0026, not a rollback of the settled B witness.

Folders continue to contain no claim or editor ownership. They may be explicitly added, or automatically added **after** a managed native switch to a verified B whose own header supplies an existing usable absolute cwd; canonical aliases deduplicate the same physical directory. Native commands are not vetoed to prepare the folder; validate B's actual cwd after the native transition, and a failed durable registration leaves a visible blocked/retry state rather than a fictitious pre-transition veto. Auto-registration changes OMP Sessions for the current workspace context, **not** VS Code workspace roots. Empty registered folders remain. Manual folder removal is refused while their managed hosts run; it never removes transcript files.

The tree shows indexed running then stopped conversations under each folder, with a stored OMP title or stable `New session N`, icon-based agent state, and native last-selected TreeView highlight. Resume separately scans all discoverable OMP files for the folder regardless of whether SessionIndex previously knew them. Forget removes only an indexed row, not the file or its eligibility for Resume. If B already has a stopped editor with unsent text, preserve it as a non-controlling, copyable surface while the initiating editor becomes B's sole controller **only when its new binding is verified and B has no incumbent live owner**; otherwise the newcomer is visibly conflicting/noncontrolling. Retire command credentials of passive editors without discarding their drafts.

This replaces ADR-0020's **explicit-only folder and open-editor-only child projection**, while retaining its separation of folder metadata from native/session/editor authority. ADR-0019's VS Code ownership of editor existence remains, but a serialized editor's current native conversation resolves from its committed binding rather than its original A. **Narrow exception to ADR-0019/0023 duplicate-editor precedence:** restoration arbitration applies to duplicate representations of the **same immutable editor slot**, not to distinct editor slots referencing B. Persist which slot is B's controller and which is the passive, draft-preserving reader; lazy serializer callback order cannot elect the stale B slot, dispose its unsent draft or grant two controlling credentials. Neither slot is manufactured solely from an index record.

### Consequences

- Positive: editor close and native conversation switch no longer erase a discoverable session row; a user may navigate both A and B without ambiguous claims.
- Negative: a transfer, rollback, extension-host reload and old-document credential retirement must be generation-fenced and recoverable. Stopped-editor duplicate handling is explicit rather than silent editor disposal.
- Negative: auto-registering B can re-add a folder the user removed if the user subsequently enters a managed native session there; background history scans do not re-add folders.

## Related documents

[Sessions and in-tab terminal design](../designs/2026-09-26-sessions-and-in-tab-terminal.md); [ADR-0018](0018-resume-imported-history-under-extension-claims.md); [ADR-0019](0019-vscode-owns-omp-editor-persistence.md); [ADR-0020](0020-separate-folder-navigation-from-session-ownership.md); [ADR-0026](0026-best-effort-native-tui-switch-ownership.md).

## Architecture review

- Reviewer: independent architect (initial review, re-review and latest review).
- Outcome: accepted after settling the fresh live-room retirement witness, duplicate-editor role arbitration and latest user-controlled native-command boundary.
- Notes: This documents intended editor/claim semantics; runtime/native-switch acceptance remains to be exercised.

> **Narrowly superseded (proposed):** [ADR-0034](0034-store-sessions-in-one-profile-catalog.md) makes the folder a verified native switch auto-registers profile-wide instead of "for the current workspace context". The verified-cwd requirement, the editor/conversation distinction, passive-editor arbitration and the witnessed-transfer rule remain operative.
