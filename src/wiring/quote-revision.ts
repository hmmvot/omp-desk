/**
 * Which version of a file a text editor shows, for a quote taken from a diff (docs/designs/2026-10-15-quote-chat-selection.md,
 * decision 10). A side of a Git diff is a document of the built-in Git extension: scheme `git`, the file's path and a ref in the
 * query (`{"path":"D:\\Work\\Repo\\src\\app.ts","ref":"HEAD"}`). The pure rules live here; the Git lookups they need are passed in.
 */
import { MAX_QUOTE_VERSION_LENGTH } from "../shared/quote-location.ts";

/** The `git:` document a diff side is: the file's path in that version and the ref the Git extension reads it at. */
export interface GitDocument {
	readonly fsPath: string;
	readonly ref: string;
}

/** The document of a `git:` URI, `null` for another scheme, a query the Git extension would not write, or a submodule's entry (its text is a diff of the submodule, not a version of a file). */
export function parseGitDocumentUri(uri: { readonly scheme: string; readonly query: string }): GitDocument | null {
	if (uri.scheme !== "git" || uri.query.length === 0 || uri.query.length > 4096) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(uri.query);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	const { path, ref, submoduleOf } = parsed as { path?: unknown; ref?: unknown; submoduleOf?: unknown };
	if (submoduleOf !== undefined) return null;
	if (typeof path !== "string" || typeof ref !== "string" || !/^(?:[A-Za-z]:[\\/]|[\\/])/.test(path)) return null;
	return { fsPath: path, ref };
}

/** What the Git lookups answer; `null` is "cannot tell". */
export interface RevisionLookup {
	/** Whether the index holds the file: the Git extension reads a `~` ref from the index then, else from HEAD. */
	isStaged(fsPath: string): Promise<boolean | null>;
	/** The full hash of the commit a ref names, `null` when it does not resolve. */
	commitOf(fsPath: string, ref: string): Promise<string | null>;
}

const MERGE_STAGES: Readonly<Record<string, string>> = { "1": "merge base (index :1)", "2": "ours (index :2)", "3": "theirs (index :3)" };

/** A ref that can be written into a location and read back: a branch, a tag, `HEAD~1`, `stash@{0}`, a hash. */
const SAFE_REF = /^[\w./@{}^~+-]{1,100}$/;
const HASH = /^[0-9a-f]{7,64}$/i;
/** Git's default abbreviation (`core.abbrev`, `git.commitShortHashLength`). */
const SHORT_HASH_LENGTH = 7;

/**
 * The words that say which version of the file a `git:` document is, or `null` when they cannot be said truthfully (an unusual
 * ref, or a `~` ref whose side the Git extension would decide). `""` is the index; `~` is the index when the file is staged and
 * HEAD otherwise; `~1`/`~2`/`~3` (and `:1`/`:2`/`:3`) are the stages of a merge conflict; anything else is a commit-ish, shown with
 * the commit it names when that resolves (`HEAD (3f2a9c1)`), or as the short hash when the ref already is one.
 */
export async function revisionVersion(document: GitDocument, lookup: RevisionLookup): Promise<string | null> {
	let { ref } = document;
	if (ref === "") return "index";
	const stage = /^[~:]([123])$/.exec(ref);
	if (stage !== null) return MERGE_STAGES[stage[1] ?? ""] ?? null;
	if (ref === "~") {
		const staged = await lookup.isStaged(document.fsPath);
		if (staged === null) return null;
		if (staged) return "index";
		ref = "HEAD";
	}
	if (!SAFE_REF.test(ref)) return null;
	if (HASH.test(ref)) return ref.slice(0, SHORT_HASH_LENGTH).toLowerCase();
	const hash = await lookup.commitOf(document.fsPath, ref);
	const version = hash !== null && HASH.test(hash) ? `${ref} (${hash.slice(0, SHORT_HASH_LENGTH).toLowerCase()})` : ref;
	return version.length <= MAX_QUOTE_VERSION_LENGTH ? version : null;
}
