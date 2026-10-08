# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **Models and Agents settings** are easier to read and navigate: the model browser shows available models first and by default, roles and agents are compact keyboard-navigable lists, fallback chains and presets are listed instead of hidden behind a key field, and prewalk/advisor offer inherit, on, off or a pattern. Selection, filters and unsaved drafts survive reloads and saves, results appear next to the control that caused them, and the pages follow the VS Code theme in Dark and Light.

### Fixed

- Typing in an agent's model suggestion field no longer replaces its existing override patterns.
- Enabling or disabling an agent no longer copies project-level disabled agents into the global config.
- Clearing a setting that is not set no longer rewrites the config file and strips its comments.
- Opening a project or global config that does not exist yet explains that saving creates it, instead of showing a generic error.

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
