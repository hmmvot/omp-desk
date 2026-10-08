---
status: proposed
date: 2026-09-28
---

# ADR-0034: Store Sessions in one transactional profile catalog

> **Narrowly amended by [ADR-0045](0045-derive-window-folders-per-window-and-pin-with-identity-ids.md):** the profile-wide folder list holds the pinned folders only; folders VS Code has open are shown per window and keep their collapsed state per window.

> Ownership/controller clauses narrowed by [ADR-0039](0039-refuse-only-on-a-verified-live-writer-the-extension-owns.md): stale/unverifiable claims and sticky import disagreements do not veto session operations. Unowned editors may control their surface. Catalog read/merge/lock integrity failures still protect the catalog itself.

> **Amended before the first release:** the read-only importer of per-workspace Memento state described below was removed, because no earlier build was ever published and its source could never exist for a new extension id. A one-time, ledger-bound import of only the registered folder list from the predecessor extension id's catalog (`src/host/predecessor-import.ts`) replaced it. Statements below about the legacy importer are historical.

## Context and Problem Statement

`SessionIndex`, explicitly registered OMP folders, broker provenance, shell-slot
records and panel-surface choices currently live in `context.workspaceState`. Opening
a different VS Code folder selects a different Memento, hiding sessions and the
user's added folder. Existing data in an inactive workspace is not available through
ExtensionContext's current-workspace Memento. A simple switch to `globalState` does
not serialize concurrent full-snapshot writers or recover those earlier records, and
the native exact-file claim already has a profile-wide identity: navigation and
durable intent must not silently fork by VS Code workspace.

## Considered Options

- One extension-owned versioned catalog in `globalStorageUri`, with short
  cross-process transactions, per-record merge rules and a read-only legacy importer.
  Preserves a single session authority, cross-window visibility and a lossless
  migration, at the cost of transactional operations and one bounded private-format
  read for already inactive workspaces.
- Move each existing Memento directly to `globalState`. Smaller patch, but stale
  windows can overwrite one another's rows, stops, bindings or added folders, and old
  workspace-only data still disappears until each old workspace is reopened.
- Keep workspace-specific authorities and union them for the sidebar. Can find older
  rows, but forgotten/deleted sessions resurrect and divergent owner histories cannot
  safely authorize a writer.
- Derive rows and folders from transcript files. Cannot recover explicitly added empty
  folders, drafts, broker provenance or stopped intent.

## Decision Outcome

Use one transactional, versioned extension-owned catalog per local VS Code extension
storage namespace. Store the complete session index, folder navigation metadata,
broker/shell recovery mappings and per-editor surface choices there. A
revision-changing operation locks, rereads and validates the newest catalog, applies
its change to that newest state, commits by durable atomic replacement and publishes
the new revision. A window's cached projection never overwrites the shared snapshot;
each record key merges by the rule of the module that owns its schema, so a window's
change is a delta and another window's unrelated change survives it. Refuse
uncertain/corrupt state rather than replace it with empty state: a catalog that exists
and cannot be read blocks every mutation with a visible reason and is never rewritten.
Keep exact-file claims and native process/broker identity as separate existing runtime
authorities; the catalog lock does not grant process ownership. Keep actual editor
membership, panel layout and focus with VS Code and the current window.

**Shared facts and window-local facts are separate.** The catalog holds identity,
scope, run intent, ownership/attempt/release evidence, bindings, held transfers and
import conflicts. A window's own observations — availability, per-row status detail,
the selected tab, the reply its panels displayed — stay in that window's local store,
because publishing them would let a rival window's failed attach or failed probe
report a failure over a session another window is running. A row with no local
observation derives its status from the shared record.

**Controller election is claim-bound.** An editor becomes a conversation's
controlling slot only when the publishing window provably holds that writer (a live
record whose claim generation is the row's, or the row's exact file claimed on disk by
this window's holder lease). A window that asks for control without that proof
publishes a passive binding and demotes nobody, so a rival can no longer displace an
incumbent's durable binding and then fail to attach. A role change advances the
binding generation.

**Related facts publish in one revision.** The settled native A→B switch commits the
target conversation, its binding, the source's retirement and the broker mapping that
follows the same process in one catalog transaction, so no reader sees the new
conversation with the previous transport. Launch records its attempt on the row before
the process exists and reserves the broker mapping first; an interrupted launch leaves
either a lookup entry no attach can use without a row and a claim, or the
identity-less attempt ADR-0033 already defines and its explicit release handles. Stop,
explicit stale release and removal keep their existing evidence and refusal rules
(ADR-0027, ADR-0031, ADR-0033).

**Activation restores only the local cohort.** A window automatically restores the
rows whose editor VS Code restored in it and the rows it already runs. Rows another
workspace put in the shared index are visible and inert until the user opens them.
Stopped and explicitly released rows keep their refusal regardless.

**Older per-workspace state is imported once, additively.** Read the open workspace
through its public Memento; recover inactive workspaces through a bounded read-only
adapter for the selected local profile: the profile root is derived from the verified
extension storage URI, only this extension's allowlisted Memento keys are read, the
source database and its sidecars are *copied* into the extension's own storage and the
copy is opened (the source path is never opened by SQLite), each source file's size
and modification time are compared across the copy and a changed source is refused
after bounded retries, and the copy must pass an integrity check. The reader is Node's
built-in `node:sqlite`, feature-detected in the extension host; no dependency is
added, no shell command is spawned, and a runtime without it makes inactive-workspace
recovery a visible refusal rather than a silent empty result. Sources are attributed
by real path inside the selected profile — an alias that escapes it is skipped — and
the catalog is always scoped to the host running the extension, so nothing is merged
across hosts. Import preserves exact identities, run intent, outstanding attempts,
bindings and broker provenance; the ledger entry is committed in the same transaction
as the records, so an imported source is never imported again and a later workspace
reopen cannot resurrect a removed row; conflicts are retained raw and block unsafe
ownership operations; a source whose own keys contradict each other is quarantined
rather than half-imported. The reader boundary and the manifest: this build keeps
`engines.vscode` at its current floor and treats inactive-workspace recovery as a
feature-detected capability, which the profile catalog does not depend on.

This decision **narrowly supersedes ADR-0020's workspace-scoped folder registry and
its stated lack of unrelated-workspace synchronization**, and **narrowly supersedes
ADR-0025's statement that verified native-switch folder registration changes Sessions
"for the current workspace context": that registration is profile-wide too.** ADR-0020's
separation of folder navigation from native ownership and non-destructive folder
removal survive, as do ADR-0025's verified-cwd requirement, editor/conversation
distinction, passive-editor arbitration, removal restrictions and its requirement that
a successful transfer is witnessed before A is retired. ADR-0021's live-draft
reattachment, ADR-0031's broker-proven transport and ADR-0033's explicit release are
unchanged.

### Consequences

- Positive: changing VS Code folders no longer hides indexed sessions or explicitly
  added OMP folders. Existing locally persisted entries can be imported even when the
  original workspace is not open, with original data retained untouched. Concurrent
  windows do not lose one another's writes, an incumbent controller cannot be
  displaced by a window that holds nothing, and a settled conversation switch cannot
  be observed with the previous transport.
- Negative: catalog transactions, recovery, per-record merge rules and cross-window
  refresh must be maintained; an ambiguous catalog lock or an unreadable catalog
  blocks mutations until it is resolved. One-time inactive-workspace import depends on
  a private VS Code disk format, a runtime that provides `node:sqlite`, and a copy that
  can be taken consistently; all three fail visibly. A mixed installation with old
  extension code writing former workspace stores is not a coherent shared-state
  configuration. A shared row can appear in a rival window while its controls
  correctly remain unavailable there. Folder collapse state, shell-slot records and
  panel-surface choices are now profile-wide rather than per workspace.

## Related Documents

[Workspace-independent Sessions design](../designs/2026-09-28-workspace-independent-sessions.md),
[ADR-0020](0020-separate-folder-navigation-from-session-ownership.md),
[ADR-0025](0025-bind-editor-slots-to-current-conversations.md),
[ADR-0031](0031-reattach-a-surviving-managed-host-through-its-broker.md),
[ADR-0033](0033-release-stale-ownership-of-an-unidentified-launch-explicitly.md).

## Architecture Review

- Reviewer: independent architect (corrective review in round 2 and delta review in round 3).
- Outcome: **changes required, addressed**; the ADR stays `proposed` only because in-host/UI proof is unavailable under the user's explicit no-window-control decision.
- Addressed: the refused coupled record is a typed unpublished hold with a remembered coupled key; a promoted panel completes its handshake before the link is delivered; a failed election reports no role; a directory keeps its committed owner; credential eligibility is fenced by the durable binding (two-sided owner/conversation check) rather than local state alone; and every write names the snapshot it was derived from, so another window change is never mistaken for this consumer's intent.
- Unavailable (permission, not implementation): actual extension-host execution evidence and installed-window visual acceptance.
