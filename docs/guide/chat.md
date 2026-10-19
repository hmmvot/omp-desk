# Chat

Chat is the rich editor view of a session. It opens in an editor tab, shows the conversation as it streams, and follows your light, dark or high-contrast theme. The same tab can be switched to OMP's native [Terminal](terminal.md) at any time. New sessions open in Chat.

![A Chat mid-turn: a drawn diagram and links in the reply, a running turn with a queued follow-up, and a draft with an image and a code block](../../media/readme/chat-features.png)

## Writing and sending

- Streaming replies, saved history, image and document attachments and `@file` mentions.
- **Attachments:** the paperclip button opens a file dialog, and you can paste a file or hold Shift and drag one in, from the operating system or from VS Code's Explorer or an editor tab. An image (PNG, JPEG, GIF or WebP) is up to 5 MiB each and 10 MiB per message. Any other file that is text (UTF-8, no control characters, an empty file too) is a **document**: its whole text goes into your message. There is no limit on how many files you attach; one message carries at most 200 000 characters in all, and the composer says which file would take it over.
- Your draft stays until OMP confirms it. Nothing is resent automatically.
- `↑`/`↓` in an empty composer walk through your earlier prompts. `Ctrl+Alt+Y` searches past prompts of every conversation (it was `Ctrl+R`, which the IntelliJ IDEA keymap uses for Replace).
- A new, empty session lists the main keys in four groups (starting a message, while the agent works, in the conversation, from the editor and anywhere), as you have them: see [An empty session shows the key you really have](keyboard-shortcuts.md#an-empty-session-shows-the-key-you-really-have). **All keyboard shortcuts** under the list, the keyboard button in the composer's toolbar and `Ctrl+/` open the Keyboard Shortcuts editor on the OMP Desk commands.
- Copy buttons on code blocks and on your own messages.
- **Your messages show what you typed.** `_`, `*` and `~~` in a message you send stay as written (`obj._method() ..... obj._otherMethod()` and `1*234*343` are never turned into italic, bold or strikethrough). Code spans and fences, `> ` quotes, lists, tables, links and `[Image #1]` references still render. Replies and thinking keep full Markdown styling.
- **Retry** (`F5` or `Alt+R`) re-runs a failed or aborted reply.
- **A failed request is a frame, not a line.** It shows the provider's HTTP status as a chip when OMP recorded one, the message (cut to three lines when long: **Show all** / **Show less**) and **Copy error**. The last failed reply of an idle session also has **Switch model**, which opens the same model picker as the footer's model button (it is off while that button is), and **Retry**.
- **Under a finished reply:** how long the turn took, `19K tok · $0.02 this turn`, and the time of day. The totals add up every request of the turn, tool-use requests included, as OMP's terminal UI does: prompt tokens are input plus cache writes (cache reads are not counted), the cost is left out when nothing was billed and reads `<$0.01` below half a cent, and a reply with no usage shows no totals. Hover the totals for the exact counts. They cover the whole turn even when its start is scrolled out of the page.
- **A different model answered.** When the provider reports serving another model than the one requested (a router sending `claude-opus-5` to Haiku), the footer of that reply says `served X · requested Y · via provider/upstream`, once for each pair of models. Desk asks the installed OMP whether two ids are really different models, so a dated snapshot of the same model, a gateway prefix or an id OMP cannot classify shows nothing; until OMP answers, or when it cannot be read, nothing is shown either.
- **Thinking time.** A thinking block reads `Thinking… 7s` while it streams and `Thought for 7s` once it is done. Only thinking this window watched stream has a time: saved history, and a block that was already streaming when the chat attached, read plain `Thought`.
- If OMP stops responding, **Reconnect** or **Restart** the conversation.

### Steer and queue while a turn runs

- While a turn runs, `Enter` steers it and `Alt+Enter` queues a follow-up.
- Queued messages can be edited, removed or sent now as steering. `Alt+↑` takes the newest one back into the draft.
- **Stop** (or `Esc`) puts messages that were still queued back into the draft instead of running them.
- OMP's questions and approval requests appear as a card above the composer. `Esc` cancels the open card (a list, a text or multi-line prompt, a confirmation or a question) and answers it as cancelled, the same as its **Cancel** button; while a card is open `Esc` never stops the turn. From the "Other" field of a question one `Esc` also cancels the whole card, as in VS Code's quick pick. `Esc` during an IME composition does nothing to it, and the find bar still takes its own `Esc` first.
- **An option of a question can have a preview**, as in OMP's terminal UI: the Markdown OMP attached to the highlighted option (a mock-up, a code block) shows under the list, for the recommended option (or the first) until the pointer or the keyboard moves to another one. When OMP gave the question a time limit, the card says `Answers itself in 1 min 30 s` and counts down; at zero OMP answers the recommended option of every question and the card closes. The countdown starts when the question arrives, and a question restored after a reconnect counts from the reconnect.

### Code blocks in the draft

Type a line of three backticks, with a language if you like (`` ```ts ``), and press `Enter`: the composer adds the closing fence and puts the caret between the two. From the opening fence to the closing fence (or to the end of the draft while there is none) the composer works like a small editor:

- `Enter` is a new line that keeps the line's indentation and does not send.
- `Tab` indents (four spaces; on several selected lines it indents them all) and does not move the focus. `Shift+Tab` outdents.
- **`Ctrl+Enter` sends from inside a block** (a follow-up while a turn runs: `Ctrl+Alt+Enter`). `Enter` and `Tab` behave as before outside a block.
- Only the block is set in your editor's font, on a band that marks its rows; the prose around it keeps the proportional font. The text is the same: plain Markdown, fences included, and nothing completes inside a block: no `/` commands, no `@` files.
- A line under the composer lists these keys while the caret is in a block.
- **Keyboard way out:** `Shift+Tab` on a line with nothing left to outdent moves the focus to the previous control; `Ctrl+Shift+L` brings it back.

### Quoting Chat text

Select text in an assistant reply, one of your own messages or an open thinking block and quote it into the draft; write your comment right under it and send one message with several quotes.

- **How:** select the text, then press `Alt+Q` or right-click the selection and choose **Quote Selection** (also **OMP Desk: Quote Selection** in the Command Palette). There are no Quote buttons. A selection has to be started with the mouse; once it exists, `Shift+Arrow` extends it.
- **What lands in the draft:** the Markdown source of exactly what you selected, as `> ` lines at the end of the draft, after a blank line. A link, a code span, emphasis, a list marker or a code fence comes along when the selection covers it; a partly selected code block is wrapped in a fence again, with its language. Tool output and notices are never quoted. The caret is on the line directly under the quote. A selection inside your own message is quoted character for character, since its `_`, `*` and `~~` are shown as typed.
- **Tables:** a selection inside one cell quotes just that text, like a paragraph (a bold run you selected whole stays `**bold**`; a part of it is plain text), with no header and no `|`. A selection across several cells or rows quotes a table: the header, the separator and the rows you touched, only in the columns between the first and the last cell you selected, with those two cells cut to your selection. A selection that starts before the table or ends after it quotes the rows it reaches whole, with every column.
- **Edit a quote like any text:** a quote is plain `> ` lines shown on a band with a bar, and its keys are the code block's. `Enter` is a new line that carries the `> ` (`Shift+Enter` and `Alt+Enter` do the same), and `Enter` again on the empty quote line lets go of it. `Shift+Tab` leaves the quote at once: it adds a plain line under the current one and puts the caret there (a nested `> > ` quote leaves one level per press). `Ctrl+Enter` sends from inside a quote (a follow-up while a turn runs: `Ctrl+Alt+Enter`). `Backspace` at the start of a line removes one level. Text with several lines that you paste or drop on a quote line stays in the quote. The **✕** beside a quote removes the whole quote in one undo step and keeps the comment under it, and `Ctrl+Z` brings it back. A line under the composer lists these keys while the caret is in a quote.
- **Limits:** a quote takes at most 20 000 characters of Markdown, and the draft at most what OMP Desk can send; the line under the composer says why a quote was refused. If part of a selection cannot be mapped back to its source, that part is quoted as the text you saw and the line says "as plain text".
- **What the model sees:** the `> ` lines and your comment, as typed. Your sent message shows the quote and the comment under it.
- **From a text editor:** select text in any text editor and press `Alt+Q`, or right-click the selection and choose **Quote Selection to Session** (also in the Command Palette). Pick the Chat session in the list, as for [Add File to Session](send-code.md); only Chat sessions are offered, and **New session** starts a Chat. The quote lands in that session's draft the way a Chat quote does, with the caret under it, and is never sent. Its first line is the file and the lines as inline code (`src/app.ts:42-50`, relative to the session's folder when the file is inside it, else the full path; it does not start with `@`, so OMP does not read it as a mention and attach the whole file), then the text: a code file in a fenced block with its language, a Markdown or plain-text file as plain quote lines. Each selection of a multi-cursor selection is its own quote. An untitled document is quoted without a location. The limits are a Chat quote's: 20 000 characters in all, refused with the size; the file's location is the saved file's even when the editor has unsaved changes.
- **With nothing selected,** `Alt+Q` (or **Quote Selection to Session** from the editor menu) puts a reference to the caret's line into the draft instead of refusing: `` `src/app.ts:42` `` as inline code, at the caret of the draft, with the same session choice, the same path rule and no quote text. Several carets reference the main one. In a diff, a side that is a Git version adds its version (`` `src/app.ts:42 @ HEAD (3f2a9c1)` ``). A document with no file behind it (untitled, output) is refused with a short reason, since a reference without a place is no use. A reference sent while a draft is being carried to a replacement editor can be lost with the old editor.
- **From a diff:** `Alt+Q` and **Quote Selection to Session** work in both sides of a diff editor (the Source Control diff of a changed or staged file, a commit's changes in the multi-file diff editor, **Compare Selected**, and a diff shown inline), and the location is the file and the lines **of the side you selected in**. The side that is the file on disk reads as in any file (`src/app.ts:42-50`). A side that is a Git version says which one after ` @ ` (`src/app.ts:3-4 @ HEAD (3f2a9c1)`, `src/app.ts:3-4 @ index` for the staged version, `src/app.ts:3-4 @ 3f2a9c1` in a commit's changes, `main (3f2a9c1)` for a branch), so the model can read those same lines with `git show` and knows they are not the file on disk. The ` @ ` has a space on both sides, so it is never an `@` mention. The location of a Git version is plain code in the sent message, never a link, because a link would open the file on disk at other lines. The left side of a Source Control diff is the index when the file is staged and `HEAD` otherwise, as VS Code's Git extension reads it. A document that has no file behind it (untitled, output, a scheme other than file and Git) and a submodule's entry in Source Control (its text is a diff of the submodule) are still quoted without a location. In a diff shown inline (VS Code switches to it by itself in a narrow editor), the lines that were deleted are drawn by VS Code, not as editor text: the key and the menu cannot take them, so quote the left side from the side-by-side view (**Toggle Inline View**).
- **No list when a Chat is in view:** if a Chat session of this window is visible (its tab is in front in any editor group, for example a Chat in the left group and the file in the right one), `Alt+Q` quotes straight into that Chat's composer and moves the focus there; nothing is asked. With several visible Chats the one you focused last is used. A Chat hidden behind another tab, a Terminal session and a stopped Chat do not count; when none is visible, the list above appears. [Add File to Session](send-code.md) always asks.
- **A whole change of a diff:** in a diff editor, with **nothing selected** and the caret on a changed line, `Alt+Q` (or **Quote Selection to Session** from the editor menu) quotes the whole change the line belongs to, in the inline view and in both sides of the side-by-side view and of a commit's changes. The quote is a `diff` block: the removed lines after `-`, the added lines after `+` and up to three unchanged lines each side after a space. Its first line names both sides, the modified side first and then the original side: `` `src/app.ts:1-7 was src/app.ts:1-5 @ HEAD (3f2a9c1)` `` (`@ index` for the staged side, `@ 3f2a9c1` in a commit's changes). It is plain code, not a link, because it holds lines of two versions. A side the change has no line on (a change that only removes lines has none on the modified side) is left out of that line. OMP Desk finds the change by comparing the two texts line by line, because VS Code does not give extensions the changes its diff editor draws: it can group lines differently from the editor (it also counts a change of only whitespace at the end of a line, which the editor ignores by default), and a pair of files too large or too different for the comparison falls back to the caret's line reference. A caret on an unchanged line, or on the modified side where lines were only removed, keeps the line reference; in the inline view the removed lines cannot hold the caret, so quote such a change from the original side of the side-by-side view. A selection quotes the selection, as before.

### Editing the draft

- `Ctrl+Z` undoes and `Ctrl+Y` or `Ctrl+Shift+Z` redoes, including a pasted image and its reference. VS Code's **Edit > Undo** menu item does not act on the composer: use the keys.
- A paste inserts plain text only, whatever the page it came from. Text you drag onto the composer lands where you drop it.
- A `[Image #N]` or `[File #N: name]` reference is one unit: the caret hops over it and one `Backspace` removes it with its attachment.
- A command or a skill that the draft names (`/compact `, `/skill:review `) is the same kind of unit; see [Commands and skills are blocks](#commands-and-skills-are-blocks).

### Attaching documents

- **Each file is a chip in the draft and a tile under it** (an icon chosen by the file's extension, `#N`, its name and size, a **✕**). The tile shows no file text. `Ctrl+Z` brings a removed file back. Attaching the same file twice gives two chips. A file that is not text (a PDF, a binary, an image format OMP cannot take) is refused by name and attaches nothing.
- **What is sent.** Your text first, then each file's whole text in a block after it (`<file path="docs/notes.md" n="1" chars="…">`; a file with no path, pasted or restored, has a `name` instead). A file that came by path, from the dialog or a drag from VS Code, is read from disk when you press Send, so the model sees the file as it is then; if it was deleted, turned into a binary, or no longer fits the message, nothing is sent and your draft stays. If an open editor holds unsaved changes to it, a line tells you the saved text was sent. A pasted file is sent as it was when you pasted it. This works the same for a message, a steer and a queued follow-up.
- **The model reads the text, not instructions in it.** OMP acts on `@path` mentions, `^model`, `+N` turn budgets and `/skill:name` tokens in a message. In an attached file's text, Desk puts an invisible zero-width space (U+200B) before each of them as it sends, so a file that happens to contain `@src/a.ts` or `/skill:x` is never read as an instruction; the model receives the file's own text. The text you type yourself is not changed, and the invisible characters are removed when Desk shows the file, copies it or puts it back in your draft. A file that already contains U+200B is restored exactly.
- **In the conversation** each file is one closed row under your message (name, line count and size); open it to read the highlighted text, and **Copy** takes the file's own text. The rows are drawn again from the saved history after a reload.
- **Getting them back.** Rewind, **Edit** on a queued message, `↑`/`↓` through earlier prompts and a draft carried to a replacement editor put the files back as chips with the text that was sent. `Ctrl+Alt+Y` remembers a message with each file reduced to its path and no text, and a recalled message attaches those files again from disk; one with no path, or one that has since been deleted, is named in a line and has to be attached again.
- **Dragging a file in: hold Shift.** VS Code, not OMP Desk, decides who receives a file dragged over a Chat. Without Shift, VS Code takes the drag as soon as the pointer has crossed another part of its window (the tab bar, the side bar, the title bar), shows its own drop overlay and opens the file in an editor, and the Chat never sees it; it reaches the Chat only when the drag happens to enter straight over the Chat, which is why an unshifted drop works sometimes and not other times. With **Shift** held over the Chat (press it before you let go; it applies to drags from the file manager and from VS Code's Explorer alike) the drop always reaches the Chat. The Attach button and a paste never depend on this. If VS Code has opened a file instead, drop it again with Shift held, or use the Attach button.
- **If VS Code opened the file, or the Chat ignores your drag.** A drop VS Code took leaves the Chat refusing plain drags until the mouse moves over the VS Code window again (measured: a mouse move, a click in the Chat or on its tab, or a Shift drag over the Chat lifts it at once; **Esc**, hiding and showing the Chat tab with the keyboard, and a simulated focus change do not). So: close the file VS Code opened, move the mouse over the Chat, and drag again with **Shift** held, or use the Attach button, which never depends on any of this.
- **A file that is too large** (a log of several megabytes, for example) is refused by name with its size and the 200 000-character limit; the composer stays ready, and the next drop or attach works as usual.
- **Fallback route.** When the page talks to the extension over the fallback connection (a rare, slow route), the file dialog and drops from VS Code are not offered, and a message too large for that connection is refused with a sentence instead of being sent.

## Reading replies

### Tool calls, thinking and the Overview

- `Ctrl+Alt+T` shows or hides all thinking (it was `Ctrl+T`, which the IntelliJ IDEA keymap uses for Git Sync).
- Tool calls have three display modes, which two keys move between: **collapsed** (every group closed), **groups** (every group open and every call in it one collapsed line such as `> Read src/a.ts`) and **all** (every call expanded).
  - `Ctrl+Shift+O` switches collapsed ↔ groups, and from all it folds the calls back to groups.
  - `Ctrl+O` switches collapsed ↔ all, and from groups it expands everything.
  - A key press also resets the groups and calls you opened or closed by hand; after it you can open or close any group or call again, and a group that arrives later follows the current mode. Every Chat remembers the choices.
- Routine tool calls are grouped in an **Overview**. Set [`ompDesk.toolCallDetail`](settings.md) to **detailed** to show every call as its own row, in every Chat. The setting decides whether calls are grouped; the tool display mode above decides only what is open. In Detailed there are no groups, so the groups mode looks like collapsed there (every call is already one line).
- Pinned rows show the TODO list and running subagents. Open a subagent's live transcript in its own tab.
  - **A finished TODO list leaves the pinned row, as in OMP's terminal UI.** When every task is completed or abandoned, the row disappears after OMP's `tasks.todoClearDelay` seconds (60 by default; a negative value keeps it for good; Desk reads the setting of the session's profile and folder, and uses 60 when it cannot read it). A change to the list brings the row back and restarts the count. A list the terminal UI already dismissed stays hidden, and one it revealed stays shown. When you open a session whose list has been finished for longer than the delay (counted from the last change to the list in the transcript), the row is not shown. The TODO tab and the TODO tool cards keep the whole list, and Desk never writes to the session file for this. Unlike the terminal UI, Desk has no key to bring the row back before the list changes.
- **Some tools have a card of their own, as in OMP's terminal UI.**
  - **MCP tools** are titled `server/tool` with the first arguments on the row (`url="https://example.com/p…", width=320`, each value cut at 24 characters, 160 in all); the open card has the full arguments as a tree, and a JSON result is a folding tree like any other JSON output. Truncation and the full-output link stay in the footer line. A tool is an MCP tool when OMP minted it as `mcp__<server>_<tool>`; before the result arrives, the name is split at its first underscore, so a server whose name contains one may show a different split until then.
  - **Submit Result** (`yield`, which you see in a subagent's transcript) shows what the subagent submitted: the section or workpool item it fills (`findings`, `item 3`), the size (`13 fields`, `4 items`), a report as text and anything else as a tree. A submission OMP rejected shows its message in full, an abort says `aborted`, and one accepted although it failed the output schema says `schema overridden` on the row.
  - **Autoresearch** (`init_experiment`, `run_experiment`, `log_experiment`, `update_notes`): a logged experiment says `keep`, `discard`, `crash` or `checks_failed` on its row with the metric against the baseline, the confidence and the number of scope deviations (listed in the open card); a run is PASS, FAIL or TIMEOUT with its duration and metric, or `Running 1m 05s…` with the output so far, and the tail of the benchmark's output.
- Status lines and warnings from OMP extensions appear around the composer; their informational notices are not shown.
- **An extension's failure is a line in the conversation**, as in OMP's terminal UI: `Extension "<path>" error (<event>): <text>`, headed `Extension error`. The text is shown exactly as the extension wrote it (never as formatting or markup), is cut at 1,000 characters, and an extension that fails on every event says it once in a row. Desk's own `/rewind` and `/clear` report their refusals in their own sentences, not in this line.
- **A frame OMP could not send is a warning in the conversation.** OMP drops an event larger than its connection allows and says so; Chat then shows `OMP dropped a "<type>" event` (headed `Frame dropped`) and writes a line to the OMP Desk log. When the lost event would leave the conversation behind (a reply's end, a tool's end, a turn's boundary), Chat reads the session file again to catch up, and a reply whose end was lost stands as it was last streamed until that read confirms it.

![A Chat with tool rows, TODO and Agents](../../media/readme/chat-agents.png)

### Finding text in the conversation

`Ctrl+F` (`Cmd+F` on macOS) anywhere in a Chat (the composer included, which has no find of its own) opens a find bar in the corner of the transcript. **OMP Desk: Find in Chat** (the Command Palette and the editor's `…` menu) opens the same bar. The key works on any keyboard layout, is listed in **Show Chat Keyboard Shortcuts**, and can be rebound or removed in the Keyboard Shortcuts editor like any other.

- **It searches the conversation, not just the rows in the page.** A long conversation keeps only the rows on screen in the page, which is all VS Code's own find could see, so the bar reads the loaded conversation itself: your messages, the replies and their thinking, and each tool call's name, target, intent and output text. It does not search notices and summaries, the text of attached files, the history before a context reset (`/clear`), or messages still on disk behind **load earlier messages**; the bar says how many of those there are.
- **It starts at the newest match.** `Enter` or `F3` goes to the next match and `Shift+Enter` or `Shift+F3` to the previous one, both wrapping round; the bar shows `3 of 12` (or `No results`). `Alt+C` turns **Match Case** on and off. The query is literal text, not a pattern. Text you had selected in the Chat fills the field.
- **The match is shown.** The row is loaded into the transcript if it was above the rows the Chat keeps, scrolled to (deep inside a long reply, to the line), and what hides it is opened: a tool group, the call's output or a thinking block. They stay open when you move on, and the current match's block opens again if its row comes back after you scrolled away, unless you closed it yourself after the jump (the next jump opens it again). Every match in the rows on screen is highlighted and the current one stands out. In a long tool output only the rows the card shows are highlighted (the match's row is outlined); use **Show all** and the output's own **Filter lines** to look further.
- **It searches when you pause.** The search runs about a moment after you stop typing (`Enter` searches at once), so a long conversation does not slow each keystroke. The reply that is still being written is not searched until it is complete.
- **`Esc` closes the bar** and puts the focus back where it was, the composer if that is gone. It works from the field and from every button of the bar, and `Esc` there never stops a running turn.
- With screen-reader paging on, the page that holds the match is shown. `Ctrl+F` is a VS Code keybinding for the Chat editor, and the page also takes it itself, so it works in a view-only Chat and while the extension restarts. Pressing it while the field has the focus changes nothing, so it never reselects what you are typing; from anywhere else it returns to the field and selects its text.

### Mermaid diagrams

Fenced `mermaid` blocks are drawn as diagrams in your theme's colours once the block is complete (flowcharts, sequence, class, state, ER, gantt, pie and the other mermaid types); until then, and when a diagram has an error, you see the code.

- **Diagram | Source** switches the view, Copy copies the source, and a wide diagram scales to the block and opens at full size on click.
- The diagram renderer is loaded only when a reply has one.
- A block too large for the transcript has **Open diagram in a tab**, which draws it in an editor tab of its own.

### SVG figures

A fenced `svg` block in a reply is drawn as an image once the block is complete, as OMP's terminal UI draws it; until then, and when the SVG cannot be drawn, you see the code, with a muted line saying why.

- **Figure | Source** switches the view and Copy copies the source. The figure uses your theme's colours: the `var(--fg)`, `var(--muted)`, `var(--accent)`, `var(--c1)` … `var(--c6)` tokens OMP asks models to draw with are replaced by your theme's text, accent and chart colours.
- The SVG is never run: scripts, links, animation, embedded HTML and anything that would load a file or a web address are removed (the figure says so), and the image is shown as a picture, which cannot do any of that itself. A figure needs a `viewBox` (or a width and height) to have a size.
- Only the assistant's reply text draws figures, and only a fence on its own, not one inside a list item or a quote; the same block in your own message, in a tool's output or in thinking stays code.

### Charts under tables

A table of numbers in a reply gets a chart under it (bars, grouped bars, or a line when the rows run in order, such as dates or `Run 1`, `Run 2`…), in your theme's colours, when OMP's terminal UI would draw one: at least four rows, values that are not all alike, and enough of them to be worth a picture. Tables of words, ids, dates and versions, tables of a few rows and tables inside a list or a quote get none. The table itself is unchanged and the chart is not part of what Find searches.

- The last table of a reply is charted once it has stopped growing (about half a second after its last row).
- **Hide chart** (beside the chart's title) hides every chart in the Chat until you reload it, leaving a **Show chart** line under each charted table; **Show chart** on any of them brings all the charts back. OMP's own off switch for the terminal, `tui.autoGraph`, is not read here.
- Desk draws the common kinds (bar, grouped bar of two or three measures, line); the terminal's other chart kinds, a heatmap of four or more same-unit columns among them, are not drawn.

### Math

LaTeX in a reply is shown as readable text, as in OMP's terminal UI: `$x^2 + \alpha$`, `\(a_1\)` and `$$…$$` become `x² + α`, `a₁` and the formula; a `$$` or `\[` on a line of its own with its closing line (or a bare `\begin{align}…\end{align}`) is a block with stacked fractions, matrices and aligned rows. Hover a formula to see its TeX.

- Dollar amounts are left alone: `$5 and $10`, `$5-$10` and `costs $5` are text. A formula you want shown as TeX goes in backticks.
- Text you type yourself is never converted. Find searches and Quote copies the text as shown (quoting a whole inline formula quotes its TeX).
- A command Desk does not know shows as `\name`. A formula that `\(`…`\)` spreads over several lines is shown as written.

### Links to files, code symbols and the web

- File paths in replies and tool rows are links. A click opens the file at that line.
- A bare file name in a reply (`session-index.ts:849`, `session-index.ts(849)`, `index.ts`) is a link too when VS Code's file search finds exactly one file of that name in the session's folders (the file in the session's own folder wins; `files.exclude` and `search.exclude` are honoured; on Windows the case of the name does not matter): a click opens it at the line. A name that several files carry links to a list of those files (dotted underline, tooltip "N files"): a click lets you choose.
- Code symbols in a reply (`Session`, `SessionData.Load()`, `Parse<T>`, `[Tracked]`) are links too when VS Code's language extensions (C# Dev Kit, TypeScript, and others) report exactly one definition of them in the session's folders: a click opens the definition, `Ctrl+Click` shows its file in the Explorer. Namespaces written before the type are ignored when the language extension does not report them (`OmpDesk.Core.SessionData.Load`), and a member the type inherits from a base class links to the base class's declaration when the language extension offers a type hierarchy (C# does). A symbol with several definitions links to VS Code's symbol search for its name (dotted underline, tooltip "N definitions"): a click lets you choose. A symbol none is found for stays plain code.
- The language extension must have loaded the workspace (a TypeScript server starts when a TypeScript file is open). Symbol searches are ranked and may be capped by the language server, so in a very large workspace a common name may be missed or, rarely, linked to one of several declarations.
- Turn the symbol and bare-file-name links off with [`ompDesk.linkCodeSymbols`](settings.md); [`ompDesk.linkReminder`](settings.md) asks the model to write them as links itself.
- `Ctrl+N` (symbol search) and `Ctrl+Shift+N` (Go to File) are prefilled with the Chat selection; see [Keyboard shortcuts](keyboard-shortcuts.md). A selected qualified name such as `SessionData.Load` is looked up the way a link is: one definition opens at once, several are listed to choose from, and when none is found the symbol search opens for the name after the last dot.
- Web links in replies, tool output and the TODO and Agents tabs open in a VS Code editor tab on click or `Enter`, and in your browser on `Ctrl+Click` or `Ctrl+Enter`.
- **OMP's internal addresses** in a reply are links when this session has what they name: `agent://<id>` (a nested agent is `Parent.Child`) opens the agent's read-only transcript tab while the live session knows it, and otherwise its published output `<id>.md` as a read-only document; `history://<id>` opens the transcript tab; `artifact://<n>` opens a tool result's full output; `local://<path>` opens a file of the session's scratch space. `Ctrl+Shift+Click` shows the file behind a link in File Explorer. An address this session does not have stays plain text. `skill://`, `memory://`, `rule://`, `omp://`, `pr://` and `issue://` are never links, because only OMP can resolve them.
- **The current commit's hash** in a reply is a link: an inline code span such as `` `c7398070` `` (7 to 40 hex digits), or a hash with both digits and letters in the text, when it is the commit HEAD points at in the repository of the session's folder. Click it (or `Enter`) and VS Code's own Source Control opens its **Graph** view with that commit selected; nothing else opens. VS Code's Graph can select only the current commit, so the hash of any other commit, a hash that matches no commit and an abbreviation that several commits share stay plain text. When you commit, switch branch or amend, the links update (usually within a few seconds, as soon as VS Code's Git extension notices): the old current commit turns back into text and its successor becomes a link. If you click a link whose commit has just stopped being current, nothing opens and a short notice says so. If the Graph's **filter** (the button beside the Graph's title, `Auto` by default) is limited to branches that do not include the current one, the Graph cannot select the commit: the click shows the Graph and a notice, `the Source Control Graph's filter hides the current branch (main). In the Graph, choose "Auto" or include main in its filter.` (OMP Desk reads the filter from VS Code's workspace storage; when it cannot, the click selects as before and the OMP Desk log line says why). No extension such as GitLens is involved. Only the assistant's replies are linked.

## Rewind

**Rewind** goes back to one of your prompts in place and puts it into the composer to edit and send again:

- `Esc` `Esc` in an empty composer or anywhere else on the Chat page (while no turn runs), **Rewind to here** on a prompt, `/rewind` or `/branch`, **OMP Desk: Rewind Conversation…**, or **Branch…** in a running session's context menu in Sessions.
- **Undo** returns to where you were, and a marker where the conversation split switches between your branches.
- Rewind never restores files; it lists the files changed after that point.
- A chat started by an older OMP Desk must be restarted before it can rewind.

## Slash commands

- Terminal-only slash commands such as `/hotkeys` are never sent to the model. Chat opens the VS Code equivalent or says where the command works.
- Slash commands suggest their arguments.
- `/models`, `/agents` and `/settings` open OMP's own editors; see [OMP settings, models and agents](omp-settings.md).

### Commands and skills are blocks

A command or a skill that the draft names is drawn as one block, like an attached image or file: a terminal-prompt icon for a command and a book for a skill, in the same tinted chip. The text is still `/name args`; the block is only how it is drawn, and what is sent does not change.

- **When it appears.** When the name is complete and a space or a line break follows it: after you pick a suggestion, or after you type `/compact` and a space (a name at the very end of the draft is still being typed, so `/model` does not become a block while you are typing `/models`). It also appears when the draft comes from the history (`↑`, `Ctrl+Alt+Y`), a restore after a reload, Undo or a paste.
- **What is a block.** A command of the session (the Commands list shows them) or a skill, at the start of the draft. A `/skill:name` anywhere in the draft is one too, because OMP runs it from the middle of a message; only the first such token counts, and not in a message that starts with another command, `!` or `$ `. An unknown `/foo`, a path such as `/usr/bin/x`, a name in the wrong case and a command Chat refuses stay plain text.
- **Delete it in one key.** `Backspace` right after the block, `Delete` right before it, `Ctrl+Backspace`, or a selection that touches it removes the whole block (with the one space after it) as one undo step. The caret cannot go inside it and `←`/`→` hop over it.
- **While a turn runs** a message you send is steered (`Enter`) or queued (`Alt+Enter`), and a command or a skill in it works as OMP's terminal UI works: Chat sends it as a prompt that OMP queues in the same way, so OMP decides what it does mid-turn (`/compact` interrupts the turn, compacts and resumes it; an extension command runs at once; a skill's instructions reach the model and the conversation shows a skill row). Every command and skill is a block then, as between turns. Chat's own commands (`/rewind`, `/clear`, `/new`, `/delete`, `/fork`, …) keep their own rules while a turn runs, and a terminal-only command is still answered by Chat.

### The Commands list

**Commands** (the terminal-prompt icon in the composer toolbar) lists the slash commands with a search box, so you do not have to type `/`.

- Commands that open a VS Code surface come first and carry a window icon whose tooltip names it: Models, Agents and OMP Settings editors, the Rewind picker, mode pickers for Compact and Shake, a Save dialog for Export, confirmations for Share and Delete, and the Keyboard Shortcuts, Source Control, Skills and Tools, Log In to Provider and Log Out of Provider views.
- Then every other command OMP runs from chat text, with its source (OMP, skill, prompt, extension).
- Picking a VS Code command opens it, a command that takes arguments is put in the message box as `/name ` for you to finish, and one without arguments is sent as a message; what you had typed is never touched.
- A command that cannot run now (no running session, a message still waiting for OMP's confirmation, or one of Chat's own commands that needs the turn to be over) is greyed out with the reason.
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

### `/review`

`/review` is OMP's own code review, and it works in Chat as in the terminal: OMP asks what to review in a dialog in place of the message box, then sends the review request (the mode, the changed files and the diff) to the model as your message.

- Type `/review` or pick it in the Commands list. **Review Mode** offers **uncommitted changes**, a **branch diff** (then the base branch to compare against), a **specific commit** (then one of the latest commits), a **specific pull request** (the open pull requests, a search row, or `#123`) and **custom review instructions** (a multi-line box, prefilled with `Review the following:`; `Enter` submits, `Shift+Enter` adds a line). **Cancel**, or `Esc`, in any of these dialogs ends the command and sends nothing, and the message box is idle again at once.
- `/review <PR link>` reviews that pull request without asking. `/review <text>` keeps the text as the focus of the review, and the custom-instructions choice is not offered.
- Pull requests need the GitHub CLI (`gh`), signed in (`gh auth login`). Without it OMP's message (`GitHub CLI (gh) is not installed…`) appears as an error message of the window and nothing is sent; so does a pull request that cannot be fetched (it does not exist, or you cannot read it).
- The pull-request list is the open pull requests of the repository the session's folder belongs to (its Git remote), up to 100 rows, with the **Search open pull requests…** row last: scroll to it, then type words to search or `#123` to review that pull request, open or not. Picking a row, or `/review <PR link>`, shows the review request in the transcript like any other mode.
- A dialog may stay open as long as you like: the `/review` message is not reported as unconfirmed while OMP waits for your answer.
- A `review` command of your own in OMP's commands folder replaces OMP's; its dialogs and prompts are then its own.

### `/fork`

`/fork` opens a copy of this session in a **new Chat tab** beside it, and this session carries on untouched:

- The copy is a separate session with its own OMP process and its own row in Sessions. It starts with the whole conversation so far; both sessions can be continued, and neither sees what the other does next. OMP itself writes the copy and records the original as its parent, as OMP's own `/fork` does in a terminal.
- It works while the session is idle. While a response is running, or a message is queued or being saved, it says OMP's own sentence (`Wait for the current response to finish or abort it before forking.`) or why it waits, and starts nothing.
- `/fork` takes no arguments here: `pane`, `window` and `tab` are the terminal UI's placements, and typing one shows a one-line reason. **Fork Session** in the session's context menu, in the Chat tab's `…` menu and in the Command Palette does the same.
- A stopped session cannot be forked (Resume it first), and a session shown in Terminal is forked from the Terminal with OMP's own `/fork`.

### `/btw`

`/btw <question>` asks a **side question** about the conversation without touching it, as OMP's terminal UI does. The question and its answer never become part of the session: they are not rows of the transcript, are not in the session file and do not count toward the context or the cost line. The answer streams as Markdown into a panel directly above the message box.

- **It works while a response is running**, and does not wait for it or stop it. The side answer can see what the assistant has said so far in the running turn. Stop does not cancel a side question and a side question does not block the response.
- **One at a time.** A second `/btw` while one is answering says so and keeps your text in the message box.
- **Cancel** with the stop button in the panel, or `Esc` while the focus is inside the panel (`Esc` there never also stops the response; `Esc` in the message box still does). `Esc` in the panel closes it when nothing is running. **Copy** takes the last non-blank answer, **Close** hides the panel.
- **Follow up** in the row under a finished answer: `Enter` continues the same side conversation, `Shift+Enter` adds a line.
- **`/btw` with no text** opens the list of the session's side questions, newest first, with their state and when they were asked; pick one to read it. The list is OMP's own (the same one the terminal UI shows), so it survives closing the page, a second editor on the same session and a restart of the extension host. A question that was still answering when its process ended reads as *Interrupted*.
- **Only text.** A `/btw` with an image attached is refused with a sentence and keeps the draft. A refusal (a question already answering, no active model, history that cannot be saved, an OMP without this feature) says why under the message box and keeps what you typed.
- Rewind, `/new` and Resume end a running side question, as in OMP; `/fork` opens a copy and leaves this session's side question running.
- Not here: the terminal UI's *branch* key, which turns a side answer into a branch of the session; use `/fork` or Rewind instead.

### Branch and Clear from the Sessions view

A running session's context menu in Sessions also has **Branch…** and **Clear Context…**, and the Chat tab's `…` menu has **Clear Context…**:

- **Branch…** shows the session in Chat (opening a closed tab) and opens the Rewind picker, exactly as typing `/branch` does.
- **Clear Context…** asks first in a dialog; **Clear Context** then runs the same `/clear` as typing it, with the same refusals and the same short wait for OMP to be ready. Cancel changes nothing. Typed `/clear` still asks nothing.

## Model, thinking, context and quotas

- Model and thinking pickers work at any time, also during a turn. A change OMP cannot take yet (compaction, a rewind, a reconnect) waits, shown in the picker with a clock icon, and is sent as soon as OMP is ready, before your next message.
- `Alt+click` the model or thinking chip to cycle it; `Ctrl+Shift+U` cycles thinking.
- The footer shows context usage, provider quotas and the Git branch.
- **Goal, fast mode, slow mode and the usage limit** are small chips beside the model and thinking pickers, as in OMP's status line, and each shows only while it holds: `Goal 12.3k/50k` (the tokens the goal has used against its budget; no budget, no `/50k`; the tooltip has the objective, its status and the time it has run, and a paused or budget-limited goal is marked with a warning colour; a dropped goal, or goal mode off, shows nothing), `Fast` (fast mode is on for the model in use), `Slow` (slow mode is on; the tooltip says whether it is OMP's setting for every session or this session's) and, in a warning colour, the usage-limit stage of your account in OMP's words (`limit reached · wrapping up · resets 14:30`, `limit reached · wrap-up, then extra usage`, `low priority until 14:30 · 40% left`; for the low-priority stage this chip stands in for `Slow`). They come from OMP's own state, read when the chat attaches and again after each turn and command, and the goal is also updated the moment OMP announces a change; a fast or slow mode switched by a command shows from the next reading. The tokens-per-second figure of OMP's status line is not shown: OMP reports a single sample, not a stream, and each reply already shows its own rate.
- **Compact…** and **Shake…** in the context popover ask for OMP's mode first (`snapcompact` and `elide` preselected); **Export as HTML** and **Share** are in the editor title menu.
- A status bar item shows the provider limits of the active Chat compactly, for example `5h 42% · 2h13m  │  7d 18% · 3d4h`: the used percent and the time left until each window resets (written like `4d4h42m`: days, hours and minutes, each only when above zero). It turns yellow from 80 % and red from 95 %, its tooltip has the exact reset times, and a click refreshes it. Right-click it to hide it.
- Without available models, the model chip offers **Log In to Provider**; see [Log in to a provider](omp-settings.md#log-in-to-a-provider).
- The **Context** view in the OMP Desk side bar shows what fills the active Chat's context window; see [OMP settings, models and agents](omp-settings.md#views-for-skills-tools-mcp-extensions-and-context).
