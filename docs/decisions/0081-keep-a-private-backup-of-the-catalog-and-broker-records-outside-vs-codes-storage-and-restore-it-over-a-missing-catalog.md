---
status: accepted
date: 2026-10-21
---

# ADR-0081: Keep a private backup of the catalog and broker records outside VS Code's storage and restore it over a missing catalog

## Context and Problem Statement

[ADR-0034](0034-store-sessions-in-one-profile-catalog.md) made the profile catalog in `globalStorage` the single authority for sessions, folders, bindings and broker mappings, and refuses to overwrite a catalog it cannot read. In the code a *missing* catalog is a fresh install (`emptyCatalogDocument`). On 2026-10-21 VS Code's own cleanup of an extension id whose installed versions were all marked obsolete deleted the whole `globalStorage/<id>` folder at a start. Desk then started on an empty catalog without saying anything, and seven live brokers, whose authentication tokens existed only in the deleted `pty/*.json` records, could no longer be listed, stopped or re-adopted. The full account is in the [design](../designs/2026-10-21-catalog-survives-a-storage-wipe.md).

Requirements: (1) a copy of the state that makes sessions reachable must exist where VS Code's extension lifecycle does not manage it; (2) a missing or reset catalog must never be committed as empty while a backup exists, and a loss that cannot be repaired must never be silent; (3) secrets in the copy must be protected as well as the originals; (4) several windows start at once and share one catalog lock; (5) brokers whose record is lost must at least be listable and endable.

## Considered Options

- **A private per-user folder outside VS Code, `%LOCALAPPDATA%\omp-desk\recovery\<key>`**, written after commits (rate limited), holding catalog copies and the broker records, restored automatically under the catalog lock when the catalog is missing or an empty shell. Survives the incident; per-machine; independent of OMP and VS Code; costs a second location with an ACL and a restore rule.
- **`~/.omp/desk/…`.** Survives a VS Code wipe. Rejected: the folder is Oh My Pi's; Desk is an independent project and would hold its only copy under another product's housekeeping.
- **VS Code `globalState`/`workspaceState` as the copy.** Survived this incident. Rejected: VS Code owns and prunes it, it is rewritten whole, and it is a poor place for rolling history.
- **A copy or journal inside `globalStorage`.** Rejected: the whole folder was removed.
- **`%APPDATA%` or Documents.** Rejected: `%APPDATA%` roams (a record is bound to this machine's processes); Documents is indexed, synced and backed up to places a token must not go.
- **Confirm before restoring.** Rejected: the confirmation would block activation in every starting window, cannot be answered coherently by several windows, and declining it means running on the state the decision exists to avoid. The restore overwrites nothing.
- **DPAPI-protect the records.** Rejected: nothing the owner-only ACL does not give against other accounts, nothing against the same account (the boundary ADR-0006 accepts), and it can make the backup unreadable exactly when needed.
- **Rebuild rows from OMP's session files when no backup exists.** Rejected: it mints new tab ids and cannot re-attach restored editors; folder History's Resume stays the manual route.
- **Refuse to start while evidence exists and no backup does.** Rejected: nothing can be rebuilt from that evidence.
- **Order copies by the document's revision.** Rejected after review: the revision restarts after a wipe and after an operator replaces the catalog.

## Decision Outcome

Adopt the first option, with these rules.

1. **Location and key.** `%LOCALAPPDATA%\omp-desk\recovery\<key>\`, `<key>` = the first 16 hex digits of SHA-256 over the lower-cased normalised `globalStorageUri` path. `OMP_DESK_RECOVERY_ROOT` replaces the root for tests. No resolvable root means no backup, reported.
2. **Content.** `catalog\catalog-g<generation>-r<revision>-c<rows>x<folders>-<hash8>.json` (a committed document byte for byte, only if it validates) and `brokers\<record>.json` (records of live brokers, token included). A *generation* is one incarnation of the catalog: it increments when the writer sees a document whose revision is below the highest it stored (a replacement); an empty document that regressed is never copied and starts no generation. Claims, bridge descriptors, the window registry, pending launches and consent records are runtime state and are not backed up.
3. **Protection.** The recovery folder is brought under the owner-only convention (`restrictPrivateStorage`) before the first write and before any restore read, **outside** the catalog lock, with the verdict cached; one that cannot be shown owner-only is not used and that is reported. A restored record is validated, names a live process by creation time, is written by `claimPtyRecord` to its slot's path (never overwriting) and only after `ensurePtyStateAccess` reports `ok` for `pty/`. A record copy is rewritten at least daily while its broker is alive, removed when the broker is provably gone, and removed at 14 days without a refresh; a record missing from `pty/` never deletes its copy. A sweep removes orphaned recovery folders.
4. **Writing.** Per window, from the store's change notifications: at most one catalog write per 30 s (leading edge plus one trailing), a seed copy 10 s after the startup restore, broker copies refreshed at most every 60 s. No lock: names are content-addressed, writes are stage-and-rename, pruning is idempotent and deletes only what it listed outside its retain set.
5. **Retention.** Per window's view at most 24 copies: the newest 6 by `(generation, revision)`, the newest of each of the last 7 UTC days, and the **peak** (most rows plus folders written within 30 days).
6. **Restore rule.** A hook of `transactCatalog`, run under the catalog lock on the document just read, supplies the base document when the file is missing or the caller's `isReset` holds (no rows and no folders, with a revision lower than the newest generation's top copy, which has data). The candidate is the highest revision of the newest generation, whatever it holds, falling back through older copies that validate. It is committed first as `max(its revision, the read document's, the window's last known) + 1`, then the caller's operation runs; a restore commits even if the operation changes nothing. `createProfileCatalog` runs it once before any consumer reads, with an operation that returns `false` (no revision on a normal start), and adopts the restored document by a re-read. A window that knew revision R > 0 and finds the file missing recovers from the newer of its own last document and the newest copy. A document at the known revision with different content is adopted like any foreign state. The restore is **automatic, with no confirmation**, logs at Info and shows one non-modal notice with the copy's age.
7. **Nothing is silent.** A missing catalog with no usable backup but with evidence (local observations, restored editors naming missing tabs, record files, unmanaged brokers), a backup that exists but cannot be used, and a catalog that regressed to fewer sessions than the previous generation each produce one Warn and one notice (deduplicated across windows by a marker file in the recovery folder); the window continues on what it has. With no evidence a first install shows nothing.
8. **Unmanaged brokers.** The Sessions view (Terminals group) lists brokers of this storage that no record names, found by command line through two native reads (`processTable`, `processCommandLine` by `NtQueryInformationProcess`) and older than 15 s. They are `source: "unmanaged"` rows: Stop (authenticated) is unavailable with an explanation, Kill works after the creation time (read from the kernel when the row was derived) and the command line are proved again, Kill reconciles nothing in the catalog, and Kill All, Stop Orphaned and Idle ignore them.

Amendments: ADR-0034 is amended in its treatment of a degraded catalog (a missing document is a fresh install in the code, unless a backup or a reset shell shows data existed; the refusal for an unreadable document, the lock, the commit and the merge rules are unchanged). ADR-0060 is narrowly extended: the Terminals group may contain rows Desk has no record for, Kill may end them with an identity read from the kernel, and no authenticated route exists for them. ADR-0006's same-user boundary and ADR-0029's refusal to claim an uncontained tree stopped are unchanged.

### Consequences

- Positive: a wipe of `globalStorage` no longer loses sessions, folders or the means to reach running brokers; the data is back within seconds of the next start, serialised across windows; a loss with nothing to restore from is announced; stranded brokers can be seen and ended.
- Negative: a second location with a secret in it and an ACL to maintain; a restore rule inside the catalog transaction; two native reads; the user who deliberately resets Desk must also delete the recovery folder (documented); a stale backup restores stale rows (the notice says how old); a copy of a semantically bad catalog is kept like a good one (history is the mitigation).
- Residual: the recovery folder can be deleted by a disk cleaner or the user; a degraded catalog that still has rows is announced but not repaired automatically; a restored `running` row whose broker is alive but whose record was not backed up can be resumed explicitly into a second writer (the unmanaged row names the session file); a later schema bump must keep a reader for the previous catalog version or accept that older copies are not restorable.

## Related Documents

- [Design: the catalog survives a wipe of VS Code's extension storage](../designs/2026-10-21-catalog-survives-a-storage-wipe.md).
- [ADR-0034](0034-store-sessions-in-one-profile-catalog.md), [ADR-0006](0006-host-generated-key-peer-verified-pipe.md), [ADR-0012](0012-run-child-process-entries-from-staged-copies.md), [ADR-0029](0029-report-uncontained-pty-tree-stop-as-unknown.md), [ADR-0039](0039-refuse-only-on-a-verified-live-writer-the-extension-owns.md), [ADR-0060](0060-merge-background-processes-into-sessions-and-kill-all-through-authenticated-routes.md), [ADR-0076](0076-call-win32-in-process-through-a-staged-koffi-module-instead-of-starting-powershell.md).

Backup and restore are indexed in [Architecture: Cross-window invariants](../architecture.md#cross-window-invariants).

## Architecture Review

- Reviewer: independent reviewer agent (read-only; verified the claims against the code), 2026-10-21.
- Outcome: accepted with required changes; all 20 findings were taken into the design and this ADR: revision-as-clock replaced by generations (1, 2, 8), degraded catalog with rows announced and the limit stated (3), `pty/` verdict before restoring tokens (4), record copies refreshed while the broker lives (5), verification before the lock (6), adoption of the restored document by re-read (7), `reconcile: none` for unmanaged Kill (9), "Sessions view" naming (10), unusable backup reported (11), second-writer Resume recorded as a residual risk (12), orphaned recovery folders swept (13), amendments recorded in ADR-0034 and ADR-0060 (14), no-change activation transaction returns `false` (15), unknown command-line reads retried and the 15 s grace stated (16), the 24-file bound stated per window (17), record destination by slot (18), schema-version gate recorded (19), notice deduplication across windows (20).
