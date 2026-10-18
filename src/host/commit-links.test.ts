/**
 * Commit hashes of a reply, proved against a fake Git API and shown through a fake command registry: which repository answers,
 * ambiguity and look-alike refs, the cache, and which commands a click runs.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { GRAPH_FOCUS, GRAPH_REVEAL_HEAD, CommitLinkResolver, handleCommitLink, openCommit, repositoriesContaining, whyNotShowable } from "./commit-links.ts";
import type { CommitHit, CommitLinkHost, CommitOpenEnv, CommitRepository } from "./commit-links.ts";
import type { GraphFilter } from "./graph-filter.ts";
import type { TerminalLinkRequest, TerminalLinkValidation } from "../shared/terminal-links.ts";

const FULL = "c7398070aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER = "1111111bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

interface FakeRepo extends CommitRepository {
	readonly calls: string[];
	/** The commit HEAD points at. */
	head: string | undefined;
	/** The Graph's id for the checked-out reference. */
	ref: string | undefined;
	/** What the Graph's filter is set to. */
	filter: GraphFilter;
}

/** A repository that answers nothing. */
function inert(root: string): CommitRepository {
	return { root, getCommit: async () => { throw new Error("unused"); }, headCommit: async () => undefined, headRef: () => undefined, graphFilter: () => ({ kind: "unlimited" }) };
}

/** A repository whose commits are `commits` (full hashes): a hex resolves when exactly one starts with it; `refs` are branch names that resolve to a commit whatever they look like. */
function repo(root: string, commits: readonly string[], refs: Record<string, string> = {}): FakeRepo {
	const state: FakeRepo = {
		root,
		calls: [],
		head: undefined,
		ref: "refs/heads/main",
		filter: { kind: "unlimited" },
		async getCommit(ref) {
			state.calls.push(ref);
			if (refs[ref] !== undefined) return { hash: refs[ref]! };
			const matches = commits.filter(hash => hash.startsWith(ref));
			if (matches.length !== 1) throw new Error(matches.length === 0 ? "unknown revision" : "ambiguous argument");
			return { hash: matches[0]!.toUpperCase() };
		},
		headCommit: async () => state.head,
		headRef: () => state.ref,
		graphFilter: () => state.filter,
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
		headCommit: async () => undefined,
		headRef: () => undefined,
		graphFilter: () => ({ kind: "unlimited" }),
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
	/** The log lines, one per click. */
	readonly logged: string[];
	/** Commands that reject when run. */
	failing: Set<string>;
	/** Whether this VS Code has the Graph's commands. */
	graph: boolean;
}

function registry(): Registry {
	const state: Registry = {
		ran: [],
		logged: [],
		failing: new Set(),
		graph: true,
		env: {
			run: async (command, ...args) => {
				state.ran.push({ command, args });
				if (state.failing.has(command)) throw new Error(`${command} failed`);
				return undefined;
			},
			graphAvailable: async () => state.graph,
			log: message => { state.logged.push(message); },
		},
	};
	return state;
}

function hitOf(project: FakeRepo): CommitHit {
	return { repo: project, hash: FULL };
}

const SHORT = FULL.slice(0, 12);

test("only the commit HEAD points at is showable, whatever the case HEAD reports it in, and only where the Graph is", async () => {
	const project = repo("C:\\work\\project", [FULL]);
	const commands = registry();
	project.head = FULL.toUpperCase();
	assert.equal(await whyNotShowable(hitOf(project), commands.env), null, "HEAD is a link");
	project.head = OTHER;
	assert.deepEqual(await whyNotShowable(hitOf(project), commands.env), { reason: "not-head", head: OTHER }, "any other commit is plain text: the Graph can select HEAD only");
	project.head = undefined;
	assert.deepEqual(await whyNotShowable(hitOf(project), commands.env), { reason: "not-head", head: undefined }, "a branch with no commit has no HEAD commit");
	project.headCommit = async () => { throw new Error("status failed"); };
	assert.deepEqual(await whyNotShowable(hitOf(project), commands.env), { reason: "not-head", head: undefined }, "a HEAD that cannot be read makes no link");
	project.headCommit = async () => FULL;
	commands.graph = false;
	assert.deepEqual(await whyNotShowable(hitOf(project), commands.env), { reason: "no-graph" }, "no Graph, no link");
});

test("a click on the HEAD commit shows the Graph and selects it there, and opens nothing else", async () => {
	const project = repo("C:\\work\\project", [FULL]);
	project.head = FULL;
	const commands = registry();
	assert.equal(await openCommit(hitOf(project), commands.env), null);
	assert.deepEqual(commands.ran, [{ command: GRAPH_FOCUS, args: [] }, { command: GRAPH_REVEAL_HEAD, args: [] }], "no editor, no diff, no command of an extension");
	assert.deepEqual(commands.logged, [`commit link ${SHORT}: HEAD, graph, graph filter unlimited, select in graph`], "one line per click names the steps");
});

test("a click on a commit that is no longer HEAD, or where there is no Graph, runs nothing and says why", async () => {
	const project = repo("C:\\work\\project", [FULL]);
	project.head = OTHER;
	const moved = registry();
	assert.deepEqual(await openCommit(hitOf(project), moved.env), { reason: "not-head", head: OTHER });
	assert.deepEqual(moved.ran, []);
	assert.deepEqual(moved.logged, [`commit link ${SHORT}: nothing shown, not HEAD (HEAD is ${OTHER.slice(0, 12)})`]);
	project.head = FULL;
	const none = registry();
	none.graph = false;
	assert.deepEqual(await openCommit(hitOf(project), none.env), { reason: "no-graph" });
	assert.deepEqual(none.ran, []);
	assert.match(none.logged[0] ?? "", /nothing shown, this VS Code has no Source Control Graph$/);
});

test("a view that will not take the focus does not stop the selection; a selection the Graph refuses rejects the click and is logged", async () => {
	const project = repo("C:\\work\\project", [FULL]);
	project.head = FULL;
	const noFocus = registry();
	noFocus.failing.add(GRAPH_FOCUS);
	assert.equal(await openCommit(hitOf(project), noFocus.env), null);
	assert.deepEqual(noFocus.ran.map(run => run.command), [GRAPH_FOCUS, GRAPH_REVEAL_HEAD]);
	assert.match(noFocus.logged[0] ?? "", /HEAD, graph failed: .*, graph filter unlimited, select in graph$/);
	const noSelect = registry();
	noSelect.failing.add(GRAPH_REVEAL_HEAD);
	await assert.rejects(openCommit(hitOf(project), noSelect.env), /revealCurrentHistoryItem failed/);
	assert.match(noSelect.logged[0] ?? "", /HEAD, graph, graph filter unlimited, select in graph failed: .*revealCurrentHistoryItem failed$/, "a refused click is logged too");
});

test("a click while the Graph's filter hides the current branch shows the Graph, selects nothing and logs the filter; every other filter selects", async () => {
	const project = repo("C:\\work\\project", [FULL]);
	project.head = FULL;
	project.filter = { kind: "refs", refs: ["refs/heads/other"] };
	const hidden = registry();
	assert.deepEqual(await openCommit(hitOf(project), hidden.env), { reason: "filtered", ref: "refs/heads/main" });
	assert.deepEqual(hidden.ran.map(run => run.command), [GRAPH_FOCUS], "the Graph comes into view, with its filter button; the selection action, which would do nothing, is not run");
	assert.deepEqual(hidden.logged, [`commit link ${SHORT}: HEAD, graph, graph filter hides refs/heads/main (filter: refs/heads/other)`]);

	project.filter = { kind: "refs", refs: [] };
	const empty = registry();
	assert.deepEqual(await openCommit(hitOf(project), empty.env), { reason: "filtered", ref: "refs/heads/main" }, "a filter of no reference hides it too");
	assert.match(empty.logged[0] ?? "", /\(filter: no reference\)$/);

	project.ref = FULL;
	project.filter = { kind: "refs", refs: ["refs/heads/main"] };
	assert.deepEqual(await openCommit(hitOf(project), registry().env), { reason: "filtered", ref: FULL }, "a detached HEAD is a commit the filter does not list");

	project.ref = "refs/heads/main";
	for (const [filter, logged] of [
		[{ kind: "refs", refs: ["refs/heads/other", "refs/heads/main"] }, "graph filter includes HEAD"],
		[{ kind: "unlimited" }, "graph filter unlimited"],
		[{ kind: "unreadable", why: "database is locked" }, "graph filter unreadable: database is locked"],
	] as const) {
		project.filter = filter;
		const shown = registry();
		assert.equal(await openCommit(hitOf(project), shown.env), null, logged);
		assert.deepEqual(shown.ran.map(run => run.command), [GRAPH_FOCUS, GRAPH_REVEAL_HEAD]);
		assert.deepEqual(shown.logged, [`commit link ${SHORT}: HEAD, graph, ${logged}, select in graph`]);
	}

	project.ref = undefined;
	project.filter = { kind: "refs", refs: ["refs/heads/other"] };
	assert.equal(await openCommit(hitOf(project), registry().env), null, "a HEAD with no reference is not hidden by any filter");
});

test("a click the Graph's filter hides warns how to fix it, keeps the link and does not ask the page to re-validate", async () => {
	const project = repo("C:\\work\\project", [FULL]);
	project.head = FULL;
	project.filter = { kind: "refs", refs: ["refs/heads/other"] };
	const resolver = resolverOf([project]);
	const talk = exchange();
	const commands = registry();
	await handleCommitLink(request("omp:terminal-link-open", "commit://c7398070"), resolver, commands.env, talk.host);
	assert.deepEqual(talk.warnings, [`commit c7398070 is not selected: the Source Control Graph's filter hides the current branch (main). In the Graph, choose "Auto" or include main in its filter.`]);
	assert.deepEqual([talk.revalidations, talk.replies], [0, []], "the commit is still HEAD: the link stays");
	project.ref = FULL;
	await handleCommitLink(request("omp:terminal-link-open", "commit://c7398070"), resolver, registry().env, talk.host);
	assert.match(talk.warnings[1] ?? "", /hides the current commit \(c7398070aaaa\)\. In the Graph, choose "Auto" or include it in its filter\.$/);
	talk.warnings.length = 0;
	project.ref = "refs/tags/v1";
	await handleCommitLink(request("omp:terminal-link-open", "commit://c7398070"), resolver, registry().env, talk.host);
	assert.match(talk.warnings[0] ?? "", /hides the current tag \(v1\)\. In the Graph, choose "Auto" or include v1 in its filter\.$/);
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
	revalidations: number;
	current: boolean;
}

function exchange(cwd = "C:\\work\\project"): Exchange {
	const state: Exchange = {
		replies: [],
		warnings: [],
		revalidations: 0,
		current: true,
		host: { cwd, isCurrent: () => state.current, reply: message => { state.replies.push(message); }, warn: message => { state.warnings.push(message); }, revalidate: () => { state.revalidations++; } },
	};
	return state;
}

function request(type: TerminalLinkRequest["type"], target: string, requestId = 7): TerminalLinkRequest {
	return { type, requestId, target };
}

const validity = (talk: Exchange): boolean[] => talk.replies.map(reply => reply.valid);

test("validation answers true only for the commit HEAD points at; a HEAD move flips the old and the new commit", async () => {
	const project = repo("C:\\work\\project", [FULL, OTHER]);
	const resolver = resolverOf([project]);
	const commands = registry();
	const talk = exchange();
	const ask = async (target: string): Promise<void> => handleCommitLink(request("omp:terminal-link-validate", target), resolver, commands.env, talk.host);
	project.head = FULL;
	await ask("commit://c7398070");
	await ask("commit://1111111");
	await ask("commit://2222222");
	assert.deepEqual(validity(talk), [true, false, false], "HEAD is a link, another commit that exists and a commit that does not are text");
	assert.equal(commands.ran.length, 0, "validation alone runs nothing");

	talk.replies.length = 0;
	project.head = OTHER;
	await ask("commit://c7398070");
	await ask("commit://1111111");
	assert.deepEqual(validity(talk), [false, true], "HEAD moved: the old HEAD is text again and the new one is a link, with the same resolver and no other signal");

	talk.replies.length = 0;
	commands.graph = false;
	await ask("commit://1111111");
	assert.deepEqual(validity(talk), [false], "without the Graph there are no links");
});

test("a click selects the HEAD commit; a commit that stopped being HEAD or never existed warns, shows nothing and asks the page to re-validate", async () => {
	const project = repo("C:\\work\\project", [FULL, OTHER]);
	project.head = FULL;
	const resolver = resolverOf([project]);
	const commands = registry();
	const talk = exchange();
	await handleCommitLink(request("omp:terminal-link-open", "commit://c7398070"), resolver, commands.env, talk.host);
	assert.deepEqual(commands.ran.map(run => run.command), [GRAPH_FOCUS, GRAPH_REVEAL_HEAD]);
	assert.deepEqual([talk.warnings, talk.revalidations], [[], 0]);

	project.head = OTHER;
	const stale = registry();
	await handleCommitLink(request("omp:terminal-link-open", "commit://c7398070"), resolver, stale.env, talk.host);
	assert.deepEqual(stale.ran, [], "the link was drawn for the old HEAD: nothing is shown");
	assert.match(talk.warnings[0] ?? "", /no longer the current commit/);
	assert.equal(talk.revalidations, 1, "the page is told to ask again, which makes the span plain");

	const none = registry();
	await handleCommitLink(request("omp:terminal-link-open", "commit://2222222"), resolver, none.env, talk.host);
	assert.deepEqual(none.ran, []);
	assert.match(talk.warnings[1] ?? "", /no commit with that hash/);
	assert.equal(talk.revalidations, 2);

	project.head = FULL;
	const failing = registry();
	failing.failing.add(GRAPH_REVEAL_HEAD);
	await handleCommitLink(request("omp:terminal-link-open", "commit://c7398070"), resolver, failing.env, talk.host);
	assert.match(talk.warnings[2] ?? "", /revealCurrentHistoryItem failed/);
	const noGraph = registry();
	noGraph.graph = false;
	await handleCommitLink(request("omp:terminal-link-open", "commit://c7398070"), resolver, noGraph.env, talk.host);
	assert.match(talk.warnings[3] ?? "", /no Source Control Graph/);
});

test("a request of a replaced document is dropped, and a target that is not a canonical commit link is never looked up", async () => {
	const project = repo("C:\\work\\project", [FULL]);
	project.head = FULL;
	const resolver = resolverOf([project]);
	const commands = registry();
	const stale = exchange();
	stale.current = false;
	await handleCommitLink(request("omp:terminal-link-validate", "commit://c7398070"), resolver, commands.env, stale.host);
	await handleCommitLink(request("omp:terminal-link-open", "commit://c7398070"), resolver, commands.env, stale.host);
	assert.deepEqual([stale.replies, stale.warnings, commands.ran, stale.revalidations], [[], [], [], 0]);
	const live = exchange();
	for (const target of ["commit://C7398070", "commit://abc", "c7398070", "commit://../x", "commit://c7398070/../x"]) {
		await handleCommitLink(request("omp:terminal-link-open", target), resolver, commands.env, live.host);
	}
	assert.deepEqual([live.replies, live.warnings, commands.ran], [[], [], []]);
	assert.deepEqual(project.calls, ["c7398070"], "only the stale request's own lookup ran: no malformed target reached the Git extension");
});
