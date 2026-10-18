/**
 * The window's commit-hash links (`host/commit-links.ts`): the repositories come from VS Code's built-in Git extension API, and
 * showing a commit runs commands of VS Code's Source Control Graph. A link exists only for the commit HEAD points at, so this
 * module also watches each repository's HEAD and says when it moved. Created once per extension host, which is per window.
 */
import * as vscode from "vscode";
import { CommitLinkResolver, GRAPH_FOCUS, GRAPH_REVEAL_HEAD } from "../host/commit-links.ts";
import type { CommitOpenEnv, CommitRepository } from "../host/commit-links.ts";
import { gitApi } from "./git-api.ts";
import type { GitRepository } from "./git-api.ts";

/** A burst of repository state changes (a commit touches the index, the branch and the HEAD one after another) is one report this long after its last HEAD change. */
const HEAD_SETTLE_MS = 150;

export interface CommitLinks {
	readonly resolver: CommitLinkResolver;
	readonly env: CommitOpenEnv;
}

/**
 * `onHeadChanged` runs once after the commit HEAD points at changed in some repository (a commit, a checkout, an amend, a reset), or a
 * repository opened or closed, with a burst of such changes coalesced; the resolver's remembered answers are dropped first.
 * Changes of the index or the working tree are not HEAD changes and report nothing.
 */
export function createCommitLinks(subscriptions: { push(...items: vscode.Disposable[]): number }, log: (message: string) => void, onHeadChanged: () => void): CommitLinks {
	let watching = false;
	const heads = new Map<GitRepository, { head: string | undefined; listener: vscode.Disposable }>();
	/** One `git status` per repository however many links ask at once. */
	const refreshing = new Map<GitRepository, Promise<string | undefined>>();
	let timer: NodeJS.Timeout | undefined;
	const settled = (): void => {
		timer = undefined;
		resolver.invalidate();
		onHeadChanged();
	};
	const schedule = (): void => {
		clearTimeout(timer);
		timer = setTimeout(settled, HEAD_SETTLE_MS);
	};
	const track = (repository: GitRepository): void => {
		if (heads.has(repository)) return;
		const listener = repository.state.onDidChange(() => {
			const entry = heads.get(repository);
			const head = repository.state.HEAD?.commit;
			if (entry === undefined || entry.head === head) return;
			entry.head = head;
			schedule();
		});
		heads.set(repository, { head: repository.state.HEAD?.commit, listener });
	};
	const resolver: CommitLinkResolver = new CommitLinkResolver({
		async repositories(): Promise<readonly CommitRepository[]> {
			const api = await gitApi();
			if (api === undefined) return [];
			if (!watching) {
				watching = true;
				subscriptions.push(
					api.onDidOpenRepository(repository => { track(repository); schedule(); }),
					api.onDidCloseRepository(repository => { heads.get(repository)?.listener.dispose(); heads.delete(repository); schedule(); }),
					{ dispose: () => { clearTimeout(timer); for (const { listener } of heads.values()) listener.dispose(); heads.clear(); } },
				);
			}
			for (const repository of api.repositories) track(repository);
			return api.repositories.map(repository => ({
				root: repository.rootUri.fsPath,
				getCommit: ref => repository.getCommit(ref),
				// The Git extension's state, and the Graph with it, lag a commit made a moment ago: refresh it before reading HEAD.
				headCommit: () => {
					let read = refreshing.get(repository);
					if (read === undefined) {
						read = repository.status().then(() => repository.state.HEAD?.commit).finally(() => refreshing.delete(repository));
						refreshing.set(repository, read);
					}
					return read;
				},
			}));
		},
	});
	const env: CommitOpenEnv = {
		run: (command, ...args) => Promise.resolve(vscode.commands.executeCommand(command, ...args)),
		async graphAvailable() {
			const commands = await vscode.commands.getCommands(true);
			return commands.includes(GRAPH_FOCUS) && commands.includes(GRAPH_REVEAL_HEAD);
		},
		log,
	};
	return { resolver, env };
}
