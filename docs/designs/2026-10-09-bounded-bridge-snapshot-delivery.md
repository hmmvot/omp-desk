---
status: accepted
date: 2026-10-09
---

# Bounded bridge snapshot delivery after reload

## Evidence and scope

A real listener/client reproduction with ChatRuntime's bridge-first route ACK sends an 80-row synthetic snapshot exceeding 1 MiB. Before this repair it fails with `outbound-queue` in `Session.#sealAndWrite`, called synchronously by `ChatRuntime.#sendSnapshot`. Authentication resets reconnect backoff, so identical replay can repeat indefinitely. This matches the reported reload log; no native process restart is needed to repair the transport.

Read-only production history-reader measurements also found ordinary snapshot rows larger than a frame: 103 current-window rows exceeded 256 KiB, with a 953,582-byte tool-result maximum. Resolved image-bearing rows reached 929,998 bytes. Truncating these rows or only surfacing an oversize error would break ordinary screenshots and tool results.

## Panel availability

The panel `postMessage` route carries large rows when a live, acknowledged panel exists. It is not a universal alternative: ADR-0023 explicitly supports an already-resolved page surviving Restart Extensions without a new `WebviewPanel` handle. VS Code has no public API to recover that handle. Reload Window may bind a panel eventually, but bridge authentication and route ACK can precede serializer/native attach. A stale remembered panel route is not proof of a current host channel. Therefore retain the panel path where it is actually acknowledged, and make the bridge independently capable of complete snapshot delivery. Do not guess a fallback panel exists or replace the user's editor.

## Ordered sender

Keep the authenticated wire grammar, 256 KiB sealed plaintext ceiling and 1 MiB serialized outbound frame budget. Add a snapshot-train admission path: the runtime hands an iterable of snapshot DTOs to the exact acknowledged session. The writer produces one frame at a time and awaits the socket write callback before advancing. Each write has an absolute five-second deadline; a non-reading peer fills finite platform buffers, stalls the callback and is closed. Ordinary live pushes remain admitted by serialized plaintext bytes. Include the current snapshot frame in that accounting. Ciphertext/WebSocket overhead is bounded by one data frame plus one coalesced pong of at most 125 bytes. Do not release bytes just because `socket.write` accepted a buffer. Refuse fragmented or oversized WebSocket control frames before replying.

At most two train sources are retained: the earliest admitted train (active or waiting behind an ordinary frame) and the latest replacement. Finish the earliest train so disk-first paint cannot be starved by live hydration. A newer snapshot removes only a later wholly unsent train and appends its replacement at its actual position among ordinary messages. Live events retain their positions; no partially sent snapshot is interleaved with another. Route-generation fencing stops the old source, and closing releases all pending sources. Epoch-bound display preferences follow every complete snapshot train.

## Fragmented DTO payload

Snapshot DTOs larger than 48 KiB UTF-8 JSON use terminal-push payloads with type `omp:bridge-fragment`. Each contains a fresh canonical message token, the acknowledged route generation, zero-based index, part count, total decoded byte count and canonical standard-base64 data. Split one UTF-8 serialization into at most 128 KiB decoded parts. A part's base64 and envelope fit well below 256 KiB, including printable-ASCII and outer-frame JSON escaping. Small DTOs retain their existing payload. This changes the application vocabulary, not the authenticated/sequenced bridge grammar; guest protocol version 9 proves the page can reassemble it.

Limit one DTO to 128 MiB decoded JSON. This accommodates the history reader's existing 64 MiB image expansion budget (about 85 MiB after base64) with metadata headroom. The sender retains at most one bounded encoded DTO, not a serialized transcript or promises for all rows. Its frame queue remains at most 1 MiB. The guest retains at most one partial DTO, with a 15-second absolute reassembly deadline and at most 1024 parts. Require exact message/route identity, total/count consistency, consecutive indices, canonical base64 and the declared part lengths. Refuse interleaved terminal pushes, missing/out-of-order parts, malformed JSON/UTF-8, oversized totals and stale route generations. Discard partial bytes before reporting failure; never deliver a half-built row. Clear reassembly on route change, disconnect, frame/sequence refusal and stop. Only the completely reassembled JSON value reaches the existing typed application boundary. Every fragment travels over the existing sealed, directional, sequenced connection bound to host, connection and document identities; there is no new unauthenticated path.

## Current-document capability gate

After the sealed route ACK, the v9 guest immediately sends the read-only `guest-version` request with `{protocolVersion:9, fragments:true}`. It is answered immediately without a mutation/read-slot reservation or native call. Only an exact valid announcement for this authenticated connection and acknowledged route authorizes bridge ChatRuntime attachment or terminal/snapshot pushes. Connection replacement, route reoffer and document retirement clear the proof; a fully authenticated stale-route announcement is ignored before admission. Existing handshake version 1, mutual authentication, counters and request grammar stay unchanged.

The first ACK starts one fixed five-second deadline; repeated ACKs do not extend it. Missing, malformed, incompatible or late proof never attaches ChatRuntime or enumerates a snapshot. Instead the exact session sends one small unfragmented existing `omp:chat-state`, carrying the fixed Reload Window reason and a blocked phase, directly to the old page. The v8 parser/reducer accepts it without clearing composer-local draft or retained transcript. No fragment is sent to an unproven page, no automatic reconnect is requested and no native process is restarted. Choose this explicitly disclosed read-only capability probe instead of a wire-version bump, which an old page cannot turn into an actionable explanation.

## Provider-login application operation

The separately requested provider-login UI also has to work in a surviving controlling bridge page and in a passive editor with a live panel route. Admit only the fixed `provider-login` operation, mapped from a validated `omp:chat-command` with that command name, through the existing bounded non-mutation request path. No other generic Chat command becomes bridge-enabled. Keep current document, connection-scoped v9 proof, exact route and indexed-entry checks before this branch; it may run while authenticated native attach is waiting because it sends no session command. Passive documents remain ineligible for bridge authentication and route ACK; their login action is panel-only, with no new presentation or writer authority.

The page supplies no provider, profile, cwd or command text. The host selects only that page's own session profile, or the default profile when none exists, through the same `omp.loginProvider` implementation. The operation only opens the native `omp login` terminal; it does not send commands to the conversation's OMP process, change session ownership or touch the queue. Permit the same fixed action for passive pages over their current panel channel only. Share one window-owned admission guard across all login entry points: ignore repeats while terminal creation or profile selection is pending or an already opened login terminal remains open, and release on opening failure, picker cancellation or matching terminal close. Do not replay login on reconnect.

Focused integration coverage includes passive panel login through the real passive bridge-eligibility fence, current proof/document/route rejection, rejected page-supplied arguments, actual listener/client concurrent repeats during deferred preflight, and the open-terminal guard's matching close/failure/cancellation release. The real transport regression uses a ready controlling route; authenticated-waiting admission is supported by the inspected branch but is not separately exercised there. Independent closure review accepted the additive operation under the explicit passive-panel-only contract.


## Finite recovery

After three authenticated connections fail before the 15-second heartbeat stability interval, stop automatic retries and surface an actionable fixed message: Reload Window, or copy the draft before closing and reopening the tab. Count TCP/close/frame failures as one recovery-failure class; reset backoff and the failure count after a stable connection, not on authentication. Normal long-lived reconnection remains automatic. A newly acknowledged live panel route clears the host-loss fence; stale panel knowledge cannot mask bridge failure. Do not restart OMP, replay input, or silently send through an unacknowledged fallback.

## Alternatives

Raising/removing 1 MiB admits a non-reading peer's unbounded backlog. Counting only `writableLength` loses queued crypto strings. Yielding with a timer between chunks is not backpressure. Awaiting only WebCrypto does not bound socket buffers. Splitting only between rows still fails for ordinary screenshots and tool results. Dropping tool-result `details` cannot replace fragmentation and would alter retained data. Replacing the tab or restarting OMP unnecessarily destroys working state.

## Verification

Observe the failing >1 MiB real listener/client/runtime reproduction before production edits, then successful full reassembly including a 950 KB tool-result row and a 900 KB image row across connection replacement. Cover malicious/partial fragments, stalled socket closure, ordinary queue saturation, snapshot supersession/order, preferences and finite reconnect escalation. Run typecheck, build and full npm test on the final baseline. Package and install for a real OMP 18.8.5 large-session Reload Window smoke in an isolated VS Code profile only. No user-window GUI interaction, commits, pushes or removal of test profiles.

## Architecture review

Independent architecture closure review accepted the amended design on 2026-10-09 after resolving the current-document capability gate, wire-size/count evidence and serialization-retention findings. The reviewer inspected the fixed sender, host/guest gate, old-page recovery and integration regressions and reported no material architecture issues. Acceptance is architecture-only; final checks and installed runtime verification remain separate.

The subsequent provider-login closure review accepted the fixed bounded non-mutation admission and passive-panel-only scope on the final inspected source. The reviewer inspected the actual endpoint/listener/client repeat regression and real passive eligibility predicate, confirmed the shared preflight/terminal-lifetime guard and host-selected profile, and reported no remaining material findings. The old-page recovery payload now uses the existing typed chat-state, including required `sessionId:null`; its parser was not relaxed. Source/design acceptance is separate from executed checks and installed GUI acceptance.
