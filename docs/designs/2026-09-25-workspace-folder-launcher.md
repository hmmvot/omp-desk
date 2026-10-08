---
status: implemented
date: 2026-09-25
---

# User-managed workspace folders and on-demand session resume

## Problem

The OMP sidebar currently mixes every indexed row (including closed editors) with a continuously scanned, workspace-independent History tree. Users instead need folders they add themselves, with only open OMP editor tabs beneath each folder. History should appear only when a user invokes Resume for one folder.

## Goals and Non-goals

- Add and remove absolute local folders explicitly, preserve their order and collapsed state for this VS Code workspace, and choose a folder when starting a new session. Removing a folder removes only sidebar metadata; it never closes editors, stops a host, forgets a session or deletes history.
- Show exactly the indexed sessions with open WebviewPanels whose recorded working directory equals a registered folder. Clicking a row focuses its existing editor. Keep empty folders visible and collapse children with the native VS Code tree affordance.
- Resume opens an on-demand picker of all discoverable, readable OMP conversation files whose header records the selected folder. Include indexed closed files and already-open files once; selecting an open session focuses its tab, selecting a closed indexed session uses its existing row, and selecting a newly discovered file imports only that file through the existing exact-file claim/resume path.
- Do not show a persistent History section or enumerate native history on sidebar visibility/refresh. Do not infer which tabs are open from the durable index. Do not change OMP's session-file layout, claim protocol, user permissions, native terminal switch, or VS Code-owned editor persistence.
- Completeness covers supported OMP profile roots, current environment overrides and exact session directories the extension already knows, not unknown custom `--session-dir` locations anywhere on disk. Incomplete reads must be reported rather than silently described as all sessions.

## Current State

`SessionTreeProvider` renders Sessions and History groups; index entries include closed tabs, while `facts(tabId).open` reports an actual panel. `newSession` unconditionally uses the first VS Code workspace folder. A bounded global scanner reads at most 32 roots, 400 buckets per root, 4,000 candidates and 400 files; filtering its snapshot by cwd cannot implement an all-sessions picker. `openHistorySession` already imports an exact file under extension-scoped claims.

## Proposed Design

Keep separate authorities ([ADR-0020](../decisions/0020-separate-folder-navigation-from-session-ownership.md)): a versioned folder registry in `context.workspaceState` stores ordered absolute native paths, stable IDs and presentation-only collapse state; VS Code owns actual open editors; `SessionIndex` owns identities and claims; a read-only on-demand history query owns discovered file metadata. The registry is per VS Code workspace context, not a global account-wide synced list. The folder dialog accepts local directories only, validates absolute paths, compares existing filesystem identities through the claim path normalizer and preserves a usable root path. An equivalent Add selects the existing folder; indexed rows and VS Code workspace roots never silently add one. On first empty use, Add may offer the current VS Code workspace root as a picker suggestion, but registering it remains explicit.

The index's existing `normalizeWorkspaceDirectory` strips a drive or POSIX root into a drive-relative or empty value. Repair normalization at the index producer so Add(`C:\` or `/`) → createDraft/trackSession → stored cwd → native launch → folder matching remains a valid absolute root. Persisted `C:` or empty cwd values from older builds cannot safely be interpreted as roots: do not resolve them against extension-host cwd or silently migrate them. Refuse a launch from such an ambiguous row with a visible explanation; a readable exact session-file header may be used only after it independently establishes the actual absolute cwd.

The tree provider receives `folders()`, `entries()`, `activeTabId()` and `facts(tabId)`. Its root nodes are registered folders and its children are only entries with `facts.open === true` and exact canonical cwd equality. Keep their tab IDs and truthful draft/failed/blocked state. A row click rechecks that its **actual panel still exists** and reveals it without calling native restore; if it just closed, report that it is no longer open and direct the user to Resume. Explicit closed-session Resume alone may restart a host. No History group, closed indexed rows or automatic folder insertion remains. Folder collapse changes presentation only; tree refresh and active-editor tracking must not expand a deliberately collapsed folder.

Resume resolves the chosen folder ID again after every asynchronous scan/picker. Resolve roots independently for the ordinary default profile, every named profile, the active `OMP_PROFILE`/`PI_CODING_AGENT_DIR` override, applicable XDG storage and indexed explicit paths; dedupe exact roots. When resuming a file identified under the default profile, pass OMP's verified `--profile default` sentinel explicitly so an inherited named profile cannot claim the wrong profile; preserve its exact `--resume <file>` path. New drafts follow the same explicit default-profile contract when their index scope records a null profile. The query enumerates all supported direct and one-bucket `*.jsonl` candidates without the global History caps, excludes backups, subagent artifact directories and symlinks, reads bounded headers, filters exact canonical header cwd, deduplicates canonical exact files and sorts matches newest-first. It runs only on Resume; unrelated history is not retained. Distinguish missing paths from stat/readdir/open/read errors at root, profile, bucket and candidate level; an inaccessible item or cancelled scan makes the picker visibly incomplete rather than empty or complete.

The picker merges matching indexed materialized rows, including closed files, by canonical exact file path; indexed identity/provenance wins and already-open rows appear once with an Open label. A missing indexed file remains visibly unavailable. Fileless drafts are not historical choices. At selection, re-read the chosen exact file's header and compare its current absolute cwd with the still-registered selected folder; verify the indexed row (including a row returned by `trackSession` after a competing import) still names that same file and folder before `openTab`. If the file or folder changed, refuse or refresh rather than launching an unrelated cwd. This is a selection-time check, not an atomic filesystem snapshot or proof against a foreign OMP writer. New discoveries alone pass to `trackSession({sessionFile: exactPath, cwd: verifiedCwd, scope})`; indexed choices use their existing tab ID and ownership.

Folder arguments carry stable registry IDs, not arbitrary caller-supplied paths. An absent argument invokes a choice among registered folders (or an explicit Add flow when none are registered); a malformed/stale supplied ID reports and stops instead of falling back to another folder. Removing a folder hides its subtree but does not touch open panels, hosts, indexed sessions or files. `onDidExpandElement`/`onDidCollapseElement` update registry presentation state; the saved collapse value is authoritative when building a folder node, with stable `TreeItem.id` assisting VS Code's native state restoration.

Command cutover:

| Existing or new command | Result |
| --- | --- |
| `omp.addWorkspaceFolder`, `omp.removeWorkspaceFolder` | Explicit metadata-only Add/Remove; folder IDs are revalidated. |
| `omp.newSession` | Folder-row action or registered-folder picker; creates a draft with that folder's exact cwd. No implicit first-workspace launch. |
| `omp.resumeWorkspaceFolder` | Folder-row action or picker, followed by folder-scoped history QuickPick and exact-file resume. |
| `omp.focusSession` | Reveals only an actually open panel; stale tree click does not resume. No-argument palette lists only currently open panels. |
| `omp.refreshSessions`, `omp.openNativeTerminal` | Refreshes folder/editor projection without a history scan; terminal behavior unchanged. |
| `omp.openSession`, `omp.openHistorySession` | Retired together with the global indexed picker and persistent History tree; no hidden global history-opening entry point survives. |
| `omp.forgetSession`, `omp.deleteSession` | Retain their existing SessionIndex ownership/provenance checks; neither is a folder-removal alias. |

Manifest title, context-menu and welcome affordances must match these commands without presenting hidden history as an always-visible tree.

## Alternatives

A durable open-tab list would conflict with VS Code's serializer and resurrect deliberately closed editors. Filtering the bounded global History snapshot silently omits older sessions. Deriving history solely from a hashed cwd bucket misses custom directories and aliases. Persisting all discovered history in the folder registry duplicates the session index and requires invalidation that OMP does not provide.

## Risks and Open Questions

- Exhaustive on-demand scans can take time; show progress, allow cancellation and report partial scans. A remote or inaccessible bucket must not imply an empty folder. Concurrent filesystem mutations prevent an atomic all-files snapshot.
- Unknown external custom session roots are unobservable without another user-provided root or installed OMP discovery authority; never claim disk-wide coverage.
- Canonical folder comparison and SessionIndex persistence must preserve drive/POSIX roots and reject relative/drive-relative paths. Existing malformed root rows are ambiguous: never turn `C:` or an empty value into `C:\` or the extension process cwd without independent exact-file evidence.
- The registry is intentionally per VS Code workspace context. If users later require a shared folder list across unrelated VS Code windows, that is a separate storage/synchronization decision.

## Rollout and Verification

First repair root-preserving index cwd and add folder metadata plus scoped history discovery with behavioral tests for duplicate/root paths, open-only projection, profile-root coverage, unreadable bucket/candidate reporting, selection-time file/folder change, tracked-file merge and stale folder IDs. Then cut over launcher, commands and manifest together; remove the old History tree, automatic scan and obsolete global Open/History entry points. Update product, README and implemented architecture. In an isolated installed VS Code window exercise Add(root) → New → indexed/native cwd → Resume, two folders, close/reopen, collapse after refresh, indexed and discovered exact-file Resume, and metadata-only removal while a host is live. Typecheck, targeted tests, full suite and package smoke after integration.

**Observed implementation (2026-09-25).** The installed VSIX in a private VS Code 1.139.1 profile explicitly added two local folders, started a native OMP conversation with the selected cwd, kept only its open editor under that folder, focused the same tab from its row, preserved collapse across refresh, and hid the row immediately on editor close. Removing and re-adding the folder changed only navigation while its native host and editor continued. After a window reload, the editor restored; folder Resume then discovered its closed indexed JSONL on demand, reopened its full-control transcript, and returned `RESUME-GUI-OK` to a new GUI prompt. Diagnostics reported one host and one guest, and the output log recorded the link delivery followed by connecting, waiting and live. The first live Resume attempt had exposed a lost early Webview readiness message; the per-document delivery state now accepts a later guest status as proof the document is listening, while explicitly mismatched protocols stay refused and a rotated room link remains deliverable. Typecheck, the serial suite (732 passed, one expected Windows/POSIX skip), build and VSIX packaging passed against the repaired baseline. Root paths, malformed headers, partial scans and folder equality have behavioral test coverage; a native Browse dialog, a non-indexed external file's **live UI** import, cancellation through the UI, and a literal filesystem-root **live launch** were not exercised in this run. Screenshots from this run are not kept in the repository.

## Related Decisions

[ADR-0018](../decisions/0018-resume-imported-history-under-extension-claims.md), [ADR-0019](../decisions/0019-vscode-owns-omp-editor-persistence.md), [ADR-0020](../decisions/0020-separate-folder-navigation-from-session-ownership.md).

## Architecture Review

- Reviewer: independent architects (a review and a corrective re-review)
- Outcome: accepted after corrective re-review
- Notes: The first review found six material gaps. The revised contracts address persisted root cwd, default-profile coverage and launch scope, scan errors, focus-only rows, selection-time file/folder checks and legacy global commands; the independent corrective re-review approved all six.
