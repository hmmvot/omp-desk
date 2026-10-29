/**
 * OMP Desk — `ompDesk.runSessionsAtRepositoryRoot` read for a folder, and the folder the editors bind.
 *
 * The setting is resource-scoped, so it is read for the folder it applies to: a monorepo folder or workspace can turn it off.
 * Sessions (`extension.ts`) and the folder OMP Settings opens on with no active session read it here and resolve through the same
 * `sessionFolderFor`. An editor opened for a session binds that session's own folder instead, so it reads the `<cwd>/.omp` the session reads.
 */
import * as vscode from "vscode";
import { sessionFolderFor } from "../wire/session-folder.ts";

export const RUN_AT_REPOSITORY_ROOT_SETTING = "ompDesk.runSessionsAtRepositoryRoot";

/** Whether sessions of `folder` run at its checkout root, as that folder's settings say (default: yes). */
export function runsAtRepositoryRoot(folder: string): boolean {
	return vscode.workspace.getConfiguration("ompDesk", vscode.Uri.file(folder)).get<boolean>("runSessionsAtRepositoryRoot", true);
}

/** The folder an editor treats as the project for an opened workspace `folder`: the one sessions run in. A session's own cwd, a Sessions row and a folder the user chose are already the folder and are not passed through here. */
export async function editorProjectFolder(folder: string): Promise<string> {
	return sessionFolderFor(folder, runsAtRepositoryRoot(folder));
}
