---
status: proposed
date: 2026-09-28
---

# Workspace-independent Sessions catalog

> Ownership/controller clauses narrowed by [ADR-0039](../decisions/0039-refuse-only-on-a-verified-live-writer-the-extension-owns.md): unknown claims and sticky import disagreements do not veto session actions; unowned editors can control their own surface. Catalog integrity checks and merge rules remain unchanged.

> **Amended before the first release:** the read-only importer of per-workspace Memento state described below was removed, because no earlier build was ever published and its source could never exist for a new extension id. A one-time, ledger-bound import of only the registered folder list from the predecessor extension id's catalog (`src/host/predecessor-import.ts`) replaced it. Statements below about the legacy importer are historical.

## Problem

Opening a different VS Code folder changes `context.workspaceState`. Today both
`SessionIndex` and `WorkspaceFolderRegistry` read their complete snapshots from that
scope; broker-slot provenance, shell slots and panel-surface choices are also
workspace-scoped. An ordinary profile currently has two session rows, one explicitly
added folder, six slot bindings and two broker mappings in one older workspace's
store, while the newly opened folder's store has none. The apparent disappearance is
not deletion: changing workspaces selects a different authority. Simply switching to
`globalState` would neither recover those older snapshots nor prevent concurrently
open windows from overwriting one another's complete cached snapshots.

## Goals and non-goals

- All VS Code windows sharing one local extension profile show the same registered
  OMP folders and indexed conversations regardless of the opened VS Code workspace.
  Folder registration never changes VS Code workspace roots. Closing a panel never
  removes a conversation row.
- Retain existing session/tab/editor IDs, exact files, run intent, ownership/attempt
  and stale-release evidence, controlling bindings and broker provenance. Neither
  migration nor a foreign window may launch a second writer, erase a verified stop,
  or grant a passive editor control.
- **Automatic work stays local.** A window restores only the rows it is responsible
  for (below). Rows another workspace's window put in the shared index are visible
  and inert until the user opens them here.
- Recover historical workspace-scoped data even if the old workspace is not currently
  open, without modifying its VS Code state database or transcript files. Repeated
  import must not resurrect rows or folders removed after import.
- Preserve recoverable shell-slot records and per-editor surface preference across
  folder changes; leave actual panel layout, focus and local runtime handles to
  VS Code/the current window.
- Display the folder action as **Resume Session**, matching **New Session**, without
  changing its command ID or folder-scoped behavior.
- No cross-profile, remote-host or Settings Sync of PIDs, paths or claims; no silent
  acceptance of a corrupt catalog, conflicting identity or unsupported historical
  store; no claim that the second window owns the first window's live editor.

## Current state

`src/extension.ts` constructs the index, folder registry, broker-slot store,
shell-slot store and panel-surface store from `context.workspaceState`. The first two
cache and rewrite whole snapshots. The existing exact-file claims, staged broker
binaries and runtime records are already in extension `globalStorageUri`. The public
ExtensionContext API cannot enumerate another, inactive workspace's `workspaceState`.
ADR-0020 explicitly scoped folder navigation per workspace; this design changes only
that scope, not the separation of folders, session ownership and VS Code editors.

## Proposed design

### The catalog

A versioned extension-owned catalog file in `globalStorageUri` is the one authority
for the session index, folder registry, broker-slot mappings, shell-slot records and
panel-surface choices. Commit a single catalog revision under a short cross-process
metadata lock: read and validate the latest committed revision, apply the caller's
change, write and flush a sibling file, atomically replace the catalog and release
the lock. A missing catalog is a fresh install; a catalog that exists and cannot be
read (malformed, or an unknown newer version) makes every mutation **refuse** and
reports why — it is never replaced with an empty writable document. The lock is
created exclusively and records its owner; it is reclaimed only when the recorded
process is *provably gone* **and** the lock is older than a grace period, and the
reclaim is recorded in the conflict ledger. Time alone never steals a lock. No
dialog, native probe, claim acquisition or host launch runs under the lock.

Every record keeps the schema, validation and semantics of the module that owns it;
the catalog owns durability, atomicity and the merge rule for each key:

| Record key | Owner | Merge rule |
| --- | --- | --- |
| `omp.sessionIndex.v1` | `src/host/session-index.ts` | per-row delta by `tabId`, plus keyed delta for bindings and held transfers |
| `omp.workspaceFolders.v1` | `src/views/workspace-folders.ts` | per-folder delta by id, de-duplicated by path identity |
| `omp.brokerSlots.v1` | `src/host/broker-slots.ts` | per-identity delta, conflicted identities retained unreadable |
| `omp.shellSlots.v1` | `src/host/shell-slots.ts` | per-slot delta, never evicting a slot |
| `omp.panelSurface.v1` | `src/host/panel-surface.ts` | per-slot delta, bounded recency order |

A window writes the *delta* it intends, not the snapshot it holds: a record this
window changed is this window's, an untouched record takes the committed value, a
record this window removed stays removed unless another window changed it since, and
every disagreement is retained in the conflict ledger. This is what makes two
windows adding two different rows both keep theirs.

### Shared facts versus window-local facts

A window's observations are not shared facts and must never become one. The session
record is therefore split:

| Fact | Where | Why |
| --- | --- | --- |
| tab/file/session identity, scope, cwd, ordinal, origin, run intent | catalog | it is what every window must agree on |
| ownership generation, recorded host/attempt, retirement/release evidence | catalog | the writer's identity and its history |
| editor-slot bindings, held transfers | catalog | a restore resolves its conversation and role from them |
| import-conflict marker | catalog | the refusal must be visible in every window |
| availability, per-row status detail | local | it is what *this* window observed; a rival window's failed attach must not report a failure over a session this window runs |
| the selected tab, the reply this window's panels displayed | local | window presentation, not conversation state |

A row with no local observation is *derived*, never blank: a fileless row is `draft`,
a materialized one is `saved`, and its detail explains its import provenance, its
released attempt or its import conflict from the shared record itself. Only a
positive, owner-authorized observation writes a shared fact — this window's own
launch attempt, an adopted claim, a confirmed release, a verified stop. A refusal, a
failed probe or a rival claim writes local status only.

### Controller election is claim-bound

One conversation has one controlling editor, and its commands, terminal input and
Reload target that conversation's writer. Publishing `controlling` requires *proof
that the publishing window holds the writer*: either it has a live record for the tab
whose claim generation is the row's recorded one, or the row's exact session file is
claimed on disk by that window's own holder lease, at the generation the row records.
An editor that asks for `controlling` without that proof — a rival window restoring
the same conversation, or one whose claim is not yet durable — is published
`passive` with a reason and **demotes nobody**. The incumbent keeps its role until
its holder is positively gone, and the window that took over publishes `controlling`
after its own claim is durable (a panel is bound before its native attempt, so the
election is re-published once the attempt held the claim). A role change advances the
slot's binding generation, so a queued callback or page credential that still names
the previous generation is fenced out.

### Multi-record operations

A single catalog file is not enough unless related facts are one semantic
transaction. The operations that must publish together, or must publish an explicit
recoverable state, are:

| Operation | Authorization | Read-set | Atomic write-set | Effect outside the lock | Interrupted state | Recovery |
| --- | --- | --- | --- | --- | --- | --- |
| Launch (`Resume`, first start) | exact-file claim acquired | row, broker table | attempt row recorded **before** the launcher is asked to start; broker reservation recorded before the process exists | one native process | a reserved mapping with no row, or an identity-less attempt on the row | the mapping is a lookup entry nothing attaches from without a row and a claim; the identity-less attempt is exactly the state the explicit Release action handles (ADR-0033) |
| Attach/restore (activation, click) | exact-file claim adopted | row, binding, broker table | adopted ownership/host facts on the row | one read-only authenticated attach probe | none published: a failed probe leaves the row as it was | the next attempt re-derives from current facts |
| Native A→B switch (settled witness) | the target claim is acquired by the commit | source row, target row, bindings, broker table | target row + binding + source retirement + held record + **broker mapping**, one revision | the native process already switched (user-typed) | the native process serves B while records say A | the observation is repeated on the next settled-witness pass; nothing was released |
| Stop / close | the window holds the claim | row, live record, broker table | run intent `stopped`, release evidence, broker `forget` | the native stop | a stopped intent without the mapping forgotten | refusal keeps the mapping: a lookup entry for a stopped process is never attached from without a row |
| Explicit stale release (ADR-0033) | the user's action, under a fresh best-effort check | row, claim, broker table | retirement evidence + claim release | nothing | a retirement whose completion was not recorded | the row reports the incomplete release and the next attempt finishes it |
| Row removal / history deletion | the holder's guard | row, claim, panel state | row removed | file deletion (its own transaction) | deletion's own descriptor | ADR-0027's transaction descriptor |

The A→B row is the case this design changes most: the conversation, its binding and
the broker mapping that follows the same process are committed in **one** catalog
revision, so no reader ever sees the new conversation with the previous transport.

### Startup admission

Activation restores only this window's local recovery cohort: the rows whose editor
VS Code restored in this window, plus the rows this window already runs. Rows another
workspace's window put in the shared index are visible in the launcher and inert
until the user opens them; no claim, launch or attachment is started for them. A
restored editor whose tab was not in the cohort when the pass started is opened by
its own serializer path, exactly as an explicit click is. A stopped or explicitly
released row keeps its refusal either way: the cohort decides *whose* row may be
restored, never whether a stopped row may start. Windows hold read-only snapshots for
projection and refresh on catalog file changes, window/view focus and explicit
Refresh; missed notifications are recovered by the next snapshot read. Commands
transact against the latest durable revision, not the displayed snapshot. A watcher
never triggers restoration or native launch. The sidebar shows a loading line until
the catalog and the one-time import have settled, rather than an empty welcome state.

### Recovering older per-workspace state

A pure validated import translates legacy `omp.sessionIndex.v1`,
`omp.workspaceFolders.v1`, `omp.brokerSlots.v1`, `omp.shellSlots.v1` and
`omp.panelSurface.v1` snapshots without regenerating IDs or guessing from JSONL
history.

- **The open workspace** is read through its public Memento (`context.workspaceState`),
  which is the freshest copy. Its own database is then *never* read as a separate
  source, so a stale copy of the very workspace that is open cannot re-add a row the
  user removed there.
- **Inactive workspaces** are read through a bounded one-time importer that locates
  the same local VS Code user-data profile from the verified extension storage URI
  (`<profileRoot>/globalStorage/<publisher>.<name>`), enumerates
  `<profileRoot>/workspaceStorage/*/state.vscdb`, and reads only this extension's
  allowlisted Memento keys from its own row (`ItemTable`, key = the extension id).
- **The source is never opened.** Each database and its `-wal`/`-shm` sidecars are
  copied into a private directory inside the extension's own storage and *the copy*
  is opened, so SQLite can never lock, checkpoint, repair or create a sidecar beside
  the source. Every source file's size and modification time are read before and
  after the copy; a change of any of them discards the copy and the attempt is
  retried a bounded number of times, after which the source is refused as changing —
  a plausible-looking *outdated* copy is exactly what must not be imported. The copy
  must pass `PRAGMA quick_check` and its allowlisted payload must parse.
- **Runtime boundary.** The reader is Node's built-in `node:sqlite`, loaded by
  feature detection inside the extension host: no native package is bundled, no
  dependency is added to the VSIX, and no shell command is spawned. On a runtime that
  does not expose it, inactive-workspace recovery is **refused with a visible
  reason** — never reported as "nothing was stored there", and never replaced by
  starting from ambiguous old state. The fresh profile catalog itself still works, so
  a window on such a runtime is fully usable for everything except that recovery
  (approved as the stance for this change; raising the manifest's engine floor would
  be a separate support decision).
- **Supported layout matrix.** Inactive-workspace recovery is defined only for the
  layout the extension can attribute to itself:

  | Host / layout | Attribution | Recovery |
  | --- | --- | --- |
  | Local desktop extension host, default profile (`<userData>/User/globalStorage/<publisher>.<name>`) | profile root = two levels above the extension's own storage directory; `workspaceStorage` is its sibling | supported |
  | Local desktop extension host, named profile (`<userData>/User/profiles/<id>/globalStorage/<publisher>.<name>`) | same derivation, so the profile root is `<userData>/User/profiles/<id>` | supported |
  | Remote extension host | the storage path is that host's profile, and only that host's storages are read; nothing is read from the local machine | supported within that host; no cross-host merge, ever |
  | A storage path whose parent is not `globalStorage` (a foreign or wrapped layout) | derivation refuses (no profile root) | **refused**, reported as an unsupported source |
  | A `workspaceStorage` directory or database whose resolved real path escapes the profile root (symlink/junction alias) | containment refuses | **refused**, reported with the escaping path |
  | An unlistable or unresolvable `workspaceStorage` | discovery returns a reason | **refused**, reported as an unsupported source |
  | An extension host whose runtime does not provide `node:sqlite` | feature detection | **refused** with a visible reason; the profile catalog itself still works |

  The current workspace's own database is never read as a source at all: its public
  Memento is authoritative and is the only way its records enter the catalog, which is
  why a stale copy of the workspace that is open cannot re-add a row the user removed
  there.
- **Lossless, additive, once.** The catalog records the imported source identity and
  snapshot digest in the same commit as the imported records. A source that was
  imported stays imported, so reopening an old workspace can never resurrect a row or
  folder removed globally after the cutover. Identical imports are idempotent;
  existing destination IDs and order are preserved and genuinely new folders are
  appended. If two sources disagree about one exact file, tab/editor ID, broker slot
  or binding, both raw records are retained for recovery and unsafe ownership
  operations are blocked instead of selecting a timestamp. Never promote a stopped
  intent to running because another source says so. Import neither acquires a claim
  nor starts, stops, deletes or attaches a native process. A source whose own keys
  contradict each other (a binding naming a row it does not describe, a controlling
  binding whose host disagrees with that source's own conversation mapping) is
  quarantined: its coupled records are not applied, because importing half of an
  interrupted transition would authorize a transport no record proves.

The move is one-way: obsolete workspace snapshots remain untouched as historical
backups but cease to be writable authorities. An older extension build running
simultaneously with the cutover is unsupported and must not silently merge its later
workspace writes.

### Implementation status (honest, at the time of writing)

In source and typecheck-clean: the catalog (format, lock, atomic commit, refusal,
revision watch, per-key merge rules), the shared/local session split with
`refreshFromStore`, the folder/broker/shell/panel records with their merge and import
rules, the copy-only reader with the identity guard, integrity check and
profile-containment check, the import driver with its ledger, quarantines and
conflicts, activation wiring (import before the narrowed startup cohort, readiness
barrier for the serializer, watcher-driven adoption, visible refusal), claim-bound
controller election, and the compound A→B commit (conversation + binding + broker
mapping in one revision).

Not yet done, and not claimed: the sidebar's loading line is not yet in the manifest;
the focused source tests for the catalog, the import and the election are still being
written; and no runtime evidence exists yet for `node:sqlite` inside the extension
host — the reader path has been exercised only through the injected copy reader and
the repository's own Node (24.14.0, `node:sqlite` present) against read-only profile
copies. Installed-UI observation is outside this task's permission and is stated as
unobserved rather than assumed.

## Alternatives

- `globalState` in place of `workspaceState`: public Memento has no compare-and-swap
  or change event; stale cached whole-snapshot writes lose other windows' data and
  inactive-workspace data remains invisible.
- Union of workspace-specific indices on every launch: creates competing
  authorities, resurrects deleted records and can turn a stale running intent into a
  second native writer.
- Reconstruct from OMP JSONL files: cannot recover added empty folders, explicit
  stopped intent, draft identity, broker provenance or editor binding.
- A permanent metadata daemon or live SQLite dependency: larger process/deployment
  surface than a small transactional local catalog; legacy SQLite is input only.
- Reading the inactive database in place (read-only): the source would still be
  opened by SQLite, which can create sidecars in the user's profile directory. The
  copy-only reader is chosen so the source is never opened at all.
- Asking users to reopen the former workspace: public-API-safe, but does not meet the
  observed immediate recovery requirement while the new folder is already open.

## Risks and open questions

- A clean copy does not guarantee a *snapshot* of a database being written during the
  copy. The identity guard, integrity check and bounded retry reduce it to a refusal
  in the worst case; a live-WAL fixture is still to be exercised.
- The claim-bound election changes when a freshly opened editor becomes controlling:
  it is passive until its own claim is durable. A regression here would show as a
  panel that never controls its session.
- Globalizing folder `collapsed` state means a folder collapsed in one window is
  collapsed in the others — the same behavior two windows of one workspace had.
- Migration conflicts may need user-directed resolution; they stay visible and
  lossless rather than silently discarded.

## Rollout and verification

1. Review this design and ADR-0034 independently before the persistence cutover. Use
   an isolated migration fixture rather than the ordinary database.
2. Introduce the catalog, transactional operations and migration adapter; move every
   affected caller from independently writable workspace snapshots. Retain a
   read-only legacy import path only.
3. Exercise two isolated windows with different VS Code folders: restore the same
   two-row/one-folder historical fixture while the former workspace stays unopened;
   add/remove/close/Resume across windows; observe stopped intent, broker provenance,
   exact-one-launch claims, conflict refusal, idempotent import, the claim-bound
   election and the compound A→B commit. Test a live WAL fixture without changing its
   source bytes, and injected catalog/write failures.
4. Run relevant focused tests, typecheck, the complete test suite and the VSIX build.
   Install via the VS Code CLI without manipulating the user's ordinary window.
   Record UI observation only if fresh explicit computer-control permission is
   granted; otherwise state that limit.

## Related decisions

[ADR-0034](../decisions/0034-store-sessions-in-one-profile-catalog.md) narrowly
supersedes [ADR-0020](../decisions/0020-separate-folder-navigation-from-session-ownership.md) on
folder scope and [ADR-0025](../decisions/0025-bind-editor-slots-to-current-conversations.md) on
the scope of native-switch folder auto-registration;
[ADR-0021](../decisions/0021-reattach-a-verified-live-draft-on-activation.md),
[ADR-0031](../decisions/0031-reattach-a-surviving-managed-host-through-its-broker.md) and
[ADR-0033](../decisions/0033-release-stale-ownership-of-an-unidentified-launch-explicitly.md)
retain their lifecycle and ownership rules.

## Architecture Review

- Reviewer: independent architect reviews, round 2 (catalog corrective review) and round 3 (catalog delta review). Round 3 required changes; every finding it raised is now addressed in code (D1-D4 and the reopened N2), alongside the two code risks its summary named.
- Outcome: **changes required, addressed**; the document stays `proposed` because one acceptance item cannot be obtained under the current permission (below), not because an implementable item remains.

### Implemented in response to round 3

- **D1** a refused coupled mapping is a typed unpublished hold (`shared-record` vs `conflict`): the extension does not rebind, advance a runtime or expose authority, and the held record remembers the coupled key so a retry cannot publish the conversation with the previous transport.
- **D2** a promoted panel is completed: a non-controlling document still records its readiness handshake, and every controlling path (explicit open, attach, batch pass) elects before it renders and delivers the link.
- **D3** a failed election reports no role, and both extension call sites require the answer to name the conversation they asked about.
- **D4** a directory keeps its committed owner: the merge reads every contender and the established folder keeps its id, order and collapse state.
- **Credential eligibility is fenced by a consistent owner/binding check**: the reason a slot may not act is now two-sided — the window's own registry *and* the durable binding must both say this slot controls the conversation it currently serves, so a demotion recorded anywhere takes effect on every credential path (bridge route, terminal input, link delivery) instead of being copied once into local state.
- **The consumer base is explicit**: every write names the snapshot it was derived from (`update(key, desired, base)`, `transactRecords` changes, and each store's own captured base), so another window's change committed since is never read as this consumer's removal of it. The earlier "pinned by the last value handed out" approximation remains only as a fallback for a caller that names no base.

### Open

- No actual extension-host execution evidence and no installed-window visual observation: both require opening a VS Code window, which the user explicitly denied for this task. This is the single acceptance item that is unavailable rather than unimplemented. The substitutes are in place and stated honestly: `node:sqlite` feature detection with a visible refusal, the import suite passing under the installed VS Code's embedded runtime (same embedded runtime family, explicitly not extension-host execution), a clean bundle build containing one external `import("node:sqlite")`, and a source-level test suite.
