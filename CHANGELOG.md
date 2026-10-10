# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - 2026-10-11

### Added

- Folder paths in Chat are links too. A click opens a file in a tab; **Ctrl+Click** selects the file or folder in the Explorer without opening it, and **Ctrl+Shift+Click** opens its folder in File Explorer with it selected. A plain click on a folder selects it in the Explorer. The Explorer can show only paths inside a folder open in the window. The same three actions are in the link's right-click menu, and a web link's right-click menu offers **Open in Editor** and **Open in Browser**.
- In Chat sessions the model is asked to write the files and folders it mentions as paths in inline code (`src/app.ts:42`, `docs/`), so they become links, and to link every code symbol it names, at each mention and in tables and lists, to the definition line it has seen (`` [`World.Current`](src/World.cs:42) ``) or to the file alone, so a click opens the definition.
- **Code symbols in Chat replies are links when VS Code can tell where they are defined.** An inline code span such as `Ability`, `AbilityData.Cast()`, `UnitUseAbilityAbstract<T>` or `[AllowedOn]` in an assistant reply becomes a link, with the same underlined look, click and `Ctrl+Click` as a file path, when VS Code's language extensions (C# Dev Kit, TypeScript and others) report exactly one definition of it inside the session's folders; a click opens the file at the definition. A partial class or an overloaded method links to one of its declarations (the type's own file, else the first); a symbol with several different definitions (same-named types in different namespaces) is a link with a dotted underline and the tooltip "N definitions — click to choose" that opens VS Code's workspace symbol search for its name, never a guessed definition; unknown symbols and code blocks stay plain. Each lookup is logged in the OMP Desk output (counts and verdict). Symbols in bold, italic and strike-through text count too. While a language server is still loading its projects, or when its queue is full, symbols stay plain code and are linked as soon as it answers, without reloading the window. It is asynchronous, bounded and cached, and never delays a streaming reply. Language servers rank and may cap workspace symbol results, and a server that has not loaded the workspace yet answers nothing, so a symbol can be missed. Turn it off with `omp.linkCodeSymbols`.
- **An optional per-message reminder keeps the model linking files and code symbols.** With `omp.linkReminder` on, a short reminder follows each prompt you send, on its way to the model only (a separate message that is never saved to the session or shown in Chat; your prompt is not changed and the prompt cache keeps working): write the files and folders you mention as paths in inline code and every class, method, property, field and type as a link with its definition line. In a test fixture the share of symbols left as plain code dropped from about 50% to about 30%. It adds about 120 tokens per prompt. It is off by default; turn it on with `omp.linkReminder`; it applies to sessions started or resumed afterwards.
- **Compact…** in the context popover asks for OMP's compaction mode, with `snapcompact` (no model call) preselected; `soft` and `remote` then ask for optional instructions. A new **Shake…** beside it drops heavy content from the context, with `elide` preselected, or `images` or `thinking`. Both are also in the editor title menu and the Command Palette.
- **Ctrl+Shift+Q** puts the cursor in the chat composer from anywhere, the integrated terminal included: the active session, else the one showing next to your files. With no session open it opens the OMP Desk side bar. In a Terminal-mode session it no longer reaches OMP as Ctrl+Q; press Ctrl+Q itself for a follow-up message.
- **Ctrl+N** in a Chat opens VS Code's symbol search with the text you selected in the Chat (or in the composer) already typed in, the way it does in a text editor; with nothing selected it opens the empty symbol search. It is the command **OMP: Search Symbol from Chat Selection**.
- Sessions open in their own editor group on the left, and that group is locked, so files you open from Chat links, the Explorer or Quick Open appear in a group on the right and the chat stays visible. Turn it off with `omp.chatColumn`.
- **Ctrl+Shift+M** (**OMP: Toggle Files Window Next to Chat**) moves every tab of the group next to the chat into a window of its own, kept on top of other windows, wherever the focus is. That file window stays: files you open from Chat links go into it until you close it, then everything goes back to the right of the chat. Pressing Ctrl+Shift+M again, from any window, brings all its tabs back into the group next to the chat (created to the right of the chat if missing) and closes the window; the next press detaches again. The window is larger than VS Code's default when every tab is a text file; with a diff, a viewer or an unsaved file among the tabs, VS Code moves the group as it is, into a default-size window. Tabs that cannot be reopened in the other window (unsaved files, custom views) stay where they are when coming back. It replaces VS Code's Problems key and the Chat's Cycle Model key; Cycle Model stays in the Command Palette. A keymap extension that binds the key in the text editor (IntelliJ IDEA Keybindings uses it for Move Caret to Matching Brace) wins there; add a user keybinding for `omp.moveFileToNewWindow` to take it back.
- **Sessions is one flat list by default.** Every session of the shown folders is a row labelled `folder · title`: sessions that are not stopped first (unread on top, then the most recent activity), stopped sessions last, and **New Session…** and **Resume Session…** rows at the end that ask for the folder. The button in the view's title bar (`omp.sessionsGrouping`) switches to the previous layout, grouped under folders, and back.
- **Unread replies.** A **●** marks a session whose agent finished a reply or asked you something while you were not looking at its editor; it clears when you look at the session, and it survives a window reload. Both layouts show it.
- While a session has an open editor, its row in Sessions stays selected: the session you viewed most recently. Clearing the selection or selecting a folder or the New Session or Resume Session row puts it back.
- **Ctrl+Alt+Q** (**OMP: Go to Session…**) opens a searchable list of every session, from anywhere including the integrated terminal: title, folder and status, in the Sessions order (unread first, stopped last). Picking one opens it as a click in Sessions does; **New Session…** at the end of the list asks for the folder and starts one.
- **Resume Session** is a button in the Sessions title bar, next to New Session, and a **Resume Session…** row under **New Session…** at the end of the flat list, so it is reachable there, where there are no folder rows. It asks for the folder when several are shown, then lists that folder's saved sessions.
- **Sessions shows the repository's agent root for a subfolder.** A folder opened inside a Git repository whose root holds the agent files (`AGENTS.md`, `CLAUDE.md`, `.agents`, `.omp`, `.claude`, `.pi`) while the folder itself has none, as a Unity project under `repo/` does, is shown as that ancestor, so new sessions start where OMP finds them; sessions already recorded in the subfolder stay listed under it. Turn it off with `omp.useAgentRootFolder`.
- **Sessions is the same in every window.** The folders open in any window of the profile now appear in all of them, so a project open only in another window shows its sessions too; a window that closes takes its folders away after a few seconds. A session another window runs shows that window's live status (Working, Needs your answer, Idle, Unread reply) instead of "Running · in another window"; its icon is the status icon, and a `⧉` mark after the status says it is open in another window. Selection, a row's available actions and the collapsed state of an unpinned folder stay per window. `omp.showWorkspaceFolders` and `omp.useAgentRootFolder` now apply to all windows.
- **Clicking a session another window runs switches to that window at once.** The window comes to the front with the session's tab selected; the "Switch to Window" question is gone (the row's menu keeps **Switch to Window** as the same direct switch). A message appears only when switching is impossible, and says why (the window has no saved workspace or folder, two windows show the same folder, it did not answer, or it no longer has the session open). Sessions that only show history in another window are not switched to.
- **A session starts in the window that has its folder open.** New Session, Resume Session and opening a stopped session of a folder that is open only in another window now run in that window, which comes to the front with the session's tab (the most recently used one when several have it). A **Unity project** (a folder with `ProjectSettings/ProjectVersion.txt` and `Assets/`, found in the session's folder or two levels below it; several are asked once) runs in a window that has the project folder open, or in a new window opened on it, because the Unity extensions need that; the session's working directory stays the repository folder. If the other window does not answer, a message says so and nothing is started. The `omp.launchInFolderWindow` setting (default on) turns it off.
- **A window that was not reloaded after an update is skipped when sessions start in another window.** Such a window cannot open views any more; a session for its folder now starts in the window you used, with a note to reload the other one, instead of ending in an "OMP was updated while this window was open" page there.

### Changed

- **Switching to another window is fast.** Clicking a session another window runs, or starting a session in another window, took up to 22 seconds, because every check whether another window is alive ran a PowerShell command on the extension host's event loop, once per row on every change. The check is now done once per window, in the background, and a switch takes about a fifth of a second. The OMP Desk output log gained `window timing:` lines for the steps of a hand-over.
- **Unpin Folder** no longer refuses while a session in that folder runs. A folder with a running session in the window stays visible, unpinned.

### Fixed

- An `@path` mention written in inline code in Chat (`` `@CHANGELOG.md` ``) is now a link, as it already was in plain text.
- Inline code in a Markdown link label in Chat (`` [`World.Current`](…) ``) is shown as code, not with its backticks.
- **Session cost** in the context popover covers the whole session, as the terminal UI's status line does. After a compaction it used to count only the spend since that compaction.
- The context ring and its popover under the Chat composer show the new usage after **Compact** / **Shake** (from the popover or typed), after `/handoff` and after an automatic compaction. They used to keep the figure from before the pass until the next turn.
- **Chat's model and thinking pickers work during a turn.** Choosing a thinking level or a model while OMP was working was refused with "OMP is busy; choose a thinking level after the turn ends". OMP accepts both changes mid-turn (the next model request uses them), so Chat now sends them at once. When Chat cannot send a change yet (OMP is compacting, a rewind is running, the connection is being restored), it keeps your choice, shows it in the picker with a clock icon and sends it as soon as OMP is ready, before any message you send in the meantime; the newest choice wins. If OMP rejects it, the picker goes back to what OMP uses and a notice says so. **Cycle Model** and **Cycle Thinking Level** (`Ctrl+Shift+U`) behave the same. A choice that is still waiting is lost if the window is reloaded.

## [0.2.1] - 2026-10-09

### Added

- Provider login is easy to find before the first session: Sessions shows **Log in to a model provider to start** when the default OMP profile has no available models. Chat's model chip becomes **Log In to Provider** when its own profile has no models, and the model picker always offers **Log In to Provider…** to add another provider.

### Changed

- A compaction shows in Chat as it does in the terminal UI: a rule across the transcript that cuts off the summarized history, labelled with the amount (for example **Compacted · 400k → 47.8k tokens**); click it to read the summary. The unclear "context-full · complete" line is gone; only a cancelled or failed pass leaves a short line.
- **Compact…** in the context popover also works while a turn runs, as `/compact` does in the terminal UI: OMP interrupts the turn, compacts, then continues it. It is unavailable only while a compaction is already running.

### Fixed

- Chat explains an OMP process that exits on its own with its exit code and bounded stderr text instead of only saying the session stopped. A "No default model selected" refusal offers **Log In to Provider** for that session's profile; other startup failures show their own reason. After configuring a provider, Resume uses the same tab.
- In the composer's command, argument and file suggestions, Up and Down now scroll the list to the selected item. Before, the selection could move past the visible part of a long list, so you could not see what Enter would insert.
- Restored Chat tabs can receive large transcripts, screenshots and tool-result rows after Reload Window without overflowing the authenticated bridge's bounded outbound queue. Snapshot delivery uses socket backpressure and bounded authenticated fragments, closes non-reading peers within a finite write deadline, and explains repeated connection failures instead of reconnecting silently forever.
- **OMP: Log In to Provider…** works without an open session: it opens `omp login` for the default profile, or asks which profile when your sessions use more than one. Before, it refused with "Open a managed OMP session first", which left a new user with no way to log in before the first session could start.
- Chat no longer shows OMP's "xd://: mounted …" list of MCP tool names at the start of a session. That notice is meant for the model; warnings about devices still appear.

## [0.2.0] - 2026-10-09

### Added

- **Chat brings the terminal UI's everyday controls.** Copy buttons on code blocks and your own messages; **Retry** (`F5`, `Alt+R`) on a failed or aborted reply; `↑`/`↓` prompt history in the composer and **Search Prompt History** (`Ctrl+R`) across conversations; `Ctrl+T` and `Ctrl+O` show all thinking and expand all tool calls, remembered for every Chat; **Send now** turns a queued follow-up into steering, and `Alt+↑` takes the newest queued message back into the draft; **Compact…** in the context popover with optional instructions; `Alt+click` on the model or thinking chip cycles it (`Ctrl+Shift+M`, `Ctrl+Shift+U`); **Export Conversation as HTML…**, **Share Conversation Link…** and **Show Chat Keyboard Shortcuts** in the editor title menu. Status lines and warnings from OMP extensions appear around the composer, and their errors as VS Code error messages; their informational notices are not shown.
- Terminal-only OMP slash commands typed into Chat (`/hotkeys`, `/copy`, `/settings` and others in the installed OMP) are no longer sent to the model as text. Chat opens the matching VS Code view, or says where the command works.
- **Rewind a Chat conversation in place.** `Esc` `Esc` in an empty composer, **Rewind to here** on one of your prompts, `/rewind` or **OMP: Rewind Conversation…** (Command Palette and the editor title menu) go back to that prompt; it returns to the composer to edit and send again. **Rewind & summarize** also keeps a model-written summary of the abandoned messages. Files are not restored: the files changed after that point are listed. A chat started by an earlier OMP Desk must be restarted before it can rewind.
- **Undo** after a rewind or a branch switch returns to where the conversation was, as long as nothing newer was added; it still works after the chat is reopened.
- **Switch between your branches.** A marker after the message where the conversation split lists the branches you left by rewinding and switches to one in place. Branches OMP creates on its own (retries, checkpoints) are not listed.
- `/branch` typed alone in Chat opens the same Rewind, as it does in OMP's terminal UI; it never forks the session into a new file. `/branch` or `/rewind` with arguments is refused with a sentence saying how to rewind.

### Changed

- **Models and Agents settings** are easier to read and navigate: the model browser shows available models first and by default, roles and agents are compact keyboard-navigable lists, and fallback chains and presets are listed instead of hidden behind a key field. Selection, filters and unsaved drafts survive reloads and saves, results appear next to the control that caused them, and the pages follow the VS Code theme in Dark and Light.
- **Stop and `Esc` in Chat put messages that were still queued back into the draft**, as the terminal UI's `Esc` does, instead of running a queued steer as a new turn. This needs OMP 18.8.5 or newer; with an older OMP, Stop still stops the turn, but queued messages stay queued.
- **Models and Agents settings pick models the way OMP's `/models` does.** Every model field is now a searchable picker listing the models your roles use first, then each provider, with context size, thinking levels and the roles using each model. Choosing a role's model saves it at once and then offers its thinking level. Fallback chains, the cycle order and agent model overrides are ordered lists with Add, Remove and Move up/down (`Alt+Up`/`Alt+Down`); a new chain picks its role, provider or model from a list. Prewalk and advisor are Inherit, Off or On, with an optional model.
- **OMP: Open Models Settings** and **OMP: Open Agents Settings** open your global settings without asking for a folder; a scope control in the editor switches to a project folder. `/models` in a Chat still opens that Chat's folder.

### Fixed

- OMP sessions now start on localized Windows: private runtime storage is verified by security identifiers instead of English account names or incorrectly decoded console output, without allowing other users access.
- The queued-messages row above the composer no longer keeps listing a steer that OMP already delivered after a Stop, with Edit and Remove still offered.
- Clicking a role's model field no longer shows an empty suggestion list when the role is saved with a thinking level such as `:high`.
- Enabling or disabling an agent no longer copies project-level disabled agents into the global config.
- Clearing a setting that is not set no longer rewrites the config file and strips its comments.
- Opening a project or global config that does not exist yet explains that saving creates it, instead of showing a generic error.
- Chat no longer keeps showing the old branch when OMP moves the conversation to another one itself: it re-reads the moved branch, and loading older messages follows the active branch instead of the last lines of the session file.
- Chat names the file changed by OMP's line-anchored `edit` in its tool card summary and in Rewind's list of changed files.
- The Chat **Agents** row now shows a subagent that finished and was then resumed by a message (`write agent://<id>`, "Delivered"), running with its current tool, and removes it when it stops. OMP's own subagent list does not report that run. The subagent no longer counts as finished for notifications either.

## [0.1.0] - 2026-10-07

First public preview of OMP Desk: a Windows-only VS Code extension that runs your installed [Oh My Pi](https://github.com/can1357/oh-my-pi) (`omp`) sessions in editor tabs.

### Added

- **Sessions view** listing the folders open in the window, pinned folders and every running or stopped OMP conversation for them, with live status (Working, Waiting for subagents, Needs your answer, Idle, Unread reply) and row actions: Open, Rename, Reload, Close, Forget, Delete and Resume Session. Sessions held by another VS Code window or written by a separate `omp` process are marked, and opening them asks first.
- **One editor, two modes.** Each session opens as a rich **Chat** or as the unmodified native OMP **Terminal** TUI, switchable from the editor title. **OMP: Choose Default Session View…** sets the mode for new sessions.
- **Sessions survive restarts.** Each session runs in a detached background process that keeps working when its tab closes, the window reloads or VS Code exits; reopening reattaches to the same process and screen. Only one window writes a session at a time.
- **Chat**: streaming replies, saved history, steer and queued follow-ups (editable before they run), questions and approvals as a card above the composer, slash-command argument suggestions, model and thinking pickers, a footer with context usage, provider quotas and the Git branch, an Overview or Detailed view of tool calls, pinned TODO and Agents rows with detail tabs, a working status row and progress bar, clickable file links, and web links that open in an editor tab (`Ctrl+Click` for the external browser). Drafts stay until OMP confirms them; if OMP stops responding, **Reconnect** or **Restart** keeps the conversation and unsent text.
- **Terminal**: the genuine OMP TUI with Nerd Font glyphs, clickable file and web links, live theme colors, **Copy screen** and **Redraw Terminal**.
- **Windows desktop notifications** when a session finishes or asks for input (`omp.desktopNotifications`).
- **Add Selection to Session** and **Add File to Session** (`Alt+Shift+K`) insert an `@path` reference into a session you pick, without sending it.
- **Folder shells**: **Open Terminal in Folder** and **Reconnect Terminal**.
- **Processes view** for the background processes behind sessions and terminals, with Stop and a one-step cleanup of orphaned and idle processes.
- **Stats** opens OMP's usage dashboard in an editor tab.
- **Tools view** listing the tools and skills of the active session.
- **Models and Agents settings** tabs for OMP's model roles and agent overrides (`/models`, `/agents`).
- **OMP: Log In to Provider…**, **OMP: Show Diagnostics**, **Copy Diagnostics** on rows, and file change observation commands.
- Windows packages for `win32-x64` and `win32-arm64`.

### Notes

- OMP is not bundled. The extension launches the `omp` found on `PATH` and never installs, downloads or updates it.
- OMP Desk is an unofficial, independent integration, not an official OMP distribution.

[Unreleased]: https://github.com/hmmvot/omp-desk/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/hmmvot/omp-desk/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/hmmvot/omp-desk/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/hmmvot/omp-desk/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/hmmvot/omp-desk/releases/tag/v0.1.0
