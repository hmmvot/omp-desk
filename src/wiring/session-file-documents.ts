/**
 * The read-only `omp-session-file:` documents: a subagent's published output (`agent://<id>`) and a file of the session's
 * scratch space (`local://<path>`), opened in an editor tab from a link in a Chat reply. Like the `omp-artifact:` documents
 * the provider is read-only by construction (a scheme with a provider and no file system has no save) and is registered at the
 * start of `activate`, so an editor tab of the scheme that Reload Window restores is served as soon as the window has one.
 * The route and the provider share `host/session-file-lookup.ts`.
 */
import * as vscode from "vscode";
import { SESSION_FILE_SCHEME, findSessionFile, sessionFileDocumentText, sessionFileUriParts } from "../host/session-file-lookup.ts";
import type { SessionFileRef } from "../host/session-file-lookup.ts";
import type { InternalOpenOutcome } from "../host/internal-links.ts";

export interface SessionFileDocuments {
	/** Open the file `ref` names in the session transcript `sessionFile`'s own folder in a read-only editor tab. */
	open(sessionFile: string, ref: SessionFileRef): Promise<InternalOpenOutcome>;
}

/** Register the provider; the returned object opens documents, and disposing the subscription unregisters the scheme. */
export function registerSessionFileDocuments(subscriptions: { push(...items: vscode.Disposable[]): number }): SessionFileDocuments {
	subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(SESSION_FILE_SCHEME, {
		provideTextDocumentContent: uri => sessionFileDocumentText(uri),
	}));
	return {
		async open(sessionFile, ref) {
			const found = await findSessionFile(sessionFile, ref);
			if (found.status === "refused") return { opened: false, reason: found.reason };
			try {
				const document = await vscode.workspace.openTextDocument(vscode.Uri.from({ scheme: SESSION_FILE_SCHEME, ...sessionFileUriParts(ref, sessionFile) }));
				await vscode.window.showTextDocument(document, { preview: true });
				return { opened: true };
			} catch (error) {
				return { opened: false, reason: `${found.found.name} could not be opened: ${error instanceof Error ? error.message : String(error)}` };
			}
		},
	};
}
