/**
 * The window's commit-hash links (`host/commit-links.ts`): the repositories come from VS Code's built-in Git extension API, and
 * showing a commit runs that extension's own `git.viewCommit` on the repository the lookup found. Created once per extension host, which is per window.
 */
import * as vscode from "vscode";
import { CommitLinkResolver } from "../host/commit-links.ts";
import type { CommitRepository } from "../host/commit-links.ts";
import { gitApi } from "./git-api.ts";
import type { GitRepository } from "./git-api.ts";

/**
 * The built-in Git extension's command that opens a commit's changes in a multi-file diff editor (hidden from the palette, callable).
 * Arguments (read from the bundle of VS Code 1.143.1, `Commands.viewCommit`): a repository selector, then the hash. The selector must
 * name an open repository (a `Uri` inside its root, such as the root itself): anything else makes the command ask the user to pick one.
 */
export const GIT_VIEW_COMMIT = "git.viewCommit";

/** Open `hash` of `repository`, after checking that the Git extension still has that repository open (a closed one would make `git.viewCommit` show a repository picker). */
async function viewCommit(repository: GitRepository, hash: string): Promise<void> {
	const root = repository.rootUri.fsPath.toLowerCase();
	if ((await gitApi())?.repositories.some(open => open.rootUri.fsPath.toLowerCase() === root) !== true) {
		throw new Error("the repository is no longer open in this window");
	}
	await vscode.commands.executeCommand(GIT_VIEW_COMMIT, repository.rootUri, hash);
}

export function createCommitLinkResolver(): CommitLinkResolver {
	return new CommitLinkResolver({
		async repositories(): Promise<readonly CommitRepository[]> {
			const api = await gitApi();
			if (api === undefined) return [];
			return api.repositories.map(repository => ({
				root: repository.rootUri.fsPath,
				getCommit: ref => repository.getCommit(ref),
				viewCommit: hash => viewCommit(repository, hash),
			}));
		},
	});
}
