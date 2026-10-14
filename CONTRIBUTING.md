# Contributing to OMP Desk

Thanks for your interest in OMP Desk, a VS Code extension for running [Oh My Pi](https://github.com/can1357/oh-my-pi) (`omp`) sessions. Bug reports, feature requests and pull requests are welcome.

## Platform

OMP Desk is **Windows-only** (x64 and arm64). It depends on Windows ConPTY, PowerShell and named pipes, so it cannot be developed, tested or run on macOS or Linux. The extension does not bundle OMP; install `omp` separately and make sure it is on `PATH` and authenticated.

## Development setup

Requirements:

- Windows 10 or 11
- [Node.js](https://nodejs.org/) 24 (the tests run TypeScript directly through Node's built-in type stripping; CI uses the same version)
- VS Code 1.110 or newer
- OMP (`omp`) installed and logged in

```powershell
git clone https://github.com/hmmvot/omp-desk.git
cd omp-desk
npm ci
```

## Commands

| Command | Purpose |
| --- | --- |
| `npm run typecheck` | Type-check the whole project (`tsc`, no emit), then `node scripts/check-imports.mjs`: the import direction between the `src/` layers and import cycles ([ADR-0065](docs/decisions/0065-enforce-one-import-direction-between-source-layers.md)) |
| `npm test` | Run every `src/**/*.test.ts` file and the `scripts/*.test.mjs` files with the Node test runner |
| `npm run build` | Bundle the extension host, Webviews, host-control module and PTY broker into `out/` and `media/` |
| `npm run watch` | Rebuild on change |
| `npm run vsix` | Package a VSIX for the current platform with `vsce` into `out/` |
| `npm run vsix:x64`, `npm run vsix:arm64`, `npm run vsix:all` | Package per-architecture release VSIX files into `out/` (each contains only its own `node-pty` prebuilds); see [docs/publishing.md](docs/publishing.md) |

Before opening a pull request, run `npm run typecheck`, `npm test` and `npm run build`.

## Trying a change

1. Run `npm run build`, then `npm run vsix`.
2. Install the VSIX into a throwaway VS Code profile, not your everyday one:
   `code --user-data-dir <scratch-dir>\data --extensions-dir <scratch-dir>\ext --install-extension out\<file>.vsix`, then start VS Code with the same two flags.
3. Open the **OMP Desk** view in the Activity Bar, add a folder and start a session.

The extension writes a log to the **OMP Desk** channel of the Output panel and can print a diagnostics summary with **OMP Desk: Show Diagnostics**. The channel is a VS Code log channel (`LogOutputChannel`): it adds its own time and level, writes to its file continuously (`<logs>/<session>/window<N>/exthost/hmmvot.omp-desk/OMP Desk.log`, whether or not the Output panel is open) and shows Info and above by default. Code logs through the `Logger` interface of `src/shared/logger.ts` (`log.error`, `log.warn`, `log.info`, `log.debug`, `log.trace`; there is no plain-string log function): `error` for a failure that broke a user action, `warn` for degraded-but-continuing, `info` for lifecycle and summaries, `debug` for high-frequency diagnostics (per-spawn timings, hand-over steps, lookups, bridge and focus traces). Do not put a timestamp or the level in a message. To see Debug, use the gear in the Output panel's toolbar or **Developer: Set Log Level…** → **OMP Desk**, or start a test window with `-DeskLogLevel debug` (below). A test that reads log lines uses `recordingLogger` (`LoggedLine` carries the level) or `silentLogger`.

### Test environments with their own OMP state

`scripts/test-vscode.ps1` starts a throwaway VS Code that has its own OMP state as well. That lets you try states your everyday OMP is not in, for example a first start with no provider login:

```powershell
./scripts/test-vscode.ps1 -Name nologin -Vsix ./out/omp-desk-win32-x64-<version>.vsix -Folder <project folder>
./scripts/test-vscode.ps1 -Name nologin -Reset    # back to an OMP with no logins, settings or sessions
```

The window never appears on your screen and cannot take the foreground or keyboard focus: the script starts it on a separate hidden Windows desktop, which no click, shortcut or focus change of yours reaches either. Drive it through the DevTools port (`-RemoteDebuggingPort`; key events, DOM evaluation, webview targets and `Page.captureScreenshot` work there) and close it with `-Stop`, for example `./scripts/test-vscode.ps1 -Name nologin -Stop`. Send `Emulation.setFocusEmulationEnabled` first: a window on the hidden desktop is never the focused one, and without it a screenshot was observed to return a stale frame. Programs started from that window, such as OMP or a browser OMP opens, run on the hidden desktop too. This is the only way the script starts VS Code.

Each `-Name` keeps VS Code data, extensions and an OMP directory under `%LOCALAPPDATA%\omp-desk-test\<name>`. The script points OMP's default profile there with `PI_CODING_AGENT_DIR`. It is the default profile that OMP Desk launches sessions in; `OMP_PROFILE` would not work, because Desk always passes an explicit `--profile`.

The launched VS Code also does not inherit the provider API keys from your environment, so it sees only what was logged in inside the test environment. Pass `-KeepProviderKeys` to keep them.

`-DeskLogLevel <error|warn|info|debug|trace>` starts the window with that level for the OMP Desk log (VS Code's `--log=hmmvot.omp-desk:<level>`); without it the log is at VS Code's own level, Info. The end-to-end suite passes `debug`, because its scenarios read `window timing:` lines; `E2E_DESK_LOG_LEVEL=default` (or another level) in the environment of `npm run test:e2e` overrides that.

A new environment starts with settings that skip VS Code's first-run prompts (workspace trust, AI sign-in, welcome page). Keep the root inside your user profile: OMP Desk refuses to start sessions when its storage sits under a folder other users can modify, such as a folder created directly under `C:\`. `-RemoteDebuggingPort` opens a DevTools port for automated UI checks. `-ResetVsCode` also clears VS Code and OMP Desk storage; stop the window first. Run `Get-Help ./scripts/test-vscode.ps1 -Detailed` for every option.

A VS Code that has downloaded an update and waits for "Restart to Update" keeps its installer running with the `vscode-updating` mutex held, and any `Code.exe` started meanwhile waits 30 s for it and exits with no window and no log. The script checks that mutex before launching and stops with a message that says so; finish the update, or point `-VsCodeDir` at another VS Code install folder (one with `Code.exe` and `bin\code.cmd`) that has no update pending.

### End-to-end tests (Playwright over CDP)

`npm run test:e2e` runs [Playwright Test](https://playwright.dev/) against a real VS Code with the real extension and the installed `omp`, on the same hidden Windows desktop as `scripts/test-vscode.ps1` (the only launcher the suite uses; no test window can appear on your screen). It needs Windows, `code.cmd` on `PATH`, an installed `omp` and `npm ci`; Playwright's own browsers are not used or downloaded.

What a run does: it packages the working tree into `out/e2e-results/omp-desk-e2e-<target>.vsix` (rebuilt only when a source file is newer; `E2E_VSIX=<path>` pins a VSIX, `E2E_REBUILD=1` forces a rebuild), starts a local OpenAI-compatible mock model server (`test/e2e/fixtures/mock-openai-server.ts`), writes an isolated OMP agent directory that names it as the only provider (`models.yml`, `config.yml`; no provider key), starts a fresh `e2e-run-*` environment under `%LOCALAPPDATA%\omp-desk-test`, attaches with `chromium.connectOverCDP` and runs `test/e2e/scenarios/*.spec.ts` in order on one worker: wiring smoke test, a session held by another window, Kill then immediate resume, `/context` rendering, latency budgets. Afterwards it stops VS Code and deletes the profile.

- A foreground watchdog (`test/e2e/foreground-watchdog.ps1`, a 50 ms sampling loop) runs on your desktop for the whole run. Setup waits until it samples before VS Code starts; teardown requires its fresh report (a stale report, an early exit or a timeout fails the run). It fails the run, killing the window, if a test VS Code window is seen as foreground or visible there. This is sampled detection, not proof that no transient event ever happened; the windows live on another desktop, so it is a safety net.
- A side-effect guard fingerprints the state the suite must never change, before and after: `~/.omp/agent/config.yml`, your VS Code `settings.json`, and `~/.omp/plugins` (the content of every top-level file, the names of every top-level entry, and the `package.json` of every installed package, so installs, removals, upgrades and toggles show; package sources and `cache` are not fingerprinted). It detects, it does not sandbox: `PI_CODING_AGENT_DIR` moves only the agent directory, so plugins and user-level skills (`~/.claude`, `~/.agents`) stay readable from the test window. The suite never toggles or writes them. A difference fails the run and names the changed lines; nothing is restored, because the cause may be your own concurrent OMP or VS Code saving settings, and then you rerun. A change event that leaves the content identical is only reported.
- Setup and teardown release every resource they acquired even when one step fails, evaluate both guards regardless, and report all problems together with the first one.
- Artifacts are under `out/e2e-results/` (Git-ignored): `report.json`, `watchdog.json`, `latency.jsonl`, `mcp/` (anything an MCP server writes), and for each failed test `artifacts/<test>/trace.zip` (open with `npx playwright show-trace`), `window-N.png`, `desk-log-window<N>.log` (the extension's own log of every window) and `error-context.md`. The files can contain local paths and window content; do not publish them.
- Development loop: `E2E_KEEP_ENV=1 npm run test:e2e -- 20-kill` keeps VS Code running; only a run that also sets `E2E_KEEP_ENV=1` attaches to it (a plain run stops and replaces it), and combining it with `E2E_VSIX` or `E2E_REBUILD=1` is refused because the kept window already has an extension installed; end it with `npm run test:e2e:stop`. Run one suite at a time. Waits are generous because the machine is often busy; only the latency budgets in `40-latency.spec.ts` are strict.
- `node test/e2e/tools/mcp-probe.mjs <playwright|devtools> <cdp-port>` drives the window through Playwright MCP or Chrome DevTools MCP over stdio (nothing is registered in any MCP configuration); its own output goes to `out/e2e-results/mcp/`; ADR-0064 summarizes what it showed.

## Documentation and design conventions

Project documentation lives in [`docs/`](docs/README.md): current architecture, product requirements, design documents and architecture decision records (ADRs). Start with [docs/README.md](docs/README.md); it defines the templates and naming conventions.

- Propose a design document before a major change and an ADR before a lasting technical choice.
- Update the affected documentation in the same pull request as the code.
- Write documentation in English.

[AGENTS.md](AGENTS.md) holds the same guidance for AI coding agents working in this repository.

## Pull requests

- Keep a pull request to one topic and describe the user-visible effect.
- Add or update focused tests for behavior you change.
- Add a line to the `Unreleased` section of [CHANGELOG.md](CHANGELOG.md) for user-visible changes.
- Do not commit personal data: absolute local paths, user names, e-mail addresses or tokens.

## Licensing

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE). If you add or update bundled third-party code, update [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt) as well.

## Reporting security issues

Do not open a public issue for a vulnerability. Follow [SECURITY.md](SECURITY.md).
