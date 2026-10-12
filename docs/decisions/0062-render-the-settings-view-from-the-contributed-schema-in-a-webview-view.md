---
status: accepted
date: 2026-10-12
---

# ADR-0062: Render the Settings view from the contributed schema in a Webview view and write through the configuration API

## Context and Problem Statement

OMP Desk's `omp.*` settings need a place in the OMP Desk side bar where the user sees every setting with its value and source and changes it in place. Four choices are lasting: what kind of view hosts the controls, where the list of settings comes from, which configuration layer a change is written to, and what Reset clears.

## Considered Options

- **View kind:** a tree view with QuickPick/InputBox editing (a tree can show a checkbox, as the inventory views do, but not an inline dropdown or validated input; every other edit is a modal); a **Webview view** (`type: "webview"`) with native controls (a second Webview bundle to build and a CSP to keep, as the existing message-only pages already do).
- **Source of the list:** a hand-maintained table in the page (drifts); the manifest on disk (a second read path); **`context.extension.packageJSON.contributes.configuration`**, the manifest VS Code loaded.
- **Layer written:** always user (cannot change a value a workspace overrides); automatically the layer of the current source; user by default with workspace when it already overrides or the user chooses it; any layer including folders.
- **Reset:** clear only the layer that supplies the value; clear **every writable layer that holds a value**.

## Decision Outcome

1. **A Webview view** `omp.deskSettings` ("Settings", collapsed, last in the `omp` container) serving a message-only page (no network; script by nonce; styles by nonce or the Webview resource origin; resource roots limited to `media/`) from `media/desk-settings.js`. The page keeps its state in a pure, tested reducer; page state (query, chosen layers) uses `setState`, and the view is not retained while hidden.
2. **The list is the extension's own `contributes.configuration`**, read once at activation and projected by a pure module shared with the page: boolean → toggle, enumeration → dropdown with the schema's option descriptions, number/string → input validated by the schema's bounds and pattern, everything else → a preview and an "Edit in settings.json" link. **The projection fails closed**: a schema with a rule the page cannot check, an enumeration the page cannot offer faithfully (empty, or with a non-primitive entry) or an unusable pattern takes the link, never a control that accepts what VS Code rejects; an enumeration only loses the options the type's own bounds reject (none left: the link). A new property appears with no other change. Order, grouping and labels are Desk's own (declaration order, `omp.<group>.<name>` sub-groups), not a claim of parity with VS Code's Settings editor.
3. **Writes use `WorkspaceConfiguration.update` only**, serialised per window, after the host re-validates key, value and layer (the page is not trusted) and followed by a read-back. The layer is the **user** layer, except that a setting with a scope VS Code reads from the workspace is written to the **workspace** when a workspace value already overrides the user value, or when the user chooses it (a radio pair on that row). `application` and `machine` settings are user-only and a workspace request is refused; so is a workspace request with no workspace open. **Folder layers are never written**, because Desk reads its settings without a folder (a folder value could not take effect); existing folder values are shown as inapplicable. Desk writes nothing for a JSON row; its link opens VS Code's own JSON editor on the file of the layer that holds the value, and VS Code's `revealSetting { edit: true }` inserts and saves the default entry when the key is absent (observed in an isolated window). The existing Sessions layout picker keeps writing the user layer and now tells the user when a workspace value overrides its choice.
4. **Reset clears every writable layer that holds a value** (workspace, then user) so the default is what takes effect. The row states the layers before the action (accessible name and tooltip), a partial failure says what was cleared, and the effective value is read back before the default is claimed.
5. **Live state** comes from `onDidChangeConfiguration` and `onDidChangeWorkspaceFolders`; the host holds no cache and refreshes passively only while the view is visible (a write already admitted finishes). The page settles each write by request id, presents only a row's latest request, never lets an unrelated snapshot roll a pending write back, and adopts a value changed elsewhere instead of overwriting it with a stale draft on leaving a field.

### Consequences

- Positive: one source of truth for what settings exist; the view is correct for settings added later and never offers a control it cannot validate; in-place editing with the same validation VS Code applies; no hidden writes to a file a repository may track unless the user already uses the workspace layer or chooses it.
- Negative: a second Webview bundle; the schema subset is intentionally limited (arrays/objects go to `settings.json`); `openSettingsJson` with `revealSetting` and `@id:` search are VS Code workbench commands rather than extension API; Reset on a setting overridden by a workspace edits that workspace's `settings.json` (and clears the user-wide value too, which the row says first); writing a toggle's displayed value into the user layer below an overriding workspace value needs Reset or the Settings editor.

## Related Documents

[Settings view design](../designs/2026-10-12-settings-view.md); [Skills, Tools, MCP and Extensions views](../designs/2026-10-11-skills-tools-mcp-extensions-views.md) and [ADR-0061](0061-read-the-omp-inventory-through-a-staged-bun-worker-and-write-omps-own-toggle-state.md) (the container and its read-while-visible rule).

## Architecture Review

- Reviewer: architect
- Outcome: reviewed together with the design in seven rounds (see the design's Architecture Review); every material finding resolved, final round accepted.
- Notes: accepted.
