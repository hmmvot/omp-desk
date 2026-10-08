/**
 * Host-side `@` completion over VS Code's own workspace file index.
 *
 * A completion request never reads the filesystem itself: the answer comes from
 * `vscode.workspace.findFiles`, which only walks the workspace folders VS Code
 * already indexes and already filters through the user's `files.exclude` /
 * `search.exclude` settings. That is the whole safety story of this module —
 * there is no path the Webview can name that makes the host stat, open, or list
 * anything outside the workspace, and the reply carries nothing but file names.
 *
 * The `findFiles` collaborator is injected rather than imported so this module
 * has no runtime dependency on the `vscode` API (the same shape as
 * `guest-webview.ts`): the extension passes
 * `(include, exclude, maxResults) => vscode.workspace.findFiles(include, exclude, maxResults)`
 * at the one call site, which keeps every branch below testable with a plain
 * fake. See {@link findFileMentions}.
 *
 * Bounds, all enforced here rather than trusted from the caller:
 * - the query is a short, control-character-free string ({@link parseFileQuery});
 * - the glob is built from a sanitized query, so a typed `*` can neither broaden
 *   the search nor produce a malformed pattern ({@link fileMentionInclude});
 * - `findFiles` is asked for a bounded multiple of the visible list
 *   ({@link SEARCH_MAX_RESULTS}) and the answer is ranked, deduplicated and cut
 *   to {@link FILE_COMPLETION_LIMIT}.
 *
 * Paths are returned in the form OMP resolves mentions against: relative to the
 * session working directory with forward slashes when the file is inside it,
 * otherwise the absolute path, also with forward slashes
 * ({@link mentionPath}). OMP resolves a mention with
 * `resolveReadPath(filePath, cwd)` and treats a mention that does not resolve to
 * an existing file as prose, so a wrong directory here silently turns a mention
 * into text — the reason the cwd, not the workspace folder, is the base.
 */
import {
	FILE_COMPLETION_LIMIT,
	MAX_FILE_PATH_LENGTH,
	MAX_FILE_QUERY_LENGTH,
	isSafeBoundaryText,
} from "../webview/messages.ts";

/** Minimal URI shape this module needs; `vscode.Uri` satisfies it structurally. */
export interface FileSearchUri {
	readonly fsPath: string;
}

/**
 * The `vscode.workspace.findFiles` shape, minus the cancellation token: the
 * caller adapts its own API so this module stays free of `vscode` at runtime.
 */
export type FindFilesLike = (
	include: string,
	exclude: string | undefined,
	maxResults: number,
) => PromiseLike<readonly FileSearchUri[]> | readonly FileSearchUri[];

/** How many candidates to ask `findFiles` for per visible suggestion. */
const SEARCH_OVERFETCH = 10;

/** Hard ceiling on one search, independent of the visible list size. */
const SEARCH_MAX_RESULTS = 200;

/** Glob metacharacters a typed query must not smuggle into the include pattern. */
const GLOB_METACHARACTER = /[*?[\]{}()!]/g;

/**
 * Validate an untrusted query. Returns the trimmed query, or `null` when it is
 * not a string, is too long, or carries control characters — all of which fail
 * closed to "no suggestions" rather than to a guess.
 *
 * An empty query is valid: a bare `@` is a request for the first files of the
 * workspace, and the result is bounded like any other.
 */
export function parseFileQuery(value: unknown): string | null {
	if (typeof value !== "string") return null;
	if (value.length > MAX_FILE_QUERY_LENGTH) return null;
	if (!isSafeBoundaryText(value)) return null;
	return value.trim();
}

/**
 * Include pattern for `findFiles`.
 *
 * The query is normalized the way a Windows user types paths (`\` → `/`) and
 * stripped of glob metacharacters: the pattern stays a plain "contains"
 * search over the workspace, and the exact match check happens in
 * {@link rankFileMentions} where case and separator handling are ours.
 */
export function fileMentionInclude(query: string): string {
	const needle = query.trim().replaceAll("\\", "/").replaceAll(GLOB_METACHARACTER, "");
	return needle.length === 0 ? "**/*" : `**/*${needle}*`;
}

/** Where a candidate matched: basename prefix beats basename beats path. */
function matchBucket(candidate: string, needle: string): number {
	if (needle.length === 0) return 0;
	const basename = candidate.slice(candidate.lastIndexOf("/") + 1).toLowerCase();
	if (basename.startsWith(needle)) return 0;
	if (basename.includes(needle)) return 1;
	return 2;
}

/**
 * Filter, rank, deduplicate and bound the candidates for `query`.
 *
 * Ranking is deliberate and stable — basename prefix, then basename, then path
 * match; shorter paths first inside a bucket; then plain string order — so the
 * popup neither reorders between identical requests nor depends on the locale.
 */
export function rankFileMentions(candidates: readonly string[], query: string): string[] {
	const needle = query.trim().replaceAll("\\", "/").toLowerCase();
	const seen = new Set<string>();
	const ranked: { path: string; bucket: number }[] = [];
	for (const candidate of candidates) {
		if (candidate.length === 0 || candidate.length > MAX_FILE_PATH_LENGTH) continue;
		if (!isSafeBoundaryText(candidate)) continue;
		const normalized = candidate.replaceAll("\\", "/");
		const key = normalized.toLowerCase();
		if (needle.length > 0 && !key.includes(needle)) continue;
		if (seen.has(key)) continue;
		seen.add(key);
		ranked.push({ path: normalized, bucket: matchBucket(normalized, needle) });
	}
	ranked.sort((left, right) => {
		if (left.bucket !== right.bucket) return left.bucket - right.bucket;
		if (left.path.length !== right.path.length) return left.path.length - right.path.length;
		return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
	});
	return ranked.slice(0, FILE_COMPLETION_LIMIT).map(entry => entry.path);
}

/** Forward-slash form of a filesystem path; the mention grammar has no separators of its own. */
function toPosix(value: string): string {
	return value.replaceAll("\\", "/");
}

/** Comparison form: Windows paths and drive letters arrive with inconsistent casing. */
function comparablePosix(value: string): string {
	const posix = toPosix(value);
	return process.platform === "win32" ? posix.toLowerCase() : posix;
}

/**
 * The path to insert for a workspace file: relative to the OMP session working
 * directory when the file is inside it, otherwise absolute. Always forward
 * slashes, and the file's own casing is preserved.
 *
 * An unknown or empty `cwd` therefore yields absolute paths rather than guesses:
 * a wrong relative path would resolve to a different file, or to nothing.
 */
export function mentionPath(fsPath: string, cwd: string): string {
	const file = toPosix(fsPath);
	const base = toPosix(cwd).replace(/\/+$/, "");
	if (base.length === 0) return file;
	const fileKey = comparablePosix(file);
	const baseKey = comparablePosix(base);
	if (fileKey === baseKey || !fileKey.startsWith(`${baseKey}/`)) return file;
	const relative = file.slice(base.length + 1);
	// A candidate that is the cwd itself plus a separator (a directory, which
	// `findFiles` does not return) would otherwise become an empty mention.
	return relative.length === 0 ? file : relative;
}

/**
 * Bounded `@` completion for one request.
 *
 * Never throws and never rejects: a search failure, a cancelled search or a
 * malformed query all resolve to "no suggestions", because a completion is a
 * convenience for the prompt the user is already typing and must not be able to
 * break it.
 */
export async function findFileMentions(
	query: unknown,
	options: { cwd: string; findFiles: FindFilesLike },
): Promise<string[]> {
	const parsed = parseFileQuery(query);
	if (parsed === null) return [];
	let found: readonly FileSearchUri[];
	try {
		found = await options.findFiles(
			fileMentionInclude(parsed),
			undefined,
			Math.min(FILE_COMPLETION_LIMIT * SEARCH_OVERFETCH, SEARCH_MAX_RESULTS),
		);
	} catch {
		return [];
	}
	const candidates: string[] = [];
	for (const uri of found) {
		if (typeof uri?.fsPath === "string") candidates.push(mentionPath(uri.fsPath, options.cwd));
	}
	return rankFileMentions(candidates, parsed);
}
