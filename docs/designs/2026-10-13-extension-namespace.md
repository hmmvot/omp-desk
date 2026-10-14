---
status: accepted
date: 2026-10-13
---

# Move OMP Desk out of the bare `omp.` namespace into `ompDesk.`

## Problem

OMP Desk publishes as `hmmvot.omp-desk`, but every id it contributes starts with `omp.`: 92 published commands (`omp.newSession`), 13 settings (`omp.chatColumn`), the Activity Bar container `omp`, seven views (`omp.sessions`), about twenty context keys (`omp.sessionMode`) and the keybinding ids. Commands, settings and context keys are global names shared by every installed extension, and the bare `omp` namespace belongs to Oh My Pi itself: if OMP ships its own VS Code integration, or any other extension names things after OMP, the ids collide. The palette also shows `OMP: …` for every command while VS Code's own generated view commands already say `OMP Desk: …`. The maintainer publishes on the Marketplace and decided: the palette category becomes **OMP Desk**, every user-visible contributed id leaves `omp.`, and existing users lose nothing.

## Goals and Non-goals

- Goals:
  - One new prefix for every contributed command, setting, view, container, context key and keybinding id, and the palette category `OMP Desk`.
  - Existing users' settings move to the new keys automatically, in every layer where the move can be done, in every profile, without losing a value.
  - Existing user keybindings keep working through a stated window, and users are told once what to change.
  - Documentation names the new ids and titles wherever it describes the current extension.
- Non-goals:
  - No new setting, command or behavior. A renamed command does exactly what it did.
  - Persisted identities private to this extension (storage keys, secrets, the webview view types that VS Code persists, tree element ids) are not renamed ([ADR-0068](../decisions/0068-rename-contributed-ids-to-ompdesk-and-migrate-settings-at-activation.md)).
  - Names OMP itself reads (environment variables, `omp` arguments, the `-e` host-control module, `omp-desk/navigation` markers) are not renamed.
  - No rewrite of `keybindings.json`: the extension API cannot do it, and the extension must not edit that file.
  - Notification prefixes (`OMP: …` in message text) are not changed; only references to palette command titles are.

## Current State

Facts checked on 2026-10-13 against the repository (commit `078b90b`, the published 0.3.2, and the working tree) and VS Code 1.141.0:

- 0.3.2 contributes 92 commands (all `"category": "OMP"`), 15 keybindings, 13 settings (5 `window`, 7 `application`, 1 `machine`), one container `omp`, seven views (`omp.sessions`, `omp.skills`, `omp.tools`, `omp.mcp`, `omp.extensions`, `omp.context`, and the webview view `omp.deskSettings`), `viewsWelcome`, menus keyed on `view == omp.*`, `config.omp.*` and context keys, `configurationDefaults` for `terminal.integrated.commandsToSkipShell`, and `onView:omp.*` events. Three commands (`reloadAllWindows`, `searchFileFromChat`, `refreshUsageStatus`) are unreleased.
- Code reads settings with `getConfiguration("omp")` and one constant (`OMP_PATH_SETTING`); the Settings view projects the contributed schema of this extension (ADR-0062) and skips entries with `included: false`.
- Editors are webviews. Persisted, each revived through a serializer registered for its exact view type: `omp.session` (legacy generic), `omp.session.b2.<tab>.<editor>` (one per actual editor, ADR-0023), `omp.shellTerminal` and `omp.settings`. Not persisted, no serializer: `omp.detail` (tabs left by an earlier host are closed at activation) and `omp.stats`. Default keybindings use `activeWebviewPanelId =~ /^omp[.]session/`.
- Private persistence uses `omp.`-prefixed keys: catalog records and Mementos (`omp.sessionIndex.v1`, `omp.sessionIndex.local.v1`, `omp.brokerSlots.v1`, `omp.shellSlots.v1`, `omp.workspaceFolders.v1`, `omp.windowFolderCollapsed.v1`, `omp.unityProjectChoice.v1`, `omp.chat.*`, `omp.session.defaultMode`, `omp.agentDebugger.breakpointOwners`, `omp.settings.contexts`), SecretStorage keys (`omp.bridge.v1/…`, `omp.hostControl.*`), tree element ids and the status bar item id (`omp.usageStatus`).
- Measured in an isolated VS Code 1.141.0 (hidden desktop, throw-away profile, a probe extension that contributes three new settings and not the old ones; default profile only):
  - `inspect()` reports `globalValue`, `workspaceValue`, `workspaceFolderValue` and `[language]` values for keys **no extension contributes**; `get()` returns them. `update(oldKey, undefined, target)` removes such a key from User and Workspace settings; `update(newKey, value, target)` for an uncontributed new key fails (`… is not a registered configuration`).
  - A `window`-scoped setting cannot be written at the folder layer; `application` and `machine` settings cannot be written at the Workspace layer (`can be written only into User settings`). A `[language]` override of a setting that is not language-overridable cannot be written. In a single-folder window the folder layer and the workspace layer are the same file.
  - Writing a read-only workspace settings file throws (`EntryWriteLocked … EPERM`) and leaves VS Code's text model of that file dirty, so the next write reports unsaved changes.
  - VS Code has no extension API or manifest contribution point for a settings migration (`configurationMigration` is an internal registry).
- From VS Code 1.141.0's workbench bundle, reported by the independent review: a window of a non-default profile reads **application**-scoped settings from the default profile's `settings.json` filtered by the registry (`skipUnregistered`), so an old application-scoped value is invisible to `inspect` in such a window the moment its key is no longer registered; application-scoped writes of a non-default profile are routed to that same file; Settings Sync excludes `machine` settings by registry lookup, which an unregistered key loses; and an updated extension keeps running its previous version in windows that are already open until their extensions restart.

## Proposed Design

### Prefix and category

Every id that moves is `ompDesk.<rest>`, where `<rest>` is the old id without its `omp.` prefix; the container `omp` becomes `ompDesk`. Every command's `category` becomes `OMP Desk`, so the palette shows `OMP Desk: New Session`. `ompDesk` is the camelCase form of the product name `OMP Desk` and follows the convention that multi-word extension namespaces are camelCase (`gitlens.`, `githubPullRequests.`, `gitHistory.`). Alternatives: `omp-desk.` (the extension name; unconventional as a namespace), `desk.` (generic), `ompd.` (cryptic).

### What moves, and what stays

| Kind | Rule | Examples |
| --- | --- | --- |
| Commands (92 published, 3 unreleased, and the registered row commands) | `omp.<x>` → `ompDesk.<x>` | `omp.newSession` → `ompDesk.newSession`; `omp.clickSession` → `ompDesk.clickSession` |
| Settings (13) and the debugger section | same | `omp.chatColumn` → `ompDesk.chatColumn`; `getConfiguration("omp")` → `getConfiguration("ompDesk")` |
| Container and views | same, container `omp` → `ompDesk` | `omp.sessions` → `ompDesk.sessions`; `workbench.view.extension.omp` → `workbench.view.extension.ompDesk`; `omp.tools.focus` → `ompDesk.tools.focus` |
| Context keys | same | `omp.sessionMode`, `omp.streaming`, `omp.catalogPending`, `omp.<kind>.scope`, … |
| Keybinding ids and `when` clauses, menus, `viewsWelcome`, `configurationDefaults`, `onView:` | same | `config.omp.showWorkspaceFolders` → `config.ompDesk.showWorkspaceFolders` |
| Webview view types that are **not** persisted | same | `omp.detail` → `ompDesk.detail`; `omp.stats` → `ompDesk.stats` (a leftover `omp.detail` tab is closed like one of the new type) |
| Palette title references in text | `OMP: <title>` → `OMP Desk: <title>` where the text names a command | README, architecture, comments, one user-visible message |
| **Stays:** persisted webview view types | unchanged | `omp.session`, `omp.session.b2.*`, `omp.shellTerminal`, `omp.settings`; the default `when` regex `^omp[.]session` and the `onWebviewPanel:` events keep them |
| **Stays:** persistence | unchanged | every Memento, catalog record and SecretStorage key above |
| **Stays:** tree element ids and the status bar item id | unchanged | `omp.terminalsGroup`, `omp.usageStatus`, … |
| **Stays:** OMP-facing names and the page protocol | unchanged | `OMP_VSCODE_*` variables, `omp` arguments, the `-e` host-control module, `omp-desk/navigation`, `omp:*` page messages |

**Persisted webview view types stay.** VS Code stores each editor's view type with its saved workbench state and calls the serializer registered for exactly that string; a bridge editor mints its type from its own tab and editor ids (ADR-0023). A rename moves a restored editor onto a type it does not have: the old editors are orphaned by the update, or the extension has to replace them, which is the flow [ADR-0022](../decisions/0022-replace-orphaned-webview-editors-after-host-restart.md) rejected. Keeping serializers for the old types and creating new editors under a new namespace leaves two namespaces for as long as any old editor stays open, doubles every `when` clause and every membership scan, and gains no user-visible benefit. The per-editor types embed 128-bit tab and editor ids, so they cannot collide with another extension; the three fixed ones (`omp.session`, `omp.shellTerminal`, `omp.settings`) can in principle (an extension host refuses a second serializer for one type and `activeWebviewPanelId` is not scoped by extension), which is a present but remote risk accepted here because no rename can be made without orphaning editors; it is revisited if a concrete collision appears. `omp.detail` and `omp.stats` have no serializer and no persisted state, so they are renamed at no cost.

**Private persistence stays.** Mementos, catalog records and SecretStorage keys are scoped by VS Code to the extension id `hmmvot.omp-desk`, are invisible to users and other extensions, and are read by older releases under their unchanged key. Renaming them would orphan every recorded session, claim and broker slot, or need a copy-and-fallback migration of the data the extension's safety invariants depend on. The one reader of another extension's keys, the predecessor import, names `omp.sessionIndex.v1` in an external file. New durable keys introduced after this change use the new prefix (the rename notice marker is `ompDesk.renameNotice.v1`).

### Settings migration

The 13 old settings stay **contributed**, hidden (`included: false`, so neither the Settings editor nor the Settings view lists them), deprecated (`deprecationMessage` naming the successor, which VS Code shows as a warning on a leftover line in `settings.json`) and with the scope they had in 0.3.2. Without this, a profile other than the default would not see an application-scoped value at all, a dead copy in a profile's own file would start to count, `omp.executablePath` would lose its machine-scope exclusion from Settings Sync, and a value a user lists in `settingsSync.ignoredSettings` or `workbench.settings.applyToAllProfiles` would lose its protection.

`migrateLegacySettings` (`src/wiring/legacy-settings.ts`) starts every activation, after the aliases are registered and before any setting is read, and activation waits for it at most 10 seconds (a slower write goes on in the background). Its input is an explicit table of the 13 old keys and their `ompDesk.` successors (not derived from `package.json`, so a setting added later never acquires a phantom predecessor).

1. **The two name lists first.** For every `omp.<name>` that `settingsSync.ignoredSettings` or `workbench.settings.applyToAllProfiles` holds at User level, `ompDesk.<name>` is added next to it; the old entries stay. A value is then never written under a name the list does not cover.
2. **Then per key and layer:**

| Layer | Handling |
| --- | --- |
| User (`globalValue`) | If the old key has a value: if the new key has no User value, write the old value to it; then remove the old key. If the new key already has a User value, keep it, remove the old key, and log the dropped value. |
| Workspace (`workspaceValue`: a folder's `.vscode/settings.json` or the `.code-workspace` `settings`) | Same, when the new key can be written there (`window` scope: `desktopNotifications`, `sessionsGrouping`, `chatColumn`, `linkCodeSymbols`, `linkReminder`). `application` and `machine` settings cannot live in a workspace, so the old value there was already ignored: it is left in place and one line says so. |
| Workspace folder (`workspaceFolderValue`) | No setting of this extension is resource-scoped, so the folder layer never applied and cannot be written. In a single-folder window it is the Workspace layer's own file and is handled there; in a multi-root workspace a folder's `.vscode/settings.json` is left untouched. |
| `[language]` overrides | Desk reads its settings without a language, so an override of one of its settings never applied, and VS Code cannot write one to a non-language-overridable key. Neither migrated nor touched. |

Rules:

- **Order.** Write the new key, then remove the old one. A crash between the two leaves both; the next activation sees the new value set and only removes the old one. Each value is read again immediately before its write.
- **Idempotent without a marker.** Nothing is recorded: every activation inspects the 13 keys (in memory, no I/O) and returns at once when none has an old value, so a value that appears later (a Settings Sync pull from a machine on an older release, a hand edit) is migrated too. Two windows activating together converge: they derive the same new value from the same old one, and a second write of an equal value changes nothing. A write that loses a file race fails inside VS Code, is logged, and is retried by the next activation.
- **Profiles.** Every profile's window runs the migration against what it can see; an application-scoped value lives in the default profile's file and is visible, still registered, from every profile, and its writes are routed there by VS Code.
- **Move, not copy.** The old value is removed, as the maintainer specified. The independent review proposed copying and leaving the old key until the window ends, so that a window still running the previous release (VS Code does not restart open windows' extensions after an update) keeps its values and teammates on 0.3.x keep a committed `.vscode/settings.json` working. Not adopted: copying leaves two keys with the same value, and a deprecation warning on one of them, in every user's settings and committed files for months; the maintainer's rule is that the old value goes. The consequence is disclosed in the changelog: a window that was already open on the previous release reads the defaults for a moved setting until it reloads, and a value it writes meanwhile under the old name loses to the new one at the next activation (the dropped value is logged).
- **Another extension's names.** Other installed extensions' manifests are scanned once at activation. An old key or command another extension contributes under `omp.` is skipped (one log line): never read, removed, aliased or mirrored. If any foreign `omp.` name exists, the old context keys are not mirrored either.
- **Workspace file not writable.** Before a Workspace write the settings file's own write permission is checked (`fs.access(…, W_OK)`; the Windows read-only attribute is honored); a read-only file is not written at all, because a failed VS Code write leaves a dirty editor model behind. A workspace with no file on disk (an `untitled:` workspace) is not checked and is written through VS Code. Any other failure is caught per key. A User `settings.json` is not checked in advance (its path is not exposed); a refused write is caught like any other failure. In every case the old value stays, the new key is not written, and one line names the key, the layer and the reason.
- **Log.** One line per key and layer in the OMP Desk output channel: `settings: omp.chatColumn → ompDesk.chatColumn (user settings): moved`, or `… left; <reason>`. No value is logged except in a dropped-conflict line.
- **Obsolete keys.** No key has been removed or renamed since 0.1.0 (`git log -S` over `package.json`); `omp.sessionsGrouping` is the live Sessions-layout setting (`flat`, `folders`, `terminals`), so it is **mapped**, like the others. The table has no drop entries.
- **Failure of the whole step** is logged and does not block activation.

A migration changes files the user may have committed (`.vscode/settings.json`); that is the cost of "every scope" and is stated in the changelog.

### Keybindings and context keys

An extension cannot rewrite `keybindings.json`. Three measures keep existing bindings working for a bounded window and tell users what to do:

1. **Hidden aliases.** Every command id the published 0.3.2 contributed (92) and the commands VS Code generates from the container and view ids (`workbench.view.extension.omp`, `omp.<view>.focus`; 8) stay registered under the old id as `src/wiring/legacy-aliases.ts` aliases that forward their arguments to the new command and return its result. They are **registered first in `activate`**, before the awaited migration, so an old binding works as early as any command does. They are not contributed: no palette entry, menu, title or generated activation event. The first use of each alias in an extension host logs and shows one warning that names the old and new id and offers **Open keybindings.json**; every use is logged. Each registration is its own `try`: an id already taken is logged and skipped and never stops the others or the activation. The three commands 0.3.2 did not publish have no alias. The three old ids in `terminal.integrated.commandsToSkipShell` stay in `configurationDefaults` next to the new ones, so a user's own binding keeps skipping the shell. `-omp.<command>` removal entries and `when` clauses that test view ids (`focusedView == omp.sessions`) cannot be forwarded.
2. **Mirrored context keys.** The three keys that default keybindings use in `when` (`sessionMode`, `streaming`, `composerPopupOpen`) are also set under their old `omp.` names, so a user's own `when` clause keeps matching. Every other old context key is gone with no alias.
3. **A one-time notice.** On the first activation of this release in a profile that already ran an earlier OMP Desk (its catalog exists), one information message says what was renamed and offers **Open keybindings.json**. A fresh install shows nothing. It covers the users the aliases cannot help (removal entries) and those who have not pressed a stale key yet. The marker (`ompDesk.renameNotice.v1` in global state) is written before the message appears.

**Window.** All of it is kept until **1.0.0** and removed in that release: the hidden command aliases, the context-key mirror, the old skip-shell entries, the settings migration and the hidden deprecated keys. The maintainer decided this (the first draft proposed 2027-01-13 and 2027-04-13); a rename compatibility that ends at a stated version is easier to explain than one that ends at a date, and no user loses a setting or a key binding before the 1.0 line. After 1.0.0 the old keys are plain unknown entries in the file, never deleted, and can be renamed by hand.

### Documentation

README, `CONTRIBUTING.md`, `.github/ISSUE_TEMPLATE/bug_report.yml`, `docs/architecture.md`, `docs/product.md`, `docs/publishing.md` and the in-progress designs name the new ids and palette titles. Accepted, implemented, rejected and superseded designs and ADRs stay as written, because they record decisions under the names current at the time; `docs/README.md` lists exactly what moved and what did not, so a reader can translate. CHANGELOG gets a *Changed (breaking)* entry under Unreleased: the new category and ids, the automatic settings migration and where it cannot apply, the alias window and its dates, the stale-window caveat, what a user with custom keybindings, `-omp.*` removals, `when` clauses, `terminal.integrated.commandsToSkipShell` or `settingsSync.ignoredSettings` must edit, and the one-time reset of the OMP Desk views' layout state (VS Code keys it by view id).

### Contract tests

- `src/wiring/contributions.test.ts`: every command's category is `OMP Desk` and its id starts with `ompDesk.`; the manifest holds no `omp.` name except the listed exceptions (persisted view types, the three old skip-shell ids, the 13 hidden deprecated settings, each with its reason); each deprecated key is hidden, names its successor and has its successor's scope; the alias table is exactly the 92 published commands plus the generated ones, none contributed, each target contributed, every alias registered; an alias forwards arguments once and warns once per id; every context key a `when` clause tests is set somewhere.
- `src/wiring/namespace-literals.test.ts`: no string literal in the sources starts with `omp.` except a listed name that stays (each with its reason), and every listed name still occurs, so neither a missed command id nor an accidental rename of a persisted key goes unseen.
- `src/wiring/legacy-settings.test.ts` and `legacy-aliases.test.ts`: the migration per layer, idempotence, a new value not overwritten, removal, read-only and refused writes, concurrent windows, the name lists, another extension's names, the alias register failure path, the notice.

## Alternatives

- **Keep `omp.`**: rejected by the maintainer.
- **Other prefixes**: see above.
- **Rename the persisted view types as well, with serializers for both namespaces**: see above; a double namespace for no visible gain, or the rejected ADR-0022 replacement flow.
- **Rename persisted keys with a copy-then-read-old migration**: risks the session catalog, claims and secrets for no visible gain.
- **Drop the old settings from the manifest at once, as the first draft did**: loses application-scoped values in non-default profiles, routes dead copies, drops Settings Sync exclusion (see Current State). Reading the default profile's `settings.json` directly instead was not tried: its path is not exposed and a second reader of a user file is worse than keeping the keys registered.
- **Settings: a marker plus a one-time pass**: misses values that reappear (Settings Sync) and needs per-workspace state; the in-memory scan costs nothing when there is nothing to do.
- **Settings: copy without removing during the window**: see "Move, not copy".
- **Settings: also remove inert values** (application/machine keys in a workspace, folder-layer values, language overrides): touches files, often committed ones, for values that never had an effect.
- **Keybindings: only a notification**: every existing binding dies at the update. Kept as the one-time notice beside the aliases.
- **Keybindings: contribute the aliases as hidden commands**: a contributed command appears in the keybindings editor, and a `commandPalette` `when: false` entry per command doubles the manifest for a temporary table.
- **Mirror every old context key**: ~20 sites for keys no shipped binding used.
- **A release count or dates for the window**: a user who updates late jumps over releases and dates; the maintainer chose a named end point, 1.0.0 (see Window).

## Risks and Open Questions

- **View layout state resets once.** VS Code keys a view's collapsed state, order and position (including a Sessions view the user moved to the secondary side bar) by its id, so the OMP Desk views return to their default arrangement after the update. Disclosed in the changelog; nothing durable is lost.
- **Stale windows.** See "Move, not copy".
- **Settings Sync.** A migration changes User settings on this machine; synced to a machine still on the previous release, the old key disappears there (the new key arrives, unknown to that release). Update all machines together.
- **A dirty text model after a failed workspace write** is avoided for the read-only attribute; other failures (an ACL deny, a file locked by another program) can still leave it. Logged; nothing is lost.
- **The dual-namespace `when` clause** stays: `activeWebviewPanelId =~ /^omp[.]session/` together with `ompDesk.sessionMode`. The contract test names it as deliberate.
- **The removal point** is 1.0.0, decided by the maintainer. Until then the alias table, the mirror and the migration add startup work and 13 hidden keys to the manifest; each activation's scan is in memory and does no I/O when nothing is left to move.
- **Marketplace.** Nothing in the manifest identity changes (`publisher.name`, `displayName`).

## Rollout and Verification

1. Scripted exact-token rewrite of `package.json`, `src`, `test` and current documents from one mapping; the alias, settings, notice and context-mirror modules.
2. Tests as above, plus the existing suites with updated ids.
3. `npm run typecheck`, the focused suites, `src/extension-lifecycle.test.ts`, `src/wiring/contributions.test.ts`, `npm run build`.
4. An isolated VS Code on the hidden desktop (`scripts/test-vscode.ps1`) with the built VSIX: a seeded User `settings.json` and workspace `.vscode/settings.json` holding old keys, and a seeded `keybindings.json` with an old id. Observe the keys moved, the palette reading `OMP Desk: …`, the old binding running and warning once, the notice. A second run installs the published 0.3.2 first, opens a folder shell and a Models settings editor (persisted view types), then upgrades to the built VSIX and observes both editors revive.
5. CHANGELOG, README, architecture and docs index updated in the same commits as the code they describe.

## Related Decisions

- [ADR-0068: Rename contributed ids to `ompDesk.` and migrate settings at activation](../decisions/0068-rename-contributed-ids-to-ompdesk-and-migrate-settings-at-activation.md)
- [ADR-0022](../decisions/0022-replace-orphaned-webview-editors-after-host-restart.md), [ADR-0023](../decisions/0023-reconnect-surviving-webviews-through-an-authenticated-bridge.md): view types and editor identity.
- [ADR-0062](../decisions/0062-render-the-settings-view-from-the-contributed-schema-in-a-webview-view.md): the Settings view reads the contributed schema, so it follows the rename and skips the hidden old keys.

## Architecture Review

- Reviewer: architect
- Outcome: accepted after independent review
- Notes: see ADR-0068; the five material findings (hidden deprecated settings and name lists, the stale-window caveat, foreign omp. names, a compatibility window that ends at 1.0.0, source-literal and upgrade tests) are resolved in this document.
