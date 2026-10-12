---
status: accepted
date: 2026-10-12
---

# Settings view in the OMP Desk side bar

## Problem

OMP Desk contributes a dozen `omp.*` settings (tool presentation, notifications, Sessions layout and visibility, link behaviour, the agent debugger's permissions). The only way to see or change them is VS Code's Settings editor, searched by extension, or a hand edit of `settings.json`. Several are changed from elsewhere in Desk (the Tools output picker in the Chat footer, the Sessions layout picker, the debugger consent prompt's "always allow"), so the user cannot tell from Desk itself what is currently set, where the value comes from, or how to undo it.

## Goals and Non-goals

- Goals:
  - A **Settings** view in the OMP Desk container that lists every setting this extension contributes and changes it in place: a toggle for a boolean, a dropdown for an enumeration (with the schema's option descriptions), a validated input for a number or string.
  - Each row shows its title, key, description, the value in effect and which layer it comes from (default, user, workspace), the layer a change is written to, Reset to default and **Open in Settings editor**.
  - Search/filter box; live update when a setting changes anywhere else (the Settings editor, `settings.json`, another window, another Desk surface).
  - Generated from the extension's own `contributes.configuration` at run time: a setting added to `package.json` appears with no other change.
  - Theme-aware, keyboard accessible, in the styling of the existing Desk Webviews.
- Non-goals:
  - A general settings editor: no arrays/objects editor (those link to `settings.json`), no language-specific overrides, no folder-layer writes, no other extension's settings and no OMP settings (Models/Agents have their own editors, [ADR-0048](../decisions/0048-write-omp-settings-directly-under-native-file-locks.md)).
  - Replacing the Settings editor: it stays the complete surface and every row links to it.
  - Changing what any setting means or how Desk reads it.

## Current State

Settings are contributed under one `contributes.configuration` section titled "OMP Desk". Desk reads them with `workspace.getConfiguration("omp").get(...)` (no resource, so a folder layer never applies) and writes some of them to the user layer from its own surfaces: `toolCallDetail` (Chat footer picker), `sessionsGrouping` (Sessions layout picker) and the debugger consent ("Always Allow"). The container hosts Sessions, Skills, Tools, MCP, Extensions (and Context) as tree views; the inventory views read only while visible ([design](2026-10-11-skills-tools-mcp-extensions-views.md)). Two existing Webview pages are message-only (the Models/Agents editors; `createSettingsHtml`), built as an esbuild IIFE bundle with React and a nonce-gated stylesheet.

## Proposed Design

### Surface: a Webview view ([ADR-0062](../decisions/0062-render-the-settings-view-from-the-contributed-schema-in-a-webview-view.md))

`contributes.views.omp` gains `{ type: "webview", id: "omp.deskSettings", name: "Settings", visibility: "collapsed" }` as the last view, with an `onView:` activation event. A `WebviewViewProvider` serves a message-only page (`default-src 'none'`, no `connect-src`; script by this document's nonce only; styles by the nonce or the Webview resource origin, because the codicon stylesheet is linked; resource roots limited to `media/`) built from `src/webview/desk-settings/main.tsx` into `media/desk-settings.js`, the same bundle shape as the other pages. A tree view can show a checkbox (the inventory views do) but not an inline dropdown or a validated text input; that, not the toggle, is why the surface is a Webview.

### Schema projection (pure, shared)

`src/host/desk-settings/model.ts` imports nothing from VS Code. `projectConfiguration(contributes.configuration)` accepts one section or an array and produces descriptors:

| Schema | Control |
| --- | --- |
| `type: boolean` | toggle |
| `enum` of strings/numbers/booleans (`enumDescriptions`/`markdownEnumDescriptions`, `enumItemLabels`) | dropdown; the chosen option's description shows under it. The type's own bounds still apply: an option they reject is not offered, and none left means the JSON fallback |
| `number` / `integer` (`minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `multipleOf`) | text input, decimal; whole-number rule for `integer` |
| `string` (`minLength`, `maxLength`, `pattern`, `patternErrorMessage`/`errorMessage`, `editPresentation: multilineText`) | text input or textarea |
| `array`, `object`, a type union, `anyOf`/`oneOf`/`$ref`, no type | read-only preview and **Edit in settings.json** |

**Fail closed.** A control is offered only when the page can enforce everything the schema says about the value. A schema that carries a rule the projection does not check (`format`, `allOf`, `not`, `const`, `if`/`then`/`else`, `dependencies`, `dependentSchemas`, `contentMediaType`, `contentEncoding`) an `enum` the page cannot offer (empty, or with a non-primitive entry) or an unusable `pattern` takes the JSON fallback instead of a control that would accept what VS Code rejects. The host validates every value again against the same projection before writing.

`included: false` properties are skipped. The description is `markdownDescription` when present, reduced to `code`, **bold** and paragraphs (links to their text; the page renders React nodes, never markup from the schema); deprecation messages show.

**Order, labels and groups are Desk's own, not a claim of VS Code parity.** Sections are ordered by `order`, then declaration; properties by `order`, then declaration (the author's order is kept; VS Code's Settings editor sorts equal-order entries differently). A key `omp.<group>.<name>` is filed under a group named for `<group>` ("Agent Debugger") with the label "Agent Debugger: Enabled"; other keys are under "General" with the humanized last segment ("Tool Call Detail"); with several sections the section title heads each group. The key is shown under every label. The manifest is read once at activation from `context.extension.packageJSON`: it cannot change while the extension runs.

### Values and layers

For each setting the host calls `inspect` (default, user, workspace) and `get` (the value in effect, which merges object values), and, for resource-level scopes only, the folder layer of each open folder. **Source** is the topmost layer that holds a value, ignoring a workspace value for a setting whose scope (`application`, `machine`) VS Code does not read from the workspace (such a setting also never shows a workspace source). Folder values are never the source: Desk reads without a folder, so they do not apply; a row says so when they exist ("Also set in folder settings of …"). No setting contributed today has a resource-level scope, so this note is covered by model tests only.

### Where a change is written

Decision (ADR-0062): **user by default; workspace when it already overrides or the user chooses it; never a folder.**

- A setting whose scope is `application` or `machine` is written to the **user** layer only; no workspace option is offered and the host refuses a request for it. The row states the scope.
- Any other setting is written to the **user** layer, unless a workspace value already overrides the user value, in which case the default layer is the **workspace**: a user write would change nothing in effect. When a workspace is open (a folder, or a workspace file) such a row shows a "Save to User | Workspace" radio pair (the choice persists in the view's page state); choosing User while a workspace value overrides is allowed and the result says the workspace value still wins. With no workspace open only User exists, and the host refuses a workspace request. Desk itself writes nothing for a JSON row, so it has no radio pair: its link names the layer it opens (the workspace's file when the workspace holds the value, otherwise the user's) and the host reveals the key there. VS Code's own `revealSetting { edit: true }` is what opens it, and it was observed in an isolated window to insert and save the default entry when the key is absent (as VS Code's own Edit in settings.json does); the link says "Edit in <layer> settings.json" for that reason.
- Typing a value into a text or number field is a no-op only when it equals the value in effect **and** that value is the default or comes from the selected layer; typing it for the other layer writes it. Toggles and dropdowns fire only on a change of the displayed value, so writing the displayed value into the layer below an overriding workspace value needs Reset or the Settings editor; this is a known narrow limit.
- The controller (host) re-checks everything the page sends: the key must be one of the projected settings, the value must pass the schema again (type, enumeration, bounds, pattern), the layer must be one the scope and the window allow. A refused request writes nothing.
- Writes go through `WorkspaceConfiguration.update`, one at a time in request order; a failure (a `settings.json` with syntax errors, a read-only file) is shown on its row with VS Code's message. Writes are logged to the OMP Desk output (key, value, layer). Serialisation is per window: another window or a hand edit can still interleave, so the result is checked by reading the value back.
- **Sessions layout picker.** The existing Sessions title picker writes the user layer only, by its own contract. With this view a workspace can hold its own `omp.sessionsGrouping` as a normal in-product state, so the picker now says so when its choice does not take effect: it names the workspace only if a workspace value exists (otherwise a neutral "another setting changed it" message), with an Open Settings button; it does not change where it writes.

**Reset to default** removes the value from **every writable layer that holds one** (workspace first, then user), so the default really takes effect again. The row states this before the user acts: the button's accessible name and tooltip name the layers it will clear and say that a User value applies in every window (it is independent of the Save-to choice). A folder layer is left alone; Reset is offered only when a layer holds a value; a failure on the second layer reports what was already cleared; the effective value is read back, and a value other than the default (another window wrote meanwhile) is reported rather than called a reset. A value equal to the default is written like any other (VS Code decides whether to store it); Reset is how the user removes it.

### Live update and the page's state

The controller owns no cache. `workspace.onDidChangeConfiguration` (filtered to the projected keys) and `onDidChangeWorkspaceFolders` make the provider push a fresh state to the page **while the view is visible**; a hidden view is not passively read, and showing it again re-reads. A write already admitted when the view hides still finishes and is read back. So a `settings.json` edit, the Settings editor, another window's write and Desk's other surfaces (the Chat footer picker) all appear without a command.

The page keeps its state in a pure reducer (`src/webview/desk-settings/page-state.ts`, tested) with these rules:
- Every write has a request id. A toggle or choice shows its new value at once as *pending* for that setting; **an unrelated snapshot never rolls a pending write back**; a result for that request settles it (success: kept until the next snapshot confirms it; failure: dropped, so the control returns to the stored value); an older request's result never clears a newer pending write.
- Notes are per request: a success note fades after a few seconds only if it is still that request's note; a failure stays until the next action on its row.
- Only the latest request of a row is presented: a result for an older write, for a request before a Reset or open on that row, or for a request this document never sent (an earlier document of the view) is ignored. Reset and open actions are requests of their row too.
- A text field keeps the user's draft across snapshots; this document's own earlier save coming back while the user kept typing rebases the draft instead of counting as an outside change. Ownership is request-scoped and needs the host's acknowledgement: only a write the host answered as saved, and not yet read back, can explain a stored value (whichever of the answer and the snapshot arrives first; a value that matches an unanswered request is not attributed to it, because the request may still fail, so leaving the field in that window defers the decision to the answer: a success rebases the newer draft and saves it, a failure plus an outside change adopts the stored value, a failure with no change keeps the draft as an ordinary unsaved one); a failed write never does, and an earlier successful value that comes back later from another window is an outside change. A result always settles its own pending write; only the presentation of its note depends on its being the row's latest request. If the stored value changes elsewhere while the user is typing, leaving the field **adopts the current value** (with a note) instead of saving the stale draft over it; pressing Enter is the explicit save and does replace it.
- The page recreated after being hidden starts from `ready` and a fresh state, and ignores results of an earlier document's requests.

### Actions per row

- **Open in Settings editor**: `workbench.action.openSettings` with `@id:<key>`.
- **Edit in <layer> settings.json** (arrays/objects and other JSON rows): `workbench.action.openSettingsJson` (or `workbench.action.openWorkspaceSettingsFile` when the workspace holds the value) with `revealSetting: { key, edit: true }`.
- Reset, and the layer choice above.
- **Test** (rows marked testable; `omp.executablePath` today, [ADR-0011](../decisions/0011-use-installed-omp-without-version-gate.md) amended): runs the typed value through the same resolution a launch uses and shows the resolved file and release, or the exact failure, under the row. It needs no layer choice and saves nothing; an empty value tests the PATH search. The result is kept per row beside, not inside, the write note, so it neither fades nor is replaced by a snapshot, and an answer for an older Test is ignored.

### Page behaviour and accessibility

One column for a narrow side bar. A sticky search box filters by label, key, group, description and option text, every term required, with a live "N of M settings match" status; `Esc` clears. Long descriptions clamp to about three lines with a "Show more" button (`aria-expanded`). Every control is a native element with a label (checkbox, `select`, `input`), the setting's description and the selected option's help are associated with it through `aria-describedby`, the layer choice is a native radio group in a `fieldset`, icon buttons have accessible names that include the setting, results use `aria-live`, validation messages `role="alert"`. Text inputs save on Enter or blur, cancel on `Esc`, and show the schema's reason inline; an invalid value is never sent. Colours come only from VS Code theme variables, including forced-colour focus outlines. Page state (query, chosen layers) survives the view being hidden through `setState`; the Webview is not retained while hidden. Screen-reader behaviour and high-contrast rendering are not verified by this design's checks.

### Components

- `src/host/desk-settings/model.ts`: projection, validation, source/target/reset rules, search (pure; shared with the page bundle).
- `controller.ts`: state assembly and action handling over a small port (`inspect`, `effective`, `update`, `workspace`, open commands); no VS Code import.
- `view.ts`: binds the port to the configuration API, the Webview view provider, the CSP and the change listeners.
- `protocol.ts`, `src/webview/desk-settings/{main.tsx,page-state.ts,styles.ts}`.
- One `registerDeskSettingsView(context, { log })` call in `extension.ts`.

## Alternatives

- **A tree view with `QuickPick`/`InputBox` editing.** Reuses the container's view pattern and can show checkboxes, but cannot show a dropdown or inline validation, and every other edit becomes a modal; rejected for the stated goal of in-place controls.
- **Only a command that opens the Settings editor filtered to `@ext:`.** Cheap, but not in the side bar, no source/reset summary.
- **A hand-maintained list of settings in the page.** Drifts silently from `package.json`; rejected (the requirement is that new settings appear automatically).
- **Reading `package.json` from disk.** Equivalent content but a second read path; `context.extension.packageJSON` is the manifest VS Code loaded.
- **Writing folder layers or choosing the layer automatically from the open window.** The extension reads settings without a folder, so a folder write could never take effect; automatic workspace writes would silently modify a file a repository may track.
- **Retaining the Webview while hidden.** Costs memory for a view that is cheap to rebuild from `setState`; rejected.
- **Changing the Sessions layout picker to follow the new layer rule.** Would change an existing caller's contract; rejected in favour of explaining an override.

## Risks and Open Questions

- The schema subset is deliberately small and fails closed; a future setting shaped unlike the table appears as read-only JSON with a link, never as a wrong control.
- `revealSetting` on `workbench.action.openSettingsJson` and `@id:` search are VS Code workbench commands, not extension API; both are checked in the installed window, and a failure is shown on the row.
- A `settings.json` with parse errors makes `update` throw; the row shows VS Code's message.
- Untrusted workspaces are not a new mode: the extension does not support them (its manifest says so).
- Fake-port tests prove the host rules, not VS Code's command behaviour, scope filtering or accessibility; those are exercised in an isolated window and recorded in Rollout and Verification.

## Rollout and Verification

1. Implement; focused tests for projection (schema to control, including fail-closed shapes), source/target/reset selection, validation, the controller's writes and refusals, and the page reducer's orderings; `npm run typecheck`.
2. Build and exercise in an isolated minimized window driven through CDP. The shipped manifest has only booleans and string enumerations, so the number, string and array controls are exercised against a copy of the extension whose manifest adds those settings (the isolated window loads that copy as its development extension). Cases: all settings listed; change a boolean, an enum and a number; Reset; search; an external `settings.json` edit reflected live; a workspace value shown and written; an application setting's workspace value ignored; the settings and `settings.json` actions.
3. Update `architecture.md`, the docs index and the CHANGELOG `Unreleased`.

## Related Decisions

[ADR-0062](../decisions/0062-render-the-settings-view-from-the-contributed-schema-in-a-webview-view.md). Builds on [Skills, Tools, MCP and Extensions views](2026-10-11-skills-tools-mcp-extensions-views.md) (the container and its read-while-visible rule).

## Architecture Review

- Reviewer: architect
- Outcome: Round 1 (an independent architect agent) requested changes (fail-closed projection, request-correlated page state, draft/external-change handling, consistent layer selection, explicit Reset disclosure, the Sessions layout picker interaction, documentation corrections); rounds 2 to 6 requested further changes in the page-state and layer-handling rules (own-write attribution by request, settlement independent of note presentation, deferred blur decision, single consumable deferred save and failure correlation to its own write); all were resolved; round 7 accepted with no remaining findings. Architecture acceptance only: the reviewer ran no code.
- Notes: accepted after independent architecture review.
