/**
 * The files a session owns beside its transcript that a Chat reply can name with an internal OMP URL, found and read for
 * the read-only `omp-session-file:` documents: a subagent's published output (`agent://<id>` is `<id>.md`) and a file of
 * the session's scratch space (`local://<path>` is `local/<path>`). OMP's own layout (pi-coding-agent
 * `internal-urls/agent-protocol.ts`, `local-protocol.ts`): everything lies below the artifacts directory, the transcript's
 * path without `.jsonl`; a nested subagent `Parent.Child` keeps its files in the directory its parent's transcript names
 * (`<artifacts>/Parent/Parent.Child.md`, one level deeper for each generation).
 *
 * The page never names a path. The host builds every path here from the session file of the conversation that asked and
 * from an id or relative path of a fixed grammar, and nothing follows a link out of the directory: the file is a regular
 * file by `lstat` (never a symlink) whose real path is inside the real directory it was looked for in. The provider runs
 * all of it on every read, because an `omp-session-file:` URI is data a restored tab brings back.
 */
import { lstat, realpath } from "node:fs/promises";
import * as path from "node:path";
import { MAX_ARTIFACT_BYTES, readBoundedText, sessionArtifactsDirectory } from "./artifact-lookup.ts";
import { isAgentId } from "../shared/internal-links.ts";

export const SESSION_FILE_SCHEME = "omp-session-file";
/** The name of the scratch directory below the artifacts directory (`local://`). */
const LOCAL_DIRECTORY = "local";

export type SessionFileRef =
	| { readonly kind: "agent"; readonly id: string }
	| { readonly kind: "local"; readonly path: string };

export interface FoundSessionFile {
	readonly file: string;
	readonly name: string;
	readonly bytes: number;
}

export type SessionFileLookup =
	| { readonly status: "found"; readonly found: FoundSessionFile }
	| { readonly status: "refused"; readonly reason: string };

export type SessionFileRead =
	| { readonly status: "text"; readonly name: string; readonly text: string }
	| { readonly status: "too-large"; readonly name: string; readonly bytes: number }
	| { readonly status: "refused"; readonly reason: string };

const refused = (reason: string): { readonly status: "refused"; readonly reason: string } => ({ status: "refused", reason });

/** What the reference is called in a sentence. */
function describe(ref: SessionFileRef): string {
	return ref.kind === "agent" ? `The output of agent ${ref.id}` : `local://${ref.path}`;
}

/**
 * The URI parts of a session file document: `omp-session-file:/agent/<id>.md?session=<encoded session file>` or
 * `/local/<relative path>`. The editor tab is titled by the last path segment, which also gives the editor its language.
 */
export function sessionFileUriParts(ref: SessionFileRef, sessionFile: string): { readonly path: string; readonly query: string } {
	return { path: ref.kind === "agent" ? `/agent/${ref.id}.md` : `/local/${ref.path}`, query: `session=${encodeURIComponent(sessionFile)}` };
}

/** The reference and session file of an `omp-session-file:` URI, or `null` for anything else (another scheme, a path that is not exactly the shapes above, an id outside the grammar, a segment that could leave a folder). */
export function parseSessionFileUri(uri: { readonly scheme: string; readonly path: string; readonly query: string }): { readonly ref: SessionFileRef; readonly sessionFile: string } | null {
	if (uri.scheme !== SESSION_FILE_SCHEME) return null;
	const query = /^session=([^&]+)$/.exec(uri.query)?.[1];
	const parts = /^\/(agent|local)\/(.+)$/.exec(uri.path);
	if (query === undefined || parts === null) return null;
	let sessionFile: string;
	try { sessionFile = decodeURIComponent(query); } catch { return null; }
	if (parts[1] === "agent") {
		const id = /^(.+)\.md$/.exec(parts[2]!)?.[1];
		return id !== undefined && isAgentId(id) ? { ref: { kind: "agent", id }, sessionFile } : null;
	}
	const segments = parts[2]!.split("/");
	return isLocalPath(segments) ? { ref: { kind: "local", path: segments.join("/") }, sessionFile } : null;
}

/** Whether `segments` are a relative path that cannot leave the folder it is joined to: no empty, dot or dot-dot segment, nothing a Windows file name cannot hold. */
function isLocalPath(segments: readonly string[]): boolean {
	return segments.length >= 1 && segments.length <= 16 && !segments.some(segment => segment === "" || segment === "." || segment === ".." || /[<>:"|?*\\\u0000-\u001f\u007f]|[ .]$/u.test(segment));
}

/** The directories `<artifacts>/<id>.md` may be in: the artifacts directory itself, then the one a nested id's parent chain names. */
function agentDirectories(artifacts: string, id: string): string[] {
	const parts = id.split(".");
	let directory = artifacts;
	let prefix = "";
	for (const part of parts.slice(0, -1)) {
		prefix = prefix === "" ? part : `${prefix}.${part}`;
		directory = path.join(directory, prefix);
	}
	return directory === artifacts ? [artifacts] : [artifacts, directory];
}

/** `file` as a found regular file whose real path is inside the real `boundary`, or the sentence that says why not. */
async function regularFileInside(file: string, boundary: string, ref: SessionFileRef): Promise<SessionFileLookup> {
	try {
		const entry = await lstat(file);
		if (!entry.isFile()) return refused(`${describe(ref)} is not a regular file.`);
		const [realFile, realBoundary] = await Promise.all([realpath(file), realpath(boundary)]);
		const inside = path.relative(realBoundary, realFile);
		if (inside === "" || inside.startsWith("..") || path.isAbsolute(inside)) return refused(`${describe(ref)} is outside this session's folder.`);
		return { status: "found", found: { file, name: path.basename(file), bytes: entry.size } };
	} catch {
		return refused(`${describe(ref)} is not in this session's folder.`);
	}
}

/** Find the file `ref` names in the session transcript `sessionFile`'s own folder, or say why it cannot be opened. */
export async function findSessionFile(sessionFile: string, ref: SessionFileRef): Promise<SessionFileLookup> {
	const session = await sessionArtifactsDirectory(sessionFile);
	if (session.status === "refused") return session;
	if (ref.kind === "agent") {
		if (!isAgentId(ref.id)) return refused("That is not an agent id.");
		let last: SessionFileLookup = refused(`${describe(ref)} is not in this session's folder.`);
		for (const directory of agentDirectories(session.directory, ref.id)) {
			last = await regularFileInside(path.join(directory, `${ref.id}.md`), session.directory, ref);
			if (last.status === "found") return last;
		}
		return last;
	}
	if (!isLocalPath(ref.path.split("/"))) return refused("That is not a path inside this session's scratch space.");
	const root = path.join(session.directory, LOCAL_DIRECTORY);
	return regularFileInside(path.join(root, ...ref.path.split("/")), root, ref);
}

/** The text of a session file: at most {@link MAX_ARTIFACT_BYTES}, decoded as UTF-8 with replacement; a binary file is refused. */
export async function readSessionFile(sessionFile: string, ref: SessionFileRef): Promise<SessionFileRead> {
	const lookup = await findSessionFile(sessionFile, ref);
	if (lookup.status === "refused") return lookup;
	const { file, name, bytes } = lookup.found;
	if (bytes > MAX_ARTIFACT_BYTES) return { status: "too-large", name, bytes };
	const text = await readBoundedText(file, bytes);
	if (text === null) return refused(`${describe(ref)} cannot be read.`);
	return text.slice(0, 8192).includes("\u0000") ? refused(`${describe(ref)} (${name}) is not a text file.`) : { status: "text", name, text };
}

/** What a session file document shows when the file cannot be shown as text; never empty, so an open never looks like an empty file. */
export function sessionFileNotice(ref: SessionFileRef, read: Exclude<SessionFileRead, { status: "text" }>): string {
	if (read.status === "too-large") return `${describe(ref)} (${read.name}) is ${(read.bytes / (1024 * 1024)).toFixed(1)} MiB, more than the ${MAX_ARTIFACT_BYTES / (1024 * 1024)} MiB this view reads. Open the file in the session's folder to see it.\n`;
	return `${read.reason}\n`;
}

/** The whole text of the document an `omp-session-file:` URI names: the file, or one sentence that says why it cannot be shown. Never throws. */
export async function sessionFileDocumentText(uri: { readonly scheme: string; readonly path: string; readonly query: string }): Promise<string> {
	const target = parseSessionFileUri(uri);
	if (target === null) return "This is not an OMP session file address.\n";
	const read = await readSessionFile(target.sessionFile, target.ref);
	return read.status === "text" ? read.text : sessionFileNotice(target.ref, read);
}
