# Upgrading

## From 0.3.x

Every command, setting, view and context key moved from `omp.` to `ompDesk.` (OMP Desk no longer uses the namespace of Oh My Pi itself), and the Command Palette category is **OMP Desk**.

- **Settings** move to their `ompDesk.` names by themselves the first time this version starts, in your user settings and in a workspace's settings where the setting can live there; the output channel **OMP Desk** has one line per moved setting. A value that cannot be moved (a read-only workspace settings file) stays where it is, and the line says why. The new names are listed in [Settings](settings.md).
- **Keybindings** in your own `keybindings.json` keep working for now: the old command ids are still accepted, and the first use of each shows a warning with a button that opens the file. Rename `omp.<command>` to `ompDesk.<command>` there, in `when` clauses too (`omp.sessionMode`, `omp.streaming`, `omp.composerPopupOpen` are also still set under their old names); entries that remove a default binding (`-omp.<command>`) must be renamed at once, because they cannot be forwarded. The old ids keep working until 1.0.0, which removes them.
- The OMP Desk views return to their default arrangement once (collapsed state, order, the side bar they were moved to).

## From the unpublished local build

Local builds made before the first release used a different extension ID (publisher and name were both `omp-vscode`) and were never published. VS Code keys an extension's global storage, secrets and state by extension ID, so `hmmvot.omp-desk` starts with its own empty state. The one thing that is carried over is the registered folder list, which OMP Desk imports once from the old build. Session rows, claims, background processes and shell records are not imported: they describe processes and ownership of the old build.

1. In the old build, close every running session from the Sessions view, so no background process is left that the new extension cannot adopt.
2. Uninstall the old build. It must go first: both builds contribute the same commands and views.
3. Install OMP Desk and open the Sessions view. The folders appear automatically; session history lives in OMP's own files and reappears through each folder's **Resume Session**.
4. Optionally delete the old extension's folder inside VS Code's `globalStorage` directory once nothing needs it.

The old build's settings (`omp.*`) are moved to their `ompDesk.*` names when OMP Desk first starts, so user settings carry over.

The maintainer's notes on this move, with the technical details, are in [publishing.md](../publishing.md#moving-from-the-unpublished-local-build).
