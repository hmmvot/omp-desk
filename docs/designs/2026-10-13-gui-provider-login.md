---
status: accepted
date: 2026-10-13
---

# Log in to and out of a model provider from VS Code, without a terminal

Decision record: [ADR-0070](../decisions/0070-log-in-through-a-dedicated-short-lived-rpc-process-and-keep-the-terminal-login-as-the-explicit-fallback.md).

## Problem

Today **Log In to Provider** (`ompDesk.loginProvider`, the no-model Sessions row, Chat's model-picker item, the no-model footer button) opens a visible `omp login` terminal and reads nothing from it. The user must pick a provider by number in a readline prompt, copy a URL out of terminal output, and paste a code back into the terminal. VS Code can do all of this with its own UI: a pick list, the system browser, a masked input box and a progress notification with Cancel. There is also no way to remove a stored credential from VS Code.

## Goals and Non-goals

Goals:

- A QuickPick of the providers OMP lists (check mark on the ones with a credential, only the ones OMP marks `available`), a progress notification with Cancel while the sign-in runs, the sign-in address opened with `vscode.env.openExternal`, a pasted authorization code or redirect URL read through an `InputBox` with `password: true`, and the model catalogues re-read afterwards.
- Log out: provider, then stored account, then a modal confirmation.
- Every existing entry point keeps working with the scope it has today (the session's profile, cwd and executable; the default profile; a profile question when indexed sessions use other profiles).
- The pasted code, the sign-in address and every string OMP produces stay out of logs, diagnostics, storage and notices (ADR-0017).

Non-goals:

- **API keys.** The user decided keys are entered in terminal OMP. The GUI says so in one line (`API-key providers: run \`omp\` in a terminal and use /login`) and never asks for a key.
- MCP OAuth, Collab, or any change to Chat's own RPC session.
- Refreshing other VS Code windows (see Risks).

## Current State (verified against installed OMP 18.10.3)

- `get_login_providers` returns `{providers:[{id,name,available,authenticated}]}`; the scratch-profile run lists **83** providers, all `available`, none `authenticated`.
- `login {providerId}` (`modes/rpc/rpc-mode.ts` `case "login"`) emits `extension_ui_request` frames: `open_url` (`url`, `launchUrl`, `instructions`), `notify` progress, and `input` (the prompt text in `title`, 600 s). A `secret` prompt, or any prompt before the address, fails the request with "…not supported in RPC mode". On success it refreshes the provider's models.
- `login` is **not** in `BACKGROUND_COMMANDS` (`rpc-mode.ts`), so it runs on the serial command queue; and the call passes **no abort signal** to `authStorage.oauth.login`. An unanswered pasted-code prompt that returns an empty string is asked again (`callback-server.ts` `#waitForCallback`), until the 300 s callback timeout.
- `omp --mode rpc` with no usable model exits at startup ("No default model selected", `main.ts`); with `--model <selector>` it starts without credentials.
- `get_logout_accounts {providerId}` returns `{accounts:[{credentialId,provider,label,detail,type,active}]}`; `logout {providerId,credentialId}` returns `{remainingSource?}`.
- OMP's own TUI `/login` and `omp login [provider]` take API keys; the TUI's `/login` is the command to name.
- Real 18.10.3 runs (scratch `PI_CODING_AGENT_DIR`; the 83 providers were each logged in once, up to the first events, and cancelled):

  | Shape | Providers (examples) | Frames |
  |---|---|---|
  | Browser OAuth with a pasted-code fallback | 10: anthropic, openai-codex, openrouter, google-gemini-cli, google-antigravity, gitlab-duo, devin, zai-coding-plan | `open_url`, `notify` ("Waiting for browser authentication…"), `input` ("Paste the authorization code (or full redirect URL):") |
  | Browser or device sign-in, nothing to paste 7: cursor, kilo, kimi-code, xai-oauth, openai-codex-device, factory-droid, muse-code (observed up to the first events; `notify` may precede `open_url`) | `open_url`, `notify` |
  | **API key or token** (60 of 83) | deepseek, kagi, exa, litellm, ollama, huggingface, cloudflare-ai-gateway, xiaomi… | `open_url` (a dashboard page) and, **in the same tick**, `input` ("Paste your X API key"). The prompt is not marked secret, so OMP's RPC does **not** refuse it |
  | Refused (6) | alibaba-coding-plan, alibaba-token-plan, github-copilot, lm-studio, perplexity, snowflake | the `login` response fails with the "not supported in RPC mode" sentence |

## Proposed Design

### Which OMP process

A **dedicated, short-lived `omp --mode rpc` process** per login or logout, never a Chat's own session (alternatives in the ADR). It is spawned through the same executable resolution the terminal path used (`runtime.binary`, else `resolveOmpBinary()`), in the session's cwd with `OMP_PROFILE` set exactly as `ompCliScopeEnvironment` does, with `--no-session --no-ui --no-skills --no-rules --no-lsp --no-tools --no-title` and `--model <selector>` (`gpt`, then `claude`, then `gemini`, each tried only when the process ended before `ready`). Extension discovery stays on so extension-registered OAuth providers are listed, as `omp login` does. It talks JSONL over stdio pipes; stdin EOF or `kill()` ends it (verified for the resolved `bun.exe <entry>` process: none remained after a cancel; the `omp.exe` shim is never spawned), so a window that closes, a Cancel and a finished flow all end the process: an idle process by closing its stdin (OMP disposes its session and MCP connections, then exits; killed after 5 s), a login waiting on the user or the browser by killing it, because OMP has no abort and does not exit on end of input while one runs. The guard is released after the exit.

### Profile selection

Unchanged: an entry that has a session scope (Chat's model picker, its footer, a bridge `provider-login`) uses that session's profile, cwd and executable. The palette uses the active session's, else the default profile, else asks when indexed sessions use other profiles.

### Flow (`src/host/provider-login-flow.ts`, over a `LoginUi` port)

1. Progress "Starting OMP…" (Cancel ends the start), then `get_login_providers`.
2. QuickPick: the `available` providers in OMP's order, `$(check)` for `authenticated`, then a last item **Other providers** whose description is the API-key line; picking it opens the explicit terminal fallback (`omp login`). The placeholder repeats the API-key line.
3. `login`. Progress "Signing in to X" with Cancel. The sign-in address is validated with `webLinkUrl` (http(s) only, else the login ends and nothing is opened) and opened with `env.openExternal(Uri.parse(url, true))`: **`url`**, not `launchUrl`, as the terminal CLI does (`launchUrl` is a loopback shortcut for clipped terminals). If OMP then asks for a pasted authorization code or redirect URL (matched by those words) the masked InputBox appears and its answer goes to OMP's stdin; the box closes by itself when the login settles first (the loopback callback won).
4. **API-key providers are recognised when they ask for the key**: any `input` prompt that is not a pasted authorization code ends the login before anything is typed, and the notice names the terminal and offers **Open Terminal Login**. Because OMP sends the address first and the key prompt in the same tick, the address is held for a 400 ms settle window (or until a pasted-code prompt arrives), so an API-key provider's dashboard page is never opened for nothing.
5. Success: notice, `credentialsChanged()` (the window re-reads default-profile and every session's models, as a closed login terminal did). Cancel, a dismissed prompt or a closing window ends the process, resolves *cancelled* and reports no failure. Refusal and any other failure show a fixed sentence (OMP's own error text is classified and never forwarded) with a terminal action.
6. Logout: providers with `authenticated`, `get_logout_accounts`, an account list, a modal "Log out of X?" naming the account, `logout`, `credentialsChanged()`. A provider with no stored credential (environment or configuration) explains where it is removed.

### Entry points and guard

`ompDesk.loginProvider` (palette, Sessions overflow menu, no-model Sessions row), Chat's model-picker item, the no-model footer button and the bridge's fixed `provider-login` command all call the same `runProviderAuth`; **`ompDesk.logoutProvider`** is new (palette, Sessions overflow menu). One window-local guard (`providerAuthRun`) is reserved before the asynchronous preflight (profile question, executable resolution) and released when the flow and its process have exited; a second request is answered ("A provider login or logout is already running in this window."), and so is one while a fallback login terminal of this window is open. Chat's model picker, its footer and the bridge request start the flow and are answered at once. `ompDesk.loginProvider` resolves with the outcome (`signed-in`, `cancelled`, `terminal`, `failed`, `busy`) and accepts an optional `{ providerId?, profile? }` from a caller that knows its scope: only a profile the extension already knows (the default or an indexed session's) and a provider OMP lists are honoured, the directory is never taken from the caller, and outcomes are `signed-in`, `cancelled`, `terminal`, `declined`, `failed` or `busy`. An outcome notice (decline, refusal, failure) is shown without the flow waiting for it, so the guard and the OMP process are released at once. Closing the window aborts the flow.

### Secret handling (ADR-0017)

- The pasted text exists only as the InputBox result, the `extension_ui_response` line written to the child's stdin and nothing else: not logged, stored, put in a notice, a progress line or a diagnostic.
- `log` receives fixed sentences, provider ids that match OMP's id grammar, the **origin** of the sign-in address (never path or query), and outcome names. stderr is drained and discarded; no frame is kept.
- Account labels (`logout`), prompt and `notify` text and `instructions` OMP sends are shown on screen (bounded, control characters replaced; brackets replaced in the final logout notice) because the user must act on them; none is logged.

## Alternatives

See the ADR: the active Chat's RPC session; a broker-owned `managed-rpc` child; keeping the terminal flow; classifying providers up front.

## Risks and Open Questions

- **The picker lists everything OMP lists** (83 here, 60 of them API-key and 6 refused by the RPC). OMP's RPC does not say which are API-key providers; they are recognised when picked and declined with the terminal pointer. The placeholder and last item say so.
- The classification of a prompt (authorization code vs anything else) and the settle window rest on OMP 18.10.3's observed frame order; a prompt whose wording changes is declined, which fails safe (the terminal path still works). The "not supported in RPC mode" refusal sentence is matched; any other wording is the generic failure with a terminal action.
- `--model` selector: `gpt`, `claude`, `gemini` must resolve in the installed catalogue; if none does, the start fails with a terminal action.
- Other VS Code windows are told through a `models` request on the window-request channel (ADR-0056): after every login or logout that sent its command, and after a closed fallback login terminal, this window re-reads its models and asks each other live window of the profile to re-read its own. A window that does not answer (an older build, a hung host) is logged and picks the credential up at its next availability read.
- Startup costs 2 to 4 s on an empty scratch profile (spawn, extension and MCP discovery) and more with configured MCP servers, shown as "Starting OMP…" progress. **The process starts the MCP servers the profile and the folder configure** (`--no-tools` only empties the tool list; OMP 18.10.3 has no MCP switch); A kill is a process-tree kill (`taskkill /T /F` through the helper Kill already uses), verified with real OMP 18.10.3 against a scratch `.mcp.json` server that spawns a detached grandchild: none survived Cancel; only a descendant an MCP server detached on purpose survives a graceful end (ADR-0070 §1). OMP has no MCP switch in RPC mode. A provider's "signed in" mark also covers a key read from the environment or configuration, which log out then says it cannot remove. Two windows signing in to a provider with a fixed callback port at once fail the second with the generic sentence. The sign-in address opens from `url` strictly; Chat's own link opener uses `launchUrl ?? url`.

## Rollout and Verification

Single cut: new `src/host/provider-login-rpc.ts` (process client), `provider-login-flow.ts` (flows over `LoginUi`), `src/wiring/provider-login-ui.ts` (VS Code port); `extension.ts` replaces the terminal-only login; the terminal is the explicit fallback. Tests: the RPC client against a scripted peer and a real child process; the flows (open_url then input sequence, cancel mid-flow, refusal, API-key decline, secret absent from the log sink, logout); the adapter against an API double; the real extension bundle for scope, guard, preflight failure, window disposal and refresh. Real OMP 18.10.3 against a scratch agent directory: providers listed, an OAuth login started up to `open_url` and cancelled with the process gone, an API-key provider declined without opening the browser, a refused provider, an empty logout. A completed real login was not run (it needs a real account).

## Related Decisions

[ADR-0017](../decisions/0017-never-forward-capability-bearing-error-text.md), [ADR-0011](../decisions/0011-use-installed-omp-without-version-gate.md), [ADR-0038](../decisions/0038-host-chat-over-rpc-ui-on-a-broker-pipe-child.md), [ADR-0052](../decisions/0052-answer-terminal-only-commands-and-restore-the-queue-on-stop.md) (terminal-only builtins typed in Chat stay answered locally).

## Architecture Review

- Reviewer: architect
- Outcome: accepted after fixes; see ADR-0070 Architecture Review.
