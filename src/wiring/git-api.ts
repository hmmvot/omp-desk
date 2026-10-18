/**
 * VS Code's built-in Git extension API (version 1), the part OMP Desk uses: the commit-hash links (`commit-links.ts`) and the
 * version a quoted diff side belongs to (`quote-source.ts`).
 */
import * as vscode from "vscode";

export interface GitRepository {
	readonly rootUri: vscode.Uri;
	readonly state: { readonly HEAD?: { readonly commit?: string; readonly name?: string; /** The API's `RefType`: 0 branch, 1 remote branch, 2 tag. */ readonly type?: number }; readonly indexChanges?: readonly { readonly uri: vscode.Uri }[]; readonly onDidChange: vscode.Event<void> };
	getCommit(ref: string): Promise<{ readonly hash: string }>;
	status(): Promise<void>;
}

export interface GitExtensionApi {
	readonly repositories: readonly GitRepository[];
	onDidOpenRepository(listener: (repository: GitRepository) => void): vscode.Disposable;
	onDidCloseRepository(listener: (repository: GitRepository) => void): vscode.Disposable;
}

/** The Git extension's API, activating the extension if needed; `undefined` when it is missing or disabled. */
export async function gitApi(): Promise<GitExtensionApi | undefined> {
	const extension = vscode.extensions.getExtension<{ getAPI(version: 1): GitExtensionApi }>("vscode.git");
	if (extension === undefined) return undefined;
	try {
		return (extension.isActive ? extension.exports : await extension.activate()).getAPI(1);
	} catch {
		return undefined;
	}
}
