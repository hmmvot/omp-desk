import assert from "node:assert/strict";
import { test } from "node:test";
import * as path from "node:path";
import { observeSessionBranch, repositoryForCwd } from "./session-branch.ts";
import type { GitApi, GitRepository } from "./session-branch.ts";

function event() {
	const listeners = new Set<() => void>();
	return { listen(listener: () => void) { listeners.add(listener); return { dispose() { listeners.delete(listener); } }; },
		fire() { for (const listener of listeners) listener(); } };
}

test("cwd selects the deepest native repository, not siblings or string-prefix paths", () => {
	const change = event();
	const repo = (root: string): GitRepository => ({ rootUri: { fsPath: path.resolve(root) }, state: { HEAD: { name: "main", type: 0 }, onDidChange: change.listen } });
	const root = repo("/workspace/project"), nested = repo("/workspace/project/nested"), sibling = repo("/workspace/project-other");
	const api: GitApi = { repositories: [root, nested, sibling], onDidOpenRepository: change.listen, onDidCloseRepository: change.listen };
	assert.equal(repositoryForCwd(api, path.resolve("/workspace/project/nested/src")), nested);
	assert.equal(repositoryForCwd(api, path.resolve("/workspace/project/src")), root);
	assert.equal(repositoryForCwd(api, path.resolve("/workspace/project-other/src")), sibling);
	assert.equal(repositoryForCwd(api, path.resolve("/outside")), undefined);
});

test("native updates supersede stale CLI, detached HEAD uses short sha and disposal stops publication", async () => {
	const changes = event(), opened = event(), closed = event();
	const repositories: GitRepository[] = [];
	const api: GitApi = { repositories, onDidOpenRepository: opened.listen, onDidCloseRepository: closed.listen };
	const pending = Promise.withResolvers<string | null>();
	const values: Array<string | null> = [];
	let reads = 0;
	const observer = observeSessionBranch(path.resolve("/project/src"), api, branch => values.push(branch), () => { reads++; return pending.promise; });
	const repository: GitRepository = { rootUri: { fsPath: path.resolve("/project") }, state: { HEAD: { name: "main", type: 0 }, onDidChange: changes.listen } };
	repositories.push(repository); opened.fire();
	pending.resolve("stale-cli"); await pending.promise; await Promise.resolve();
	assert.deepEqual(values, ["main"]);
	repository.state.HEAD = { commit: "1234567890abcdef", type: 2, name: "tag" }; changes.fire();
	assert.deepEqual(values, ["main", "1234567"]);
	changes.fire();
	assert.deepEqual(values, ["main", "1234567"]);
	observer.dispose();
	repository.state.HEAD = { name: "ignored", type: 0 }; changes.fire();
	assert.deepEqual(values, ["main", "1234567"]);
	assert.equal(reads, 1);
});

test("no native repository hides outside-repo results and refreshes CLI on lifecycle triggers", async () => {
	const values: Array<string | null> = [];
	let branch: string | null = null;
	const observer = observeSessionBranch("/project", undefined, value => values.push(value), async () => branch);
	await Promise.resolve();
	assert.deepEqual(values, [null]);
	branch = "new-branch"; observer.refresh(); await Promise.resolve();
	assert.deepEqual(values, [null, "new-branch"]);
	observer.dispose();
});
