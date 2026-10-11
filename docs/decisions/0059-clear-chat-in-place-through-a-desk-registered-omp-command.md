---
status: proposed
date: 2026-10-11
---

# ADR-0059: Clear Chat in place through a Desk-registered OMP command, and answer `/new` and `/delete` with Desk's own session flows

## Context and Problem Statement

Users expect `/clear`, `/new`, `/delete` and `/fresh` in Chat. A durable `reset_boundary` is necessary for clearing model history, but does not establish the runtime teardown of terminal `/clear`. The initial boundary-plus-reload proposal was rejected by independent architecture review. The user chose the combined behavior below: **model context cleared, provider state rotated; known differences from terminal `/clear` remain explicit**. Evidence includes installed OMP 18.8.5 source inspection and an isolated native RPC probe with no model turn; real-provider teardown and installed-window behavior remain unobserved.

OMP's terminal `/clear` calls `AgentSession.resetSessionContext()` (`session/agent-session.ts:5775-5854`). No RPC reset command or extension-context reset API reaches it. It clears runtime conversation, checkpoint and tool state, cancels owned asynchronous work, rotates provider identity, resets transcript memory tracking, rearms approved-plan references and resets capabilities. The latest reset boundary excludes earlier messages from model-context reconstruction and the collapsed live transcript, subject to later compaction. Full-history transcript export and the session tree retain earlier entries. The durable SessionManager id, file, title and selected model are retained; `get_state.sessionId` is the provider-session id and rotates.

## Considered Options

- Wait for public `reset_context` RPC or `ctx.resetContext`: cleaner complete teardown, unavailable today.
- Rewind before the first prompt: public, but no reset boundary or provider teardown.
- Mutate over host control: rejected; that pipe remains read-only.
- Host-edit JSONL or silently restart OMP: rejected; second writer/lost process.
- Boundary plus public reload alone: rejected; the boundary is already in SessionManager when reload takes its comparison snapshot, defeating normal same-file change detection.
- **Boundary plus public reload, supported `/fresh`, then completion marker**: chosen, with remaining differences disclosed.
- `/new` and `/delete` through raw identity-changing RPC: rejected in favor of Desk's existing lifecycle flows.

## Decision Outcome

### `/clear`

One fenced Desk operation owns all three RPC prompts. None is a user prompt-ledger row and none starts a model turn intentionally.

1. `RpcSession.clear` admits an idle, settled session without compaction, dialog, queued input, unreconciled/unconfirmed prompt, async work or live agents (including ADR-0053 registry-only liveness). It acquires the shared navigation/lifecycle mutation slot before its first await. The live catalogue must identify `omp-desk-clear` as an extension command.
2. The first `/omp-desk-clear` prompt carries a bounded request id and the **durable** SessionManager id, not the rotated provider id. The handler checks mode, identity, callable `appendResetBoundary`/`reload`, idle and pending input. It checks the public `getAsyncJobSnapshot()` running list and delivery's `queued`, `delivering` and `pendingJobIds`, plus the SDK-exported AgentRegistry and ADR-0053 binding observations. Missing work accessors or unreadable registry state refuse as `work-unavailable`, never as no jobs. It appends OMP's own boundary via the only private dependency, `SessionManager.appendResetBoundary`, then awaits public `ctx.reload()`. It retains the boundary in request-local command state; **no completion marker is written yet**.
   On OMP 18.8.5 this extension command's success response is an **early admission acknowledgement without a local-handled flag**, not handler completion. Desk waits for its correlated `prompt_result` with `agentInvoked:false/status:"completed"`, which `reportPromptResult` emits only after the handler promise finishes (`rpc-mode.ts:1834-1846`; `rpc-prompt-results.ts:278-290`). A false/aborted detach result does not qualify. Preparation errors are inspected before fresh is dispatched.
3. After correlated **prepare handler completion** and authoritative boundary readback, Desk sends `/fresh` as a second ordinary RPC `prompt`, without `streamingBehavior`. This is a supported builtin route (`slash-commands/builtin-lifecycle.ts:184-200`). The supported builtin invokes `freshSession()` (`session/agent-session.ts:5741-5754`), which closes provider sessions, rotates the provider UUID, synchronizes agent identity, rekeys memory and invalidates append-only context. OMP 18.8.5's RPC dispatcher captured the old provider id before dispatch; after this builtin rotates it, its `isCurrent` check returns false and the input outcome is `cancelled` (`rpc-mode.ts:1759-1762,1814,1877-1879`). The final correlated prompt acknowledgement therefore succeeds without `agentInvoked:false`. This special acknowledgement is not a refused reset. Desk must combine the actual native completion outcome with unchanged-file, changed-provider-id readback and durable acceptance; a generic successful prompt acknowledgement alone is insufficient. In an idle session `promptResults.settle(ticket)` reports `agentInvoked:true`, `status:"aborted"`, `sessionSettled:true`, after the acknowledgement (`rpc-prompt-results.ts:89-100,149-162`); that exact admission-cancellation result is accepted only for the fresh phase, without observed model/message fall-through.
4. Desk sends a confirmation-phase `/omp-desk-clear` prompt. The handler checks idle/work/identity again and appends `custom:omp-desk/clear` with `{v, requestId, boundaryId}` from its retained preparation. Only this marker, after reload and fresh, confirms a cleared boundary. The host reconciles it and refreshes context usage.

These are not an atomic transaction. A reload cancellation, failure, timeout or process exit can leave a boundary without completed live reset or marker. `reload-failed` does not prove precisely which runtime context remains. No automatic retry occurs. A boundary associated with a known incomplete Desk clear is shown as an unconfirmed Desk operation and does not collapse earlier history. During that host attach, the page says exactly: **"Context clear did not finish; the next message may still include earlier history. Retry /clear."** A payload-free OMP boundary with no Desk marker may instead come from a successful native `/clear`; absence of a Desk marker alone must not be labeled a failed clear. Such a boundary is displayed conservatively as **"Context reset"**, without collapsing history. This host-known failure provenance is not persisted and is not inferred after reattach.

Every mutation stays fenced until proved phase completion, a valid completion marker, or process end. A local-handled final acknowledgement qualifies; an early no-data admission acknowledgement qualifies only with the native correlated completion result described above. Reload's aborted detach-induced `prompt_result` is not handler completion and cannot lift this fence. An unanswered phase reports `unconfirmed`; neither elapsed time nor exhausted reads releases its fence. Late correlated phase completion can end the uncertain phase, but does not automatically execute subsequent phases or retry.

Phase completion correlation remains active from command dispatch through all timeout reconciliation and cleanup. A final acknowledgement arriving during reconciliation is recorded even before an uncertain fence is published. Neither that acknowledgement nor its completion state may be discarded and replaced by a permanent busy fence.

Every internal prompt phase retains ADR-0051's fall-through defense. Evidence that prepare, fresh or confirmation reached the model triggers an abort and a failed or unconfirmed outcome, never a clean-reset claim. The known native `/fresh` cancelled-admission outcome is handled separately from model invocation. Third-party input hooks can still intercept or rewrite commands; any resulting user message remains in the transcript.

### Identity acceptance

Provider identity is process-bound state, distinct from durable journal identity. Before releasing admission, acceptance must durably commit against the expected previous provider id and captured file/runtime generation. A local in-memory comparison and best-effort catalog write do not satisfy this contract. Storage failure or a conflicting committed record leaves the operation unconfirmed and admission failure-closed. Any already-started persistence is awaited even if a later state read fails. Durable-id consumers—including registry liveness, bridge bindings, navigation and stopped-file operations—must never consume the rotated provider id.

Only a Desk-driven fresh operation accepts one provider-id rotation, and only for the already-bound session file. `RpcSession.#boundId` accepts the new provider id during that operation. `SessionIndex.recordHostSessionId` validates the latest committed row inside `CatalogStore.transactRecords` using its `decide` callback: previous provider id, exact file, recorded host/RPC generation and ownership must still match. The rotated identity exists only in that transaction's desired snapshot until commit; it is then published to the row/live host before the next serialized snapshot is captured. A refused or failed acceptance is not retried as a plain snapshot. When the CAS detects a changed committed runtime, the shared row retains that committed identity while preserving concurrent local title/unread edits; the actual local child is not relabeled as the competing runtime. The durable row `sessionId` remains the journal-header id; recorded RPC host and live-host records carry provider identity. Reattach expects the recorded provider id; a new child starts with the durable header id. Broker root/slot/file/generation identity is unchanged. Rotation outside this operation retains `identity-diverged`.

Tentative provider identity must not be published into general index/live state or captured by an ordinary queued snapshot before the validating transaction commits. A rejected transaction must remain rejected after concurrent unread, title, other-tab and retry persistence drains; rollback of the mutable row alone is insufficient.

Restart validates the saved row, journal headers and bridge binding against the durable id, and separately validates the recorded host and live RPC session against the captured provider id. This distinction applies before confirmation, before stopping and before successor launch.

### Display and Rewind

Only the last **confirmed** boundary collapses earlier display history. The divider expands read-only history with no inline Rewind, Retry or reply footers. The count is user/assistant messages in the latest cleared segment, possibly a lower bound when older entries are unloaded; it is not OMP's native dropped-message count. Clear is not deletion. Full branches and exports retain earlier history.

Desk's global Rewind picker, page targets and host target admission all filter targets before the last confirmed boundary. Explicit branch switching and OMP's own checkpoint tools remain separate recoverability paths. Model-derived TODO projection and history-reader `todoSeed` stop at a reset boundary instead of reseeding from earlier model messages; OMP's canonical TODO state is a separate retained store described below.

### Known differences from terminal `/clear`

This inventory is not a claim to enumerate every private AgentSession field.

- **Checkpoint state:** `getBranch()` retains all ancestors; reload's `#rehydrateCheckpointRewindState` (`agent-session.ts:6739-6770,11369`) does not reset at boundaries. Old pending/completed checkpoints can remain usable or cause a model-driven rewind into earlier history. Desk filters its own Rewind UI only.
- **Session-scoped tool state:** boundary-before-reload usually makes both compared persisted contexts equal (`11253,11366-11369`). Therefore conditional clearing at `11460-11461` does not normally run. Fresh guarantees provider teardown, not `#clearSessionScopedToolState` (`6715-6724`): deferred directives, forced tool-choice queues, ACP permission decisions, announced mounts and cached tool-execution updates may remain. No additional private cast duplicates that teardown.
- **Asynchronous work:** reload does not execute native owner-scoped cancellation, delivery-epoch invalidation or async-result yield-queue clearing. Guards check running jobs, queued/in-flight delivery and registry-only agents before mutation and again before confirmation. They are not an atomic OMP transition lock; later peer messages, new asynchronous wakes or extension activity may re-enter context. Desk does not promise all old work is cancelled.
- **Foreground bash/eval:** Native clear refuses foreground bash/eval. Neither public `ctx.isIdle()` nor RPC `get_state.isSettled` observes those foreground-running flags (`agent-session.ts:5783,7985`; `rpc-session-settle.ts:43-50`). Desk therefore cannot infer their absence from settled readback alone. Reload signals cancellation, but completion output may still be recorded after the boundary (`eval-runner.ts:109-131`, `bash-runner.ts:196-249`); signaling cancellation does not establish exclusion.
- **Approved plan reference:** native clear resets `#planReferenceSent` (`5831-5837`); same-file reload/fresh does not. Approved-plan content dropped from messages may not be reinjected on the next turn (`#buildPlanReferenceMessage:6898-6902`). The plan file itself survives.
- **Capabilities:** native clear calls `resetCapabilities` (`5851`); this composition does not. Cached capabilities may carry over.
- **Advisor costs:** reload resets advisor state with `preserveCost:true` (`11382`), whereas native clear resets without preservation (`5841`). Costs can remain visible across clear.
- **Memory:** same-file reload skips `resetContextForNewTranscript`, retaining transcript-scoped tracking/counters and not requesting the new-transcript Hindsight mental-model refresh (`11457-11459`, `session-memory.ts:208-240`). It attempts `refreshBaseSystemPrompt` before returning; a committed canonical rebuild clears promotion snapshot (`session-tools.ts:1947-1952,1997-2007`). Refresh errors are logged without failing the switch (`11473-11481`). Fresh rekeys memory to its new provider id. Canonical configured memory may remain; clear is not memory erasure and a marker/context ring proves no memory-reset parity.
- **TODO:** OMP reload's todo tracker rehydrates canonical phases from the full branch (`todo-tracker.ts:104-105`, `tools/todo.ts:252-257`) without stopping at reset boundaries; native reset also does not erase canonical TODO. Canonical TODO/reminders may remain even though Desk's model-message-derived TODO begins empty.
- **`/btw` and goals:** extension reload closes the side conversation and quiesces/reattaches goals (`rpc-mode.ts:1623-1642`), which is not native clear's path. Goal activity can resume after this transition.
- **Compaction:** Desk refuses active compaction; TUI clear first aborts compaction and waits (`command-controller.ts:1245-1251`).
- **Usage/accounting:** Context usage is refreshed from OMP but need not become zero: the system prompt, tools, project context and canonical memory still consume tokens. Active `model_usage` accounting honors reset boundaries; durable full-history usage remains retained. Unlike reload alone, the explicit fresh phase invalidates append-only context.

### Dependency and replacement

Missing `appendResetBoundary` or `reload` is detected before mutation. Callable presence is not semantic compatibility, atomicity or complete reset behavior; signature-compatible upstream changes can weaken behavior. An upstream resetSessionContext-backed RPC/API would replace this composition only with explicit provider-id acceptance and renewed teardown/failure evidence. `RpcSession.clear` remains the page-facing interface.

### `/new`

Replacement admission is once per old conversation. The host shares clear/navigation's mutation admission; the extension fences the captured old runtime/editor before its first await and serializes replacement by conversation. It creates a draft in the same folder and opens the replacement in the same column in this window (a deliberate exception to ADR-0057 launch routing). Before an unconfirmed graceful stop, the lifecycle gate rechecks the authoritative **observed RPC settled predicate**, not proof that every independently running foreground command stopped, and captured runtime/file/provider-id/epoch. A concurrent clear/navigation/replacement or newly running turn refuses. Exact-child graceful stop and explicit Force Stop confirmation remain unchanged. If the new editor opens but the old process cannot be stopped, retain the old editor and report that partial outcome. A stopped saved session remains resumable; an unsaved draft is not promised to become a resumable saved session.

### `/delete`

Reuse confirmed Delete Session (`confirmAndDeleteSession`, ADR-0027/0039), and only after successful exact-file deletion create a new session in the old editor's column. Cancellation/refusal creates no successor. A successor launch failure cannot undo deletion and is reported.

### `/fresh` and interception

Plain `/fresh` is allowed through the same fenced, accepted-provider-rotation path. It rotates provider state without removing local conversation messages. All four leading tokens are intercepted by Chat; arguments are refused. `/clear`, `/new`, `/delete` and internal extension command names remain in the low-level deny list; `/fresh` leaves it and its obsolete denial sentence is removed. Autocomplete offers Desk descriptions. No command is described as terminal-clear parity.

### Amendments

- ADR-0038 §8 / ADR-0003 via ADR-0051: a second RPC-only extension command; mutations travel over broker-owned RPC stdin, never the read-only host-control pipe.
- ADR-0052: clear/new leave terminal-only guidance; delete leaves identity-command refusal; fresh accepts deliberate provider-only identity rotation.
- ADR-0051: Desk Rewind targets now stop at confirmed clear boundaries; branch history remains recoverable.

## Consequences

The same durable file/editor/title/model survive a successful clear. Provider sessions are closed and their id rotates. Confirmed history display survives Reload Window. No private AgentSession teardown is copied.

The admission fence belongs to one RpcSession; Reload Window/input-owner transfer does not recover an in-flight fence. Such a command can outlive admission. An unmarked boundary remains visible with provenance-neutral wording after reattach, not a falsely clean transcript or a falsely attributed Desk failure. This clear-specific residual race remains disclosed and unapproved by the pending architecture review; ADR-0051's prior acceptance does not establish reset parity. One custom marker is persisted per confirmed clear. Background work is refused, not cancelled.

A separate recovery window exists after OMP rotates its provider id but before Desk durably records acceptance. If the host/window ends in that interval, the surviving child reports an id different from the recorded one and reattachment fails closed. Recovering this case without accepting unrelated rotations requires process/file-bound operation evidence; the ordinary loss-of-fence disclosure does not cover it. The selected policy is **no persisted rotation intent and no broad same-file mismatch acceptance**. Recovery requires explicitly stopping the exact surviving child and reopening the same saved conversation; ordinary reattach must not accept its divergent identity. The Chat Restart action is currently restricted to unanswered native-state requests and is not itself an identity-mismatch recovery action. Main must confirm this fail-closed policy and the supported Stop/reopen workflow before architecture acceptance.

An isolated installed-OMP RPC probe (2026-10-11; explicit temporary extension and journal, dummy model key, no model start) observed the real no-data admission/completion pair for prepare and confirm, and fresh's no-data success plus true/aborted/settled result. Waiting for handler completion before advancing produced two successive boundary/fresh/marker sequences on the same file, with distinct rotated provider ids, unchanged durable header id and retained pre-clear journal entry. This exercised the native command composition, not VS Code, the broker/catalog acceptance integration or a live provider connection. The isolated process and temporary fixtures were removed.

## Related Documents

- [ADR-0051](0051-rewind-chat-in-place-through-a-desk-registered-omp-command.md), [ADR-0052](0052-answer-terminal-only-commands-and-restore-the-queue-on-stop.md), [ADR-0053](0053-merge-a-desk-published-registry-liveness-signal-into-the-agents-row.md), [ADR-0038](0038-host-chat-over-rpc-ui-on-a-broker-pipe-child.md), [ADR-0027](0027-delete-discovered-history-under-exclusive-extension-claim.md), [ADR-0039](0039-refuse-only-on-a-verified-live-writer-the-extension-owns.md), [ADR-0003](0003-native-host-control-pipe.md).

## Architecture Review

- Reviewer: independent architecture reviewer inspected rounds 1–4 and OMP 18.8.5 source.
- Outcome: accept with changes: implementation blockers resolved; Main policy approval remains outstanding.
- Notes: Rounds 1–3 rejected earlier implementations (boundary-plus-reload alone; the /fresh and extension-command acknowledgement shapes; identity commit and Restart separation). Round 4 closes tentative provider-identity leakage into queued catalog snapshots and completes the durable/provider identity separation in Restart; no further architectural blocker was identified in the scoped re-review. Final acceptance requires Main approval of the disclosed loss of in-flight admission fencing across Reload Window and of the fail-closed rotation-before-commit recovery (Stop the exact surviving child, then reopen). The reviewer performed no executable checks.
