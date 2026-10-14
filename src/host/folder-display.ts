/**
 * How a folder is spelled for display. The session index and the folder identity keep a Windows path case-folded
 * (`normalizeWorkspaceDirectory`, right for comparing), so a title or a label built from them shows `game` for `Game`.
 * The editors compare by that key and show this spelling.
 */
import { realpath } from "node:fs";
import { promisify } from "node:util";
import { normalizeWorkspaceDirectory } from "./session-files.ts";

const realpathNative = promisify(realpath.native);

/**
 * `folder` spelled as the file system spells it, on Windows only (elsewhere the case is already exact). Only a difference
 * of case is taken: a junction, a drive alias or a short name resolves to another path, and `folder` is kept then.
 * A folder that is gone keeps its given spelling.
 */
export async function onDiskFolder(folder: string): Promise<string> {
	if (process.platform !== "win32") return folder;
	try {
		const real = await realpathNative(folder);
		return normalizeWorkspaceDirectory(real) === normalizeWorkspaceDirectory(folder) ? real : folder;
	} catch {
		return folder;
	}
}
