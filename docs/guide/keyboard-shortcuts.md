# Keyboard shortcuts

All commands are in the Command Palette under **OMP Desk**. The ones with default keys:

| Key | Command | When |
| --- | --- | --- |
| `Ctrl+Shift+L` | Focus the chat composer of the active or visible session; opens the OMP Desk side bar when no session is open | Anywhere, including the integrated terminal (takes over VS Code's Select All Occurrences of Find Match key; rebind it with a user keybinding) |
| `Ctrl+Alt+Q` | Go to Session: a searchable list of every session (title, folder, status; unread first, stopped last, as in Sessions) that opens the one you pick, with **New Session…** at the end | Anywhere, including the integrated terminal |
| `Ctrl+Alt+N` | New Session: the **New Session…** row of Sessions (asks for the folder when several are shown, this window's folders first, so `Ctrl+Alt+N` then `Enter` starts a session in the folder open here) | Anywhere, including the integrated terminal |
| `Ctrl+Alt+R` | Resume Session: the **Resume Session…** row of Sessions (asks for the folder when several are shown, this window's folders first, then lists its saved sessions; `Enter` on the highlighted first row of each list resumes the newest one) | Anywhere, including the integrated terminal (takes over VS Code's Terminal: Run Recent Command key there; rebind it with a user keybinding) |
| `Ctrl+Shift+M` | Toggle the file window: the first press moves all files of the group next to the chat into one window that stays on top (files from Chat links open there too); the next press brings them back next to the chat and closes it | Anywhere, including the integrated terminal (replaces VS Code's Problems key; a keymap extension that binds it in text editors wins there unless you add a user keybinding) |
| `Ctrl+Enter` | Send composer prompt (`Enter` in the composer also sends) | Chat editor focused |
| `Ctrl+Enter`, in a fenced code block of the draft | Send, where `Enter` is a new line (see [code blocks in the draft](chat.md#code-blocks-in-the-draft)) | Chat editor focused, caret inside a block |
| `Ctrl+Enter`, on a quote line of the draft | Send, where `Enter` is a new line that carries the `> ` prefix; `Shift+Tab` leaves the quote (see [quoting Chat text](chat.md#quoting-chat-text)) | Chat editor focused, caret after the `>` of a quote line |
| `Esc` | Cancel the open question or dialog (OMP's `/review` pickers, a question card, an approval or a text prompt); with none open, stop the current turn. Never both: while a dialog is open `Esc` only cancels it, exactly like its **Cancel** button | Chat editor; stopping needs a running turn |
| `F5`, `Alt+R` | Retry the failed or aborted reply | Chat editor, no turn running |
| `Alt+Q` | Quote the selected Chat text into the draft (see [quoting Chat text](chat.md#quoting-chat-text)) | Chat editor |
| `Alt+Q` | Quote Selection to Session: the selected editor text goes into a Chat draft as a quote with its file and lines, straight into the Chat that is visible in this window (the one focused last if several), else into the Chat you pick from a list. In either side of a diff editor the lines are those of that side, and a side that is a Git version says which one (`src/app.ts:3-4 @ HEAD (3f2a9c1)`; see [quoting Chat text](chat.md#quoting-chat-text)) | Text editor or diff editor with a selection |
| `Ctrl+R` | Search prompt history | Chat editor |
| `Ctrl+F` | Find in the conversation: a find bar that searches every loaded message, not only the rows on screen, with `Enter`/`F3` next, `Shift+Enter`/`Shift+F3` previous, `Alt+C` Match Case and `Esc` to close (see [finding text](chat.md#finding-text-in-the-conversation)). It works on any keyboard layout, **Find in Chat** in the Command Palette opens the same bar, and the key can be rebound or removed like any other | Chat editor |
| `Ctrl+N` | Symbol search (`#`) prefilled with the Chat selection; a qualified name (`Type.Member`) opens its definition, or lists them to choose from | Chat editor |
| `Ctrl+Shift+N` | Go to File prefilled with the Chat selection | Chat editor |
| `Ctrl+T` / `Ctrl+O` / `Ctrl+Shift+O` | Show/hide all thinking / expand/collapse all tool calls / open or close the tool groups with every call collapsed | Chat editor |
| `Ctrl+Shift+U` | Cycle thinking level (**Cycle Model** has no default key) | Chat editor |
| `Ctrl+Alt+Shift+R` | Redraw Terminal | Terminal editor |
| `Alt+Shift+K` | Add Selection to Session (see [Send code to a session](send-code.md)) | Text editor with a selection |

Inside the Chat page, `Enter` steers a running turn, `Alt+Enter` queues a follow-up, `Alt+↑` takes the newest queued message back into the draft and `Esc` `Esc` starts a Rewind; see [Chat](chat.md). In the composer `Ctrl+Z` undoes and `Ctrl+Y` or `Ctrl+Shift+Z` redoes (the composer keeps its own undo stack, so VS Code's **Edit > Undo** menu item does nothing there).

## Keymap notes

A keymap extension (the IntelliJ IDEA keymap, for one) that binds `Ctrl+N` or `Ctrl+Shift+N` in text editors can win over these two keys, because VS Code does not let an extension choose its place in the keybinding order. Add a user keybinding (**Preferences: Open Keyboard Shortcuts (JSON)**) with the same `when` clause: `{ "key": "ctrl+n", "command": "ompDesk.searchSymbolFromChat", "when": "activeWebviewPanelId =~ /^omp[.]session/ && ompDesk.sessionMode == chat" }`, and the same for `ctrl+shift+n` with `ompDesk.searchFileFromChat`.

`Ctrl+Shift+O` is VS Code's Go to Symbol in Editor, which does nothing in a Chat (it has no text editor); OMP Desk takes it there only, under the same `when` clause. It is free in the IntelliJ IDEA keymap (that keymap puts Go to Symbol on `Ctrl+Alt+Shift+N`). If another extension binds it in a way that wins, or you want another key, add a user keybinding the same way: `{ "key": "alt+o", "command": "ompDesk.toggleToolGroups", "when": "activeWebviewPanelId =~ /^omp[.]session/ && ompDesk.sessionMode == chat" }`.

## Other commands

Other commands include **New Session**, **Add Folder**, **Pin Folder**, **Unpin Folder**, **Resume Session**, **Switch to Chat / Terminal**, **Compact Conversation…**, **Shake Conversation…**, **Export Conversation as HTML…**, **Share Conversation Link…**, **Show Chat Keyboard Shortcuts**, **Open Stats**, **Log In to Provider…**, **Log Out of Provider…**, **Show Diagnostics** and the file-change observation commands.
