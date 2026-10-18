import { stat } from "node:fs/promises";
import path from "node:path";
import { fileReference } from "../shared/code-symbols.ts";
import type { BareFileName } from "../shared/code-symbols.ts";
import { silentLogger, type Logger } from "../shared/logger.ts";
import { GiveUpReporter, giveUpReason } from "./link-give-up.ts";
import { isInside } from "./link-scope.ts";
import type { FileLookup, FileNameLinks, SymbolOutcome, SymbolScope } from "./link-scope.ts";

/**
 * Where a bare file name of a Chat reply (`session-index.ts:849`), or the trailing part of a path (`host/session-index.ts:579`),
 * is, according to VS Code's file search (docs/designs/2026-10-10-code-symbol-links.md, "Bare file names"). Pure: the search,
 * the clock and the timers are injected, so the rules, bounds and cache are tested without VS Code. Windows rules throughout,
 * like the symbol links: file names compare case-insensitively and either separator is a separator.
 */

/**
 * The search side: the paths of every file whose name is `name` (compared case-insensitively) below `folders`, or
 * `null` when it failed. `name` may carry the directories that end the path (`host/session-index.ts`): then only files whose path ends that way are wanted.
 * `truncated` is true when a folder's search stopped at its result limit, so more files may
 * exist. `signal` aborts when the search outlasts its time budget; an aborted search should settle.
 */
export interface FileNameSource {
	find(name: string, folders: readonly string[], signal: AbortSignal): Promise<{ readonly paths: readonly string[]; readonly truncated: boolean } | null>;
}

export interface FileNameResolverOptions {
	readonly now?: () => number;
	/** One search gives up after this long. */
	readonly queryTimeoutMs?: number;
	/** The most searches running at once, across every batch. */
	readonly maxConcurrent?: number;
	/** Searches that may wait for a slot at once; beyond that a lookup is refused. */
	readonly maxWaiting?: number;
	readonly foundTtlMs?: number;
	readonly noneTtlMs?: number;
	/** How long a search that failed or timed out is remembered as `unavailable`, so retries do not search again. */
	readonly failedTtlMs?: number;
	readonly maxCached?: number;
	/** Whether `file` is an existing file (the cwd check); defaults to `stat`. */
	readonly isFile?: (file: string) => Promise<boolean>;
	/** One compact line per finished lookup (the extension's output channel). */
	readonly log?: Logger;
	/** Called when the search line has emptied after it refused lookups: they were answered `unavailable` with `waiting` and are to be asked again. */
	readonly onDrained?: () => void;
}

/** Results of one folder a search keeps; an answer that reaches it is still several files. */
export const MAX_FILE_NAME_RESULTS = 100;

const unavailable: FileLookup = { state: "unavailable" };
const none: FileLookup = { state: "none" };

async function statIsFile(file: string): Promise<boolean> {
	try { return (await stat(file)).isFile(); } catch { return false; }
}

/**
 * `roots` without duplicates (case-insensitive). A root that lies inside another is still searched on its own: the outer
 * root's own `files.exclude` may hide it, as a repository root that hides its Unity project does when that project is
 * opened next to it as a second workspace folder, and the outer search alone would then never find the project's files.
 * A file both searches find is one match.
 */
export function distinctRoots(roots: readonly string[]): string[] {
	const unique = new Map<string, string>();
	for (const root of roots) if (root !== "" && !unique.has(root.toLowerCase())) unique.set(root.toLowerCase(), root);
	return [...unique.values()];
}

/**
 * Finds the file(s) a name stands for, or the files whose path ends with a partial path (`host/session-index.ts`): the
 * "reference" of a lookup. Answers are cached per window by (session folder, reference) for a short time and dropped by
 * {@link invalidate} when files appear, vanish or move; the same question asked while it runs shares one search. A search
 * that was running when an invalidation came is not thrown away (the files of a busy repository change all the time, and
 * an answer that is always discarded is never delivered): each file it found is checked to still exist and the answer is
 * returned without being cached; with nothing left to prove it is `unavailable`.
 */
export class FileNameLinkResolver implements FileNameLinks {
	readonly #source: FileNameSource;
	readonly #now: () => number;
	readonly #queryTimeoutMs: number;
	readonly #maxConcurrent: number;
	readonly #maxWaiting: number;
	readonly #foundTtlMs: number;
	readonly #noneTtlMs: number;
	readonly #failedTtlMs: number;
	readonly #maxCached: number;
	readonly #isFile: (file: string) => Promise<boolean>;
	readonly #log: Logger;
	readonly #giveUps: GiveUpReporter;
	readonly #cache = new Map<string, { lookup: FileLookup; expires: number }>();
	readonly #pending = new Map<string, Promise<FileLookup>>();
	readonly #waiting: { grant(): void; timer: NodeJS.Timeout }[] = [];
	#running = 0;
	#generation = 0;
	/** A lookup was refused (the line was full or its wait ran out) since the line last drained. */
	#refused = false;
	readonly #onDrained: (() => void) | undefined;

	/** Moves on whenever {@link invalidate} forgets the answers. */
	get generation(): number { return this.#generation; }

	constructor(source: FileNameSource, options: FileNameResolverOptions = {}) {
		this.#source = source;
		this.#now = options.now ?? Date.now;
		this.#queryTimeoutMs = options.queryTimeoutMs ?? 5000;
		this.#maxConcurrent = options.maxConcurrent ?? 2;
		this.#maxWaiting = options.maxWaiting ?? 32;
		this.#foundTtlMs = options.foundTtlMs ?? 60_000;
		this.#noneTtlMs = options.noneTtlMs ?? 15_000;
		this.#failedTtlMs = options.failedTtlMs ?? 30_000;
		this.#maxCached = options.maxCached ?? 512;
		this.#isFile = options.isFile ?? statIsFile;
		this.#log = options.log ?? silentLogger;
		this.#giveUps = new GiveUpReporter(this.#log, this.#now);
		this.#onDrained = options.onDrained;
	}

	/** Forget every answer: a file appeared, vanished or moved, so any of them may be stale. */
	invalidate(): void {
		this.#generation++;
		this.#cache.clear();
		this.#pending.clear();
	}

	/** The link outcome for one span: the lookup of its reference with the span's position. */
	async resolve(file: BareFileName, scope: SymbolScope): Promise<SymbolOutcome> {
		return fileNameOutcome(await this.lookup(fileReference(file), scope), file, scope.cwd);
	}

	/** The files `reference` (a file name, or a name with the directories that end its path, `/`-separated) stands for inside `scope`: the one in the session's folder if there is one, else what the file search finds. */
	lookup(reference: string, scope: SymbolScope): Promise<FileLookup> {
		if (scope.roots.length === 0 || scope.cwd === "") return Promise.resolve(none);
		const key = `${scope.cwd.toLowerCase()}\0${reference.toLowerCase()}`;
		const cached = this.#cache.get(key);
		if (cached !== undefined) {
			if (cached.expires > this.#now()) return Promise.resolve(cached.lookup);
			this.#cache.delete(key);
		}
		const shared = this.#pending.get(key);
		if (shared !== undefined) return shared;
		const pending: Promise<FileLookup> = this.#run(reference, scope).then(({ lookup, ttlMs }) => {
			// An invalidation emptied the map and a newer lookup of the same key may be in it.
			if (this.#pending.get(key) === pending) this.#pending.delete(key);
			if (ttlMs > 0) {
				if (this.#cache.size >= this.#maxCached) this.#cache.clear();
				this.#cache.set(key, { lookup, expires: this.#now() + ttlMs });
			}
			return lookup;
		});
		this.#pending.set(key, pending);
		return pending;
	}

	async #run(reference: string, scope: SymbolScope): Promise<{ lookup: FileLookup; ttlMs: number }> {
		const startedAt = this.#now();
		const startedGeneration = this.#generation;
		const done = (lookup: FileLookup, ttlMs: number, verdict: string, found = 0): { lookup: FileLookup; ttlMs: number } => {
			this.#log.debug(`file name ${JSON.stringify(reference)}: ${found} in scope -> ${verdict} in ${this.#now() - startedAt} ms`);
			if (lookup.state === "unavailable") this.#giveUps.missed("file name", reference, giveUpReason(verdict));
			else this.#giveUps.answered("file name", reference);
			return { lookup, ttlMs };
		};
		const failure = (failed: "invalidated" | "queue-full" | "error" | "timeout") => {
			// A full line is no verdict: the lookup waits to be asked again once the line has drained (`onDrained`) and is neither cached nor a try.
			if (failed === "queue-full") return done({ state: "unavailable", waiting: true }, 0, "parked (queue)");
			// An invalidation is not worth remembering; I/O that timed out or threw is, so retries do not repeat it.
			const remember = failed === "timeout" || failed === "error";
			return done(unavailable, remember ? this.#failedTtlMs : 0, `unavailable: ${failed}`);
		};
		// The session's own folder first: a file of that name there is the answer, whatever else exists. The stat is bounded like the search and proves the file now.
		const own = path.win32.join(scope.cwd, ...reference.split("/"));
		const inCwd = await this.#bounded(() => this.#isFile(own));
		if ("failed" in inCwd) return failure(inCwd.failed);
		if (inCwd.value) return done({ state: "unique", path: own }, this.#generation === startedGeneration ? this.#foundTtlMs : 0, "cwd");
		let searchedGeneration = this.#generation;
		const searched = await this.#bounded(signal => {
			searchedGeneration = this.#generation;
			return this.#source.find(reference, distinctRoots(scope.roots), signal);
		});
		if ("failed" in searched) return failure(searched.failed);
		const answer = searched.value;
		const ending = `\\${reference.replaceAll("/", "\\").toLowerCase()}`;
		const seen = new Map<string, string>();
		for (const candidate of answer.paths) {
			if (!candidate.replaceAll("/", "\\").toLowerCase().endsWith(ending) || !scope.roots.some(root => isInside(root, candidate))) continue;
			if (!seen.has(candidate.toLowerCase())) seen.set(candidate.toLowerCase(), candidate);
		}
		let matches = [...seen.values()].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
		const stale = this.#generation !== searchedGeneration;
		if (stale && matches.length > 0) {
			// Files appeared, vanished or moved while the search ran: what it found is shown only as far as it still exists.
			const proven = await this.#bounded(() => Promise.all(matches.map(async candidate => (await this.#isFile(candidate)) ? candidate : null)));
			if ("failed" in proven) return failure(proven.failed);
			matches = proven.value.filter((candidate): candidate is string => candidate !== null);
		}
		const ttl = (ms: number) => (stale ? 0 : ms);
		// A stale search that proves nothing is no verdict: it cannot say whether a file appeared meanwhile.
		if (matches.length === 0) return stale ? failure("invalidated") : answer.truncated ? done(unavailable, 0, "unavailable: truncated") : done(none, this.#noneTtlMs, "none");
		// A search that stopped at its limit hides files: it never proves a file unique, never narrows to the cwd, and shows only what it has.
		if (answer.truncated) return matches.length < 2 ? done(unavailable, 0, "unavailable: truncated", matches.length) : done({ state: "many", paths: matches }, ttl(this.#foundTtlMs), "several (truncated)", matches.length);
		if (matches.length === 1) return done({ state: "unique", path: matches[0]! }, ttl(this.#foundTtlMs), "found", 1);
		// Several: exactly one inside the session's folder narrows to it, as for symbols.
		const local = matches.filter(candidate => isInside(scope.cwd, candidate));
		if (local.length === 1) return done({ state: "unique", path: local[0]! }, ttl(this.#foundTtlMs), "found (cwd)", matches.length);
		return done({ state: "many", paths: matches }, ttl(this.#foundTtlMs), "several", matches.length);
	}

	/** A search slot: at once when one is free, else after a place in a finite line; `false` when the line is full or the wait outlasts the query timeout. */
	#acquire(): Promise<boolean> {
		if (this.#running < this.#maxConcurrent) { this.#running++; return Promise.resolve(true); }
		if (this.#waiting.length >= this.#maxWaiting) return Promise.resolve(false);
		const { promise, resolve } = Promise.withResolvers<boolean>();
		const waiter = {
			grant: () => { clearTimeout(waiter.timer); resolve(true); },
			timer: setTimeout(() => { this.#waiting.splice(this.#waiting.indexOf(waiter), 1); resolve(false); }, this.#queryTimeoutMs),
		};
		this.#waiting.push(waiter);
		return promise;
	}

	/** The slot goes to the next waiter, or is freed. */
	#release(): void {
		const next = this.#waiting.shift();
		if (next !== undefined) { next.grant(); return; }
		this.#running--;
		// The line is empty again after it had refused some lookups: they wait for this to be asked again.
		if (this.#running === 0 && this.#refused) { this.#refused = false; this.#onDrained?.(); }
	}

	/**
	 * One bounded piece of I/O (the cwd `stat`, the search or the proof of its files) under the window-wide limiter. A slot is held until the
	 * work itself settles, not until the timeout; on the timeout the work's signal aborts so it settles soon. `null` from the work is a failure.
	 */
	async #bounded<T>(work: (signal: AbortSignal) => Promise<T | null>): Promise<{ readonly value: T } | { readonly failed: "queue-full" | "error" | "timeout" }> {
		if (!await this.#acquire()) { this.#refused = true; return { failed: "queue-full" }; }
		const controller = new AbortController();
		const settled = Promise.resolve()
			.then(() => work(controller.signal))
			.then((value): { readonly value: T } | { readonly failed: "error" } => value === null ? { failed: "error" } : { value }, (): { readonly failed: "error" } => ({ failed: "error" }))
			.finally(() => this.#release());
		const { promise: timeout, resolve: expire } = Promise.withResolvers<{ readonly failed: "timeout" }>();
		const timer = setTimeout(() => { controller.abort(); expire({ failed: "timeout" }); }, this.#queryTimeoutMs);
		try { return await Promise.race([settled, timeout]); }
		finally { clearTimeout(timer); }
	}
}

/** The path as a link target: relative to `cwd` inside it, absolute elsewhere, with the span's line (and column) after it. */
export function fileNameTarget(file: string, cwd: string, position: { readonly line?: number; readonly column?: number }): string {
	const shown = isInside(cwd, file) ? path.win32.relative(cwd, file).replaceAll("\\", "/") : file;
	return position.line === undefined ? shown : `${shown}:${position.line}${position.column === undefined ? "" : `:${position.column}`}`;
}

/** The answer for a span: one file is a link to it, several are a choice, none and unavailable stay as they are. */
export function fileNameOutcome(lookup: FileLookup, file: BareFileName, cwd: string): SymbolOutcome {
	switch (lookup.state) {
		case "unique": return { status: "found", target: fileNameTarget(lookup.path, cwd, file) };
		case "many": return { status: "ambiguous", definitions: lookup.paths.length, files: true };
		case "none": return { status: "none" };
		default: return lookup.waiting === true ? { status: "pending" } : { status: "unavailable" };
	}
}

/** A QuickPick row for `file`: its name, and the folder it is in relative to the session's folder (or the folder of the workspace root that holds it). */
export function fileChoiceLabel(file: string, cwd: string, roots: readonly string[]): { readonly label: string; readonly description: string } {
	const directory = path.win32.dirname(file);
	const root = isInside(cwd, file) ? cwd : roots.find(candidate => isInside(candidate, file));
	const relative = root === undefined ? directory : path.win32.relative(root, directory);
	return { label: path.win32.basename(file), description: (relative === "" ? "." : relative).replaceAll("\\", "/") };
}

/** The slice of the VS Code API the file search needs. */
export interface FindFilesApi {
	readonly workspace: {
		findFiles(include: unknown, exclude: string | null, maxResults: number, token: unknown): PromiseLike<readonly { readonly scheme: string; readonly fsPath: string }[]>;
		getConfiguration(section: string, scope?: unknown): { get<T>(key: string): T | undefined };
	};
	readonly RelativePattern: new (base: string, pattern: string) => unknown;
	readonly CancellationTokenSource: new () => { readonly token: unknown; cancel(): void; dispose(): void };
	readonly Uri: { file(path: string): unknown };
}

/** The glob that finds exactly the file `name` at any depth (`name` may end with directories: `host/session-index.ts`), every letter written as both cases (Windows file names do not care). The alphabet of a file reference holds no glob character, and `/` is only a separator. */
export function fileNameGlob(name: string): string {
	let out = "";
	for (const char of name) {
		const lower = char.toLowerCase();
		const upper = char.toUpperCase();
		out += lower !== upper && [...lower].length === 1 && [...upper].length === 1 ? `[${lower}${upper}]` : char;
	}
	return `**/${out}`;
}

/** The patterns the window hides from the Explorer and from search: every `true` entry of `files.exclude` and `search.exclude`, each once, at most 256. */
export function excludePatterns(...settings: readonly unknown[]): string[] {
	const patterns = new Set<string>();
	for (const setting of settings) {
		if (typeof setting !== "object" || setting === null) continue;
		for (const [pattern, value] of Object.entries(setting)) if (value === true && pattern !== "" && !/[\u0000-\u001f]/.test(pattern)) patterns.add(pattern);
	}
	return [...patterns].slice(0, 256);
}

/** The files the window hides from the Explorer and from search, as one glob: every pattern of {@link excludePatterns}. `null` when neither setting hides anything. */
export function excludeGlob(...settings: readonly unknown[]): string | null {
	const all = excludePatterns(...settings);
	return all.length === 0 ? null : all.length === 1 ? all[0]! : `{${all.join(",")}}`;
}

/** `folder`'s own `files.exclude` and `search.exclude` (what the file search honours for that folder), for {@link excludeGlob} and {@link excludePatterns}. */
export function folderExcludeSettings(api: Pick<FindFilesApi, "workspace" | "Uri">, folder: string): [files: unknown, search: unknown] {
	const scope = api.Uri.file(folder);
	return [api.workspace.getConfiguration("files", scope).get("exclude"), api.workspace.getConfiguration("search", scope).get("exclude")];
}

/** The file search through `vscode.workspace.findFiles`: one search per folder, that folder's `files.exclude` and `search.exclude` honoured, a bounded result count, cancelled with the signal. */
export function workspaceFileNameSource(api: FindFilesApi): FileNameSource {
	const excludeOf = (folder: string): string | null => excludeGlob(...folderExcludeSettings(api, folder));
	return {
		async find(name, folders, signal) {
			const source = new api.CancellationTokenSource();
			const cancel = () => source.cancel();
			if (signal.aborted) cancel(); else signal.addEventListener("abort", cancel, { once: true });
			try {
				const found = await Promise.all(folders.map(folder => api.workspace.findFiles(new api.RelativePattern(folder, fileNameGlob(name)), excludeOf(folder), MAX_FILE_NAME_RESULTS, source.token)));
				return { paths: found.flat().filter(uri => uri.scheme === "file").map(uri => uri.fsPath), truncated: found.some(list => list.length >= MAX_FILE_NAME_RESULTS) };
			} finally {
				signal.removeEventListener("abort", cancel);
				source.dispose();
			}
		},
	};
}
