# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Chat brings the terminal UI's everyday controls.** Copy buttons on code blocks and your own messages; **Retry** (`F5`, `Alt+R`) on a failed or aborted reply; `↑`/`↓` prompt history in the composer and **Search Prompt History** (`Ctrl+R`) across conversations; `Ctrl+T` and `Ctrl+O` show all thinking and expand all tool calls, remembered for every Chat; **Send now** turns a queued follow-up into steering, and `Alt+↑` takes the newest queued message back into the draft; **Compact…** in the context popover with optional instructions; `Alt+click` on the model or thinking chip cycles it (`Ctrl+Shift+M`, `Ctrl+Shift+U`); **Export Conversation as HTML…**, **Share Conversation Link…** and **Show Chat Keyboard Shortcuts** in the editor title menu. Status lines and notices from OMP extensions appear around the composer, and their errors as VS Code error messages.
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

[Unreleased]: https://github.com/hmmvot/omp-desk/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/hmmvot/omp-desk/releases/tag/v0.1.0
