---
status: superseded
date: 2026-09-29
---

# Recovering a lost room link, and releasing a launch attempt no observation can resolve

> Further superseded by [ADR-0039](../decisions/0039-refuse-only-on-a-verified-live-writer-the-extension-owns.md): explicit release, retained uncertainty and stale-reservation states are removed. Authenticated exact-child Stop survives, with fresh positive ownership rechecks after an unconfirmed result.

> Superseded by [ADR-0038](../decisions/0038-host-chat-over-rpc-ui-on-a-broker-pipe-child.md) and its [RPC-UI chat and Sessions design](2026-09-29-rpc-ui-chat-and-sessions.md): lost-room link recovery is removed with Collab rooms. The explicit release and no-runtime stop mechanisms (ADR-0036/0037) continue with broker/kernel witnesses only.

## Problem

Two user-reported states had no way out.

1. **A Collab room closes while the OMP session keeps running.** The guest's socket then retries the link
   it already holds — reported as a loop against 4001/4004 — and nothing ever offers it another one: the
   host republishes a room with a new generation, and only OMP's current registry can name it.
   `deliverLink` cannot help, because the guest already confirmed that exact link and the delivery rule
   never repeats a confirmed link; `refreshLink` only runs when the runtime holds *no* link at all. The
   panel stays dead until the user reloads the editor or restarts the window.
2. **A launch attempt no observation can ever resolve.** A row whose launch recorded a process but matched
   no Collab room answers `unknown` for every automatic pass, however its pid ends, and
   `OMP: Release Stale Session Ownership` refused it (it was limited to attempts with no process identity
   at all). The user was left with a blocked tab and no action — the permanent lock ADR-0033 rejected in
   principle.

## Goals and Non-goals

- Goals:
  - A panel whose established room was lost gets a bounded, scheduled chance to acquire the room the verified host publishes now, without launching, stopping, adopting or switching a host.
  - The replacement is fenced to the exact host this window verified, so a reused pid, a room serving another conversation, or a host this window never verified cannot be adopted through it.
  - An unresolved recorded attempt has an explicit, risk-disclosed release, without implying that a writer is absent.
- Non-goals:
  - Launching, stopping, adopting or switching anything from automatic link recovery or explicit release.
  - Acting on a lost room automatically when the same host cannot be proved.
  - Changing attachment, transport selection or claim admission. Automatic link recovery also changes no durable run intent; only the two explicit actions persist a stopped intent (the release deliberately, the recorded-host stop before it dispatches).

## Current State

- `deliverLink` (`src/extension.ts`) delivers a tab's link only to its own document, only once the document
  has shown it can receive, and never repeats a link the guest confirmed. When `runtime.link === null` it
  asks `refreshLink`, which acquires a link for the runtime's pid and cwd — and accepted whatever room came
  back, without comparing it to the host this window had already verified.
- `acquireCollabHostLink` (`src/host/native-terminal.ts`) re-lists OMP's registry on every attempt for one
  pid and working directory and requests a generation-bound link, so a *rotated* room is reachable; a room
  whose generation rotated after a listing is refused by OMP itself.
- `isUnresolvableLaunchAttempt` (then `isUnidentifiedLaunchAttempt`) admitted the explicit release only for
  attempts with `pid`, `instanceId` and `generation` all null, and the release action refused any row with
  no session file.
- `PanelLinkDelivery` (`src/views/session-link.ts`) owned "when may this document be sent this link" but had
  no notion of a bounded retry for a lost room.

## Proposed Design

### A lost room link is re-acquired for the verified host, bounded

On one `omp:status` report with phase `reconnecting` or `ended` — the phases a guest reports only after it accepted a link, i.e. an *established* room loss — the extension starts a cancellable, finite recovery sequence for that panel document. Guest statuses with identical signatures are deduplicated by the panel app, so the extension does not wait for repeated reports.

1. only for a served, non-passive document whose runtime has a pid and a **verified host** (`runtime.host !== null`); a runtime with no verified host is refused and logged, because nothing could fence a replacement;
2. bounded per document by `PanelLinkDelivery.claimLinkRefresh` (`LINK_REFRESH_LIMIT`: at most 3 attempts, at least 20 s apart). A cancellable timer schedules each attempt; the budget is claimed *before* acquisition starts, so a failed attempt still counts. The claim refuses with a *reason*: an exhausted document ends the sequence, while a document whose own cooldown has not elapsed yet is **deferred** for the remainder (`{kind: "cooling", afterMs}`) and keeps the sequence armed — an unused automatic attempt is never discarded, and the deferral does not spend the sequence's budget (`LostRoomAttemptResult.deferred`). A loss that arrives one second after an attempt is answered by the attempt that is still owed, not by an early end;
3. `acquireCollabHostLink(runtime.executable, runtime.pid, runtime.cwd)` re-lists OMP's registry and requests a fresh generation-bound link; nothing is launched, stopped or adopted. Every link acquisition for one resolved panel document and runtime shares **one in-flight token held on the tab record** (`TabState.linkRequest`), so the ordinary `refreshLink`, the automatic recovery and the user's foreground retry cannot run two at once. The token is an identity object, not a per-caller key: the automatic recovery is armed from the editor slot and the foreground callback knows the conversation, and both resolve to the same record (`stateOf`), which is what makes "one acquisition per document" true rather than a claim about one spelling of the tab id;
4. the freshly listed room must pass `roomReplacementRefusal`: `isRotatedRoomOfVerifiedHost(known, listed)` — the same pid, Collab controller `instanceId`, session id and normalized working directory as the host this window verified, with the **generation free to differ** — and, when this window captured the host's kernel creation time at launch, that reading is taken again and must still be equal;
5. only then are `runtime.host`/`runtime.link` replaced and `deliverLink` called, which sends a *different* link and refuses an identical one. Delivery is what makes an acquisition a recovery: re-acquiring the room the guest already confirmed sends nothing, so it is reported as `retry` — the room loss stands and the bounded sequence stays armed — and only a link the guest was actually owed is reported as `recovered`.

The scheduled sequence is cancelled when the guest reports `connecting`, `waiting` or `live` (self-recovery), when its panel document is disposed or replaced, when the tab closes, or when the runtime is replaced.

Cancellation is a fence, not just a cleared timer. Each sequence carries a generation that every `arm` and `cancel` invalidates, and the attempt is handed `LostRoomAttemptContext.isCurrent()` so it can ask whether it still owns its sequence. `recoverLostRoomLink` re-checks that generation **after every await** — after the registry listing, after the process re-read inside `roomReplacementRefusal`, and again before delivering — together with the record still being filed under its own slot, the same runtime, and the guest's last reported phase still being a lost room. A completion that fails any of those commits nothing: no runtime field, no delivery and no scheduled work. A superseded completion therefore cannot schedule a timer for, or cancel, a sequence that replaced it.

Every acquisition — the automatic attempt **and** the user's foreground retry — additionally captures the record's document lifetime (`TabState.linkGeneration`), which `resetPanelLink` bumps whenever the panel document is disposed, rebuilt or pointed at another relay, or the runtime is relaunched. Completion must match that captured generation as well as, for an automatic attempt, its sequence generation, so an acquisition started for a document that was replaced before it finished cannot commit a room or deliver a link into its replacement — even when the replacement is lost in exactly the same way and the record, the runtime and the guest's lost-room phase all still match. The foreground retry passes that generation as its own fence; there is no path whose completion is unfenced.

After the automatic budget is exhausted, bringing the panel forward while the guest still reports a lost-room phase makes one further fenced attempt. This explicit fresh-link retry is not charged to the automatic budget (it takes no claim), is not gated by the automatic cooldown, and is deduplicated against an acquisition already in flight by the same tab-record token. Re-delivering the old confirmed link cannot recover a rotated room.

The same fence applies to `refreshLink` whenever a verified host is already known, so no path replaces a verified room with an unverified one.

### The explicit release reaches every unresolvable attempt

`isUnresolvableLaunchAttempt(host, availability)` admits a recorded launch attempt (`host !== null`) when `host.pid === null`, `host.instanceId === null`, or its availability is `owner-unknown`. This includes a room-matched attempt whose room closed but whose process cannot be proved gone or positively identified as a live writer. For an attempt with both `pid` and `instanceId`, eligibility additionally requires `owner-unknown`; missing either field admits the attempt to the check regardless of availability. Eligibility alone never authorizes release: a locally driven host or a positive writer witness found by the fresh check refuses it.

Everything else about ADR-0033's mechanism is kept: one action (`omp.releaseStaleOwnership`), one durable retirement bound to the exact attempt (`attemptStartedAt` and its recorded `sessionId`), explicit-only, and nothing started, stopped or deleted by the release itself. The identity the release holds is the row's own canonical claim, else its reserved draft identity; a fileless draft is not excluded. An already-completed matching release is re-verified and completed idempotently, rather than becoming a permanent lock if a later pass marks the row `owner-unknown` again.

The fresh best-effort check is widened to what each shape can support, and every unreadable input still refuses:

- the recorded session id is checked first, with the row file's header as fallback; a header naming a different session from the recorded id refuses, as does a live Collab session publishing the target session id in that directory;
- a registered Collab host with the row's recorded `instanceId` refuses;
- a registry row at the recorded pid refuses unless a reboot plus the occupant's creation time proves the recorded process gone;
- a live managed child under the row's recorded broker slot refuses;
- unreadable file/header or broker provenance, and an existing broker record that cannot be read or authenticated, refuse;
- an existing broker record that proves a **different slot, host kind or child** is a target mismatch and refuses, exactly like an unreadable one: the missing-record exception never waives it;
- a missing recorded broker record is **disclosed uncertainty, not `idle`**. Only this explicit release path, and later re-derivation of that same matching retirement, may accept it as residual uncertainty; automatic reconciliation, attachment and launch admission continue to refuse/answer unknown;
- a roomless attempt with neither a matchable session identity nor a broker slot has nothing left to check, and release proceeds **on the user's authorization alone**, with the confirmation, row detail and deletion confirmation stating that the writer may still be running.

After release the row is stopped (and `draft` when fileless). Open/Resume re-derive ownership through their ordinary path and Delete re-reconciles under its own held claim. An automatic pass may only re-derive an already-released row while its intent is stopped, and every non-clear answer of that check is propagated unchanged — a released row whose exact recorded writer is publishing again is answered `attachable` by the earlier exact-host branch of the reconciler, before the release check runs, so nothing needs to fall through from it.

A successful release also retires the *retained* in-memory bookkeeping an unconfirmed Close Session left for that row: once the claim it authorized has been released, a record that only stood for that claim must not go on reporting one, or Forget and Delete finalization would still be refused on a reservation that no longer exists. Only that bookkeeping is dropped — the durable recorded attempt and the retirement stay exactly where they are, so no evidence of a writer is discarded and no absence is claimed.

### A recorded broker-owned child has an explicit stop without a chat runtime

The accepted [ADR-0037](../decisions/0037-stop-a-recorded-broker-owned-managed-child-without-a-chat-runtime.md) adds `OMP: Stop This Session's OMP Process…` (`omp.stopSessionHost`) for a stale row whose recorded host is not resolvable, including from the command palette. It handles the reload/restart case where the panel and chat runtime are gone but the recorded broker and child survive.

The confirmation is bound to the selected row's captured attempt tuple and durable broker slot. The modal's title names the working folder's basename and the recorded pid (`pid 4242`, or `no recorded pid`), and the detail it displays names the **full working directory**, the recorded launch timestamp (`attemptStartedAt`) and the captured broker slot, so the attempt the user approves is identified exactly and a pid-less attempt is distinguishable from another attempt in the same folder. The action is offered at all only when the row's durable provenance resolves to a slot — an unreadable provenance, or none, refuses before the dialog, because then this window has no authenticated way to reach the process.

The dialog stays outside the tab's lifecycle gate ([ADR-0015](../decisions/0015-serialize-tab-lifecycle-through-one-gate.md)). The transaction then runs in this exact order:

1. inside the tab's gate, `SessionIndex` re-reads the row and refuses if it now records a different attempt (`host.startedAt`/`host.pid` vs the captured `expect`), if this window drives a runtime for the tab (Close Session owns that case), if the row recorded no attempt, or if its identity (exact file, else reserved draft identity) is missing — nothing has been claimed or changed yet;
2. it re-reads the claim for that identity and refuses an unreadable record or a foreign owner generation, then **adopts** the row's own canonical claim, or **publishes** a temporary one for the duration when the row recorded none, refusing a live rival holder. The claim is the exact-file claim throughout; the draft identity is the fallback when the row has no file yet;
3. it persists the durable stopped intent **before** any stop is attempted, and restores the previous intent and gives back a temporary claim if that write fails, so an interrupted explicit stop can never become an automatic launch;
4. only then does it invoke the stop port, which re-resolves the row's durable broker provenance and refuses when that slot changed while the confirmation was open (or is unreadable, or missing). An authenticated read-only `PtyBrokerClient.attach(slot)` **without** owner hints must prove, through `provedBrokerPin`, a `managed-omp` kind in the recorded slot with matching broker id/generation/kernel identity and child pid/kernel creation time; a recorded pid must match, and a pid-less attempt requires its recorded slot. The handle disconnects in `finally`;
5. `writerGone` permits claim release. If that release fails, the row stays `owner-unknown` with its recorded host and claim retained and the failure is reported; only a released claim clears the recorded host and writes the row as stopped (`saved`, or `draft` when fileless). Every outcome other than `writerGone` keeps the claim and the recorded host, marks the row `owner-unknown`, and leaves the separate explicit release where eligible.

`decidePtyStop` governs the result of `handle.stop({ mode: "graceful" })`: `writerGone` requires the recorded process gone and its matched room freshly withdrawn. A launch with no matched room remains unknown even when the root exits, and the process tree remains separately unproven (ADR-0029). On `writerGone`, the exact-file claim is released, the recorded host cleared and the extension's conversation/editor-to-slot mapping forgotten (best effort); the broker's own retained recovery record is not erased while tree completeness is unknown, and ADR-0029's retention rule remains operative. Otherwise the row keeps its claim and recorded host and the user may choose the separate explicit release where eligible. A refusal that never reached the broker is reported as nothing having been stopped; a stop request whose delivery or answer could not be confirmed is reported as **unconfirmed** — the recorded process may have stopped or may still be running — never as "nothing was stopped". The action never signals a numeric PID, infers descendants, launches, substitutes a legacy transport, or shuts down the broker.

Neither this stop nor the release is blocked by the bookkeeping an uncertain Close Session leaves. Before that repair, a close whose stop could not be confirmed kept the row's claim *and* the in-memory record of a runtime this window drove, while the terminal was already disposed: Close Session then had no runtime to confirm, the recorded-host stop refused with "stop it with Close Session instead", and the release refused with "this window is running the native host" — a row with no action at all. An uncertain Close Session now **preserves the claim and the recorded attempt** (the claim file is never released without a confirmed stop) and marks the row `owner-unknown`, but it no longer leaves a *driven* runtime behind: the live record becomes retained bookkeeping (`LiveSession.driven === false`), so `hasLiveHost` is false for it, a restore reports the stopped unresolved row instead of adopting it, and both the recorded-host stop and the release run their own fresh checks. Retained uncertainty is never a positive live-writer witness: every refusal that needs a witness still requires one, and a reopen, resume or restore of that row still starts no second writer.

## Alternatives

- **A continuously polling background retry loop.** Rejected: one guest loss report starts a finite scheduled sequence; polling beyond its bounded budget adds retries without authorization, while the user's panel foreground action remains the explicit fresh-link retry.
- **Deliver whatever room the pid publishes (pid + cwd only).** Rejected: a pid is not an identity, so a reused number or a room serving another conversation could be bound to the panel.
- **Rotate the link but keep the old host record.** Rejected: the fence compares against the host this window verified, and the durable launch record is deliberately not rewritten.
- **Release automatically once the pid is gone or provably reused.** Rejected: an automatic pass may never act on a heuristic (ADR-0035).
- **Release only attempts with no process identity.** Rejected by ADR-0036's accepted widening: it leaves room-matched attempts in `owner-unknown` with no release path.
- **Stop a broker-owned child only through the chat runtime.** Rejected: after a reload the panel/runtime may be absent even while the broker and child survive. ADR-0037 accepts a separately authorized stop by authenticated broker slot, with no PID signalling or inferred tree termination.

## Risks and Open Questions

- **The fence is only as good as the recorded identity.** A host that rotated its own `instanceId` rather than only its room generation will not be auto-refreshed; the panel keeps its link and the user's foreground/reload paths remain.
- **A room closure may never republish.** Automatic recovery is bounded to three attempts at least 20 seconds apart; after exhaustion the user may bring the panel forward for one further fenced attempt, or reload.
- **The release can authorize a resume over a live roomless writer.** Deliberate, disclosed, and explicit only (accepted ADR-0036); no universal single-writer guarantee is made.
- **Whole-tree termination remains unproven.** The stop outcome separately reports the writer and process-tree evidence; an unknown tree is never described as stopped (ADR-0029/0037).

## Rollout and Verification

- `src/views/session-link.test.ts` covers the bounded refresh budget (claim kinds, spacing, limit, served-only, per-document reset), the established-room loss phase vocabulary, the deferred retry that does not spend the sequence budget, and cancellation fencing: a superseded completion may neither schedule work for nor cancel the sequence that replaced it, and an attempt cancelled in flight is told so.
- `src/host/native-terminal.test.ts` covers the rotation fence (same host with a changed generation accepted; another pid, instance, session or directory refused) and the broker stop/probe evidence — including the fresh registry/header refusals the release's check re-derives. `src/host/session-index.test.ts` largely supplies reconciler *verdicts* to the index; the refusal decisions themselves are the native-terminal coverage.
- `src/host/session-index.test.ts` covers explicit release eligibility, fresh-check refusals, missing-record uncertainty, re-derivation and release disclosure, and the recorded-host stop's transaction (claim kept on an unconfirmed stop, released only for `writerGone`, stopped intent persisted before the stop). It also covers the uncertain Close Session directly: a row this window drove, closed with an unconfirmed stop, keeps its claim and recorded attempt while `hasLiveHost` becomes false and both the recorded-host stop and the explicit release are reachable again.
- `src/host/recorded-host-stop.test.ts` exercises the real index transaction, reconciler and `stopBrokerOwnedHost` helper together. Broker record lookup, attachment, handle stop/disconnect, kernel identity and room/registry observations are test doubles; the test does not execute broker authentication, a socket connection or a real process stop. It covers an unconfirmed stop whose answer was lost, retained claims, and subsequent explicit release with missing-record disclosure.
- `src/views/session-tree.test.ts` covers blocked-row presentation and the available explicit actions.
- The changed extension orchestration is additionally driven by a throwaway scenario script (not kept in the repository, deleted after the confirming round): the real `src/extension.ts` is compiled with the functions under test exported, and `handleGuestMessage`'s status branch, `roomRecoveryFor`, `recoverLostRoomLink`, `deliverLink`, `redeliverLinkToForegroundPanel` and `resetPanelLink` run with a hand-driven clock, a fake OMP CLI answering the real `omp collab list|link --json` protocol, the real `LostRoomRecovery`/`PanelLinkDelivery` and the real editor-slot registry the tab keys resolve through. It asserts: an unchanged room delivers nothing and leaves the sequence armed; one acquisition serves both the slot-addressed automatic recovery and the conversation-addressed foreground retry; a rotated room is delivered and its new generation adopted; a completion whose sequence was cancelled commits no runtime link, delivers nothing and schedules nothing; a new loss inside the cooldown is deferred for the remainder without spending the attempt budget; and a foreground acquisition whose document is replaced while it is in flight commits no link, delivers nothing into the replacement and neither schedules nor cancels the replacement's own attempt. The panel's `postMessage`, the session index (only `get` is reached) and `node:timers` are fakes, and no real OMP process, terminal, panel or broker takes part.
- An installed-window run and a real room closure are **not performed** — this change has no desktop control and no installed-window observation — so the end-to-end behavior inside VS Code, the real broker, and a real OMP room closure remain unverified. Focused tests, the index/broker integration test and the driven extension scenario do not establish installed-window behavior, and none of them is a substitute for it.

## Remaining limits, stated exactly

- A room that is never republished cannot be recovered by link acquisition. Automatic recovery is bounded to three attempts at least 20 s apart; after that (or when the host itself cannot be proved) the user still has the explicit foreground retry, the explicit recorded-host stop, the explicit release of an eligible unresolved reservation, and a reload.
- A different controller `instanceId` is outside automatic replacement: a host that rotated its own instance id cannot be auto-recovered by this identity fence, and stopping or releasing it is the user's explicit choice.
- Automatic link recovery changes no durable run intent (the explicit release and the explicit stop deliberately persist stopped intent), and it never attaches, launches or switches anything.
- A released roomless attempt may still overlap a writer, and a missing broker record does not prove the child is absent.
- A stop request may remain unconfirmed, and only `writerGone` permits claim release; a `writerGone` verdict does not prove the whole process tree empty (ADR-0029).

## Related Decisions

- [ADR-0033](../decisions/0033-release-stale-ownership-of-an-unidentified-launch-explicitly.md) — accepted explicit-only release, whose four enumerated clauses are superseded by the accepted [ADR-0036](../decisions/0036-release-an-unresolvable-launch-attempt-explicitly.md); the rest of its mechanism remains authoritative.
- [ADR-0036](../decisions/0036-release-an-unresolvable-launch-attempt-explicitly.md) — accepted lasting choice for the widened release.
- [ADR-0037](../decisions/0037-stop-a-recorded-broker-owned-managed-child-without-a-chat-runtime.md) — accepted explicit stop without a chat runtime.
- [ADR-0035](../decisions/0035-distinguish-a-recorded-process-from-a-later-occupant-of-its-pid.md) — reboot-scoped automatic rule.
- [ADR-0031](../decisions/0031-reattach-a-surviving-managed-host-through-its-broker.md) — transport provenance and no-fallback rule this fence does not weaken.
- [ADR-0016](../decisions/0016-bind-recording-to-link-room-identity.md) — registry reading that a controller's `instanceId` survives room rotations.

## Architecture Review

- Reviewer: independent architect (v3 design review), v3 review and two confirmation rounds.
- Outcome: **accepted** (final confirmation, revision 3): no remaining blocking architecture findings.
- Notes: V3-D1…V3-D7 are resolved. Document-generation fencing now covers the foreground retry across document replacement; a completed explicit release retires non-driven bookkeeping without erasing the durable attempt or claiming writer absence; and the verification section states its mocked broker boundaries. The real-extension orchestration scenario (including the document-replacement case that previously failed) and the targeted release/finalization tests passed in the final confirmation. Recovery does not silently launch a successor, and no path claims a stop proves `writerGone` or that `writerGone` proves the tree empty. Acceptance is architectural: installed-window behavior, real broker authentication and a real room closure remain **unverified** — no installed-window run was performed.

  Finding history, for the record: round 1 raised V3-D1 (cancellation/document fencing), D2 (cooldown rearm, unchanged-link recovery), D3 (retained bookkeeping after an uncertain Close Session), D4 (stop transaction and confirmation wording), D5 (inbound acquisition keying), D6 (verification honesty) and D7 (limits). Round 2 resolved D2, D4, D5 and D7 and left D1, D3 and D6; round 3 confirmed those three resolved with source evidence and targeted runtime verification: sequence and document generations fence every acquisition, `TabState.linkRequest` is the one in-flight token per resolved record, a cooling claim defers for the remainder without spending an attempt, an unchanged re-acquired link reports `retry` rather than recovery, an uncertain close preserves the claim and recorded attempt without leaving a driven runtime, and a successful release retires the retained bookkeeping. Its remaining non-blocking item (two body references still calling ADR-0036/0037 "proposed") is corrected here. ADR-0036 and ADR-0037 are `accepted` after their own reviewers' final confirmations.

