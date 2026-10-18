/**
 * What the Source Control Graph's reference filter is set to, for the commit-hash links (`commit-links.ts`). The Graph's action that
 * selects the current commit does nothing, silently, while the Graph's filter hides the current branch (its precondition is the
 * context key `scmCurrentHistoryItemRefInFilter`, which lives in the Graph view and that no extension can read), so a click has to
 * know the filter to say why nothing was selected.
 *
 * The Graph keeps the filter per repository in VS Code's workspace storage under the key `scm.graphView.referencesFilter`: a JSON
 * array of `[repository key, filter]` pairs where the repository key is `<provider id>:<provider label>:<root URI>` and the filter
 * is `"all"` or the list of reference ids (`refs/heads/main`) the Graph is limited to; the default, "Auto", is stored as no pair.
 * VS Code writes that storage to the workspace's `state.vscdb` (SQLite) within a moment of a change, and an extension's own
 * workspace storage folder is a child of the folder that holds it. This is internal to VS Code, not an API: every step that can fail
 * ends in `unreadable`, which a click treats as "no filter" (it selects, as before, and logs why the filter was not read).
 */
import * as path from "node:path";
import type * as Sqlite from "node:sqlite";

/** What the Graph shows for one repository. */
export type GraphFilter =
	/** "Auto" or "All": the Graph shows the current branch. */
	| { readonly kind: "unlimited" }
	/** Limited to these reference ids, which may or may not include the current branch. */
	| { readonly kind: "refs"; readonly refs: readonly string[] }
	/** The filter could not be read; `why` is for the log. */
	| { readonly kind: "unreadable"; readonly why: string };

export const GRAPH_FILTER_KEY = "scm.graphView.referencesFilter";
const GRAPH_PROVIDER_PREFIX = "git:";

/** The Git extension's `RefType.Head` / `RefType.Tag`. */
const REF_TYPE_HEAD = 0;
const REF_TYPE_TAG = 2;

/** The id the Git extension gives the Graph for what is checked out: `refs/heads/<branch>`, `refs/tags/<tag>`, the commit when HEAD is detached; `undefined` when HEAD has nothing yet. */
export function graphRefId(head: { readonly type?: number; readonly name?: string; readonly commit?: string } | undefined): string | undefined {
	if (head === undefined) return undefined;
	if (head.name !== undefined && head.type === REF_TYPE_TAG) return `refs/tags/${head.name}`;
	if (head.name !== undefined && (head.type === undefined || head.type === REF_TYPE_HEAD)) return `refs/heads/${head.name}`;
	return head.commit;
}

/** How the user's words name a reference id: `the current branch (main)`. */
export function describeGraphRef(ref: string): { readonly noun: "branch" | "tag" | "commit"; readonly name: string } {
	if (ref.startsWith("refs/heads/")) return { noun: "branch", name: ref.slice("refs/heads/".length) };
	if (ref.startsWith("refs/tags/")) return { noun: "tag", name: ref.slice("refs/tags/".length) };
	return { noun: "commit", name: ref.slice(0, 12) };
}

/**
 * The filter stored for the repository whose root URI (`Uri.toString()`) is `repositoryUri`; `stored` is the raw value under
 * `GRAPH_FILTER_KEY`, `undefined` when there is none (a Graph that was never filtered).
 */
export function parseGraphFilter(stored: string | undefined, repositoryUri: string): GraphFilter {
	if (stored === undefined) return { kind: "unlimited" };
	let entries: unknown;
	try {
		entries = JSON.parse(stored);
	} catch {
		return { kind: "unreadable", why: "the stored filter is not JSON" };
	}
	if (!Array.isArray(entries)) return { kind: "unreadable", why: "the stored filter is not a list" };
	for (const entry of entries as unknown[]) {
		if (!Array.isArray(entry) || typeof entry[0] !== "string") continue;
		const key = entry[0];
		if (!key.startsWith(GRAPH_PROVIDER_PREFIX) || !key.endsWith(`:${repositoryUri}`)) continue;
		const filter: unknown = entry[1];
		if (filter === "all") return { kind: "unlimited" };
		if (Array.isArray(filter) && filter.every(ref => typeof ref === "string")) return { kind: "refs", refs: filter as string[] };
		return { kind: "unreadable", why: "the stored filter of this repository has an unknown shape" };
	}
	return { kind: "unlimited" };
}

/** The value `GRAPH_FILTER_KEY` has in `<workspaceStorage>/state.vscdb`; `undefined` when the key has no row. Throws when the database cannot be read. */
export function readStoredGraphFilter(workspaceStorage: string): string | undefined {
	// `node:sqlite` is the runtime's own module (not a dependency); it is loaded here so that a host without it fails this read only.
	const sqlite = process.getBuiltinModule("node:sqlite") as typeof Sqlite | undefined;
	if (sqlite === undefined) throw new Error("this runtime has no node:sqlite");
	const { DatabaseSync } = sqlite;
	const database = new DatabaseSync(path.join(workspaceStorage, "state.vscdb"), { readOnly: true });
	try {
		const row = database.prepare("SELECT value FROM ItemTable WHERE key = ?").get(GRAPH_FILTER_KEY);
		const value = row?.value;
		return typeof value === "string" ? value : value instanceof Uint8Array ? Buffer.from(value).toString("utf8") : undefined;
	} finally {
		database.close();
	}
}

/** The Graph's filter for the repository at `repositoryUri` in the workspace whose storage folder is `workspaceStorage`. Never throws. */
export function readGraphFilter(workspaceStorage: string | undefined, repositoryUri: string): GraphFilter {
	if (workspaceStorage === undefined) return { kind: "unreadable", why: "this window has no workspace storage" };
	try {
		return parseGraphFilter(readStoredGraphFilter(workspaceStorage), repositoryUri);
	} catch (error) {
		return { kind: "unreadable", why: error instanceof Error ? error.message : String(error) };
	}
}
