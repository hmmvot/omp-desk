---
status: implemented
date: 2026-10-20
---

# Move a live session to this window

## Problem

One window writes a session at a time (ADR-0039): a window that runs a session holds its claim, and every other window sees the row as **open in another window**. Until now the only things a second window could do with such a row were switch to the holder (ADR-0056), stop the process (Stop, graceful) or end it (Kill). Both Stop and Kill end the OMP process and everything it was doing.

That bites after a window is closed. A session whose host outlives its window is adopted, by an ordinary click, into whichever window the user clicked in, including a window that does not have the session's folder open (ADR-0057: a folder open nowhere starts "here"). When the user then reopens the folder's own window, its restore finds the claim held by the other window and the editor shows "This session is open in another window. Continue there." The user wants the session *here*, where its folder is open, and has no way to get it without ending the process: in the incident behind this design a working session was killed to move it.

## Goals and Non-goals

- Goals:
  - An explicit action, **Move to This Window**, that takes a session from the live window that holds it into the window where the user asked, **without stopping the OMP process**, mid-turn included. The process, its broker, its turn, its background jobs and its transcript are untouched; only the window that serves it changes.
  - Offered on a row shown as open in another window (Sessions row menu), on the conflict notice a window shows when its restore or open found the session held elsewhere, and in the Command Palette for the active session.
  - The requester takes the session through the ordinary open path, so the claim and attach proofs of ADR-0031/0039 are exactly the ones that decide; nothing about ownership is taken on trust from a request.
  - Clear outcomes for a holder that is busy, does not answer, runs an older build, or is gone.
- Non-goals:
  - No automatic move, and no move at click time: a click keeps switching to the holder window. Nothing moves a session unless the user asks.
  - No change to where a session opens when the holder is gone (ADR-0057 stays).
  - Terminal-mode (native PTY) sessions are not moved: their editor owns a PTY frontend, not an RPC connection. They are refused with a reason.
  - No window-to-window transfer of drafts or editor state.

## Current State

- The claim file (`session-claims`) names the holder window; liveness is the registry lease plus the claim holder's process proof (ADR-0039/0056). `SessionIndex.#openEntry` refuses a live foreign holder with `claim-conflict`.
- The request channel (`window-requests/`, ADR-0056/0057/0060) has kinds `select`, `launch`, `stop`, `reload` and `models`. A `stop` or `reload` is *taken up* (renamed to `.accepted`) before the owner acts, so the requester can tell a window that never saw it from one that is working; a kind an older build does not know is parsed to `null` and deleted without an answer.
- A window can drop its view of a running session without touching the process: `deactivate()` and an editor close do exactly that (connections close, the broker and child, the claim and the recorded host stay). `RpcHandle.disconnect()` clears the broker input owner first. There is no operation that does this for one session of a live window *and* releases its claim.
- The broker's input claim is not taken over (`input-not-owner` leaves an attach read-only), so a window that attaches while the holder still holds the connection comes up read-only.
- The adopter's open path (`openSession` → `SessionIndex.restore`) takes a free claim, reconciles the recorded host to `attachable` and re-adopts the broker with a replay from sequence 0 (pending approvals and host-tool calls are pinned in the broker's ring).

## Proposed Design

### Wire: a `handover` request, taken up

`window-requests/<holder>.<id>.request` with `{ version, kind: "handover", id, to, from, createdAt, tabId, incarnation, binding }`, the same fields and limits as `select`. `to` is the claim holder's id, so only the holder's watcher reads it. It is **taken up** like `stop`: the holder renames it to `.accepted` before it acts, so a requester that withdraws (deletes the file) and the holder cannot both win, and the requester can tell "never seen" (the file vanished with no `.accepted`: an older build deleted a kind it does not know) from "being served". Take-up is per file, so two requests for one session are both taken up and both served, one after the other by the gate (below).

The answer is the ordinary `.response` `{ version, id, ok, focused: false, refusal? }`. `RefusalReason` gains `not-holder`, `busy`, `terminal` and `unfinished` beside `stale-build`; an answer with an unknown reason or a reason on `ok: true` is not an answer. `unfinished` is set only by the holder's own step-3 failure (below). A bare `ok: false` is what the request watch writes when the handler threw, so it means only "that window could not do it" and the requester hedges its sentence.

Timing. The requester's waiter **is the stop waiter's state machine, reused with its classification verbatim** (`not-accepted`, accepted, answered, and the `silent` outcome of a blocked withdrawal or a requester that was not running for the stall gap), with handover constants beside the stop ones: `HANDOVER_REQUEST_TTL_MS` 12 s (how long the file stays actionable before it is taken up), `HANDOVER_ACCEPT_TIMEOUT_MS` 8 s (the requester's wait for take-up, after which it withdraws), `HANDOVER_WITHDRAW_TIMEOUT_MS` and `HANDOVER_STALL_GAP_MS` equal to the stop values, and `HANDOVER_TOTAL_TIMEOUT_MS` 30 s (post to answer). The total bounds only the requester's wait: the holder's work is not bounded by it, and an answer that arrives after the wait ended is swept while the move stands (the requester then says it may have happened).

### Requester (the window the user asked in)

`moveSessionHere(index, tabId)`:

1. Read the claim afresh (`observeOwnership`) and plan with `planWindowSwitch`'s facts (claim, holder liveness via the registry first, then the display reading). `stale` (no claim, this window's claim, a dead holder, or a row with no recorded incarnation) means nothing is held elsewhere: say so and refresh the row; a click opens such a row normally. The holder's registry record gives its label and its `stale` flag; a holder published as stale (older build than the installed one) is refused before posting: "reload that window". A holder whose published row status for the run is `starting`, `stopping` or `restoring` is told "that window may be busy with this session; try again" (the published row can be a lease old, so the holder's own answer is authoritative and the request is posted anyway when the user retries).
2. When the holder's published status for that run is `working` or `question`, ask once (modal): the session keeps running and its turn continues; only host-tool calls the holder window was serving at that instant fail once (OMP reports a tool error and the turn goes on), a prompt the holder had sent and not yet seen acknowledged is not resent, and the holder's unsent composer text stays in its now read-only editor.
3. Post the request with the registry's published binding token for the run (as a switch does) and wait with the stop-style waiter. The post/wait path **carries no focus plan**: the requester never focuses or reveals the holder window, so none of the switch sentences about bringing a window forward apply.
4. On `ok`, run the **ordinary open** of the row with routing suppressed and the live view kept (`openSession(… "opened", noRouting, keepLiveView)`): it takes the now free claim, reconciles and attaches the surviving broker. If the open cannot finish because the holder window itself reloaded in the short gap after the release and re-adopted the session first (its own restore admits a free claim with a live recorded host), the open ends as the ordinary conflict and the session is simply open in that window again; a later reload of the holder is harmless once the adopter holds the claim. If the open fails for another reason the session is still running; the notice says so and that any click in any window adopts it.
5. Outcomes are fixed sentences, and "nothing was moved" is only printed when that is proved:
   - moved: silent, the editor appears;
   - `not-holder`: that window no longer holds this run of the session (it may have been stopped, restarted or moved already): refresh;
   - `busy`: that window is stopping, closing, restarting or switching the view of the session: try again;
   - `terminal`: a Terminal session cannot be moved;
   - `stale-build`: that window runs an older OMP Desk: reload it;
   - `unfinished`: that window began the move and could not finish it; its editor shows how to reconnect there; the session is still running;
   - a bare `ok: false`: that window could not move it (it may have failed before doing anything); refresh and check where the session is;
   - not accepted (the file vanished with no take-up; an older build deletes a kind it does not know): that window runs an older OMP Desk, nothing was moved;
   - never taken up within the wait and withdrawn: that window did not respond, nothing was moved;
   - `silent` (withdrawal blocked, or a stalled wait) or taken up with no answer in time: the move may have happened or may still happen: refresh and check.

### Holder (the window that holds the claim)

`serveHandoverRequest` first refuses, with no state read beyond the window's own, in this order:

1. `stale-build` when this window runs an older build than the installed one (it cannot durably record).
2. The asking window must be another window the registry lists as live. This is a sanity filter, not authentication (any local process of the user can read the registry and name a live window).

Then it **takes the tab's lifecycle gate and holds it from its first recheck to its last recording** (the runtime rule of `local-transition.ts`: each operation takes the gate itself and holds it from its first recheck to its last recording), raises the admission fence, and **re-reads everything under it**; a failed recheck answers without touching the editor or the conversation:

3. Fresh claim read; the claim names this window, its owner generation equals the catalog's, `sessionIncarnation(entry)` equals the request's, `hasLiveHost` is true, the live entry is this window's driven runtime, the row still records `runIntent: running` and the captured host, and when the request names a binding, the editor slot's binding generation matches: otherwise `not-holder`.
4. The conversation is a live **Chat** (RPC) host driven here; a Terminal runtime is `terminal`.
5. No stop, close, restart, view switch or other transition is in flight for it (the fence and the record's transition flag): otherwise `busy`.

Two requests for one session queue on the gate; the first moves it, the second finds it no longer held here and answers `not-holder` without touching anything. A Stop, Close, restart or view switch the user starts at the same instant queues the same way and the detach then refuses (`busy` or `not-holder`); it never paints "moved" over a session this window just stopped. **Kill is not gated** (ADR-0060: it ends the process at once without checking state): a Kill issued while a detach runs ends the process, the detach's under-gate requirement that the row still records `runIntent: running` and the captured host catches a Kill whose intent was already recorded, and a Kill that lands later finds the adopter as the live claim holder (`reconcileKilledHost` then skips as `rival`), and the stopped intent it already recorded is ended by the adopter's own broker watch. A move that lost this race is reported as moved while the process dies; the adopter's open then finds the process gone like any dead session. This is the same outcome as a Kill sent to a session a moment before it is opened anywhere.

Under that hold, in this order:

1. **Drop the conversation**: release it without rendering anything (`chat.release`, the `#drop` half). This disposes the `RpcSession`: pending commands fail as closed, host-tool calls this window was serving are aborted, and the broker connection closes.
2. End the window's record of the runtime: stop the runtime's broker watch and exit handling (so no later event can record "OMP ended" for a session this window no longer serves), clear the record's runtime, and close the verified host-control channel **keeping its credentials** (the adopter reconnects with them).
3. `SessionIndex.detachLiveClaim(tabId, expected, lease)` (the caller's gate lease, so the call never queues on the gate its caller holds): under the tab gate, require that the live entry is this window's driven runtime for exactly the incarnation named (pid, slot, broker id and generation, child pid and creation time) and that the row still records `runIntent: running` with that host; release the claim and drop the live entry. It writes **no** `runIntent`, **no** recorded-host change and **no** `releasedAt` (a recorded release is absence evidence that would authorize a relaunch of a second writer). A failed release is `claim-unreleased`; a changed row is `target-changed`.
4. Lower the fence and release the gate. Then, outside the hold, render the read-only view (`showViewOnly`, phase `blocked`, reason "This session was moved to another window."; it reads the session file, which is why it comes after the release and outside the gate: neither the claim nor the gate may wait on a transcript read). The window then forgets its local outcome, repaints, tells the user in a notification which window asked ("The session X was moved to another window.") and answers `ok`.

Input ownership at the broker. `BrokerHandle.disconnect()` is not acknowledged and the broker clears its input owner when it processes the close; an attach claims input without takeover and is not retried. A move can therefore let the adopter reach the broker before it has seen the holder's close. The adopter side closes that gap: after an attach whose input claim is refused because another frontend owns input, **the claim holder retries the claim a bounded number of times** (about 10 tries over 2 s) before it settles read-only. The retry is the plain input claim, never a takeover (a takeover would let two windows act as the writer); it is armed only by the attach path of a window that holds the session's claim, as an option of the attach, and is not inside `BrokerHandle.claimInput` (the terminal pipeline calls that with its own takeover decision). When input is gained the session re-sends its state and re-registers its host tools (they are retracted while the channel is not the input owner and nothing else re-sends them). If the retry runs out, the moved session is live and readable but every write is refused as not the input owner, with host tools unregistered; reloading that window recovers it (the claim stays and the next attach claims input). The holder-side order (connection closed before the claim is released) keeps the window short; the retry is what makes it correct.

If step 1 or 2 succeeded and step 3 fails, the window has dropped its connection but still holds the claim: it renders the read-only view with the note "The move could not finish. Open the session here to reconnect it.", answers `unfinished`, and an ordinary open in this window re-adopts the surviving broker as a restart would. The note is shown only while a fresh claim read still names this window; when the claim is elsewhere the note says the session is open in another window. The process is never affected.

The holder's editor stays open as a read-only history view with the note. It is not closed (that would need the editor-slot and bridge cleanup of a full close and would lose any unsent composer text). The adopter's controlling election demotes the holder's durable binding (`demoteRivalControllers`) as it does for any rival, and a later revival of that tab opens nothing but the claim-conflict view.

### What survives and what does not

The OMP process, its broker, the turn in progress, queued messages, background jobs and the transcript survive, as in a window reload. Lost, as in a reload: the holder's prompt ledger (a prompt the holder had sent and not yet seen acknowledged fails as closed and is not resent), host-tool calls served by the holder at that instant (answered by an "earlier attachment" error from the adopter, as a reload does), per-window UI state (the HUD clocks, footer values, caches, which are rebuilt from `get_state` and the file). Unanswered approvals and host-tool calls pinned in the broker's ring are replayed to the adopter.

### Surfaces

- **Sessions row menu**: `Move to This Window` (`ompDesk.moveSessionHere`) beside Stop and Switch to Window on every row shown as open in another window (it does not need the holder's window URI, unlike Switch).
- **Conflict notice**: the error notification a window shows when its restore or open hits `claim-conflict` gets a `Move to This Window` action.
- **Command Palette**: `OMP Desk: Move Session to This Window` resolves the session like Close does (the editor in front, else the active session) and tells the user when that session is not held by another window.
- Guide page, changelog and architecture notes name the action and say Stop/Kill end the process while Move does not.

### Placement in the layers

The detach is a `SessionRuntime` port member (`detach`, DTO-only, in `src/runtime/`, no `vscode`): a gated transition beside `stop` and `replaceWriter`, implemented over the existing `index`, `records`, `chat` and `control` collaborators plus the launcher's broker-watch disposal. It takes the gate itself, performs steps 1 to 3 under it, releases the gate and the fence, and then renders the read-only view itself (`showViewOnly` is the runtime's own conversation surface, so the render needs no `vscode`, and the transcript read happens outside the gate). It returns a value (`detached`, `refused` with `not-holder`, `busy` or `terminal`, or `failed` with `claim-unreleased` and whether the claim is still held here). What is window-side stays in `extension.ts`/`window-routing.ts`: the registry checks, the notification, the repaint and the answer. ADR-0066's list of port operations gains `detach`.

### Security

Request files are writable by any local process of the user (ADR-0056), and the registry is readable by all of them, so "the asking window is a live window of the profile" filters mistakes and noise; it is not authentication, and the holder's notification would then name an innocent window. A forged `handover` addressed to a holder can make that holder drop its view of the session it really holds, release its claim and leave the running session adoptable by any window of the profile. It cannot start, stop or admit anything: the process is untouched, the exact run is fenced (`incarnation`, `binding` and the claim's owner generation), and the adopter's admission is the only ownership decision. It is, however, stronger than a switch: besides the session having to be reopened, the move re-homes host-tool execution to another window and drops one in-flight host call and any unacknowledged prompt, so a turn's tool call can fail once. Claims, the registry and requests remain advisory.

## Alternatives

- **Steal the claim from the requester without asking the holder.** Violates ADR-0039 (a live holder is never overridden) and leaves two connections, one of which would hold broker input.
- **Stop then Resume.** Exists today; ends the process and its in-flight turn and background jobs. The whole point is not to.
- **Close the holder's editor as part of the move.** Needs the full slot, bridge and binding cleanup, loses unsent composer text and leaves no history view; a read-only view with a note is smaller and safer.
- **Automatically give a session to the window that has its folder open.** Two windows would fight over rows on every focus change, and a user who opened a session where they want it would lose it. Rejected: only an explicit request moves a session.
- **Another channel (a pipe or the broker) between the windows.** Duplicates the registry/request channel the extension already authenticates and sweeps.
- **Require the holder to be idle.** The process is not stopped, so a turn in progress is not at risk; an idle requirement would refuse the case that matters (a working session in a closed-then-adopted window). A modal on the requester states what a mid-turn move costs instead.

## Risks and Open Questions

- A holder window with a wedged extension host never takes the request up: the requester says so after 8 s and withdraws, nothing moved.
- A failure between dropping the connection and releasing the claim leaves the holder with a read-only view and a claim; the recovery is an ordinary open in the holder (see above). This window is short (one claim file write).
- A holder reload between the release and the adopter's claim re-adopts the session in the holder (free claim, live recorded host, no release proof); the adopter's open then ends as the ordinary conflict (see the requester, step 4).
- A Kill is not gated (ADR-0060); see the holder section for what a Kill that races a detach produces.
- Host tools (ADR-0055) run in the window that serves the session; a move changes that window mid-turn and fails the one call in flight, as a reload does.
- A holder on a build that parses the kind (this one) but whose installed package changed on disk refuses with `stale-build` before doing anything.
- Two windows asking for the same session at once: both requests are taken up and queue on the gate; the first moves it, the second answers `not-holder` (the claim then names the first), and the user sees the row open elsewhere.
- Terminal-mode sessions are not moved (a later design could do the same for a PTY frontend).

## Rollout and Verification

Slices: (1) wire kind, take-up, post/wait helpers (the stop waiter generalised) and tests in `window-requests`; (2) `SessionIndex.detachLiveClaim`, the runtime `detach` port member in the gated transitions and the adopter-side bounded input re-claim, with unit tests over the fakes (order of collaborators, no intent or host write, refusal on a changed incarnation or a recorded stop, two detaches in a row, nothing stopped); (3) the holder and requester wiring in `window-routing` and `extension.ts`, the command, menu, palette, notice action and the read-only note; (4) docs. Verification: focused unit tests for each slice, the lifecycle harness test of the full holder path with a fake broker (a mid-turn move keeps the process, a concurrent stop wins or loses cleanly, an older holder is reported), `npm run typecheck` and the focused suites, then the installed build in a two-window smoke.

## Related Decisions

- [ADR-0080](../decisions/0080-hand-over-a-live-session-through-a-taken-up-request-that-detaches-the-holder-without-stopping-it.md)
- [ADR-0055](../decisions/0055-expose-vscode-capabilities-as-rpc-host-tools-run-by-the-owning-window.md), [ADR-0066](../decisions/0066-extract-a-session-runtime-port-and-enforce-it-with-a-vscode-free-layer.md), [ADR-0039](../decisions/0039-refuse-only-on-a-verified-live-writer-the-extension-owns.md), [ADR-0056](../decisions/0056-publish-window-state-in-a-leased-registry-and-switch-windows-by-request.md), [ADR-0057](../decisions/0057-start-a-session-in-the-window-that-suits-its-folder.md), [ADR-0060](../decisions/0060-merge-background-processes-into-sessions-and-kill-all-through-authenticated-routes.md), [ADR-0031](../decisions/0031-reattach-a-surviving-managed-host-through-its-broker.md)
- [Multi-window sessions](2026-10-10-multi-window-sessions.md)

## Architecture Review

- Reviewer: architect
- Outcome: accepted after two independent review passes
- Notes: first pass ACCEPT WITH CHANGES (three material findings: checks outside the gate, the Kill race, the unacknowledged broker input release; five should-fix items and five nits); the revision resolved them in the text and a confirmation pass found one material point (a bare refusal cannot mean "began and could not finish"; it became the `unfinished` reason), four should-fix items (the re-claim is a plain non-takeover claim armed by the claim holder's attach path and re-registers host tools; the render is the runtime's own and happens outside the gate; `detachLiveClaim` takes the lease) and three nits, all applied. Implemented and unit-tested; a two-window smoke test with a real broker is not part of this record.
