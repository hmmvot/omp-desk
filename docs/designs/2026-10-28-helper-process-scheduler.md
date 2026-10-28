---
status: accepted
date: 2026-10-28
---

# Helper processes are scheduled: bounded per window, deferred until the restore is over and spread across windows

## Problem

After a window reload every window of the profile restores its Chat tabs at the same moment, and each restored tab asks for the facts a Chat shows beside the conversation the moment it goes live: its provider's quota (`omp usage --json --redact --provider …`), whether the default profile has any model (`omp models --json`), and, when the page needs them, settings reads (`omp config get/list`), the served-model check and the inventory worker. Each is a short-lived process that loads OMP's whole package. The 109 s start analysed on 2026-10-23 (commit `cb63ec7`) found a batch of about two dozen of them started by the reloading windows at once, on a machine already busy restoring; the retained logs of a later reload show the default-profile read running out of its 15 s limit (`Default-profile models could not be read; retaining the last availability.`) about 15 s after the window started. None of them is needed for the first visible state.

The multiplication was larger than the number of facts: `recordSessionModels` asked for a default-profile catalogue read for **every tab's first look at its own models**, and a request that arrived while a read ran asked for one more read afterwards, so a window with N tabs going live one after another could run up to N catalogue reads. The usage read is per tab and per scope (OMP executable, profile, folder), so tabs of different folders do not share it.

## Goals and Non-goals

- Goals: no helper process that the first view does not need starts while the window is still restoring; the helpers a window runs at once are bounded; the windows of one reload do not all start theirs together; a read that was only asked for as a hint is not repeated; every helper is counted and timed in the log; the window's closing cancels queued helpers and ends running ones.
- Non-goals: the processes of the restore itself (`rpc-launch`, the launcher capability probe, the PTY runtime proof and everything in the restore pipe), which other work owns; Stats, provider login, the settings editors and everything the user clicks (these are explicit actions and keep starting at once); making any helper faster; sharing a helper's result between windows (below).

## Current State

Every call site ran `runOmpCli` or `runSettingsWorker` directly. Window-level guards existed only per call site: `resolvingExecutable` shares one resolution of the OMP binary, `ProviderUsageCache` shares one usage read per scope and provider with a five-minute throttle, and the inventory controller runs one worker per folder and profile at a time. After a reload a re-adopted host carries no `binary` (`RpcHostRuntime.binary` is `null` for an adopted one), so a footer refresh resolves the executable again; for a Bun-shim install that resolution starts no process (the release comes from the package manifest), for a standalone `omp.exe` it is an `omp --version` run.

`WindowState.startupRestoreOver` already exists for exactly this kind of work: it settles when the window's startup restore pass is over, or after 120 s, and the Sessions view's ownership observations, the Processes poll and the lease probe wait for it.

## Proposed Design

`HelperScheduler` (`src/host/helper-scheduler.ts`, no `vscode` import), one per window, created at activation and disposed with it. The helper runs listed under "Call sites" go through `run(job)`:

- **Classes.** `visible` work serves something on screen now: the provider usage of the active tab or of any Chat panel that is visible (and any forced refresh), a settings question a Chat page asked, the served-model verdicts a page asked, every inventory read and switch. It is held back by nothing but the window's concurrency bound and goes before background work. `background` work is the rest: the usage of tabs with no visible panel, the default-profile catalogue read, the version probes of other OMP installs. It starts only after the gate (`startupRestoreOver`) plus a 2 s settle delay, so work the restore itself queued goes first.
- **Bounds per window.** At most 2 helpers run at once and at most 1 of them is background work, so visible work always has headroom. Order is visible first, then background, each first-in first-out.
- **Spread across windows.** A background run takes one of two cross-window slots before it starts (`src/host/helper-slots.ts`). The slots are the PTY slot lock that Stats' launch already uses (`acquirePtySlotLock`: a file created exclusively under the PTY state directory, owned by a process id, taken over when that process is gone), named `omp-helper:0` and `omp-helper:1`; a taker tries them in random order and polls every 400–800 ms. A run waits at most 30 s for a slot and then runs anyway; a slot that cannot be created at all is no wait. The slot is a throttle, not a lock anything depends on, and is released when the helper ends.
- **Sharing inside the window.** Work with a `key` that is queued or running returns the first caller's promise. A queued background job that a visible caller asks for is promoted to `visible`, by a second `run` with the same key or by `promote(key)` (the usage read calls it when its tab is in front, because the usage cache joins a pending read without calling the scheduler again). The keys are the usage scope and provider, and `models:default`.
- **Cancellation.** `dispose` rejects queued work with `HelperCancelledError`, aborts what runs (the job's `AbortSignal`; `runOmpCli` and `runSettingsWorker` end their process on it), frees every caller at once, and starts nothing afterwards. A cancellation is not counted as a failed helper.
- **Not repeated as a hint.** `refreshDefaultProviderModels` has two reasons. `credentials` (a sign-in, a sign-out, the login terminal's close, another window's announcement, a session whose models changed) marks the read dirty as before, so a read already running is repeated once. `discovery` (activation, a session's first look at its models when the catalogue was never read) joins a read that is queued or running. A session's first look is no change: it asks only while this window has never read the catalogue.
- **Log.** Every helper whose run ends writes a debug line (class, wait, wait for a slot, run time; a failed run adds the kind of its error, never its message); a helper cancelled before its run started writes none. When the window's helpers drain after the gate opened, one info line sums up: count started by class, the peak of runs in progress at once (a run waiting for its slot is not counted), offsets of the first and last start from activation, the longest wait and how much of the waits was for a slot.

Call sites: `refreshFooterMetadata` (usage), `refreshDefaultProviderModels`, the `readTodoClearDelay` and `readMagicKeywords` reads (through `visibleOmpCli`), `servedModelVerdicts`, the inventory runtime, and `reportOtherInstalls` in `native-terminal.ts` through `setOmpBackgroundRunner`. `runOmpCli` takes an optional `signal`.

**What is not shared between windows, and why.** A result could be shared only when it is the same for every window and safe to put on disk. `omp usage` runs OMP's extension discovery in the folder (the command has `-e` and `--no-extensions` flags), so two folders can give different reports, and a report holds account labels this extension keeps out of files. The catalogue availability is a bare boolean, but it is read in the first workspace folder with the default profile's project layer, and a stale boolean decides whether the sign-in prompt shows. Neither is worth a shared file; the slots bound the load without sharing.

## Alternatives

- **Only a fixed delay after activation.** The restore's length varies from seconds to the 120 s cap; a fixed delay is either too short for the slow case that hurts or a long wait for the fast one. The gate is the restore itself.
- **A global queue in one window that serves the others.** Needs a new inter-window request protocol and a failure story for the serving window. The slot files are an existing mechanism with a stale-holder rule.
- **Lazy usage: read a tab's quota only when it is shown.** A real saving, but a behaviour change (a hidden tab's footer would be empty until shown, and there is no tab-activation refresh today); left to the owner of that behaviour.
- **Share the usage cache across folders.** Rejected above: extension discovery is folder-scoped.
- **A semaphore with more slots, or none.** Two slots keeps the whole machine at two background helpers however many windows reload; a visible run is never behind them.

## Risks and Open Questions

- A background fact is later: the sign-in prompt for a profile with no models, and the quota of a tab that is not in front (no visible panel), appear after the restore plus the settle delay (and, under a busy machine, the slot wait). The cap on the gate is the existing 120 s. A tab that becomes visible later is not read again by this change (there is no refresh on tab activation); its quota arrives with the background read.
- A cross-window slot is a file; the PTY lock takes a dead holder's lock over only when no live process has that process id (it records no creation time), and Windows reuses process ids, so a lock left by a window that died can keep a slot busy until its id is free again. The wait is bounded at 30 s plus one poll, and with both slots in that state every background helper of every window pays it, one at a time per window: facts arrive late, never lost. The PTY lock also replaces a lock file it cannot read, so two windows may very rarely hold one slot: one more helper runs. Recording a creation time in the lock would close the first gap and is left to the owner of that lock.
- Visible work is bounded by the same 2 at once; a slow visible run (the usage read has a 20 s limit) can hold a place. The page-driven reads each have their own limits.
- Promotion reaches a queued background job only; one that has been admitted (running, or waiting for its slot) is not moved. The usage read promotes by key when the footer asks for a tab that is in front, and `ProviderUsageCache` joins the read that is already pending instead of starting another.
- Executable resolution is not scheduled: a window re-adopting hosts resolves the OMP binary through `resolveOmpBinary`, which for a standalone `omp.exe` runs `omp --version` (for a Bun-shim install it reads the release from the package and starts nothing), shared only while one resolution is in flight. It is the probe a launch pays as well, so it is not delayed here; it is not in the counts of the model or in the log line. The restore-time helpers that the launch path starts (the launcher capability probe, executable resolution inside `rpc-launch`) are outside this change.
- A window closing while an inventory switch runs surfaces the worker's interruption sentence as a notice in a window that is going away; nothing else logs a cancellation.
- Measured so far only in a model (below); the real-window numbers are for the first build that carries this change.

## Rollout and Verification

One commit: the scheduler, the slots, the call sites, `runOmpCli`'s signal, tests, architecture and ADR text, changelog. Tests: `helper-scheduler.test.ts` (bounded concurrency, visible before background, deferral behind the gate and settle delay, sharing and promotion, cancellation on dispose including a run waiting for a slot, slots held and released, fail-open), `helper-slots.test.ts` (real lock files: two windows, stale holder, wait, abort, unusable directory), `helper-startup.test.ts` (a four-window reload with six tabs each on a virtual clock, before against after), and the lifecycle test's catalogue case. The model in `helper-startup.test.ts` gives, for 4 windows × 6 tabs: before, 36 helpers with a peak of 20 at once and every start within 0.8 virtual seconds of the first tab going live; after, 28 helpers with a peak of 4 at once, none of the background ones before its window's restore ended. Those are model numbers.

The installed check (not run here): reload with several windows and Chat tabs at the Desk log level Debug; the info line `helper runs: … started since activation …` per window and the `helper run:` debug lines give the real count and timeline; compare the first start of a background helper with the `startup restore timeline` line of the same window.

## Related Decisions

[ADR-0084](../decisions/0084-run-helper-processes-through-one-per-window-scheduler-with-cross-window-slots.md); the start analysis in [A Chat start does not wait for the full PTY runtime proof](2026-10-23-chat-start-does-not-wait-for-the-full-pty-proof.md), whose non-goals named these helpers; [Stats dashboard](2026-10-08-stats-dashboard.md) for the PTY slot lock's other user.

## Architecture Review

- Reviewer: `reviewer` agent (independent, read-only, one pass; it read the implementation as well as the text)
- Outcome: accept with changes; the changes are applied below. No material finding.
- Notes: two should-fix items (a queued background usage read was not promoted when its tab came to the front, because the usage cache joins a pending read without calling the scheduler: `promote(key)` added and called; a visible Chat panel that is not the active one was classified as background: the class now follows panel visibility as well as the active tab) and four nits (failed runs were not written to the log and the peak counted runs waiting for a slot: both fixed; executable resolution's `omp --version` and the stale-lock process-id reuse were not named: both added to Risks; a cancellation was logged as a failure at the call sites: quiet now, except for an inventory switch's notice in a closing window, named in Risks). No confirmation pass was run for these fixes; they narrow the text to what the code does and add the promote call.
