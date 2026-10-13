---
status: proposed
date: 2026-09-28
---

# ADR-0034: Store Sessions in one transactional profile catalog

> **Narrowly amended by [ADR-0045](0045-derive-window-folders-per-window-and-pin-with-identity-ids.md):** the profile-wide folder list holds the pinned folders only; folders VS Code has open are shown per window and keep their collapsed state per window.

> Ownership/controller clauses narrowed by [ADR-0039](0039-refuse-only-on-a-verified-live-writer-the-extension-owns.md): stale/unverifiable claims and sticky import disagreements do not veto session operations. Unowned editors may control their surface. Catalog read/merge/lock integrity failures still protect the catalog itself.

> **Amended before the first release:** the read-only importer of per-workspace Memento state described below was removed, because no earlier build was ever published and its source could never exist for a new extension id. A one-time, ledger-bound import of only the registered folder list from the predecessor extension id's catalog (`src/wiring/predecessor-import.ts`) replaced it. Statements below about the legacy importer are historical.

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
the selected tab — stay in that window's local store,
because publishing them would let a rival window's failed attach or failed probe
report a failure over a session another window is running. A row with no local
observation derives its status from the shared record. Amended with the flat Sessions
list: the reply a user has read (`lastSeenReplyId`) is shared with the row's
`lastCompletedReplyId`, because a read marker kept in one window's workspace state was
lost whenever that window opened another folder and every finished session then showed as
unread; reading a session in any window clears its mark in all of them.

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

### Amendment (2026-10-12): the conflict ledger is bounded per disagreement

The conflict ledger was declared non-evicting so that no raw record two sources disagreed about is lost without a retention policy; it had none. A real profile reached 613 KB, 589 KB of it 215 records of one reason (`another window changed this row while this window changed it too; this window's own facts were applied`, each holding both whole rows), and every transaction of every window parses, serializes, fsyncs and re-reads that file. Conflict entries are forensic: production code does not consult their contents as ownership, admission or reconciliation authority (ADR-0039). Retention does not change those decisions; the catalog's schema and integrity checks, which refuse an unreadable or malformed ledger, are unchanged.

Retention is now **per disagreement, never per ledger**: records are grouped by the exact `(key, identity, reason)` and a group keeps its newest three records. "Newest" and "oldest" mean ledger append order, not timestamp order; surviving records keep their relative order. Each record a group drops contributes `1 + (its own earlier ?? 0)` to the `earlier` count of the oldest record that remains, so the ledger still says how often that disagreement happened. A different row, a different reason, an import disagreement, a lock reclaim (its identity is a fresh token) and a quarantined source are different groups and each keep their records, so no identity or kind of disagreement is forgotten. After a commit by this build every exact group has at most three records; the number of groups and the total size remain unbounded. This replaces unlimited raw retention with recent raw samples: the payloads of dropped records, including older import or quarantine payloads of a repeated group, are not recoverable from `earlier`, and `source` is not a grouping dimension. The rule runs on the newest committed ledger inside every revision-changing transaction (the same lock that applies the change), so a ledger written by an earlier build shrinks on the next ordinary commit without a migration step and without a window deciding it from a stale view. A transaction that changes nothing writes nothing and does not compact. `earlier` is optional: a build that predates it reads the ledger and drops the field on its next write, so in mixed-build operation lifetime counts and continuous enforcement are not guaranteed. The import ledger is unchanged.

### Amendment (2026-10-13): how a window reads the catalog and learns of a commit

**Status: accepted after independent architecture review (accept with required changes; all addressed, see "Amendment Review (2026-10-13)" at the end).**

A reload of three windows at once (build 5416066, 2026-10-13 18:16 local time, 16:16 UTC; the log stamps below are UTC) left one window restoring for 62.8 s with two PowerShell starts: attach `intent` 16.1 s and 19.0 s, `persist` 6.9 s and 7.9 s, controller elections 29.5 s, and a slot binding refused with "The editor mode could not be recorded durably". All three windows logged event-loop stalls of 0.5–6.6 s (the largest, window 3's 6.6 s, with 0.5 s of process CPU and before any Desk operation was marked: the host was starved) and many `catalog adoption` operations in flight (each stall report names at most six marked operations; the six named in the two reports at 16:17:15 were all catalog adoptions, with 9 and 10 further marked operations of any kind). `intent` and `persist` are catalog commits (`#persistNow`), and a refused binding is a failed commit.

- **Cause [INFERENCE for the incident; MEASURED for the mechanism].** On Windows a rename over the document fails while any process has it open. A committing window keeps the catalog lock while it retries the rename (about 2.1 s), and every other window's commit waits on that lock for at most 4 s. A window read the document with an asynchronous `readFile`, which keeps the file open across several event-loop turns, so a read that was in flight when that window's loop stalled kept the document open for the whole stall. The logs prove the stalls, the long commit steps and the refused binding; they do not record which handle blocked which rename, whether the refused commit ended in a lock timeout ("busy") or an exhausted rename retry (the message names neither), nor whether the stalled window was a reader or a lock holder. A lock holder whose own loop stalls mid-commit fits the same logs and is not removed by this amendment. Measured mechanism: in isolation, a reader stalled 2.5 s after starting `readFile` kept a peer's rename failing until the stall ended (2.0 s, 33 attempts); the same reader with a synchronous read blocked it for 1 ms. Three real processes ran the catalog code on a copy of the real 164 KB catalog (135 KB of it conflict ledger), two committing 25 times each and one stalling its loop for 1.5 s right after starting a read (at most once per 600 ms, by construction): before the changes below the two committing windows had a median commit of 2.2–2.4 s and 13–18 of 25 commits refused; after decisions (1) to (3), a median of 50–62 ms and none refused. That run does not use the coalescing of decision (4), which is supported only by the log co-occurrence of many in-flight adoptions with a 1.3 s stall at full process CPU. Three further sources of reads close to a peer's commit: the watcher also reported each commit's staged sibling (`catalog.json.<pid>.<uuid>.tmp`), so windows re-read the document while a commit was between staging and rename; the committing store re-read the document it had just written; and adoption (re-reading the record and republishing Sessions, the launcher and the folder list) ran once per trigger and in parallel, so a burst of commits released a burst of identical adoptions at once.
- **Decision.** (1) A window reads the document with one synchronous call (`readFileSync`): the file is opened, read and closed without returning to the event loop, so no loop stall *between the steps of a read* can keep it open. (2) The committing store applies the revision it wrote from the text it wrote, parsed and validated exactly as a read is, and does not read the file again for it. (The adoption that the commit's notification starts still reads the document once, synchronously.) (3) The watcher reports only the document itself, never a staged sibling. A missed signal is still recovered by the revision comparison at the next focus, visibility change or explicit refresh. (4) A window runs one adoption at a time; every trigger that arrives meanwhile is folded into one follow-up that starts after it, so a caller that asked for the newest revision is never answered by an adoption that began before it asked.
- **Unchanged.** The lock and its 4 s bound, the durable commit (stage, flush, rename with its retry), the per-record merge rules, the refusal of an unreadable catalog, and what an adoption does. A rename blocked by an antivirus or indexer is still retried and still reported. The catalog lock file is still read asynchronously and must stay so: a stalled reader of `catalog.lock` does not block its removal (checked with a stalled reader under Node 24: the name disappears at once and a new exclusive create succeeds). A window whose loop stalls *while it holds the lock* still delays the others for that long.
- **Consequences.** A synchronous read of a document this size (164 KB) takes 0.2–0.6 ms warm; the document's total size is not bounded (see the previous amendment), so a much larger catalog makes the read proportionally longer. A stall *inside* the synchronous call (disk latency, a scanner on open) still holds the document open and now also blocks this window's extension-host thread, which every extension in that window shares. With decision (4) a window learns of another window's commit only when its adoption in flight finishes: that adoption waits on the index's write queue (`refreshFromStore`), which can take seconds when commits are slow, so `store.get` and the broker and shell slot tables show another window's state later than before; correctness is unchanged because every commit merges under the lock. The startup adoption and the Processes view's fresh catalog read may wait for one run in flight plus the follow-up. An adoption that finds a newer revision notifies this window's own listener, so it is followed by one more run, as before but in series. The vehicle is an amendment because it records a Windows constraint future changes must respect: never read `catalog.json` asynchronously.

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

## Amendment Review (2026-10-13)

- Reviewer: independent architect agent (`Adr0034ReadAmendmentReview`, read-only; round 2 `Adr0034ReadAmendmentReview2`), static review of the amendment, `profile-catalog.ts`, `coalesced-run.ts`, the adoption wiring in `extension.ts` and the tests, with its own reproduction of the isolated reader stall and the three-process run.
- Round 1: **accept with required changes.** No durability, ownership, merge, refusal or stale-snapshot invariant is weakened, no deadlock in the adoption queue, the watcher still recovers a missed event at focus, visibility and explicit refresh. M1: "does not open the file again" was false for the window as a whole (the adoption a commit triggers reads once). M2: a synchronous read still holds the file for whatever happens inside it (disk latency, a scanner), so the claim narrows to stalls between the steps of a read, and the consequence adds that the host thread is blocked. M3: the cause was overstated (a stalled lock holder fits the same logs, the logs cannot tell a lock timeout from an exhausted rename retry) and the measurement covers decisions 1 to 3 only. Non-material: log figures, a stale comment, parsing inside the lock, a dead fallback, a test that would pass on the old code, the consequences of coalescing, the asynchronous lock-file read that must stay.
- Round 2: **changes required, text only**: two documents still said the window does not re-read after its own commit, the status line pointed to a section that did not exist, and one time-zone label was missing. All three are corrected.
- Not verified by the reviewer: any real multi-window reload with the change; the exact original benchmark command (the figures were reproduced with the same scripts).
