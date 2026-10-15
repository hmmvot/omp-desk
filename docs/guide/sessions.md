# Sessions

The **Sessions** view in the OMP Desk Activity Bar container lists every OMP session and every folder you work in. This page covers the view, how sessions keep running, the background processes behind them, Stats, and where sessions and files open.

![Sessions view](../../media/readme/sessions.png)

## Sessions that survive restarts

- Each session runs in its own background process.
- Close its tab, reload the window or close VS Code: the session keeps working.
- Reopen it to get the same process and screen back.
- Only one window writes a session at a time.
- Stopping a session never deletes its history.

For how this works, see the [architecture](../architecture.md).

### The VS Code update exception

**Installing a VS Code update is the one thing that ends sessions.** Its installer stops every `Code.exe` of the install after waiting about 30 s, and Terminals, folder shells and Stats run as `Code.exe`. So **Restart to Update** ends their processes, and with them the OMP processes of running Terminal sessions (a turn in progress and its sub-agents are lost).

A **Chat** keeps its OMP process alive on the `bun.exe` that runs it when Desk can use that Bun (see [`ompDesk.chatBrokerRuntime`](settings.md)), and such a Chat survives the update: the next window re-adopts it with its transcript. That needs OMP launched through Bun (the Bun global install). An OMP installed as its own program (the winget package, the `omp.sh` binary install, a mise install) has no Bun to share, so its Chats run as `Code.exe` like the rest. A Chat that could not use Bun runs as `Code.exe` too; the OMP Desk output says which each Chat uses.

OMP Desk cannot prevent the installer's stop. When it sees the updater's log naming one of its hosts, it says so, and it resumes the sessions that were running from their files.

A background process on Bun keeps the `bun.exe` it started from, so after `bun upgrade` a second upgrade can fail with a rename error until that Chat is stopped (**Stop** in the Terminals group, or **Kill All**).

## The Sessions view

### What it lists

- Every OMP session, running or stopped, of the folders open in **any window** of the profile and the folders you pin, so every window shows the same list in the same order.
- By default it is **one flat list**, each row labelled `folder · title`. The layout button in the view's title bar opens a picker for the **flat list**, sessions **grouped under their folders** and the **Terminals** layout, which lists the background processes ([`ompDesk.sessionsGrouping`](settings.md)).
- In the flat list and the folders layout, terminals and processes that no listed session stands for are in a **Terminals** group at the very end, after the New Session… and Resume Session… rows and set off by a blank row.
- The flat list puts sessions that are not stopped first, unread ones on top and then the most recently active, and stopped sessions last.
- A **New Session…** row and a **Resume Session…** row under it, at the end, ask for the folder. Resume Session asks for the folder when several are shown, then lists that folder's saved sessions. The title bar has no New Session or Resume Session button. (`Ctrl+Alt+N` and `Ctrl+Alt+R` run the same commands; `Ctrl+Alt+Q` is a searchable **Go to Session** list; see [Keyboard shortcuts](keyboard-shortcuts.md).)
- If the default OMP profile has no models yet, **Log in to a model provider to start** appears above the sessions.

### Status and the unread marker

- Live status per session: **Working**, **Waiting for subagents**, **Needs your answer**, **Idle** or **Unread reply**.
- A blue **●** at the right end of a row marks a reply you have not read: the agent finished or asked you something while you were not looking at that session. It clears when you look at the session's editor, and it survives a window reload.
- While a session has an open editor, its row stays selected: the one you viewed most recently. Selecting a folder or the New Session or Resume Session row puts the selection back. (The Terminals layout has no session rows and keeps your selection.)

### Sessions in other windows

- A session open in another window shows the same live status there, and clicking it takes you straight to that window with the session's tab selected, with no question first. If that window cannot be brought forward (for example it has an unsaved multi-root workspace), you are told why.
- A session that a plain `omp` in a terminal is writing shows **Open in another OMP process**. OMP Desk asks before opening it too.
- New Session, Resume Session and opening a stopped session of a folder that is open only in another window start in that window; see [`ompDesk.launchInFolderWindow`](settings.md).

### Folders

- **Pin Folder** keeps a folder in every window. **Add Folder** picks and pins another one. **Unpin Folder** removes a pin.
- The folders open in this window are listed next to the pinned ones ([`ompDesk.showWorkspaceFolders`](settings.md)).
- Sessions run at the root of the version-control checkout a folder lies in ([`ompDesk.runSessionsAtRepositoryRoot`](settings.md)).

### Row actions

- **Open**, **Rename**, **Reload**, **Close**, **Forget** and **Delete**. A folder's **Resume Session** lists every saved session.
- A click that takes time says so at once: the row you clicked reads **Opening…**, **Starting…**, **Closing…**, **Killing…**, **Deleting…**, **Forgetting…** or **Renaming…** with what it is doing (`checking for another OMP process`, `waiting for your answer`), the seconds once it passes five, and a progress bar runs across the view. The composer's **Resume** button shows the same in the Chat. A second click on a row that is already busy changes nothing, and **New Session** on a folder whose new session is still starting just shows that session.
- **Open Terminal in Folder** starts a plain shell editor in that folder.
- **Copy Diagnostics** in the context menu copies paths and process details for bug reports.

## Background processes and the Terminals layout

**Background processes** are part of **Sessions**: a running session shows `Process: running` in its tooltip, and terminals and processes that no listed session stands for are in a **Terminals** group at the end of the list.

- The **Terminals** layout lists every process with its folder; a click opens its session or terminal, and **Stop** ends one.
- **Stop Orphaned and Idle** cleans up unused processes.
- **Kill All** stops everything in this window, and after you confirm, in all windows.

## Stats

**Stats** in the Sessions title opens OMP's usage dashboard in an editor tab. If your OMP build would also open a browser, OMP Desk asks first.

## Where sessions and files open

Sessions open in their own editor group on the left, and OMP Desk locks it. Files opened from Chat links, the Explorer or Quick Open go to a group on the right, so you read them next to the chat. Turn this off with [`ompDesk.chatColumn`](settings.md); unlock the group from its title bar for a one-off change.

`Ctrl+Shift+M` moves all files of the group next to the chat into one window that stays on top and back again; see [Keyboard shortcuts](keyboard-shortcuts.md).
