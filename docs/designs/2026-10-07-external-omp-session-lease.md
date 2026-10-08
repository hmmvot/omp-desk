---
status: accepted
date: 2026-10-07
---

# Detecting a session another OMP process is writing: the "Open in another OMP process" row state

## Problem

A user opens a session in OMP Desk while the same session is still running in a plain terminal `omp`. The extension cannot tell: its claims ([ADR-0034](../decisions/0034-store-sessions-in-one-profile-catalog.md), [ADR-0039](../decisions/0039-refuse-only-on-a-verified-live-writer-the-extension-owns.md)) only describe processes this extension owns, so the row reads "Stopped" and Open launches a second writer. OMP notices on its own, moves the new process's writes to a sibling file and warns "open for writing in another omp process", but the user has already been told nothing and ends up with two diverging conversations.

## Goals and Non-goals

- Goals:
  - A row whose session an `omp` process this window does not run (most likely a terminal) is writing shows its own state, **Open in another OMP process**, with its own icon and a tooltip that says so.
  - Open, a click, a folder's Resume and every other explicit launch that can start a writer ask first, with **Open Anyway** and **Cancel**, and say that OMP will then save to a new sibling file.
  - The check never creates, waits on or keeps anything that could block OMP, and it never flags a writer this extension can verify as its own.
  - Any failure (an unknown derivation, a missing helper, a failed probe) leaves every row exactly as it is today and writes one log line.
- Non-goals:
  - No change to claims, ownership rules, admission, Stop or the refusal policy of ADR-0039. The probe adds an observation and a confirmation; it never refuses.
  - No attempt to stop, signal or identify the outside process, or to name its terminal.
  - No polling and no new refresh trigger: the state is read where ownership is already read.
  - No detection on a session that no process has written yet (see Risks).

## Current State

- `SessionTreeProvider` observes each non-running row through `observeOwnership` (`launcherOwnershipFacts` in `src/extension.ts`), on window focus, view visibility, claim-directory events and clicks, and derives the row state in `sessionItemState`. A holder another window of this extension has is `otherWindow` ([design](2026-10-07-window-folders-and-other-window-state.md)).
- Launching goes through `openTab` / `openTabOnce`, the claim admission in `SessionIndex.restore` and the launcher port.
- Staged helpers (`src/runtime-assets.ts`) are content-addressed copies of packaged files re-verified before every process start; the PowerShell helpers speak `!`-prefixed lines.

## Proposed Design

### What OMP does (verified against installed OMP 18.6.3)

When an OMP process first **writes** a session it takes the session's ownership lease and keeps it until it exits or leaves the session (`tryAcquireSessionLease` in `pi-coding-agent` `src/session/session-storage.ts`). The lease is keyed by the session id in the file header, not by the file path, so every process that reaches the journal meets the same lease. A second process finding the lease taken moves its writes to a sibling file with a new id. On Windows the lease is a named kernel mutex (`pi-utils` `src/file-lock.ts` and the native `FileLock`): the native code creates the mutex without initial ownership and treats `ERROR_ALREADY_EXISTS` as "held by someone else", so **the lease is held exactly while the named object exists**, and the kernel removes it when the last handle closes, including when the holder dies.

The mutex name is `Global\omp-file-lock-` plus 32 hex digits. The digits and their input are given in [ADR-0046](../decisions/0046-probe-omp-session-lease-for-external-writers.md); the derivation was recovered from the native code and confirmed against 15 name vectors read back from the kernel object directory (including 31/32/33-byte inputs and non-ASCII text) and against a real `omp` process holding a real session.

### The probe

`src/host/omp-session-lease.ts` (VS Code-free) derives the mutex name for a session id and runs the probe.

- `session-lease-probe.ps1` receives names on stdin and opens each with `Mutex.TryOpenExisting(name, Synchronize)`, closes the handle at once, and prints `!LEASE held|absent|error <name>` then `!DONE <n>`. It refuses any name that is not exactly `Global\omp-file-lock-` plus 32 lower-case hex digits. It never creates, waits on or owns a mutex, so it cannot make an OMP process fail to take or keep its lease for longer than the handle exists.
- `ExternalLeaseObserver` answers "does a live OMP hold this session file's lease?" for many rows with one helper run: the first request that finds no fresh verdict probes the catalog's session files (at most 200 names per run; header ids are read on every pass) and the others reuse that answer for 2 s. A request marked `fresh` is answered only by a probe that started after the call; opens and clicks use it, and wait for one helper run, bounded at 5 s.
- The helper is staged on its own (not with the host entries) so a missing or changed copy only turns the probe off. It is re-verified by digest immediately before each run.

### Row state and priority

`launcherOwnershipFacts` adds one fact, `externalOmp`, asked only when nothing this extension owns can be the holder: it is false when another window's live claim exists (that row is **Open in another window** and wins), when this window holds a live claim, and when a verified writer under one of this extension's brokers exists, because their `omp` children hold leases too. A row this window runs is never observed. `sessionItemState` returns `externalOmp` after `stopping`, `otherWindow`, `starting` and `restoring`, and before `checking`/`running`/`stopped`, and requires no verified owned writer.

The state is not forgettable and not deletable, offers **Open in Chat** and **Open in Terminal** (which ask), and hides Rename. Add to Session can still pick it; it asks like Open, and Cancel adds nothing.

### Confirmation

- A click or Open on a row *displayed* as `externalOmp` re-probes with `fresh` first. If the terminal has gone, the ordinary path runs. If it still holds the lease, a modal says: "This session is open in another OMP process." with the detail that OMP will save this window's turns to a new sibling file instead of mixing them into the one the other process writes. **Open Anyway** launches (`resumed`, even from a click: it is the user's explicit launch); Cancel does nothing.
- Every explicit attempt that can start a writer (`openTabOnce`, intent `explicit`, no runtime here, and verb `resumed` or a row whose run intent is not stopped) probes `fresh` before it opens an editor or starts anything and asks the same question, so the mode-specific Open, a folder's Resume, Resume from Chat and Add to Session cannot start a second writer unasked even from a stale row. A history view of a stopped row starts no writer and never asks. A restored editor and the activation pass's automatic relaunch do not consult the lease (a known limitation: OMP moves such a writer to a sibling file; silent declining needs an index-level port under ADR-0039's automatic gate). An unknown answer (no probe, failed probe, unreadable header) never asks.

### Failure behavior

| Situation | Result |
| --- | --- |
| Derivation no longer matches OMP's | The object is never found: "absent", i.e. today's behavior. |
| Helper missing, changed, blocked, timed out (5 s) or malformed output | Probe returns unknown; rows keep today's state; a log line when a pass fails. |
| Session id OMP would hash (not `[A-Za-z0-9_-]{1,128}`) | Unknown; OMP ids are UUIDs, so this does not occur for sessions OMP wrote. |
| `PI_CONFIG_DIR` set in the user's shell but not the extension host's environment, or only in OMP's own `.env` | Names differ: "absent". |
| Probe handle open while the holder exits | The object lives for those microseconds; an OMP that tries the lease in that window sees it taken and moves to a needless sibling file (negligible probability, no data loss). |
| OMP running elevated | Access denied is answered only for an existing object: "held". |

## Alternatives

- **Read the other process's session file for a recent write.** Heuristic: an idle terminal holds the lease with no recent write, and a finished one leaves a recent timestamp.
- **Try to acquire the lease (the native lock) and release it.** Exact, but it takes the lease: an OMP starting to write in that moment loses it and moves to a sibling file. Rejected as a probe that can interfere.
- **Enumerate processes and their command lines.** Cannot tell a process that writes this session from one that merely runs `omp`, and the command line may not name the session.
- **Load OMP's native module in the extension.** Couples the extension to a 190 MB addon and the lock's acquiring API; no read-only entry point exists.
- **Ask only at launch, add no row state.** Cheaper, but the row would keep saying Stopped while a terminal writes it, and the user would learn only at the dialog.

## Risks and Open Questions

- **An undocumented detail.** The name derivation is an implementation detail of OMP's native lock, introduced as an id-keyed lease on 2026-10-03 (OMP 18.5.0; its changelog replaces a path-keyed lease path by `tryAcquireSessionLease`). It was verified against 18.6.3 only. A future change makes the probe silently report "absent" (today's behavior); the recorded vectors are constants, so re-verification is manual on each OMP update. OMP 18.0.4 was observed to hold no such mutex after a write, consistent with the lease being newer.
- **No lease before the first write.** OMP takes the lease on a *write*. A terminal `omp` that resumed a session and has not yet appended anything holds none, so it is not detected, and the first write of whichever process comes second still lands in a sibling file. The row appears once that terminal has written (any message, bash command or model change).
- **Probe window.** The brief handle makes the lease look held for the instant it is open; the only effect is described in the table above.
- **Own children.** The exclusions rely on claims and the broker witness. A child of this extension that neither can verify (a survivor of a dead broker, a writer of a reloaded window, unreadable claim storage) is shown as an outside process, and so is a copied session file with the same id; Open Anyway proceeds as today.
- **`omp gc` and other lease probes** briefly hold a lease name themselves. A row may show the state for that moment; the next observation clears it.

## Rollout and Verification

Implemented in one change: the probe module and helper, the row state, the confirmations, menus and documentation. Verified by unit tests (name derivation against recorded OMP vectors, report parsing, observer batching/freshness/failure, row-state derivation and priority), lifecycle tests (Cancel/Open Anyway, no ask on a history view, a rival window's claim winning, a click on an external row), an integration test that holds a real named mutex with the derived name in a child process and checks the production helper sees it and then sees it gone, and an isolated-window run on Windows with OMP 18.6.3: a throwaway session was written by a plain terminal `omp` in a temporary folder and its row read "Open in another OMP process" with the explanatory tooltip; a click showed the modal with **Open Anyway** and **Cancel**; Cancel started nothing and kept the row; **Open Anyway** opened the session and OMP started its writer; after the terminal `omp` was stopped the lease object was gone and the next view refresh showed the row as Stopped.

## Related Decisions

- [ADR-0046](../decisions/0046-probe-omp-session-lease-for-external-writers.md)
- [ADR-0039](../decisions/0039-refuse-only-on-a-verified-live-writer-the-extension-owns.md), [ADR-0045](../decisions/0045-derive-window-folders-per-window-and-pin-with-identity-ids.md), [ADR-0012](../decisions/0012-run-child-process-entries-from-staged-copies.md)

## Architecture Review

- Reviewer: architect
- Outcome: accepted with changes (see the Architecture Review of [ADR-0046](../decisions/0046-probe-omp-session-lease-for-external-writers.md))
- Notes: the confirmation predicate, wording, Add to Session cancel, probe bound, interference and drift statements and failure table were corrected; the restore and automatic-relaunch gap is recorded as a known limitation.
