/**
 * The read-only `omp-artifact:` documents: what a tool's truncated output left out, opened in an editor tab (tool output
 * design, slice 5). The content provider is read-only by construction (a scheme with a provider and no file system has no save),
 * and is registered at the start of `activate` so an editor tab of the scheme that Reload Window restores is served as soon
 * as the window has one. The route and the provider share `host/artifact-lookup.ts`.
 */
import * as vscode from "vscode";
import { ARTIFACT_SCHEME, artifactDocumentText, artifactTool, artifactUriParts, findArtifact } from "../host/artifact-lookup.ts";

/** What opening an artifact came to: opened, or the sentence that says why not. */
export type ArtifactOpenOutcome = { readonly opened: true } | { readonly opened: false; readonly reason: string };

export interface ArtifactDocuments {
	/** Open artifact `artifactId` of the session transcript `sessionFile` in a read-only editor tab. */
	open(sessionFile: string, artifactId: string): Promise<ArtifactOpenOutcome>;
}

/** Register the provider; the returned object opens documents, and disposing the subscription unregisters the scheme. */
export function registerArtifactDocuments(subscriptions: { push(...items: vscode.Disposable[]): number }): ArtifactDocuments {
	subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(ARTIFACT_SCHEME, {
		provideTextDocumentContent: uri => artifactDocumentText(uri),
	}));
	return {
		async open(sessionFile, artifactId) {
			const found = await findArtifact(sessionFile, artifactId);
			if (found.status === "refused") return { opened: false, reason: found.reason };
			try {
				const document = await vscode.workspace.openTextDocument(vscode.Uri.from({ scheme: ARTIFACT_SCHEME, ...artifactUriParts(artifactId, sessionFile, artifactTool(found.artifact.name)) }));
				await vscode.window.showTextDocument(document, { preview: true });
				return { opened: true };
			} catch (error) {
				return { opened: false, reason: `Artifact ${artifactId} could not be opened: ${error instanceof Error ? error.message : String(error)}` };
			}
		},
	};
}
