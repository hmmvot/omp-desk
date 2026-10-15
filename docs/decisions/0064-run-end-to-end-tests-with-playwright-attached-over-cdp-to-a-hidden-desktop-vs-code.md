---
status: accepted
date: 2026-10-12
---

# ADR-0064: Run end-to-end tests with Playwright Test attached over CDP to a hidden-desktop VS Code

## Context and Problem Statement

OMP Desk has unit, integration, real-broker and owned-Chromium page tests, but nothing that drives the installed extension in a real VS Code. Several regressions were therefore found only by the maintainer or by throwaway CDP scripts: the "open in another window" badge under a slow PowerShell, a blocked extension host, slow inventory views, raw escape fragments from a real `/context` report, lost focus.

The binding constraint is that **a test window must never appear on the user's desktop or take focus** (`scripts/test-vscode.ps1` starts VS Code on a separate hidden Windows desktop through `CreateProcess` and exposes only a DevTools port). The suite also needs a deterministic model with no provider keys, two windows of one profile, and failure artifacts a maintainer can open later.

## Considered Options

- **Playwright Test attached with `chromium.connectOverCDP`** to the VS Code that `scripts/test-vscode.ps1` already started. Playwright does not launch anything; it only needs the DevTools endpoint.
- **wdio-vscode-service** (WebdriverIO, 8.0.0 at the time of writing). **Unverified: not run here.** From its documented launch model it downloads a VS Code and a chromedriver and starts VS Code itself through the driver, which puts the window where the driver's process runs. Attaching to an already running Electron needs chromedriver's `debuggerAddress` and a matching chromedriver build, which the service does not document as a supported mode. Its Workbench page objects are the main attraction.
- **vscode-extension-tester** (Selenium based, 8.28.1). **Unverified: not run here.** Same launch model and the same objection; page objects exist for views and webviews.
- **`@vscode/test-electron` with Mocha in the extension host.** Its ordinary launch model starts a visible window (a custom launcher could point it at another desktop, which was not tried). API-level tests only: no DOM and no webview content.

## Decision Outcome

**Playwright Test over CDP** (`npm run test:e2e`, `test/e2e/`). The launcher stays the one place that starts VS Code, so the hidden-desktop guarantee is unchanged. A foreground watchdog on the user's desktop samples the foreground window and the visible windows every ~50 ms and fails the run (killing the window) if a test window is seen there. This is sampled detection, not proof that no transient event occurred; the real guarantee is the separate desktop.

Protected user state, and what the suite does not isolate. `PI_CODING_AGENT_DIR` isolates the OMP agent directory (config, models, sessions, the owned fixture skill). It does not sandbox the file system: `~/.omp/plugins`, user-level skills (`~/.claude`, `~/.agents`) and the real VS Code settings stay reachable from the test window. The suite never toggles or writes them, and a guard fingerprints before and after: `~/.omp/agent/config.yml`, the VS Code `settings.json`, and `~/.omp/plugins` (content of every top-level file, names of every top-level entry, `package.json` of every installed package; package sources and `cache` are not covered). A difference fails the run and names the changed lines; nothing is restored, so a concurrent edit by the user is never overwritten (a concurrent real OMP saving settings can trip it: rerun). Change events with identical content are only reported. If "isolation" must mean that the test window cannot even read the user's plugins and skills, that is a stronger scope than this ADR decides. **Amended 2026-10-15 (recorded by the implementer; not independently reviewed):** the window's OMP profile is now isolated for reads as well. `PI_CODING_AGENT_DIR` does not cover OMP's user-level agent discovery, which reads `~/.omp/agent/agents` from the home folder (verified in the installed OMP's `discoverAgents`/`getConfigDirs`), so the Models and Agents editors of a test window listed the user's own agents. `scripts/test-vscode.ps1 -IsolateHome`, always passed by the suite's launcher, starts the window with `USERPROFILE`, `HOME`, `HOMEDRIVE` and `HOMEPATH` pointing at `<base>/home`, so every `~` lookup of VS Code, OMP and Desk lands in an empty folder of the run. `scenarios/01-own-profile.spec.ts` asserts it through the Agents editor's source filter (no source but `bundled`, no user agent). The fingerprint guard stays as the check on the real paths. Only the `-IsolateHome` launcher path and one scenario were run; the other scenarios were not re-run with the isolated home in this amendment.

Harness lifecycle. Setup waits until the watchdog samples before VS Code starts; teardown requires the watchdog's fresh report (a stale report, an early exit or a timeout fails the run). Every resource acquired during a failed setup or teardown is released independently, both guards are always evaluated, and all problems are reported together. A kept development environment (`E2E_KEEP_ENV=1`) is reused only by a run that asks for it, and not together with `E2E_VSIX` or `E2E_REBUILD=1`.

### Spike evidence (OMP 18.8.5, VS Code with Chromium 150, Windows)

- Playwright attaches in under a second. Each VS Code window is one `Page`; a second window of the same profile (opened by running the launcher again with the same `-Name`) is a second `Page` of the same default context.
- Locators work on workbench trees and menus (ordinary roles, `toMatchAriaSnapshot`, HTML context menus once `window.dialogStyle` is `custom`) and inside the extension's webviews, which VS Code nests as workbench page, `iframe.webview` (hosted in an overlay container, not in the editor part; side-bar webview views carry `purpose=webviewView` in the URL) and `iframe#active-frame`. `frameLocator` chains reach the Chat composer, transcript and the Settings view. The CSS-drawn row badge appears in aria snapshots but not in `innerText`.
- Playwright traces work on the connected context: a failed test keeps `trace.zip` with screenshots and DOM snapshots, a screenshot per window and the extension's log of every window.
- OMP 18.8.5 accepts a custom provider from `<agentDir>/models.yml` (`providers.<id>.baseUrl/apiKey/api/models`) and a default model from `config.yml` (`modelRoles.default`); the isolated agent directory needs no key. A local OpenAI-compatible mock (`test/e2e/fixtures`) answers Chat turns, a scripted `read` tool call (supported by the mock, not yet used by a scenario) and OMP's own `/context` report.
- Scenarios: other-window row and switch (also while the CPU is saturated), Kill then immediate resume, `/context` rendering and number agreement, latency budgets. The `/context` scenario **fails on a build with the SGR rendering fix (c2209bd) reverted**, showing the raw `[38;2;107;114;128m` fragments, and passes on the fixed build. Failure on a reverted fix was demonstrated for that scenario only.
- Latency measured in the page from a real click's `pointerdown`: Sessions layout QuickPick about 20 ms; the Skills first expand, which starts the inventory worker and is measured to the owned fixture skill row, about 4 s (no budget); a cached reopen about 7 ms. With 64 busy workers on 32 logical processors: 18-23 ms, a warm reopen of 19 ms and a cached reopen of 13 ms (normal-priority load barely delays interactive threads). Budgets: layout 500 ms and cached 300 ms on the median of three samples; a sample that timed out fails the test.
- Agent tooling (nothing registered in any MCP configuration; `test/e2e/tools/mcp-probe.mjs` reproduces it, its output confined to `out/e2e-results/mcp/`): **Playwright MCP** (`--cdp-endpoint`) attaches and its accessibility snapshot shows the workbench (the Sessions tree) and the nested webview iframes as bare `iframe` refs, but does not expand their content, so the Chat composer is not in the snapshot and cannot be clicked or typed into through refs. **Chrome DevTools MCP** (`--browser-url`, `--no-usage-statistics`, `--no-performance-crux`): `take_snapshot` includes the Sessions tree and the Chat composer, and `performance_start_trace` / `performance_stop_trace` return a summary. Clicks through DevTools MCP were not tested.

### Known limits and one open suite issue

- **Open product issue found by the loaded variant (not fixed here):** starting a Chat session while 64 busy workers saturate the CPU fails with `the PTY broker runtime is not usable yet: the runtime self-check failed with exit code 7: the pipe child did not finish within the self-check deadline` and the session ends as launch-failed. The loaded other-window scenario therefore starts the load only after the session runs.
- **One unexplained failure of the loaded other-window scenario.** In one full run (before the harness kept per-window logs) the requester log never gained a `held elsewhere=true` line within 120 s after the row click. The evidence of that run was not kept (the extension logs were deleted with the environment). It has not recurred in 16 later runs (one rerun of the scenario file, six repeats of the scenario alone and the scenario inside nine full-suite runs, the last six of them on the final harness, all fully green); the harness now saves every window's extension log with the artifacts of a failed test, so a recurrence will carry its evidence. It is therefore recorded as unexplained, without a retry or a longer timeout masking it, and the scenario's failure should be investigated, not rerun away, when it recurs.
- A slow PowerShell cannot be simulated (the extension resolves `%SystemRoot%\System32\...\powershell.exe` with no seam); only the CPU-loaded variant exists.
- A click on a context-menu item in the instant the menu opens is ignored (hover and wait for the focused item), and a Sessions tree row that re-renders between mouse down and up loses a click, so `New Session` is clicked again only while no pick or panel appeared.
- The Skills view also lists the user's real `~/.claude` and `~/.agents` skills; the suite reads them and asserts only the owned fixture row.

### Consequences

- Positive: regressions in real VS Code, real webviews and real OMP become permanent tests; no window reaches the user's desktop; traces are portable; one dependency (`@playwright/test`, no browser download).
- Negative: tests depend on VS Code's DOM structure (workbench selectors, overlay webview iframes) and on log text of the Desk output channel for some assertions; a full run takes about 2 minutes plus a VSIX build; one run at a time per machine; the guard detects but does not prevent changes to the user's plugins.

## Related Documents

- `scripts/test-vscode.ps1`, `CONTRIBUTING.md` (End-to-end tests)
- [ADR-0056](0056-publish-window-state-in-a-leased-registry-and-switch-windows-by-request.md), [ADR-0063](0063-read-the-context-breakdown-from-omps-own-context-report-and-files-from-the-system-prompt.md)

## Architecture Review

- Reviewer: independent architecture review (Adr64Review), read-only, at commit d6f9a61
- Outcome: accepted after the listed fixes; the framework choice was supported and the findings were in harness ownership and evidence, not in a limit of CDP
- Notes: resolved: setup and teardown failures no longer bypass the guards; the watchdog needs a readiness signal and a fresh report; the plugin guard fingerprints the installed packages and its contract is stated; the Skills measurement uses an owned fixture row and rejects failed samples; the MCP probe is confined to `out/e2e-results/mcp/`; a kept environment can no longer silently override the selected VSIX; the open loaded-window failure is recorded above; the documentation map and changelog list the work. Not resolved by design: the unexplained loaded-window failure (recorded, evidence now captured), plugins and user skills stay reachable (stated), wdio-vscode-service and vscode-extension-tester are unverified.
