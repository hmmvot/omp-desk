/**
 * The document a quote is taken from (`ompDesk.quoteEditorSelection`; docs/designs/2026-10-15-quote-chat-selection.md, decisions 9
 * and 10): a file on disk, or one side of a Git diff, which is a `git:` document of VS Code's built-in Git extension. The pure rules
 * (the URI, the words for a version) are in `quote-revision.ts`; this module is the part that asks the Git extension.
 */
import * as path from "node:path";
import * as vscode from "vscode";
import { isInside } from "../host/link-scope.ts";
import type { EditorQuoteSource } from "./editor-context.ts";
import { gitApi } from "./git-api.ts";
import type { GitRepository } from "./git-api.ts";
import { parseGitDocumentUri, revisionVersion } from "./quote-revision.ts";
import type { RevisionLookup } from "./quote-revision.ts";

/** A symbolic ref is resolved to a commit for the location, but never at the price of a stuck Alt+Q. */
const RESOLVE_TIMEOUT_MS = 3_000;

/** The deepest repository of the Git extension that holds `fsPath`. */
async function repositoryOf(fsPath: string): Promise<GitRepository | undefined> {
	const api = await gitApi();
	return api?.repositories.filter(repository => isInside(repository.rootUri.fsPath, fsPath)).sort((a, b) => b.rootUri.fsPath.length - a.rootUri.fsPath.length)[0];
}

const sameFile = (a: string, b: string): boolean => path.win32.normalize(a).toLowerCase() === path.win32.normalize(b).toLowerCase();

const gitLookup: RevisionLookup = {
	async isStaged(fsPath) {
		const repository = await repositoryOf(fsPath);
		const staged = repository?.state.indexChanges;
		return staged === undefined ? null : staged.some(change => sameFile(change.uri.fsPath, fsPath));
	},
	async commitOf(fsPath, ref) {
		const repository = await repositoryOf(fsPath);
		if (repository === undefined) return null;
		const timeout = Promise.withResolvers<null>();
		const timer = setTimeout(() => timeout.resolve(null), RESOLVE_TIMEOUT_MS);
		try {
			return await Promise.race([repository.getCommit(ref).then(commit => commit.hash, () => null), timeout.promise]);
		} finally {
			clearTimeout(timer);
		}
	},
};

/**
 * What `editor` shows, for a quote of `selections`. A `file:` document is the file on disk. A `git:` document is a version of a
 * file: its path is the file's, and its `version` says which one (`index`, `HEAD (3f2a9c1)`, `3f2a9c1`), so the lines it quotes are
 * lines of that version. Every other document, and a `git:` one whose version cannot be told truthfully, has no path.
 */
export async function quoteSourceOf(document: vscode.TextDocument, selections: readonly vscode.Selection[]): Promise<EditorQuoteSource> {
	const { uri } = document;
	let fsPath: string | null = null;
	let version: string | null = null;
	if (uri.scheme === "file") {
		fsPath = uri.fsPath;
	} else {
		const git = parseGitDocumentUri(uri);
		const said = git === null ? null : await revisionVersion(git, gitLookup);
		if (git !== null && said !== null) {
			fsPath = git.fsPath;
			version = said;
		}
	}
	return {
		fsPath,
		version,
		fileName: fsPath === null ? "" : path.basename(fsPath),
		languageId: document.languageId,
		selections: selections.map(selection => ({ start: selection.start, end: selection.end, text: document.getText(selection) })),
	};
}
