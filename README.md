# OMP Desk

[![CI](https://github.com/hmmvot/omp-desk/actions/workflows/ci.yml/badge.svg)](https://github.com/hmmvot/omp-desk/actions/workflows/ci.yml)
[![Marketplace version](https://vsmarketplacebadges.dev/version-short/hmmvot.omp-desk.svg)](https://marketplace.visualstudio.com/items?itemName=hmmvot.omp-desk)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![100% vibe coded](https://img.shields.io/badge/100%25-vibe%20coded-ff69b4)](#how-this-was-made)
[![Built with Oh My Pi](https://img.shields.io/badge/built%20with-Oh%20My%20Pi-blueviolet)](#how-this-was-made)

Run your [Oh My Pi](https://github.com/can1357/oh-my-pi) (`omp`) sessions from VS Code: every folder and conversation in one place, as a rich **Chat** or OMP's native **Terminal**, and the sessions keep running when you close the tab.

![A Chat session next to the Sessions view](media/readme/chat.png)

> **Preview.** OMP Desk is an unofficial, independent integration, not an official OMP distribution. It is Windows-only.

## Why OMP Desk

**Sessions that don't die.** Close the tab, reload the window, even update VS Code (a Chat on a Bun-installed OMP survives the update): the session keeps running and reopens as the same process. [More](docs/guide/sessions.md#sessions-that-survive-restarts)

**Chat or OMP's native Terminal, in the same tab.** Switch any time; the Terminal is OMP's own UI, unmodified. [More](docs/guide/terminal.md)

![Terminal mode](media/readme/terminal.png)

**One Sessions view across all windows.** Live status, an unread marker, and a click jumps to the window that has the session. [More](docs/guide/sessions.md)

![Sessions view](media/readme/sessions.png)

**A rich Chat.** Steer or queue a message while a turn runs, Rewind with branches, mermaid diagrams, links to files and code symbols, image attachments and code blocks in the draft. [More](docs/guide/chat.md)

![Chat with tool rows, TODO and Agents](media/readme/chat-agents.png)

**A GUI for OMP's own settings and features.** Models and Agents editors (who runs on what, and why), an OMP Settings editor with global and project layers, Skills, Tools and MCP views, provider login, Stats, the slash-command list and a provider quota status bar. [More](docs/guide/omp-settings.md)

![The Models editor](media/readme/models.png)

![The OMP Settings editor](media/readme/omp-settings.png)

**Desktop notifications** when the agent finishes or asks you something. [More](docs/guide/notifications.md)

## Requirements

Windows 10 or 11, VS Code 1.110 or newer, and [Oh My Pi](https://github.com/can1357/oh-my-pi) installed, on your `PATH` and logged in to a provider. OMP Desk never installs or updates OMP; it runs the `omp` you have. [Install forms and details](docs/guide/getting-started.md#requirements)

## Getting started

1. Install **OMP Desk** (`hmmvot.omp-desk`) from the Extensions view, or from a [release](https://github.com/hmmvot/omp-desk/releases) VSIX.
2. Open the **OMP Desk** view in the Activity Bar. Your open folders are listed with their existing OMP sessions.
3. Use a folder's **New Session** action. The session opens in an editor tab.
4. Close the tab whenever you like. The session keeps running until you stop it.

## Learn more

- [User guide](docs/guide/README.md): every feature, one page per topic.
- [Keyboard shortcuts](docs/guide/keyboard-shortcuts.md) and [settings](docs/guide/settings.md).
- [Troubleshooting](docs/guide/troubleshooting.md), including a blocked native module, and [upgrading](docs/guide/upgrading.md).
- [Contributing](CONTRIBUTING.md) and the [developer documentation](docs/README.md); [changelog](CHANGELOG.md).
- **Privacy and security.** Everything runs on your machine and OMP Desk sends no telemetry. [Details](docs/guide/privacy-and-security.md); report vulnerabilities privately, see [SECURITY.md](SECURITY.md).

## How this was made

OMP Desk is 100% vibe coded. All of its code, tests and documentation were written by AI agents running in [Oh My Pi](https://github.com/can1357/oh-my-pi); none of it was written by hand. Agents also reviewed the designs and code, and ran the automated tests. Expect rough edges, and please [report them](https://github.com/hmmvot/omp-desk/issues/new/choose).

## License and credits

OMP Desk is released under the [MIT License](LICENSE). It uses and adapts open-source work, listed with its licenses in [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt): [oh-my-pi](https://github.com/can1357/oh-my-pi) (MIT, including the adapted icon artwork), [Paseo](https://github.com/getpaseo/paseo) (Apache-2.0, text reveal policy), [xterm.js](https://github.com/xtermjs/xterm.js) and [node-pty](https://github.com/microsoft/node-pty) (MIT), React (MIT) and the VS Code [Codicons](https://github.com/microsoft/vscode-codicons) (CC-BY-4.0).
