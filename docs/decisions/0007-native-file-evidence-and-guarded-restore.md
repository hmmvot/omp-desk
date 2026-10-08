---
status: accepted
date: 2026-09-24
---

# ADR-0007: Keep Native File Evidence Separate from Guarded Restore

## Context and Problem Statement

The accepted [development design](../designs/2026-09-24-omp-vscode-development.md) requires diffs, file Undo/Redo and checkpoints without destroying user edits. The existing session claim excludes another *extension-owned OMP host for the same transcript*, not all processes that can write the workspace. OMP 18.2.11 `tool_call` hooks fire at batch admission, before tools run; `tool_result` does not necessarily mean all deferred writes have settled. Ordinary read/hash-then-write and VS Code WorkspaceEdit are not atomic against independent filesystem writers. Checkpoint code in comparable tools and tool result text are not authoritative byte backups. The user's acceptance of a best-effort race for model/thinking transitions ([ADR-0004](0004-best-effort-host-model-transitions.md)) does not authorize losing file edits.

## Considered Options

- Take snapshots the way comparable tools do and immediately expose hash-checked Undo/Redo: expedient, but two writers can race between the hash and replacement; dirty buffers, symlinks and crash-time partial writes are not covered.
- Replace native OMP builtin tools, intercept global fs calls or force all writers through a wrapper: changes OMP semantics, misses Bash/MCP/other processes and may deadlock a batch; no public transparent all-writers transaction API exists.
- Record immutable observation bytes with explicit provenance and offer labelled diffs, while withholding automatic filesystem writes until both trustworthy mutation evidence and a verified exclusion/restore mechanism exist: selected. This is a conservative order of work, not an assertion that preview alone satisfies parity with comparable tools.

## Decision Outcome

Raw-byte capture is **disabled by default** and requires explicit consent scoped to a workspace/session. Before the first capture, even an experimental one, establish supported-path and read limits, restricted Windows storage access within [ADR-0006](0006-host-generated-key-peer-verified-pipe.md)'s same-user trust boundary, total blob/manifest quotas, finite retention, and coordinated deletion. A surviving native producer must honor persistent disablement across extension-host reload; disabling stops new capture while retained history and its separate deletion remain visible. A pre-approval observation may preserve bytes of a later denied operation, and consent must disclose this. If these gates cannot be enforced, byte capture stays off.

A native-side producer observes supported local-file intentions/results and writes content-addressed bytes and a bounded journal under an extension-owned owner/slot namespace outside the workspace. `admission-observed` and `observed-post-result` describe distinct read intervals, not guaranteed instantaneous states or immediate per-tool pre/post images. `unknown`, `unstable` and `unavailable` describe missing results, races and unsupported observations. Each record carries operation/host/turn/path identity, file type/existence, digest and observed tool outcome without asserting sole authorship. Committed blobs precede manifests that reference them; readers reject corrupt/missing blobs. A watcher may invalidate stale evidence but cannot prove authorship. A prepared operation missing `tool_result` becomes unknown even while the host runs; a new host epoch never replays old work. Links/reparse/hardlink, binary, nonlocal/internal/archive/SQLite and oversize paths may retain metadata while remaining unrestorable. Bytes can contain secrets and never enter the transcript, relay, argv, logs or unsanitized Webview messages.

VS Code may show a native diff from two immutable snapshot URIs with an explicit label that observation is not guaranteed per-tool attribution. `tool_call` captures are not advertised as immediate preimages of each call, including multiple edits in one batch. `ast_edit` preview and later resolve are distinct write opportunities. A failed result can still leave partial changes; a missing result makes the prepared operation unknown.

Automatic Undo/Redo/checkpoint **must remain unavailable** until separate review and proof establish (1) verified immediate before **and** after states attributable to the exact mutation for per-operation Undo, and (2) a restore executor excluding independent Windows writers, accounting for existing handles, dirty VS Code buffers, path/identity replacement and crash-time partial writes. Exclusion at restore time cannot retroactively make admission/result observations attributable: those remain preview-only, even after an executor exists. A historical checkpoint has separately reviewed coverage and target-state semantics, not retroactive per-tool authorship. Merely checking a digest, acquiring a cooperative mutex or calling WorkspaceEdit is not sufficient. The executor consumes justified immutable states, not Webview-supplied content, validates identity/type/current bytes while protected, journals actual mutations, invalidates redo on a new accepted branch and reports partial multi-file outcomes rather than atomic success; Redo requires the verified state its Undo produced. Neither gate is waived by the native model-transition race. If strong exclusion/evidence cannot be obtained without changing OMP core, a consequential user decision is required before weakening the no-data-loss contract; incomplete parity must not be declared done.

### Consequences

- Positive: users can inspect honest native file history and immutable diffs without an extension-controlled write destroying unrelated edits; restart and provenance ambiguity are explicit.
- Negative: complete automatic file Undo/Redo and all-writer attribution are not presently available. The journal holds sensitive bytes and requires quotas, scoped access and deletion. Captures at batch-admission can be informative but not authoritative per-operation preimages.

## Related Documents

- [Native file observation and reversibility design](../designs/2026-09-24-native-file-observation-and-reversibility.md).
- [Development design](../designs/2026-09-24-omp-vscode-development.md).
- [ADR-0004](0004-best-effort-host-model-transitions.md) — a different race with explicitly accepted consequences.

## Architecture Review

- Reviewer: architect
- Outcome: independently reviewed; material findings addressed and accepted as a decision, not runtime proof.
- Notes: Independent architect review identified two gaps: a future restore lock cannot repair a pre-batch snapshot that predates an unrelated user edit; and a bounded journal without prior consent/ACL/blob quotas could persist sensitive bytes. The revision requires both attributable immediate states and exclusion for Undo, and disables capture until scoped opt-in, Windows storage checks, quotas, retention, persistent disablement and deletion are available. Review is not runtime proof of either producer or restore executor.
