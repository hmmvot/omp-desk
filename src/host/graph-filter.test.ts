/**
 * The Source Control Graph's reference filter as VS Code stores it: parsed for one repository, named in the user's words, and read
 * back from a real `state.vscdb` (SQLite) the way the Graph's own storage writes it.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type * as Sqlite from "node:sqlite";
import { GRAPH_FILTER_KEY, describeGraphRef, graphRefId, parseGraphFilter, readGraphFilter, readStoredGraphFilter } from "./graph-filter.ts";

const REPO = "file:///c%3A/Users/someone/work/project";
const KEY = `git:Git:${REPO}`;

test("the filter of a repository is read from the stored pairs; no pair, \"all\" and an unknown repository are not limited", () => {
	assert.deepEqual(parseGraphFilter(undefined, REPO), { kind: "unlimited" }, "a Graph that was never filtered");
	assert.deepEqual(parseGraphFilter("[]", REPO), { kind: "unlimited" }, "Auto is stored as no pair");
	assert.deepEqual(parseGraphFilter(JSON.stringify([[KEY, "all"]]), REPO), { kind: "unlimited" });
	assert.deepEqual(parseGraphFilter(JSON.stringify([[KEY, ["refs/heads/other"]]]), REPO), { kind: "refs", refs: ["refs/heads/other"] });
	assert.deepEqual(parseGraphFilter(JSON.stringify([[KEY, []]]), REPO), { kind: "refs", refs: [] });
	assert.deepEqual(parseGraphFilter(JSON.stringify([[`git:Git:${REPO}2`, ["refs/heads/x"]], ["scm:Other:file:///c%3A/elsewhere", ["refs/heads/y"]]]), REPO), { kind: "unlimited" }, "another repository's filter is not this one's");
	assert.deepEqual(parseGraphFilter(JSON.stringify([[`git:Git:file:///c%3A/Users/someone/work/other`, ["refs/heads/x"]], [KEY, ["refs/heads/z"]]]), REPO), { kind: "refs", refs: ["refs/heads/z"] }, "the pair of this repository among others");
});

test("a stored filter that is not what the Graph writes is unreadable, never a guess", () => {
	assert.equal(parseGraphFilter("{", REPO).kind, "unreadable");
	assert.equal(parseGraphFilter("{}", REPO).kind, "unreadable");
	assert.equal(parseGraphFilter(JSON.stringify([[KEY, 7]]), REPO).kind, "unreadable");
	assert.equal(parseGraphFilter(JSON.stringify([[KEY, ["refs/heads/a", 1]]]), REPO).kind, "unreadable");
});

test("the checked-out reference has the id the Git extension gives the Graph, and is named as the user knows it", () => {
	assert.equal(graphRefId({ type: 0, name: "main", commit: "abc" }), "refs/heads/main");
	assert.equal(graphRefId({ name: "feature/x", commit: "abc" }), "refs/heads/feature/x");
	assert.equal(graphRefId({ type: 2, name: "v1", commit: "abc" }), "refs/tags/v1");
	assert.equal(graphRefId({ commit: "abc123" }), "abc123", "a detached HEAD is its commit");
	assert.equal(graphRefId({}), undefined);
	assert.equal(graphRefId(undefined), undefined);
	assert.deepEqual(describeGraphRef("refs/heads/feature/x"), { noun: "branch", name: "feature/x" });
	assert.deepEqual(describeGraphRef("refs/tags/v1"), { noun: "tag", name: "v1" });
	assert.deepEqual(describeGraphRef("c7398070aaaaaaaaaaaa"), { noun: "commit", name: "c7398070aaaa" });
});

test("the filter is read from the workspace's state.vscdb, whatever else the file holds, and a file that cannot be read is unreadable", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-graph-filter-"));
	try {
		assert.equal(readGraphFilter(undefined, REPO).kind, "unreadable", "no workspace storage");
		assert.equal(readGraphFilter(path.join(dir, "missing"), REPO).kind, "unreadable", "no database");

		const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof Sqlite;
		const database = new DatabaseSync(path.join(dir, "state.vscdb"));
		database.exec("CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)");
		database.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run("scm.graphView.viewMode", "list");
		assert.equal(readStoredGraphFilter(dir), undefined, "no row yet");
		assert.deepEqual(readGraphFilter(dir, REPO), { kind: "unlimited" });

		database.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run(GRAPH_FILTER_KEY, JSON.stringify([[KEY, ["refs/heads/other"]]]));
		assert.deepEqual(readGraphFilter(dir, REPO), { kind: "refs", refs: ["refs/heads/other"] }, "read while VS Code still holds the file open");
		database.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run(GRAPH_FILTER_KEY, Buffer.from("[]"));
		assert.deepEqual(readGraphFilter(dir, REPO), { kind: "unlimited" }, "the Graph's next write replaces the row; a BLOB value is text too");
		database.close();
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
