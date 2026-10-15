# OMP Desk user guide

OMP Desk runs your [Oh My Pi](https://github.com/can1357/oh-my-pi) (`omp`) sessions from VS Code. It lists every folder and conversation in one **Sessions** view. Each session opens in an editor tab as a rich **Chat** or as OMP's own native **Terminal** UI, and it keeps running when you close the tab or reload the window.

OMP Desk is an unofficial, independent integration, not an official OMP distribution. It is Windows-only. This guide is for people who use the extension; the [project README](../../README.md) is the short tour, and the [developer documentation](../README.md) covers design and architecture.

## Pages

| Page | What it covers |
| --- | --- |
| [Getting started](getting-started.md) | Requirements, installing OMP Desk and your first session, limitations. |
| [Sessions](sessions.md) | The Sessions view, live status and unread marker, sessions that survive restarts (and the VS Code update exception), background processes and the Terminals layout, Stats, where sessions open. |
| [Chat](chat.md) | The Chat editor: composer, steering and queueing, Rewind, mermaid diagrams, links, images, code blocks, slash commands, the Commands list, quotas. |
| [Terminal](terminal.md) | OMP's native Terminal UI in the same tab, and switching between Chat and Terminal. |
| [Send code to a session](send-code.md) | Add a selection or a file to a session as an `@path` reference. |
| [Notifications](notifications.md) | Windows desktop notifications when a session finishes or asks. |
| [OMP settings, models and agents](omp-settings.md) | The Models, Agents and OMP Settings editors, the Skills, Tools, MCP, Extensions and Context views, logging in to a provider. |
| [Keyboard shortcuts](keyboard-shortcuts.md) | Every default key, keymap notes and the other commands. |
| [Settings](settings.md) | Every `ompDesk.*` setting. |
| [Privacy and security](privacy-and-security.md) | What stays on your machine, and where to report a vulnerability. |
| [Troubleshooting](troubleshooting.md) | OMP not found, the log and diagnostics, a blocked native module. |
| [Upgrading](upgrading.md) | From 0.3.x and from the unpublished local build. |

Everything is in the Command Palette under **OMP Desk**. Contributions are welcome: see [CONTRIBUTING.md](../../CONTRIBUTING.md), and [CHANGELOG.md](../../CHANGELOG.md) for what changed.
