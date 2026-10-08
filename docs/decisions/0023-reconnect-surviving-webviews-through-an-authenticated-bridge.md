---
status: accepted
date: 2026-09-25
---

# ADR-0023: Reconnect surviving Webviews through an authenticated host bridge

> Amended by [ADR-0038](0038-host-chat-over-rpc-ui-on-a-broker-pipe-child.md): the bridge transport, identity and mutation ledger are unchanged; the payload it carries is now the rpc-ui chat message family instead of Collab frames, and the "relay unavailable" fallback documents are replaced by in-page phases.

## Context and Problem Statement

The user works inside this extension's own OMP Webview and expects both **Restart Extensions** and **Reload Window** to continue the same session without manual Open/Resume or restarting native OMP. The surviving Webview can continue its encrypted direct Collab chat after a host-only restart, but VS Code gives the new extension host no `WebviewPanel` handle to that already-resolved editor. Its current VS Code `postMessage` controls are dead, and the Sessions tree excludes entries with no bound panel. A lost panel handle is not a prohibition on browser-to-host network communication. The installed OMP guest Collab protocol cannot perform the current authenticated set-model/set-thinking and tool-catalogue operations.

[ADR-0019](0019-vscode-owns-omp-editor-persistence.md) makes VS Code's actual editor membership authoritative and keeps native claims independent. [ADR-0021](0021-reattach-a-verified-live-draft-on-activation.md) allows attaching to a verified surviving fileless draft without launching another native process. Neither decision promises re-binding of a resolved `WebviewPanel`. The [rejected ADR-0022](0022-replace-orphaned-webview-editors-after-host-restart.md) proposed closing that tab and creating a replacement; its guest-bridge alternative was incorrectly dismissed because it cannot recover the *panel handle*. The user's question calls for retaining the actual running tab if possible.

## Considered Options

- **Force Reload Window after every host restart:** serializer re-creates a controlled panel but fails the requested automatic built-in Restart Extensions path.
- **Close and replace surviving editors:** restores WebviewPanel APIs but discards running page/composer, complicates lazy serializer and concurrent close ordering; not necessary for chat, controls or Sessions membership.
- **Rebind the original panel through public VS Code API:** impossible for an already-resolved Webview after its host generation disappears; serializers revive unresolved saved inputs, not arbitrary resolved editors.
- **Send host controls over native Collab:** requires a new installed/native guest-control protocol, expanded grants and a restart of already-running OMP to load it; not a transparent same-process extension update.
- **Add a narrow authenticated browser-to-extension bridge:** keeps the live page and native Collab socket and forwards only current control DTOs to the new host's already peer-verified native channel. Chosen, subject to installed-version runtime gates.

## Decision Outcome

**Proposed:** future OMP Webview documents know one exact loopback bridge origin before creation. The extension retains that non-secret endpoint for each indexed tab across extension-host generations and rebinds it on activation. A separate random document secret, held in host SecretStorage and browser memory only, authenticates a versioned mutual handshake and per-message protected, sequenced control frames. Persisted Webview state stays identity-only; no Collab link, native host-control key, reusable secret or native authority is embedded in type/state/URL. A port occupant unable to authenticate is a failure, never a reason to scan or connect to another service. The page independently retries its host bridge while retaining its direct native Collab connection and composer.

A browser-supplied tab ID is a lookup hint. Every accepted request must pass current workspace, document incarnation, exact live editor membership, indexed owner/holder, verified native process and exact materialized session-file checks; fileless Controls keep their existing wait. Only existing model/thinking snapshots and mutations and read-only Tools catalogue are allowed. The existing mutation ledger remains in force; uncertain mutations are not resent after bridge disconnect/restart. Close, generation change and owner transition fence prior document connections and responses. The bridge never launches, kills or switches OMP as a repair side effect.

Give newly created tabs versioned identity-bearing Webview types and validate actual `TabGroups` membership independently of lost panel handles. Rebuild Sessions from that membership plus verified document/native state, never a saved open-tab list or heartbeat. VS Code still owns editor existence and normal Reload Window serializer revival. **Narrow migration exception to ADR-0019:** `WebviewPanel.viewType` is readonly, so a validated legacy `omp.session` panel supplied to its serializer cannot acquire the new type in place. On that panel's first post-upgrade deserialization, create one versioned successor in its group and retire only that exact supplied legacy panel, with saved-editor/duplicate precedence and no additional native operation. Migration is lazy for hidden panels; group is best-effort, and exact tab order/pinned state and unsent input are not preserved. A user close observed before successor publication cancels migration; the public close API cannot distinguish a truly simultaneous user close from the migration's own close, so a close overlapping the commit cannot be promised strict close-wins. A pre-bridge resolved orphan cannot be retrofitted and needs one Reload Window, not a guessed session-to-tab pairing. No editor is reopened merely because a port, secret or indexed row persists. A recovered orphan does **not** regain panel-only `reveal`, title/icon and disposal APIs: Sessions shows the row and controls, but Focus instructs the user to select the already-open tab rather than fabricating another editor.

**Fallback-document identity, and the one legacy state it recovers.** Every document the host builds for a versioned editor names that editor's own `(tab, editor)` namespace: the guest document through its meta tag and bridge ticket, and the bounded fallback/explanation document a panel shows while its relay or bridge is not ready through an inline bootstrap that persists the full version-2 state. A document that cannot name a valid identity saves nothing instead of a weaker one; a guest document with no bridge ticket keeps the version-1 state, because it has no editor id to write. An editor an earlier build already left with the version-1 `{version:1,tabId}` state *on a versioned type* is adopted once when, and only when, the editor's own registered view type, the saved tab and the durable **controlling** editor-slot binding all name the same `(tab, editor)` pair: it is bound exactly as a version-2 revival (same reservation and one-writer rule, no claim change), and its next document writes the version-2 identity. A missing or unrecognized view type, a mismatched tab, or an absent, passive or foreign binding is refused exactly as before, and an unidentified editor still persists nothing. The legacy `omp.session` type keeps its own version-1 identity, including when its migration is refused, so its serializer can still restore it.

## Consequences

- Positive: after the upgraded guest has loaded once, Restart Extensions can restore Controls and Sessions in the same live tab while chat, unsent input, native PID and Collab room remain intact; ordinary versioned editors continue to use serializer revival on Reload Window.
- Positive: the native control key and existing claim/exact-file/peer-verification boundaries remain on the extension/native side; replacing a tab is not required for control recovery.
- Positive: an editor whose earlier document saved the version-1 identity on a versioned type is restored once its own view type and durable controlling binding prove that pair, without guessing a session, without a second writer and without persisting anything for an editor it cannot identify.
- Negative: a new authenticated localhost protocol, endpoint lifetime and dynamic editor identity must be maintained and security-tested. An occupied exact port, missing secret, incompatible old page or unverified owner leaves controls unavailable rather than opening a duplicate or weakening authentication.
- Negative: an orphan's panel-only operations remain unavailable; generic legacy tabs require a first Reload Window and a one-time serializer-authorized **editor replacement** as each saved panel resolves. This is not replacement of a surviving bridge-capable page during Restart Extensions. Group placement is best-effort; exact order, pinned state, unsent input and strict close-wins during the migration's unobservable commit race cannot be guaranteed. One Reload Window cannot retroactively preserve already-orphaned old JavaScript.
- Constraint: no runtime-feasibility claim until isolated VS Code 1.139.1 proves CSP/origin, exact port rebinding, tab-view-type identity, two-tab closure behavior and a live native reattach. The [design](../designs/2026-09-25-reconnect-live-webviews-after-host-restart.md) specifies protocol, rollout and acceptance in detail.

## Related Documents

- [Authenticated Webview reconnection design](../designs/2026-09-25-reconnect-live-webviews-after-host-restart.md)
- [ADR-0019](0019-vscode-owns-omp-editor-persistence.md) — its VS Code membership and serializer rationale remains; the one-time legacy serializer replacement above is a narrow superseding exception to supplied-panel adoption, to be linked from ADR-0019 on acceptance.
- [ADR-0021](0021-reattach-a-verified-live-draft-on-activation.md) — verified fileless native attach, no automatic draft launch.
- [ADR-0006](0006-host-generated-key-peer-verified-pipe.md) — native control key/peer verification remains separate.
- [ADR-0015](0015-serialize-tab-lifecycle-through-one-gate.md) — per-tab native lifetime serialization.
- [ADR-0022](0022-replace-orphaned-webview-editors-after-host-restart.md) — rejected replacement alternative, not current architecture.

## Architecture Review

- Reviewer: an independent read-only document review with a corrective re-review.
- Outcome: **ACCEPT** after explicitly choosing and disclosing the narrow legacy serializer replacement exception.
- Notes: The earlier live-page bridge architecture consultation was design research, not this document review. Acceptance of the choice does not certify the proposed design's unresolved implementation details or installed VS Code runtime gates.
