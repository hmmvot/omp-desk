/**
 * `OMP Desk: Show Commands` (`Ctrl+Alt+P`): the Command Palette already filtered to this extension's commands.
 *
 * Every command OMP Desk contributes carries the category `OMP Desk`, and the palette lists a command as `<category>: <title>`, so
 * Quick Open with the value `>OMP Desk: ` (the `>` hands it to the Command Palette, the rest filters on the label) shows the extension's
 * commands and nothing of VS Code's or other extensions'. `workbench.action.quickOpen` takes its prefilled value as the first argument and
 * keeps it (the same call a `keybindings.json` entry with `args` makes).
 */
import * as vscode from "vscode";

/** The Quick Open value that lists the commands of the `OMP Desk` category, and nothing else. */
export const DESK_COMMANDS_QUERY = ">OMP Desk: ";

export function showDeskCommands(): Thenable<unknown> {
	return vscode.commands.executeCommand("workbench.action.quickOpen", DESK_COMMANDS_QUERY);
}
