import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseGitDocumentUri, revisionVersion } from "./quote-revision.ts";
import type { GitDocument, RevisionLookup } from "./quote-revision.ts";

const FILE = "D:\\Work\\omp-vscode\\src\\app.ts";
const SHA = "3f2a9c1d5e6b7a8091a2b3c4d5e6f708192a3b4c";

/** A Git extension that answers from fixed facts, and records what it was asked. */
function lookup(facts: { staged?: boolean | null; commits?: Record<string, string> }): RevisionLookup & { readonly asked: string[] } {
	const asked: string[] = [];
	return {
		asked,
		async isStaged(fsPath) { asked.push(`staged ${fsPath}`); return facts.staged ?? null; },
		async commitOf(_fsPath, ref) { asked.push(`commit ${ref}`); return facts.commits?.[ref] ?? null; },
	};
}

const version = (ref: string, facts: Parameters<typeof lookup>[0] = {}): Promise<string | null> => revisionVersion({ fsPath: FILE, ref }, lookup(facts));

describe("the git: document of a diff side", () => {
	const query = (path: string, ref: string) => JSON.stringify({ path, ref });

	it("is read from the scheme and the JSON query the Git extension writes", () => {
		assert.deepEqual(parseGitDocumentUri({ scheme: "git", query: query(FILE, "HEAD") }), { fsPath: FILE, ref: "HEAD" });
		assert.deepEqual(parseGitDocumentUri({ scheme: "git", query: query("/home/me/app.ts", "") }), { fsPath: "/home/me/app.ts", ref: "" });
	});

	it("is nothing for another scheme, an empty or broken query, or a path that is not absolute", () => {
		assert.equal(parseGitDocumentUri({ scheme: "file", query: query(FILE, "HEAD") }), null);
		assert.equal(parseGitDocumentUri({ scheme: "git-blame", query: query(FILE, "HEAD") }), null);
		assert.equal(parseGitDocumentUri({ scheme: "git", query: "" }), null);
		assert.equal(parseGitDocumentUri({ scheme: "git", query: "{" }), null);
		assert.equal(parseGitDocumentUri({ scheme: "git", query: "[]" }), null);
		assert.equal(parseGitDocumentUri({ scheme: "git", query: JSON.stringify({ path: FILE }) }), null);
		assert.equal(parseGitDocumentUri({ scheme: "git", query: query("src/app.ts", "HEAD") }), null);
		assert.equal(parseGitDocumentUri({ scheme: "git", query: JSON.stringify({ path: 1, ref: "HEAD" }) }), null);
		assert.equal(parseGitDocumentUri({ scheme: "git", query: JSON.stringify({ path: FILE, ref: "wt", submoduleOf: "D:\\Work\\omp-vscode" }) }), null);
	});
});

describe("which version a git: document is", () => {
	it("says index for the empty ref, the staged side of a diff", async () => {
		const git = lookup({});
		assert.equal(await revisionVersion({ fsPath: FILE, ref: "" }, git), "index");
		assert.deepEqual(git.asked, [], "nothing to ask");
	});

	it("resolves HEAD, a branch and a tag to the commit they name when the Git extension answers, and keeps the name when it does not", async () => {
		assert.equal(await version("HEAD", { commits: { HEAD: SHA } }), "HEAD (3f2a9c1)");
		assert.equal(await version("main", { commits: { main: SHA.toUpperCase() } }), "main (3f2a9c1)");
		assert.equal(await version("v1.2.0", { commits: { "v1.2.0": SHA } }), "v1.2.0 (3f2a9c1)");
		assert.equal(await version("HEAD~1", { commits: { "HEAD~1": SHA } }), "HEAD~1 (3f2a9c1)");
		assert.equal(await version("HEAD"), "HEAD", "the commit could not be resolved");
		assert.equal(await version("HEAD", { commits: { HEAD: "not a hash" } }), "HEAD");
	});

	it("shows a ref that already is a commit as its short hash, without asking", async () => {
		const git = lookup({});
		assert.equal(await revisionVersion({ fsPath: FILE, ref: SHA }, git), "3f2a9c1");
		assert.equal(await revisionVersion({ fsPath: FILE, ref: "3F2A9C1D" }, git), "3f2a9c1");
		assert.deepEqual(git.asked, []);
	});

	it("reads ~ the way the Git extension does: the index when the file is staged, else HEAD", async () => {
		assert.equal(await version("~", { staged: true }), "index");
		assert.equal(await version("~", { staged: false, commits: { HEAD: SHA } }), "HEAD (3f2a9c1)");
		assert.equal(await version("~", { staged: false }), "HEAD");
		assert.equal(await version("~", { staged: null }), null, "which side it is cannot be told");
	});

	it("names the stages of a merge conflict", async () => {
		assert.equal(await version("~1"), "merge base (index :1)");
		assert.equal(await version("~2"), "ours (index :2)");
		assert.equal(await version(":3"), "theirs (index :3)");
	});

	it("refuses a ref that cannot be written into a location or is too long", async () => {
		for (const ref of ["a b", "x`y", "a\nb", "$(x)", "a".repeat(101), ":0"]) assert.equal(await version(ref), null, JSON.stringify(ref));
		assert.equal(await version("feature/a-b_c.d@{1}", {}), "feature/a-b_c.d@{1}");
	});

	it("asks about the file the document names", async () => {
		const git = lookup({ staged: true });
		const document: GitDocument = { fsPath: FILE, ref: "~" };
		await revisionVersion(document, git);
		assert.deepEqual(git.asked, [`staged ${FILE}`]);
	});
});
