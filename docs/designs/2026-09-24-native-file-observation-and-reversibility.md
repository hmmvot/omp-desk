---
status: accepted
date: 2026-09-24
---

# Observe Native OMP File Changes Before Offering Guarded Reversal

## Problem

The accepted [development design](2026-09-24-omp-vscode-development.md) calls for diffs, per-file Undo/Redo and checkpoints comparable to established AI coding extensions, without overwriting unrelated user edits. The installed OMP is the only native TUI/Collab runtime and no numeric release is pinned ([ADR-0011](../decisions/0011-use-installed-omp-without-version-gate.md)): the evidence below was gathered against 18.2.11 and must be re-read in whatever release is installed. Its public extension hooks observe tool admission and results, not a transaction spanning every file writer. A transcript checkpoint is not a filesystem backup. In particular, OMP checks every tool's pre-hook in a batch before executing any tool (`pi-agent-core/src/agent-loop.ts:2670-2762`); a `tool_call` preimage is not necessarily the immediate before state of an individual write. `ast_edit` can defer its actual write until a later resolve. Bash, eval, MCP, child and external processes may write without a corresponding file-specific hook. Ordinary filesystem hash-then-replace is not atomic with an independent writer.

## Goals and Non-goals

- Show native VS Code diffs between immutable bytes actually observed during bounded reads, with the consistency status, provenance and coverage of each observation visible. A file's absence differs from zero bytes. A failed or interrupted tool may still have changed files; observations do not prove one instantaneous filesystem state or one tool's authorship.
- Keep raw bytes and metadata outside the workspace/transcript/Webview storage. Raw capture is **disabled by default** and requires explicit consent scoped to a workspace/session. Bounds, Windows access controls, retention and deletion must be implemented before the first capture, including experimental use. Committed evidence survives an extension-host reload while the native host lives; missing results become unknown rather than silently reversible.
- Offer conflict-aware per-file Undo/Redo and checkpoint planning **only when BOTH attributable immediate before/after states and an actual filesystem exclusion/restore mechanism are established**. Never overwrite a dirty VS Code document, unexpected current file, unsupported path kind or changed external writer. A partial checkpoint result must say partial, never success.
- Do not change OMP core or silently re-register all builtin tools. Do not claim every file change was caused by OMP, that pre-batch snapshots are per-operation preimages, that an OS watcher proves authorship, or that hash-check/WorkspaceEdit is an atomic compare-and-swap.

## Current State

The extension tracks the owner of an OMP **session** (`src/host/session-claim.ts`) and preserves exact transcript paths (`src/host/session-index.ts`), but has no file snapshot journal or filesystem writer broker. OMP exposes `tool_call`/`tool_result` handlers with toolCallId and input (`src/extensibility/extensions/types.ts:932-1034,1287-1288`, read in the 18.2.11 package the evidence was gathered from). Its `write` accepts non-file destinations such as archives/internal URLs, edit spans multiple files and rename/delete, and result text is budget-limited. The checkpoint code of other source-available extensions is not a safe rollback contract.

## Proposed Design

### Capture and provenance

Add a native-side producer alongside the existing OMP `-e` host extension, enabled only after explicit workspace/session consent and storage readiness. Treat each `tool_call` as an **admission observation**, never an exclusive file lock or guaranteed final input; later hooks can replace it. Recognized direct local-file `write`/`edit` targets are candidates, not automatic coverage. Exclude internal/SQLite/archive URLs, UNC/device/alternate-stream paths, links/reparse points, hardlinks and other unsupported path kinds from byte capture initially; show metadata-only/unavailable status instead. For a supported regular file, read through one bounded handle, associate type and identity with that handle, compare relevant metadata and pathname binding before/after, and mark changes/races `unstable` or `unavailable`. Even stable metadata does not prove an atomic snapshot against arbitrary in-place writers: each blob is **bytes observed during a read interval**. Record `admission-observed`, not an invented immediate per-tool preimage. On `tool_result`, independently observe a later state and outcome (`observed-post-result`), including partial changes after errors. Blob digests validate stored bytes, not their authorship or an instantaneous filesystem state.

Correlate own operation UUID with process instance/epoch, session file and branch/turn anchor, toolCallId/toolName/occurrence, path, observation stage and monotonic journal sequence. Copy event-time identities and input; if the tool result reports revised input, mark the path relationship uncertain instead of backdating a new preimage. A watcher may invalidate a stale displayed diff or report `external/unknown`, never assign an author. An OMP `ast_edit` preview is not an applied edit; any later resolve write requires its own evidence. Intra-batch, nested/direct dispatch, deferred LSP and other uninstrumented changes retain ambiguous provenance. Child runtimes may run a verified producer of their own; a parent Hub event cannot prove child mutation. A tool denied after admission may leave a snapshot of a target never written: consent explicitly covers this possibility.

### Storage and readers

One native publisher per owner/slot namespace writes to an extension-owned directory with verified Windows access rules (within [ADR-0006](../decisions/0006-host-generated-key-peer-verified-pipe.md)'s same-user trust boundary). Set concrete total blob and manifest quotas, per-file read/size limits, finite retention and explicit deletion **before any real capture**. An authenticated extension host reads committed manifests/blobs after validating its established session/host owner; a Webview receives opaque snapshot IDs and text diffs through extension-owned VS Code URIs, never an arbitrary path or journal-root access. Show binary, oversize and unstable states as unavailable. Disabling capture persists across extension-host reload and stops the surviving native producer; existing history and explicit deletion are separate visible actions. Serialize deletion with publication and readers; invalidated evidence is never silently recreated. Never evict a snapshot while an Undo button claims it remains available.

Publish all complete immutable blobs before the manifest commit that references them; validate hashes, path binding and record integrity on every read. Orphan blobs may be collected, whereas a missing/corrupt referenced blob makes that record unavailable. A `prepared` record without a witnessed result becomes `unknown` even while the host is alive (approval denial, nested dispatch and missed/failed `tool_result` can omit the event); a host restart also begins a new producer epoch and never replays it. Snapshot work in `tool_call` is time/byte/path-bounded, catches expected failures and returns a visible unavailable result instead of intentionally denying the native tool. Honor cancellation and fence asynchronous completion after a timeout; an OMP hook itself timing out can still block a native tool under OMP's semantics, so this observer is not promised transparent. `tool_result` failure likewise must not turn absence of evidence into success. Readers only rely on fully published commits after a process crash; no power-loss durability is claimed from rename alone.

### Restore boundary

Per-operation Undo requires a verified **immediate before AND immediate after state attributable to that exact mutation**, plus a verified file identity; exclusion acquired later cannot repair ambiguous historical capture. `admission-observed` and `observed-post-result` remain preview-only, even if a future restore executor exists. A future executor must acquire a proven exclusion mechanism shared by cooperating sessions and strong enough for independent Windows writers, then compare type/identity/current bytes and dirty VS Code buffer version while protected. It writes a justified target state and journals the actual outcome before moving an Undo/Redo cursor. Redo requires the verified state produced by its corresponding Undo; a new accepted change invalidates the redo tail. A historical checkpoint replacement has separate explicit coverage/target semantics, not retroactive tool attribution. No Webview-supplied destination/content or hidden `force` path is accepted.

Until that exclusion mechanism is specified and verified, **automatic Undo/Redo/rollback remains unavailable**, not a hash-check followed by a potentially lossy write. A checkpoint is an immutable manifest of explicitly covered paths, distinct from OMP's conversation context. If a future executor cannot atomically apply several paths, it preflights all, records each applied path, and reports `partial/conflict` on interruption; it never promises all-or-nothing or silently compensates over later user edits. Preserve a read-only diff/preview for unsupported cases.

## Alternatives

- Copy another extension's checkpoint implementation or call `git reset`: can overwrite unrelated edits and conflates transcript rewind with filesystem changes.
- Hold a path mutex from OMP `tool_call` until `tool_result`: deadlocks a batch whose next pre-hook waits before the first tool starts; it still excludes only cooperating writers.
- Use watcher timestamps, capped tool-result oldText/newText, or a global fs monkey patch as a complete backup: none covers arbitrary native/subprocess or deferred writes.
- Save current hash then call WorkspaceEdit/rename without an exclusion primitive: a concurrent independent editor can write between comparison and replacement.

## Risks and Open Questions

- Resolve the actual edit input variants (verified against 18.2.11) and supported local-file path extraction before choosing capture coverage. A malformed path must not cause the producer to capture or restore unrelated files.
- Sensitive-byte policy is a pre-implementation gate, not a deferred question: capture is disabled by default; each workspace/session requires explicit enablement with target/read limits, Windows ACL verification, total blob/manifest quota, finite retention, persistent disablement and explicit deletion. Pre-approval capture may retain bytes from a tool the user later denies. If this cannot be honestly disclosed and enforced, leave byte capture unavailable rather than enabling it from an implicit raw-recording preference.
- A verified Windows same-handle/exclusive write primitive is not designed yet. If it cannot prevent concurrent existing handles, parent-path replacement and crash-time partial writes without data loss, automatic restore remains unavailable. Accepting a best-effort loss risk would be a separate consequential user decision, not implied by the model-transition race waiver.
- Full attribution/automatic reversal of arbitrary Bash/MCP/remote changes would require a verified shared filesystem broker or broader OMP/tool contract and cannot be inferred from a new event listener.

## Rollout and Verification

1. First establish consent, supported-path policy, ACL/quotas/retention/deletion and native-producer disablement, then implement bounded nonblocking-intent observations and VS Code immutable diff/preview against the release currently installed, re-verifying the 18.2.11 evidence baseline rather than assuming it transfers. Exercise two writes to one path in a batch, an input rewritten by a later handler, denial with no result, a failed partial edit, external and in-place concurrent writers, deferred ast_edit, a child tool, binary and absent/zero-byte files. Verify labels do not overclaim, interrupted captures are unavailable and observation never intentionally writes a user file.
2. Prove journal publication/recovery after extension-host reload and process crash, per-window owner binding, missing-result reconciliation while the host still runs, quota/unavailable state, deletion/disablement and secret non-disclosure. Treat corrupt/missing blobs as unavailable; power-loss durability is a separate gate.
3. Independently design/review a restore executor and separately prove attributable immediate before/after states plus exclusion, dirty-buffer/path swap, symlink/hardlink, partial checkpoint and crash behavior. Both evidence and restore gates must pass before automatic Undo/Redo; a diff-only phase is not parity completion.

## Related Decisions

- [ADR-0007: Native file evidence with guarded restore](../decisions/0007-native-file-evidence-and-guarded-restore.md)
- [Development design](2026-09-24-omp-vscode-development.md)
- [ADR-0002: Native TUI plus Collab GUI](../decisions/0002-local-collab-gui-native-omp.md)

## Architecture Review

- Reviewer: architect
- Outcome: independently reviewed; material findings addressed and accepted as a design, not an implemented capability.
- Notes: Independent architect review found that future exclusion cannot repair an ambiguous preimage, a byte read is not an atomic file state, hooks can block/omit results, separate blob+manifest renames need a commit order, and sensitive capture needs prior consent/limits. The design now requires two-sided attributable evidence and a separate restore gate; marks reads as interval observations; defines bounded hook/recovery/publication behavior; and disables byte capture until explicit workspace/session opt-in and storage policy are implemented. No runtime proof or restore implementation is claimed.
