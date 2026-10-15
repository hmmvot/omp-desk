/**
 * How a folder is spelled for display. The session index and the folder identity keep a Windows path case-folded
 * (`normalizeWorkspaceDirectory`, right for comparing), so a title or a label built from them shows `omp-vscode` for `Omp-Vscode`.
 * The editors compare by that key and show this spelling.
 */
import { realpath } from "node:fs";
import { promisify } from "node:util";
import { normalizeWorkspaceDirectory } from "./session-files.ts";

const realpathNative = promisify(realpath.native);

/**
 * `folder` with a Windows drive letter in upper case. VS Code's `Uri.fsPath` spells the drive in lower case (`c:\repo`), and
 * everything built from it (the opened folders, the checkout root derived from them) keeps that spelling, while the file system
 * and the scope pickers say `C:\repo`. A path that does not start with a drive letter is returned as it is.
 */
export function displayFolderPath(folder: string): string {
	return /^[a-z]:(?=[\\/]|$)/.test(folder) ? folder[0]!.toUpperCase() + folder.slice(1) : folder;
}

/**
 * `folder` spelled as the file system spells it, on Windows only (elsewhere the case is already exact). Only a difference
 * of case is taken: a junction, a drive alias or a short name resolves to another path, and `folder` is kept then.
 * A folder that is gone keeps its given spelling.
 */
export async function onDiskFolder(folder: string): Promise<string> {
	if (process.platform !== "win32") return folder;
	try {
		const real = await realpathNative(folder);
		return normalizeWorkspaceDirectory(real) === normalizeWorkspaceDirectory(folder) ? real : displayFolderPath(folder);
	} catch {
		return displayFolderPath(folder);
	}
}

/**
 * The folders a scope picker lists: `listed` (the Sessions folders, whose paths are case-folded keys on Windows) and the
 * folder the editor is on, one entry per directory, each spelled for display. The editor's own folder wins a tie.
 */
export async function scopePickerFolders(listed: readonly string[], current: string | null): Promise<string[]> {
	const unique = new Map([...listed, ...(current === null ? [] : [current])].map(folder => [normalizeWorkspaceDirectory(folder), folder]));
	return await Promise.all([...unique.values()].map(onDiskFolder));
}
