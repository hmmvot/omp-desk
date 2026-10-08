---
status: rejected
date: 2026-09-25
---

# ADR-0022: Replace unbound session-specific Webview editors after an extension-host restart

## Context and Problem Statement

The user develops this VS Code extension in its own OMP chat, installs updated builds and uses both **Reload Window** and VS Code's built-in **Restart Extensions** without manually reopening the conversation. The same native OMP process should continue; a replacement GUI tab is acceptable. With the current common `omp.session` view type, the extension-host-only restart leaves the already-resolved Webview on screen but destroys its extension-host panel reference. The user can still talk to OMP through the Webview's direct Collab socket, while the extension cannot project its open tab or answer Controls. VS Code's [Webview lifecycle documentation](https://code.visualstudio.com/api/extension-guides/webview#lifecycle) explicitly rules out regaining a lost `WebviewPanel` reference. Its serializer runs for revived inputs, not an arbitrary already-resolved panel. The public `TabInputWebview` exposes a view type but not the panel's saved `{tabId}`; all existing OMP chat tabs share one type.

[ADR-0019](0019-vscode-owns-omp-editor-persistence.md) made VS Code's saved editor membership authoritative and used a serializer to preserve layout across window restarts. That approach remains correct for Reload Window but does not give the new extension host a handle to a surviving resolved Webview after Restart Extensions. Index rows alone never prove a tab is open.

## Considered Options

- **Only document Reload Window:** uses the existing serializer and preserves placement, but does not meet the user's explicit Restart Extensions requirement.
- **Keep one generic Webview type and infer the session from title or index order:** cannot distinguish multiple open chats safely and may reopen explicitly closed conversations.
- **Use a session-specific Webview type and replace unbound tabs that VS Code still lists:** `TabInputWebview.viewType` supplies the identity hint, while `TabGroups` supplies actual membership. Requires per-type serializer registration, conservative validation and a one-time legacy migration.
- **Migrate to a resource-backed custom readonly editor:** would expose a stable URI in `TabInputCustom`, but rewrites the editor/provider lifecycle and still cannot rebind an already-resolved orphan. Not justified by the current feature.
- **Keep the old Webview alive through an independent guest bridge:** can maintain the Collab transcript but cannot give the new host the old panel reference or safe editor membership; introduces additional capability/security surface.

## Decision Outcome

**Proposed:** encode the index's opaque tab ID in a versioned, extension-namespaced `WebviewPanel.viewType` for each new chat. The view type is an untrusted identifier, **not** authorization or an OMP session file. Register an exact serializer for each relevant type during activation and before new panel creation. Keep `{version:1,tabId}` Webview state and cross-check that it matches the type and this workspace's index on deserialization. Continue to let VS Code decide which editors exist and where; never manufacture open tabs from every index row.

On activation, enumerate actual `window.tabGroups.all` membership. If a recognized indexed OMP tab remains open but no WebviewPanel for that tab was bound in the new extension host, replace that one editor automatically: create a bounded inactive replacement in its group, close the captured old tab, then bind/enable the replacement only after a successful close. A serializer that already adopted a valid saved panel wins; a racing callback or user close must not create a duplicate chat or native host. Retain the native process and exact fileless/materialized ownership checks of [ADR-0021](0021-reattach-a-verified-live-draft-on-activation.md): editor replacement itself never releases a claim, attaches without verification, or launches OMP.

A generic legacy `omp.session` orphan cannot be mapped to a tab ID after extension-host-only restart. Migrate it on the first Reload Window, when its existing serializer receives saved identity and can replace it with an identity-bearing editor; no manual Open is required. Until then show Reload Window guidance, not a guessed chat. The installed VS Code version currently exposes an internal prefix in `TabInputWebview.viewType` even though its public description maps to `WebviewPanel.viewType`; recognize only a validated namespaced identity and prove the mapping in an isolated installed-version test before shipping. An unfamiliar mapping is a visible fail-closed limitation, not permission to close a tab by label.

### Consequences

- Positive: Restart Extensions can recover the same native conversation in a new, controlled editor without asking the user to find its history or restarting OMP; Reload Window retains serializer revival.
- Positive: only VS Code's actually open tabs may be replaced, so deliberately closed indexed sessions remain closed.
- Negative: the old panel object and unsent composer input cannot be preserved; exact tab ordering, pinned/preview state and background selection are not guaranteed by `createWebviewPanel` and `tabGroups.close`.
- Negative: per-session serializer registrations and the target VS Code view-type mapping need focused compatibility tests. The first upgrade needs a Reload Window to identify legacy generic panels; an already-orphaned generic panel cannot be recovered automatically by its type alone.
- Constraint: no callback, tab type or editor title is a writer claim. Only the existing SessionIndex/host reconciliation may deliver a current Collab link or control capability.

## Related Documents

- [Restart Extensions editor recovery design](../designs/2026-09-25-recover-chats-after-extension-host-restart.md)
- [ADR-0019](0019-vscode-owns-omp-editor-persistence.md) — preserved editor-membership and serializer rationale; this proposal would supersede its serializer-only outcome for host-only restart.
- [ADR-0021](0021-reattach-a-verified-live-draft-on-activation.md) — exact native draft reattachment; unchanged by UI replacement.
- [ADR-0015](0015-serialize-tab-lifecycle-through-one-gate.md) — per-tab serialization for native ownership and editor transition.

## Architecture Review

- Reviewer: independent architect, read-only review.
- Outcome: **REVISE** — indiscriminate replacement can displace lazy saved editors after Reload Window; the proposal also lacked a sound close-race contract.
- Notes: This proposal was not accepted or implemented. Subsequent source analysis by a separate architect established that losing the panel handle prevents public panel operations but does **not** prevent a surviving page from authenticating to the new extension host over an independent network channel; its negative claim about guest bridges in the considered options is incorrect. [ADR-0023](0023-reconnect-surviving-webviews-through-an-authenticated-bridge.md) evaluates that alternative. This record remains as a rejected alternative, not current architecture.
