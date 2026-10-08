---
status: rejected
date: 2026-09-24
---

# Query VS Code language providers from the native OMP agent

## Problem

The parity row “VS Code language-provider tools” means asking the language extensions in the open VS Code workspace, not merely offering another language-server client. The native OMP agent runs in its own process and cannot directly call the extension host's `vscode` API.

**Recommendation:** retain OMP's native `lsp` tool unchanged and add a narrowly scoped, separately named read-only provider tool through the existing authenticated host-control connection. Reverse RPC is a proposed protocol extension, not existing functionality. This document authorizes neither implementation nor activation.

**Is a bridge warranted?** For definitions, references, hover, symbols and diagnostics in general, **no additional LSP implementation is warranted**: installed OMP 18.3.0 already covers those categories. For this assignment's explicit requirement to query **VS Code's providers and editor state**, native `lsp` is **not an equivalent substitute**. Its inspected path uses OMP-configured server transports and disk reconciliation, rather than executing VS Code provider commands. The bridge is warranted only for that difference; there must be no silent fallback between the two sources.

## Goals and Non-goals

Goals:

- Let the existing native OMP agent request definition, references, hover, document symbols, workspace symbols and diagnostics from its associated VS Code workspace.
- Preserve provider provenance, use 1-based agent coordinates, normalize results, and expose truncation and uncertainty explicitly.
- Bound requests, responses, concurrency and waiting; restrict structured locations and file reads to the authorized workspace root.
- Preserve native session ownership, ADR-0006 authentication and the F1 identity distinction.
- State the disclosure boundary accurately: returned editor content becomes agent tool-result data and participates in the normal conversation and Collab replica, including the Webview transcript.

Non-goals:

- OMP core edits, a second AgentSession, additional transcript writers, or session-history adoption/resume. Normal recording of results by the existing native session remains part of the design.
- Replacing or disabling native `lsp`, launching language servers from this bridge, or copying OMP's LSP configuration/discovery.
- Arbitrary VS Code commands, eval, shell, edits, rename, code actions, settings changes or live tool-selection mutation.
- Full nine-tool parity with the comparison extension in this change. Implementations, type definitions, call hierarchy and reference access classification are comparison-extension features outside the requested operation set; diagnostics is an additional requested operation.
- Automatically exporting tools into subagents or isolated worktrees. Their grants and workspace semantics require a separate decision.
- Suppressing normal OMP tool-result replication or guaranteeing secret detection in arbitrary provider prose.

## Current State

### Repository contracts and observations

Read together: [architecture](../architecture.md), [ADR-0003](../decisions/0003-native-host-control-pipe.md), [ADR-0006](../decisions/0006-host-generated-key-peer-verified-pipe.md), [ADR-0009](../decisions/0009-read-only-native-tools-until-atomic-selection.md), and the recorded F1 invariant in [ADR-0011](../decisions/0011-use-installed-omp-without-version-gate.md).

The native module is the pipe server; VS Code's extension host is its client. The present method allowlist is `snapshot`, `listModels`, `listTools`, `setModel`, `setThinking`, and `result` (`src/host/control-protocol.ts:605-634`). The current frame unions describe client hello/request and server challenge/response/error, not server-originated provider calls (`src/host/control-protocol.ts:850-911`). Protocol version is 1 and the frame ceiling is 256 KiB (`src/host/control-protocol.ts:50-61`).

The client has one outstanding ordinary request per connection and queues them (`src/host/control-client.ts:1018-1029`). Same-handle peer verification and HMAC challenge validation occur before trusting the channel (`src/host/control-client.ts:793-819,1065-1107`). The server distinguishes its challenge-sent state from `provenClient`, which means a signed request has proved possession of the key (`src/omp/host-control.ts:425-438`). Provider data must never be sent merely because hello received a challenge.

The existing request path checks connection nonces, HMAC and payload digest before dispatch (`src/omp/host-control.ts:1152-1189`). These checks alone do not define replay protection for a new server-originated provider call; the proposal below supplies that contract explicitly.

The GUI is already a conversation replica, not an isolated display that can be assumed to exclude tool results. `src/webview/components/Transcript.tsx:258-266` collects `toolResult` messages for rendering. The installed native replication evidence is listed below.

These are preliminary working-tree observations during concurrent project work. Revalidate integration points before implementation. The independent review examined the original document with SHA-256 `0989ddd0b37df7c3f8b22905bb6a67a46cdb9c741b04be812fce4d29d65bda72`; this corrected text is a subsequent revision.

### Installed OMP 18.3.0 evidence

All OMP paths below are relative to the inspected installed package **`@oh-my-pi/pi-coding-agent`** (a global Bun installation), not the separate development checkout. `package.json:1-3` declares version **18.3.0**. These citations establish source behavior and interface feasibility, not a runtime smoke test or a future version pin.

| Claim | Installed source evidence |
|---|---|
| Native `lsp` is a registered built-in factory. | `src/tools/index.ts:525-530`; `src/lsp/tool.ts:169-196` names the tool, marks it discoverable, and omits it when `enableLsp === false`. |
| Native LSP already has the requested query categories. | `src/lsp/types.ts:8-21` declares its action schema; `src/lsp/tool.ts:267-278` handles workspace diagnostics, `317-369` file diagnostics, `983-1063` workspace symbols, `1208-1229` definitions, `1282-1329` references, `1331-1346` hover, and `1457-1485` document symbols. |
| This is OMP's server path, not a VS Code provider adapter. | `src/lsp/tool.ts:216,1141-1165` selects configured servers and reconciles the target; `src/lsp/client.ts:1063-1086` obtains an OMP shared transport or spawns a configured command. Do not describe every query as necessarily spawning a private server. |
| Native queries do not establish dirty VS Code buffer equivalence. | `src/lsp/client.ts:1355-1409` reconciles from `Bun.file(filePath).text()`, with a special case for OMP's own pending writes. `src/lsp/tool.ts:1164-1165` invokes that reconciliation. This is evidence of a different input path, not a claim about every possible external server configuration. |
| Native addressing differs from the comparison extension. | `src/lsp/types.ts:8-21` exposes `file`, `line`, `symbol`, and `query`, but no explicit column input; `src/lsp/tool.ts:1171-1189` resolves a symbol column and requires a symbol for certain project-aware queries. |
| A loadable extension can register a tool without creating a second session. | `src/extensibility/extensions/types.ts:1306-1307` declares `registerTool`; `src/extensibility/extensions/loader.ts:216-224` stores the definition and notifies registration listeners. The module factory is bound to a concrete API in `loader.ts:437-456`. |
| The tool contract supports schemas, read approval, asynchronous execution and cancellation input. | `src/extensibility/extensions/types.ts:604-649` defines name/label/description/parameters, `approval`, and `execute(toolCallId, params, signal, onUpdate, ctx)`. The comment permits Zod or legacy TypeBox-compatible schemas. `src/extensibility/extensions/wrapper.ts:68-93` forwards the AbortSignal and creates the execution context. |
| Registration does not mean unconditional provider-visible availability. | `src/extensibility/extensions/types.ts:613-619` documents hidden/defaultInactive/discoverable presentation. `src/sdk.ts:2963-2983` gathers and wraps extension tools; `3458-3493` filters inactive/hidden tools and includes extension registrations except for restricted callers. Actual presentation and availability must be verified in the native runtime. |
| Tool execution has access to workspace/session context. | `src/extensibility/extensions/types.ts:443-452` exposes `cwd` and the read-only session manager. This alone is not an atomic session lease. |
| Native LSP already handles caller abort plus a tool timeout. | `src/lsp/tool.ts:199-214` combines the caller signal with a timeout signal. This does not implement cancellation for the proposed VS Code side. |
| Normal tool results participate in native Collab replication. | `src/collab/host.ts:79-103` allows tool execution and message events plus message session entries; `430-455` subscribes to session events and sends eligible appended entries. `src/collab/replication-shrink.ts:1-56` describes and defines payload-size reduction, not a confidentiality filter that removes provider content. |

Do not copy the comparison extension's tool definitions wholesale: their descriptions and API fields are inspiration, not an installed OMP API specification. In particular, only fields verified above are part of this proposal's registration contract.

The comparison extension's LSP tools guide describes nine provider wrappers, 1-based coordinates, normalized locations/symbols, symbol-name resolution and child registration. Its language-extension-name heuristic for `no-provider` does not establish authoritative provider availability.

## Proposed Design

### Components and ownership

1. **OMP tool adapter:** extend the existing packaged native `-e` module with one separately named tool — `vscode_language`, the name the implementation registers — and an allowlisted operation enum. Declare read approval. Never override `lsp` or construct another SDK session.
2. **Authenticated reverse-call transport:** extend the existing channel implementation with directional provider frames and bounded pending-call state. OMP remains the listener/server; VS Code remains the connecting client. Request initiation and connection initiation are different concepts.
3. **VS Code provider adapter:** execute only fixed provider commands and the diagnostics read API inside the extension host. Normalize and scope results before returning them. This adapter owns resource accounting for its entire extension-host lifetime, across all attachments and connection generations. The Webview is neither a reverse-RPC endpoint nor an authority for provider calls, but it receives intentionally returned tool results through the ordinary conversation replica.

Registration occurs during the native module factory's normal startup. Do not add a GUI tool-selection setter or call `setActiveTools` on connect/disconnect. A missing provider attachment makes execution visibly unavailable; it does not rewrite native tool selection. Do not claim that registration forces exposure in restricted sessions or overrides native selection policy.

### Operation contract

| Operation | VS Code-side action |
|---|---|
| `definition` | `vscode.executeDefinitionProvider` |
| `references` | `vscode.executeReferenceProvider` |
| `hover` | `vscode.executeHoverProvider` |
| `document_symbols` | `vscode.executeDocumentSymbolProvider` |
| `workspace_symbols` | `vscode.executeWorkspaceSymbolProvider` |
| `diagnostics` | `vscode.languages.getDiagnostics(uri)` or its workspace snapshot, filtered to the authorized root |

Provider-command use is grounded in the comparison extension's implementation and the [official VS Code built-in command documentation](https://code.visualstudio.com/api/references/commands). The latter states that definition, reference, hover and workspace-symbol commands execute all applicable providers. The bridge can bound its command invocations, not the command's internal provider fan-out. Local VS Code declarations expose `commands.executeCommand` at `node_modules/@types/vscode/index.d.ts:11028`, diagnostic reads at `14812-14819`, and document version/dirty state at `146-151`. These are VS Code contracts, not OMP APIs.

Position operations accept a workspace-relative file plus 1-based line and column, or a symbol-name query. Resolve symbol names through workspace symbols, filter to the authorized root, and return up to 20 candidates on ambiguity; never silently choose the first candidate. Reject conflicting addressing forms. Validate integral coordinates against the actual opened document; do not clamp an invalid position onto an unrelated token.

Document symbols require a file. Workspace symbols require a nonempty bounded query. Diagnostics permits one file or the authorized root's current snapshot; it does not trigger a build or promise a completed diagnostic recomputation.

Normalize Location and LocationLink results to workspace-relative locations and 1-based ranges. Flatten hierarchical and flat symbols to name, kind, container, depth and location. Return hover markdown as inert text: never execute returned commands or trust embedded links. Diagnostics include severity, source, code, message and location, but exclude arbitrary provider data and commands.

Each result identifies `source: vscode`, operation, attachment/workspace generation, observation time, truncation, and relevant dirty/version information. For a position or document request, observe the query document's version before and after provider execution; a changed version produces `stale`, not success. Cross-file and workspace queries are best-effort observations, not atomic snapshots. Cached diagnostics do not carry a guarantee that they describe the latest document version.

Distinguish success with an empty result from transport unavailability, invalid input, scope refusal, provider error, cancellation, timeout, stale identity/state, and busy capacity. **Do not claim an authoritative `no-provider` result solely from an empty provider response or a list of installed language extensions.** Report provider availability as unknown when it cannot be proven. This is a deliberate correction to the comparison extension's heuristic semantics, not exact parity with it.

### Request direction and authentication

1. VS Code establishes the existing peer-verified named-pipe connection, verifies process generation and completes the nonce/HMAC flow. All ADR-0006 bootstrap, owner/slot, recipient, pinned-key and reload checks remain mandatory.
2. VS Code sends an authenticated provider-attachment request advertising only the fixed supported operations and authorized workspace root. The native server accepts attachment only after a signed request proves the client knows the key. Permit one active provider attachment for the exact owner/slot/process; a competing live attachment is refused rather than selected arbitrarily.
3. A native tool call captures known session identity, epoch, attachment generation and workspace binding, then sends a server-to-client provider request.
4. VS Code verifies the signature, direction, replay state, generation, root and operation before dispatch. It sends a bounded, signed provider result or error. OMP correlates it with the original pending call and rechecks identity before returning a tool result.

This requires new directional attachment/request/result/cancel frame types and a protocol-version change. Existing version-1 parsers do not support these frames. Upgrade both extension-owned ends together; an older surviving native host must report incompatible/unavailable and must not be transparently replaced or resumed. No unauthenticated fallback, second listener or reverse-RPC route through Collab is permitted. Ordinary tool-result replication through Collab remains unchanged.

Use separate HMAC domains for provider request, provider result/error, cancellation and attachment, in addition to connection nonces. Authenticate frame kind and direction, sequence number, request ID where applicable, complete payload digest, exact owner/process/session/epoch binding, attachment generation, workspace generation and operation. This prevents reflected frames from being interpreted as ordinary control requests. Use independent correlation maps for reverse calls and existing control requests.

#### Replay and correlation contract

The authenticated connection nonce pair defines the connection generation. For the new provider frame family, maintain one monotonically increasing sequence counter in each sending direction and one corresponding receive high-water mark. All frame kinds in that direction share its counter, including attachment, results and cancellation. Start at 1 on a fresh authenticated connection. Serialize frame emission so sequence assignment matches wire order; on the ordered stream, accept only the exact next sequence after verifying MAC and bindings. Reject a repeated, skipped, invalid or exhausted sequence as a protocol violation, close the connection, and fail its pending reads without replay. Counter rollover requires a fresh authenticated connection, not reuse of a previous generation.

A provider request ID is the tuple of connection generation, request direction and that request frame's sequence number. Require that relationship when accepting a request. It cannot be reused in another fresh-sequence request. A byte-for-byte replay fails the receive high-water check; a newly signed frame attempting to reuse an old request ID fails the ID/sequence relationship. Neither case may dispatch a provider again, including after the original request settled. Reserve a valid request's bounded pending state before invoking VS Code; capacity refusal is terminal for that ID, not an invitation to retry it.

Results, errors and cancellation carry their own directional frame sequence and refer to the original request ID, request digest and captured generations. Only an exact live pending match can produce a tool completion or cancel that call. A cancellation never creates a pending call, dispatches work, or targets a later call by a reused identifier. A result-versus-cancel race settles the logical wait once; it does not release an unsettled underlying invocation slot.

Keep at most 256 terminal tombstones per connection, containing only request identity/digest and terminal classification, never provider payloads. They identify recent duplicate completions or late cancels, which are ignored after authentication and sequence validation. Tombstone eviction does not permit ID reuse: sequence-derived request IDs and monotonic high-water marks remain authoritative for the whole connection. A well-formed authenticated late reference to an older non-live ID below the appropriate request high-water mark is discarded without dispatch, state allocation or effect, even if its tombstone was evicted. A reference to an impossible/future ID, wrong connection, or mismatched live call is a protocol violation. Late frames for an invalidated attachment may be discarded only after frame authentication and sequence consumption; they never enter a replacement attachment's pending map.

Connection closure discards its transport correlation state and tombstones, but not the extension-host adapter's unsettled invocation accounting. A new nonce pair rejects all prior connection frames. No result cache, automatic request retransmission or mutation-style outcome replay is introduced for these reads.

Receive-side demultiplexing must not await a provider promise on the same serial queue that needs to receive its result or cancellation. Keep the existing mutation ledger and control serialization unchanged. Provider calls are read observations, not mutation-ledger entries and not automatic-retry candidates. Closing a connection after a provider protocol violation does not erase native mutation reservations or authorize replay of an ordinary control mutation whose reply was lost.

### Identity, scope and disclosure

The existing F1 rule remains unchanged: a session identity read failure is not a new unsaved session. A successfully read null identity remains distinct and is bound by owner/slot/process/epoch. For this bridge, fail closed before provider dispatch and before delivery whenever native identity is unreadable, has changed, or does not match the pending call. Preserve the original model/thinking refusal before reservation; do not weaken it to enable language queries. Transition observations invalidate pending provider requests but must not veto native TUI transitions.

Authorize only the live host's launch-bound workspace root when it belongs to the associated VS Code window. This root is not selected by the model's payload. Initially support local `file:` resources under that root; refuse remote, untitled and other virtual schemes. In a multi-root window, do not grant the other folders implicitly. Workspace-folder changes invalidate the attachment generation and outstanding results, not the adapter's accounting for old unsettled invocations.

Resolve filesystem paths canonically, using component containment rather than string-prefix checks. Reject traversal, sibling-prefix tricks and symlink/junction targets outside the root. Apply the same rule to provider-returned locations and diagnostic related locations **before** reading snippets or serializing paths. External targets are omitted with a filtered indicator; no external path or snippet is returned. The bridge must not widen scope because a provider returned a dependency or generated-file URI.

Read snippets through the relevant VS Code document, including dirty text, without saving it. **Returned snippets and provider text, including content derived from unsaved buffers, become agent tool-result data. They may be recorded in the native conversation and reach its ordinary Collab guests and the VS Code Webview transcript.** Communicate this before enabling the capability; the pipe's confidentiality and the Webview's lack of reverse-RPC authority do not make results editor-private. No separate content-free replication mode is proposed. If content must not enter that transcript/replica, the requirement must change rather than relying on this bridge design.

Apply data minimization before crossing into OMP: return only allowlisted normalized fields and bounded excerpts; omit raw provider objects, arbitrary diagnostic `data`, commands, unsupported URI targets and full-document dumps. Do not place raw responses in tool `details` or update callbacks as a way around the text limit. Return bounded bridge-authored error classifications instead of forwarding raw exception messages/stacks, which may contain paths, credentials or unrelated editor data. Never copy transport credentials, recipient material, HMACs or complete reverse-RPC frames into tool results, progress, the Webview or logs.

No additional payload logging or telemetry is introduced. Optional operational logging is limited to operation names, bounded counts and stable status codes, not requests, provider text or document excerpts. These restrictions do not suppress the intentional normalized tool result from the ordinary OMP conversation. Its final combined `content` and `details` must satisfy the output budget below before OMP receives it; the bridge does not rely on Collab's larger size limit or truncation as a privacy control.

Opening a document or executing a read provider can activate language extensions; read-only here means the bridge dispatches no editing operation, not that arbitrary provider code has no side effects. Free-form hover/diagnostic prose may itself mention external types, paths or sensitive source content. Workspace scoping constrains structured targets and bridge file reads; field omission and output bounds are not a general data-loss-prevention or arbitrary-secret-redaction guarantee. Do not advertise stronger isolation than this contract.

Use the existing verified host only. Missing attachment, external session ambiguity, or absent Collab metadata never authorizes launching another writer, adopting a session, or releasing its claim.

### Bounds, cancellation and lifecycle

Proposed application limits, independent of native LSP defaults:

- Request body at most 8 KiB; symbol/query text at most 256 characters.
- At most 200 returned locations, symbols or diagnostics; at most 20 ambiguity candidates.
- At most four snippet context lines on each side, 2 KiB per snippet, and 16 KiB total hover text.
- Normalized result payload at most 64 KiB encoded UTF-8. Also enforce 64 KiB on the final tool-result `content` and `details` together, accounting for any repeated presentation text rather than granting each field its own budget. All signed frames must remain below the existing 256 KiB channel ceiling. Count bytes after JSON encoding, not UTF-16 characters. Normalize incrementally and stop at the first limit; mark truncation without splitting JSON or Unicode. Do not emit content-bearing partial updates that bypass this per-call budget.
- At most four live logical request workflows in the extension-host provider adapter, with no unbounded waiting queue; excess calls receive `busy`. The native side likewise retains at most four pending bridge calls per host.
- Independently, at most four unsettled bridge command invocations in the extension-host provider adapter, **shared across all attachments, hosts and connection/workspace/session generations served by that adapter**. The unit is one bridge invocation of a VS Code provider command, not one third-party provider execution. Internal provider fan-out is outside this limit's guarantee. Subject asynchronous document-opening stages to the same gate so they cannot create an unbounded side channel of bridge work.
- At most 256 terminal transport tombstones per connection; replay safety does not depend on retaining all completed IDs.
- A fixed 15-second end-to-end tool deadline, including symbol resolution, document loading, provider dispatch and normalization. Dispatch no new stage after expiry. The VS Code side also starts a local bounded deadline; transport disconnect must reject pending native promises immediately.

Acquire an invocation slot immediately before calling the VS Code API and release it only when that underlying invocation actually fulfills, rejects or throws synchronously. Multi-stage queries, including symbol resolution followed by a position query, run stages sequentially and acquire the gate for each stage. Do not hold one invocation slot while waiting to acquire another. If capacity is unavailable, return `busy` rather than queueing more work. Normalize within the admitted request workflow and apply the same gate to asynchronous document opens needed for snippets.

OMP's execution AbortSignal is forwarded to bridge cancellation. On abort or deadline, settle the native wait once, send best-effort authenticated cancellation, and suppress late results. On disconnect, attachment replacement, workspace/session change or native identity change, invalidate all affected logical calls. **None of these events frees the slot of an unsettled underlying invocation.** Its record remains owned by the live extension-host adapter until actual settlement, even after the original transport, pending map and attachment are gone. Reattachment must reuse that adapter and its limiter rather than constructing a fresh empty counter. Disposal/reactivation inside the same extension-host process cannot bypass outstanding accounting; reject reactivation if that accounting cannot be preserved. Only termination of the owning extension-host process ends its lifetime; the bridge does not claim to terminate all external language-server work thereby.

Do not promise that cancellation kills a language provider. The generic VS Code `executeCommand` signature does not establish a CancellationToken contract for these commands. Where a selected API genuinely supports cancellation, use it; otherwise cancellation means stopping bridge work and dropping late completion. A requested cancellation is not proof of settlement. Four hung old-generation invocations therefore keep new requests `busy` across reconnects and workspace-generation changes. Provider-returned arrays may already have been allocated by VS Code before normalization; the bridge's wire bounds and invocation count do not bound a third-party provider's internal allocations, tasks or fan-out.

Reconnect only after a fresh ADR-0006 peer/HMAC verification and explicit authenticated attachment. A surviving native process retains ownership but has no provider service while the extension host is absent. No result is migrated between connection or session generations, and no logical call is automatically replayed. A genuinely restarted extension-host process creates a new adapter, not a new OMP session writer.

## Alternatives

### Native `lsp` only

Lowest complexity and the preferred choice when the requirement is generic semantic assistance. Installed 18.3.0 already supports all requested categories and additional operations. It does not establish the requested VS Code provider provenance, dirty-buffer state, or extension-specific diagnostic snapshot. Selecting this alternative would change this assignment's behavior and therefore requires an explicit change to the contract.

### Reverse RPC over the existing authenticated pipe — recommended

Reuses the native-owned endpoint, reload ownership and established peer/key proof. Adds no OMP core dependency or second runtime writer. Its real cost is a reviewed bidirectional framing/dispatch extension, with independent cancellation, replay protection and pending-call state. An ordinary duplex byte stream is not by itself proof that the existing protocol supports reverse calls. Normalized answers still follow OMP's existing tool-result replication; the reverse transport is not a mechanism for hiding answers from the conversation.

### Separate IPC channel

Could isolate language traffic from control traffic, but requires another endpoint lifecycle, identity binding, authentication, reload association and failure surface. A VS Code-owned listener would disappear on reload and would need safe rediscovery by the surviving native host. There is no demonstrated requirement that justifies that additional channel here. Loopback HTTP without equivalent authentication is not an acceptable shortcut. A separate transport would not by itself prevent ordinary tool-result disclosure or fix generation-local resource accounting.

## Risks and Open Questions

- The expanded authenticated surface needed an explicit extension to ADR-0003's narrow protocol contract; [ADR-0013](../decisions/0013-authenticated-reverse-rpc-for-vscode-language-providers.md) recorded that decision as a proposal, which the user then **rejected** (language tools are native OMP `lsp` only), and the source written against it was removed. Neither this design nor that record supersedes an accepted ADR by implication, and there is no capability to certify.
- Registration in a real extension host, discoverability through `omp`'s own tool list, schema construction in the packaged module against a real host, an extension-host restart and dirty-buffer answers in a real window have **not** been exercised. Installed source plus the unit and in-process integration coverage described under Implementation Status prove feasibility, not integration.
- Tool names can collide with other extensions. The implementation registers `vscode_language` and must visibly refuse conflicting ownership, not replace native `lsp` or silently shadow another tool.
- Empty results do not prove provider absence. The explicit unknown-availability semantics must be accepted rather than promising the comparison extension's heuristic as truth.
- Query results may be stale across multiple files. Per-document checks do not make VS Code's workspace symbol graph or diagnostics snapshot atomic.
- Hung invocations can exhaust adapter-wide slots across reconnects; the safe outcome is unavailable/busy until actual settlement or termination of the owning extension-host process, not resetting counters or spawning another OMP process.
- Bounds cover bridge command invocations and returned data, not third-party provider fan-out or internal allocations.
- Returned dirty-buffer text is intentionally agent/conversation data and can appear in Collab/Webview. Complete exclusion from that replica would require a different contract; ordinary payload shrinking is not redaction.
- Remote workspaces, external libraries, child worktrees and additional operations from the comparison extension need separate scope decisions; none are silently granted here.
- The currently installed source is evidence for 18.3.0, not a numeric runtime compatibility gate. Recheck changed interfaces when implementing against a different installation.

## Rollout and Verification

The independent review recorded at the end of this document reviewed it as a proposal, and that record is preserved as history. The design was then accepted, the user subsequently rejected it, and the source written against it was removed, so nothing here is implemented. Everything in this section remains unexecuted and the capability it describes does not exist: the verification below would require a real VS Code extension host and a controlled workspace, and no runtime, security or acceptance run performed it.

A later implementation must prove the changed path, not merely compile it:

1. In an isolated, already-owned native session, register the actual packaged tool and invoke each of the six operations through OMP and the authenticated connection into a real VS Code extension host. Inspect the observed tool availability rather than assuming registration equals provider exposure.
2. Use a controlled workspace with known definitions, references, hierarchical/flat symbols, hover text and diagnostics. Change an unsaved buffer and establish that the bridge reports the editor result with dirty/version provenance while native `lsp` remains independently usable. Observe the normalized result in the native conversation and actual Collab/Webview transcript; do not claim editor-private content. A cached empty diagnostic snapshot must not be reported as proof of a clean build.
3. Prove coordinate conversion, ambiguous symbol handling, provider-empty/error behavior, workspace filtering, external-location omission, traversal and junction rejection, and UTF-8/result limits. Check the combined tool-result `content`/`details` budget and absence of raw provider objects, command data or exception stacks in returned data. Neither `details` nor progress callbacks may bypass the limit.
4. Exercise cancellation, deadline expiry, never-settling and late invocations, four-slot saturation, concurrent ordinary controls, and reverse replies arriving while control requests are pending. Hold four command invocations unsettled, then disconnect/reconnect and change workspace/attachment generations in the same extension host: new invocations must remain `busy`. Repeat across another host attachment and same-process adapter reactivation. Allow one old invocation to settle and prove that exactly one slot becomes available, without delivering its stale result. Count bridge API invocations, not presumed third-party provider executions.
5. Exercise unreadable identity versus legitimately null identity, native transition, workspace-folder change, actual extension-host restart and reconnect. The original native process remains the only session writer; pending reads fail visibly and are never replayed automatically. Same-process reattachment and actual process termination must not be conflated in resource-accounting tests.
6. Re-exercise same-handle PID/generation proof, forged or direction-reflected frames, attachment competition and changed keys. Replay a valid request before and after settlement and after tombstone eviction; no case dispatches it twice. Try a fresh-sequence frame with an old request ID, a skipped sequence, future/mismatched response IDs, cross-generation frames, duplicate completion and a cancel arriving after completion. Prove bounded tombstones and that late cancellation cannot affect a later call. Existing control mutation reservations must survive a provider-induced connection failure.
7. Verify that transport credentials, recipient secrets, HMAC material and raw reverse-RPC envelopes never enter results, progress, logs, telemetry or Webview messages. Verify absence of added request/provider-content logging, while explicitly allowing the bounded normalized results in the ordinary native transcript and its Collab/Webview replica. Existing ADR-0006 credential-handling and runtime gates remain prerequisites rather than being assumed satisfied by this document.

These are unexecuted acceptance criteria, not verification performed during drafting, review or implementation: the independent document review checked the document and its API evidence, and the implementation's own coverage is unit and in-process only. No bridge runtime verification has occurred.

## Reversal

The user decided on 2026-09-24 that language tools are **native OMP `lsp` only**. This design was therefore rejected before any implementation was accepted, and the source that had been written against it — the version-2 provider frame family, the native attachment and `vscode_language` tool code, the client-side reverse frames and the VS Code adapter with its tests — was removed in a clean cutover. No alias, stub or dormant path remains, and native OMP `lsp` is unchanged: it is the only language tool.

The sections above are kept as the rationale and the record of the independent review, not as a description of any implemented capability. The **Rollout and Verification** items were never executed and the capability they describe does not exist.

## Planned Future Work

The user reopened this bridge on 2026-09-24 as **planned future work** — not implemented, not accepted, and with no source in the repository — while the current release keeps native OMP `lsp` as its only language tool. The sections above remain the rationale and the review record for a proposal that was rejected in implementation; reviving the capability requires a revised security design that closes the three findings an independent security review recorded against the removed code:

- **LSP-01 (high, cross-session disclosure).** One process-wide adapter was rebound to each newly attached host's workspace root, so a request from a still-attached native session resolved relative paths — and workspace-wide queries — against another session's root and could return that session's editor data as its own tool result and Collab transcript. The fix is an immutable per-attachment handler and root validated against the attached host, with outstanding calls invalidated on rebind rather than re-rooted.
- **LSP-02 (high, cross-workspace disclosure).** Workspace-symbol results whose location fell outside the authorized root still contributed their name, kind and container to normalized results. The fix is to discard any symbol whose explicit location fails root scoping, including ambiguity candidates, keeping locationless entries only when they belong to the authorized query document.
- **LSP-03 (medium, authorization lifecycle).** The workspace-folder check ran only at attachment and no workspace-folder listener detached or rebound the client, so an attached host kept opening files and querying providers in a folder the user had removed from the window. The fix is to retain attachment handles per tab and recheck exact host/root membership on folder changes.

Beyond those fixes, enabling the bridge requires explicit consent with Collab disclosure before any query runs — returned editor data, including unsaved-buffer text, becomes agent and conversation data that replays through Collab and the Webview — an independent security review of the revised design, and real-window acceptance in an actual extension host. Claude resources remain excluded from this work: their discovery stays with installed OMP's own capability providers.

## Related Decisions

- [ADR-0003: Native host-control pipe](../decisions/0003-native-host-control-pipe.md).
- [ADR-0006: Host-generated key and peer-verified pipe](../decisions/0006-host-generated-key-peer-verified-pipe.md).
- [ADR-0009: Read-only native tool selection](../decisions/0009-read-only-native-tools-until-atomic-selection.md).
- [ADR-0011: Installed-runtime policy and recorded F1 invariant](../decisions/0011-use-installed-omp-without-version-gate.md) — proposed record; do not imply its broader acceptance.
- [Development design](2026-09-24-omp-vscode-development.md).
- [VS Code built-in command reference](https://code.visualstudio.com/api/references/commands) — provider-command behavior and fan-out.

## Architecture Review

- Reviewer: independent architect, separate from the design's author.
- Review date: 2026-09-24.
- Review result: an independent review; its findings and re-review are recorded below.
- Reviewed baseline: SHA-256 `0989ddd0b37df7c3f8b22905bb6a67a46cdb9c741b04be812fce4d29d65bda72` of the original draft. The author confirmed the on-disk document matched that baseline before preparing this revision.
- Outcome: **accept after corrections**. The reviewer found three material issues and verified the original ten installed-OMP API evidence rows without finding material false API claims. The author accepted all three findings and incorporated the corrections below.
- Re-review (same independent reviewer, 2026-09-24, corrected text SHA-256 `e309cb275850f5c56c48f5f29b02f7832d57d08a801f78087b84774f95c26347`): F1, F2 and F3 **resolved**, no new material issues; recommendation "accept as-is". Accepted as a design only: it does not authorize activating the reverse-RPC protocol, which still requires its own ADR (ADR-0003 extension) and runtime/security verification before implementation.

| Finding | Disposition and resolution in this revision |
|---|---|
| **F1 — high: attachment-local limits allow unsettled work to accumulate across reconnects; provider fan-out is not controlled.** | Accepted. Components and lifecycle now give resource ownership to the live extension-host provider adapter, shared across attachments/hosts/generations. Cancellation, disconnection, workspace/session changes, disposal and reattachment do not free an unsettled invocation slot. Release requires actual settlement. The limit explicitly counts bridge command invocations, not individual third-party providers. Verification includes four hung invocations followed by reconnect, workspace-generation change, another attachment and same-process reactivation, all still busy. |
| **F2 — medium: MAC domains and nonces do not by themselves prevent same-connection request replay.** | Accepted. Added MAC-covered per-direction ordered sequence numbers, connection-generation/sequence-derived unique request IDs, reservation before dispatch, exact result/cancel correlation, bounded terminal tombstones and high-water rejection independent of tombstone retention. Defined duplicate, late, impossible and cross-generation frame behavior without redispatch or unbounded state. Verification includes replay after settlement and eviction, reused IDs under fresh sequences, and late cancellation. |
| **F3 — high: provider payloads normally reach the Webview through tool-result replication.** | Accepted. Added installed Collab replication evidence and explicit disclosure that returned unsaved-buffer content becomes agent/conversation/replica data. Separated intentional normalized results from credentials, raw transport frames and added telemetry. Added pre-return field minimization, bounded bridge-authored errors, a combined content/details budget and no content-bearing progress bypass. Removed the false requirement that normal provider results be absent from Webview messages; verification now observes their expected transcript delivery while testing secret/raw-frame exclusion. |

The recommendation remains a narrow authenticated reverse-RPC bridge for VS Code-specific semantics, not a duplicate native LSP implementation. This review and correction record does not describe implemented functionality, authorize OMP core changes, weaken ADR-0006/F1, or close runtime/security gates.

Historical note: the outcome lines above record what the review decided about this document, including that accepting the design did not authorize activating the protocol. That protocol decision was taken in [ADR-0013](../decisions/0013-authenticated-reverse-rpc-for-vscode-language-providers.md) and then rejected by the user, whose decision is native OMP `lsp` only; the source was removed in a clean cutover. The runtime and security verification the review required, and every item under Rollout and Verification, are therefore moot rather than open.
