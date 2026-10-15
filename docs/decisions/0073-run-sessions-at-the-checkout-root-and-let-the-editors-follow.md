---
status: accepted
date: 2026-10-14
---

# ADR-0073: Run sessions at the checkout root and let the Settings, Models and Agents editors follow

## Context and Problem Statement

Where a session runs was decided by `ompDesk.useAgentRootFolder`: from an opened folder with no agent file it climbed to the nearest ancestor that has one, never above the nearest `.git` ([the 2026-10-10 amendment of the window-folders design](../designs/2026-10-07-window-folders-and-other-window-state.md), scope `application` by [ADR-0056](0056-publish-window-state-in-a-leased-registry-and-switch-windows-by-request.md)). Which `.omp` the Settings, Models and Agents editors write was decided by a second setting, `ompDesk.ompSettings.useNearestAncestorOmpFolder` (default off, [ADR-0071](0071-edit-omps-settings-from-its-own-registry-in-a-staged-worker-and-write-one-layer-at-a-time.md) amendment, applied to the Models and Agents editors by [ADR-0072](0072-resolve-roles-and-agents-in-the-worker-with-omps-own-functions-and-write-agent-overrides-to-either-layer.md)), with an ancestor notice. A Unity project opened as `repo/omp-vscode` needed the second setting on to make the editors agree with the sessions the first one had already moved to `repo`. The agent-root rule also knew Git only and depended on which files exist, so a Plastic SCM, Mercurial, Subversion or Jujutsu checkout, and a subfolder with its own `AGENTS.md`, behaved differently from the same layout under Git.

The decision: what is the one rule for where sessions run, how do the editors stay on the same folder, what is a checkout root, and what happens to sessions, windows and settings already in place?

## Considered Options

- **Keep both settings and tune each.** Two names for one question; the Unity user keeps a switch to find. Rejected.
- **Keep the agent-files nuance** (climb only when the folder has none). The answer depends on directory contents and on Git. Rejected by the user.
- **Detect the checkout with the VCS programs or VS Code's Git extension.** Exact for unusual layouts, but processes per folder, missing binaries, servers for Plastic and Perforce, and Git only for the extension. Rejected.
- **Detect by root markers with a stat walk; one resolver for sessions and editors; one resource-scoped setting** (chosen).
- **Show the opened folder as the Sessions row and the root in its description.** A New Session on the row would start in a folder other than the one it names. Rejected; the root is the row and its tooltip names the opened folder.

## Decision Outcome

**Rule.** `ompDesk.runSessionsAtRepositoryRoot` (boolean, default `true`, scope `resource`). On: sessions run at the root of the version-control checkout the opened folder lies in, else in the opened folder. Off: in the opened folder. No agent-file test.

**Resolver.** `sessionFolderFor` (`src/host/session-folder.ts`) is the only function that answers; `SessionFolderResolver` remembers its answers for the synchronous Sessions code and is re-probed at activation, on workspace-folder, window-focus, registry and configuration changes and on the registry heartbeat. The editors bind the project folder through `editorProjectFolder` (`src/host/session-folder-setting.ts`), which reads the setting for the folder and calls the same function; it is used for the first opened workspace folder when OMP Settings opens with no active session. An editor opened for a session binds that session's own folder, so an editor and the session it follows read the same `<cwd>/.omp`. The old resolver (`src/views/agent-root.ts`), the `useNearestAncestorOmpFolder` option of `src/omp/config-ancestor.ts`, the ancestor notice and the buttons that opened the setting are removed.

**Checkout root.** The nearest directory at or above the opened folder (the folder itself included) that holds a marker of any system, by `stat` only:

| System | Marker | Strength |
| ------ | ------ | -------- |
| Git | `.git` (directory, or file for a worktree or submodule: the innermost wins) | strong |
| Mercurial | `.hg` | strong |
| Sapling | `.sl` | strong |
| Jujutsu | `.jj` | strong |
| Subversion | `.svn` (one per working copy since 1.7) | strong |
| Plastic SCM / Unity Version Control | `.plastic` | strong |
| Bazaar / Breezy | `.bzr` | strong |
| Fossil | `.fslckout`, `_FOSSIL_` (files) | strong |
| Pijul | `.pijul` | strong |
| Darcs | `_darcs` | strong |
| CVS | `CVS/Root`, topmost of a consecutive run | weak |
| Perforce | `.p4config`, and the plain file name in this process's `P4CONFIG` | weak |

Weak markers are not taken in a home folder or a drive root; strong markers are (a dotfiles repository). The walk never climbs above the home folder of a folder inside it, ends at the filesystem root, costs at most 15 `stat` calls a directory (the strong markers first, the weak ones only when none is there), shares a memo per pass, and never throws. Perforce without a P4CONFIG file (a non-default name set with `p4 set` in the Windows registry) and a pre-1.7 Subversion working copy are not recognised: the folder itself is used.

**Session index identity.** A session row records the cwd it launched in; nothing is rewritten. Existing sessions keep their cwd and stay filed under the opened folder's shown root through `openedPaths` and `folderOwnsCwd` (unchanged from the agent-root rule). The rule applies to new launches and to everything that reads the shown folder's path. Folder Resume scans the shown folder's own cwd only, as under the agent-root rule, so a history file recorded in the opened subfolder and not yet indexed is not offered; a stopped session recorded at a folder that is no longer shown is filed under no shown folder.

**Folder identity.** Four cases change the shown path: a folder with agent files inside a checkout climbs; a folder whose old agent root was an intermediate directory climbs on to the root; a non-Git checkout that stayed itself climbs, and one nested under Git that the old rule climbed past now stops at its own root. The row id changes with the path, an unpinned row's collapsed state resets once, and a stopped session recorded at the old shown path is filed under no shown folder until that folder is shown again; a pin of the subfolder alone keeps that subfolder's recorded cwds.

**Unity routing ([ADR-0057](0057-start-a-session-in-the-window-that-suits-its-folder.md)).** Unchanged. `unityCandidatesOf` already adds the opened folders a shown folder stands for to the projects found below it, so `repo` with `openedPaths = [repo/omp-vscode]` routes to the window that has `repo/omp-vscode` open.

**Windows.** The setting is `resource`-scoped, so a window publishes `staysInFolder` (the opened folders whose setting is off) in its registry snapshot and the other windows show those folders as themselves. This replaces [ADR-0056](0056-publish-window-state-in-a-leased-registry-and-switch-windows-by-request.md)'s reasoning (repeated in [ADR-0045](0045-derive-window-folders-per-window-and-pin-with-identity-ids.md) item 3) that the agent-root setting is application-scoped and so every window agrees. A record without the field reads as climbing.

**Editors and the ancestor refusal.** OMP Settings opened from the palette with no active session binds `editorProjectFolder` of the first opened workspace folder (the session folder); Models and Agents opened from the palette start in the global scope. An editor opened for a session binds that session's own cwd as it is, and the scope control's Sessions rows and a folder chosen with the dialog are used as they are, so an editor never moves the folder a session reads its `<cwd>/.omp` from. The first project file in a folder is still refused when it would hide an ancestor's `AGENTS.md`, `RULES.md` or `SYSTEM.md` (`ancestorContextDir`), because OMP walks to the nearest `.git` only (outside home, to the drive root): at a Git checkout root the check cannot fire, but for a session folder that is not its root (recorded before the upgrade, or from a pinned subfolder), a Mercurial, Plastic, Subversion or other root, a folder in no checkout and a folder with the setting off it can. The home-folder refusal stays. The message no longer names a setting.

**Sessions.** The shown folder is the root; its tooltip says `Sessions run at the repository root <root>, not in the opened "<folder>".` when they differ.

**Migration** (`src/wiring/session-folder-settings.ts`, activation, after the namespace migration, in the style of [ADR-0068](0068-rename-contributed-ids-to-ompdesk-and-migrate-settings-at-activation.md)): an explicit `ompDesk.useAgentRootFolder: false` becomes `ompDesk.runSessionsAtRepositoryRoot: false` and is removed, an explicit `true` is removed, and `ompDesk.ompSettings.useNearestAncestorOmpFolder` is removed in user and workspace settings, one log line per moved key, no write when no old key is present, an explicit new value never overwritten. The three old names (`omp.useAgentRootFolder`, `ompDesk.useAgentRootFolder`, `ompDesk.ompSettings.useNearestAncestorOmpFolder`) stay contributed as hidden, deprecated settings until 1.0.0 and are deleted with [ADR-0068](0068-rename-contributed-ids-to-ompdesk-and-migrate-settings-at-activation.md)'s alias table. The new key is read at once and the move runs asynchronously, so a New Session in the first moments after an update can still see the default.

### Consequences

- Positive: one rule and one resolver for where sessions start and where an editor opens, and an editor opened for a session binds that session's own folder; every common VCS works, Plastic and Mercurial as Git does; no setting to turn on for Unity; the ancestor notice and two settings leave the product; the rule is explainable in one sentence and testable over temp directories.
- Negative: a subfolder with its own agent files inside a checkout runs at the root unless the setting is turned off for it (a monorepo opts out per folder); a subfolder's own `.omp` (settings, skills, MCP, extensions) stops applying to new sessions, because OMP reads those from `<cwd>/.omp` only; a stray `.git` or a `.git` in the home folder is chosen as the checkout it is (and OMP and Desk's editors never treat the home folder as a project); Perforce set only in the registry is not seen; a folder's row id and an unpinned row's collapsed state change once on upgrade; the registry carries one more optional field; windows on different builds can show one folder differently until each is reloaded; the ancestor-context refusal stays for the cases above, so some saves are still refused.

## Related Documents

[Run sessions at the repository root, and let the OMP editors follow](../designs/2026-10-14-run-sessions-at-the-repository-root.md); supersedes in part the 2026-10-10 amendment of the [window-folders design](../designs/2026-10-07-window-folders-and-other-window-state.md) (the agent-root substitution) and [ADR-0056](0056-publish-window-state-in-a-leased-registry-and-switch-windows-by-request.md) (its application-scope decision, repeated in [ADR-0045](0045-derive-window-folders-per-window-and-pin-with-identity-ids.md) item 3), [ADR-0071](0071-edit-omps-settings-from-its-own-registry-in-a-staged-worker-and-write-one-layer-at-a-time.md) (the ancestor-folder amendment) and [ADR-0072](0072-resolve-roles-and-agents-in-the-worker-with-omps-own-functions-and-write-agent-overrides-to-either-layer.md) (the editors' project-folder binding); extends ADR-0056's registry record with `staysInFolder`; [ADR-0057](0057-start-a-session-in-the-window-that-suits-its-folder.md) (unchanged, pinned by tests); [ADR-0068](0068-rename-contributed-ids-to-ompdesk-and-migrate-settings-at-activation.md) (migration style); [window folders design](../designs/2026-10-07-window-folders-and-other-window-state.md).

## Architecture Review

- Reviewer: architect (independent, read-only; one review covers this design and ADR-0073, plus a confirmation pass)
- Outcome: accepted after changes. The review found three material problems, all fixed: (M1) the editors re-resolved a folder that was already a session's folder, so with the setting on they could edit `<root>/.omp` while a subfolder session read its own `<cwd>/.omp`; they now bind a session's own cwd, the Sessions rows and a dialog-chosen folder as they are, and resolve only the first opened workspace folder when OMP Settings opens with no session; (M2) a subfolder's own `.omp` stops applying to new sessions, which the documents did not say: disclosed in the behaviour changes, the ADR and the CHANGELOG, with the mitigation (a notice) left as an open decision; (M3) the Resume claim was false: folder Resume scans the shown folder's own cwd only, now stated as an existing limit. Minor findings (identity cases, Perforce and cost wording, ADR-0056 as the source of the application-scope decision, refusal message, risks for home, the Unity picker, window agreement, migration timing, the scope of "one resolver", hidden-key removal at 1.0.0, stale comments) are folded in. The confirmation pass found five wording issues, fixed.
- Notes: the marker table, the nearest-wins and home/drive-root rules, `staysInFolder`, ADR-0057 routing, keeping the ancestor refusal and the migration were confirmed sound. Optional markers the reviewer named and this design leaves out: TFVC (`$tf`) and ClearCase (`view.dat`).
