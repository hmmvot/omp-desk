# Chat

Chat is the rich editor view of a session. It opens in an editor tab, shows the conversation as it streams, and follows your light, dark or high-contrast theme. The same tab can be switched to OMP's native [Terminal](terminal.md) at any time. New sessions open in Chat.

![A Chat mid-turn: a drawn diagram and links in the reply, a running turn with a queued follow-up, and a draft with an image and a code block](../../media/readme/chat-features.png)

## Writing and sending

- Streaming replies, saved history, image attachments and `@file` mentions.
- **Image attachments:** attach, paste, or hold Shift and drag an image in; up to 5 MiB each and 10 MiB per message.
- Your draft stays until OMP confirms it. Nothing is resent automatically.
- `↑`/`↓` in an empty composer walk through your earlier prompts. `Ctrl+R` searches past prompts of every conversation.
- Copy buttons on code blocks and on your own messages.
- **Retry** (`F5` or `Alt+R`) re-runs a failed or aborted reply.
- If OMP stops responding, **Reconnect** or **Restart** the conversation.

### Steer and queue while a turn runs

- While a turn runs, `Enter` steers it and `Alt+Enter` queues a follow-up.
- Queued messages can be edited, removed or sent now as steering. `Alt+↑` takes the newest one back into the draft.
- **Stop** (or `Esc`) puts messages that were still queued back into the draft instead of running them.
- OMP's questions and approval requests appear as a card above the composer.

### Code blocks in the draft

Type a line of three backticks, with a language if you like (`` ```ts ``), and press `Enter`: the composer adds the closing fence and puts the caret between the two. From the opening fence to the closing fence (or to the end of the draft while there is none) the composer works like a small editor:

- `Enter` is a new line that keeps the line's indentation and does not send.
- `Tab` indents (four spaces; on several selected lines it indents them all) and does not move the focus. `Shift+Tab` outdents.
- **`Ctrl+Enter` sends from inside a block** (a follow-up while a turn runs: `Ctrl+Alt+Enter`). `Enter` and `Tab` behave as before outside a block.
- Only the block is set in your editor's font, on a band that marks its rows; the prose around it keeps the proportional font. The text is the same: plain Markdown, fences included, and nothing completes inside a block: no `/` commands, no `@` files.
- A line under the composer lists these keys while the caret is in a block.
- **Keyboard way out:** `Shift+Tab` on a line with nothing left to outdent moves the focus to the previous control; `Ctrl+Shift+L` brings it back.

### Editing the draft

- `Ctrl+Z` undoes and `Ctrl+Y` or `Ctrl+Shift+Z` redoes, including a pasted image and its reference. VS Code's **Edit > Undo** menu item does not act on the composer: use the keys.
- A paste inserts plain text only, whatever the page it came from. Text you drag onto the composer lands where you drop it.
- A `[Image #N]` reference is one unit: the caret hops over it and one `Backspace` removes it with its image.

## Reading replies

### Tool calls, thinking and the Overview

- `Ctrl+T` shows or hides all thinking.
- Tool calls have three display modes, which two keys move between: **collapsed** (every group closed), **groups** (every group open and every call in it one collapsed line such as `> Read src/a.ts`) and **all** (every call expanded).
  - `Ctrl+Shift+O` switches collapsed ↔ groups, and from all it folds the calls back to groups.
  - `Ctrl+O` switches collapsed ↔ all, and from groups it expands everything.
  - A key press also resets the groups and calls you opened or closed by hand; after it you can open or close any group or call again, and a group that arrives later follows the current mode. Every Chat remembers the choices.
- Routine tool calls are grouped in an **Overview**. Set [`ompDesk.toolCallDetail`](settings.md) to **detailed** to show every call as its own row, in every Chat. The setting decides whether calls are grouped; the tool display mode above decides only what is open. In Detailed there are no groups, so the groups mode looks like collapsed there (every call is already one line).
- Pinned rows show the TODO list and running subagents. Open a subagent's live transcript in its own tab.
- Status lines and warnings from OMP extensions appear around the composer; their informational notices are not shown.

![A Chat with tool rows, TODO and Agents](../../media/readme/chat-agents.png)

### Mermaid diagrams

Fenced `mermaid` blocks are drawn as diagrams in your theme's colours once the block is complete (flowcharts, sequence, class, state, ER, gantt, pie and the other mermaid types); until then, and when a diagram has an error, you see the code.

- **Diagram | Source** switches the view, Copy copies the source, and a wide diagram scales to the block and opens at full size on click.
- The diagram renderer is loaded only when a reply has one.
- A block too large for the transcript has **Open diagram in a tab**, which draws it in an editor tab of its own.

### Links to files, code symbols and the web

- File paths in replies and tool rows are links. A click opens the file at that line.
- A bare file name in a reply (`session-index.ts:849`, `session-index.ts(849)`, `index.ts`) is a link too when VS Code's file search finds exactly one file of that name in the session's folders (the file in the session's own folder wins; `files.exclude` and `search.exclude` are honoured; on Windows the case of the name does not matter): a click opens it at the line. A name that several files carry links to a list of those files (dotted underline, tooltip "N files"): a click lets you choose.
- Code symbols in a reply (`Session`, `SessionData.Load()`, `Parse<T>`, `[Tracked]`) are links too when VS Code's language extensions (C# Dev Kit, TypeScript, and others) report exactly one definition of them in the session's folders: a click opens the definition, `Ctrl+Click` shows its file in the Explorer. A symbol with several definitions links to VS Code's symbol search for its name (dotted underline, tooltip "N definitions"): a click lets you choose. A symbol none is found for stays plain code.
- The language extension must have loaded the workspace (a TypeScript server starts when a TypeScript file is open). Symbol searches are ranked and may be capped by the language server, so in a very large workspace a common name may be missed or, rarely, linked to one of several declarations.
- Turn the symbol and bare-file-name links off with [`ompDesk.linkCodeSymbols`](settings.md); [`ompDesk.linkReminder`](settings.md) asks the model to write them as links itself.
- `Ctrl+N` (symbol search) and `Ctrl+Shift+N` (Go to File) are prefilled with the Chat selection; see [Keyboard shortcuts](keyboard-shortcuts.md).
- Web links in replies, tool output and the TODO and Agents tabs open in a VS Code editor tab on click or `Enter`, and in your browser on `Ctrl+Click` or `Ctrl+Enter`.

## Rewind

**Rewind** goes back to one of your prompts in place and puts it into the composer to edit and send again:

- `Esc` `Esc` in an empty composer or anywhere else on the Chat page (while no turn runs), **Rewind to here** on a prompt, `/rewind` or `/branch`, or **OMP Desk: Rewind Conversation…**.
- **Undo** returns to where you were, and a marker where the conversation split switches between your branches.
- Rewind never restores files; it lists the files changed after that point.
- A chat started by an older OMP Desk must be restarted before it can rewind.

## Slash commands

- Terminal-only slash commands such as `/hotkeys` are never sent to the model. Chat opens the VS Code equivalent or says where the command works.
- Slash commands suggest their arguments.
- `/models`, `/agents` and `/settings` open OMP's own editors; see [OMP settings, models and agents](omp-settings.md).

### The Commands list

**Commands** (the terminal-prompt icon in the composer toolbar) lists the slash commands with a search box, so you do not have to type `/`.

- Commands that open a VS Code surface come first and carry a window icon whose tooltip names it: Models, Agents and OMP Settings editors, the Rewind picker, mode pickers for Compact and Shake, a Save dialog for Export, confirmations for Share and Delete, and the Keyboard Shortcuts, Source Control, Skills and Tools, Log In to Provider and Log Out of Provider views.
- Then every other command OMP runs from chat text, with its source (OMP, skill, prompt, extension).
- Picking a VS Code command opens it, a command that takes arguments is put in the message box as `/name ` for you to finish, and one without arguments is sent as a message; what you had typed is never touched.
- A command that cannot run now (no running session, or a turn is running and OMP runs the command only between turns) is greyed out with the reason.
- Terminal-only commands that have no VS Code equivalent are not listed.

### `/clear`, `/new`, `/delete` and `/fresh`

These work in Chat.

- `/clear` clears model conversation history and rotates provider state in place, keeping the session file, title and tab.
- Only confirmed clears collapse earlier messages behind an expandable **Context cleared · N messages dropped** divider; Rewind targets stop at that boundary. A known incomplete Desk clear keeps history visible and says to retry; native/unknown markerless boundaries say **Context reset**, without hiding history. Nothing is retried automatically.
- Observed busy/background work is refused; settled readback cannot prove foreground bash/eval idleness.
- This is not complete terminal `/clear` parity: retained runtime state and fail-closed restart/reattach differences are documented in [ADR-0059](../decisions/0059-clear-chat-in-place-through-a-desk-registered-omp-command.md).
- `/fresh` rotates provider state without removing local history, with durable acceptance before admission reopens.
- `/new` opens a same-folder replacement and stops the old session only if its observed RPC settled predicate still allows it; a failed stop retains the old editor and reports the partial outcome.
- `/delete` confirms deletion before starting a replacement.
- Clear requires the Desk command and supported OMP entry points.

## Model, thinking, context and quotas

- Model and thinking pickers work at any time, also during a turn. A change OMP cannot take yet (compaction, a rewind, a reconnect) waits, shown in the picker with a clock icon, and is sent as soon as OMP is ready, before your next message.
- `Alt+click` the model or thinking chip to cycle it; `Ctrl+Shift+U` cycles thinking.
- The footer shows context usage, provider quotas and the Git branch.
- **Compact…** and **Shake…** in the context popover ask for OMP's mode first (`snapcompact` and `elide` preselected); **Export as HTML** and **Share** are in the editor title menu.
- A status bar item shows the provider limits of the active Chat compactly, for example `5h 42% · 2h13m  │  7d 18% · 3d4h`: the used percent and the time left until each window resets (written like `4d4h42m`: days, hours and minutes, each only when above zero). It turns yellow from 80 % and red from 95 %, its tooltip has the exact reset times, and a click refreshes it. Right-click it to hide it.
- Without available models, the model chip offers **Log In to Provider**; see [Log in to a provider](omp-settings.md#log-in-to-a-provider).
- The **Context** view in the OMP Desk side bar shows what fills the active Chat's context window; see [OMP settings, models and agents](omp-settings.md#views-for-skills-tools-mcp-extensions-and-context).
