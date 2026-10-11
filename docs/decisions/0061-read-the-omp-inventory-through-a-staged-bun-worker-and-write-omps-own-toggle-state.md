---
status: accepted
date: 2026-10-11
---

# ADR-0061: Read the OMP inventory through a staged Bun worker and write OMP's own toggle state

## Context and Problem Statement

The Skills, Tools, MCP and Extensions views need, for every item, its origin, its source file, whether OMP considers it enabled (including disabled and shadowed items OMP does not load) and a way to enable or disable it globally. Installed OMP 18.8.5 exports none of this over RPC: `get_available_commands` has skill commands without paths, `get_state` has tool descriptors, and nothing lists MCP servers, their source files or extension modules. `omp skill list --json` omits disabled skills and has no tools, MCP or extension listing. OMP's own TUI Extensions dashboard builds the complete inventory with `loadAllExtensions` (which logs and swallows a failed source) and persists toggles through different mechanisms (`disabledExtensions`, the MCP config's user-level lists, per-tool settings, the plugin lock).

Three choices are needed: where the inventory comes from, how an incomplete or polluted read is detected, and where each toggle is written. A fourth is a boundary question: [ADR-0009](0009-read-only-native-tools-until-atomic-selection.md) keeps tool selection read-only.

## Considered Options

- **Re-implement discovery in the extension**: no runtime dependency on OMP source, but a permanent second copy of provider precedence, shadowing, foreign-ecosystem opt-ins and MCP suppression that drifts silently.
- **OMP CLI output**: stable, but incomplete and cwd-bound.
- **Staged Bun worker importing the installed OMP's own inventory function**: the same function the TUI dashboard uses, so the views and the TUI agree; coupled to installed source paths, which Desk already accepts for the Models/Agents editors.
- **Extend host-control** with tool origin and MCP names: only helps live sessions, changes an authenticated protocol.
- **Toggle MCP through `disabledExtensions` (`mcp:<name>`)**, through OMP's `setMcpServerEnabled` (per-entry flag in the entry's own file) or through the **user MCP config's name lists** (`disabledServers`, `enabledServers`).

## Decision Outcome

1. **Inventory:** a second staged, digest-verified Bun worker (`out/inventory-worker.mjs`), launched like the settings worker against the same resolved OMP package root, imports `loadAllExtensions`, `loadCapability`, `loadSkills`, `BUILTIN_TOOLS`, the settings registry and `PluginManager` from the installed OMP. It returns a bounded JSON projection (no raw items, no MCP arguments/env/headers/query strings). Required exports and result shapes are checked before use. Any failure (no Bun or package root, compiled-only install, missing export, timeout, malformed receipt) yields an *unavailable* inventory with a fixed reason; the views fall back to the session's own reported skill commands and tools, and every switch is disabled. There is no approximate local discovery. A contract test against the installed OMP pins the worker, including every built-in switch id of the repository's table.
2. **Completeness is checked, not assumed.** Each category is reloaded through `loadCapability` with warnings visible and its item count compared with the dashboard's; a failed source or a mismatch marks the category *incomplete*: its rows stay, its switches are removed, and a notice says so. Skills additionally take their effective runtime name from OMP's `loadSkills`.
3. **Global is user-only, enforced.** The Global read runs in a folder without project layers (drive root of the extension's global storage). The worker refuses, with a sentence naming the finding, when project settings keys, rows in a dot-folder of the folder or its ancestors, or the project plugin registry / Claude project settings files that select project rows appear, and the view shows that message instead of a mixed list.
4. **Toggles are written to OMP's own user-level state, global only:**
   - skills, custom tools, extension modules → `disabledExtensions` in the profile's user `config.yml` (ids `skill:`, `tool:`, `extension-module:`), written by the transaction extracted from the ADR-0048 worker into `src/omp/config-transaction.ts` (installed file lock, re-read under the lock, targeted-key merge with a caller-supplied path allow-list, staged fsync, bounded Windows replace, no-op when unchanged, no unlink). **YAML comments are not preserved**: OMP's serializer drops them on its own rewrites (`/extensions`, `/mcp disable`, settings saves) and this matches; the maintainer accepted the limitation;
   - built-in tools → the boolean `<setting>.enabled` named by an explicit table in the repository, looked up in OMP's settings registry and validated with the setting's `assertWritable`; a tool without a table entry, a missing registry id, a non-boolean setting (`find`) or a project override has no switch;
   - MCP servers → OMP's own user-file writers `setServerDisabled` and `setServerForceEnabled` on the user MCP config, by server name, in a fixed interruption-safe order; no per-entry flag, definition or project/source file is written; a legacy `mcp:` id is cleared from `disabledExtensions` on enable; a partial write is reported;
   - plugins → `PluginManager.setEnabled` (the `omp plugin enable/disable` path), offered only in Global scope; project-installed plugins are read-only.
   The project configuration is never written. A project `disabledExtensions` array replaces the global one in OMP's merge; the worker reports that condition and the affected rows lose their switch. A row that is shadowed by a same-named higher-priority item has no switch.
5. **Application is OMP's:** Desk relies on OMP's config watcher and extension reconcile for live kinds. The view says "saved; a running session *may* apply it live" for skills, extension modules and settings-gated built-ins and "restart a running session" for the others; it never claims application it did not observe. No confirmation dialog precedes a switch; the tooltip and notice state that the switch changes the global OMP configuration for all sessions.
6. **MCP status:** no RPC or control surface returns it; Desk shows configuration state and *name-matched* tool evidence (a tool is attributed to a server only on a unique `mcp__<server>_` prefix) and never claims a connection.
7. **Desk's `-e` module** is never listed (explicit flag, not discovery) and a switch request for the name `omp-host-control` is refused.
8. **Amendment to ADR-0009.** ADR-0009's boundary stays for tool *selection*: the Webview and the host-control pipe gain no selection or toggle command, and no per-session active-tool change is made by Desk. The user's request for Skills, Tools, MCP and Extensions switches is the product decision to *persist OMP's own user configuration*, which OMP applies to sessions on its own schedule; it is not a mutation through the pipe and not session-atomic, and the UI never presents it as such.

### Consequences

- Positive: one inventory convention shared with OMP's dashboard; disabled, shadowed and foreign-ecosystem items are visible with their origin; toggles are visible to plain OMP and its TUI; reuse of an accepted worker and write discipline; partial or polluted reads are visible rather than silently wrong.
- Negative: dependence on installed-source module paths and on a UI-layer function; a compiled-only OMP or a renamed export degrades the views; four different write mechanisms are exposed; YAML comments are lost on rewrite; custom-tool, MCP and plugin switches are not live; the plugin writer is OMP's, with OMP's atomicity; the built-in switch table is repository data that must follow OMP (the contract test fails first).

## Related Documents

[Skills, Tools, MCP and Extensions views](../designs/2026-10-11-skills-tools-mcp-extensions-views.md). Reuses [ADR-0048](0048-write-omp-settings-directly-under-native-file-locks.md). Amends [ADR-0009](0009-read-only-native-tools-until-atomic-selection.md) narrowly as in item 8.

## Architecture Review

- Reviewer: architect
- Outcome: accepted after six review rounds: round 1 (13 findings), 2 (8), 3 (4), 4 (1: Global provenance), 5 (1: registry location and path identity) and 6 (1: Claude config dir resolved with OMP's own resolveClaudePaths) each returned changes needed and every finding was fixed; the independent architect (ReviewR6) confirmed commit 9cad20b with no remaining material findings and accepted both documents.
- Notes: details in the design's Architecture Review.
