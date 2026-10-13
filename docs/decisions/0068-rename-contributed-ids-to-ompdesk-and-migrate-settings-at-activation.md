---
status: accepted
date: 2026-10-13
---

# ADR-0068: Rename contributed ids to `ompDesk.` and migrate settings at activation

## Context and Problem Statement

OMP Desk contributes 95 commands (92 of them published in 0.3.2), 13 settings, one view container, seven views and about twenty context keys under the bare `omp.` namespace, which belongs to Oh My Pi, and labels every command `OMP` in the palette. The maintainer decided to publish under the product's own namespace and category `OMP Desk` and to lose no user data. The change is breaking for users' settings and keybindings, and VS Code gives an extension no declarative settings migration and no write access to `keybindings.json`. The design ([extension namespace](../designs/2026-10-13-extension-namespace.md)) holds the measurements this decision rests on.

## Considered Options

- **Prefix `ompDesk.`**: camelCase product name, VS Code's convention for multi-word extensions (`gitlens.`, `githubPullRequests.`). **`omp-desk.`**: the extension name, but unconventional as a namespace. **`desk.` / `ompd.`**: too generic or cryptic.
- **Webview view types**: (a) keep the persisted ones (`omp.session*`, `omp.shellTerminal`, `omp.settings`) and rename the two that are not persisted (`omp.detail`, `omp.stats`); (b) rename everything and orphan open editors; (c) rename, replace restored editors (the flow ADR-0022 rejected); (d) rename for new editors and keep serializers for the old types.
- **Persisted keys** (Mementos, catalog records, SecretStorage): keep, or copy to new keys with fallback reads.
- **Settings**: automatic migration at activation by an in-memory scan, or a marker-guarded one-time pass, or none; the old keys dropped from the manifest, or kept contributed and hidden; the old value moved, or copied.
- **Keybindings**: (A) a one-time notification; (B) hidden alias commands under the old ids; (A+B) aliases plus a first-use warning and a one-time notice.
- **Compatibility window**: counted in releases, or in dates.
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
5. **Keybindings: A+B, bounded by dates.** The 92 command ids published in 0.3.2 and the generated view commands (`workbench.view.extension.omp`, `omp.<view>.focus`) stay registered, uncontributed, as aliases that forward arguments and the result to the new command; they are registered first in `activate`, each in its own `try`. The first use per extension host warns once with an **Open keybindings.json** action and every use is logged. The three old skip-shell ids stay in `configurationDefaults`. The context keys `sessionMode`, `streaming` and `composerPopupOpen` are also published under their old names. A one-time notice on the first activation in a profile that ran an earlier release tells users what moved. Aliases, the mirror and the old skip-shell ids are removed in the first minor release published on or after **2027-01-13** that is at least the second minor release after introduction; the settings migration and the hidden deprecated keys in the first minor release on or after **2027-04-13**. `-omp.*` removal entries, other old context keys, `when` clauses on view ids and `settingsSync.ignoredSettings` entries added by hand are the user's to edit and are named in the changelog.
6. **Documentation.** README, architecture, product and publishing documents use the new names; dated, accepted designs and ADRs keep the names current when they were written, and `docs/README.md` lists exactly what moved and what did not.

### Consequences

- Positive: no collision with Oh My Pi's namespace; the palette reads `OMP Desk: …`; no setting is lost; existing bindings keep working through the compatibility window; open editors survive the update untouched; profiles and Settings Sync keep their behavior for the old keys.
- Negative: two namespaces remain in the manifest (`ompDesk.*` ids and the `omp.session*` view types, plus `omp.`-prefixed private keys); a migration rewrites User and committed Workspace settings files; the OMP Desk views' collapsed/order/location state resets once; custom `when` clauses beyond the three mirrored keys and `-omp.*` removal entries break at the update; a window open on the previous release during the update reads defaults for moved settings until it reloads; Settings Sync to a machine on the previous release loses the moved keys until it updates; the alias table and migration must be deleted on the dates above; 13 hidden deprecated keys stay in the manifest until then.

## Related Documents

- [Design: Move OMP Desk out of the bare `omp.` namespace into `ompDesk.`](../designs/2026-10-13-extension-namespace.md)
- [ADR-0022](0022-replace-orphaned-webview-editors-after-host-restart.md) (rejected): why a view-type rename is not worth the replacement flow.
- [ADR-0023](0023-reconnect-surviving-webviews-through-an-authenticated-bridge.md): per-editor view types.
- [ADR-0062](0062-render-the-settings-view-from-the-contributed-schema-in-a-webview-view.md): the Settings view follows the contributed keys.

## Architecture Review

- Reviewer: architect
- Outcome: accepted after independent review
- Notes: the reviewer found five material issues in the first draft, all resolved above: (1) dropping the old settings from the manifest lost application-scoped values in non-default profiles and Settings Sync exclusion, so they stay contributed and hidden and the two name lists are migrated first; (2) moving a value strands windows still on the previous release, kept as the maintainer's move rule and disclosed; (3) another extension's `omp.` names are never touched; (4) the window is counted in dates, not releases; (5) a source-literal test and an upgrade check with persisted view types are required. Smaller findings (aliases for generated view commands, registered first; a one-time notice; skip-shell ids; the hyphen claim; untitled workspaces; a bounded wait; 92 published aliases only) are applied.
