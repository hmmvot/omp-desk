/**
 * Commit hashes of a reply, proved against a fake Git API and shown through a fake command registry: which repository answers,
 * ambiguity and look-alike refs, the cache, and which command a click runs.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { GITLENS_REVEAL_COMMIT, GITLENS_SHOW_COMMITS, GIT_VIEW_COMMIT, SCM_VIEW, CommitLinkResolver, gitLensRepoPath, handleCommitLink, openCommit, repositoriesContaining } from "./commit-links.ts";
import type { CommitHit, CommitLinkHost, CommitOpenEnv, CommitRepository } from "./commit-links.ts";
import type { TerminalLinkRequest, TerminalLinkValidation } from "../shared/terminal-links.ts";

const FULL = "c7398070aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER = "1111111bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

interface FakeRepo extends CommitRepository {
	readonly calls: string[];
	base: string | undefined | "throw";
	/** The checked-out branch, `undefined` for a detached HEAD. */
	branch: string | undefined;
}

/** A repository that answers nothing. */
function inert(root: string): CommitRepository {
	return { root, getCommit: async () => { throw new Error("unused"); }, getMergeBase: async () => undefined, currentBranch: () => undefined };
}

/** A repository whose commits are `commits` (full hashes): a hex resolves when exactly one starts with it; `refs` are branch names that resolve to a commit whatever they look like. */
function repo(root: string, commits: readonly string[], refs: Record<string, string> = {}): FakeRepo {
	const state: FakeRepo = {
		root,
		calls: [],
		base: undefined,
		branch: "main",
		async getCommit(ref) {
			state.calls.push(ref);
			if (refs[ref] !== undefined) return { hash: refs[ref]! };
			const matches = commits.filter(hash => hash.startsWith(ref));
			if (matches.length !== 1) throw new Error(matches.length === 0 ? "unknown revision" : "ambiguous argument");
			return { hash: matches[0]!.toUpperCase() };
		},
		currentBranch: () => state.branch,
		async getMergeBase() {
			if (state.base === "throw") throw new Error("no merge base");
			return state.base;
		},
	};
	return state;
}

function resolverOf(repos: readonly CommitRepository[], options: ConstructorParameters<typeof CommitLinkResolver>[1] = {}): CommitLinkResolver {
	return new CommitLinkResolver({ repositories: async () => repos }, options);
}

test("a hash is a commit when a repository containing the session folder has exactly one commit it abbreviates", async () => {
	const inner = repo("C:\\work\\project", [FULL]);
	const resolver = resolverOf([inner]);
	const hit = await resolver.lookup("C:\\work\\project\\src", "c7398070");
	assert.equal(hit?.hash, FULL, "the hit carries the full lower-case hash");
	assert.equal(hit?.repo, inner);
	assert.equal(await resolver.lookup("C:\\work\\project", "c7398071"), null, "no such commit");
});

test("an ambiguous short hash, a branch named like a hash and a repository that fails are not commits", async () => {
	const ambiguous = repo("C:\\work\\a", ["c7398070" + "1".repeat(32), "c7398070" + "2".repeat(32)]);
	assert.equal(await resolverOf([ambiguous]).lookup("C:\\work\\a", "c7398070"), null, "git refuses an ambiguous abbreviation");
	assert.ok((await resolverOf([ambiguous]).lookup("C:\\work\\a", "c73980701")) !== null, "a longer prefix is unique");
	const shadowed = repo("C:\\work\\b", [FULL], { c7398070: OTHER });
	assert.equal(await resolverOf([shadowed]).lookup("C:\\work\\b", "c7398070"), null, "a ref that resolves elsewhere is not the commit the hex abbreviates");
	const broken: CommitRepository = { ...inert("C:\\work\\c"), getCommit: async () => { throw new Error("git failed"); } };
	assert.equal(await resolverOf([broken]).lookup("C:\\work\\c", "c7398070"), null);
});

test("only repositories that contain the session folder are asked, the deepest first, and a commit of another repository is none", async () => {
	const outer = repo("C:\\work", [OTHER]);
	const inner = repo("C:\\work\\sub", [FULL]);
	const sibling = repo("C:\\other", [FULL]);
	const inside = repo("C:\\work\\sub\\nested", ["abcdef0" + "3".repeat(33)]);
	assert.deepEqual(repositoriesContaining([outer, sibling, inner, inside], "C:\\work\\sub\\src").map(found => found.root), ["C:\\work\\sub", "C:\\work"]);
	const resolver = resolverOf([outer, sibling, inner, inside]);
	assert.equal((await resolver.lookup("C:\\work\\sub\\src", "c7398070"))?.repo, inner);
	assert.equal((await resolver.lookup("C:\\work\\sub\\src", "1111111"))?.repo, outer, "an enclosing repository answers what the deeper one does not have");
	assert.equal(await resolver.lookup("C:\\work\\sub\\src", "abcdef0"), null, "a repository below the folder is not the session's");
	assert.deepEqual(sibling.calls, [], "an unrelated repository is never asked");
	assert.equal(repositoriesContaining([repo("c:\\work", [])], "C:\\WORK\\x").length, 1, "Windows path rules");
	assert.deepEqual(repositoriesContaining([], "C:\\work"), [], "no open repository, no link");
});

test("answers are cached: a commit for a minute, a miss for a few seconds, one lookup per hash", async () => {
	let now = 1_000;
	const project = repo("C:\\work", [FULL]);
	const resolver = resolverOf([project], { now: () => now });
	const [first, second] = await Promise.all([resolver.lookup("C:\\work", "c7398070"), resolver.lookup("C:\\work", "c7398070")]);
	assert.equal(first, second);
	assert.equal(project.calls.length, 1, "two spans share one lookup");
	now += 30_000;
	await resolver.lookup("C:\\work", "c7398070");
	assert.equal(project.calls.length, 1, "a found commit is remembered");
	await resolver.lookup("C:\\work", "1234567");
	await resolver.lookup("C:\\work", "1234567");
	assert.equal(project.calls.length, 2, "a miss is remembered");
	now += 4_000;
	await resolver.lookup("C:\\work", "1234567");
	assert.equal(project.calls.length, 3, "a miss is asked again soon: a commit made just now becomes a link");
	resolver.invalidate();
	await resolver.lookup("C:\\work", "c7398070");
	assert.equal(project.calls.length, 4, "opening or closing a repository drops every answer");
});

test("at most two lookups run at once, and a lookup that does not settle in time is no answer and is not remembered", async () => {
	const gates: (() => void)[] = [];
	let running = 0;
	let peak = 0;
	const slow: CommitRepository = {
		root: "C:\\work",
		getCommit: async ref => {
			running++;
			peak = Math.max(peak, running);
			const { promise, resolve } = Promise.withResolvers<void>();
			gates.push(resolve);
			await promise;
			running--;
			return { hash: ref.padEnd(40, "0") };
		},
		getMergeBase: async () => undefined,
		currentBranch: () => "main",
	};
	const resolver = resolverOf([slow]);
	const all = ["1234567", "2345678", "3456789", "4567890"].map(hex => resolver.lookup("C:\\work", hex));
	const tick = () => new Promise(resolve => setImmediate(resolve));
	await tick();
	assert.equal(gates.length, 2, "the other lookups wait for a free slot");
	while (gates.length > 0) { gates.splice(0).forEach(open => open()); await tick(); }
	assert.equal(peak, 2);
	assert.equal((await Promise.all(all)).every(hit => hit !== null), true);

	let hang = true;
	const flaky: CommitRepository = { ...inert("C:\\work"), getCommit: () => hang ? new Promise(() => undefined) : Promise.resolve({ hash: FULL }) };
	const timed = resolverOf([flaky], { timeoutMs: 20 });
	assert.equal(await timed.lookup("C:\\work", "c7398070"), null);
	hang = false;
	assert.equal((await timed.lookup("C:\\work", "c7398070"))?.hash, FULL, "the timeout was not remembered as a miss");
});

interface Registry {
	readonly env: CommitOpenEnv;
	readonly ran: { command: string; args: unknown[] }[];
	/** Commands the window has: registered or contributed. */
	available: Set<string>;
	/** Commands that reject when run. */
	failing: Set<string>;
}

function registry(available: readonly string[]): Registry {
	const state: Registry = {
		ran: [],
		available: new Set(available),
		failing: new Set(),
		env: {
			commandAvailable: async command => state.available.has(command),
			run: async (command, ...args) => {
				state.ran.push({ command, args });
				if (state.failing.has(command)) throw new Error(`${command} failed`);
				return undefined;
			},
			repositoryUri: root => ({ fsPath: root }),
		},
	};
	return state;
}

const GITLENS = [GITLENS_REVEAL_COMMIT, GITLENS_SHOW_COMMITS];

function hitOf(project: FakeRepo): CommitHit {
	return { repo: project, hash: FULL };
}

test("with GitLens, a commit of the current branch is selected in its Commits view of Source Control", async () => {
	const project = repo("C:\\work\\project", [FULL]);
	project.base = FULL.toUpperCase();
	const commands = registry(GITLENS);
	assert.equal(await openCommit(hitOf(project), commands.env), "gitlens-commits-view");
	assert.deepEqual(commands.ran, [
		{ command: SCM_VIEW, args: [] },
		{ command: GITLENS_REVEAL_COMMIT, args: [{ repoPath: "c:/work/project", sha: FULL }] },
	], "Source Control opens first, then the commit is revealed with GitLens' own repository key");
});

test("with GitLens, a commit that is not on the current branch is shown in its Search & Compare view, because the Commits view cannot reveal it", async () => {
	const project = repo("C:\\work\\project", [FULL]);
	project.base = OTHER;
	const commands = registry(GITLENS);
	assert.equal(await openCommit(hitOf(project), commands.env), "gitlens-search-view");
	assert.deepEqual(commands.ran.map(run => run.command), [SCM_VIEW, GITLENS_SHOW_COMMITS]);
	assert.deepEqual(commands.ran[1]?.args, [{ repoPath: "c:/work/project", refs: [FULL] }]);
	for (const base of [undefined, "throw" as const]) {
		project.base = base;
		const again = registry(GITLENS);
		assert.equal(await openCommit(hitOf(project), again.env), "gitlens-search-view", `no usable merge base (${String(base)}) is off the branch`);
	}
});

test("with GitLens and a detached HEAD (also at a tag) even an ancestor of HEAD goes to the Search & Compare view: the Commits view lists a branch and would select nothing", async () => {
	const project = repo("C:\\work\\project", [FULL]);
	project.base = FULL;
	project.branch = undefined;
	const commands = registry(GITLENS);
	assert.equal(await openCommit(hitOf(project), commands.env), "gitlens-search-view");
	assert.deepEqual(commands.ran.map(run => run.command), [SCM_VIEW, GITLENS_SHOW_COMMITS]);
});

test("the wait for a free slot counts toward a lookup's time, and a lookup that timed out while it waited starts no git process", async () => {
	const gates: (() => void)[] = [];
	const started: string[] = [];
	const busy: CommitRepository = {
		...inert("C:\\work"),
		getCommit: async ref => {
			started.push(ref);
			const { promise, resolve } = Promise.withResolvers<void>();
			gates.push(resolve);
			await promise;
			return { hash: ref.padEnd(40, "0") };
		},
	};
	const resolver = resolverOf([busy], { timeoutMs: 30 });
	const held = [resolver.lookup("C:\\work", "1111111"), resolver.lookup("C:\\work", "2222222")];
	const waiting = resolver.lookup("C:\\work", "3333333");
	assert.equal(await waiting, null, "queued behind two slow lookups it gives up on time");
	assert.deepEqual(await Promise.all(held), [null, null], "the two slow ones gave up too");
	gates.splice(0).forEach(open => open());
	await new Promise(resolve => setImmediate(resolve));
	assert.deepEqual(started, ["1111111", "2222222"], "the abandoned lookup never asked git");
});

test("without GitLens, or when GitLens fails, the built-in Git view of the commit opens after Source Control", async () => {
	const project = repo("C:\\work\\project", [FULL]);
	const plain = registry([GIT_VIEW_COMMIT]);
	assert.equal(await openCommit(hitOf(project), plain.env), "git-view-commit");
	assert.deepEqual(plain.ran, [{ command: SCM_VIEW, args: [] }, { command: GIT_VIEW_COMMIT, args: [{ fsPath: "C:\\work\\project" }, FULL] }]);

	project.base = FULL;
	const broken = registry(GITLENS);
	broken.failing.add(GITLENS_REVEAL_COMMIT);
	assert.equal(await openCommit(hitOf(project), broken.env), "git-view-commit");
	assert.deepEqual(broken.ran.map(run => run.command), [SCM_VIEW, GITLENS_REVEAL_COMMIT, GIT_VIEW_COMMIT]);

	const noScm = registry([GIT_VIEW_COMMIT]);
	noScm.failing.add(SCM_VIEW);
	assert.equal(await openCommit(hitOf(project), noScm.env), "git-view-commit", "a view that will not open does not stop the commit");

	const nothing = registry([GIT_VIEW_COMMIT]);
	nothing.failing.add(GIT_VIEW_COMMIT);
	await assert.rejects(openCommit(hitOf(project), nothing.env), /git\.viewCommit failed/);
});

test("GitLens keys a repository by its folder with forward slashes, no trailing separator and a lower-case drive", () => {
	assert.equal(gitLensRepoPath("C:\\Work\\Project"), "c:/Work/Project");
	assert.equal(gitLensRepoPath("D:\\x\\"), "d:/x");
	assert.equal(gitLensRepoPath("/home/me/project/"), "/home/me/project");
});

interface Exchange {
	readonly host: CommitLinkHost;
	readonly replies: TerminalLinkValidation[];
	readonly warnings: string[];
	current: boolean;
}

function exchange(cwd = "C:\\work\\project"): Exchange {
	const state: Exchange = {
		replies: [],
		warnings: [],
		current: true,
		host: { cwd, isCurrent: () => state.current, reply: message => { state.replies.push(message); }, warn: message => { state.warnings.push(message); } },
	};
	return state;
}

function request(type: TerminalLinkRequest["type"], target: string, requestId = 7): TerminalLinkRequest {
	return { type, requestId, target };
}

test("validation answers whether the commit exists; a click shows it; a missing commit warns and shows nothing", async () => {
	const project = repo("C:\\work\\project", [FULL]);
	const resolver = resolverOf([project]);
	const commands = registry([GIT_VIEW_COMMIT]);
	const talk = exchange();
	await handleCommitLink(request("omp:terminal-link-validate", "commit://c7398070"), resolver, commands.env, talk.host);
	await handleCommitLink(request("omp:terminal-link-validate", "commit://1234567", 8), resolver, commands.env, talk.host);
	assert.deepEqual(talk.replies, [
		{ type: "omp:terminal-link-validation", requestId: 7, valid: true },
		{ type: "omp:terminal-link-validation", requestId: 8, valid: false },
	]);
	assert.equal(commands.ran.length, 0, "validation alone opens nothing");

	await handleCommitLink(request("omp:terminal-link-open", "commit://c7398070"), resolver, commands.env, talk.host);
	assert.deepEqual(commands.ran.map(run => run.command), [SCM_VIEW, GIT_VIEW_COMMIT]);
	assert.deepEqual(talk.warnings, []);

	const none = registry([GIT_VIEW_COMMIT]);
	await handleCommitLink(request("omp:terminal-link-open", "commit://1234567"), resolver, none.env, talk.host);
	assert.deepEqual(none.ran, []);
	assert.match(talk.warnings[0] ?? "", /no commit with that hash/);

	const failing = registry([GIT_VIEW_COMMIT]);
	failing.failing.add(GIT_VIEW_COMMIT);
	await handleCommitLink(request("omp:terminal-link-open", "commit://c7398070"), resolver, failing.env, talk.host);
	assert.match(talk.warnings[1] ?? "", /git\.viewCommit failed/);
});

test("a request of a replaced document is dropped, and a target that is not a canonical commit link is never looked up", async () => {
	const project = repo("C:\\work\\project", [FULL]);
	const resolver = resolverOf([project]);
	const commands = registry([GIT_VIEW_COMMIT]);
	const stale = exchange();
	stale.current = false;
	await handleCommitLink(request("omp:terminal-link-validate", "commit://c7398070"), resolver, commands.env, stale.host);
	await handleCommitLink(request("omp:terminal-link-open", "commit://c7398070"), resolver, commands.env, stale.host);
	assert.deepEqual([stale.replies, stale.warnings, commands.ran], [[], [], []]);
	const live = exchange();
	for (const target of ["commit://C7398070", "commit://abc", "c7398070", "commit://../x", "commit://c7398070/../x"]) {
		await handleCommitLink(request("omp:terminal-link-open", target), resolver, commands.env, live.host);
	}
	assert.deepEqual([live.replies, live.warnings, commands.ran], [[], [], []]);
	assert.deepEqual(project.calls, ["c7398070"], "only the stale request's own lookup ran: no malformed target reached the Git extension");
});
