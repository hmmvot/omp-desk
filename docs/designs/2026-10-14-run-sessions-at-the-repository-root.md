---
status: implemented
date: 2026-10-14
---

# Run sessions at the repository root, and let the OMP editors follow

## Problem

Two settings answered one question from two sides, and a third question hid behind them.

- `ompDesk.useAgentRootFolder` (default on) decided where a session launches: from an opened folder with no agent file (`AGENTS.md`, `CLAUDE.md`, `.agents/`, `.omp/`, `.claude/`, `.pi/`) it climbed to the nearest ancestor that has one, never above the nearest `.git`. It knew Git only, and its answer depended on which files happened to exist.
- `ompDesk.ompSettings.useNearestAncestorOmpFolder` (default off) decided which `.omp` the Settings, Models and Agents editors write project settings to. A Unity user has to turn it on, because VS Code opens `repo/Game` while sessions run at `repo`; with it off the Project view shows a notice with a button to the setting.
- The two disagreed by construction: the editors climbed to an ancestor `.omp`, sessions to the nearest ancestor with any agent file, so a folder could launch sessions in one directory and write its project settings to another.

A user whose team uses Plastic SCM (Unity Version Control), Mercurial, Subversion or Jujutsu also got no climb at all, because the walk stopped at `.git`.

## Goals and Non-goals

Goals:

- One rule: **sessions run at the root of the version-control checkout the opened folder lies in; outside any checkout, or with the setting off, in the opened folder itself.**
- One resolver for where sessions start and for the folder OMP Settings opens on when no session is active; an editor opened for a session binds that session's own folder, so an editor and the session it follows read the same `<cwd>/.omp`.
- Twelve version-control systems recognised by a file-system stat, with no VCS program run.
- Sessions says where sessions run, and why, when that is not the opened folder.
- Old values migrated once; the old settings removed from the product (hidden and deprecated until 1.0.0).

Non-goals:

- Changing the folder of a session that already exists: its recorded cwd stays.
- Changing OMP's own context discovery (it knows `.git` only; see "Editors and the ancestor refusal").
- Detecting a checkout by running `git rev-parse`, `hg root`, `p4 info` or any other program.
- Reading a Perforce client's root from `p4 set` or the Windows registry.

## Current State

- `src/views/agent-root.ts` (`AgentRootResolver`) probes up from an opened folder and the substituted folder carries the opened roots as `openedPaths` ([the 2026-10-10 amendment of the window-folders design](2026-10-07-window-folders-and-other-window-state.md#agent-root-substitution); its application scope is the decision of [ADR-0056](../decisions/0056-publish-window-state-in-a-leased-registry-and-switch-windows-by-request.md), repeated in [ADR-0045](../decisions/0045-derive-window-folders-per-window-and-pin-with-identity-ids.md) item 3).
- `src/omp/config-ancestor.ts` finds an ancestor `.omp` for the editors when `useNearestAncestorOmpFolder` is on, refuses a first project file that would hide an ancestor's `AGENTS.md`, `RULES.md` or `SYSTEM.md`, and shows a notice when an ancestor `.omp` looks like the project ([ADR-0071](../decisions/0071-edit-omps-settings-from-its-own-registry-in-a-staged-worker-and-write-one-layer-at-a-time.md), [ADR-0072](../decisions/0072-resolve-roles-and-agents-in-the-worker-with-omps-own-functions-and-write-agent-overrides-to-either-layer.md)).
- Unity window routing ([ADR-0057](../decisions/0057-start-a-session-in-the-window-that-suits-its-folder.md)) sends a session to a window that has the Unity project folder open; it already copes with a session folder that is an ancestor of the open folder through `openedPaths`.

## Proposed Design

### The rule

`runSessionsAtRepositoryRoot` (boolean, default `true`, scope `resource`):

| Setting | Opened folder in a checkout | Opened folder in no checkout |
| ------- | --------------------------- | ---------------------------- |
| on | the checkout root | the opened folder |
| off | the opened folder | the opened folder |

No agent-file test remains: a subfolder with its own `AGENTS.md` inside a checkout also runs sessions at the root. A monorepo that wants sessions per package turns the setting off for that workspace or folder (the scope is `resource`, so a multi-root workspace decides per folder).

`sessionFolderFor(folder, enabled)` (`src/host/session-folder.ts`) is the one function; `SessionFolderResolver` remembers its answers for the synchronous Sessions code. `editorProjectFolder(folder)` (`src/host/session-folder-setting.ts`) reads the setting for that folder and calls `sessionFolderFor`; the editors use it for the first opened workspace folder when no session is active (see Editors).

### Checkout root search (`src/host/checkout-root.ts`)

Walk up from the folder; the first directory (the folder itself included) that carries a marker is the root, whatever its system. The nearest wins, so a submodule or a worktree is its own root, and a Mercurial repository inside a Git one is the Mercurial root.

| System | Marker at the root | Kind | Decision |
| ------ | ------------------ | ---- | -------- |
| Git | `.git` | directory, or a file (worktree, submodule) | Strong. The file form makes the worktree or submodule root win over the superproject. |
| Mercurial | `.hg` | directory | Strong. |
| Sapling | `.sl` | directory | Strong. A clone that keeps Mercurial's name has `.hg`. |
| Jujutsu | `.jj` | directory | Strong. A colocated repository also has `.git`; a secondary workspace has `.jj` only. |
| Subversion | `.svn` | directory | Strong. One per working copy since 1.7, so the nearest `.svn` is the root. Before 1.7 each directory had one, so a pre-1.7 folder is its own root: documented, not handled. |
| Plastic SCM / Unity Version Control | `.plastic` | directory | Strong. The workspace root; the case that matters for Unity. |
| Bazaar / Breezy | `.bzr` | directory | Strong. |
| Fossil | `.fslckout`, `_FOSSIL_` | file | Strong. `_FOSSIL_` is the Windows name. |
| Pijul | `.pijul` | directory | Strong. |
| Darcs | `_darcs` | directory | Strong. |
| CVS | `CVS/Root` | file | Weak. Every directory of a working copy has `CVS/`; the root is the topmost of a consecutive run, so a directory counts only when its parent has no `CVS/Root`. |
| Perforce | the file named by `P4CONFIG`, and `.p4config` | file | Weak. Perforce has no marker of its own; a P4CONFIG file at the workspace root is the convention. `.p4config` is always checked, and so is the plain file name in this process's `P4CONFIG` variable (a value with a path separator is ignored). A non-default name that `p4 set` keeps only in the Windows registry is not seen: such a workspace runs where it is opened (documented, not shelled out). The variable is read per extension host, so windows with different environments can resolve one folder differently until their environments agree. |

Search rules:

- **Weak markers are not taken in a home folder or a drive/filesystem root**, because a P4CONFIG file in a home folder configures every client and a stray `CVS` directory is common. A **strong** marker is taken anywhere, including the home folder: a dotfiles repository whose `.git` sits in the home folder is a checkout root and an opened `~/dotfiles-ish` subfolder runs there. That is the one case where the home folder is chosen, and only because it truly is a checkout.
- The walk never climbs above the home folder when the opened folder is inside it, and it ends at the filesystem root. A folder outside home climbs to the drive root at most.
- Cost: at most 15 `stat` calls per directory: the 11 strong markers together, then, when none is there, up to 4 weak ones (two CVS, up to two Perforce) together. A pass shares a memo, so folders under the same parents probe each directory once.
- A directory that cannot be read has no marker. Nothing throws.

### Re-resolution

Sessions remembers the answer per opened folder. The probe runs at activation, on workspace-folder changes, on window focus, on a configuration change of the setting, on the registry heartbeat, and when the registry changes. Reading the disk again on focus and heartbeat is what makes a repository created or deleted after activation (a `git init`, an `hg clone` into the folder) take effect without a reload, and what makes windows converge when one of them was started before the repository existed. `LauncherFolders.list()` stays synchronous and shows the folder itself until the answer arrives.

### Sessions display

A folder opened inside a checkout is shown as the checkout root (the existing `openedPaths` substitution), because that is where a New Session starts and where its sessions are filed. The row's tooltip says so: `Sessions run at the repository root <root>, not in the opened "<folder>".` The row label is the folder sessions run in; the opened folder is named in the tooltip. [INFERENCE: the request said the row label stays the folder; this reads it as the folder where sessions run, which is the existing agent-root presentation. Showing the opened folder as the label would make the row's New Session start in a folder other than the one it names.] Rows with no difference are unchanged.

### Session-index identity

A session row records the cwd the session was launched from, and the catalog files a session under the folder whose path equals that cwd (`folderOwnsCwd`). Nothing is rewritten:

- Existing sessions keep their recorded cwd. While `repo/Game` is opened and shown as `repo`, `folderOwnsCwd` files a session recorded in `repo/Game` under `repo` through the folder's `openedPaths`, so it neither disappears nor appears twice, exactly as under the agent-root rule. When no shown folder owns `repo/Game` any more (the folder was closed and is not pinned), a stopped session recorded there is filed under no shown folder and is not listed, as before; a running one keeps its folder visible.
- New launches, New Session and the folder pickers use the session folder. Folder Resume scans the history of the shown folder's own cwd only: a session file recorded in the opened subfolder that the index does not hold yet is not offered there. The agent-root rule had the same limit (see the 2026-10-07 amendment, "Existing sessions"); more folders now move up, so it reaches more history. Indexed sessions are listed through `openedPaths`. Scanning the opened folders too would also have to register a found file with its recorded folder (it registers with the shown folder's path today), which this change does not touch.
- Rows are never re-parented by a path rewrite; `sessionFile`, `sessionId` and the recorded cwd are untouched.

### Folder identity keys

Folder rows are keyed by identity ids ([ADR-0045](../decisions/0045-derive-window-folders-per-window-and-pin-with-identity-ids.md)): a pinned folder's id is stable across sessions, an unpinned one's derives from its path. The rule changes a folder's shown path in three cases (and in a fourth leaves it alone):

- A folder that has agent files and sits inside a checkout used to stay itself; now it climbs to the root.
- A folder whose old agent root was an intermediate directory (agent files between it and `.git`) now climbs on to the checkout root.
- A non-Git checkout (Plastic, Mercurial, ...) that used to stay itself, or that the old rule climbed past to a `.git` above, now stops at (or climbs to) its own root: nested under a Git repository its shown path moves down.
- Nothing changes for a folder in no checkout or with the setting off.

In each case the row id changes with the shown path. The collapsed state of an unpinned row is per window and is lost once, and a stopped session recorded at the old shown path is filed under no shown folder (exact-cwd filing) until that folder is shown again. A pinned folder keeps its pin: pins are paths in the registry, so a pin of the subfolder alone is enough for `folderOwnsCwd` to keep that subfolder's recorded cwds under the pinned row rather than under the ancestor.

### Unity window routing (ADR-0057)

VS Code opens `repo/Game`; sessions run at `repo`. The Unity extensions need a window that has the Unity project folder as workspace root, so ADR-0057 routes a session to a window that has the project open or opens one. `unityCandidatesOf` (`src/wiring/window-routing.ts`) collects the Unity projects a launch in a folder stands for: the projects in the folder or up to two levels below it, plus every opened folder the shown folder stands for (`openedPaths`) that is a Unity project. With the session folder `repo` and `openedPaths = [repo/Game]`, `repo/Game` is a candidate both ways, so the launch is routed to the window that has `repo/Game` open, as before. Routing code is unchanged by this design; it already received `openedPaths` from the agent-root substitution. A deeper layout (`repo/a/b/Game`) is found through `openedPaths` only while that folder is open, which is the case routing is about.

### Window registry

The setting is `resource`-scoped, so two windows may disagree about whether a shared folder climbs. [ADR-0056](../decisions/0056-publish-window-state-in-a-leased-registry-and-switch-windows-by-request.md) (and [ADR-0045](../decisions/0045-derive-window-folders-per-window-and-pin-with-identity-ids.md) item 3) made the agent-root setting application-scoped so that every window agrees; that reasoning no longer holds. `WindowSnapshot.staysInFolder` (optional, a list of opened folders whose setting is off) is published with the folders, and the consumer that lists another window's folders keeps those folders as themselves. A record from an earlier build has no such field and is read as climbing.

### Editors and the ancestor refusal

OMP Settings opened from the palette in a window with no active session binds `editorProjectFolder(workspaceFolder)`, the session folder of the first opened workspace folder, so `<root>/.omp` is the file it writes (Models and Agents opened from the palette start in the global scope). An editor opened for a session (`/settings` and `/models` in Chat) binds that session's own cwd as it is; the scope control offers the Sessions rows' paths and a folder the user chose with the dialog, also as they are: each of those is already a folder a session runs in or a folder asked for literally. That is what keeps the editors and the sessions together: an editor never moves a session's folder, so a session that runs in a subfolder (recorded before the upgrade, or started from a pinned subfolder row) still has its own `<cwd>/.omp` edited, which is the one OMP reads for it (OMP reads project settings, skills and MCP configuration from `<cwd>/.omp` only). An open editor keeps its binding when the setting changes, and a restored panel keeps its stored folder. `useNearestAncestorOmpFolder`, its option in `config-ancestor.ts`, the ancestor notice and the buttons that opened the setting are removed, and with them the editors' own re-resolution of every folder they were given.

The refusal to create a first project file that would hide an ancestor's context file is **kept** (`ancestorContextDir`). OMP loads `AGENTS.md`, `RULES.md` and `SYSTEM.md` by walking up to the nearest `.git` only ([ADR-0071](../decisions/0071-edit-omps-settings-from-its-own-registry-in-a-staged-worker-and-write-one-layer-at-a-time.md)). When the session folder is a Git checkout root there is no ancestor within OMP's walk and the refusal cannot fire. It still applies when:

- the session folder is not its checkout root: a session recorded in a subfolder before the upgrade, or started from a pinned subfolder row, because OMP takes context from the nearest non-empty `.omp` at or above the cwd and a new `<cwd>/.omp` would become the nearest;
- the root is a Mercurial, Plastic, Subversion or other non-Git root (OMP walks past it to some ancestor's `.git`, or to the home folder, and a new `<root>/.omp` would change what it loads);
- the folder is in no checkout (the folder itself, with OMP walking up to wherever it stops);
- the setting is off (a package folder whose repository root holds the context files);
- a folder chosen with "Choose another folder…" that is neither a Git checkout root nor the home folder (it is used as chosen).

Outside the home folder OMP's walk reaches the drive root, not only a `.git`. The refusal message no longer names the removed setting; it says OMP stops looking only at a Git repository root (or the home folder) and that this folder is neither, listing the cases above.

### Migration

At activation, after the `omp.*` → `ompDesk.*` migration and in the style of [ADR-0068](../decisions/0068-rename-contributed-ids-to-ompdesk-and-migrate-settings-at-activation.md) (`src/wiring/session-folder-settings.ts`):

| Old value | Action |
| --------- | ------ |
| `ompDesk.useAgentRootFolder: false` (user layer) | `ompDesk.runSessionsAtRepositoryRoot: false`, old key removed, one log line |
| `ompDesk.useAgentRootFolder: true` | removed (default), one log line |
| `ompDesk.ompSettings.useNearestAncestorOmpFolder` (user or workspace) | removed, one log line; the editors follow sessions now |

Nothing is written when none of the old keys is present. An existing explicit `runSessionsAtRepositoryRoot` is never overwritten. The old keys stay contributed as hidden (`included: false`) deprecated settings until 1.0.0, so a value in a file the migration did not own (a profile, a workspace) is recognised and shown as deprecated rather than as unknown.

### Behaviour changes

- A folder with its own agent files inside a checkout now runs sessions at the checkout root. **OMP reads project settings, skills, MCP configuration and extensions from `<cwd>/.omp` only, and context files from the nearest `.omp` at or above the cwd, so a subfolder's own `.omp` (or `.claude/settings.json`) stops applying to new sessions there**: the root's `.omp` applies instead, and the Settings editor writes `<root>/.omp`. Settings a user kept in `<subfolder>/.omp` do not move; they apply again if the setting is turned off for that folder. This follows from removing the agent-files nuance, as the user decided; no one-time notice or tooltip warns about it. [OPEN: Main may want one for an opened folder that holds a non-empty `.omp`.]
- Non-Git checkouts (the ten other systems) now climb.
- Sessions in a folder outside any checkout are unchanged.
- A Unity user turns nothing on: `useNearestAncestorOmpFolder` is no longer needed, and the notice is gone.
- A user who turned `useAgentRootFolder` off keeps sessions in the opened folder (the setting is renamed); the editors follow the same rule, so they now write to the opened folder's `.omp` rather than a climbed one, where `useNearestAncestorOmpFolder` was on.

## Alternatives

- **Keep both settings and fix the overlap.** Two names for one question, and a checkbox the Unity user must find. Rejected by the user.
- **Keep the agent-files nuance** (climb only when the folder has none). Makes the answer depend on the content of directories and breaks for a subfolder with a stray `AGENTS.md`. Rejected by the user.
- **Detect with VCS programs** (`git rev-parse --show-toplevel`, `hg root`, `cm getworkspacefrompath`). Exact for worktrees and sparse layouts, but a process per folder per probe, absent binaries, and the Plastic and Perforce CLIs need a server. Rejected: marker stats are enough.
- **Read VS Code's Git extension for the repository.** Covers Git only and depends on another extension's activation. Rejected.
- **Make the editors keep a separate folder choice.** The divergence this design removes.
- **Show the opened folder as the row label, with the root in the description.** See the Sessions display decision above.
- **Treat CVS and Perforce as unsupported.** Cheap to support with weak markers that stay out of home and drive roots; kept.

## Risks and Open Questions

- **A `.git` in the home folder or another very high directory** (a dotfiles repository, an accidental `git init ~`). Every folder under it without a nearer marker then runs at the home folder. This is the correct answer for a real checkout, the user's stated exception, and the escape is turning the setting off per folder. It interacts badly with two existing rules: OMP never treats the home folder as a project, and Desk's editors refuse a home project layer, so sessions there load the global configuration only (the old rule also climbed to `~` when `~/.omp` existed). A directory with a stray `.git` between the folder and the real root is also chosen (nearest wins).
- **Perforce configured through the registry** (`p4 set P4CONFIG=...`) is invisible; the conventional `.p4config` is still checked. Documented, not handled.
- **Several markers at one directory** (a colocated Jujutsu repository has `.jj` and `.git`) are one root; there is no conflict.
- **Window agreement.** A window whose host sees another `P4CONFIG` value resolves a folder to another root, its row ids differ, and the ADR-0057 receiver can refuse with "this window shows no such folder" until the environments agree. Publishing the owner's resolved folder instead of `staysInFolder` would remove the dependence; not done, because the inputs are the same for ordinary users.
- **Mixed builds during an update.** An older window does not publish `staysInFolder` and reads another window's folders by its own rule, so the two may show a folder differently until each reloads; the registry's own epoch handling for a window that was not reloaded is unchanged.
- **Network or slow drives.** Fifteen stats per directory against a stalled share could be slow; the probe is asynchronous and the first answer is the folder itself, so the UI never waits, and a pass shares one memo.
- **The row label reading** (see Sessions display) is an interpretation of the request.
- **The Unity project picker.** More folders now reach it: the Unity projects are searched two levels under the root, so a root with several projects asks which one a launch is for, and the remembered answer is keyed by the root. The launching window's own opened Unity project is a candidate through `openedPaths`.
- **One resolver means two surfaces.** It covers where sessions start and what the three editors edit. `omp models --json` and the palette provider login keep running in the first workspace folder.
- **Migration timing.** The new key is read at once while the move of an old value runs asynchronously at activation, so a New Session started in the first moments after an update can still use the default (on) for a user whose old value was `false`.
- **Hidden keys.** The three old names stay contributed until 1.0.0 and are deleted with ADR-0068's alias table.

## Rollout and Verification

1. `checkout-root.ts` and `session-folder.ts` with unit tests over temp directories (every system, nearest-wins, worktree and submodule files, nested systems, home and drive root, weak markers, P4CONFIG name, memo).
2. Replace `AgentRootResolver` consumers (launcher folders, window routing, Sessions tooltips, the registry's `staysInFolder`), then the editors' `editorProjectFolder`, then remove the old option from `config-ancestor.ts` and the notice from the pages.
3. Migration with tests (explicit false carried, ancestor key dropped, no writes when nothing to move).
4. Documentation and a CHANGELOG Changed entry with the migration note.
5. Isolated VS Code window (`scripts/test-vscode.ps1`): a Unity-like git layout `repo/Game`, open `repo/Game`, start a session, read the session file header's cwd; open `/settings`, Project view, confirm it targets `repo/.omp`; seed the old settings in the scratch profile and read the migration lines in the OMP Desk log.

### Verification evidence (2026-10-14, installed VSIX in an isolated window, scratch profile)

- Layout: `repo/.git`, `repo/AGENTS.md`, `repo/omp-vscode/Assets`, `repo/Game/ProjectSettings/ProjectVersion.txt`; VS Code opened on `repo/Game`.
- Migration: a profile seeded with `ompDesk.useAgentRootFolder: false` and `ompDesk.ompSettings.useNearestAncestorOmpFolder: true` logged `settings: ompDesk.useAgentRootFolder → ompDesk.runSessionsAtRepositoryRoot (user settings): moved` and `... useNearestAncestorOmpFolder (user settings): dropped (it held true) ...`; `settings.json` then held only `ompDesk.runSessionsAtRepositoryRoot: false`.
- Off: a New Session created OMP's session directory `...-repo-Game` (cwd `repo/Game`) and the window's registry record published `staysInFolder`.
- On (key removed from settings.json): a New Session created `...-repo`, the record's `liveCwds` was `repo` and `staysInFolder` was gone; the session started without a model login, so no session file was written and the directory name is the cwd evidence.
- Editors: `OMP Desk: Open OMP Settings` with that session active opened "OMP Settings · repo", Project · repo (the session's folder), not `Game`.

## Related Decisions

[ADR-0073](../decisions/0073-run-sessions-at-the-checkout-root-and-let-the-editors-follow.md) (this design's decision); supersedes in part the 2026-10-10 amendment of the [window-folders design](2026-10-07-window-folders-and-other-window-state.md) (the agent-root substitution) and [ADR-0056](../decisions/0056-publish-window-state-in-a-leased-registry-and-switch-windows-by-request.md) (its application-scope decision, repeated in [ADR-0045](../decisions/0045-derive-window-folders-per-window-and-pin-with-identity-ids.md) item 3), [ADR-0071](../decisions/0071-edit-omps-settings-from-its-own-registry-in-a-staged-worker-and-write-one-layer-at-a-time.md) (the ancestor-folder amendment) and the editors' project-folder binding in [ADR-0072](../decisions/0072-resolve-roles-and-agents-in-the-worker-with-omps-own-functions-and-write-agent-overrides-to-either-layer.md); builds on ADR-0056's registry and [ADR-0057](../decisions/0057-start-a-session-in-the-window-that-suits-its-folder.md) (Unity routing, unchanged); [ADR-0068](../decisions/0068-rename-contributed-ids-to-ompdesk-and-migrate-settings-at-activation.md) (migration style).

## Architecture Review

- Reviewer: architect (independent, read-only; one review covers this design and ADR-0073, plus a confirmation pass)
- Outcome: accepted after changes. The review found three material problems, all fixed: (M1) the editors re-resolved a folder that was already a session's folder, so with the setting on they could edit `<root>/.omp` while a subfolder session read its own `<cwd>/.omp`; they now bind a session's own cwd, the Sessions rows and a dialog-chosen folder as they are, and resolve only the first opened workspace folder when OMP Settings opens with no session; (M2) a subfolder's own `.omp` stops applying to new sessions, which the documents did not say: disclosed in the behaviour changes, the ADR and the CHANGELOG, with the mitigation (a notice) left as an open decision; (M3) the Resume claim was false: folder Resume scans the shown folder's own cwd only, now stated as an existing limit. Minor findings (identity cases, Perforce and cost wording, ADR-0056 as the source of the application-scope decision, refusal message, risks for home, the Unity picker, window agreement, migration timing, the scope of "one resolver", hidden-key removal at 1.0.0, stale comments) are folded in. The confirmation pass found five wording issues, fixed.
- Notes: the marker table, the nearest-wins and home/drive-root rules, `staysInFolder`, ADR-0057 routing, keeping the ancestor refusal and the migration were confirmed sound. Optional markers the reviewer named and this design leaves out: TFVC (`$tf`) and ClearCase (`view.dat`).
