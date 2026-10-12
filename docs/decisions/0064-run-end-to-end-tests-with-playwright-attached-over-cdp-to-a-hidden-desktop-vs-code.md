---
status: proposed
date: 2026-10-12
---

# ADR-0064: Run end-to-end tests with Playwright Test attached over CDP to a hidden-desktop VS Code

## Context and Problem Statement

OMP Desk has unit, integration, real-broker and owned-Chromium page tests, but nothing that drives the installed extension in a real VS Code. Several regressions were therefore found only by the maintainer or by throwaway CDP scripts: the "open in another window" badge under a slow PowerShell, a blocked extension host, slow inventory views, raw escape fragments from a real `/context` report, lost focus.

The binding constraint is that **a test window must never appear on the user's desktop or take focus** (`scripts/test-vscode.ps1` starts VS Code on a separate hidden Windows desktop through `CreateProcess` and exposes only a DevTools port). The suite also needs a deterministic model with no provider keys, two windows of one profile, and failure artifacts a maintainer can open later.

## Considered Options

- **Playwright Test attached with `chromium.connectOverCDP`** to the VS Code that `scripts/test-vscode.ps1` already started. Playwright does not launch anything; it only needs the DevTools endpoint.
- **wdio-vscode-service** (WebdriverIO, 8.0.0 at the time of writing). It downloads a VS Code and a chromedriver and starts VS Code itself through the driver. Its Workbench page objects are the main attraction. [INFERENCE: from its documented launch model, not run here] starting the application itself puts the window on the user's desktop, and attaching to an already running Electron needs chromedriver's `debuggerAddress` plus a matching chromedriver build, which the service does not document as a supported mode.
- **vscode-extension-tester** (Selenium based, 8.28.1). Same launch model and the same objection [INFERENCE: not run here]; page objects exist for views and webviews.
- **`@vscode/test-electron` with Mocha in the extension host**. API-level tests only: no DOM, no webview content, and it launches visible windows.

## Decision Outcome

Proposed: **Playwright Test over CDP** (`npm run test:e2e`, `test/e2e/`). The launcher stays the one place that starts VS Code, so the hidden-desktop guarantee is unchanged, and the suite adds a foreground watchdog that fails the run if a test window is ever foreground or visible on the user's desktop.

Spike evidence (OMP 18.8.5, VS Code with Chromium 150, Windows):

- Playwright attaches in under a second. Each VS Code window is one `Page`; a second window of the same profile (opened by running the launcher again with the same `-Name`) is a second `Page` of the same default context.
- Locators work on workbench trees and menus (ordinary roles, `toMatchAriaSnapshot`, HTML context menus once `window.dialogStyle` is `custom`) and inside the extension's webviews, which VS Code nests as workbench page, `iframe.webview` (hosted in an overlay container, not in the editor part; side-bar webview views carry `purpose=webviewView` in the URL) and `iframe#active-frame`. `frameLocator` chains reach the Chat composer, transcript and the Settings view. The CSS-drawn row badge appears in aria snapshots but not in `innerText`.
- Playwright traces work on the connected context: a failed test keeps `trace.zip` with screenshots and DOM snapshots plus one screenshot per window.
- OMP 18.8.5 accepts a custom provider from `<agentDir>/models.yml` (`providers.<id>.baseUrl/apiKey/api/models`) and a default model from `config.yml` (`modelRoles.default`); the isolated agent directory needs no key. A local OpenAI-compatible mock (`test/e2e/fixtures`) answers Chat turns, a scripted `read` tool call and OMP's own `/context` report.
- Scenarios: other-window row and switch (also while the CPU is saturated), Kill then immediate resume, `/context` rendering and number agreement, latency budgets. The `/context` scenario **fails on a build with the SGR rendering fix (c2209bd) reverted**, showing the raw `[38;2;107;114;128m` fragments, and passes on the fixed build.
- Latency measured in the page from a real click's `pointerdown`: Sessions layout QuickPick about 20 ms, Skills first rows 215 ms, cached reopen about 7 ms; with 64 busy workers on 32 logical processors 23 ms, 14 ms and 13 ms (normal-priority load barely delays interactive threads).
- Finding made by the loaded variant: starting a Chat session while 64 busy workers run fails with `the PTY broker runtime is not usable yet: the runtime self-check failed ... did not finish within the self-check deadline` (launch-failed). The loaded other-window scenario therefore starts the load only after the session runs.
- Limits met: a slow PowerShell cannot be simulated (the extension resolves `%SystemRoot%\System32\...\powershell.exe` with no seam), a click on a context-menu item in the instant the menu opens is ignored (hover and wait for the focused item), `~/.omp/plugins` and user-level skills are not isolated by `PI_CODING_AGENT_DIR`, and a concurrently running real OMP can change `~/.omp/agent/config.yml` during a run and trip the side-effect guard.
- Agent tooling: see the MCP probe results recorded with the spike report; `test/e2e/tools/mcp-probe.mjs` reproduces them.

### Consequences

- Positive: regressions in real VS Code, real webviews and real OMP become permanent tests; no window reaches the user's desktop; traces are portable; one dependency (`@playwright/test`, no browser download).
- Negative: tests depend on VS Code's DOM structure (workbench selectors, overlay webview iframes) and on log text of the Desk output channel for some assertions; a full run takes minutes and a VSIX build; one run at a time per machine.

## Related Documents

- `scripts/test-vscode.ps1`, `CONTRIBUTING.md` (End-to-end tests)
- [ADR-0056](0056-publish-window-state-in-a-leased-registry-and-switch-windows-by-request.md), [ADR-0063](0063-read-the-context-breakdown-from-omps-own-context-report-and-files-from-the-system-prompt.md)

## Architecture Review

- Reviewer: architect
- Outcome: pending
- Notes: not yet reviewed.
