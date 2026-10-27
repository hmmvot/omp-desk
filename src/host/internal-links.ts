/**
 * Internal OMP URLs of a Chat reply (`agent://<id>`, `history://<id>`, `artifact://<n>`, `local://<path>`), proved and opened
 * on the host for the conversation the page shows. The page names the URL only; the host parses it again
 * (`shared/internal-links.ts`), resolves it against THIS session's own data and opens one of the existing read-only views:
 *
 * - a subagent of the session (`agent://`, `history://`): its detail tab, the live read-only child transcript; for `agent://`
 *   also its published output (`<id>.md`), a read-only document, when OMP's registry does not hold the agent (a session that
 *   was resumed, or a stopped one) or holds it only through a task result of the history;
 * - `artifact://<n>`: the numbered tool-output document of `omp-artifact:`;
 * - `local://<path>`: a file of the session's scratch space as a read-only document.
 *
 * A URL that names nothing this session has is not a link (validation answers `false`), so the page never offers a dead link.
 * Nothing here executes a command, takes a path from the page or opens a file outside the session's own folder.
 */
import { findArtifact } from "./artifact-lookup.ts";
import { findSessionFile } from "./session-file-lookup.ts";
import type { SessionFileRef } from "./session-file-lookup.ts";
import type { InternalLink } from "../shared/internal-links.ts";
import type { TerminalLinkRequest, TerminalLinkValidation } from "../shared/terminal-links.ts";

/** How the live Chat session knows a subagent: its roster holds it (OMP's registry reports it), or only a task result it holds names it. */
export type SubagentKnowledge = "roster" | "reference";

/** What opening a document came to: opened, or the sentence that says why not. */
export type InternalOpenOutcome = { readonly opened: true } | { readonly opened: false; readonly reason: string };

/** What an internal link resolves to in one session. */
export type InternalResolution =
	| { readonly kind: "agent-tab"; readonly id: string }
	| { readonly kind: "file"; readonly sessionFile: string; readonly ref: SessionFileRef; readonly file: string }
	| { readonly kind: "artifact"; readonly sessionFile: string; readonly id: string; readonly file: string };

export interface InternalLinkHost {
	/** Whether the document and session that sent the request are still current; checked after the disk lookup. */
	isCurrent(): boolean;
	reply(message: TerminalLinkValidation): void;
	/** The transcript file of the conversation the page shows, or `null` when it has none yet. Never the page's word. */
	sessionFile(): string | null;
	/** Whether this conversation shows detail tabs (a Chat conversation, not a Terminal or legacy one). */
	readonly tabs: boolean;
	/** How the conversation's live Chat session knows subagent `id`, or `null` (also when the session is not live). */
	knownSubagent(id: string): SubagentKnowledge | null;
	/** Open, or reveal, the agent's detail tab. */
	openAgentTab(id: string): void;
	openSessionFile(sessionFile: string, ref: SessionFileRef): Promise<InternalOpenOutcome>;
	openArtifact(sessionFile: string, artifactId: string): Promise<InternalOpenOutcome>;
	/** Show `file` selected in the system file manager. */
	revealInOs(file: string): Promise<void>;
	/** Short user-visible notice, so an activation that cannot complete is never silent. */
	warn(message: string): void;
}

/**
 * What `link` names in this conversation's session, or `null`. A subagent the live roster holds opens its detail tab; one it
 * does not hold but whose output file the session has opens that file; one only a held task result names opens the tab (the
 * roster rule of the child read), and `history://` has no file to fall back on.
 */
export async function resolveInternalLink(link: InternalLink, host: InternalLinkHost): Promise<InternalResolution | null> {
	if (link.scheme === "history") return host.tabs && host.knownSubagent(link.id) !== null ? { kind: "agent-tab", id: link.id } : null;
	if (link.scheme === "agent") {
		const known = host.tabs ? host.knownSubagent(link.id) : null;
		if (known === "roster") return { kind: "agent-tab", id: link.id };
		const sessionFile = host.sessionFile();
		if (sessionFile !== null) {
			const ref: SessionFileRef = { kind: "agent", id: link.id };
			const found = await findSessionFile(sessionFile, ref);
			if (found.status === "found") return { kind: "file", sessionFile, ref, file: found.found.file };
		}
		return known === "reference" ? { kind: "agent-tab", id: link.id } : null;
	}
	const sessionFile = host.sessionFile();
	if (sessionFile === null) return null;
	if (link.scheme === "local") {
		const ref: SessionFileRef = { kind: "local", path: link.path };
		const found = await findSessionFile(sessionFile, ref);
		return found.status === "found" ? { kind: "file", sessionFile, ref, file: found.found.file } : null;
	}
	const found = await findArtifact(sessionFile, link.id);
	return found.status === "found" ? { kind: "artifact", sessionFile, id: link.id, file: found.artifact.file } : null;
}

/** Why an unresolved link opens nothing, as the notice says it. */
function missing(link: InternalLink): string {
	switch (link.scheme) {
		case "agent":
		case "history": return `this session has no agent ${link.id}`;
		case "artifact": return `this session has no artifact ${link.id}`;
		case "local": return `this session's scratch space has no file ${link.path}`;
	}
}

/**
 * Answer a validation or activation request whose target is an internal link. Both re-resolve on the host; a click opens an
 * existing view, Ctrl+Click shows the file behind the link in the system file manager where there is one (a detail tab
 * has none), and every other modifier is a plain open.
 */
export async function handleInternalLink(request: TerminalLinkRequest, link: InternalLink, host: InternalLinkHost): Promise<void> {
	const resolution = await resolveInternalLink(link, host);
	if (!host.isCurrent()) return;
	if (request.type === "omp:terminal-link-validate") {
		host.reply({ type: "omp:terminal-link-validation", requestId: request.requestId, valid: resolution !== null });
		return;
	}
	if (resolution === null) {
		host.warn(`cannot open "${request.target}": ${missing(link)}.`);
		return;
	}
	try {
		if (resolution.kind === "agent-tab") {
			host.openAgentTab(resolution.id);
			return;
		}
		if (request.action === "os") {
			await host.revealInOs(resolution.file);
			return;
		}
		const outcome = resolution.kind === "artifact" ? await host.openArtifact(resolution.sessionFile, resolution.id) : await host.openSessionFile(resolution.sessionFile, resolution.ref);
		if (!outcome.opened) host.warn(outcome.reason);
	} catch (error) {
		host.warn(`cannot open "${request.target}": ${error instanceof Error ? error.message : String(error)}`);
	}
}
