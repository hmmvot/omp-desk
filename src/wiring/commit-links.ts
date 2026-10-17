/**
 * The window's commit-hash links (`host/commit-links.ts`): the repositories come from VS Code's built-in Git extension API, and
 * opening a commit runs commands of GitLens (when installed) or of the Git extension. Created once per extension host, which is per window.
 */
import * as vscode from "vscode";
import { CommitLinkResolver } from "../host/commit-links.ts";
import type { CommitOpenEnv, CommitRepository } from "../host/commit-links.ts";

/** The part of the Git extension's API (version 1) these links use. */
interface GitExtensionApi {
	readonly repositories: readonly {
		readonly rootUri: vscode.Uri;
		readonly state: { readonly HEAD?: { readonly type?: number; readonly name?: string } };
		getCommit(ref: string): Promise<{ readonly hash: string }>;
		getMergeBase(ref1: string, ref2: string): Promise<string | undefined>;
	}[];
	onDidOpenRepository(listener: () => void): vscode.Disposable;
	onDidCloseRepository(listener: () => void): vscode.Disposable;
}

export interface CommitLinks {
	readonly resolver: CommitLinkResolver;
	readonly env: CommitOpenEnv;
}

/** The Git extension's API, activating the extension if needed; `undefined` when it is missing or disabled. */
async function gitApi(): Promise<GitExtensionApi | undefined> {
	const extension = vscode.extensions.getExtension<{ getAPI(version: 1): GitExtensionApi }>("vscode.git");
	if (extension === undefined) return undefined;
	try {
		return (extension.isActive ? extension.exports : await extension.activate()).getAPI(1);
	} catch {
		return undefined;
	}
}

export function createCommitLinks(subscriptions: { push(...items: vscode.Disposable[]): number }): CommitLinks {
	let watching = false;
	const resolver: CommitLinkResolver = new CommitLinkResolver({
		async repositories(): Promise<readonly CommitRepository[]> {
			const api = await gitApi();
			if (api === undefined) return [];
			if (!watching) {
				watching = true;
				subscriptions.push(api.onDidOpenRepository(() => resolver.invalidate()), api.onDidCloseRepository(() => resolver.invalidate()));
			}
			return api.repositories.map(repository => ({
				root: repository.rootUri.fsPath,
				getCommit: ref => repository.getCommit(ref),
				getMergeBase: (ref1, ref2) => repository.getMergeBase(ref1, ref2),
				// RefType.Head is 0; a detached HEAD at a tagged commit is reported as a tag (2) that carries the tag's name.
				currentBranch: () => (repository.state.HEAD?.type === 0 ? repository.state.HEAD.name : undefined),
			}));
		},
	});
	const env: CommitOpenEnv = {
		async commandAvailable(command) {
			if ((await vscode.commands.getCommands(true)).includes(command)) return true;
			return vscode.extensions.all.some(extension => {
				const commands = (extension.packageJSON as { contributes?: { commands?: { command?: unknown }[] } } | undefined)?.contributes?.commands;
				return Array.isArray(commands) && commands.some(entry => entry.command === command);
			});
		},
		run: (command, ...args) => Promise.resolve(vscode.commands.executeCommand(command, ...args)),
		repositoryUri: root => vscode.Uri.file(root),
	};
	return { resolver, env };
}
