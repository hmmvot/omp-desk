---
status: accepted
date: 2026-10-13
---

# ADR-0068: Rename contributed ids to `ompDesk.` and migrate settings at activation

## Context and Problem Statement

OMP Desk contributes 95 commands (92 of them existed before the rename: the 87 of 0.3.1, the last release, and five added after it for Kill and the Context view), 13 settings, one view container, seven views and about twenty context keys under the bare `omp.` namespace, which belongs to Oh My Pi, and labels every command `OMP` in the palette. The maintainer decided to publish under the product's own namespace and category `OMP Desk` and to lose no user data. The change is breaking for users' settings and keybindings, and VS Code gives an extension no declarative settings migration and no write access to `keybindings.json`. The design ([extension namespace](../designs/2026-10-13-extension-namespace.md)) holds the measurements this decision rests on.

## Considered Options

- **Prefix `ompDesk.`**: camelCase product name, VS Code's convention for multi-word extensions (`gitlens.`, `githubPullRequests.`). **`omp-desk.`**: the extension name, but unconventional as a namespace. **`desk.` / `ompd.`**: too generic or cryptic.
- **Webview view types**: (a) keep the persisted ones (`omp.session*`, `omp.shellTerminal`, `omp.settings`) and rename the two that are not persisted (`omp.detail`, `omp.stats`); (b) rename everything and orphan open editors; (c) rename, replace restored editors (the flow ADR-0022 rejected); (d) rename for new editors and keep serializers for the old types.
- **Persisted keys** (Mementos, catalog records, SecretStorage): keep, or copy to new keys with fallback reads.
- **Settings**: automatic migration at activation by an in-memory scan, or a marker-guarded one-time pass, or none; the old keys dropped from the manifest, or kept contributed and hidden; the old value moved, or copied.
- **Keybindings**: (A) a one-time notification; (B) hidden alias commands under the old ids; (A+B) aliases plus a first-use warning and a one-time notice.
- **Compatibility window**: counted in releases, in dates, or until a named version.
- **Context keys**: drop the old names, or mirror all, or mirror those default keybindings used.

## Decision Outcome

1. **Prefix `ompDesk.`; category `OMP Desk`.** Commands, settings, the debugger section, container, views, context keys, keybinding ids and `when` clauses, menus, `viewsWelcome`, `configurationDefaults`, `onView:` events and generated view commands move by the rule `omp.<x>` → `ompDesk.<x>` (container `omp` → `ompDesk`). A scripted exact-token rewrite applies it; the single mapping is the alias table in `src/wiring/legacy-aliases.ts` and the setting table in `src/wiring/legacy-settings.ts`.
2. **Persisted webview view types stay (option a).** `omp.session`, `omp.session.b2.*`, `omp.shellTerminal` and `omp.settings` are not contributed and not shown; VS Code revives an editor through the serializer of the exact type saved with it, so any rename either orphans open editors, needs ADR-0022's replacement flow, or leaves two namespaces for as long as an old editor is open. Not renamed: the `^omp[.]session` keybinding regex and the `onWebviewPanel:` events. `omp.detail` and `omp.stats` have no serializer and no persisted state, so they become `ompDesk.detail` and `ompDesk.stats`, and a leftover `omp.detail` tab is closed at activation. The three fixed persisted types could in principle collide with another extension's; accepted, because no rename avoids orphaning editors.
3. **Private persistence stays.** Mementos, catalog records, SecretStorage keys, tree element ids and the status bar item id are scoped to this extension by VS Code and invisible to users; renaming them risks the session catalog, claims, broker slots and secrets. OMP-facing names stay. Durable keys added later use `ompDesk.`.
4. **Settings migrate automatically, in memory-scanned, marker-free passes, at the start of every activation** (awaited for at most 10 seconds before any setting is read):
   - the table is the 13 explicit keys; `omp.sessionsGrouping` is live and is mapped, nothing is dropped;
   - **the 13 old keys stay contributed, hidden (`included: false`), deprecated and in their old scope**, so that a non-default profile still sees an application-scoped value, a dead copy is not routed, `omp.executablePath` stays out of Settings Sync and a user's `settingsSync.ignoredSettings` / `workbench.settings.applyToAllProfiles` entries still protect it; before any value moves, those two lists get the new name next to the old;
   - User and Workspace layers: write the new key when it is unset there and the layer can hold it, then remove the old key; an existing new value wins and the old value's removal is logged with its value. **The value is moved, not copied** (the maintainer's rule); a window already open on the previous release reads defaults for a moved setting until it reloads, which the changelog states;
   - values at layers that cannot hold the new key (`application` and `machine` settings in a workspace, the folder layer, `[language]` overrides) never applied before and are left untouched;
   - an old key or command that another installed extension contributes under `omp.` is never read, removed, aliased or mirrored;
   - a read-only Workspace settings file is not written (the permission is checked first, because a failed VS Code write leaves a dirty model); any other failed write is caught; the old value stays and one line says why;
   - one log line per key and layer; idempotent by construction (equal values converge across windows, and a profile migrates when its window activates).
5. **Keybindings: A+B, kept until 1.0.0.** The 92 command ids that existed before the rename (the 87 of 0.3.1, the last release, plus five added on the way to 0.4.0) and the generated view commands (`workbench.view.extension.omp`, `omp.<view>.focus`) stay registered, uncontributed, as aliases that forward arguments and the result to the new command; they are registered first in `activate`, each in its own `try`. The first use per extension host warns once with an **Open keybindings.json** action and every use is logged. The three old skip-shell ids stay in `configurationDefaults`. The context keys `sessionMode`, `streaming` and `composerPopupOpen` are also published under their old names. A one-time notice on the first activation in a profile that ran an earlier release tells users what moved. **Aliases, the mirror, the old skip-shell ids, the settings migration and the hidden deprecated keys are all kept until 1.0.0 and removed in that release** (the maintainer's decision; the reviewed draft proposed the dates 2027-01-13 and 2027-04-13). `-omp.*` removal entries, other old context keys, `when` clauses on view ids and `settingsSync.ignoredSettings` entries added by hand are the user's to edit and are named in the changelog.
6. **Documentation.** README, architecture, product and publishing documents use the new names; dated, accepted designs and ADRs keep the names current when they were written, and `docs/README.md` lists exactly what moved and what did not.

### Consequences

- Positive: no collision with Oh My Pi's namespace; the palette reads `OMP Desk: …`; no setting is lost; existing bindings keep working through the compatibility window; open editors survive the update untouched; profiles and Settings Sync keep their behavior for the old keys.
- Negative: two namespaces remain in the manifest (`ompDesk.*` ids and the `omp.session*` view types, plus `omp.`-prefixed private keys); a migration rewrites User and committed Workspace settings files; the OMP Desk views' collapsed/order/location state resets once; custom `when` clauses beyond the three mirrored keys and `-omp.*` removal entries break at the update; a window open on the previous release during the update reads defaults for moved settings until it reloads; Settings Sync to a machine on the previous release loses the moved keys until it updates; the alias table and migration must be deleted in 1.0.0; 13 hidden deprecated keys stay in the manifest until then.

## Related Documents

- [Design: Move OMP Desk out of the bare `omp.` namespace into `ompDesk.`](../designs/2026-10-13-extension-namespace.md)
- [ADR-0022](0022-replace-orphaned-webview-editors-after-host-restart.md) (rejected): why a view-type rename is not worth the replacement flow.
- [ADR-0023](0023-reconnect-surviving-webviews-through-an-authenticated-bridge.md): per-editor view types.
- [ADR-0062](0062-render-the-settings-view-from-the-contributed-schema-in-a-webview-view.md): the Settings view follows the contributed keys.

## Architecture Review

- Reviewer: architect
- Outcome: accepted after independent review
- Notes: the reviewer found five material issues in the first draft, all resolved above: (1) dropping the old settings from the manifest lost application-scoped values in non-default profiles and Settings Sync exclusion, so they stay contributed and hidden and the two name lists are migrated first; (2) moving a value strands windows still on the previous release, kept as the maintainer's move rule and disclosed; (3) another extension's `omp.` names are never touched; (4) the window was counted in release numbers, which a user who updates late jumps over; it is now a named end point, 1.0.0, set by the maintainer; (5) a source-literal test and an upgrade check with persisted view types are required. Smaller findings (aliases for generated view commands, registered first; a one-time notice; skip-shell ids; the hyphen claim; untitled workspaces; a bounded wait; 92 published aliases only) are applied.

## Amendment 2026-10-13: the move no longer holds activation (implemented; independent review pending)

Measured on the first start after the rename shipped (three windows, a loaded machine): every window waited the full 10 seconds of decision 4 before it activated (window 1's `extension activated` came 10.3 s after its first line, window 3's 10.0 s), with the first write at 0.4 s and the next one 7.4 s later in two windows; the broker state check, the restore and every editor's serializer started 10 s late. That the three windows were slowing each other through the one `settings.json` is inferred from those gaps, not measured. On an idle machine with all 13 keys seeded, one window waited 1583 ms.

Decision 4's order and rules stay (the two name lists first, the new key before the old one is removed, an existing new value wins, foreign names untouched, User and Workspace layers, one log line per key and layer). What changes is when and by whom:

- **Activation does not wait.** With nothing to move, which is every start after the first, the check is synchronous `inspect` reads with no I/O and no wait. With work, the move runs in the background; what must not read a half-moved setting is the first launch of a process (`executablePath`, `linkReminder`), which waits in `brokerClient()` for the move, counted from activation and capped at the same 10 s. Settings that only paint (grouping, folders, detail level) are re-read on a configuration change.
- **One window moves the User layer.** The User layer is shared by every window of the profile, so a window takes a claim file in the extension's global storage (`settings-move.claim`, created exclusively, removed afterwards, ignored when older than 60 s); the others wait for its release, give their own configuration up to 3 s to show the moved values, and take over only if the values are still there. A storage that refuses the claim runs the move unclaimed, as before. The Workspace layer belongs to one window and needs no claim.
- **The keys of a layer move concurrently.** VS Code queues the writes of one file itself; what overlaps is the reload each write waits for. Writes inside one key stay ordered.

Measured in an isolated window with all 13 keys and both name lists seeded (same machine, one window): `activation → catalog adopted` fell from +1583 ms to +126 ms, the move itself finished about 1.1 s after activation in the background, and a start with nothing to move took +71 ms in total (the whole activation up to the catalog). Not measured: three windows at once, which the isolated harness cannot start (one window at a time); the single mover is covered by `src/wiring/legacy-settings.test.ts` and `legacy-settings-claim.test.ts`.

## Amendment 2026-10-18: `omp.sendSelection` leaves the alias table (implemented; independent review pending)

Decision 5 keeps the 92 pre-rename command ids registered until 1.0.0. The maintainer removed the command **Add Selection to Session** in 0.4.7 (`ompDesk.sendSelection`: **Quote Selection to Session** carries the file, the lines and the text, and an `@` mention made an idle OMP read the whole file; [design](../designs/2026-10-18-chat-keys-and-empty-state.md), decision 2). An alias forwards to a contributed command, and `ompDesk.sendSelection` no longer exists, so `omp.sendSelection` leaves `LEGACY_COMMAND_IDS` and `LEGACY_ALIASES`: 91 aliases remain, plus the generated view commands. The table is frozen in the sense that nothing is added to it, not that nothing leaves it when its target is removed by a later decision. A user keybinding that names `omp.sendSelection` (or `ompDesk.sendSelection`) becomes a dead entry, as for any command that no longer exists; the one-time rename notice and the alias warning do not cover a command that was removed, and the release note names it.
