---
status: proposed
date: 2026-10-11
---

# ADR-0060: Merge background processes into Sessions and stop everything through each process's authenticated route

## Context and Problem Statement

The Processes view listed the PTY brokers that host sessions and folder terminals next to the Sessions view that lists the sessions. The two overlapped, a session's live process was only visible in the other view, and no action ended everything. The user asked for a single Sessions view that marks live processes, shows terminals without sessions separately, has a Terminals layout, and offers Stop Orphaned and Idle and Kill All, where Kill All ends everything in this window and may also end the processes of other windows after an explicit offer. The Processes design had deliberately left "stop everything" undecided because it ends live, driven sessions in this and other windows.

Constraints that stay: no process id is ever signalled (ADR-0029, ADR-0037, ADR-0039); a session's stop runs through its own lifecycle under the per-tab gate (ADR-0015); a process authenticated by a record is stopped only after its identity is re-verified; the view that is always visible must not poll expensively.

## Considered Options

- **One Sessions view over the existing reader, with Kill All stopping each process through the route its own Stop uses, from this window, in two confirmed tiers.** One list, one reader, one stop path; other windows' processes are stopped through the broker any window can authenticate to.
- **Keep two views and add Kill All.** Leaves the duplication the user asked to remove.
- **Ask every other window to stop its own processes through ADR-0056's request channel.** A new request kind and answer protocol, deadlines and stale-window handling, for something the authenticated broker already permits from any window.
- **End processes by PID or process tree.** Rejected by the standing ADRs: the check and the kill are not atomic and Windows cannot prove a tree.
- **Kill All limited to rows this window shows.** Leaves a "kill all" that leaves processes running and no single action that ends them.
- **Treat a row with no known window as this window's.** A session another window holds is `none` until its claim is observed; this would stop another window's work without the explicit choice the user required.

## Decision Outcome

First option.

- **Sessions is the one place.** The Processes view is removed. A session row marks its process from its own status (and from the process snapshot's facts when it has them); processes that no listed row stands for are served in a separate **Terminals** group in the flat and folders layouts, and every process in the new `terminals` layout. The Processes design's classification, reader, identity caches and presentation words are kept, moved behind the Sessions provider.
- **One stop path.** Single Stop, Stop Orphaned and Idle and Kill All call the same row stop function, which chooses the `driven`, `recorded` or `broker` route from a fresh derivation exactly as the Processes design defines. A session this window drives is stopped through its own lifecycle; nothing here signals a PID.
- **Kill All has three tiers behind one modal.** *This window* is exact local identity: a session this window drives, or a folder terminal an editor of this window carries; a session another window holds is that window's even when this window has an editor on it. *Other windows* are rows another window holds; *not run by this window* is everything else stoppable (no window shows it, or this window only shows it). The last two are stopped only after the explicit choice *Stop in All Windows*, because a window attribution is a record, not proof. A recorded-host stop binds to the exact slot, attempt and broker identity the row was derived from and proves the attached broker against it. Rows this build cannot authenticate to are never attempted and are named in the result. The result is per target: a row still present in a final fresh read is still running, and an absent row counts as stopped only when its route confirmed it.
- **No request to other windows.** A process held by another window is stopped from this window through its authenticated broker, as Stop on an `otherWindow` row already does; the other window sees the exit the way it sees any exit. ADR-0056's request channel is not extended.
- **One serialized reader, bounded polling.** `process-wiring.ts` owns the reader; every read, the poll's and every controller's, runs through one queue and is published to the Sessions provider. No background read while Sessions is hidden (explicit actions always read fresh); explicit reads on visibility, layout change and after stops; ticks every 5 s in the `terminals` layout and every 30 s elsewhere, plus one debounced tick after launcher refreshes; one authenticated child-state read per newly seen broker; a verified identity is trusted for 60 s of wall time.

### Consequences

- Positive: one list for sessions, terminals and their processes; every stop action reaches the same authenticated paths; Kill All needs no new transport or format.
- Negative: Kill All is destructive and serial, so its duration grows with the number of processes; a terminal held by another window cannot be revealed from here; a mark derived from status can be a moment out of date; the visible-only poll now runs for the main view (slower in the common layouts to bound its cost).

## Related Documents

- [Sessions unify design](../designs/2026-10-11-sessions-unify-processes.md)
- [Processes view design](../designs/2026-10-07-processes-view.md) (separate view, poll rule and "no stop-everything action" superseded)
- [ADR-0015](0015-serialize-tab-lifecycle-through-one-gate.md), [ADR-0029](0029-report-uncontained-pty-tree-stop-as-unknown.md), [ADR-0037](0037-stop-a-recorded-broker-owned-managed-child-without-a-chat-runtime.md), [ADR-0039](0039-refuse-only-on-a-verified-live-writer-the-extension-owns.md), [ADR-0056](0056-publish-window-state-in-a-leased-registry-and-switch-windows-by-request.md)

## Architecture Review

- Reviewer: independent `architect` agent, two rounds (2026-10-11).
- Outcome: round 1 accept after fixes (addressed); round 2 not accepted, so this ADR stays `proposed` with the [design](../designs/2026-10-11-sessions-unify-processes.md): a native session held by another window is stopped through its broker's graceful stop rather than the owner's native shutdown lifecycle (needs the product owner's decision); the owner window's convergence after a remote shutdown is unverified; `drivenHere` is slot equality; driven and recorded routes prove the writer gone, not the broker retired.
- Notes: "one stop path" above means one function choosing the existing routes; it does not mean every route has the same lifecycle effects.
