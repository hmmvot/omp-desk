/**
 * The window's commit-hash links (`host/commit-links.ts`): the repositories come from VS Code's built-in Git extension API, and
 * showing a commit runs that extension's own `git.viewCommit` on the repository the lookup found; the HEAD commit is also selected in
 * VS Code's own Source Control Graph first. Created once per extension host, which is per window.
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

/**
 * The workbench's command that shows the Source Control Graph view (view id `workbench.scm.history`) and focuses it.
 * Read from the 1.143.1 bundle (`workbench.desktop.main.js`): registered as the view's `focus` command; takes no argument.
 */
export const GRAPH_FOCUS = "workbench.scm.history.focus";

/**
 * The Graph's action that selects, focuses and scrolls to the **current HEAD** item of the repository the Graph shows (it loads more
 * history until the item is there). Read from the 1.143.1 bundle: `runInView` calls `revealCurrentHistoryItem()`, which takes no
 * argument and reads the repository's `historyItemRef` (HEAD); nothing in the workbench or the Git extension selects any other commit.
 * It selects nothing, and says nothing, while the Graph's reference filter hides the current branch (its precondition, the context key
 * `scmCurrentHistoryItemRefInFilter`, is set inside the Graph and an extension cannot read it).
 */
export const GRAPH_REVEAL_HEAD = "workbench.scm.action.graph.revealCurrentHistoryItem";

/** How long a click waits for the Git extension to refresh its state before it takes the state it has. */
const STATUS_REFRESH_MS = 2_000;

/** Whether the Git extension still has `repository` open, and how many repositories it has open. */
async function openState(repository: GitRepository): Promise<{ open: boolean; count: number }> {
	const root = repository.rootUri.fsPath.toLowerCase();
	const repositories = (await gitApi())?.repositories ?? [];
	return { open: repositories.some(open => open.rootUri.fsPath.toLowerCase() === root), count: repositories.length };
}

/** Open `hash` of `repository`, after checking that the Git extension still has that repository open (a closed one would make `git.viewCommit` show a repository picker). */
async function viewCommit(repository: GitRepository, hash: string): Promise<void> {
	if (!(await openState(repository)).open) throw new Error("the repository is no longer open in this window");
	await vscode.commands.executeCommand(GIT_VIEW_COMMIT, repository.rootUri, hash);
}

/**
 * The commit HEAD points at. The Git extension's state, and the Graph with it, lag a commit made a moment ago: refresh it first,
 * but never for longer than {@link STATUS_REFRESH_MS} (a slow `git status` must not hold the diff back).
 */
async function headCommit(repository: GitRepository): Promise<string | undefined> {
	const { promise: expired, resolve } = Promise.withResolvers<void>();
	const timer = setTimeout(resolve, STATUS_REFRESH_MS);
	try {
		// A refresh that fails leaves the state the extension has, which is still the best answer there is.
		await Promise.race([repository.status().catch(() => undefined), expired]);
	} finally {
		clearTimeout(timer);
	}
	return repository.state.HEAD?.commit;
}

/**
 * Show the Graph and select HEAD in it. The Graph shows one repository, picked by the workbench (the active editor's repository or
 * the focused one) and not settable by an extension, so the selection is only attempted when this is the one open repository: with
 * several open it could select the HEAD of another one.
 */
async function revealHeadInGraph(repository: GitRepository): Promise<void> {
	const { open, count } = await openState(repository);
	if (!open) throw new Error("the repository is no longer open in this window");
	if (count !== 1) throw new Error(`${count} repositories are open and the Graph may show another one`);
	const commands = await vscode.commands.getCommands(true);
	if (!commands.includes(GRAPH_FOCUS) || !commands.includes(GRAPH_REVEAL_HEAD)) throw new Error("this VS Code has no Source Control Graph");
	// A view that will not take the focus does not stop the selection: the action selects the item in the view wherever it is.
	await Promise.resolve(vscode.commands.executeCommand(GRAPH_FOCUS)).catch(() => undefined);
	await vscode.commands.executeCommand(GRAPH_REVEAL_HEAD);
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
				headCommit: () => headCommit(repository),
				revealHeadInGraph: () => revealHeadInGraph(repository),
			}));
		},
	});
}
