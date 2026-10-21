---
status: proposed
date: 2026-10-21
---

# A restart returns a running session to its home window

## Problem

A session moves between windows: a window that adopted it, a window that opened it first, or a **Move to This Window** ([ADR-0080](../decisions/0080-hand-over-a-live-session-through-a-taken-up-request-that-detaches-the-holder-without-stopping-it.md)). The window that gave it up keeps an editor for the session (a read-only history, by design). At the next VS Code start every window that VS Code restores an editor for the session puts it into its **recovery cohort** (`localRecoveryCohort`, `src/extension.ts`: a live host here, or a local editor for the tab), races for the claim, and the winner elects its editor the controlling one. So a session the user moved to window B can come back in window A after a full restart, depending on which of four windows starting at once reaches the claim first. The placement follows leftover editors, not the user's last choice. [INFERENCE: the race outcome was not observed in the logs; the code path is.]

Related facts, verified in the code:

- A row whose run intent is `running` and that no window has an editor for is *inert* at startup: it is never relaunched. Yet the end of an OMP process that nobody asked for says "The session restarts the next time VS Code starts" (`exitOutcome`, `src/runtime/local-exit.ts`). The promise holds only when some window restores an editor for the row.
- A restored editor that was not in the cohort when the pass started is opened by its own serializer path (`openRestoredTabIfUncovered`, `src/wiring/window-routing.ts` → `openTab(..., "opened", "restored")` → `SessionIndex.restore`), which relaunches a `running` row whose owner is absent, or attaches a surviving host, exactly as an explicit click does. Leaving the cohort therefore does not by itself stop a window from taking the session: every user of the cohort test must change.
- A click on a session row that another window holds does not open it here: it switches to the holder (`heldByAnotherWindow` → `switchToSessionWindow`, ADR-0056). Only **Move to This Window** takes it.

## Goals and Non-goals

- Goals: after a full VS Code restart a running session returns to the window that last ran it (its **home**) and is not taken by another window's leftover editor; that editor shows the saved history read-only; the exit message says what is true.
- Non-goals: choosing a window for a session no window ran (a row with no home keeps today's behaviour); changing what an explicit click, Resume, Open or Move does; relaunch of rows nobody restores an editor for (still inert); any new request kind, registry field or claim field; telling two windows that show the same folder apart (see Risks).

## Current State

- The catalog row has no record of which window ran the session. The claim carries the holder's `windowUri` (`SessionClaimRecord.windowUri`, display and navigation only), but a claim does not survive a restart.
- Cohort: `inLocalRecoveryCohort(index, tabId) = index.hasLiveHost(tabId) || hasLocalEditorFor(tabId)`, used by `localRecoveryCohort` (the pass), by the `restoring` fact of the launcher rows while the pass is pending, and by the `ownedHere` test of `sweepGoneRecords`. The pass restores the cohort, then elects every cohort editor controlling (`electLocalController`).
- Non-cohort restored editor: `openRestoredTabIfUncovered` → `openTab(..., "restored")`.
- A Move leaves the old holder's editor read-only (`SessionRuntime.detach`, ADR-0080).

## Proposed Design

**Home.** A new optional field on the shared session row, `home: string | null`: the window URI (`file:` folder or saved workspace, the value `owningWindowUri()` returns and the claim's `windowUri` carries) of the window that last became the session's driver. It is written in the same persist as the host record at **every** place a window becomes the driver of a row:

1. the launch of a new host and the attach of a surviving host (both in `SessionIndex.#openEntry`, each next to its `#dropReleaseProof` call),
2. the re-attach of a verified live draft (`#reattachDraft`, called from `#openEntry`, and the adoption path next to its own `#dropReleaseProof`),
3. the native conversation transfer (`transferNativeHost`), which makes this window the driver of the `to` row, whatever home that row had.

`replaceHost` (a successor transport in the same editor) drives the same row in the same window and leaves it as it is. The value is read from the window at write time (a `windowUri()` provider passed to `SessionIndex`, wired to `owningWindowUri()`), not from `claimHolder.windowUri`, which is frozen at activation; the startup comparison uses the same function. A window with no URI (an unsaved multi-root window, an empty window) writes `null`, which means "no preference". A stop, a close and a crash never clear it: it is where the session lives until another window drives it.

**Merge.** `home` is the fourth field of the run state that `settleRunState` settles ([ADR-0034](../decisions/0034-store-sessions-in-one-profile-catalog.md), amended): it keeps the committed value unless this window changed it relative to the value it last saw; the rule for a write that records a new attempt carries its own (the write that records the attempt is the write that sets `home`); and the other early return of `settleRunState`, a write that only clears the host of a run while another window committed a newer attempt, takes the committed `home` with the rest of the committed run state (without it a dying window's close would carry its own home back over the attaching window's). Without any of this a stale window's unrelated write (a title, a reply marker) would carry an older `home` back and undo a Move. No catalog version moves; the field is optional, `cloneSharedEntry` writes it and a row without it reads as `null`; a value this build cannot read is read as `null`, never a reason to discard the snapshot. A build that does not know the field drops it when it rewrites the row, which falls back to today's behaviour (no home) until a build that knows it launches or attaches again.

**Cohort and restored editors.** A window is *home* for a row when the row's `home` is `null`, or the identity of `home` (`windowUriIdentity`) equals the identity of the window's URI. The test lives in `inLocalRecoveryCohort`, so its three users move together: the cohort, the `restoring` fact while the pass is pending, and `sweepGoneRecords`' `ownedHere` (a non-home row is swept as not owned here, which is safe: a live home claim makes the sweep step back, and a stale host of an inert row is what the sweep is for). A row is in this window's cohort when `index.hasLiveHost(tabId)` (this window already runs it), or the row's run intent is not `running` (a stopped or draft row restores as history; nothing is launched), or this window has a local editor for it **and is home** for it. The same test governs the second path:

- `openRestoredTabIfUncovered` does not open a restored editor of a `running` row for which the window is not home (the `hasLiveHost` branch stays first). It shows the saved history read-only (`conversations.showViewOnly`, the call the restore pass already uses) with one fixed sentence that does not claim more than is known: "This session belongs to another window. Use Sessions to switch to it, or Move to This Window." It takes no claim and no controlling election.
- The Sessions row and every other reader of the row are unchanged: they read claims and the broker, not `home`.
- A click on the Sessions row is unchanged: it switches to a live holder; **Move to This Window** is the one act that takes a live session. A click that opens the session in this window (no live holder, the window is where the open is placed, ADR-0057) is a launch or an attach and so makes this window the new home.

**Trade-off, stated.** Today a crashed `running` row is relaunched in whichever restored window has an editor for it. After this change it is relaunched only by its home window: when the home window is not restored at the next start (or its own relaunch fails), nobody relaunches the session until the user opens it. That is the price of "the session stays where the user put it"; the user approved it as the behaviour asked for ("restores view-only until the user clicks"). The exit text is the mitigation.

**What an exit says.** `exitOutcome` for an end nobody asked for says: "The OMP process ended unexpectedly (...). The session restarts when its window's editor is restored at the next VS Code start; Resume starts it now." The unconditional promise of relaunch is also in the exit's log line (`the run intent stays as recorded, so the next startup relaunches the row`), in the comments of `SessionIndex.recordKillIntent` and `session-kill.ts`, in `docs/architecture.md` and in the amendments of 2026-10-21 to ADR-0034 and ADR-0060; each is reworded "relaunches when its home window is restored" as part of the implementation (Rollout item 3).

## Alternatives

- **Keep the race, reword the exit message only.** Honest, but a moved session still comes back in whichever window wins the claim.
- **Home as an explicit user setting ("always open this session in this window").** More control, a new surface; the last driver is what the user did.
- **Record the home in the host record** (it is rewritten on every launch and attach). It is cleared with the host at every stop and crash, which is exactly when a restart has to know it.
- **Route the restore through the registry** (ask the home window to restore it). Registry records do not survive a restart, and requests are advisory (ADR-0056).
- **Elect the home window by folder** (the window that has the session's folder open). A Move deliberately places the session in a window that may not have its folder open; and ADR-0057 already places *launches* by folder, which stays.
- **Key home by holder id.** Holder ids do not survive a restart.

## Risks and Open Questions

- Home is a URI, not a window. Two windows that show the same folder or workspace have one identity (`windowUriIdentity`, the same case VS Code itself cannot tell apart: `planWindowFocus`'s ambiguous plan), so both are home and the claim race still decides between them. `windowUriIdentity` also lowercases the path, so on a case-sensitive file system two folders that differ only in case would share an identity; both limits are accepted and stated, and neither makes a non-home window home.
- A window whose URI changes (the user opens another folder in it, saves its workspace) is no longer the home: its editor restores read-only until the user acts. The row records the URI the window had when it became the driver.
- A moved session whose home window is not restored stays inert until the user opens it (the trade-off above).
- A mixed-build profile: an older window that rewrites the row drops `home`; the next launch or attach by a new build writes it again. An older window ignores the field and restores by today's race.

## Rollout and Verification

1. `SessionIndex`: the field, its lenient read, its clone, the `windowUri` provider, the writes at the sites above, the `settleRunState` rule (the generic block and both early returns); tests in `session-index.test.ts` (written with the host, kept across a stop and a crash, written by a native transfer, merged: a stale window's unrelated write does not revert it, a dying window's close does not carry its home over a newer attempt's).
2. Cohort and restored editors: a pure `homeAllows(entry, windowUri)` used by `inLocalRecoveryCohort` and `openRestoredTabIfUncovered`; tests with two windows' identities, a null home, a stopped row, a row this window already runs.
3. Texts: `exitOutcome` and its log line and tests, the comments of `recordKillIntent` and `session-kill.ts`, `docs/architecture.md`, the ADR-0034 and ADR-0060 amendment texts, CHANGELOG.
4. Focused tests and `tsc` only; no live-window verification.

## Related Decisions

- [ADR-0080](../decisions/0080-hand-over-a-live-session-through-a-taken-up-request-that-detaches-the-holder-without-stopping-it.md) (amended: the home), [ADR-0034](../decisions/0034-store-sessions-in-one-profile-catalog.md) (amended: the field, its merge rule; the cohort), [ADR-0031](../decisions/0031-reattach-a-surviving-managed-host-through-its-broker.md) (a surviving host is re-adopted at startup by its home window), [ADR-0057](../decisions/0057-start-a-session-in-the-window-that-suits-its-folder.md) (launch placement unchanged; restart placement follows the home), [ADR-0039](../decisions/0039-refuse-only-on-a-verified-live-writer-the-extension-owns.md) (unchanged: a home never admits or refuses a launch, ownership stays with claims and process generation).

## Architecture Review

- Reviewer: architect
- Outcome: accepted after three independent review passes
- Notes: round 1 (independent `reviewer`): incorrect as first written; corrections applied. Round 2: required text changes (the exit texts are future work and listed, `settleRunState`'s early return carries the committed home, the home test lives in `inLocalRecoveryCohort` so its three users move together, anchors and click wording); applied. Round 3: one required text change (the new-attempt rule of `settleRunState` carries its own home, in ADR-0080's wording), applied; no further defect found. The implementation is not part of this record.
