---
status: accepted
date: 2026-10-10
---

# ADR-0057: Start a session in the window that suits its folder

## Context and Problem Statement

Since ADR-0056 every window lists every folder open in any window, so a session can be started from a window that does not have the folder open. The editor then lives in the wrong window, and for a Unity project the Unity extensions (vstuc, C# Dev Kit) do not work at all there: they need the project folder as the window's workspace root. ADR-0056's request channel only lets a window *select* a tab another window already has; a launch needs the other window to start something. That is a new authority for a request and a new way to start a session, so it is decided here rather than slipped into ADR-0056.

## Considered Options

- **A launch request kind on ADR-0056's channel, performed by the receiving window through its own ordinary path, plus a pending-launch file for a window that does not exist yet.** One request format and queue; admission stays where claims already are.
- **Carry a prepared draft or a picker's answer from the requester.** A draft created by a requester whose request is never answered would stay as a stray row everywhere; a picker's choice would need a second description of every candidate.
- **Fall back to launching locally when the receiver does not answer.** A slow window may still start the session: two sessions.
- **Treat any window with an ancestor open as having a Unity project open.** The Unity extensions need the project as workspace root.
- **Open a new window and rely on the window's own startup to pick up work (a global queue).** Requires a durable, atomically claimed file anyway; this is that, narrowed to the folder's identity.

## Decision Outcome

First option.

- Every explicit launch of a session for a folder (New Session from any entry point, Resume Session from a folder's history, opening a stopped or draft row, in an explicit view or not) is started in a window that has the launch's *workspace* open: the folder itself, or, for a Unity launch, the Unity project folder the folder stands for, matched exactly against the window's own roots. The session's working directory stays the Sessions folder, so the repository's agent files still load.
- Here when this window has the workspace; the most recently focused other window that has it (the registry publishes `focusedAt`, never shown); for a Unity project nobody has open, a new window on it; for an ordinary folder nobody has open, here.
- A **launch** request (`kind: "launch"`, with the workspace and one of `new-session`, `resume-folder`, `open-session`) is served by the addressed window through the same function a click there runs. The receiver first awaits its own start-up state, then checks that it has the workspace open, that the folder or session the request names stands under that workspace (the folder itself, or a Unity project it stands for), and that the requester still waits, and looks at its roots and the target again synchronously right before beginning (the target is the one it validated: same session and working directory, same folder path). Whether a session is live is decided at that moment and carried through the open's own waits: a live session is only revealed, never launched or switched to another view, including one that went live while the open waited or that a launch already in flight brought up. Readiness awaits the newest agent-root probe to have published. It never routes the request again. The answer is given on admission. A launch lives 11 s with a 10 s answer wait (a select keeps 6 s and 5 s).
- The requester **never launches locally after handing over**: bringing the window forward and waiting for the answer start together, the wait ends at an absolute deadline whatever the focus command does, every path that stops waiting withdraws the request, and a timeout, refusal, failed focus or unreadable answer is a message (hedged where the receiver may already have acted). Nothing is retried.
- A **pending launch** (`pending-launches/<identity key>.<id>.pending`, 65 s lifetime, 60 s wait) is left for a Unity project's new window, which claims it by exclusively creating a marker file (not by rename: two windows can both rename one file on Windows). Claiming is not admitting: the pending file stays, and stays withdrawable, until the launch is admitted or refused, so a window still waiting at the requester's deadline refuses instead of starting late. The marker is removed only once the pending file is positively deleted, so a served launch whose file could not be deleted is never claimed again. Work is a bounded, deduplicated queue and stale files are swept by any window.
- A window that runs an older OMP Desk than the one installed (its package changed on disk under it, so it cannot build a view) publishes `stale: true` in its registry record, is never chosen for a launch, and a launch for which it was the only candidate starts here (also for a Unity project: no new window on a project a stale window has) with a message once per window; a record without the field reads as stale. A launch request that reaches such a window anyway is refused first thing with the reason `stale-build`, and the requester then starts the launch itself. This keeps at-most-once: the refusal is written by the addressed receiver for that request before it begins anything, a request is served once, and the requester acts only on that definite answer, never on a timeout, an unreadable answer or a failed focus. Switching to a session such a window already holds is unchanged.
- **Add Selection / Add File to Session** stay local (they insert references into this window's editors); every other explicit launch routes, and every explicit open first switches to a window that holds the session.
- Unity detection is bounded and cached (the folder, then two levels, excluding dot-directories, `node_modules`, `Library`, `Temp`, `Logs`; a directory with `ProjectSettings/ProjectVersion.txt` and `Assets/`); several projects are asked once and remembered per folder.
- `omp.launchInFolderWindow` (default true, application scope) turns all of it off.

### Amendments to ADR-0056

- Its "a request only selects a tab" rule is now the rule for `select` requests; `launch` requests start sessions, with the receiver's own admission and the checks above. A forged launch can start an idle session in a folder the receiver itself has open, which the same user can do directly; claims, registry data and requests remain advisory and never admit or refuse a launch.
- Revealing a session another window already holds keeps ADR-0056's switch.

### Consequences

- Positive: a session starts where its folder (and Unity tooling) is; one code path per launch; no duplicate sessions from this routing; no change to claims.
- Negative: a hand-over to a window that does not answer says so and starts nothing (the user retries); the requester's command stays pending up to 10 s (60 s for a new window); a few milliseconds of race can start a session while the requester says it did not respond; Unity projects deeper than two levels are not found; Add Selection / Add File to Session started for a Unity project run in the window the user used.

## Related Documents

- [Start a session in the window that suits its folder](../designs/2026-10-10-launch-in-folder-window.md)
- [ADR-0056](0056-publish-window-state-in-a-leased-registry-and-switch-windows-by-request.md), [ADR-0045](0045-derive-window-folders-per-window-and-pin-with-identity-ids.md), [ADR-0039](0039-refuse-only-on-a-verified-live-writer-the-extension-owns.md), [ADR-0034](0034-store-sessions-in-one-profile-catalog.md)

## Architecture Review

- Reviewer: architect
- Outcome: accepted
- Notes: Seven independent review rounds (round 1 found eleven issues: an action not bound to the workspace it was served for, a stale admission check, unbounded delivery, a claimed pending launch that could not be cancelled, the Add Selection / File entry point, explicit-mode opens, setting text, unfocused new windows, startup readiness, an unbounded pending queue, missing sweeping; later rounds: a cleanup failure that could allow a second claim, a stale target and live-session decision across admission waits, a readiness barrier a superseded probe did not provide, and the reveal-only rule that had to follow the open through every continuation) were each addressed in code, tests and this text; round 7 found no remaining blocking finding. Acceptance of the architecture does not approve the declared scope limits, which the maintainer decides: a Unity project is a heuristic (two levels, ProjectSettings/ProjectVersion.txt and Assets), Add Selection / Add File to Session always run in the window the user used, the requester's message after a timeout or failed focus cannot tell whether the receiver already acted, and a launch whose admission began just before the requester withdrew it can still start.
