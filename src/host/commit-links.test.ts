/**
 * Commit hashes of a reply, proved against a fake Git API: which repository answers, ambiguity and look-alike refs, the cache, and
 * what a validation and a click do for a commit that exists, one that does not and a repository that cannot show it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { CommitLinkResolver, handleCommitLink, repositoriesContaining } from "./commit-links.ts";
import type { CommitLinkHost, CommitRepository } from "./commit-links.ts";
import type { TerminalLinkRequest, TerminalLinkValidation } from "../shared/terminal-links.ts";

const FULL = "c7398070aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER = "1111111bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SHORT = FULL.slice(0, 12);

interface FakeRepo extends CommitRepository {
	/** The refs `getCommit` was asked about. */
	readonly calls: string[];
	/** The hashes `viewCommit` was asked to open. */
	readonly viewed: string[];
	/** Every Graph and diff step in the order it ran: `graph` for a HEAD selection, `view <hash>` for a diff. */
	readonly steps: string[];
	/** What `viewCommit` rejects with, when set. */
	failure: unknown;
	/** What `revealHeadInGraph` rejects with, when set. */
	graphFailure: unknown;
	/** The commit HEAD points at now (a click reads it fresh); `undefined` reads as no commit. */
	head: string | undefined;
}

/** A repository that answers nothing. */
function inert(root: string): CommitRepository {
	const unused = async (): Promise<never> => { throw new Error("unused"); };
	return { root, getCommit: unused, viewCommit: unused, headCommit: unused, revealHeadInGraph: unused };
}

/** A repository whose commits are `commits` (full hashes): a hex resolves when exactly one starts with it; `refs` are branch names that resolve to a commit whatever they look like. */
function repo(root: string, commits: readonly string[], refs: Record<string, string> = {}): FakeRepo {
	const state: FakeRepo = {
		root,
		calls: [],
		viewed: [],
		steps: [],
		failure: undefined,
		graphFailure: undefined,
		head: undefined,
		async getCommit(ref) {
			state.calls.push(ref);
			if (refs[ref] !== undefined) return { hash: refs[ref]! };
			const matches = commits.filter(hash => hash.startsWith(ref));
			if (matches.length !== 1) throw new Error(matches.length === 0 ? "unknown revision" : "ambiguous argument");
			return { hash: matches[0]!.toUpperCase() };
		},
		async viewCommit(hash) {
			if (state.failure !== undefined) throw state.failure;
			state.viewed.push(hash);
			state.steps.push(`view ${hash.slice(0, 7)}`);
		},
		async headCommit() {
			return state.head;
		},
		async revealHeadInGraph() {
			if (state.graphFailure !== undefined) throw state.graphFailure;
			state.steps.push("graph");
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
	now += 30_000;
	await resolver.lookup("C:\\work", "c7398070");
	assert.equal(project.calls.length, 4, "a found commit is asked again after its minute");
});

test("at most two lookups run at once, and a lookup that does not settle in time is no answer and is not remembered", async () => {
	const gates: (() => void)[] = [];
	let running = 0;
	let peak = 0;
	const slow: CommitRepository = {
		...inert("C:\\work"),
		getCommit: async ref => {
			running++;
			peak = Math.max(peak, running);
			const { promise, resolve } = Promise.withResolvers<void>();
			gates.push(resolve);
			await promise;
			running--;
			return { hash: ref.padEnd(40, "0") };
		},
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

interface Exchange {
	readonly host: CommitLinkHost;
	readonly replies: TerminalLinkValidation[];
	readonly warnings: string[];
	/** The log lines, one per click. */
	readonly logged: string[];
	current: boolean;
}

function exchange(cwd = "C:\\work\\project"): Exchange {
	const state: Exchange = {
		replies: [],
		warnings: [],
		logged: [],
		current: true,
		host: { cwd, isCurrent: () => state.current, reply: message => { state.replies.push(message); }, warn: message => { state.warnings.push(message); }, log: message => { state.logged.push(message); } },
	};
	return state;
}

function request(type: TerminalLinkRequest["type"], target: string, requestId = 7): TerminalLinkRequest {
	return { type, requestId, target };
}

test("validation answers true for every commit that exists, HEAD or not, and false for one that does not; it shows nothing", async () => {
	const project = repo("C:\\work\\project", [FULL, OTHER]);
	const resolver = resolverOf([project]);
	const talk = exchange();
	for (const target of ["commit://c7398070", "commit://1111111", "commit://2222222"]) {
		await handleCommitLink(request("omp:terminal-link-validate", target), resolver, talk.host);
	}
	assert.deepEqual(talk.replies.map(reply => reply.valid), [true, true, false], "both commits that exist are links, the one that does not is text");
	assert.deepEqual(talk.replies.map(reply => reply.requestId), [7, 7, 7]);
	assert.deepEqual([project.viewed, talk.logged, talk.warnings], [[], [], []], "validation alone shows nothing");
});

test("a click on a commit that is not HEAD opens only its changes, by the full hash the lookup found, in the session's repository", async () => {
	const project = repo("C:\\work\\project", [FULL, OTHER]);
	project.head = OTHER;
	const outer = repo("C:\\work", [FULL]);
	outer.head = FULL;
	const resolver = resolverOf([outer, project]);
	const talk = exchange();
	await handleCommitLink(request("omp:terminal-link-open", "commit://c7398070"), resolver, talk.host);
	assert.deepEqual(project.viewed, [FULL], "the page's abbreviation is never passed on: the full lower-case hash is");
	assert.deepEqual(project.steps, ["view c739807"], "no Graph step for a commit that is not HEAD");
	assert.deepEqual([outer.viewed, outer.steps], [[], []], "the deepest repository that has the commit is the one that shows it, and the outer one's HEAD is not its business");
	assert.deepEqual(talk.logged, [`commit link ${SHORT}: view commit`]);
	assert.deepEqual([talk.warnings, talk.replies], [[], []]);
});

test("a click on the HEAD commit selects it in the Graph first and then opens its changes, so the diff editor is last", async () => {
	const project = repo("C:\\work\\project", [FULL, OTHER]);
	project.head = FULL.toUpperCase();
	const talk = exchange();
	await handleCommitLink(request("omp:terminal-link-open", "commit://c7398070"), resolverOf([project]), talk.host);
	assert.deepEqual(project.steps, ["graph", "view c739807"]);
	assert.deepEqual(project.viewed, [FULL]);
	assert.deepEqual(talk.logged, [`commit link ${SHORT}: HEAD, select in graph, view commit`]);
	assert.deepEqual([talk.warnings, talk.replies], [[], []], "a Graph selection is silent");
});

test("HEAD is read at the click: a link remembered while its commit was HEAD does not select once HEAD has moved on, and selects again when HEAD returns", async () => {
	const project = repo("C:\\work\\project", [FULL, OTHER]);
	const resolver = resolverOf([project]);
	const talk = exchange();
	project.head = FULL;
	await handleCommitLink(request("omp:terminal-link-open", "commit://c7398070"), resolver, talk.host);
	project.head = OTHER;
	await handleCommitLink(request("omp:terminal-link-open", "commit://c7398070"), resolver, talk.host);
	project.head = undefined;
	await handleCommitLink(request("omp:terminal-link-open", "commit://c7398070"), resolver, talk.host);
	project.head = FULL;
	await handleCommitLink(request("omp:terminal-link-open", "commit://c7398070"), resolver, talk.host);
	assert.deepEqual(project.steps, ["graph", "view c739807", "view c739807", "view c739807", "graph", "view c739807"]);
	assert.equal(project.calls.length, 1, "the lookup was remembered: only HEAD was asked again");
	assert.deepEqual(talk.warnings, []);
});

test("a Graph that cannot select is logged at info and never stops the diff or shows a notice", async () => {
	const project = repo("C:\\work\\project", [FULL]);
	project.head = FULL;
	project.graphFailure = new Error("2 repositories are open and the Graph may show another one");
	const talk = exchange();
	await handleCommitLink(request("omp:terminal-link-open", "commit://c7398070"), resolverOf([project]), talk.host);
	assert.deepEqual(project.steps, ["view c739807"]);
	assert.deepEqual(talk.logged, [`commit link ${SHORT}: HEAD, select in graph failed: 2 repositories are open and the Graph may show another one, view commit`]);
	assert.deepEqual(talk.warnings, []);
	project.graphFailure = "not an Error";
	await handleCommitLink(request("omp:terminal-link-open", "commit://c7398070"), resolverOf([project]), talk.host);
	assert.equal(talk.logged[1], `commit link ${SHORT}: HEAD, select in graph failed: not an Error, view commit`);
});

test("a HEAD that cannot be read counts as not HEAD: the diff opens and the Graph is left alone", async () => {
	const project = repo("C:\\work\\project", [FULL]);
	project.headCommit = async () => { throw new Error("status failed"); };
	const talk = exchange();
	await handleCommitLink(request("omp:terminal-link-open", "commit://c7398070"), resolverOf([project]), talk.host);
	assert.deepEqual(project.steps, ["view c739807"]);
	assert.deepEqual([talk.logged, talk.warnings], [[`commit link ${SHORT}: view commit`], []]);
});

test("a click on a commit that does not exist warns, shows nothing and logs it", async () => {
	const project = repo("C:\\work\\project", [FULL]);
	const talk = exchange();
	await handleCommitLink(request("omp:terminal-link-open", "commit://2222222"), resolverOf([project]), talk.host);
	assert.deepEqual(project.viewed, []);
	assert.deepEqual(talk.warnings, ["cannot show commit 2222222: this session's repository has no commit with that hash."]);
	assert.deepEqual(talk.logged, ["commit link 2222222: nothing shown, no such commit in this session's repository"]);
});

test("a repository that cannot show the commit gives a notice with its reason and a log line, after the Graph step for HEAD", async () => {
	const project = repo("C:\\work\\project", [FULL]);
	project.failure = new Error("the repository is no longer open in this window");
	const talk = exchange();
	await handleCommitLink(request("omp:terminal-link-open", "commit://c7398070"), resolverOf([project]), talk.host);
	assert.deepEqual(talk.warnings, ["cannot show commit c7398070: the repository is no longer open in this window."]);
	assert.deepEqual(talk.logged, [`commit link ${SHORT}: view commit failed: the repository is no longer open in this window`]);
	project.failure = "not an Error";
	project.head = FULL;
	await handleCommitLink(request("omp:terminal-link-open", "commit://c7398070"), resolverOf([project]), talk.host);
	assert.equal(talk.warnings[1], "cannot show commit c7398070: not an Error.");
	assert.equal(talk.logged[1], `commit link ${SHORT}: HEAD, select in graph, view commit failed: not an Error`);
});

test("a request of a replaced document is dropped, and a target that is not a canonical commit link is never looked up", async () => {
	const project = repo("C:\\work\\project", [FULL]);
	const resolver = resolverOf([project]);
	const stale = exchange();
	stale.current = false;
	await handleCommitLink(request("omp:terminal-link-validate", "commit://c7398070"), resolver, stale.host);
	await handleCommitLink(request("omp:terminal-link-open", "commit://c7398070"), resolver, stale.host);
	assert.deepEqual([stale.replies, stale.warnings, stale.logged, project.viewed], [[], [], [], []]);
	const live = exchange();
	for (const target of ["commit://C7398070", "commit://abc", "c7398070", "commit://../x", "commit://c7398070/../x"]) {
		await handleCommitLink(request("omp:terminal-link-open", target), resolver, live.host);
	}
	assert.deepEqual([live.replies, live.warnings, live.logged, project.viewed], [[], [], [], []]);
	assert.deepEqual(project.calls, ["c7398070"], "only the stale request's own lookup ran: no malformed target reached the Git extension");
});
