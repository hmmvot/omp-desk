/**
 * The artifact files of a session, found and read for the `omp-artifact:` documents (tool output design, slice 5).
 *
 * OMP saves what a tool's truncated output left out as `<artifacts directory>/<id>.<type>.<ext>`, the directory being the
 * session transcript's path without `.jsonl`. The page asks for `artifact://<id>` of the conversation it shows; the route
 * (opening a document) and the content provider (serving it, also for an editor tab restored by Reload Window, which never
 * passes through the route) share this one lookup and run all of it on every read, because an `omp-artifact:` URI is data a
 * restored tab brings back, not something this window just built.
 *
 * Nothing here follows a link out of the directory: the file is the entry of a non-recursive listing whose name has the one
 * accepted shape, a regular file by `lstat` (never a symlink), whose real path is inside the real directory.
 */
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import * as path from "node:path";
import { readSessionFileHeader } from "./session-files.ts";
import { sessionFileLayout } from "./session-lifecycle.ts";

export const ARTIFACT_SCHEME = "omp-artifact";
/** What one artifact document shows at most; a larger file is named and not read. */
export const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
const ARTIFACT_ID = /^\d{1,9}$/;
const ARTIFACT_NAME = /^(\d{1,9})\.([A-Za-z0-9_-]+)\.[A-Za-z0-9]+$/;

/** An artifact the lookup found: where it is, its file name and its size. */
export interface FoundArtifact {
	readonly file: string;
	readonly name: string;
	readonly bytes: number;
}

export type ArtifactLookup =
	| { readonly status: "found"; readonly artifact: FoundArtifact }
	| { readonly status: "refused"; readonly reason: string };

export type ArtifactRead =
	| { readonly status: "text"; readonly name: string; readonly text: string }
	| { readonly status: "too-large"; readonly name: string; readonly bytes: number }
	| { readonly status: "refused"; readonly reason: string };

const refused = (reason: string): { readonly status: "refused"; readonly reason: string } => ({ status: "refused", reason });

/** The tool an artifact file name names (`12.bash.log` is bash's), or `null` for a name of another shape. */
export function artifactTool(name: string): string | null {
	return ARTIFACT_NAME.exec(name)?.[2] ?? null;
}

/**
 * The URI parts of an artifact document: `omp-artifact:/<id>/<title>?session=<encoded session file>`. The editor tab is
 * titled by the last path segment, so that segment is the title (`Full output · bash · artifact 12`), not the bare id.
 */
export function artifactUriParts(artifactId: string, sessionFile: string, tool: string | null = null): { readonly path: string; readonly query: string } {
	const title = `Full output · ${tool === null ? "" : `${tool} · `}artifact ${artifactId}`;
	return { path: `/${artifactId}/${title}`, query: `session=${encodeURIComponent(sessionFile)}` };
}

/** The artifact id and session file of an `omp-artifact:` URI, or `null` for anything else. The title segment is display only; a tab saved before it existed (`/<id>`) still resolves. */
export function parseArtifactUri(uri: { readonly scheme: string; readonly path: string; readonly query: string }): { readonly artifactId: string; readonly sessionFile: string } | null {
	if (uri.scheme !== ARTIFACT_SCHEME) return null;
	const artifactId = /^\/(\d{1,9})(?:\/[^/]+)?$/.exec(uri.path)?.[1];
	const query = /^session=([^&]+)$/.exec(uri.query)?.[1];
	if (artifactId === undefined || query === undefined) return null;
	try {
		return { artifactId, sessionFile: decodeURIComponent(query) };
	} catch {
		return null;
	}
}

/**
 * The artifacts directory of the session transcript `sessionFile`: its path without `.jsonl`, once the file is an
 * absolute path of a real OMP transcript (a regular file with a session header). Everything a session owns beside its
 * transcript (tool-output artifacts, subagent outputs, the `local://` scratch space) lives below it.
 */
export async function sessionArtifactsDirectory(sessionFile: string): Promise<{ readonly status: "found"; readonly directory: string } | { readonly status: "refused"; readonly reason: string }> {
	const layout = path.isAbsolute(sessionFile) ? sessionFileLayout(sessionFile) : null;
	if (layout === null || layout.artifactsDirectory === null) return refused("The session file is not an OMP session transcript.");
	try {
		if (!(await stat(sessionFile)).isFile() || (await readSessionFileHeader(sessionFile)) === null) return refused("The session file is not an OMP session transcript.");
	} catch {
		return refused("The session file is gone.");
	}
	return { status: "found", directory: layout.artifactsDirectory };
}

/** Find artifact `artifactId` of the session transcript `sessionFile`, or say why it cannot be opened. */
export async function findArtifact(sessionFile: string, artifactId: string): Promise<ArtifactLookup> {
	if (!ARTIFACT_ID.test(artifactId)) return refused("That is not an artifact id.");
	const session = await sessionArtifactsDirectory(sessionFile);
	if (session.status === "refused") return session;
	const directory = session.directory;
	let names: string[];
	try {
		names = await readdir(directory);
	} catch {
		return refused("This session has no artifacts directory.");
	}
	const name = names.filter(entry => ARTIFACT_NAME.exec(entry)?.[1] === artifactId).sort()[0];
	if (name === undefined) return refused(`Artifact ${artifactId} is not in this session's artifacts directory.`);
	const file = path.join(directory, name);
	try {
		const entry = await lstat(file);
		if (!entry.isFile()) return refused(`Artifact ${artifactId} is not a regular file.`);
		const [realFile, realDirectory] = await Promise.all([realpath(file), realpath(directory)]);
		const inside = path.relative(realDirectory, realFile);
		if (inside === "" || inside.startsWith("..") || path.isAbsolute(inside)) return refused(`Artifact ${artifactId} is outside this session's artifacts directory.`);
		return { status: "found", artifact: { file, name, bytes: entry.size } };
	} catch {
		return refused(`Artifact ${artifactId} cannot be read.`);
	}
}

/** The first {@link MAX_ARTIFACT_BYTES} of a file of `bytes` bytes, decoded as UTF-8 with replacement; `null` when it cannot be read. */
export async function readBoundedText(file: string, bytes: number): Promise<string | null> {
	try {
		const handle = await open(file, "r");
		try {
			const buffer = Buffer.allocUnsafe(Math.min(bytes, MAX_ARTIFACT_BYTES));
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
			return buffer.subarray(0, bytesRead).toString("utf8");
		} finally {
			await handle.close();
		}
	} catch {
		return null;
	}
}

/** The text of an artifact: at most {@link MAX_ARTIFACT_BYTES}, decoded as UTF-8 with replacement. */
export async function readArtifact(sessionFile: string, artifactId: string): Promise<ArtifactRead> {
	const found = await findArtifact(sessionFile, artifactId);
	if (found.status === "refused") return found;
	const { file, name, bytes } = found.artifact;
	if (bytes > MAX_ARTIFACT_BYTES) return { status: "too-large", name, bytes };
	const text = await readBoundedText(file, bytes);
	return text === null ? refused(`Artifact ${artifactId} cannot be read.`) : { status: "text", name, text };
}

/** What an artifact document shows when the file cannot be shown as text; never empty, so an open never looks like an empty file. */
export function artifactNotice(artifactId: string, read: Exclude<ArtifactRead, { status: "text" }>): string {
	if (read.status === "too-large") return `Artifact ${artifactId} (${read.name}) is ${(read.bytes / (1024 * 1024)).toFixed(1)} MiB, more than the ${MAX_ARTIFACT_BYTES / (1024 * 1024)} MiB this view reads. Open the file in the session's artifacts directory to see it.\n`;
	return `${read.reason}\n`;
}

/** The whole text of the document an `omp-artifact:` URI names: the artifact, or one sentence that says why it cannot be shown. Never throws. */
export async function artifactDocumentText(uri: { readonly scheme: string; readonly path: string; readonly query: string }): Promise<string> {
	const target = parseArtifactUri(uri);
	if (target === null) return "This is not an OMP artifact address.\n";
	const read = await readArtifact(target.sessionFile, target.artifactId);
	return read.status === "text" ? read.text : artifactNotice(target.artifactId, read);
}
