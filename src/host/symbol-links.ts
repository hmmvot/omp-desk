import path from "node:path";
import { parseCodeSymbol } from "../webview/code-symbols.ts";
import type { CodeSymbol, SymbolLinkResult, SymbolLinksRequest, SymbolLinksResolution } from "../webview/code-symbols.ts";

/**
 * Where an inline-code symbol of a Chat reply is defined, according to VS Code's workspace symbol providers
 * (`vscode.executeWorkspaceSymbolProvider`). This module is pure: the provider, the clock and the timers are
 * injected, so the matching rules, bounds and cache are tested without VS Code. A symbol is linked only when
 * exactly one definition inside the session's folders matches; every doubt leaves it plain code.
 */

/** `vscode.SymbolKind` values this module distinguishes. */
export const SymbolKind = {
	File: 0, Module: 1, Namespace: 2, Package: 3, Class: 4, Method: 5, Property: 6, Field: 7, Constructor: 8, Enum: 9, Interface: 10,
	Function: 11, Variable: 12, Constant: 13, String: 14, Number: 15, Boolean: 16, Array: 17, Object: 18, Key: 19, Null: 20,
	EnumMember: 21, Struct: 22, Event: 23, Operator: 24, TypeParameter: 25,
} as const;

/** One workspace symbol as a provider reported it; `line` and `column` are one-based. */
export interface SymbolEntry {
	readonly name: string;
	readonly kind: number;
	readonly container: string;
	readonly path: string;
	readonly line: number;
	readonly column: number;
}

/** The provider side: `null` when it threw or did not answer in time. */
export interface SymbolSource {
	/** `text` is what the provider is asked; `last` is the symbol's own name, which an entry must carry. */
	query(text: string, last: string): Promise<SymbolAnswer | null>;
}

/** The part of `vscode.SymbolInformation` this module reads; a provider may leave the location's range out. */
export interface ProviderSymbol {
	readonly name: string;
	readonly kind: number;
	readonly containerName?: string;
	readonly location?: {
		readonly uri?: { readonly scheme: string; readonly fsPath: string };
		readonly range?: { readonly start: { readonly line: number; readonly character: number }; readonly end: { readonly line: number; readonly character: number } };
	};
}

/**
 * A provider's symbol as an entry. Only a `file` location has a path (anything else, a library or metadata
 * document, can never be inside a session folder). A missing range, or an empty range at the very start of the
 * file that a provider substitutes for one it did not resolve, gives no position: the link opens the file only.
 */
export function symbolEntry(symbol: ProviderSymbol): SymbolEntry {
	const range = symbol.location?.range;
	const unresolved = range === undefined || (range.start.line === 0 && range.start.character === 0 && range.end.line === 0 && range.end.character === 0);
	const name = String(symbol.name);
	const container = String(symbol.containerName ?? "");
	// Metadata too long to be matched faithfully is never cut into a different identity: it matches nothing.
	const oversize = name.length > MAX_NAME_LENGTH || container.length > MAX_CONTAINER_LENGTH;
	return {
		name: oversize ? "" : name,
		kind: oversize ? UNMATCHABLE_KIND : symbol.kind,
		container: oversize ? "" : container,
		path: symbol.location?.uri?.scheme === "file" ? symbol.location.uri.fsPath : "",
		line: unresolved || !Number.isSafeInteger(range.start.line) ? 0 : range.start.line + 1,
		column: unresolved || !Number.isSafeInteger(range.start.character) ? 0 : range.start.character + 1,
	};
}
const MAX_NAME_LENGTH = 256;
const MAX_CONTAINER_LENGTH = 512;
/** The kind of an entry whose metadata was too long to match: it never matches, and its presence makes a lookup uncertain. */
const UNMATCHABLE_KIND = -1;

const TYPE_KINDS: Record<number, true> = { [SymbolKind.Class]: true, [SymbolKind.Interface]: true, [SymbolKind.Struct]: true, [SymbolKind.Enum]: true };
/** Kinds a link may point at; files, packages, literals, type parameters and operators never are a symbol the model names. */
const LINKABLE_KINDS: Record<number, true> = {
	...TYPE_KINDS,
	[SymbolKind.Module]: true, [SymbolKind.Namespace]: true, [SymbolKind.Method]: true, [SymbolKind.Property]: true, [SymbolKind.Field]: true,
	[SymbolKind.Constructor]: true, [SymbolKind.Function]: true, [SymbolKind.Variable]: true, [SymbolKind.Constant]: true,
	[SymbolKind.EnumMember]: true, [SymbolKind.Event]: true,
};

/** `text` without parameter lists and generic argument lists: what a provider appends to a declaration's name. */
function bareName(text: string): string {
	let depth = 0;
	let out = "";
	for (const char of text) {
		if (char === "<" || char === "(") depth++;
		else if (char === ">" || char === ")") depth = Math.max(0, depth - 1);
		else if (depth === 0) out += char;
	}
	return out.trim();
}

/** The container's identifiers, outermost first: `Game.Abilities.AbilityData<T>` is `["Game", "Abilities", "AbilityData"]`. */
function containerSegments(container: string): string[] {
	return bareName(container).split(/[.:]+/).map(segment => segment.trim()).filter(segment => segment !== "");
}

export type SymbolMatch =
	| { readonly state: "unique"; readonly entry: SymbolEntry; /** Distinct declaration locations the name matched. */ readonly locations: number; readonly via?: "partial" | "overload" | "cwd" }
	| { readonly state: "ambiguous"; readonly locations: number; readonly symbols: number }
	| { readonly state: "none"; readonly locations: 0 };

/** The number of generic type parameters a provider shows on a declaration's name (`Foo<T, U>` is 2, `Foo` is 0). */
function genericArity(text: string): number {
	const open = text.indexOf("<");
	if (open < 0) return 0;
	let depth = 0;
	let arity = 1;
	for (const char of text.slice(open)) {
		if (char === "<") depth++;
		else if (char === ">") { if (--depth === 0) break; }
		else if (char === "," && depth === 1) arity++;
	}
	return arity;
}

/** Whether a provider's entry could be a declaration named `last` (or its attribute form): cheap pre-filter for the adapter, which must not map unrelated fuzzy results. */
export function isNameCandidate(name: string, last: string): boolean {
	if (name.length > MAX_NAME_LENGTH) return true;
	const bare = bareName(name);
	return bare === last || bare === `${last}Attribute`;
}

/** Which declarations are one symbol: the partial parts of one type, or the overloads of one member. */
function declarationKey(entry: SymbolEntry): string | null {
	const container = containerSegments(entry.container).join(".");
	const name = bareName(entry.name);
	if (entry.kind in TYPE_KINDS) {
		// Parts of a C# partial type share name, arity and container; a global-namespace type has no container, so only `.cs` files may share without one.
		if (container === "" && !entry.path.toLowerCase().endsWith(".cs")) return null;
		return `type\0${container}\0${name}\0${genericArity(entry.name)}`;
	}
	if (container === "") return null;
	const methodLike = entry.kind === SymbolKind.Method || entry.kind === SymbolKind.Constructor || entry.kind === SymbolKind.Function;
	return `${methodLike ? "method" : `kind${entry.kind}`}\0${container}\0${name}`;
}

function byPosition(a: SymbolEntry, b: SymbolEntry): number {
	return (a.line > 0 ? 0 : 1) - (b.line > 0 ? 0 : 1) || a.path.toLowerCase().localeCompare(b.path.toLowerCase()) || a.line - b.line || a.column - b.column;
}

/** The declaration to open for several parts of one symbol: a type's own file (`Game.cs` for `Game`), else the first by path and line. */
function representative(parts: readonly SymbolEntry[]): SymbolEntry {
	const sorted = [...parts].sort(byPosition);
	const own = sorted.find(entry => {
		const file = entry.path.slice(Math.max(entry.path.lastIndexOf("\\"), entry.path.lastIndexOf("/")) + 1);
		return entry.kind in TYPE_KINDS && file.replace(/\.[^.]*$/, "").toLowerCase() === bareName(entry.name).toLowerCase();
	});
	return own ?? sorted[0]!;
}

/**
 * The single definition of `symbol` among `entries`, which are already limited to the session's folders. The last
 * segment must equal the entry's name exactly (case-sensitive; an attribute also matches `NameAttribute` on a type);
 * a dotted name needs its preceding segments to end the entry's container. A bare capitalized name prefers
 * type-like entries and accepts members only when no type matches. Declarations that are one symbol (the partial
 * parts of a type, the overloads of a member in one container) are one definition, opened at the type's own file or
 * the first by path and line. Distinct symbols are ambiguous, unless exactly one of them lies inside `cwd`.
 */
export function matchSymbol(symbol: CodeSymbol, entries: readonly SymbolEntry[], cwd = ""): SymbolMatch {
	const names = symbol.attribute ? [symbol.last, `${symbol.last}Attribute`] : [symbol.last];
	const wanted = symbol.segments.slice(0, -1);
	let matches = entries.filter(entry => {
		if (LINKABLE_KINDS[entry.kind] !== true || !names.includes(bareName(entry.name))) return false;
		if (symbol.attribute && !(entry.kind in TYPE_KINDS)) return false;
		if (wanted.length === 0) return true;
		const container = containerSegments(entry.container);
		return container.length >= wanted.length && wanted.every((segment, index) => container[container.length - wanted.length + index] === segment);
	});
	if (wanted.length === 0 && /^[A-Z]/.test(symbol.last)) {
		const types = matches.filter(entry => entry.kind in TYPE_KINDS);
		if (types.length > 0) matches = types;
	}
	// Distinct declaration locations: one reported twice is one definition, but entries without a position carry no
	// identity (two unresolved overloads in one file are two declarations), so each counts separately.
	const distinct = new Map<string, SymbolEntry>();
	matches.forEach((candidate, index) => {
		const key = candidate.line > 0 ? `${candidate.path.toLowerCase()}\0${candidate.line}\0${candidate.column}` : `${candidate.path.toLowerCase()}\0unresolved\0${index}`;
		if (!distinct.has(key)) distinct.set(key, candidate);
	});
	const locations = [...distinct.values()];
	if (locations.length === 0) return { state: "none", locations: 0 };
	if (locations.length === 1) return { state: "unique", entry: locations[0]!, locations: 1 };
	const groups = new Map<string, SymbolEntry[]>();
	for (const [index, location] of locations.entries()) {
		const key = declarationKey(location) ?? `single\0${index}`;
		const group = groups.get(key);
		if (group === undefined) groups.set(key, [location]); else group.push(location);
	}
	const sameSymbols = [...groups.values()];
	if (sameSymbols.length === 1) return { state: "unique", entry: representative(sameSymbols[0]!), locations: locations.length, via: sameSymbols[0]![0]!.kind in TYPE_KINDS ? "partial" : "overload" };
	const local = cwd === "" ? [] : sameSymbols.filter(group => group.some(entry => isInside(cwd, entry.path)));
	if (local.length === 1) return { state: "unique", entry: representative(local[0]!), locations: locations.length, via: "cwd" };
	return { state: "ambiguous", locations: locations.length, symbols: sameSymbols.length };
}

/** Whether `file` is `root` or inside it (Windows rules: case-insensitive, either separator). */
export function isInside(root: string, file: string): boolean {
	if (root === "" || file === "") return false;
	const relative = path.win32.relative(root, file);
	return relative === "" || (relative !== ".." && !relative.startsWith("..\\") && !path.win32.isAbsolute(relative));
}

/**
 * The folders a symbol's file may be in: the session's working directory, and any open workspace folder that
 * contains it (a session started in a subfolder still links to the rest of its project). No library or metadata location.
 */
export function symbolRoots(cwd: string, workspaceFolders: readonly string[]): string[] {
	if (cwd === "") return [];
	return [cwd, ...workspaceFolders.filter(folder => !isInside(cwd, folder) && isInside(folder, cwd))];
}

/** The link target of `entry` in the grammar the page's open request takes: relative to `cwd` inside it, absolute elsewhere, with line and column when the provider gave a position. */
export function symbolTarget(entry: SymbolEntry, cwd: string): string {
	const shown = isInside(cwd, entry.path) ? path.win32.relative(cwd, entry.path).replaceAll("\\", "/") : entry.path;
	return entry.line > 0 ? `${shown}:${entry.line}:${Math.max(entry.column, 1)}` : shown;
}

export type SymbolOutcome =
	| { readonly status: "found"; readonly target: string }
	| { readonly status: "none" }
	/** Several different definitions inside the session's folders: the page links to the workspace symbol search, never to one of them. */
	| { readonly status: "ambiguous"; readonly definitions: number }
	| { readonly status: "unavailable" }
	/** Not a verdict: the provider is not ready or its queue is full; the token is asked again when the host signals a retry. */
	| { readonly status: "pending" };

export interface SymbolScope {
	/** The session's working directory: relative targets are relative to it, and it names the cache scope. */
	readonly cwd: string;
	readonly roots: readonly string[];
}

export interface SymbolResolverOptions {
	readonly now?: () => number;
	/** One provider query gives up after this long. */
	readonly queryTimeoutMs?: number;
	/** The most provider queries running at once, across every batch. */
	readonly maxConcurrent?: number;
	readonly foundTtlMs?: number;
	readonly noneTtlMs?: number;
	readonly maxCached?: number;
	/** One compact line per finished lookup (the extension's output channel). */
	readonly log?: (line: string) => void;
	/** Called when parked tokens may be asked again: the provider became ready or its queue drained. */
	readonly onRetry?: () => void;
	/** Delays of the not-ready canary probes (the last one repeats). */
	readonly probeDelaysMs?: readonly number[];
}

/** A provider answer; `total` is how many entries the provider returned before the adapter kept the name candidates. */
export interface SymbolAnswer extends ReadonlyArray<SymbolEntry> { total?: number }

type QueryResult = { readonly entries: readonly SymbolEntry[]; readonly total: number } | { readonly failed: "invalidated" | "queue-full" | "error" | "no-answer" | "timeout" };

/** Provider queries that may wait for a slot at once; beyond that a query is refused. A waiting query gives up after the query timeout. */
const MAX_WAITING_QUERIES = 64;
/** Entries of one provider answer that are looked at; an answer with more is a locally truncated list. */
export const MAX_SYMBOL_ENTRIES = 1000;
/** After this long a lookup starts no further provider query. */
const LOOKUP_BUDGET_MS = 15_000;
/** Batches of page questions that may work at once, panel and bridge routes together. */
const MAX_ACTIVE_BATCHES = 8;

const unavailable: SymbolOutcome = { status: "unavailable" };
const none: SymbolOutcome = { status: "none" };
const pending: SymbolOutcome = { status: "pending" };
/** Parked tokens (and canary names) the resolver remembers; the page keeps its own, smaller budget. */
const MAX_PARKED_KEYS = 1024;
const MAX_CANARIES = 8;
/** How long a not-ready provider is probed, and the least time between two "queue drained" signals. */
const PROBE_WINDOW_MS = 10 * 60_000;
const MIN_QUEUE_RETRY_MS = 3000;

/**
 * Resolves symbols against one {@link SymbolSource}. Answers are cached per window by (session folder, canonical
 * name) for a short time and dropped by {@link invalidate} when files change; the same question asked while it is
 * running shares one answer; an answer that was started before an invalidation is returned but not cached.
 * `unavailable` (the provider threw, timed out, or returned no symbol at all, as a language server that is still
 * loading does) is never cached.
 */
export class SymbolLinkResolver {
	readonly #source: SymbolSource;
	readonly #now: () => number;
	readonly #queryTimeoutMs: number;
	readonly #maxConcurrent: number;
	readonly #foundTtlMs: number;
	readonly #noneTtlMs: number;
	readonly #maxCached: number;
	readonly #log: ((line: string) => void) | undefined;
	readonly #onRetry: (() => void) | undefined;
	readonly #probeDelays: readonly number[];
	readonly #cache = new Map<string, { outcome: SymbolOutcome; expires: number }>();
	readonly #pending = new Map<string, Promise<SymbolOutcome>>();
	readonly #waiting: { grant(): void; timer: NodeJS.Timeout }[] = [];
	#running = 0;
	#generation = 0;
	#batches = 0;
	/** False until some provider query answered with a symbol. */
	#ready = false;
	#notReadySince = 0;
	#parkedKeys = new Set<string>();
	#canaries: string[] = [];
	#probeTimer: NodeJS.Timeout | undefined;
	#probeIndex = 0;
	#probeStartedAt = 0;
	#queueRetryDue = false;
	#queueRetryTimer: NodeJS.Timeout | undefined;
	#lastQueueRetry = -MIN_QUEUE_RETRY_MS;

	constructor(source: SymbolSource, options: SymbolResolverOptions = {}) {
		this.#source = source;
		this.#now = options.now ?? Date.now;
		this.#queryTimeoutMs = options.queryTimeoutMs ?? 8000;
		this.#maxConcurrent = options.maxConcurrent ?? 4;
		this.#foundTtlMs = options.foundTtlMs ?? 60_000;
		this.#noneTtlMs = options.noneTtlMs ?? 15_000;
		this.#maxCached = options.maxCached ?? 1024;
		this.#log = options.log;
		this.#onRetry = options.onRetry;
		this.#probeDelays = options.probeDelaysMs ?? [2000, 4000, 8000, 16_000, 30_000];
	}

	/** A batch of the page's questions may start only while fewer than {@link MAX_ACTIVE_BATCHES} are working; pair with {@link leaveBatch}. */
	enterBatch(): boolean {
		if (this.#batches >= MAX_ACTIVE_BATCHES) return false;
		this.#batches++;
		return true;
	}

	leaveBatch(): void { this.#batches--; }

	/** Moves on whenever answers are invalidated; a batch compares it before and after to drop buffered answers. */
	get generation(): number { return this.#generation; }

	/** Forget every answer: a file changed, so any of them may be stale. */
	invalidate(): void {
		this.#generation++;
		this.#cache.clear();
		this.#pending.clear();
	}

	resolve(symbol: CodeSymbol, scope: SymbolScope): Promise<SymbolOutcome> {
		if (scope.roots.length === 0) return Promise.resolve(none);
		const key = `${scope.cwd.toLowerCase()}\0${symbol.attribute ? "[]" : ""}${symbol.name}`;
		const cached = this.#cache.get(key);
		if (cached !== undefined) {
			if (cached.expires > this.#now()) return Promise.resolve(cached.outcome);
			this.#cache.delete(key);
		}
		const shared = this.#pending.get(key);
		if (shared !== undefined) return shared;
		const generation = this.#generation;
		const pending = this.#lookup(symbol, scope, generation).then(outcome => {
			if (generation === this.#generation) {
				this.#pending.delete(key);
				if (outcome.status === "found" || outcome.status === "none" || outcome.status === "ambiguous") {
					if (this.#cache.size >= this.#maxCached) this.#cache.clear();
					this.#cache.set(key, { outcome, expires: this.#now() + (outcome.status === "none" ? this.#noneTtlMs : this.#foundTtlMs) });
				}
			}
			return outcome;
		});
		this.#pending.set(key, pending);
		return pending;
	}

	/**
	 * One lookup: at most two provider queries. No query is dispatched and no answer is returned once
	 * {@link invalidate} has moved the generation on, and the qualified second query is not started when the lookup
	 * has already used its budget. A provider answer longer than {@link MAX_SYMBOL_ENTRIES} is a locally truncated
	 * list: it can still show an ambiguity, but a unique match in it is never trusted (`unavailable`).
	 */
	async #lookup(symbol: CodeSymbol, scope: SymbolScope, generation: number): Promise<SymbolOutcome> {
		const startedAt = this.#now();
		const inScope = (entries: readonly SymbolEntry[]) => entries.filter(entry => scope.roots.some(root => isInside(root, entry.path)));
		let queries = 0;
		let total = 0;
		let entries: readonly SymbolEntry[] = [];
		let locations = 0;
		let via = "";
		const done = (outcome: SymbolOutcome, verdict: string): SymbolOutcome => {
			this.#log?.(`code symbol ${JSON.stringify(symbol.name)}: ${queries} quer${queries === 1 ? "y" : "ies"}, ${total} provider entries, ${inScope(entries).length} in scope, ${locations} matching locations -> ${verdict}${via === "" ? "" : ` (${via})`} in ${this.#now() - startedAt} ms`);
			return outcome;
		};
		const ask = async (text: string): Promise<{ answer: { readonly entries: readonly SymbolEntry[]; readonly total: number } } | { verdict: string; parked: boolean }> => {
			queries++;
			const answer = await this.#query(text, symbol.last, generation);
			if ("failed" in answer) {
				// A full line and a slow provider are not verdicts: the token waits for the queue to drain and is asked again.
				const parked = answer.failed === "queue-full" || answer.failed === "timeout";
				if (parked) this.#queueRetryDue = true;
				return { verdict: parked ? `parked (${answer.failed === "timeout" ? "timeout" : "queue"})` : `unavailable: ${answer.failed}`, parked };
			}
			if (generation !== this.#generation) return { verdict: "unavailable: invalidated", parked: false };
			total += answer.total;
			return { answer };
		};
		const first = await ask(symbol.last);
		if ("verdict" in first) return done(first.parked ? pending : unavailable, first.verdict);
		if (first.answer.total > 0) this.#markReady();
		entries = first.answer.entries.slice(0, MAX_SYMBOL_ENTRIES);
		let truncated = first.answer.entries.length > MAX_SYMBOL_ENTRIES;
		let match = matchSymbol(symbol, inScope(entries), scope.cwd);
		// A provider may understand a qualified query that the bare name's ranked list does not reach.
		if (match.state === "none" && symbol.segments.length > 1) {
			if (this.#now() - startedAt >= LOOKUP_BUDGET_MS) return done(unavailable, "unavailable: lookup budget");
			const second = await ask(symbol.name);
			if ("verdict" in second) return done(second.parked ? pending : unavailable, second.verdict);
			entries = [...entries, ...second.answer.entries.slice(0, MAX_SYMBOL_ENTRIES)];
			truncated ||= second.answer.entries.length > MAX_SYMBOL_ENTRIES;
			match = matchSymbol(symbol, inScope(entries), scope.cwd);
		}
		locations = match.locations;
		if (!this.#ready && total === 0) { this.#park(symbol, scope); return done(pending, "parked (not ready)"); }
		if (total === 0) return done(none, "none");
		// An entry whose name or container was too long to match could be a rival (or the match) that is not seen.
		const unmatchable = inScope(entries).some(candidate => candidate.kind === UNMATCHABLE_KIND);
		if (match.state === "ambiguous") return done({ status: "ambiguous", definitions: match.symbols }, "ambiguous");
		if (unmatchable) return done(unavailable, "unavailable: unmatchable entry");
		if (match.state !== "unique") return done(none, "none");
		if (truncated) return done(unavailable, "unavailable: truncated");
		via = match.via ?? "";
		return done({ status: "found", target: symbolTarget(match.entry, scope.cwd) }, "found");
	}

	/** A provider-call slot: at once when one is free, else after a place in a finite line; `false` when the line is full or the wait outlasts the query timeout. */
	#acquire(): Promise<boolean> {
		if (this.#running < this.#maxConcurrent) { this.#running++; return Promise.resolve(true); }
		if (this.#waiting.length >= MAX_WAITING_QUERIES) return Promise.resolve(false);
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
		if (this.#running === 0 && this.#queueRetryDue) this.#scheduleQueueRetry();
	}

	/** The queue drained after it had refused or timed out some lookups: tell the pages, at most once every few seconds. */
	#scheduleQueueRetry(): void {
		if (this.#queueRetryTimer !== undefined) return;
		const delay = Math.max(0, this.#lastQueueRetry + MIN_QUEUE_RETRY_MS - this.#now());
		this.#queueRetryTimer = setTimeout(() => {
			this.#queueRetryTimer = undefined;
			if (!this.#queueRetryDue || this.#running > 0) return;
			this.#queueRetryDue = false;
			this.#lastQueueRetry = this.#now();
			this.#log?.("code symbols: provider queue drained, asking parked tokens again");
			this.#onRetry?.();
		}, delay);
		this.#queueRetryTimer.unref?.();
	}

	/** The provider has answered at least one query with a symbol: an empty answer now means the name is unknown, not that the server is loading. */
	#markReady(): void {
		if (this.#ready) return;
		this.#ready = true;
		clearTimeout(this.#probeTimer);
		this.#probeTimer = undefined;
		const parked = this.#parkedKeys.size;
		this.#parkedKeys.clear();
		if (parked > 0) {
			this.#log?.(`code symbols: provider ready after ${Math.round((this.#now() - this.#notReadySince) / 1000)} s, re-running ${parked} parked`);
			this.#onRetry?.();
		}
	}

	/** Park a token the provider could not answer yet (its server is loading); a canary probe finds out when it is ready. */
	#park(symbol: CodeSymbol, scope: SymbolScope): void {
		if (this.#parkedKeys.size === 0 && this.#probeTimer === undefined) this.#notReadySince = this.#now();
		if (this.#parkedKeys.size >= MAX_PARKED_KEYS) this.#parkedKeys.clear();
		this.#parkedKeys.add(`${scope.cwd.toLowerCase()}\0${symbol.name}`);
		if (!this.#canaries.includes(symbol.last)) { this.#canaries.push(symbol.last); if (this.#canaries.length > MAX_CANARIES) this.#canaries.shift(); }
		if (this.#probeTimer === undefined) this.#probeStartedAt = this.#probeStartedAt === 0 || this.#now() - this.#probeStartedAt > PROBE_WINDOW_MS ? this.#now() : this.#probeStartedAt;
		this.#scheduleProbe();
	}

	/** One canary query after a growing delay (2 s, doubling to 30 s) for up to ten minutes; any symbol in the answer, exact or fuzzy, means the provider is ready. */
	#scheduleProbe(): void {
		if (this.#ready || this.#probeTimer !== undefined) return;
		if (this.#now() - this.#probeStartedAt > PROBE_WINDOW_MS) return;
		const delay = this.#probeDelays[Math.min(this.#probeIndex, this.#probeDelays.length - 1)]!;
		this.#probeTimer = setTimeout(() => { this.#probeTimer = undefined; void this.#probe(); }, delay);
		this.#probeTimer.unref?.();
	}

	async #probe(): Promise<void> {
		const canary = this.#canaries[this.#probeIndex % Math.max(1, this.#canaries.length)];
		this.#probeIndex++;
		if (this.#ready || canary === undefined) return;
		const generation = this.#generation;
		const answer = await this.#query(canary, canary, generation);
		if (!("failed" in answer) && answer.total > 0) this.#markReady();
		else this.#scheduleProbe();
	}

	/** The workspace's folders changed: the language servers load again, so an empty answer is not a verdict until one answers. */
	resetReadiness(): void {
		this.#ready = false;
		clearTimeout(this.#probeTimer);
		this.#probeTimer = undefined;
		this.#probeIndex = 0;
		this.#probeStartedAt = 0;
		this.#parkedKeys.clear();
	}

	/**
	 * One provider query. A slot is held until the provider's own call settles, not until the timeout: a hung
	 * provider keeps its slot instead of letting invocations pile up. Waiting for a slot has the same logical
	 * deadline as a query and a finite line, so no request state outlives a hung provider, and a query whose
	 * generation was invalidated while it waited is dropped instead of dispatched.
	 */
	async #query(text: string, last: string, generation: number): Promise<QueryResult> {
		if (generation !== this.#generation) return { failed: "invalidated" };
		if (!await this.#acquire()) return { failed: "queue-full" };
		if (generation !== this.#generation) { this.#release(); return { failed: "invalidated" }; }
		const settled: Promise<QueryResult> = Promise.resolve()
			.then(() => this.#source.query(text, last))
			.then((answer): QueryResult => answer === null ? { failed: "no-answer" } : { entries: answer.slice(0, MAX_SYMBOL_ENTRIES + 1), total: (answer as SymbolAnswer).total ?? answer.length }, (): QueryResult => ({ failed: "error" }))
			.finally(() => this.#release());
		let timer: NodeJS.Timeout | undefined;
		const timeout = new Promise<QueryResult>(resolve => { timer = setTimeout(() => resolve({ failed: "timeout" }), this.#queryTimeoutMs); });
		try { return await Promise.race([settled, timeout]); }
		finally { clearTimeout(timer); }
	}
}

export interface SymbolLinksHost {
	/** The session's working directory; empty when the host has none. */
	readonly cwd: string;
	/** The folders a symbol's file may be in. */
	roots(): readonly string[];
	/** The `omp.linkCodeSymbols` setting, read for each request. */
	enabled(): boolean;
	/** Whether the document and session that asked are still current. */
	isCurrent(): boolean;
	reply(message: SymbolLinksResolution): void;
}

/** A batch is answered within this long with what settled; the rest stays `unavailable` while it keeps resolving into the cache. */
const BATCH_DEADLINE_MS = 15_000;

/**
 * Answer one batch of symbol questions from the page. The tokens are normalized again here; each one that is
 * not a symbol is `none`. Nothing returned is trusted by the open path: a click goes through the ordinary link request.
 */
export async function handleSymbolLinks(request: SymbolLinksRequest, host: SymbolLinksHost, resolver: SymbolLinkResolver, deadlineMs = BATCH_DEADLINE_MS): Promise<void> {
	const reply = (results: SymbolLinkResult[], disabled?: true): void => {
		if (host.isCurrent()) host.reply({ type: "omp:terminal-link-symbol-resolution", requestId: request.requestId, ...(disabled === true ? { disabled } : {}), results });
	};
	if (!host.enabled()) return reply(request.tokens.map(token => ({ token, status: "none" })), true);
	// Host-side admission: only so many batches work at once, however many requests the page (or a forged one) sends.
	if (!resolver.enterBatch()) return reply(request.tokens.map(token => ({ token, status: "unavailable" })));
	try {
		const roots = host.roots();
		const generation = resolver.generation;
		const results: SymbolLinkResult[] = request.tokens.map(token => ({ token, status: "unavailable" }));
		const tasks = request.tokens.map(async (token, index) => {
			const symbol = parseCodeSymbol(token);
			const outcome = symbol === null || host.cwd === "" ? none : await resolver.resolve(symbol, { cwd: host.cwd, roots });
			results[index] = outcome.status === "found" ? { token, status: "found", target: outcome.target } : outcome.status === "ambiguous" ? { token, status: "ambiguous", definitions: outcome.definitions } : { token, status: outcome.status };
		});
		let timer: NodeJS.Timeout | undefined;
		const deadline = new Promise<void>(resolve => { timer = setTimeout(resolve, deadlineMs); });
		try { await Promise.race([Promise.all(tasks), deadline]); }
		finally { clearTimeout(timer); }
		// A setting turned off or a folder removed while the provider worked revokes what it found, and a file change
		// since the batch began makes every answer it buffered stale.
		if (!host.enabled()) return reply(request.tokens.map(token => ({ token, status: "none" })), true);
		if (host.roots().join("\n") !== roots.join("\n") || resolver.generation !== generation) return reply(request.tokens.map(token => ({ token, status: "unavailable" })));
		reply(results.map(result => ({ ...result })));
	} finally {
		resolver.leaveBatch();
	}
}
