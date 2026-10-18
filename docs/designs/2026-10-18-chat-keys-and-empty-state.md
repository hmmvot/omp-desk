---
status: accepted
date: 2026-10-18
---

# Chat keys that do not collide, an empty state that teaches them, and a warning when another extension takes one

Requested by the maintainer (2026-10-18), all decisions below approved in the request: move two Chat keys that clash with the IntelliJ IDEA Keymap, drop `Alt+Shift+K` and **Add Selection to Session**, let `Alt+Q` reference the caret line when nothing is selected, add `Ctrl+/` and a keyboard button for "all shortcuts", rewrite the empty Chat as grouped key hints, and show, in those hints, the key the user *actually* has and whether another extension or the user's own `keybindings.json` may be taking it.

## Problem

1. **Two Chat defaults collide with a popular keymap.** The IntelliJ IDEA Keymap binds `Ctrl+T` to `git.sync` with **no `when`**, and `Ctrl+R` to `editor.action.startFindReplaceAction` under `editorFocus || editorIsOpen`. An editor tab that holds a Chat makes `editorIsOpen` true, so in a Chat both our `ompDesk.toggleThinking` (`Ctrl+T`) and `ompDesk.searchPromptHistory` (`Ctrl+R`) are contested, and VS Code does not let an extension choose its place in the keybinding order (`docs/guide/keyboard-shortcuts.md`, *Keymap notes*).
2. **Two commands are redundant.** `Alt+Shift+K` (**Add Selection to Session**) writes an `@path [lines a-b]` mention into a session; **Quote Selection to Session** (`Alt+Q`) already carries the file, the lines and the text, and an `@` mention makes an idle OMP read the whole file (`docs/designs/2026-10-15-quote-chat-selection.md`, *Format*). **Add File to Session** (Explorer and tab menus) has no replacement and stays.
3. **`Alt+Q` with no selection warns "Select some text first."** A caret on a line is a legitimate thing to point at.
4. **The empty Chat lists five hints, three of them about keys that most users never press, and nothing about the keys that matter** (`Alt+Q`, `Ctrl+F`, `Alt+↑`, the editor-side keys). It also states keys as constants, although a user may have rebound or removed them or another extension may have taken them.
5. **No quick way to see every Desk key.** `ompDesk.showChatKeyboardShortcuts` exists (palette, `/hotkeys`, the Chat's title menu) but has no key and no button.

## Decisions

### 1. Keys

| Command | Before | After | `when` |
| --- | --- | --- | --- |
| `ompDesk.toggleThinking` | `Ctrl+T` | **`Ctrl+Alt+T`** | unchanged (Chat only) |
| `ompDesk.searchPromptHistory` | `Ctrl+R` | **`Ctrl+Alt+Y`** | unchanged (Chat only) |
| `ompDesk.showChatKeyboardShortcuts` | none | **`Ctrl+/`** | Chat only |
| `ompDesk.quoteEditorSelection` | `Alt+Q`, `editorTextFocus && editorHasSelection` | `Alt+Q`, **`editorTextFocus`** | |
| `ompDesk.sendSelection` | `Alt+Shift+K` | **removed** | |

`Ctrl+/` is bound only under the Chat `when` (`activeWebviewPanelId =~ /^omp[.]session/ && ompDesk.sessionMode == chat`). The IntelliJ keymap binds `Ctrl+/` only with `editorTextFocus`, which is false in a webview, so there is no clash. The key is the physical `Slash` key (VS Code's `KeyCode.Slash`; the Windows virtual key `VK_OEM_2`): VS Code matches a keybinding written `ctrl+/` against the physical key where `keyboard.dispatch` is `code` and against the typed character where it is `keyCode` (the default), so a layout whose Slash key types another character is a real question; see *Evidence* for what was and was not exercised on a Russian layout.

**Mnemonics (decided by evidence).** `Alt+T` and `Alt+H` were the first choice and are exactly the menu bar's `&Terminal` and `&Help` mnemonics on Windows. A real window (default menu bar, `E2E_LAYOUT=minimal`) showed that pressing `Alt+T` in a Chat **ran the command and also opened the Terminal menu** (`.menubar-menu-button.open`, `aria-keyshortcuts="Alt+t"`), so a plain `Alt+letter` cannot be a Chat key. The keys are the fallback `Ctrl+Alt+T` and `Ctrl+Alt+Y` (the mnemonic is the *Y* of histor*y*; `H` is Call Hierarchy for IntelliJ users). `Ctrl+Alt+<letter>` is already what `Ctrl+Alt+Q` and `Ctrl+Alt+N` use, and the page forwards a Ctrl+Alt chord to the workbench.

### 2. `Add Selection to Session` is removed

`ompDesk.sendSelection` is deleted with its command entry, its `editor/context` menu entry, its keybinding, `addSelectionToSession`, the selection-only branch of the shared helpers and their tests and documentation. `ompDesk.sendFile` and the `sendCandidates` / `pickSendTarget` machinery stay (Add File, and the quote's picker, use them).

The old id `omp.sendSelection` is one of the 92 legacy ids of ADR-0068 (a command published under that name in 0.3.x). It has no target left, so it leaves `LEGACY_COMMAND_IDS` and `LEGACY_ALIASES` (91 remain) and **ADR-0068 gets a dated amendment** recording that the table is no longer frozen at 92: a user keybinding that still names `omp.sendSelection` is a dead entry like any command that no longer exists, and nothing registers an alias that would run a command that is not there. The alias tests and the counts in `contributions.test.ts` and `legacy-aliases.ts` change with it.

### 3. `Alt+Q` with no selection inserts a line reference

`quoteEditorSelectionToSession` keeps its id, its title (**Quote Selection to Session**) and its key. When no selection of the active editor is non-empty it takes the caret instead of warning:

* The reference is `` `path:N` `` (inline code, one-based line of the primary caret, `selection.active.line + 1`), written by the same `quoteLocation` as a quote's location line: the path relative to the target session's folder when inside it, else absolute with forward slashes; a Git version of a diff side adds ` @ <version>` (`` `src/app.ts:42 @ HEAD (3f2a9c1)` ``). It is never an `@` mention, for the reason given in the quote design.
* The target rule is the quote's, unchanged: the visible Chat of this window (the last focused one if several), else the picker; Chat sessions only, **New session** starts a Chat.
* The text goes into the draft through the existing `omp:insert-text` message, which the page already places at the caret with the spacing rule of `spaceInsertion` and never submits. A reference is a single line of at most 900 characters, which is what that message accepts; the host refuses a longer path with the quote's own reason. Nothing new is added to the page protocol.
* A document with no location (an untitled document, a scheme other than `file` and `git`, a `git:` document whose version cannot be told truthfully) is refused with a short reason: "This document has no file location to reference. Select text to quote it instead."
* With several carets, only the primary caret is referenced. With any non-empty selection the quote behaviour is unchanged (empty carets among them are ignored, as today).

The key's `when` becomes `editorTextFocus`, the `editor/context` entry's `when` becomes `editorTextFocus`, and the command's `enablement: editorHasSelection` is removed.

### 4. `Ctrl+/` and the keyboard button

`Ctrl+/` runs `ompDesk.showChatKeyboardShortcuts`, which already opens Keyboard Shortcuts filtered to `ompDesk.` through `workbench.action.openGlobalKeybindings`. The composer's action row gets a keyboard icon button (codicon `keyboard`, title "Keyboard shortcuts (Ctrl+/)", `aria-label` "Keyboard shortcuts") next to the Commands button. It follows that button's convention: it posts the existing `omp:chat-command` message with the existing `keyboard-shortcuts` command, which `runChatAction` already routes to `showChatKeyboardShortcuts`; no new message is needed for it. The title names the *effective* key (the same value the empty state shows) and falls back to `Ctrl+/` when the host sent none. (The command is in the Chat's `editor/title` menu and the palette; there is no `webview/context` item for it.)

### 5. The empty state

`EmptyState.tsx` replaces the five hints with four groups of one-line hints, two columns when the transcript area is wide enough and one when narrow, each key in `<kbd>`. The header (folder · model · thinking) and **Recent in this folder** stay as they are.

| Group | Hints (keys → text) |
| --- | --- |
| Start | `/` commands and skills · `@` attach a file · `Ctrl+V` or `Shift`+drag: an attachment · `↑` an earlier prompt · `Ctrl+Alt+Y` search prompts |
| While the agent works | `Enter` steer · `Alt+Enter` queue · `Alt+↑` take a queued message back · `Esc` stop |
| In the conversation | `Ctrl+F` find · `Alt+Q` quote · `Esc Esc` rewind · `Ctrl+Alt+T` / `Ctrl+O` thinking / tool calls |
| From the editor and anywhere | `Alt+Q` quote or line reference · `Ctrl+Shift+L` composer · `Ctrl+Alt+Q` go to session · `Ctrl+Alt+N` new session |

Under the groups a link, **All keyboard shortcuts (Ctrl+/)**, runs the same `keyboard-shortcuts` command. The texts are English, the UI language.

A key that is a Desk command (`Ctrl+Alt+Y`, `Esc`, `Ctrl+F`, `Alt+Q`, `Ctrl+Alt+T`, `Ctrl+O`, `Alt+Q` of the editor, `Ctrl+Shift+L`, `Ctrl+Alt+Q`, `Ctrl+Alt+N`, `Ctrl+/`) is drawn from the **effective key** that the host sends (below), and falls back to the manifest default while the host has said nothing (a Chat in a test fixture, or a page on a bridge route whose host has not answered; the page's copy of the defaults is pinned to `package.json` by a test). A key that is not a Desk command (`/`, `@`, `Ctrl+V`, `Shift`+drag, `↑`, `Enter`, `Alt+Enter`, `Alt+↑`, `Esc Esc`) is a constant of the page. A Desk command with no key (removed by the user) shows a muted `none` instead of a key.

### 6. Effective keys and conflicts

The host computes, for the commands the empty state shows (`EMPTY_STATE_KEY_COMMANDS`, one list in `src/shared/key-hints.ts` used by the host and the page): the key the user has, and the other commands that may take it.

**Inputs, all read asynchronously and cached; none blocks activation.**

1. **The defaults**: this extension's own `packageJSON.contributes.keybindings` (`win`, else `key`), so the manifest is the one source of truth. A command's *context* comes from its own `when`: one that names `editorTextFocus` is an `editor` command (only `ompDesk.quoteEditorSelection`); one with a Chat `when` is a `chat` command, evaluated in a Chat webview with the focus; one with no `when` (`ompDesk.focusComposer`, `goToSession`, `newSession`) is pressed in both.
2. **The user's `keybindings.json` of the active profile.** `context.globalStorageUri` is `<profile folder>/globalStorage/<publisher.name>`, where the profile folder is `<user data>/User` for the default profile and `<user data>/User/profiles/<profile id>` for any other. This is how VS Code builds a profile (`UserDataProfile.globalStorageHome` and `keybindingsResource`, read from the workbench source of 1.142): the profile's own `globalStorage` and `keybindings.json` are siblings under its folder, **unless** the profile's `useDefaultFlags` says it shares that part with the default profile (`globalState` for the storage, `keybindings` for the file), in which case the property points into the default profile's folder. The profile folder is therefore two levels above `globalStorageUri`, and `keybindings.json` sits there. Read as JSONC (comments, trailing commas, a BOM), capped at 1 MiB, an array of `{ key, command, when?, args? }`. A file that is **missing** counts as no user bindings; one that cannot be read, is too large or is not valid JSON keeps the bindings read before it (see *Recomputation*). *Limit:* the flags are not visible to an extension. The derivation is exact for the default profile and for a profile that shares both or neither (a profile created with its own keyboard shortcuts and its own extensions state; the Agents window's profile, which shares everything). For a mixed profile it reads the wrong file: when only the extensions' state (`globalState`) is shared, it reads the **default profile's** `keybindings.json` instead of the profile's own; when only the keyboard shortcuts are shared, it reads the profile's own `keybindings.json` (usually absent) instead of the default's, which is the file VS Code uses. The limit is documented in the guide.
3. **Every installed extension's `contributes.keybindings`** (`vscode.extensions.all`, `packageJSON.contributes.keybindings`, an array or one object; `win`, else `key`; entries with a `command` starting with `-` are removals, applied as *Removals* below, never conflicts; this extension's own entries are skipped, since its overlapping `when` clauses are designed). Built-in extensions are included, because they are extensions too. *Limit:* VS Code's own core default keybindings (`workbench`, editor) are not readable by an extension and are not considered.

**The effective key of a command.** The user's entries are applied in file order:

* a removal (user's or another extension's, see *Removals* below) takes away the defaults it matches;
* the user's entries that bind `<id>` to a key (not a removal, a non-empty `key`) *replace* the default, but only an entry whose `when` can hold where the command's key is pressed (an entry `when: editorTextFocus` for a Chat command would be shown although pressing it in a Chat does nothing); **the last** such entry is shown, as VS Code resolves the user's rules from the end of the list (`ctrl+k ctrl+t` is one key of two chords);
* otherwise the first default that survives the removals is shown, and a command with none has the key `null`.

**Key normalization**, for comparing and for display: lower case, whitespace-separated chords; in each chord the modifiers `ctrl`, `shift`, `alt`, `meta` in that order (`cmd`, `win`, `super` are `meta`; `control` is `ctrl`; `option` is `alt`) and the key last (`esc` is `escape`, `return` is `enter`, `del` is `delete`). Display capitalizes each part (`Ctrl+Alt+Q`, `Alt+Up` is shown as `Alt+↑`).

**What counts as a conflict.** A foreign binding conflicts with the effective key *K* of command *C* when its normalized key equals *K*, its `when` is **not obviously false** where *C*'s key is pressed, and no removal takes it away (below). *C* is pressed in a Chat for a command with a Chat `when`, in an editor for the editor's `Alt+Q`, and in **both** for a command with no `when` (`Ctrl+Shift+L`, `Ctrl+Alt+Q`, `Ctrl+Alt+N`): such a command conflicts if the foreign binding can apply in either. A user's own binding of another command (not a removal, not *C* itself) counts the same, whatever removals the file holds (a removal takes defaults, never the user's own entries). The `when` rule is deliberately conservative toward showing a conflict:

* A missing or empty `when` is true.
* The clause is parsed as VS Code's grammar of `||` (lowest), `&&`, `!`, parentheses and comparison atoms (`key`, `key == v`, `key != v`, `key =~ /re/`, `key in x`, `key not in x`, `>`, `>=`, `<`, `<=`); a clause that does not parse is true.
* An atom is **false** (cannot hold) only when its key is in one of **two finite tables** exported from `src/host/key-hints.ts`, and its operator needs the key to be set: the key alone, `==`, `=~`, `in`, a relation. `!key`, `!=` and `not in` on such a key are true, because an unset key is `undefined`. The tables hold focus, selection and widget keys, never keys that state a capability of the window:
  * *false whatever has the focus when the key is pressed* (`NEVER_IN_ANY_CONTEXT`): `inQuickOpen`; `terminalFocus`, `terminalFocusInAny`, `terminalEditorFocus`, `terminalTextSelected`, `terminalTextSelectedInFocused`, `terminalFindFocused`, `terminalFindInputFocused`, `terminalAltBufferActive`; `notebookEditorFocused`, `notebookCellListFocused`, `notebookOutputFocused`, `notebookCellEditorFocused`, `notebookCellFocused`, `notebookFindWidgetFocused`;
  * *false only with a Chat webview focused* (`NOT_WITH_A_CHAT_FOCUSED`, not used for the editor's `Alt+Q`): `editorTextFocus`, `editorFocus`, `textInputFocus`, `editorColumnSelection`, `editorReadonly`, `editorHasSelection`, `editorHasMultipleSelections`, `editorLangId`, `editorHoverFocused`, `findWidgetVisible`, `findInputFocussed`, `replaceInputFocussed`, and the `editorHas…Provider` keys of the language features, each named in the table.
* `editorIsOpen` is **true** in both contexts (a Chat is an open editor), so `editorIsOpen` holds and `!editorIsOpen` is obviously false: a binding gated `!editorIsOpen` is not a conflict.
* Every other key, including `terminalIsOpen`, `terminalHasBeenCreated`, `notebookKernelCount`, `activeWebviewPanelId`, `resourceScheme`, `view`, `config.*` and anything unknown, is **maybe true**, so a clause that contains one is not obviously false.
* `A && B` can hold when both can; `A || B` when either can; `!X` is evaluated by pushing the negation to the atoms.

**Removals.** An entry `-<id>` removes **defaults**, never a positive entry of the user's own file, by VS Code's rule (`keybindingResolver.ts`, `_isTargetedForRemoval`, read from the `main` source): the same command; the same key when the removal names one; and, when it names a `when`, a default that has a `when` and **implies** it (every `&&` term of the removal is a term of the default's clause; a clause with `||` is compared as text). A removal with a `when` therefore takes a broader-than-the-default clause's default away (`editorTextFocus` removes a default gated `editorTextFocus && !editorReadonly`), takes nothing from a default with no `when`, and one with no `when` takes every `when`. Removals come from the user's file **and from the other extensions' manifests** (a keymap may remove our default), and apply to this extension's defaults and to every extension's bindings. The rule is one function in `src/host/key-hints.ts`, used for all of them.

The result is reported as "*may* be taken": the order in which VS Code resolves a user binding, several extensions and the core defaults is not visible to an extension, and a `when` that depends on a state we cannot read is not evaluated. Two-chord keys are compared as whole keys; a foreign binding of the first chord alone is not reported.

**The message.** The host keeps a current list of `{ command, key, conflicts }` (one per shown command) and sends it to a Chat page as a new `omp:chat-keys` message of the chat family, by the route of `omp:chat-code-theme`: to a page when it attaches (`resend`) and to every attached page when the list changes (`refreshKeyHints`). It needs no epoch. A conflict is `{ by, command }`: `by` is the extension's display name (its `displayName`, or its id when the display name is missing or an unresolved `%…%` placeholder) or "your keybindings.json"; the host replaces control characters in both strings with spaces, trims them, clips them to the page's bound (128 characters) and drops a conflict with nothing left, because the page parser refuses the **whole** message for one string it cannot take. At most three conflicts are sent, with the count of those not sent. The page validates the message by the bounds in `src/protocol/chat-messages.ts` and shows nothing it cannot validate.

**Recomputation.** The defaults and the foreign index are built once at registration and again, debounced (100 ms), on `vscode.extensions.onDidChange`; the user file is read again, debounced (150 ms), when it changes (a `fs.watch` on its folder, not on the file, so an editor's replace-by-rename is seen; `persistent: false`). The list is compared with the last one; the page is told only when it differs. **A failed read keeps the previous bindings and logs one line**: a missing file is "no user bindings" (a new file, or a deleted one, is a real change), but a file that cannot be read, is not valid JSON (an editor can write it half-way) or is over the limit leaves what was read before, so a transient state never shows the defaults for a moment. `dispose` closes the watcher and the timers.

**The marker.** In the empty state a hint whose key has a conflict shows a warning codicon after the key, with a tooltip: "`Ctrl+Alt+T` may be taken by IntelliJ IDEA Keymap: git.sync" (the display name is the extension's, the command is its command id; with more, "and 2 more"). Clicking it posts a new page message `omp:open-key-conflict { command }`; the host looks the command up in its **current** list and opens Keyboard Shortcuts filtered to its key with `workbench.action.openGlobalKeybindings` and the query `@keybinding:"<normalized key>"` (the form of the editor's own search; `@command:` is the other form it accepts, verified in the workbench source of 1.142), or `@command:<id>` when the key holds a quote mark that the first form cannot carry. The page names no query and no key, only the command id, which the host must find in its list.

### 7. Where the code lives

* `src/shared/key-hints.ts` (no `vscode`): `EMPTY_STATE_KEY_COMMANDS`, the types of `ChatKeyHint`.
* `src/host/key-hints.ts` (no `vscode`; pure, the unit-tested part): key normalization and display, the `when` rule with its two exported tables of context keys, the removal rule, the effective-key and conflict computation from plain inputs.
* `src/host/key-hints-source.ts`: the reading, caching, watching and debouncing, with injected ports (no `vscode`, tested with real temporary files).
* `src/shared/jsonc.ts`: the JSONC reader, moved out of `src/host/code-theme.ts` so both readers use one (`code-theme.ts` imports it).
* `src/wiring/key-hints-wiring.ts` (`vscode`): the manifests of `vscode.extensions`, `vscode.extensions.onDidChange`, the path of the profile folder; modelled on `code-theme-wiring.ts`.
* `src/host/chat-runtime.ts`, `src/runtime/*`: `readKeyHints`, `refreshKeyHints`, the `omp:chat-keys` post on `resend`.
* `src/protocol/chat-messages.ts` and `src/protocol/messages.ts`: the two messages and their parsers.
* `src/webview/lib/key-hints-store.ts` (the `omp:chat-keys` listener is attached module-level in `main.tsx` before the page announces itself, like `attachCodeTheme`, so the host's first post is not missed; its `DEFAULT_KEYS` are pinned to `package.json` by a test, because the page shows them when the host has said nothing), `src/webview/components/EmptyState.tsx`, `KeyboardShortcutsButton.tsx`, `styles.ts`.
* `src/wiring/editor-context.ts`, `src/extension.ts`: the line reference; the removal of Add Selection.
* Documentation: `docs/guide/keyboard-shortcuts.md`, `docs/guide/chat.md`, `docs/guide/send-code.md`, `docs/product.md`, `docs/architecture.md`, `docs/designs/2026-10-15-quote-chat-selection.md` (a note that decision 9's `when` and "select text first" are superseded), `docs/designs/2026-10-07-add-editor-context-to-session.md` (a note that Add Selection was removed), ADR-0068 (a dated amendment) and `CHANGELOG.md`.

## Alternatives

1. **Keep `Ctrl+T` and `Ctrl+R` and document the clash.** Rejected by the maintainer: the clash is with a keymap many users have, and it cannot be fixed from our side.
2. **`Alt+T` / `Alt+H`.** Tried first and rejected by the real-window check: the menu bar's mnemonics open the Terminal and Help menus even when the command runs (*Evidence*). `Ctrl+Alt+T` / `Ctrl+Alt+Y` are two-modifier keys, slower to press and wider in a one-line hint, but they are the keys that work.
3. **A new command for the line reference.** Rejected: the key, the menu and the target rule are the quote's; a second command would need its own key (no free `Alt+` letter next to `Alt+Q`) and the user thinks of both as "quote".
4. **A reference as a quote line (`> \`path:42\``).** Rejected: a quote means "this text"; with no text there is nothing to quote, and the sent message should show a plain inline-code location, as a typed path would.
5. **Read the user's bindings through a VS Code API.** There is none (`vscode.commands.getKeybindings` does not exist); the file is the only source, and the active profile is derivable only from storage paths.
6. **Evaluate `when` with the workbench's own parser.** Not available to extensions; a small reader of the grammar over an explicit table of keys is enough because a clause we cannot read, and any key not in the table, is treated as possibly true (a conflict shown, never hidden).
7. **Flag only exact `when`-less bindings.** Rejected by the request: a `when` such as `editorIsOpen` is true in a Chat and is the real IntelliJ case.
8. **Send the whole list of every Desk key.** The page needs the dozen it shows; a bounded list with one list of commands in `src/shared` keeps the message small and the page from naming arbitrary commands.

## Risks and limits

* **Mnemonics and a native title bar.** The verification covers VS Code's custom title bar, the default on Windows. With `window.titleBarStyle: "native"` the menu is Windows's own, and `Alt+letter` may be consumed by the operating system before the page sees it; that was not exercised.
* **The profile's file.** See the limit above; it is stated in the guide.
* **Core keybindings are not read.** A clash with a VS Code core default shows no marker.
* **Order is unknown.** "May be taken" is the strongest statement available. A prefix of a two-chord key (a foreign binding of `ctrl+k` against a shown `ctrl+k ctrl+t`) is not reported.
* **`Ctrl+/` itself.** The link and the composer's button show its effective key but carry no marker; a foreign binding of `Ctrl+/` is not flagged there (it is flagged by the unit rule, which has no place to show it).
* **The line reference during a draft hand-off.** `omp:insert-text` is deferred while a draft capture is held and while an IME composition is open, and runs only if the same document is still mounted. A line reference sent in that window is lost with the replaced document although the host reported it delivered; the quote design refuses a quote in that window, a reference is one short line and the window is the length of a hand-off, so the line reference accepts the deferral and the loss is disclosed here, not engineered away.
* **A page on a bridge route.** After a host restart (ADR-0023) a page may be on an acknowledged bridge route, which carries a fixed set of operations. `omp:chat-keys` reaches it (host to page), so the keys, the markers, the link and the keyboard button are drawn; but a click on the marker, the link or the button is a panel-only exchange and is dropped by the page until the panel route is back (the same as every other chat command that is not on the bridge's list). The page shows its route notice meanwhile.
* **Russian layout.** See *Evidence*.
* **Removed alias.** A user keybinding that names `omp.sendSelection` becomes a dead entry; see the ADR-0068 amendment.

## Test plan

* Unit (`node --test`): `src/host/key-hints.test.ts` (normalization; the `when` rule, including a capability key such as `terminalIsOpen` that is a conflict and a focus key that is not, `editorIsOpen` and `!editorIsOpen`; the effective key with a user rebinding, the last of several entries, an entry whose `when` cannot hold in a Chat, a removal with a broader, a narrower and no `when`, a removal of a default that has no `when`, another extension's removal of our default and of a third extension's binding, a positive entry of the user's file that a removal in the same file does not touch; JSONC with comments and trailing commas; a global command judged in a Chat and an editor; foreign names with control characters and over the bound; a key with a quote mark and its `@command:` query), `src/host/key-hints-source.test.ts` (the profile folder from `globalStorageUri`, the file read, a file that is missing, half-written, too large; the watcher; extension changes; dispose), `src/wiring/editor-context.test.ts` (the line reference: relative and absolute, a Git version, an untitled document, a backtick in the path, a long path), `src/protocol/messages.test.ts` and `chat-messages.test.ts` (both messages), `src/wiring/guest-dispatcher.test.ts` (the page→host message), `src/host/chat-runtime-key-hints.test.ts` (resend and refresh), `src/webview/lib/key-hints-store.test.ts` (the defaults equal `package.json`'s keybindings through `displayKey`), `src/wiring/contributions.test.ts` (the keys, the `when` strings, no `ompDesk.sendSelection`, no `omp.sendSelection` alias, 91 aliases).
* Chromium (`src/webview/chat-ui.test.ts`): the grouped empty state in two widths, the effective key replacing the default, `none`, the conflict marker, its tooltip and its click, the link, the keyboard button and its row at 360 px.
* A real hidden window (`test/e2e/scenarios/47-chat-keys.spec.ts`): `Ctrl+Alt+T` toggles thinking, `Ctrl+Alt+Y` opens the history search, neither opens a menu-bar menu; `Ctrl+/`, the same key on a Russian layout (a CDP key event for the physical `Slash` key, which reports `.`), the keyboard button and the link open Keyboard Shortcuts filtered to `ompDesk.`; `Alt+Q` with no selection puts `` `path:N` `` into the draft and an untitled document is refused; a user `keybindings.json` that binds `ctrl+alt+t` elsewhere makes the marker appear, a click on it opens Keyboard Shortcuts on `@keybinding:"ctrl+alt+t"`, a removal of our key shows `none`, and deleting the file brings the default back.
* Screenshots of the empty state in a dark and a light theme, read with the image viewer.

## Evidence

Recorded 2026-10-18 on the implementation, in a real VS Code window (Windows, the default menu bar via `E2E_LAYOUT=minimal`, one hidden window at BelowNormal priority with the foreground watchdog: 0 violations).

* **Mnemonics: `Alt+T` does not work.** The first run of `47-chat-keys.spec.ts` with `Alt+T` showed the command ran (the log line `thinking blocks: shown by default` was written) **and** the Terminal menu opened (`.menubar-menu-button.open`, `aria-keyshortcuts="Alt+t"`) and stayed open. The workbench's own mnemonic handling is not stopped by a keybinding that wins, so `Alt+<mnemonic letter>` is unusable as a Chat key. The keys became `Ctrl+Alt+T` and `Ctrl+Alt+Y`; with them the same spec runs the commands, the history search opens, and no menu-bar menu opens.
* **Menu layout.** Only the default (non-compact) menu bar was run; the compact layout, which has no per-letter mnemonics, was not, and is not needed for the decision because the key no longer has a mnemonic.
* **`Ctrl+/`, also on a Russian layout.** `Ctrl+/` from the composer opens Keyboard Shortcuts with the search `ompDesk.`; a CDP key event for the physical `Slash` key reporting `.` does the same. The keyboard button and the empty session's link do too.
* **Line reference.** `Alt+Q` in a text editor with no selection puts `\`caret-sample.ts:3\`` into the draft; an untitled document is refused with a notification naming the missing file location.
* **Conflict marker.** A real `keybindings.json` binding `ctrl+alt+t` to `workbench.action.terminal.toggleTerminal` puts the marker with the title *Ctrl+Alt+T may be taken by your keybindings.json: workbench.action.terminal.toggleTerminal* on the key (the key itself stays); a click opens Keyboard Shortcuts searched for `@keybinding:"ctrl+alt+t"`; a user removal (`-ompDesk.toggleThinking`) removes the key and the marker; deleting the file brings the default back. **A defect found by this run and fixed:** with no user file, the key `Ctrl+F` showed a marker for the built-in Markdown extension's `markdown.editor.cursorRight` (`activeCustomEditorId == … && markdownEditorFocus && isMac`). `canApply` now knows the host's platform keys (`isMac`, `isWindows`, `isLinux`, `isWeb`) and that a Chat is no custom editor (`activeCustomEditorId`, `customEditorFocus`, `markdownEditorFocus` are false there); unit-tested.
* **Screenshots** (Chromium, dark and light, 900 px and 360 px; read with the image viewer): four groups, `<kbd>` keys aligned in the first column, the warning icon on a conflicting key, the link and the recent list below, the composer's keyboard button; at 360 px the groups stack in one column and nothing overflows. (They were taken before the keys moved to `Ctrl+Alt+T`/`Ctrl+Alt+Y`; the layout is unchanged and the chat-ui test pins the new texts.)
* **Review.** The first design review (two material findings: the `when` false-key table and the removal semantics, plus the ADR amendment, bridge route, docs, invalid file and `editorIsOpen` points) was resolved in this document and the code; the findings are reflected in *Decisions* above.
