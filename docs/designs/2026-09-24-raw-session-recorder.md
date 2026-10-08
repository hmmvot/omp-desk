---
status: superseded
date: 2026-09-24
---

# Record the Consented Collab Receive Stream in a Session-Bound Private Store

> Superseded by [ADR-0038](../decisions/0038-host-chat-over-rpc-ui-on-a-broker-pipe-child.md) and its [RPC-UI chat and Sessions design](2026-09-29-rpc-ui-chat-and-sessions.md): the raw Collab recorder is removed with Collab. Preserved as history; ADR-0014 and ADR-0016 are superseded with it.

## Problem

The [development design](2026-09-24-omp-vscode-development.md) includes **Raw unredacted stream, viewer and deletion**: inspect and clear one session without leaking another. Recorder UIs in comparable extensions provide useful recorder/viewer UX, but their global enablement and unbounded persistence are not this project's sensitive-data contract.

This proposal records **what this extension's existing guest actually receives**, not everything OMP or a provider exchanges. “Raw” means that retained inbound payloads receive no additional redaction, rewriting or summarization. Missing, oversized and disconnected intervals are explicitly incomplete. Native replication can already omit or reduce content before it reaches the guest [O4, O5].

**Recommendation:** use opt-in extension-side capture of decrypted inbound Collab frames and an extension-owned read-only text viewer. Do not add native provider instrumentation or use `/record` as a misleading substitute. Native raw SSE diagnostics exist, but do not match this persistent, consented receive-stream contract [O1–O3].

## Goals and Non-goals

### Goals

- Explicitly enable recording for exactly one identified workspace/session and recording epoch; default off.
- Preserve the received plaintext payload exactly for each admitted frame, including sensitive content.
- Bound capture memory, bridge traffic, storage, record count, viewer reads and retention.
- Show source, identity, completeness, start/stop times, limits and expiry alongside the payload.
- Disable without deleting; delete only after positive proof that all exact storage producers of the target epochs are stopped or irreversibly fenced and drained.
- Prevent one panel, stale callback or restored viewer from resolving another session's recording.
- Expire each epoch independently without stopping, deleting or revoking consent for another unexpired epoch.

### Non-goals

- Full provider HTTP/SSE/WebSocket recording, outgoing prompts or guest `hello`, native control authentication, room keys, write tokens, terminal output, workspace snapshots, arbitrary session artifacts or replay into an agent.
- A second hidden Collab guest, relay decryption, new native hooks or changes to OMP core.
- Recording while no existing guest receives frames, retroactive recovery of missed traffic, a complete child-session recording, or cryptographic proof that a Webview-reported frame came from a particular model.
- Upload, sharing, automatic export, secure erasure of backups, or suppression of OMP's independent native diagnostics.

## Current State

### Project observations

These are source observations against a changing working tree, not runtime acceptance. Line references describe the inspected source and may shift under concurrent edits; revalidate the named functions before implementation.

- `src/webview/lib/socket.ts:142–183` opens encrypted frames in receive order and calls `onFrame`; `src/webview/lib/codec.ts:42–51` currently parses plaintext JSON and returns only the parsed value. Exact plaintext capture therefore requires a small optional receive tap, not serialization of an already-mutated UI object.
- `src/webview/lib/socket.ts:187–225` distinguishes retryable close events from terminal failures. The recorder must likewise distinguish a temporary pause from final closure rather than promising that all disconnects permanently stop recording.
- `src/webview/lib/client.ts:392–438` adopts a welcome header and handles chunked snapshot state. The recorder must separately bind that header to the extension's expected session; successful decryption alone is not the recording identity check.
- `src/webview/bridge.ts:1–17,72–107` provides the existing checked message transport and deliberately does not persist Webview state. `src/host/guest-webview.ts:59–84` restricts guest networking through CSP.
- `src/host/native-file-observation-storage.ts:130–183,355–493,507–564` provides namespace derivation and private-storage verification/restriction patterns. Windows access is limited to the owning account plus SYSTEM and Administrators, not literally to one account alone.
- The inspected `producerStopProof`, `fileEvidenceDeletionRefusal` and `disableFileEvidence` in `src/extension.ts` separate durable disablement from positive producer-stop proof (initial inspection: lines 3384–3489 and 3838–3868). Native evidence cannot be deleted just because a registry entry disappeared. Its low-level deletion helper does not itself establish that proof (`src/host/native-file-observation-storage.ts:871–909`).
- The inspected `deleteSession` flow revalidates ownership before and after confirmation (`src/extension.ts:526–604` at initial inspection). Its exact integration points must be rechecked before implementation because that code is being developed concurrently.

### Installed OMP evidence and native-facility decision

All **O** references below are to the inspected installation, not an assumed upstream checkout. Let **P** be the globally installed `@oh-my-pi/pi-coding-agent` package (under Bun's global `node_modules`); `P/package.json:1–3` identifies version **18.3.0**. This is the evidence baseline, not a new runtime version gate.

| Reference | Inspected source | What it establishes |
| --- | --- | --- |
| O1 | `P/src/stream/recording.ts:1–19,57–89,132–205`; `P/src/modes/interactive-mode.ts:6655–6685` | `/record` records normalized, redacted TUI paint frames to `.ompcast`; startup loads `StreamRedactor`. The default directory is temporary `omp-recordings`. This is not an unredacted provider or Collab stream. |
| O2 | `P/src/commands/play.ts:11–43` | `omp play` replays screen recordings in an interactive terminal. Without a filename it selects the newest recording, not the extension's selected session. Never use that implicit selection for a session-bound viewer. |
| O3 | `P/src/session/agent-session.ts:1564–1596,4991–5005,5052–5058`; `P/src/debug/index.ts:375–396,572–575`; `P/src/debug/report-bundle.ts:68–83,119–123` | Native provider response/raw SSE capture **does exist** in a session diagnostic buffer. Native debug UI can display it; a report can contain `raw-sse.txt`. Disposal detaches interceptors and later clears the buffer. These paths do not establish an opt-in persistent Collab recorder with this proposal's consent, ACL, retention and deletion contract. |
| O4 | `P/src/collab/protocol.ts:1–7,50–96`; `P/src/collab/host.ts:430–455,731–768` | Collab carries encrypted session projections: welcome, snapshot chunks, entries, events, state, Hub and UI traffic. Host events/entries are filtered and shrunk, and large welcome snapshots can lose images. Recording that receive stream does not recover the original provider exchange. |
| O5 | `P/src/collab/replication-shrink.ts:33–56,69–95` | Replication may replace oversized content with typed placeholders; its payload ceiling is 1 MiB, which is not a promise that every outer frame fits that exact size. |
| O6 | `P/src/collab/host.ts:236–238,582–647,718–720`; `P/src/session/session-entries.ts:35–53` | Rooms retain a session identity, host traffic is guarded against a different active session, and welcome includes a session header with an ID. Recording must still validate its own binding and fence queued work across transitions. |
| O7 | `P/src/session/session-entries.ts:35–78`; `P/src/session/artifacts.ts:1–5,65–74` | Native history contains typed session/message entries; artifacts store outputs alongside a session and can be shared by the parent/subagent tree. Neither is evidence of a complete original receive stream or a separately consented recording. |
| O8 | `P/src/collab/host.ts:1018–1036,1097–1135` | Agent snapshots enumerate the non-advisor native registry, and transcript replies read the requested registered agent. These frames can contain information beyond the parent transcript. The recorder must describe them as data received in this room, not independently prove parent-only ancestry. |

For O3, the imported installed dependency is also inspected: the globally installed `@oh-my-pi/pi-tui` package's `src/apps/debug/raw-sse-buffer.ts:4–13,189–218,253–255,305–307,374–391` bounds the diagnostic tail to 1,000 records/512,000 characters and trims individual oversized events. It is useful native provider debugging, not a durable exact receive-stream archive.

**Native-first conclusion:** none of the inspected native facilities matches this request. Keep native screen playback and provider diagnostics native; do not automatically start them, export reports, scrape their UI or copy their artifacts. If the user wants provider-wire debugging rather than extension-received traffic, that is a different product contract, not an alternate label for this feature.

Prior art: recorder UIs in comparable extensions. Reuse the concepts of visible capture state, sequence-based inspection and coordinated cleanup, not their global opt-in, pending-session rebinding or unlimited disk history.

## Proposed Design

### 1. Source and runtime ownership

Use **inbound Collab only**. Host-control responses may establish identity and lifecycle facts, but this recorder does not store host-control bodies or authentication traffic. This keeps the source precise and avoids adding a second content channel merely because it is available.

Data flow:

1. The existing socket decrypts an inbound frame.
2. While enabled, an optional receive tap retains the original plaintext bytes before JSON parsing/reducer mutation. It checks the per-frame bound before copying or encoding. Normal guest delivery is unchanged and never waits for disk or a recorder acknowledgement.
3. After the connection's welcome identity is accepted, the tap submits admitted frames through a bounded, credit-controlled bridge to its owning extension-host panel handler.
4. The extension host validates the sender binding and recording epoch, assigns committed sequence numbers, and serializes writes to that epoch's private store.
5. A read-only document provider pages committed records. No stored payload is sent back to a chat Webview.

Preserve exact plaintext bytes using a byte-preserving representation, such as base64 inside versioned JSONL. Store byte length and a digest; decode only for viewing. Do not stringify the parsed `HostFrame` and call that the exact original. Plaintext payloads remain unredacted even when their fields contain credentials.

Only inbound payloads from the established guest connection are eligible. Outgoing `hello`/write-token traffic, links, crypto keys, pipe bootstrap, relay control messages and arbitrary Webview messages are outside this source contract, not silently redacted portions of a supposedly complete log. Malformed or unauthenticated traffic yields a fixed reason/count, never a body dump.

### 2. Identity, consent and transitions

The immutable binding includes extension profile/storage identity, owner, launch slot, verified native process generation and room identity, normalized workspace, canonical session-file identity and native session ID. Room identity here is the room id the session's own generation-bound link addresses — what the guest actually joins — and never the native host's process identity ([ADR-0016](../decisions/0016-bind-recording-to-link-room-identity.md)). Add a fresh recorder epoch, extension-host process generation, panel document generation and connection generation. Paths and IDs come from extension-owned records, never from a capture message or the active editor at read time.

Recording is unavailable until that binding is known and agrees with the welcome header. A draft without a known canonical session is not recorded and later relabelled. A copied transcript, another launch slot, a fork or a changed native session does not inherit consent.

Before enabling, show the exact session/workspace, private storage location, bounds and expiry in an extension-owned confirmation. Proposed wording:

> Record the unredacted data this OMP guest receives for this session? This may include prompts, replies, reasoning, tool inputs/results, source code, paths, credentials, images and Agent Hub data. A reconnect can send earlier conversation history; received data can describe operations you later deny. No additional secret masking is applied. This is not a complete provider-wire recording.
>
> A temporary disconnect pauses capture. Capture automatically resumes only after the same pinned room, host and session have been re-verified, while this recording epoch is still open, consented and unexpired. The disconnected interval is not recovered; a reconnect may record history sent again by the host.
>
> Stop Recording, deletion, expiry, a reached limit, a storage or terminal connection failure, a changed identity, the session ending, closing the guest panel, or reloading the extension permanently closes this recording epoch. Recording after a final stop requires a new explicit confirmation; reconnect cannot reopen a closed epoch.
>
> Data is stored outside the workspace with access restricted to your Windows account, SYSTEM and Administrators. Same-user software and backups may still copy it. Recording is limited to 64 MiB per session and expires seven days after each recording epoch starts. Stop Recording keeps retained data until its expiry or deletion. Delete Recording removes this session's extension recordings after their writers are stopped. Continue?

The confirmation defaults to cancel. File-observation consent does not enable this recorder, and this consent does not enable file observations.

Capture starts after confirmation, storage readiness and a current binding check. Do not reconnect or fetch history merely to fill the recording. If enabled mid-connection, record subsequent frames plus a metadata-only binding marker; do not fabricate an earlier welcome. Future welcomes are captured only after their identity matches.

A retryable disconnect changes an open epoch from **recording** to **paused — reconnecting**; it is not Stop Recording. Reconnect to the same pinned room/host/session creates a new connection generation and a visible discontinuity. Discard old-generation callbacks before both bridge admission and publication. No payload from a new connection is persisted until its welcome matches. Automatic return to **recording** additionally requires that the original epoch remains open, its consent remains valid, no deletion/disable fence exists, storage remains ready and neither expiry nor a limit has been reached. Reconnection never extends consent or expiry.

A mismatch, changed room/host/session, terminal bye or connection failure, panel disposal, extension-host reload, explicit stop/delete, expiry, storage failure or reached capture limit finally closes the epoch. A final stop cannot be undone by a late reconnect. Reload starts capture off; previously enabled consent is historical, not authority to resume silently. A new recording after final closure requires new explicit consent and a new epoch.

Snapshots and reconnect repeats remain raw received frames, not deduplicated model output. Show them as snapshot/reconnect data. Agent Hub/transcript frames remain scoped to the room that received them, with the O8 disclosure; do not index them as another session's recording.

### 3. Bounded publication and failure behavior

Initial fixed policy, disclosed before capture:

| Resource | Bound and behavior |
| --- | --- |
| One plaintext frame | 2 MiB; omit the whole oversized frame, append a metadata-only omission/stop reason and stop this epoch. Never store a chopped payload as raw. |
| One serialized record | 3 MiB including base64 and envelope; reserve size before publication. |
| Bridge and write backlog | At most 4 MiB and 128 uncommitted records per recorder, including outstanding bridge messages; byte credits are returned only after commit/discard. No unbounded promise chain. |
| Additional capture memory | At most 16 MiB of admitted queues per extension-host process; allocation/encoding reservations are included. Existing normal guest decode memory is not claimed as recorder memory. |
| Session storage | 64 MiB and 10,000 records across retained epochs, including temporary files, manifests and metadata. |
| Profile storage | 256 MiB and 128 retained session namespaces across windows; shared reservations enforce this before writes. |
| Terminal metadata reserve | 64 KiB within, not in addition to, the session limit; fixed-size markers and counters cannot recursively log failures. |
| Retention | Fixed expiry seven days after an epoch starts, not extended by reads, reconnects or further frames. Expiry targets that epoch, not other unexpired epochs of its session. |
| Viewer request | At most 100 records and 512 KiB; a large individual record is displayed in labelled byte ranges rather than read as an unlimited page. |

Admission uses exact encoded-size accounting, not character counts. Crossing any byte/count/backlog limit stops only the affected recorder, without delaying, aborting or changing the native session. Storage failure produces a metadata-only UI status; if a final marker cannot be committed, the next reader reports an incomplete epoch rather than claiming a clean stop.

Use one serialized writer per epoch, with a cross-window storage coordinator for namespace creation, byte reservations and deletion. Reuse the project's process-generation ownership/claim principles, but do not claim that a transcript claim alone protects this storage. A live or uncertain owner cannot be displaced by a timeout or by an empty registry. Unknown reservations count against capacity until ownership is resolved. Capacity exhaustion refuses enablement or stops capture; it never silently evicts an unrelated unexpired recording.

Segment JSONL into bounded immutable committed units with manifests. Commit payload segments before publishing their manifest entries. Account for temporary and committed copies, reject duplicate/out-of-order submissions within an epoch, and recover only validated committed segments. A hash detects corruption, not a malicious same-user writer. Do not promise power-loss durability from rename alone.

### 4. Private storage and secrets

Use a separate feature root under extension-owned private storage, outside all workspace roots and separate from native session/artifact directories. Derive owner/slot/workspace/session namespaces from the bound identities, with recording epochs below them. Hashes in names are addressing aids, not anonymization or authorization.

Reuse the storage verification/restriction implementation from native file observation, extracting only the shared private-directory mechanics if necessary. Do not reuse its observation schema, consent file or workspace-wide disable marker as a raw-recorder switch. Raw disablement is session/epoch-specific, and expiry revocation is always epoch-specific. Store consent and immutable manifests per epoch so removal of one epoch cannot erase another epoch's consent or binding. Verify the actual raw root, descendants and created files; reject unsupported links/reparse paths, arbitrary paths, permissive ACLs and unreadable storage facts. A failed ACL adjustment leaves capture off. Recheck storage binding and access on reopening and before reads.

Persist consent version, immutable identity, limits, expiry, writer identity and terminal reason. Store no room key, Collab URL, write token, pipe secret or bootstrap material as metadata. Payload content may itself contain secrets; it is intentionally not sanitized. Never copy payloads into diagnostics, telemetry, error messages, Memento, Webview state, the session index, source maps or the workspace.

This is access-controlled plaintext storage, not encrypted-at-rest storage. ACLs do not isolate malicious same-user processes, other trusted VS Code extensions, administrators or backups. The viewer must not advertise stronger protection.

### 5. Read-only viewer and session isolation

Provide session-scoped **Start Recording**, **Stop Recording**, **View Recording** and **Delete Recording** actions. Status distinguishes **recording**, **paused — reconnecting** and final stopped states; Stop Recording remains available while paused. Stopping leaves View/Delete available while retained data exists. No global “enable all future chats” setting is introduced.

Use the existing extension-owned read-only document pattern, with a new `omp-raw:` URI scheme and bounded page/record selection commands. Render payload as literal text, not HTML, Markdown, links, images or executable terminal control sequences. The page header identifies the session, epoch, source, connection, timestamps, completeness, size and expiry. Label control-character escapes and byte-range presentation as viewer formatting; stored bytes remain unchanged.

A URI contains only opaque identifiers. Its provider resolves an immutable server-side recording binding and validates namespace, manifest identity, sequence, digest, size, expiry and deletion state on every read. It never selects data by the active tab, session title, “latest recording”, caller-provided path or a same-ID transcript at a different canonical location. Historical views remain bound to their original session when the user changes tabs. Restored views fail closed when their binding cannot be established; they never fall back to another available recording.

The Webview bridge accepts capture only from the actual panel receiver associated with that epoch. A session ID supplied by a Webview cannot authorize a read or write. The Webview can request the host-owned View action for its own session but receives no stored payload, recording manifest, filesystem location or cross-session listing. Existing live Collab content is not confused with access to retained recordings.

On deletion or expiry, revoke URI resolution, clear extension caches and refresh/close raw documents for the transaction's target epochs before reporting completion. An unexpired non-target epoch's URI remains valid. A session inventory may refresh its metadata to show an expired/deleted epoch, but must not revoke other epochs' documents. Already copied text, external saves and editor/process memory cannot be recalled. Do not provide automatic export or clipboard copying; ordinary explicit user copying is outside the retention guarantee.

### 6. Stop, retention and deletion

**Stop Recording** durably revokes admission for the exact epoch, invalidates its bridge generation, detaches the receive tap, then drains or explicitly discards the bounded pending queue and closes all writer handles. It also works while the epoch is paused. It does not delete committed data. Re-enabling requires new explicit consent and a new epoch; it never reopens an old epoch.

#### Immutable deletion targets

Use one stop-and-delete transaction parameterized by an immutable session binding, reason and **frozen set of exact epoch identities**. Each target includes its namespace and recorded producer generation. Resolve identities from validated extension storage, not from a Webview or active-tab lookup. The transaction never broadens its set while running or retrying.

- **Manual Delete Recording:** targets all retained epochs of the selected immutable session, including any active or paused epoch. Show the binding, epochs and affected sizes in the confirmation. After confirmation, revalidate the epoch set under the coordinator. If the set changed while the dialog was open, refresh the confirmation instead of silently adding unseen epochs. Atomically freeze the confirmed set and install a manual-deletion creation guard for that session, so a new epoch cannot appear during this delete-all operation. The guard does not authorize deletion of anything outside the frozen set and ends when the manual operation completes; an unresolved manual deletion remains visibly pending rather than silently allowing replacement recording.
- **Automatic expiry:** at the sweep's cutoff, targets only epochs whose immutable expiry has been reached. Freeze those identities under the coordinator. Do not install a session-wide disable or creation guard, stop an unexpired epoch, or invalidate its consent. An epoch that expires after the cutoff belongs to a later transaction; do not silently add it to this one. A brief coordinator lock to select targets/update shared accounting is not permission to disable or delete non-target epochs.

#### Shared stop-and-delete transaction

For the frozen target set only:

1. Persist durable deletion/admission fences on the target epochs. Revoke their new bridge admission and viewer access, and ask their exact live recorder owners to stop. Non-target epochs retain their capture state, consent and reader capabilities.
2. Obtain positive stop proof for every target: an owning extension host confirms irrevocable epoch revocation, a drained/discarded queue and closed handles under its fence; or the recorded OS process generation is positively proven gone and exclusive ownership of the target storage is acquired. Recheck the binding/fence and stop proof before removal. Do not unlink targets until every target producer is proven stopped; an unknown target producer keeps this transaction pending, not successful.
3. Remove only the targets' committed segments, temporary files, manifests and per-epoch consent. Verify the declared deletion targets are absent. Update shared session/profile indexes without removing non-target entries or their parent namespace. Retain bounded metadata-only epoch deletion markers as needed to reject late callbacks; they contain no payload or credentials and remain quota-accounted.
4. Release only reservations and usage for target bytes actually confirmed removed and target writers actually closed. Failed removals and surviving markers continue to count. Release a shared session-namespace slot only when no surviving epoch, reservation or retained metadata still occupies it. Never reset the whole session/profile usage because one epoch expired.
5. Report success only for completed deletion of the frozen set. On sharing violations or other failures, keep the target epochs disabled and their viewer access revoked, retain exact failure state and offer retry against the same set. Do not interpret absence of a control record, missing IPC response, panel closure, unlink attempt or timeout as successful producer shutdown. Do not stop or revoke non-target epochs to simplify recovery.

Here the **raw-file producer is the extension-host recorder**, not native OMP and not the Webview. A Webview cannot write files or reopen a fenced epoch. Thus positively closing and fencing this recorder does not require terminating native OMP. This preserves ADR-0007's no-delete-under-a-possible-writer invariant without incorrectly copying the native-file producer's process identity. Native file-observation deletion still requires its own native-producer proof; this design does not relax that rule.

#### Retention scheduling and history integration

Retention invokes the shared transaction with **expired epochs only**, not the manual delete-all target selection and not a competing garbage collector. At an epoch's expiry, its reads become unavailable immediately; if active or paused, that epoch is finally stopped before physical removal. Sweep on activation, before enable/read, and with a bounded timer while the extension is running. If VS Code is closed, removal occurs at the next activation. If stop proof or filesystem removal is unavailable, show **expired — deletion pending** for the affected epochs, keep their remaining bytes counted against quota and do not silently extend retention. New capture may be refused when remaining accounted bytes exhaust a quota; that capacity refusal is not a revocation of another epoch's consent. No background OS deletion service is proposed.

For example, E1 starts on day 0 and E2 starts on day 6 for the same session. On day 7, only E1 is an expiry target. E2 remains readable and, if active, continues recording under its existing consent until its own stop condition or day-13 expiry. E1's failed cleanup does not disable E2; its retained bytes still consume the shared quota.

Integrate raw cleanup into the session-history deletion coordinator before it forgets the identity needed to locate raw data. Full history deletion targets all retained epochs of that session and uses the manual delete-all creation guard and revalidation rules. Preflight and stop all relevant producers before unlinking anything. An unsuccessful raw cleanup must not be reported as complete session deletion. Multi-directory deletion is not atomic: report actual partial outcomes and retain the cleanup identity for retry. Deleting only a raw recording never deletes the native transcript, native artifacts, `/record` captures or debug bundles. Forgetting a launcher row is not deletion; retained recordings remain discoverable through an explicitly selected session-bound recording inventory until their own expiry or explicit deletion, without resuming that session.

## Alternatives

1. **Reuse `/record` and `omp play`.** Preferred if the requirement were native screen playback, but rejected here: redacted screen frames are the wrong source, and implicit newest-file selection is not session-safe [O1, O2].
2. **Reuse native raw SSE diagnostics or report export.** Native provider inspection already exists and should stay native. Its bounded diagnostic tail and optional report are neither the complete Collab receive stream nor this storage/consent contract [O3]. Bridging or exporting it would collect a different source and introduce additional permissions and lifecycle work.
3. **Treat session JSONL/artifacts as the raw log.** Rejected because typed history and selected artifacts cannot reconstruct received streaming frames or connection gaps [O7].
4. **Add provider hooks, log host-control frames, or connect a hidden guest.** Rejected for this assignment: these broaden collection or add unnecessary sources. Host-control bootstrap also contains capabilities that should never be swept into a generic recorder.
5. **Copy another extension's recorder or build a raw Webview panel.** Its UX is useful, but global consent, unlimited persistence and path-based rebind do not fit. A text-document viewer reuses the existing read-only surface and avoids creating a second Webview data-access boundary.

## Risks and Open Questions

- “Raw provider stream” would be a false label for this feature. UI and documentation must say **Raw Collab receive recording** and show known omissions.
- Recording can preserve earlier history from reconnects and native Hub data beyond the parent transcript [O4, O8]. These are explicit consent facts, not grounds to silently redact captured fields.
- The additional bridge and base64 encoding can affect responsiveness. Credit/byte limits and stop-on-overflow are required behavior; they must not become guest backpressure.
- Same-user software and user-created copies are outside the protection/deletion boundary. Physical removal cannot be guaranteed while the application is stopped or an exact writer remains unresolved.
- A temporary pause is not a final stop. Consent and UI must disclose conditional automatic continuation; final closure always requires fresh consent for another epoch.
- Session-level indexes and quota accounting are shared by epochs, but deletion authority is not implicitly session-wide. Expiry must never erase an unexpired epoch's consent, payloads or reader capability.
- The receive tap, read-only URI binding and deletion coordinator have since been implemented. Revalidate their integration anchors against the current source when changing those paths.
- No product choice is left unresolved by this proposal. Changing the source to provider traffic, automatic capture across reloads, global opt-in, cross-session Webview browsing, upload, session-wide deletion on one epoch's expiry, or best-effort deletion under an unknown producer requires revising the contract rather than treating it as an implementation detail.

## Rollout and Verification

This is a verification plan, not a report of tests run or permission to implement.

1. Implement the bound recorder/store and reuse private-storage checks before enabling a real capture. Exercise exact byte round-trip, non-ASCII data, malformed storage, truncated segments, missing manifests, modified digests and one-frame-over-limit behavior. Prove all disk and pending-byte accounting includes metadata, temporary files and base64 overhead.
2. Connect the receive tap and credit-controlled bridge. With two real isolated-profile sessions, enable A only and inject distinct canaries into both. Verify only A's already-received payloads are captured, normal prompting still works, and no outgoing hello/link/pipe key is copied as recorder metadata. Use a deliberately secret-looking payload to prove raw content is not redacted; do not use real credentials.
3. Exercise mid-session enablement, welcome/snapshot capture, reconnect duplicates, pre-welcome errors, protocol/decryption failure, rapid room/session changes, late decrypt completion, delayed bridge delivery, panel disposal and extension reload. Verify temporary disconnect visibly pauses capture and automatic continuation occurs only after the same room/host/session is re-verified in the still-open consented epoch. Stop, expire or delete while paused, then deliver a late successful reconnect: capture must remain off and the closed epoch must not reopen. Old-generation frames must never reach a new recording. Disabled/reloaded capture stays off. A mismatched welcome must leave no payload persisted. Check the actual consent dialog discloses this distinction.
4. Exercise sustained streaming with an intentionally slow or failing disk, maximum-size records and cross-window quota contention. Observe bounded queues and storage, visible stop reasons, no unbounded retained promises and no change to native session execution. Verify other recorders are not silently evicted to make room.
5. In an actual separate VS Code profile/window, inspect the literal read-only viewer: paging, large-record byte ranges, exact session/epoch labels, tab switching, restored URIs, control-character rendering and expired/deleted views. Attempt forged IDs/paths, cross-panel capture messages and stale viewer requests. B's panel must not receive A's stored bytes, and no Webview message should carry viewer payloads.
6. Verify Windows ACL behavior using the real storage root and created files: inherited permissive access, failed restriction, redirected/unsupported roots and link substitution must fail closed. Check that errors and diagnostics contain no canary payload or capability values.
7. Delete while writes and bridge messages are in flight; test stop acknowledgement, crashed extension host, PID reuse, missing owner metadata, IPC timeout, another live window, filesystem sharing violations and partial deletion. A late callback cannot recreate a deleted epoch. Unknown producer state must refuse physical deletion and remain visible. Change the manual-deletion epoch set while confirmation is open and verify re-confirmation rather than deletion of unseen epochs. Verify retries keep the original frozen target set.
8. Advance time across expiry while active, paused, after reload and with VS Code closed. Verify stop-before-remove, inaccessible expired content, truthful deletion-pending state and continued quota accounting. Exercise raw-only deletion, launcher forgetting and full history deletion without touching another session or independent native recordings.
9. For one session, create E1 on day 0 and E2 on day 6, with E2 still actively capturing. At day 7, verify expiry selects only E1: E1's admission/URI is revoked, its producer is stopped and only its files/consent are removed; E2's capture, consent, viewer, payloads, expiry and accounted bytes remain unchanged. Repeat with E1's producer unknown and with an E1 deletion failure: E2 must not be stopped or revoked, while E1's surviving bytes remain quota-accounted. Then manually delete the session's recordings and verify that the confirmed frozen set includes every retained epoch, including E2, and that no new epoch can race that manual delete-all operation.

Focused regression tests cover consumer-visible identity, ordering, boundary, stop/delete and failure behavior. Actual VS Code rendering, Windows access controls, cross-window ownership and live guest flow also require runtime scenarios. The implementation evidence and remaining live limits are recorded below.

## Implementation Status

This design is the contract and its behaviour is now implemented in source: the recorder engine (policy, binding, private session-bound store, epoch admission, registry, producer-fenced deletion with preflight and the read-only page renderer), the panel receive tap and its protocol messages, and the VS Code-facing layer (`src/raw-recorder-ui.ts` plus the six commands, the `omp-raw` document provider and a retention sweep on activation and every 30 minutes). Three implementation details worth keeping explicit: `Start Recording` restricts and verifies the store's access before consent and re-derives the session, room, host and panel facts after the dialog, refusing if any changed; `View Recording` sweeps expiry before opening and flushes a live epoch so the page shows every record already accepted; and a retention pass finalizes an epoch an earlier run left open with the reason `extension-reload` only when its exact recorded writer is positively gone, never finalizing a live other window's epoch or touching its payload. Deletion proof follows the same standard: two independent signals must agree — for a foreign writer its recorded pid gone, or alive under a different kernel generation (pid reuse), with a merely reported-absent pid accepted only when the generation probe cannot read it either, and for this extension host's own pid only the registry's positive statement that no run of this process holds an open writer for that epoch. OMP's own session identity is recorded for display and is never deletion proof.

Verification has progressed beyond the first two live failures (draft promotion and a host-instance-id/Collab-room-id mix-up). A further isolated-window attempt exposed a profile-ledger bug: a real generated namespace key is 208 characters, but the reservation reader admitted only 200; the new regression reproduced the malformed-ledger refusal before the reader was corrected to validate full-length keys. On the corrected VSIX with installed OMP 18.3.0, the exact-file sessions A, B and C restored after a window reload; explicit C consent displayed the correct session/workspace and seven-day retention. A GUI prompt reached native C and returned `C-RAW-LIVE-2026-09-25`; `View Recording` showed C's exact binding and 27 decrypted inbound records / 47,744 bytes with labelled ranges and no B canary. A new B prompt returned `B-ISOLATION-2026-09-25` while C was recording; C's viewer still omitted B. `Stop Recording` wrote a `stopped-by-user` terminal marker; exact-epoch deletion removed the segment, closed the viewer and left B running with its own transcript. The final typecheck, full test suite (632 passed, one skipped, zero failed), build and VSIX packaging succeeded. These observations establish live consent/capture/view/isolation/stop/delete, not a real seven-day expiry, quota-exhaustion, in-flight failure or cross-window race; those remaining scenarios have focused tests but are not claimed as observed in this window.

Deliberate implementation choices worth keeping visible: one session's epochs can live under more than one namespace (a relaunch slot or an earlier window generation), so listing and deletion resolve namespaces by session id and workspace digest and freeze their union; profile-wide capacity is reserved under a shared coordinator before each write, while the published accounting snapshot can lag by up to 250 ms without softening admission limits; and the tap retains the exact decrypted bytes of a frame that parsed, so malformed traffic is never stored — the retained bytes are the pre-parse buffer, not a re-serialization, and the design's "before parse" requirement is met in substance rather than by handing malformed bodies to the recorder.


## Related Decisions

- [ADR-0002: Local Collab guest for native OMP GUI](../decisions/0002-local-collab-gui-native-omp.md).
- [ADR-0006: Host-generated key over a peer-verified pipe](../decisions/0006-host-generated-key-peer-verified-pipe.md) — same-user trust boundary; do not record bootstrap capabilities.
- [ADR-0007: Native file evidence with guarded restore](../decisions/0007-native-file-evidence-and-guarded-restore.md) — scoped sensitive capture, finite storage, disablement and producer-safe deletion.
- [Native file observation and reversibility design](2026-09-24-native-file-observation-and-reversibility.md) — reuse storage protections, not observation semantics or consent.
- [Development design](2026-09-24-omp-vscode-development.md) — parity row addressed by this proposal.

## Architecture Review

- Reviewer: independent architect review.
- Outcome: **accept after corrections**; document remains `proposed` pending the maintainer's disposition. Review result: an independent review, stage `independent-review-1`.
- Reviewed baseline: SHA-256 `e6c8dff28d5a2b9c643f647daa8bd69e5494ccc671ed0ee6eb5f680d84958250` of the pre-correction document.
- F1, P2 — consent mixed temporary disconnect with final stop. Resolved in the consent text, transition rules, visible states and verification scenario: a retryable disconnect pauses a still-open epoch; automatic continuation requires re-verification of the same room/host/session and continuing consent, storage readiness and unexpired/unfenced status. Final closure requires fresh consent for a new epoch; late reconnect cannot reopen it.
- F2, P2 — reuse of the delete-all transaction made per-epoch retention ambiguous. Resolved by parameterizing the shared transaction with a frozen exact epoch set: manual deletion targets all confirmed retained epochs; expiry targets only expired epochs at its cutoff. Admission fences, stop proofs, URI/cache revocation, file/consent removal and quota release are target-scoped. Shared indexes and unexpired epochs survive. Added the two-epoch day-0/day-6/day-7 scenario, including unknown-producer and failed-deletion cases.
- Re-review (same independent reviewer, stage `independent-review-2`, corrected text SHA-256 `c694fcaa84dc626f4708891fc2df9a674b0507a6e4ff1086b7ff125b8345092e`): F1 and F2 **resolved**, no new material issues; recommendation "accept as-is". Accepted as a design only; it is not implemented and its runtime/security verification is open.
- The independent review found no fundamental objection to the source choice, native-first comparison, session isolation, ACL/Webview boundary or producer-safe deletion approach. No implementation, runtime verification or parity acceptance is claimed.
