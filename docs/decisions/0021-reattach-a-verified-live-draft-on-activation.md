---
status: superseded
date: 2026-09-25
---

# ADR-0021: Reattach a verified live draft on activation, and keep panel ownership with VS Code

> Claim clauses narrowed by [ADR-0039](0039-refuse-only-on-a-verified-live-writer-the-extension-owns.md): absent/unreadable/stale reservations may be acquired; adopt-only and failed-attach-retains-reservation clauses are superseded. Failed attach rechecks positive ownership and releases its operation lease. VS Code still owns panels.

> Narrowly superseded by [ADR-0038](0038-host-chat-over-rpc-ui-on-a-broker-pipe-child.md): a new session's exact file is learned from rpc `get_state.sessionFile` right after `ready` (before the file exists), so the fileless-draft process/room reattach and the bounded materialization lookup are replaced by an exact binding. "Panel ownership stays with VS Code" and adopting (never creating) the reserved claim remain operative.

## Context and Problem Statement

A native OMP session writes its JSONL file lazily, so a freshly created session is an extension-owned *draft*: an indexed row, a reserved draft claim, and a running native host, with `sessionFile: null`. A window reload (or VS Code restart) keeps the durable row and claim, but the hidden terminal's process may or may not survive; the extension host that owned the panel, runtime and authenticated control channel is gone. Before this decision, even a verified surviving process was reported as a draft, leaving its restored editor disconnected with "no native host yet": the row was absent from Sessions (the tree lists bound panels only), and model/thinking and Tools answered "The native session or its held ownership is not verified yet." or nothing at all. The user had to rediscover and reopen the session, and any new prompt risked a second writer.

VS Code's Webview API compounds the problem in one specific way: **panels are owned by the extension that creates them**. The extension receives a panel reference from `createWebviewPanel` or from `WebviewPanelSerializer.deserializeWebviewPanel`, and there is no API to enumerate or regain a webview the extension host has already resolved. `Developer: Restart Extension Host` ("Restart Extensions" in some UI surfaces) replaces extension hosts without re-running deserializers for resolved webview inputs, so a panel that was visible keeps rendering while the new extension host has no reference to it. `Developer: Reload Window` restarts the workbench window: webviews are re-created through the serializer, while the native OMP process, its Collab room, the relay sidecar and the hidden terminal are not children of the extension host and can outlive it. Their survival is what makes a same-process attachment possible at all — a prerequisite this decision verifies against the recorded launch, never something it assumes.

## Considered Options

- **Enable `restoreDrafts: true` for the activation pass.** Rejected for unattended work, not for a second writer: the ordinary start path still takes the claim and refuses any owner it cannot exclude. It would launch a host for every *startable* draft — including genuinely empty ones — without the user having asked for any of them, where the user's stated intent was to get back the process that already exists.
- **Attach from the deferred reconciliation or from the serializer.** Rejected: the deferred pass is observation only (it takes no claim and holds no lease), and the serializer is an editor-lifecycle callback that must stay native-operation-free ([ADR-0019](0019-vscode-owns-omp-editor-persistence.md)).
- **Let a live row through the dead-host deferred adoption (`promoteDeferredDraft`).** Rejected: that authorization exists to adopt the file of a *provably stopped* host; a live writer must be adopted as a host, not as a file.
- **Run the attach inside the ordinary restore pass, with an attach-only intent for fileless rows, and require the same facts the classification already needed.** Chosen.
- **Relax the GUI control gate to allow a verified channel with no session file.** Rejected for this decision: the gate cross-checks the index's exact file against the authenticated host's own reported file, and a null file cannot be told apart from a host serving another session. Native host control does distinguish a known-null file from an unreadable identity, so a separate, reviewed authorization could be designed — that is not this repair.
- **Regain or re-bind the orphaned panel after an extension-host-only restart.** Rejected: no public API hands back a `WebviewPanel` this extension host has already resolved, and `TabInputWebview` reports a view type rather than the panel's original tab identity, so an orphan cannot be re-bound to its session from here. Its neighbour operation is possible and deliberately not chosen: `window.tabGroups.close(tab)` can close the orphaned tab and `createWebviewPanel` can create a replacement, which is *replacement*, not re-binding — a different, larger editor-identity decision outside this record.

## Decision Outcome

**Activation never starts a host for a row that is still fileless; a verified live draft is reattached.** `SessionIndex.restoreAll` dispatches every fileless row with an attach-only intent unless its caller explicitly asked for drafts to be started. A row that is not fileless is outside that intent: the deferred pass may adopt the file of a provably stopped host, and any materialized row — including a draft promoted that way — is restored by the ordinary resume path, which launches a host when ownership is provably free. The attach-only path

1. requires the row's recorded launch and its reserved draft identity;
2. refuses a recorded working directory that is not absolute (the same refusal an explicit open applies) and records that as `ambiguous-cwd`;
3. reads the reserved identity's claim and refuses unless it exists, is readable, belongs to the row's owner generation, and the reconciler names the **exact** recorded host (process id, Collab instance, session id, working directory, and this window's own terminal) — the same `attachable` verdict the materialized-session path uses;
4. only then **adopts** that claim atomically: under the identity mutation lock, and only if the claim is still there. Adoption never publishes a record, so a reservation another process removes between step 3 and this step is refused instead of being recreated under the draft's identity, and a rival live holder of the same owner generation is refused instead of double-held;
5. attaches through the ordinary `OmpHostLauncher.attach` integration — no process is spawned, no ownership is minted, and no claim is created at all: the reservation read in step 3 is the one this window's holder lease is recorded over;
6. publishes the `#live` record with `sessionFile: null` and updates the row's recorded host, so the row is `live` and its editor is bound to the adopted runtime.

Refusals are not all byte-preserving, and the record says which is which.

- **Before adoption** — no recorded launch, no reserved identity, a claim that is absent, unreadable or of another owner generation, a rival live holder of this generation, a second row claiming the same reserved identity, a recorded directory that is not absolute, or a reconciliation that does not name the exact recorded host: no lease is taken, the claim file is left exactly as it was found, an absent claim stays absent (nothing is published), and no process is attached or started. The row does carry the refusal as a diagnostic (`failed` for an unusable directory, otherwise the availability the deferred pass derived plus the refusal detail), and several of these refusals deliberately update that row state.
- **After adoption** — the native attach itself fails: the reservation is retained rather than released, with this window holding its lease, and the row is recorded as a live conflict naming the failed attach. The lease record may have changed during adoption (or may already have named this holder); the native process is untouched by either kind of refusal.

A row whose writer is provably gone keeps its startable draft: nothing in the default activation pass starts a host for it, and only an explicit open (`SessionIndex.restore`) or a caller that asked for drafts to be started does.

**Materialization is unchanged and still owns the file.** An attached draft is promoted by the same live-host promotion path as a launched one: the host's own reported session id identifies the file inside the directory the host was actually launched in, and the canonical claim for that file is taken before the reserved draft claim is retired. The row stays a draft until then, so a session with no file yet is never presented as if it had a transcript.

**The GUI control gate keeps requiring the exact file.** Model/thinking and the tool catalogue stay unavailable while `sessionFile` is null, and the panel is now told which wait it is in ("has not written its session file yet") instead of implying that verification failed. When the authenticated channel is published, and again when a promotion binds the exact file, the extension posts a bounded `omp:control-invalidate` to that tab's panel; the panel answers with its ordinary correlated snapshot request, and never with a resent change. The invalidation is a debt paid exactly once, by the request dispatched to answer it: a report that arrives while a request is outstanding is held until that request settles or times out, several reports waiting behind one request cost one request, and the dispatch that answers them is what clears the debt — so a reply or a timeout can never re-owe an invalidation the panel already answered, and the refresh stays bounded instead of asking the host again after every report.

**Restart commands are not interchangeable, and this decision does not paper over it.** `Developer: Reload Window` is the supported way to load changed extension code with a live session: it re-creates the editor through the serializer, and this decision makes that editor bind to the same still-running native process with one attach and zero launches. An extension-host-only restart leaves any already-resolved panel orphaned: the new extension host cannot re-bind it (no API returns the resolved `WebviewPanel`), it is not reachable through a Sessions row because no panel is bound in this host, and no row is fabricated for it. Closing that tab and creating a replacement panel *is* possible through the public tab and webview APIs; that is a different decision and is not implemented here.

## Consequences

- Positive: if the native process and its recorded identity survive and ownership verification succeeds, a reloaded window binds the same session to that process without a second launch or a manual reopen; otherwise the editor reports the bounded draft or conflict state.
- Positive: the attach decision needs no new persisted field, no new owner generation and no claim-format change: it reuses the recorded host, the reserved draft identity and the existing holder-lease rule.
- Positive: refusals are exhaustive and fail closed; the strongest failure mode remains a visible conflict, never a second writer.
- Negative: activation now performs one reconciliation per fileless row that recorded a launch (the deferred pass still runs first for dead-host file adoption), and a live draft whose process cannot be re-verified reports a visible conflict where it previously reported nothing.
- Negative: the reserved draft claim is re-held on a successful attach, so the row remains this workspace's until the session ends or is closed normally.
- Constraint: an extension-host-only restart cannot restore the already-resolved panel of that window; the user must reload the window to get an editor bound to the live process. Opening "the session's row again" is not an alternative there — that orphan has no bound panel, so it has no row — and replacing the orphaned editor is the separate decision noted above.
- Constraint: no control surface becomes available before the session's exact file exists; the wait is reported as a wait.

## Related Documents

- [ADR-0015](0015-serialize-tab-lifecycle-through-one-gate.md) — one tab lifecycle gate spans claim work and runtime/index publication.
- [ADR-0019](0019-vscode-owns-omp-editor-persistence.md) — VS Code owns editor existence; serializer state is identity only.
- [ADR-0004](0004-best-effort-host-model-transitions.md), [ADR-0006](0006-host-generated-key-peer-verified-pipe.md) — host control and its authenticated channel.
- [Draft promotion lifecycle serialization design](../designs/2026-09-25-draft-promotion-lifecycle-serialization.md)

## Verification

Focused tests only; no isolated-window acceptance run was performed for this decision, and the reload path, the restored editor's room rehydration and the panel's automatic re-read after promotion are therefore source- and test-level expectations rather than observations.

- `node --test src/host/session-index.test.ts` — `live draft reattach`: an owned live fileless draft is adopted with exactly one attach and zero launches and the row stays fileless until promotion; a provably dead writer with no file stays a startable draft with nothing attached or started; mismatched process, Collab or session identity and an unverifiable "free" verdict attach nothing; a rival live holder is refused; a missing or concurrently removed reserved claim is refused without creating one; failed native attachment retains the reservation, and the dead-prior-holder example observes its changed lease.
- `node --test src/host/session-claim.test.ts` — `adoptExistingClaim`: no claim is created for an absent reservation; a claim of this caller's generation is adopted in place and released by the adopter; a live rival holder, another owner generation and an unreadable record are refused. The unreadable-record test establishes continuing unverifiability, not byte-for-byte equality.
- `node --test src/webview/lib/control-refresh.test.ts` — `control refresh`: the step sends only for an owed invalidation; one invalidation costs exactly one request however many replies or timeouts follow it (the bounded-refresh regression — the earlier counted-but-never-consumed version asked again after every settle); an invalidation arriving behind an outstanding request is held and answered once that request settles or times out; several invalidations behind one request cost one request.
- `node --test src/host/native-terminal.test.ts` — `attach session directory`: a materialized file keeps its own directory, an explicit scope directory survives attachment, and a fileless draft falls back to the isolated per-tab directory the launch used.
- `node --test src/webview/messages.test.ts` — `omp:control-invalidate` parses as a bare event and carries no state.
- `npm run typecheck` across the extension, the guest components and the tests.
- Not covered by a test: the two guest components' own wiring of the step above (this repository has no DOM/React test harness). Each keeps one refresh state and calls the tested pure step; only the effect that calls it is unobserved, and that effect only ever sends an `action: "snapshot"` request, so a change the user asked for is never resent.

## Architecture Review

- Reviewer: an independent document reviewer, followed by a second independent corrective reviewer.
- Outcome: **ACCEPT** after six initial material findings were repaired and three residual wording/evidence corrections were independently reviewed.
- Notes: The pre-document architecture consultation was design input, not a document review. The corrective review checked the repaired source and tests for consumed control invalidation and adopt-only claim ownership, plus documentation of conditional process survival, refusal effects, and the distinction between re-binding and replacing an orphaned panel. No isolated-window acceptance run has observed the resulting behavior yet.
