# Getting started

## Requirements

- Windows 10 or 11, x64 or arm64.
- VS Code 1.110 or newer, in a trusted workspace.
- [Oh My Pi](https://github.com/can1357/oh-my-pi) installed, on your `PATH` and logged in to a provider. OMP Desk never bundles, installs or updates OMP; it runs the `omp` you already have. To use another program, set [`ompDesk.executablePath`](settings.md).

Any of these OMP install forms works. All of them need Windows paths that Desk can follow from `omp` on your `PATH`; the table says what Desk then starts and whether the settings editors work.

| How OMP was installed | What Desk starts | Chat and Terminal | `/agents`, `/model`, `/settings` and the Models, Agents and OMP Settings editors |
| --- | --- | --- | --- |
| **Bun global** (`bun install -g @oh-my-pi/pi-coding-agent`; also what the `omp.sh` installer does when Bun is present) | `bun.exe` running the package's entry | Yes | Yes |
| **npm global** (`npm install -g @oh-my-pi/pi-coding-agent`) | `bun` running the package's entry, found through npm's `omp.cmd` | Yes | Yes |
| **pnpm global** (`pnpm add -g @oh-my-pi/pi-coding-agent`) | `bun` running the package's entry, found through pnpm's `omp.cmd` and its link into the `.pnpm` store | Yes | Yes |
| **Yarn 1 global** (`yarn global add @oh-my-pi/pi-coding-agent`) | `bun` running the package's entry, found through Yarn's `omp.cmd` | Yes | Yes |
| **Volta** (`volta install @oh-my-pi/pi-coding-agent`) | `bun` running the package in Volta's image, found through Volta's `omp.cmd`; Volta itself and Node are not started | Yes | Yes |
| **OMP's compiled program from `omp.sh` or winget** (`can1357.oh-my-pi`) | the program itself | Yes | No: the program carries its code inside the executable, so there is no source for the editors to read |
| **mise** (`mise use -g github:can1357/oh-my-pi`) | the installed `omp.exe` in mise's `installs` folder, found through mise's `shims\omp.exe` when exactly one release is installed (with several, Desk names them and asks for [`ompDesk.executablePath`](settings.md)) | Yes | No, as for the compiled program |
| **`install.ps1 -Source -Ref <tag>`** (a clone built into a Bun global install) | as for Bun global (inferred: Bun copies the package into its global folder, so the layout is the registry install's; the install itself failed in the check, see below) | Yes, once the install succeeds | Yes, once the install succeeds |

Not covered: Yarn 2 and newer (they have no global install), and an OMP installed by a method that is not in the table. A launcher Desk does not recognise is refused with the reason; set [`ompDesk.executablePath`](settings.md) to OMP's program instead.

The npm, pnpm, Yarn and Volta forms run OMP's entry under Bun (OMP's `#!/usr/bin/env bun`), so Bun must be installed too, as for the Bun global install. In the check for this guide `install.ps1 -Source -Ref v18.11.1` installed nothing on Bun 1.3.14, 1.4.0 and 1.4.3: `bun install -g <clone>\packages\coding-agent` stopped with `failed to resolve` on the package's `catalog:` dependencies. That failure is the installer's and comes before Desk is involved.

With the compiled program, host control (model readback, subagent work indicators, Terminal status) needs a build that accepts Bun's startup options from `BUN_OPTIONS`. Desk checks that once per executable and, when the build does not accept them, runs the session without host control and says so. Chat itself is unaffected.

The Skills, Tools, MCP and Extensions views read OMP's own source files too, so they need a package install as well. With the compiled program, the three editors name `/agents`, `/model` or `/settings` in the session's Terminal view as the way to do the same there.

An OMP that began as a Bun global install can turn into the compiled program: when `omp update` finds that Bun's launcher cannot run the new release (OMP 18.13 needs Bun 1.4.4 or newer), it replaces Bun's `omp.exe` with the compiled program and stops updating the Bun package. Desk then treats it as the compiled program, whatever Bun's global folder still holds; see [After `omp update` changed Bun's launcher](troubleshooting.md#after-omp-update-changed-buns-launcher).

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
