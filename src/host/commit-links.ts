/**
 * Commit hashes of a Chat reply, proved and shown on the host (`docs/designs/2026-10-17-commit-hash-links.md`). The page names a
 * hash only (`commit://<hex>`, `shared/commit-links.ts`); the host parses it again, looks it up in the repositories that
 * VS Code's Git extension has open and that contain THIS session's folder (the deepest first), and only then answers that the hash is a link.
 * Any commit that exists in the session's repository is a link, HEAD or not. A click opens the commit's changes as a multi-file diff
 * with the Git extension's own command (`git.viewCommit`, run by the wiring on the repository the lookup found, with the full hash it found).
 * A click on a link whose commit no longer exists shows a notice and opens nothing.
 *
 * Nothing here takes a path or a repository from the page, runs a `git` process of its own or executes a command the page names.
 */
import { isInside } from "./link-scope.ts";
import { MAX_COMMIT_HASH_LENGTH, parseCommitLinkTarget } from "../shared/commit-links.ts";
import type { TerminalLinkRequest, TerminalLinkValidation } from "../shared/terminal-links.ts";

/** What the resolver needs of one repository of VS Code's Git extension (its API's `Repository`). */
export interface CommitRepository {
	/** The repository's root folder. */
	readonly root: string;
	/** `git show` of `ref`: rejects when `ref` names nothing, is ambiguous or is not a commit. */
	getCommit(ref: string): Promise<{ readonly hash: string }>;
	/** Open the changes of the commit with this full hash in a multi-file diff editor (the Git extension's `git.viewCommit`); rejects when this window cannot show it. */
	viewCommit(hash: string): Promise<void>;
}

/** A commit that exists: `hash` is its full lower-case hash. */
export interface CommitHit {
	readonly repo: CommitRepository;
	readonly hash: string;
}

export interface CommitLinkSource {
	/** The repositories the Git extension has open, in any order; `[]` when it is disabled or has none. */
	repositories(): Promise<readonly CommitRepository[]>;
}

/** How many repositories one hash is looked up in: the session's folder is in one checkout and rarely in a stack of nested ones. */
const MAX_REPOSITORIES = 4;
const FOUND_TTL_MS = 60_000;
const NONE_TTL_MS = 3_000;
const MAX_CACHED = 512;
/** `git show` calls running at once for this window; the rest wait. */
const MAX_CONCURRENT = 2;
/** A lookup, the wait for a free slot included, that has not settled by now is no answer and is not cached; it ends before the page's own four-second validation deadline, so the page never takes a late reply for a miss. */
const LOOKUP_TIMEOUT_MS = 3_000;

export interface CommitLinkResolverOptions {
	readonly now?: () => number;
	readonly timeoutMs?: number;
}

/** The repositories of `all` that contain `cwd`, deepest first, at most {@link MAX_REPOSITORIES}. */
export function repositoriesContaining(all: readonly CommitRepository[], cwd: string): CommitRepository[] {
	return all.filter(repo => isInside(repo.root, cwd)).sort((a, b) => b.root.length - a.root.length).slice(0, MAX_REPOSITORIES);
}

/**
 * Whether a commit with a given (abbreviated) hash exists in the repositories of a session folder. Answers are cached for a short time
 * (a found commit for a minute, a miss for three seconds, so a commit made just now becomes a link soon), one lookup runs per
 * hash however many spans ask, and a few run at once: each is one `git show` of the Git extension.
 */
export class CommitLinkResolver {
	readonly #source: CommitLinkSource;
	readonly #now: () => number;
	readonly #timeoutMs: number;
	readonly #entries = new Map<string, { value: CommitHit | null; expires: number }>();
	readonly #pending = new Map<string, Promise<CommitHit | null>>();
	readonly #waiting: (() => void)[] = [];
	#active = 0;

	constructor(source: CommitLinkSource, options: CommitLinkResolverOptions = {}) {
		this.#source = source;
		this.#now = options.now ?? Date.now;
		this.#timeoutMs = options.timeoutMs ?? LOOKUP_TIMEOUT_MS;
	}

	/** The commit `hex` (7 to 40 lower-case hex digits) names in a repository that contains `cwd`, or `null`. */
	lookup(cwd: string, hex: string): Promise<CommitHit | null> {
		const key = `${cwd}\n${hex}`;
		const entry = this.#entries.get(key);
		if (entry !== undefined && entry.expires > this.#now()) return Promise.resolve(entry.value);
		let pending = this.#pending.get(key);
		if (pending === undefined) {
			pending = this.#search(cwd, hex).then(({ value, settled }) => {
				this.#pending.delete(key);
				if (settled) {
					if (this.#entries.size >= MAX_CACHED) this.#entries.clear();
					this.#entries.set(key, { value, expires: this.#now() + (value === null ? NONE_TTL_MS : FOUND_TTL_MS) });
				}
				return value;
			});
			this.#pending.set(key, pending);
		}
		return pending;
	}

	/** The whole lookup, the wait for a free slot included, is bounded: the page gives up on a validation after four seconds and would cache the late answer as a miss. */
	async #search(cwd: string, hex: string): Promise<{ value: CommitHit | null; settled: boolean }> {
		if (hex.length > MAX_COMMIT_HASH_LENGTH) return { value: null, settled: true };
		const { promise: timeout, resolve: expire } = Promise.withResolvers<"timeout">();
		const timer = setTimeout(() => expire("timeout"), this.#timeoutMs);
		const turn = { abandoned: false };
		try {
			const found = await Promise.race([this.#inSlot(cwd, hex, turn), timeout]);
			if (found === "timeout") turn.abandoned = true;
			return found === "timeout" ? { value: null, settled: false } : { value: found, settled: true };
		} catch {
			return { value: null, settled: false };
		} finally {
			clearTimeout(timer);
		}
	}

	/** Wait for a free slot, then look; a lookup that timed out while it waited starts no `git show`. */
	async #inSlot(cwd: string, hex: string, turn: { abandoned: boolean }): Promise<CommitHit | null> {
		while (this.#active >= MAX_CONCURRENT) {
			const { promise, resolve } = Promise.withResolvers<void>();
			this.#waiting.push(resolve);
			await promise;
		}
		this.#active++;
		try {
			return turn.abandoned ? null : await this.#find(cwd, hex);
		} finally {
			this.#active--;
			this.#waiting.shift()?.();
		}
	}

	async #find(cwd: string, hex: string): Promise<CommitHit | null> {
		for (const repo of repositoriesContaining(await this.#source.repositories(), cwd)) {
			try {
				const commit = await repo.getCommit(hex);
				const hash = commit.hash.toLowerCase();
				// A branch or tag named like a hash resolves to some other commit: only the commit the hex abbreviates is this link.
				if (hash.startsWith(hex)) return { repo, hash };
			} catch {
				// Unknown, ambiguous or not a commit in this repository: the next one.
			}
		}
		return null;
	}
}

export interface CommitLinkHost {
	/** Whether the document and session that sent the request are still current; checked after the lookup. */
	isCurrent(): boolean;
	reply(message: TerminalLinkValidation): void;
	/** Short user-visible notice, so an activation that cannot complete is never silent. */
	warn(message: string): void;
	/** One line per click, so a click that showed nothing is diagnosable. */
	log(message: string): void;
	/** The session's folder; never the page's word. */
	readonly cwd: string;
}

/**
 * Answer a validation or activation request whose target is `commit://<hex>` (`parseCommitLinkTarget` has already accepted `request.target`).
 * Valid means: the commit exists in the session's repository. A click opens the commit's changes there, by the full hash the lookup found
 * (never the page's text), and shows a notice when the commit is gone or the repository cannot show it.
 */
export async function handleCommitLink(request: TerminalLinkRequest, resolver: CommitLinkResolver, host: CommitLinkHost): Promise<void> {
	const hex = parseCommitLinkTarget(request.target);
	if (hex === null) return;
	const hit = await resolver.lookup(host.cwd, hex);
	if (!host.isCurrent()) return;
	if (request.type === "omp:terminal-link-validate") {
		host.reply({ type: "omp:terminal-link-validation", requestId: request.requestId, valid: hit !== null });
		return;
	}
	if (hit === null) {
		host.log(`commit link ${hex}: nothing shown, no such commit in this session's repository`);
		host.warn(`cannot show commit ${hex}: this session's repository has no commit with that hash.`);
		return;
	}
	const short = hit.hash.slice(0, 12);
	try {
		await hit.repo.viewCommit(hit.hash);
		host.log(`commit link ${short}: view commit`);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		host.log(`commit link ${short}: view commit failed: ${reason}`);
		host.warn(`cannot show commit ${hex}: ${reason}.`);
	}
}
