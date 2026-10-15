# Getting started

## Requirements

- Windows 10 or 11, x64 or arm64.
- VS Code 1.110 or newer, in a trusted workspace.
- [Oh My Pi](https://github.com/can1357/oh-my-pi) installed, on your `PATH` and logged in to a provider. OMP Desk never bundles, installs or updates OMP; it runs the `omp` you already have. To use another program, set [`ompDesk.executablePath`](settings.md).

Either OMP install form works:

- the **Bun global install** (`bun install -g @oh-my-pi/pi-coding-agent`, also what the `omp.sh` installer does when Bun is present), and
- **OMP's own compiled program** (winget `can1357.oh-my-pi`, the `omp.sh` binary install, mise).

With the compiled program, host control (model readback, subagent work indicators, Terminal status) needs a build that accepts Bun's startup options from `BUN_OPTIONS`. Desk checks that once per executable and, when the build does not accept them, runs the session without host control and says so. Chat itself is unaffected.

The install form also decides whether a running Chat survives a VS Code update; see [Sessions that survive restarts](sessions.md#sessions-that-survive-restarts).

## Install and start

1. Install **OMP Desk** (`hmmvot.omp-desk`) from the Extensions view. Or download the VSIX for your architecture from [releases](https://github.com/hmmvot/omp-desk/releases) and run `code --install-extension omp-desk-win32-x64-<version>.vsix` (or `omp-desk-win32-arm64-<version>.vsix`).
2. Open the **OMP Desk** view in the Activity Bar. The folders open in this window are already listed, with their existing OMP sessions. If your default OMP profile has no models yet, **Log in to a model provider to start** appears above the sessions; see [Log in to a provider](omp-settings.md#log-in-to-a-provider).
3. Use a folder's **New Session** action. The session opens in an editor tab, as a [Chat](chat.md) unless you chose the [Terminal](terminal.md) as the default.
4. Close the tab whenever you like. The session keeps running until you stop it. See [Sessions](sessions.md).

Upgrading from an earlier version or from a local build? See [Upgrading](upgrading.md).

## Limitations

- Windows only. There are no macOS or Linux builds.
- Stopping a folder shell cannot guarantee that every child process stopped. Commands detached from the shell may keep running.
- OAuth-dependent MCP setup, and anything OMP asks you to do in its own settings UI, is done in OMP.
- Installing OMP and switching OMP versions are outside the extension.
