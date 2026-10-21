---
status: accepted
date: 2026-10-21
---

# The catalog survives a wipe of VS Code's extension storage

## Problem

On 2026-10-21 VS Code deleted the whole `globalStorage/<publisher>.<name>` folder of OMP Desk at a start. The extension did not do it. VS Code's own cleanup of "uninstalled" extensions (`deleteExtensionsMarkedForRemoval`, then `ExtensionsLifecycle.postUninstall`) removes the storage folder of every extension id whose installed versions are *all* listed in `extensions/.obsolete`. A forced reinstall (`code --install-extension --force`) that failed half way left exactly that state: every folder of the id was either deleted or marked, so the id counted as uninstalled for one start. The next start of the extension found no catalog and started silently on an empty one.

What was in that folder, and why it hurt:

- The profile catalog (`catalog/v1/catalog.json`): every session row, the registered folders, the broker-slot and shell-slot tables, the bindings of editors to conversations, the run intents. It is the only copy.
- The broker records (`pty/pty-*.json`): one file per background broker, holding **the authentication token** the broker accepts. The broker never republishes it. Seven live brokers, each running an OMP session, became unreachable: they could not be listed, stopped or re-adopted by the product, and the session files they write were open under a process Desk no longer knew.
- Claims, bridge descriptors, pending launches, the window registry and consent records: runtime state that is rebuilt when a window starts or a row is opened.

VS Code's own state that survived the same event (the per-workspace editor state, the Memento of each window with its local observations) *named* the lost sessions: six restored editors asked for tab ids the new catalog did not have, and each window logged "adopted 0 new row(s)" and carried on. Nothing told the user their sessions were gone. After the loss the old build's windows kept writing: the catalog had two rows within minutes, which is why a rule that only recognises an *empty* catalog would not have recognised this one.

The user's goal: the catalog must not be a single source of truth that VS Code can erase. Keep a copy VS Code does not manage, and rebuild from live processes and OMP's own files where a copy does not exist.

## Goals and Non-goals

Goals:

1. A copy of the catalog and of the broker records of running sessions exists **outside** every folder VS Code's extension lifecycle manages, is current within seconds of a change, and has bounded size and history.
2. A start whose catalog is missing, or is an empty shell of a lost one, while a backup exists **restores** from the newest backup, automatically, once, serialised across windows, with an Info log line and a notice. It never commits an empty catalog over a backup.
3. A start whose catalog is missing and that cannot be restored (no backup, or one that cannot be used) but has other evidence (local observations naming tabs, restored editors naming tabs, brokers running with no record) says so, visibly and once. A catalog that *regressed* to fewer sessions than its backup (a degraded catalog that still has rows) is announced too, with the backup's location. Nothing here is silent.
4. A broker process of this profile whose record is lost is **listed in the Sessions view (Terminals group) as unmanaged** (found by its command line) and can be killed from there.
5. The secrets in the copy are protected as well as the originals.

Non-goals:

- Rebuilding session rows from OMP's JSONL files without a backup. Rows carry Desk-only facts (the tab id that restored editors name, bindings, run intent, folder registrations) that no JSONL holds. Folder History's *Resume Session* already imports a row from a file; it stays the manual route.
- Re-adopting a live broker whose record exists in no copy. Without the token the broker cannot be authenticated to; the product can only list and kill it.
- **An automatic repair of a catalog that has rows but fewer than its backup.** Whether it is a degraded catalog or a deliberate repair (an operator replaced the document) cannot be told from the file; the user is told and the backup is kept (goal 3). A *Restore Sessions from Backup…* command that merges missing rows without resurrecting removed ones needs its own design (see Alternatives); the manual route is in the troubleshooting guide.
- Protecting against deletion by the user of the backup folder itself, or against a second machine, a roaming profile or a reinstall of Windows.
- Changing how VS Code installs extensions. The release procedure's preflight (never start VS Code with no live version folder) stays the first defence; this design is the second.
- Holding a restored `running` row back until its process is accounted for (see Risks): that is session-index behaviour owned by another change.

## Current State

- `src/host/profile-catalog.ts`: one JSON document per local profile in `<globalStorage>/catalog/v1/`, committed by stage-and-rename under `catalog.lock` ([ADR-0034](../decisions/0034-store-sessions-in-one-profile-catalog.md)). A missing document is "a fresh install", created by the first commit; an unreadable one refuses writes. There is no second copy, journal or last-good file.
- `src/host/pty-registry.ts`: broker records in `<globalStorage>/pty/`, created once by the broker (`claimPtyRecord`), immutable afterwards, protected by an owner-only ACL that `ensurePtyStateAccess` establishes and verifies ([ADR-0006](../decisions/0006-host-generated-key-peer-verified-pipe.md): the same-user boundary is the stated trust boundary).
- `src/host/broker-processes.ts` and `src/wiring/process-wiring.ts`: the process rows (the Terminals group of the Sessions view; [ADR-0060](../decisions/0060-merge-background-processes-into-sessions-and-kill-all-through-authenticated-routes.md) removed the separate Processes view) are exactly the records of `pty/` whose broker process is alive and is the process the record describes. A broker without a record is invisible.
- `src/host/session-kill.ts`: Kill ends a row's broker tree by `taskkill /T /F` after proving the recorded process identity (creation time); it needs no token.
- `src/host/win32-native.ts`: in-process Win32 calls through the staged `koffi.node` ([ADR-0076](../decisions/0076-call-win32-in-process-through-a-staged-koffi-module-instead-of-starting-powershell.md)): creation time, descendants, pipe client, security reads. No command-line read.
- A restored editor that names a tab the catalog does not have is only logged and left as an explanation (`editor-panels.ts`).

## Proposed Design

### 1. Where the copy lives

`%LOCALAPPDATA%\omp-desk\recovery\<key>\`, where `<key>` is the first 16 hex digits of the SHA-256 of the lower-cased, normalised absolute path of this window's `globalStorageUri`. The key makes a second VS Code flavour or user-data directory (Insiders, a portable install, the isolated test profile) a different copy, so two stores never restore into one another.

Why this location, in the order the choice was weighed:

- **Not VS Code's.** Everything under `%APPDATA%\Code`, `~/.vscode/extensions` and their `globalStorage`/`workspaceStorage` folders is managed by VS Code's lifecycle. The Memento (`globalState`, `workspaceState`) is the same private SQLite store the uninstall cleanup and the profile removal manage, is rewritten in whole, and is not a place for hundreds of kilobytes of rolling history.
- **Not `~/.omp`.** That folder is Oh My Pi's own: its layout, its housekeeping and any reset of OMP are OMP's to decide, and Desk is an independent project, not an OMP distribution, that keeps its state out of another product's folder. A backup there would be exposed to a user's "clean up OMP" and to any future OMP change of that folder, which is the same single-owner problem moved to a different owner. [INFERENCE] that such a change is likely; the objection is ownership, not a known incident.
- **`%LOCALAPPDATA%`, not `%APPDATA%`.** `%APPDATA%` roams in a domain profile; a broker record is bound to this machine's processes and pids, and a catalog restored onto another machine from a roamed copy would name sessions whose files and processes are elsewhere. `%LOCALAPPDATA%` is per-user and per-machine, is where the isolated test profiles already live (`scripts/test-vscode.ps1`), and is the location whose ACL the existing owner-only convention is verified against in the tests of the private-storage module.
- **Not a repository or the workspace.** A copy next to user files could be committed or swept up by a clean.

`%LOCALAPPDATA%` unset falls back to `<home>\AppData\Local`; neither resolvable means no backup (reported as in section 6). A test or an isolated environment may point the root elsewhere through `OMP_DESK_RECOVERY_ROOT`; the variable is for tests and is not a setting.

Layout inside `<key>\`:

| Path | Content |
| --- | --- |
| `source.json` | The storage path this copy belongs to and the extension version that wrote it. Used by the cleanup of folders whose storage is gone (section 4). The key is the authority. |
| `catalog\catalog-g<generation>-r<revision>-c<rows>x<folders>-<hash8>.json` | One committed catalog document, byte for byte as read from `catalog.json`. The name carries the **generation** (below), the document's revision, the number of session rows and registered folders, and the first 8 digits of the SHA-256 of the text, so two windows writing the same document write the same file and retention can rank copies without reading them. |
| `brokers\<record-file-name>.json` | A copy of one broker record of `pty/`, token included, of a broker that is alive. |
| `notice-<kind>.json` | When a loss notice was last shown, so that several windows show one (section 6). |

**Generation.** A catalog's revision restarts at 1 after a wipe and after an operator replaces the document (the incident's own repair wrote revision 13 over a lost 7979), so a revision is not a clock across incarnations of the catalog. A *generation* is one incarnation: it is `max(generation of the copies) + 1` when the writer sees a document whose revision is **below** the highest revision it has stored in the newest generation (a replacement), and otherwise the newest generation. A document that regressed *and is empty* (no rows, no folders) starts no generation and is not copied: it is the shape of a freshly wiped catalog, and recording it as the newest incarnation is what would hide the real one. Copies are ordered by `(generation, revision)`, and wall-clock times (file modification times) are used only for the daily retention and the age of a copy.

### 2. What is backed up, and what is not

Backed up: the catalog (folders, rows, run intents, bindings, broker and shell slot tables, import ledger, conflict ledger) and the broker records of live brokers. Together they are what makes a running session reachable again: the catalog says which conversation a slot hosts, the record holds the token.

Not backed up, by design: session claims, bridge descriptors, the window registry and window requests, pending launches, host-control keys (those live in `SecretStorage`, which survived the incident), native consent records. All are either runtime state a window rebuilds when it starts or a row is opened (claims are re-taken, a bridge descriptor is republished per window), or a consent whose loss only turns an opt-in feature off. Backing them up would restore a stale claim and a dead descriptor, which is worse than nothing.

### 3. Secrets

A broker record is a bearer capability for a broker running as the same account: [ADR-0006](../decisions/0006-host-generated-key-peer-verified-pipe.md) states the same-user boundary explicitly, and the original `pty/` folder is protected by an owner-only ACL and nothing else. The copy is protected the same way and no better:

- Before the first byte is written, and before any read for a restore, the recovery folder is brought under the existing owner-only convention through `restrictPrivateStorage` (the one `pty/` uses: inheritance removed, only the account, SYSTEM and Administrators granted, ancestors verified not writable by others, a probe write). A folder that cannot be shown owner-only is not used: the backup writer stays off and the restore reads nothing. That is **reported** (section 6), not just logged. A copy that anyone else could rewrite would also be an injection route for a record that points Desk's token at another process.
- A restored record must parse as a broker record, name a process creation time, and name a process that is alive **with that creation time** (`queryPtyProcessIdentity`); anything else is skipped. It is published by `claimPtyRecord` to the path its slot names, which never overwrites a record, and **only after the `pty/` folder itself has been shown owner-only** (`ensurePtyStateAccess`): a token is never written into a folder whose access has not been verified. If that verdict is not `ok`, the records are skipped with a reported reason and the catalog is still restored.
- DPAPI is not used. It protects a secret from other accounts, which the ACL already does, and gives nothing against code running as the same account, which ADR-0006 does not defend against either. It would add a failure mode at the worst moment: a profile whose DPAPI master key changed (password reset, profile repair, a different logon) could not read the backup it was made for.
- A copy lives as long as its broker. While the broker is alive the writer **rewrites** its copy at least once a day, so a copy's modification time says "still alive and still ours"; a copy is removed when the broker is *provably gone* (identity probe: gone, or the pid belongs to a process created later), and a copy that has not been refreshed for 14 days is removed whatever the probe says (its writer is gone, or the broker cannot be probed). A record missing from `pty/` is **never** a reason to delete its copy. The token therefore does not outlive the process it opens, and a session that runs for months keeps its copy.

### 4. When the copy is written

A backup writer in each window (`src/host/catalog-backup.ts`, no `vscode` import) is told when the catalog changed (the store's own `onChange`, which also carries other windows' commits) and:

- reads `catalog.json` synchronously (the same read as `readCatalogDocument`) and validates it with the same parser; an unreadable document is never backed up;
- decides the generation (section 1), and skips a document whose `(generation, revision, hash8)` is already stored;
- writes the text to a staged sibling, flushes, renames it to its name;
- **rate limit**: at most one write per 30 s per window, leading edge, with one trailing write for changes that arrived inside the interval; a burst of commits at start costs one write. At the first activation it also seeds a copy when none exists for the current document, 10 s after the startup restore, off the critical path;
- once per 60 s at most, refreshes the broker-record copies by the rule of section 3;
- once per process, off the critical path, **sweeps the recovery root**: for every sibling `<key>` folder it applies the broker-copy rule of section 3 (a copy whose broker is provably gone, or that was not refreshed for 14 days, is deleted), and it removes a whole folder when its `source.json` names a user-data directory that no longer exists *and* nothing in it was written for 180 days. A storage folder that was wiped while its user-data directory remains is exactly the case the copy exists for, so the existence test is on the user-data directory (the parent of `globalStorage`), never on the storage folder itself.

**Retention** per catalog folder: the newest 6 copies by `(generation, revision)`; the newest copy of each of the last 7 UTC days; the **peak**, the copy with the most content (session rows plus registered folders) written in the last 30 days, kept even when 20 newer copies are smaller. This is the rule that would have saved the incident's data a second time: after the loss, the new empty catalog's first 13 revisions would otherwise have rotated the real one out of a plain "newest N" ring within minutes. The retain set always contains the newest copy of the newest generation. A window deletes only files it listed itself and only files outside its retain set, so two windows pruning at once can only agree or both miss. Without a lock the bound is "at most 24 copies per window's listing"; two windows pruning from different listings can briefly leave a few more, which the next prune removes.

**Multi-window concurrency.** Backups take no lock: file names are content-addressed by generation, revision and hash, every write is stage-and-rename, and the prune is idempotent. The catalog lock is taken for exactly one thing, the restore (next section), because that is the one operation that writes `catalog.json` from outside a normal transaction.

### 5. The startup rule: a missing catalog is not a fresh install while a backup exists

`transactCatalog` gains one hook, evaluated **under the catalog lock, on the document it just read**: when the document is missing, or the caller's `isReset` predicate holds, the hook `recover(current)` may return a document. If it does, that document is committed first, as the new revision `max(its revision, the read document's, the window's last known revision) + 1`, and the caller's own operation then runs against it; a recovery is committed even when the operation then changes nothing. The hook is the only place the rule lives; the three situations it covers are:

1. **A start after a wipe.** The store's `recoverIfNeeded()` is called inside `createProfileCatalog`, before the store is handed to any consumer, so activation never builds a view from the empty projection. It runs a transaction whose operation **returns `false`** ("nothing to change"), so a start with a present catalog commits nothing and takes no lock (it only runs when the document was missing at open). When the transaction finds that another window already restored, the store **re-reads the document and adopts it** before returning; a no-change transaction carries no document, so without that re-read the second window would keep an empty projection.
2. **A reset shell.** An older build, or any writer unaware of this rule (a window that was not reloaded after an update), committed an *effectively empty* catalog (no session rows, no folders) after a wipe. `isReset` holds when the document has no rows and no folders, the newest generation's top copy is substantive (has rows or folders), **and** the document's revision is lower than that copy's. A catalog the user deliberately emptied only ever gains revisions, and its own empty document is the top copy, so it is never read as reset. The shell's records are carried onto the restored ones by each key's own merge rule (as a delta with no base); a key without a merger keeps the restored value.
3. **The file vanishing under a running window.** The store remembers the last document it read or wrote. A transaction that finds the file missing while the window knew revision R > 0 recovers from the newer of its own last known document and the newest backup, instead of from nothing. The watcher's refresh that sees the file missing starts that recovery itself, so a window heals the catalog without waiting for its next write. Because a restore can reuse a revision another window had already committed with different content, a refresh that reads a document at the window's own revision but with different content adopts it like any foreign state: the window's consumers re-merge their own changes by the ordinary delta rule on their next write.

**Verification before the lock.** The owner-only verdicts of the recovery folder and of `pty/` cost a second or more (they run a security read and a probe write; `private-storage.ts`), and the catalog lock waits only 4 s. The store therefore takes both verdicts **before** it acquires the lock, through an option that runs while a recovery is wanted, and caches them for the process; the hook under the lock reads only the cached verdicts, the candidate files and the commit.

Decision: **restore automatically, no confirmation.** A confirmation would have to be answered while activation is blocked on the catalog, in as many windows as are starting; it cannot be answered coherently, and declining it means running exactly the empty state the rule forbids. Restoring cannot overwrite anything: the document it replaces does not exist or is an empty shell. The cost of a wrong restore (a user who deliberately wiped the storage to reset Desk gets their old rows back as stopped rows) is small, visible and documented; resetting completely means deleting the recovery folder as well, which the troubleshooting page says.

What a restore does, in this order, under the catalog lock:

1. Pick the candidate: the copy of the **highest revision of the newest generation**, whatever it holds (a catalog its user emptied on purpose is restored as empty, which is what the user left); if it does not validate (the same parser as a read) the next copy of that generation is tried, then the previous generations, and each failure is named in the log.
2. Restore broker records (section 3's checks): a crash here leaves the catalog still missing, and the next start repeats it.
3. Commit the catalog document by the normal stage-and-rename.
4. After the lock is released: log at **Info** (`catalog: the profile catalog was missing … restored revision N (R sessions, F folders) from the backup of <time>; K broker record(s) of running sessions restored; …`), and the window that restored shows one non-modal notice when the restored catalog has sessions or folders: "OMP Desk found its saved sessions missing and restored N sessions and F folders from the backup of <relative time>. Running sessions reconnect when you open them." with **Show Log**. If brokers of this storage are running that no restored record names (unmanaged, section 7), the notice adds that K OMP processes are still running without a record and names the Sessions view; see Risks.

Other windows that find the catalog already restored adopt it as any other foreign revision.

### 6. Nothing is silent

Three situations, all reported through one notice mechanism (`src/host/catalog-loss.ts`) that shows a non-modal message with **Show Log** and a second button when one applies, and writes a `notice-<kind>.json` marker in the recovery folder when it can, so several windows show it once per ten minutes:

| Situation | Text (summary) | Second button |
| --- | --- | --- |
| The catalog is missing and **no backup exists**, with evidence | "OMP Desk's saved sessions were not found and no backup exists. This window remembers N sessions, M open editors belong to them and K OMP processes are still running." | Show Sessions |
| The catalog is missing and a backup exists but **cannot be used** (the folder cannot be shown owner-only, every candidate failed to validate, no recovery root) | The same, with "A backup exists but could not be used: <reason>." | Show Log |
| The catalog **regressed** to fewer sessions than the newest stored generation had (the writer started a new generation whose document has fewer rows than the previous generation's top copy) | "OMP Desk's saved sessions look reset: N sessions now, M before. The previous catalog is kept in the backup folder." | Show Backup Folder |

Evidence for the first two rows is gathered from facts that survive in VS Code's own state:

| Evidence | Source |
| --- | --- |
| Observations | this window's local observations (`omp.sessionIndex.local.v1` in `workspaceState`) name N tab ids the catalog lacks |
| Restored editors | VS Code restored M Desk editors that name a tab the catalog lacks (`editor-panels.ts`: today only a log line) |
| Brokers | K broker processes of this storage are running and no record names them (section 7); L record files exist in `pty/` while the catalog is missing |

If any is non-zero: one Warn log line with the counts and the notice. The editors named M stay as the explanation panels they are today. The window then continues on an empty catalog; it is not blocked, because refusing to start gives the user nothing a notice does not, and the data cannot be conjured from this evidence (local observations carry availability and detail keyed by tab id, not files). The evidence arrives at different times (observations at once, restored editors as VS Code revives them, brokers after a lazy enumeration); a small aggregator collects it, shows the notice once 3 s after the first item, extends that wait once by 5 s when more arrives inside it, and logs later items without a second notice. With no evidence at all (a first install) nothing is shown.

### 7. Unmanaged brokers

`Win32Native` gains `processTable()` (the Toolhelp snapshot it already walks, with the executable name) and `processCommandLine(pid)` (`OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION)` and `NtQueryInformationProcess(ProcessCommandLineInformation)`, which returns the command line in one call without reading another process's memory). A pure module `src/host/unmanaged-brokers.ts` splits a command line by the Windows rules and recognises a broker: an argument whose file name is `pty-broker.js`, a `--slot`, a `--kind`, and a `--storage-dir` equal to this window's storage directory (case-insensitive, normalised). The command line carries no secret (`buildBrokerArguments`: "Nothing secret is on this line"), and a test pins the recogniser to that builder.

The reader merges, on every read, brokers found this way whose `(pid, creation time)` no record names: they become rows with `source: "unmanaged"`:

- A broker younger than 15 s is not listed: it may be about to publish its record. A command-line read the kernel refused (`unknown`) is not cached as "not a broker"; it is tried again at the next scan. Only a readable line or a gone process is remembered per `(pid, creation time)`.
- `status: "unmanaged"` (not `orphaned`, which means "no durable source references it", and the catalog may reference it again after a restore); a tooltip says "Desk has no record for this process, so it cannot reconnect to it" and shows the slot, the folder and the session file from its command line.
- **Stop** (the authenticated route) is unavailable with that explanation; **Kill** (existing, `ompDesk.killSession` on a process row) works: it already ends the broker's tree by `taskkill /T /F` after proving the identity, and for an unmanaged row the identity is the creation time **read from the kernel when the row was derived**, proved again, together with the command line, immediately before the kill (`verifyUnmanagedBroker`). `reconcileOfRow` returns `none` for an unmanaged row: Kill removes no shell-slot record and no broker-slot mapping, which a restore may just have legitimately restored. Kill All, Stop Orphaned and Idle and the orphan decoration ignore these rows: ending a process Desk cannot identify beyond a command line is an explicit, per-row act.
- The enumeration costs one snapshot and one cheap native call per process; command lines are cached by `(pid, creation time)`. It runs on explicit reads and on the slow poll while the view is visible, never on the activation path; the loss evidence of section 6 uses it once, lazily, only when it is needed.

### 8. Components

| New or changed | Content |
| --- | --- |
| `src/host/catalog-backup.ts` (new) | Location and key, the owner-only guard and its cached verdicts, the generation rule, the writer with its rate limit, retention, peak, broker-record copies and the sweep, the reader that picks the restore candidate, the broker-record restore, `isReset` and the content summary. |
| `src/host/catalog-loss.ts` (new) | The evidence aggregator, the notice kinds and their texts, the cross-window marker. |
| `src/host/unmanaged-brokers.ts` (new) | Command-line splitting, broker recognition, the scanner, the pre-kill verification. |
| `src/host/profile-catalog.ts` | The `recover` / `isReset` / `onRecovered` / `prepareRecovery` options, the last-known document, `recoverIfNeeded`, `openedWithoutDocument`, the missing-file heal and the equal-revision adoption in `refresh`. No behaviour change without them. |
| `src/host/win32-native.ts` | `processTable`, `processCommandLine`. |
| `src/host/broker-processes.ts`, `src/host/session-kill.ts`, `src/runtime/local-kill.ts`, `src/views/session-processes.ts`, `src/views/process-rows.ts`, `src/wiring/process-wiring.ts` | `source: "unmanaged"`, its rows, tooltip and Stop refusal; the Kill target, its `none` reconciliation and the pre-kill verification. |
| `src/extension.ts`, `src/wiring/editor-panels.ts` | Compose: pass the hooks to the store, start the writer and the sweep, feed the evidence aggregator. |

## Alternatives

- **A second copy inside `globalStorage` (a `.bak` or a journal).** Does not survive the incident: the whole folder went.
- **VS Code `globalState` / `workspaceState` as the copy.** Survived this time, but it is VS Code's store, has no history, is rewritten whole by every writer, is per-workspace for `workspaceState`, and is storage VS Code owns and may prune (the incident's per-window state was pruned by the new session). One more thing VS Code owns.
- **`~/.omp/desk/`.** See section 1: OMP's folder.
- **A per-user folder under `%APPDATA%` or the Documents folder.** `%APPDATA%` roams; Documents is the user's, indexed, synced and backed up to places where a token must not go.
- **DPAPI-protected records.** See section 3.
- **Confirm before restoring.** See section 5. A command *Restore Sessions from Backup…* for the non-empty case (pick a copy, merge missing rows) is a possible later addition; it needs a merge rule that does not resurrect rows the user removed (the import ledger exists for that), which is its own design. The notice of section 6 and the manual steps in the guide are what this change offers for that case.
- **Compare revisions across catalog incarnations.** Rejected after review: a revision restarts after a wipe and after an operator's replacement; ordering copies by it would never back up a repaired catalog and would prune it first. Hence the generation.
- **Skip empty copies when choosing the restore candidate.** Rejected after review: a user who deliberately emptied the catalog commits an empty document at the highest revision of its generation, and restoring an older copy with rows would resurrect what they removed. The post-wipe empty shell is excluded by the generation rule instead.
- **Rebuild from OMP's JSONL when no backup exists.** Rejected as a non-goal above; it would mint new tab ids and could not re-attach restored editors.
- **A `vscode:uninstall` hook that checks for a live version folder.** VS Code runs the hook from the folder of the version it is deleting; it cannot tell the mistaken uninstall from a real one, and a hook that did anything would run in the incident too.
- **Refuse to start when evidence exists and there is no backup.** Blocks the user for nothing: the evidence cannot rebuild the rows.
- **Signalling an unmanaged broker by pid with no identity check.** Rejected: [ADR-0029](../decisions/0029-report-uncontained-pty-tree-stop-as-unknown.md) and [ADR-0060](../decisions/0060-merge-background-processes-into-sessions-and-kill-all-through-authenticated-routes.md) allow Kill only after the creation time proves the process.

## Risks and Open Questions

- **The backup folder itself may be deleted or cleaned** (a disk cleaner, the user). Then the next incident is as bad as before; the notice of section 6 is the floor. The writer re-creates it silently on the next change; a missing folder with a catalog present is not an incident.
- **A stale backup restores old rows.** A catalog lost for a day is restored as of the last change within 30 s of the loss; a copy made long before the loss (a machine that was off for months) restores old rows. The notice states the copy's age.
- **A backup of a damaged catalog.** Only a document the same parser accepts is copied, and the peak and daily copies reach back; a semantically bad catalog (a bug) is copied like a good one. The history is the mitigation.
- **Two stores, one key.** Two VS Code installs sharing one `globalStorage` path (the same user-data directory) share a copy and the lock-free scheme; this is the same sharing as the catalog itself.
- **Disk volume.** At most about 24 catalog copies and the live brokers' records; with a 600 KB catalog, about 15 MB at the very most, typically a few hundred KB per copy.
- **The native `NtQueryInformationProcess` class 60.** An undocumented information class that has existed since Windows 8.1 and is widely used; a failure is "unknown" for that process and never a verdict. Verified in a test against a real child process, including a command line longer than the first buffer.
- **Unmanaged detection depends on the command line the client builds today.** A future client that changes the argument names must update the recogniser; a test pins it to `buildBrokerArguments`.
- **A restore that races a user who just deleted the folder to start over.** Covered by the documented reset (delete the recovery folder too).
- **A schema bump disables the restore of older copies.** The restore reads copies with the same parser as the catalog, which refuses a version other than the one this build writes. A later build that raises `CATALOG_VERSION` must keep a reader for the previous version or accept that copies made by older builds are not restorable; this change does not decide that, and the first such bump must.
- **A restored `running` row whose broker is alive but whose record was not backed up** (the broker started within a minute of the loss, or its copy could not be made) is read by the reconciler as free: an explicit Resume of it would start a second OMP on a session file the original process still writes. The automatic startup pass is protected (it launches nothing without accepted absence evidence); the explicit click is not, and holding such a row back belongs to the session index, which another change owns. Mitigation in this change: the unmanaged row names the session file, and the restore notice says how many processes are running without a record and points to the Sessions view. The risk is the one the incident report lists as risk 1, narrowed to the brokers the backup missed.
- **Cross-window notice dedupe depends on the recovery folder.** When the folder cannot be used the marker cannot be written, and each window shows its own notice; that is noise in the failing case, not a loss.

## Rollout and Verification

Implementation order: (1) `profile-catalog.ts` hook with tests on temp directories (restore under contention from two stores, the second store adopting the restored document, reset shell, vanished file, equal revision with different content, a start with a present catalog commits no revision, no hook = unchanged); (2) `catalog-backup.ts` with tests (location key, generation rule including a repaired catalog and a regressed empty shell, rate limit with a fake clock, retention including the peak, broker-record copy, daily refresh and removal rules, restore validation, the `pty/` verdict gate, a refused ACL guard, the sweep); (3) `catalog-loss.ts`; (4) native reads with a real-process test; (5) unmanaged rows end to end (parser pinned to `buildBrokerArguments`, reader merge, Stop refusal, Kill target); (6) wiring and the evidence hook; (7) documentation, changelog, VSIX, isolated proof.

Verification: the focused test files above and `npm run typecheck`; an isolated VS Code run with the throwaway profile (storage deleted while the window is closed, window started: the catalog is restored, Info line present, rows visible) is recorded when it is run. Installed-window acceptance in the main profile stays a separate fact, stated as such.

## Related Decisions

- [ADR-0081](../decisions/0081-keep-a-private-backup-of-the-catalog-and-broker-records-outside-vs-codes-storage-and-restore-it-over-a-missing-catalog.md): the decision this design proposes.
- [ADR-0034](../decisions/0034-store-sessions-in-one-profile-catalog.md) (the catalog and its refusal rule; amended), [ADR-0006](../decisions/0006-host-generated-key-peer-verified-pipe.md), [ADR-0012](../decisions/0012-run-child-process-entries-from-staged-copies.md), [ADR-0029](../decisions/0029-report-uncontained-pty-tree-stop-as-unknown.md), [ADR-0039](../decisions/0039-refuse-only-on-a-verified-live-writer-the-extension-owns.md), [ADR-0060](../decisions/0060-merge-background-processes-into-sessions-and-kill-all-through-authenticated-routes.md) (amended), [ADR-0076](../decisions/0076-call-win32-in-process-through-a-staged-koffi-module-instead-of-starting-powershell.md).

## Architecture Review

- Reviewer: independent reviewer agent (read-only; verified the claims against the code), 2026-10-21.
- Outcome: accepted with required changes. All 20 findings were taken into this revision: generations instead of revision-as-clock (1, 2, 8), degraded catalog with rows announced and the limit stated (3), `pty/` verdict before restoring tokens (4), record copies refreshed while the broker lives (5), verification before the lock (6), adoption of the restored document by re-read (7), `reconcile: none` for unmanaged Kill (9), "Sessions view" naming (10), unusable backup reported (11), second-writer Resume as a residual risk (12), orphaned recovery folders swept (13), amendments to ADR-0034 and ADR-0060 (14), the `false` no-change transaction (15), unknown reads retried and the 15 s grace (16), the per-window 24-file bound (17), record destination by slot (18), the schema-version gate (19), cross-window notice deduplication (20).
