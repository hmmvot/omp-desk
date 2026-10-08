---
status: rejected
date: 2026-09-24
---

# ADR-0013: Query VS Code language providers through authenticated reverse RPC on the existing host-control pipe

## Context and Problem Statement

The [language-provider bridge design](../designs/2026-09-24-vscode-language-provider-bridge.md), accepted as a design at the time and later rejected with this record, distinguishes generic language-server assistance from querying the providers and editor state of the associated VS Code workspace. Native OMP `lsp` remains the tool for the former. The latter requires a bridge from the existing native OMP process to the VS Code extension host.

[ADR-0003](0003-native-host-control-pipe.md) establishes a narrow native-owned host-control protocol, with the bootstrap and peer-verification requirements of [ADR-0006](0006-host-generated-key-peer-verified-pipe.md). Its ordinary control requests do not implicitly authorize server-originated provider calls. This record proposes that lasting protocol extension explicitly; it does not claim that a duplex pipe already implements reverse RPC.

The accepted design remains the authority for operation schemas, normalization, bounds, lifecycle and future verification. This ADR adds no operations or permissions beyond it. The bridge remains unimplemented and this ADR remains `proposed`; neither this draft nor the design is evidence of runtime/security verification. *(Decision later reversed by the user — see Reversal below: language tools are native OMP `lsp` only, and the source written against this proposal was removed.)*

### Installed OMP evidence

All OMP paths in this section are relative to the installed **`@oh-my-pi/pi-coding-agent`** package. Its `package.json:1-3` declares **18.3.0**. These are inspected source contracts, not runtime proof or a numeric runtime compatibility gate.

| Basis for the decision | Installed source evidence |
|---|---|
| Native `lsp` already covers the requested semantic categories. | `src/lsp/types.ts:8-21` declares the action schema. `src/lsp/tool.ts:267-278,317-330` handles diagnostics; `983-1006` workspace symbols; `1208-1229` definitions; `1282-1303` references; `1331-1346` hover; `1457-1485` document symbols. |
| That path does not establish equivalence to VS Code providers or dirty editor buffers. | `src/lsp/tool.ts:1141-1165` selects an OMP-configured server and reconciles the target. `src/lsp/client.ts:1063-1086` obtains a shared transport or spawns the configured command; `1355-1409` reconciles from disk, with an exception for OMP's own pending writes. This is a different input path, not a claim about every external server configuration. |
| The existing native extension can register a separately named tool, with a schema, read approval and asynchronous execution. | `src/extensibility/extensions/types.ts:604-649,1306-1307`; `src/extensibility/extensions/loader.ts:216-224,437-456`. `src/extensibility/extensions/wrapper.ts:68-93` forwards the execution AbortSignal. No second SDK session is needed for this registration route. |
| Registration does not guarantee provider-visible availability in every session. | `src/extensibility/extensions/types.ts:613-619` describes presentation and inactive/hidden controls; `src/sdk.ts:2963-2983,3458-3493` gathers registrations and applies restricted-caller and initial-selection rules. |
| Normal tool results participate in Collab replication. | `src/collab/host.ts:79-103,430-455` admits tool-execution/message events and message entries to replication. `src/collab/replication-shrink.ts:1-56` defines payload-size reduction, not a confidentiality filter for provider text. |

## Considered Options

- **Native `lsp` only.** Lowest complexity and appropriate for generic semantic assistance. It does not establish the required VS Code-provider provenance, dirty-buffer state or editor diagnostic snapshot. Choosing it instead would require the product owner to change the accepted requirement explicitly.
- **Authenticated reverse RPC over the existing peer-verified pipe — recommended.** Reuses the native-owned endpoint, existing host ownership and ADR-0006 peer/key proof. Requires a deliberate bidirectional protocol extension with replay protection, independent correlation and bounded resource accounting; it does not require another native session writer or OMP core changes.
- **Separate IPC channel.** Could separate language traffic from control traffic, but adds another endpoint lifecycle, authentication, identity binding, reload association and failure surface. A VS Code-owned listener disappears on reload and requires safe rediscovery by the surviving native host. The accepted design identifies no requirement justifying that extra channel. An unauthenticated loopback shortcut is unacceptable; another channel would not prevent ordinary tool-result disclosure or fix generation-local resource accounting.

## Decision Outcome

Propose a **narrow extension of ADR-0003**: carry authenticated provider attachment, request, result/error and cancellation frames over the existing **ADR-0006 peer-verified named pipe**. Preserve ADR-0003's existing controls and mutation ledger, ADR-0009's `listTools` extension, ADR-0006's trust boundary and credential/ownership requirements, and the separately limited model/thinking transition policy. This is not a wholesale replacement of those decisions.

### Components and permitted behavior

1. The existing packaged native OMP `-e` module registers one separately named tool during normal factory startup, with read approval and a fixed operation enum. The design proposes `vscode_language`; implementation must establish a unique final name and visibly refuse conflicting ownership. Never replace native `lsp`, construct a second AgentSession, or add another transcript writer.
2. OMP remains the pipe listener/server and VS Code remains the connecting client. Once the client has completed peer/HMAC verification and proved key possession through a signed request, it may establish one authenticated provider attachment for the exact owner/slot/process. A competing live attachment is refused. Connection initiation and request initiation remain distinct.
3. Native tool execution captures known session identity, epoch, attachment generation and workspace binding and sends a server-to-client request. The VS Code adapter validates authentication, direction, replay state, generation, root and operation before dispatch. It returns a bounded signed result/error; the native side correlates it and rechecks identity before tool-result delivery.
4. Only `definition`, `references`, `hover`, `document_symbols`, `workspace_symbols` and `diagnostics` are admitted, through the design's fixed provider commands and diagnostics read API. There is no arbitrary command, eval, shell, edit, rename, code-action, settings or live tool-selection route. Do not call `setActiveTools` on attachment changes. Missing attachment makes execution visibly unavailable rather than changing native selection or silently falling back to `lsp`.
5. The extension-host adapter owns its resource accounting across attachments and generations. The Webview is neither a reverse-RPC endpoint nor an authority for provider dispatch; intentionally returned results still reach it through the normal conversation replica.

The protocol requires a version change and coordinated upgrade of both extension-owned ends. Existing version-1 parsers do not support the proposed frames. An older surviving native host reports incompatible/unavailable; it must not be transparently replaced or resumed. No unauthenticated fallback, second listener or reverse-RPC route through Collab is permitted. Fresh attachment after reconnect requires fresh ADR-0006 peer/HMAC verification. Ordinary tool-result replication remains unchanged.

### Security and lifecycle invariants retained verbatim

The following passages are reproduced verbatim from the accepted design's **Request direction and authentication**, **Replay and correlation contract**, **Identity, scope and disclosure**, and **Bounds, cancellation and lifecycle** sections. They are requirements of this proposal, not claims of implemented protection.

#### Per-direction MAC-covered sequences and correlation

> Use separate HMAC domains for provider request, provider result/error, cancellation and attachment, in addition to connection nonces. Authenticate frame kind and direction, sequence number, request ID where applicable, complete payload digest, exact owner/process/session/epoch binding, attachment generation, workspace generation and operation. This prevents reflected frames from being interpreted as ordinary control requests. Use independent correlation maps for reverse calls and existing control requests.

> The authenticated connection nonce pair defines the connection generation. For the new provider frame family, maintain one monotonically increasing sequence counter in each sending direction and one corresponding receive high-water mark. All frame kinds in that direction share its counter, including attachment, results and cancellation. Start at 1 on a fresh authenticated connection. Serialize frame emission so sequence assignment matches wire order; on the ordered stream, accept only the exact next sequence after verifying MAC and bindings. Reject a repeated, skipped, invalid or exhausted sequence as a protocol violation, close the connection, and fail its pending reads without replay. Counter rollover requires a fresh authenticated connection, not reuse of a previous generation.

> A provider request ID is the tuple of connection generation, request direction and that request frame's sequence number. Require that relationship when accepting a request. It cannot be reused in another fresh-sequence request. A byte-for-byte replay fails the receive high-water check; a newly signed frame attempting to reuse an old request ID fails the ID/sequence relationship. Neither case may dispatch a provider again, including after the original request settled. Reserve a valid request's bounded pending state before invoking VS Code; capacity refusal is terminal for that ID, not an invitation to retry it.

> Results, errors and cancellation carry their own directional frame sequence and refer to the original request ID, request digest and captured generations. Only an exact live pending match can produce a tool completion or cancel that call. A cancellation never creates a pending call, dispatches work, or targets a later call by a reused identifier. A result-versus-cancel race settles the logical wait once; it does not release an unsettled underlying invocation slot.

> Keep at most 256 terminal tombstones per connection, containing only request identity/digest and terminal classification, never provider payloads. They identify recent duplicate completions or late cancels, which are ignored after authentication and sequence validation. Tombstone eviction does not permit ID reuse: sequence-derived request IDs and monotonic high-water marks remain authoritative for the whole connection. A well-formed authenticated late reference to an older non-live ID below the appropriate request high-water mark is discarded without dispatch, state allocation or effect, even if its tombstone was evicted. A reference to an impossible/future ID, wrong connection, or mismatched live call is a protocol violation. Late frames for an invalidated attachment may be discarded only after frame authentication and sequence consumption; they never enter a replacement attachment's pending map.

> Connection closure discards its transport correlation state and tombstones, but not the extension-host adapter's unsettled invocation accounting. A new nonce pair rejects all prior connection frames. No result cache, automatic request retransmission or mutation-style outcome replay is introduced for these reads.

> Receive-side demultiplexing must not await a provider promise on the same serial queue that needs to receive its result or cancellation. Keep the existing mutation ledger and control serialization unchanged. Provider calls are read observations, not mutation-ledger entries and not automatic-retry candidates. Closing a connection after a provider protocol violation does not erase native mutation reservations or authorize replay of an ordinary control mutation whose reply was lost.

#### Adapter-lifetime concurrency slots

> At most four live logical request workflows in the extension-host provider adapter, with no unbounded waiting queue; excess calls receive `busy`. The native side likewise retains at most four pending bridge calls per host.

> Independently, at most four unsettled bridge command invocations in the extension-host provider adapter, **shared across all attachments, hosts and connection/workspace/session generations served by that adapter**. The unit is one bridge invocation of a VS Code provider command, not one third-party provider execution. Internal provider fan-out is outside this limit's guarantee. Subject asynchronous document-opening stages to the same gate so they cannot create an unbounded side channel of bridge work.

> Acquire an invocation slot immediately before calling the VS Code API and release it only when that underlying invocation actually fulfills, rejects or throws synchronously. Multi-stage queries, including symbol resolution followed by a position query, run stages sequentially and acquire the gate for each stage. Do not hold one invocation slot while waiting to acquire another. If capacity is unavailable, return `busy` rather than queueing more work. Normalize within the admitted request workflow and apply the same gate to asynchronous document opens needed for snippets.

> OMP's execution AbortSignal is forwarded to bridge cancellation. On abort or deadline, settle the native wait once, send best-effort authenticated cancellation, and suppress late results. On disconnect, attachment replacement, workspace/session change or native identity change, invalidate all affected logical calls. **None of these events frees the slot of an unsettled underlying invocation.** Its record remains owned by the live extension-host adapter until actual settlement, even after the original transport, pending map and attachment are gone. Reattachment must reuse that adapter and its limiter rather than constructing a fresh empty counter. Disposal/reactivation inside the same extension-host process cannot bypass outstanding accounting; reject reactivation if that accounting cannot be preserved. Only termination of the owning extension-host process ends its lifetime; the bridge does not claim to terminate all external language-server work thereby.

> Do not promise that cancellation kills a language provider. The generic VS Code `executeCommand` signature does not establish a CancellationToken contract for these commands. Where a selected API genuinely supports cancellation, use it; otherwise cancellation means stopping bridge work and dropping late completion. A requested cancellation is not proof of settlement. Four hung old-generation invocations therefore keep new requests `busy` across reconnects and workspace-generation changes. Provider-returned arrays may already have been allocated by VS Code before normalization; the bridge's wire bounds and invocation count do not bound a third-party provider's internal allocations, tasks or fan-out.

#### Disclosure through the ordinary conversation and Collab

> Read snippets through the relevant VS Code document, including dirty text, without saving it. **Returned snippets and provider text, including content derived from unsaved buffers, become agent tool-result data. They may be recorded in the native conversation and reach its ordinary Collab guests and the VS Code Webview transcript.** Communicate this before enabling the capability; the pipe's confidentiality and the Webview's lack of reverse-RPC authority do not make results editor-private. No separate content-free replication mode is proposed. If content must not enter that transcript/replica, the product owner must change the requirement rather than relying on this bridge design.

> Apply data minimization before crossing into OMP: return only allowlisted normalized fields and bounded excerpts; omit raw provider objects, arbitrary diagnostic `data`, commands, unsupported URI targets and full-document dumps. Do not place raw responses in tool `details` or update callbacks as a way around the text limit. Return bounded bridge-authored error classifications instead of forwarding raw exception messages/stacks, which may contain paths, credentials or unrelated editor data. Never copy transport credentials, recipient material, HMACs or complete reverse-RPC frames into tool results, progress, the Webview or logs.

> No additional payload logging or telemetry is introduced. Optional operational logging is limited to operation names, bounded counts and stable status codes, not requests, provider text or document excerpts. These restrictions do not suppress the intentional normalized tool result from the ordinary OMP conversation. Its final combined `content` and `details` must satisfy the output budget below before OMP receives it; the bridge does not rely on Collab's larger size limit or truncation as a privacy control.

#### F1 session identity and writer ownership

> The existing F1 rule remains unchanged: a session identity read failure is not a new unsaved session. A successfully read null identity remains distinct and is bound by owner/slot/process/epoch. For this bridge, fail closed before provider dispatch and before delivery whenever native identity is unreadable, has changed, or does not match the pending call. Preserve the original model/thinking refusal before reservation; do not weaken it to enable language queries. Transition observations invalidate pending provider requests but must not veto native TUI transitions.

> Use the existing verified host only. Missing attachment, external session ambiguity, or absent Collab metadata never authorizes launching another writer, adopting a session, or releasing its claim.

### Scope, result semantics and remaining bounds

Apply the accepted design's operation contract without widening it:

- Authorize only the live host's launch-bound workspace root associated with the VS Code window. Initially admit only local `file:` resources within that root, not other workspace folders, remote/virtual resources, subagent worktrees or model-selected roots. Canonical component containment applies to inputs, returned locations and diagnostic related locations before snippet reads or path serialization; omit external targets with a filtered indicator.
- Preserve `source: vscode`, operation, attachment/workspace generation, observation time, truncation and relevant dirty/version information. Use 1-based coordinates, reject invalid/conflicting addressing and return bounded candidates rather than choosing the first ambiguous symbol. Query-document version changes produce `stale`; cross-file/workspace observations and cached diagnostics are not atomic or guaranteed current.
- Empty results are not proof of provider absence. Keep success-empty distinct from unavailable, invalid input, scope refusal, provider error, cancellation, timeout, stale identity/state and busy capacity. Provider availability remains unknown when it cannot be proven.
- Request bodies are bounded to 8 KiB and symbol/query text to 256 characters. Return at most 200 locations/symbols/diagnostics or 20 ambiguity candidates. Snippets have at most four context lines on each side and 2 KiB each; total hover text is at most 16 KiB.
- Normalized results are at most 64 KiB encoded UTF-8, and final tool-result `content` plus `details` together must also fit 64 KiB, including repeated presentation text. Signed frames remain below the existing 256 KiB channel ceiling. Count bytes after JSON encoding, normalize incrementally, expose truncation and permit no content-bearing partial-update bypass.
- Apply the fixed 15-second end-to-end deadline, including resolution, document loading, dispatch and normalization, plus a local bounded VS Code deadline. Dispatch no new stage after expiry; disconnect rejects pending native promises immediately. No logical call or result migrates between generations or is automatically replayed.

Read-only means that the bridge dispatches no editing operation, not that provider activation has no side effects. Structured workspace scoping and bounded fields are not arbitrary-secret detection or general data-loss prevention; provider prose can still mention sensitive content or external paths. No stronger isolation is claimed.

### Consequences

- Positive: the native agent can query the associated VS Code providers and editor state without replacing its independent `lsp` tool, changing OMP core or adding another session writer.
- Positive: the existing native-owned endpoint and ADR-0006 identity/key proof are reused, rather than introducing another listener and reload-discovery mechanism.
- Positive: explicit provenance, fail-closed identity checks and visible unavailable/stale/busy outcomes avoid silent substitution of another source or session.
- Negative: bidirectional authenticated framing, ordered replay protection, independent correlation, bounded tombstones and adapter-lifetime accounting add protocol and lifecycle complexity. Ordinary control serialization and mutation reservations must remain intact.
- Negative: four hung underlying invocations can keep new requests busy across reconnects and generation changes until actual settlement or termination of the owning extension-host process. Timeout and cancellation do not justify resetting the limiter.
- Negative: returned dirty-buffer/provider content intentionally becomes conversation and Collab/Webview data. Pre-return minimization does not make it editor-private or guarantee secret redaction.
- Constraint: registration and source inspection do not prove discoverability or end-to-end execution. Name collisions, actual packaged schema construction, each operation, dirty-buffer provenance, replay/cancellation races and resource accounting still require the accepted design's runtime/security verification.
- Constraint: remote workspaces, additional roots, child worktrees and additional reference operations remain outside this decision. Existing ADR-0006 verification requirements remain prerequisites, not requirements closed by this ADR.

This is a documentation-only decision proposal. No source change, protocol activation, runtime gate, formatter or test suite was executed for it. The accepted design's **Rollout and Verification** section remains the future verification contract; this ADR does not introduce another one or claim that it has passed.

## Reversal

The user decided on 2026-09-24 that language tools are **native OMP `lsp` only**, so this proposal was rejected before implementation was accepted and the work described above was removed in a clean cutover:

- the version-2 provider frame family in `src/host/control-protocol.ts` (attachment, acknowledgement, request, result, error and cancellation, with its MAC domains, directional sequences, derived request ids and bounds) is gone, and `CONTROL_PROTOCOL_VERSION` is back to 1;
- the native attachment, pending-call, tombstone and `vscode_language` tool code in `src/omp/host-control.ts` is gone;
- the client-side reverse-frame handling in `src/host/control-client.ts` and the whole `src/host/language-provider-adapter.ts` (with its tests) are gone;
- the extension's adapter construction, provider attachment call, disclosure notice and version-incompatibility report are gone.

Nothing was left behind as an alias, stub or dormant path, and native `lsp` was never modified: it remains the only language tool, with the same behavior it had before this proposal. The section above is preserved as the rationale and the independent review record, not as a description of any implemented capability.

The design's **Rollout and Verification** section is likewise unusable now: none of its items were executed, and the capability it describes does not exist.

### Planned future work (2026-09-24)

The user reopened this proposal as **future work**. This record stays `rejected` for the implementation it described and authorizes nothing: reviving the capability needs a revised security design that closes the three findings recorded against the removed code — one process-wide adapter root crossing native session boundaries, out-of-root workspace-symbol content in normalized results, and workspace-folder removal not revoking an attachment — plus explicit consent with Collab disclosure of returned editor data, independent security review, and real-window acceptance. The current release remains native OMP `lsp` only.

## Related Documents

- [VS Code language-provider bridge design](../designs/2026-09-24-vscode-language-provider-bridge.md) — canonical operation, lifecycle, bounds and verification contract; `rejected` since the user's decision recorded under Reversal.
- [ADR-0003: Native host-control pipe](0003-native-host-control-pipe.md) — narrowly extended by this proposal, not replaced wholesale.
- [ADR-0006: Host-generated key over a peer-verified pipe](0006-host-generated-key-peer-verified-pipe.md) — bootstrap, same-handle peer identity, trust boundary and credential handling remain unchanged.
- [ADR-0009: Read-only native tool selection](0009-read-only-native-tools-until-atomic-selection.md) — no GUI tool-selection mutation is added.
- [ADR-0004: Best-effort model/thinking transitions](0004-best-effort-host-model-transitions.md) — its separate waiver is not broadened.
- [ADR-0011: Installed-runtime policy and recorded F1 invariant](0011-use-installed-omp-without-version-gate.md) — proposed record; citing F1 does not imply acceptance of the broader ADR.
- [Current architecture](../architecture.md) — implemented state, distinct from this proposal.

## Architecture Review

- Reviewer: independent architect, separate from the author.
- Outcome: **accept as-is**, 2026-09-24, reviewed ADR SHA-256 `e903421b5a0debe7ff5e4476e02549a6d9d2cfb3f6dd7f50a7345e99c3052a6e` against the accepted design SHA-256 `3ac791b998605a3c668907a6c4b28383e81bf6b4baefe2364be15b834b853558`. No material findings; all five installed-OMP evidence rows verified against OMP 18.3.0.
- Notes: Accepted as an architectural decision only. It does not claim implementation, activation, or closure of runtime/security verification; the protocol version change and the reverse-RPC gates remain to be implemented and proven.
