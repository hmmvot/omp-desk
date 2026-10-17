import path from "node:path";
import { isNamespaceSegment, parseBareFileName, parseCodeSymbol } from "../shared/code-symbols.ts";
import type { BareFileName, CodeSymbol, SymbolLinkResult, SymbolLinksRequest, SymbolLinksResolution } from "../shared/code-symbols.ts";
import { silentLogger, type Logger } from "../shared/logger.ts";
import { isInside } from "./link-scope.ts";
import type { FileLookup, FileNameLinks, SymbolOutcome, SymbolScope } from "./link-scope.ts";

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

/** One type of the provider's type hierarchy: what {@link HierarchyType} holds, and the provider's own handle for asking about its supertypes. */
export interface HierarchyNode extends HierarchyType {
	readonly token: unknown;
}

/** The provider's type hierarchy (`vscode.prepareTypeHierarchy` and `vscode.provideSupertypes`); `null` when a call threw or did not answer, an empty list when the provider has no hierarchy for the position. */
export interface TypeHierarchySource {
	/** The type declared at an entry's position. */
	prepare(entry: SymbolEntry): Promise<readonly HierarchyNode[] | null>;
	/** The direct supertypes (base class and interfaces) of a type. */
	supertypes(node: HierarchyNode): Promise<readonly HierarchyNode[] | null>;
}

/** The provider side: `null` when it threw or did not answer in time. */
export interface SymbolSource {
	/** `text` is what the provider is asked; `last` is the symbol's own name, which an entry must carry. */
	query(text: string, last: string): Promise<SymbolAnswer | null>;
	/** Present when the provider can name a type's supertypes: a member the qualifier's type inherits is then found where its base declares it. */
	readonly hierarchy?: TypeHierarchySource;
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

/** The part of `vscode.TypeHierarchyItem` this module reads. */
export interface ProviderHierarchyItem {
	readonly name: string;
	readonly uri: { readonly scheme: string; readonly fsPath: string };
	readonly range: { readonly start: { readonly line: number }; readonly end: { readonly line: number } };
}

/** A provider's hierarchy item as a node: only a `file` location has a path, and the item itself is the handle for asking about its supertypes. */
export function hierarchyNode(item: ProviderHierarchyItem): HierarchyNode {
	return { name: String(item.name), path: item.uri.scheme === "file" ? item.uri.fsPath : "", line: item.range.start.line + 1, endLine: item.range.end.line + 1, token: item };
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

/** The identifiers of a dotted type path, outermost first: `OmpDesk.Sessions.SessionData<T>` is `["OmpDesk", "Sessions", "SessionData"]`. */
function pathSegments(text: string): string[] {
	return bareName(text).split(/[.:]+/).map(segment => segment.trim()).filter(segment => segment !== "");
}

/** `text` split at whitespace outside generic argument lists (`Dictionary<K, V>.Entry` stays one word). */
function topLevelWords(text: string): string[] {
	const words: string[] = [];
	let depth = 0;
	let word = "";
	for (const char of text) {
		if (char === "<") depth++;
		else if (char === ">") depth = Math.max(0, depth - 1);
		if (depth === 0 && /\s/.test(char)) {
			if (word !== "") words.push(word);
			word = "";
		} else word += char;
	}
	if (word !== "") words.push(word);
	return words;
}

/** `text` split at its last parenthesized group, which must end it: `in Foo (project P (net8.0))` is `in Foo` and `project P (net8.0)`. */
function trailingGroup(text: string): { head: string; group: string } | null {
	if (!text.endsWith(")")) return null;
	let depth = 0;
	for (let index = text.length - 1; index >= 0; index--) {
		if (text[index] === ")") depth++;
		else if (text[index] === "(" && --depth === 0) return { head: text.slice(0, index).trim(), group: text.slice(index + 1, -1).trim() };
	}
	return null;
}

/**
 * What a provider's container text says about where a declaration lives. `paths` are the alternatives for the
 * enclosing type path (a qualifier must end one of them); `key` is the identity of the container for grouping
 * overloads and partial parts.
 *
 * Most providers give the enclosing path itself (`OmpDesk.Sessions.SessionData<T>`). The C# language server (Roslyn,
 * behind both the C# and C# Dev Kit extensions) gives a localized display text instead: a member's container is
 * `in SessionIndex (project omp-vscode (net8.0))` (`в SessionIndex (проект omp-vscode (net8.0))` in a Russian window), a nested type of a
 * partial type `in Outer (Outer.cs - omp-vscode (net8.0))`, and a top-level type has only the project or file
 * (`project omp-vscode (net8.0)`, `Store.cs - omp-vscode (net8.0)`), never a namespace. The enclosing type path is the one word
 * of the text before its trailing group that is not the localized "in" (its place differs between languages), so
 * every such word is an alternative; the group, which names the project, stays part of the identity so same-named
 * types of two projects are not one symbol.
 */
function containerInfo(container: string): { paths: string[][]; key: string } {
	const split = trailingGroup(container.trim());
	// A group with a space or a nested group is the project part of a member's container; `(net8.0)` alone is a project's framework.
	if (split !== null && /[\s(]/.test(split.group)) {
		const words = topLevelWords(split.head);
		// A declaration in the global namespace's own scope (a delegate) has only the "in" word: no enclosing type.
		const paths = words.length < 2 ? [] : words.map(pathSegments).filter(segments => segments.length > 0);
		return { paths, key: `${words.map(bareName).join(" ")}\0${split.group}` };
	}
	const segments = pathSegments(container);
	return { paths: [segments], key: segments.join(".") };
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
	const container = containerInfo(entry.container).key;
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

/** The declaration to open for several parts of one symbol: a type's own file (`Desk.cs` for `Desk`), else the first by path and line. */
function representative(parts: readonly SymbolEntry[]): SymbolEntry {
	const sorted = [...parts].sort(byPosition);
	const own = sorted.find(entry => {
		const file = entry.path.slice(Math.max(entry.path.lastIndexOf("\\"), entry.path.lastIndexOf("/")) + 1);
		return entry.kind in TYPE_KINDS && file.replace(/\.[^.]*$/, "").toLowerCase() === bareName(entry.name).toLowerCase();
	});
	return own ?? sorted[0]!;
}

/**
 * The qualifiers a dotted name may stand for. A provider's container names the type (`in SessionData (…)`, `Catalog.Profile`),
 * not the namespaces above it, so after the qualifier as written come the ones with leading namespace-like segments
 * dropped (`OmpDesk.Core.Catalog.Profile.Load` then `Core.Catalog.Profile.Load`, `Catalog.Profile.Load`, `Profile.Load`),
 * always keeping the segment that stands next to the member. A shortened qualifier applies only to a container shorter than the
 * written one: a container that carries the namespaces too (`OmpDesk.Sessions.SessionData`) contradicts a wrong one.
 */
function qualifierVariants(wanted: readonly string[]): string[][] {
	const variants = [[...wanted]];
	for (let dropped = 1; dropped < wanted.length && isNamespaceSegment(wanted[dropped - 1]!); dropped++) variants.push(wanted.slice(dropped));
	return variants;
}

/**
 * The distinct declaration locations of `symbol` among `entries`, which are already limited to the session's folders. The last
 * segment must equal the entry's name exactly (case-sensitive; an attribute also matches `NameAttribute` on a type);
 * a dotted name needs its preceding segments to end the entry's container (the longest qualifier variant that any entry
 * satisfies). A bare capitalized name prefers type-like entries and accepts members only when no type matches
 * (`preferTypes: false` turns that off, for a member looked up on its own).
 */
export function candidateEntries(symbol: CodeSymbol, entries: readonly SymbolEntry[], preferTypes = true): SymbolEntry[] {
	const names = symbol.attribute ? [symbol.last, `${symbol.last}Attribute`] : [symbol.last];
	const wanted = symbol.segments.slice(0, -1);
	const named = entries.filter(entry => LINKABLE_KINDS[entry.kind] === true && names.includes(bareName(entry.name)) && !(symbol.attribute && !(entry.kind in TYPE_KINDS)));
	let matches = named;
	if (wanted.length > 0) {
		for (const variant of qualifierVariants(wanted)) {
			matches = named.filter(entry => containerInfo(entry.container).paths.some(container =>
				container.length >= variant.length && (variant.length === wanted.length || container.length < wanted.length)
				&& variant.every((segment, index) => container[container.length - variant.length + index] === segment)));
			if (matches.length > 0) break;
		}
	} else if (preferTypes && /^[A-Z]/.test(symbol.last)) {
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
	return [...distinct.values()];
}

/**
 * The single definition among `locations` (see {@link candidateEntries}). Declarations that are one symbol (the partial
 * parts of a type, the overloads of a member in one container) are one definition, opened at the type's own file or
 * the first by path and line. Distinct symbols are ambiguous, unless exactly one of them lies inside `cwd`.
 */
export function decideMatch(locations: readonly SymbolEntry[], cwd = ""): SymbolMatch {
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

/** The single definition of `symbol` among `entries`: {@link decideMatch} of its {@link candidateEntries}. */
export function matchSymbol(symbol: CodeSymbol, entries: readonly SymbolEntry[], cwd = ""): SymbolMatch {
	return decideMatch(candidateEntries(symbol, entries), cwd);
}

/** A type of a supertype chain as the provider's type hierarchy reports it; `line` and `endLine` are one-based, `path` is empty for a type that is not in a file (metadata, a library). */
export interface HierarchyType {
	readonly name: string;
	readonly path: string;
	readonly line: number;
	readonly endLine: number;
}

/**
 * The declarations of a member that the nearest supertype level declares. `members` are the entries named like the member
 * (any container) and `levels` the supertype chain of the qualifier's type, nearest level first (direct supertypes, then theirs). A
 * member belongs to a type when its container's innermost name is the type's own (generic arguments aside); when several
 * entries carry that name, the ones inside the type's declaration range win (`Base<T>` against `Base`, the partial part
 * the hierarchy points at). A member declared further up the chain is shadowed by one nearer: an override is found where it is
 * written. A type outside the files has nothing to compare and is skipped.
 */
export function inheritedLocations(members: readonly SymbolEntry[], levels: readonly (readonly HierarchyType[])[]): SymbolEntry[] {
	for (const level of levels) {
		const types = level.filter(type => type.path !== "");
		const holds = (entry: SymbolEntry, type: HierarchyType) => containerInfo(entry.container).paths.some(container => container[container.length - 1] === bareName(type.name));
		const named = members.filter(entry => types.some(type => holds(entry, type)));
		if (named.length === 0) continue;
		const inside = named.filter(entry => types.some(type => holds(entry, type) && entry.path.toLowerCase() === type.path.toLowerCase() && entry.line >= type.line && entry.line <= type.endLine));
		return inside.length > 0 ? inside : named;
	}
	return [];
}

/**
 * The folders a symbol's or file's path may be in: the session's working directory, every open workspace folder that
 * contains it (a session started in a subfolder still links to the rest of its project) and every open workspace
 * folder inside it. An inner folder adds no path to the scope, but it is searched with its own `files.exclude` and
 * `search.exclude`: the session folder's may hide it (a repository root that hides its Unity project, opened as a second
 * workspace folder). No library or metadata location; unrelated folders and the cwd itself (any spelling) are left out.
 */
export function symbolRoots(cwd: string, workspaceFolders: readonly string[]): string[] {
	if (cwd === "") return [];
	return [cwd, ...workspaceFolders.filter(folder => !(isInside(cwd, folder) && isInside(folder, cwd)) && (isInside(folder, cwd) || isInside(cwd, folder)))];
}

/** The link target of `entry` in the grammar the page's open request takes: relative to `cwd` inside it, absolute elsewhere, with line and column when the provider gave a position. */
export function symbolTarget(entry: SymbolEntry, cwd: string): string {
	const shown = isInside(cwd, entry.path) ? path.win32.relative(cwd, entry.path).replaceAll("\\", "/") : entry.path;
	return entry.line > 0 ? `${shown}:${entry.line}:${Math.max(entry.column, 1)}` : shown;
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
	readonly log?: Logger;
	/** Called when parked tokens may be asked again: the provider became ready or its queue drained. */
	readonly onRetry?: () => void;
	/** Delays of the not-ready canary probes (the last one repeats). */
	readonly probeDelaysMs?: readonly number[];
	/** The bare-file-name side: looked up by {@link SymbolLinkResolver.resolveFileName} and dropped with every {@link SymbolLinkResolver.invalidate}. */
	readonly files?: FileNameLinks;
}

/** A provider answer; `total` is how many entries the provider returned before the adapter kept the name candidates. */
export interface SymbolAnswer extends ReadonlyArray<SymbolEntry> { total?: number }

type QueryResult = { readonly entries: readonly SymbolEntry[]; readonly total: number } | { readonly failed: "invalidated" | "queue-full" | "error" | "no-answer" | "timeout" };

/** Why a provider question gave no answer: the outcome the token gets and the line the log shows. */
interface Failure {
	readonly outcome: SymbolOutcome;
	readonly verdict: string;
}

/** What the provider's questions of one lookup were and returned, for the log. */
interface Gathering {
	queries: number;
	total: number;
	entries: readonly SymbolEntry[];
}

type Gathered =
	| { readonly failed: Failure }
	| { readonly locations: readonly SymbolEntry[]; readonly match: SymbolMatch; readonly via: string; readonly truncated: boolean };

/** The answer of {@link SymbolLinkResolver.find}: every matching definition of a qualified name, or why there is none (`pending`: the provider is not ready; `unavailable`: it failed or timed out). */
export type SymbolFind =
	| { readonly state: "matches"; readonly entries: readonly SymbolEntry[]; readonly via: string }
	| { readonly state: "none" | "unavailable" | "pending" };

/** Provider queries that may wait for a slot at once; beyond that a query is refused. A waiting query gives up after the query timeout. */
const MAX_WAITING_QUERIES = 64;
/** Entries of one provider answer that are looked at; an answer with more is a locally truncated list. */
export const MAX_SYMBOL_ENTRIES = 1000;
/** After this long a lookup starts no further provider query. */
const LOOKUP_BUDGET_MS = 15_000;
/** Batches of page questions that may work at once, panel and bridge routes together. */
const MAX_ACTIVE_BATCHES = 8;
/** The supertype levels, provider hierarchy calls and search results one lookup takes at most; a hierarchy beyond that is not walked and the member stays unresolved. */
const MAX_HIERARCHY_DEPTH = 8;
const MAX_HIERARCHY_CALLS = 24;
export const MAX_SEARCH_RESULTS = 100;

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
	readonly #log: Logger;
	readonly #onRetry: (() => void) | undefined;
	readonly #files: FileNameLinks | undefined;
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
		this.#log = options.log ?? silentLogger;
		this.#onRetry = options.onRetry;
		this.#probeDelays = options.probeDelaysMs ?? [2000, 4000, 8000, 16_000, 30_000];
		this.#files = options.files;
	}

	/** A batch of the page's questions may start only while fewer than {@link MAX_ACTIVE_BATCHES} are working; pair with {@link leaveBatch}. */
	enterBatch(): boolean {
		if (this.#batches >= MAX_ACTIVE_BATCHES) return false;
		this.#batches++;
		return true;
	}

	leaveBatch(): void { this.#batches--; }

	/** Moves on whenever answers are invalidated, for any reason; a batch compares it before and after to drop buffered symbol answers. */
	get generation(): number { return this.#generation; }

	/** Moves on only when the set of files may have changed (see {@link invalidate}); the file lookups' own fence. */
	get fileGeneration(): number { return this.#files?.generation ?? 0; }

	/** Forget every answer: a file appeared, vanished or moved, so any of them may be stale. */
	invalidate(): void {
		this.invalidateContent();
		this.#files?.invalidate();
	}

	/**
	 * Forget the symbol answers: some file's contents changed (an edit, a save, a write), which may move a definition but never
	 * changes which files exist, so the file-name answers and the file lookups under way stay valid. A busy repository changes
	 * contents all the time (an agent writing files, a Unity editor importing); discarding file lookups for it left their spans plain.
	 */
	invalidateContent(): void {
		this.#generation++;
		this.#cache.clear();
		this.#pending.clear();
	}

	/** The bare file name a span is: where the file search finds it (`none` when the host has no file search). Fenced by {@link fileGeneration}. */
	resolveFileName(file: BareFileName, scope: SymbolScope): Promise<SymbolOutcome> {
		return this.#files?.resolve(file, scope) ?? Promise.resolve(none);
	}

	/** The files a file reference (a name, or a name with the directories that end its path) stands for, for the click that lets the user choose among several. */
	lookupFileName(reference: string, scope: SymbolScope): Promise<FileLookup> {
		return this.#files?.lookup(reference, scope) ?? Promise.resolve({ state: "none" });
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
	 * One lookup: at most two provider queries for the name, and for a member the qualifier's type does not declare itself
	 * one more for the type plus a few type-hierarchy calls (see {@link #inherited}). No query is dispatched and no answer is
	 * returned once {@link invalidate} has moved the generation on, and the later queries are not started when the lookup
	 * has already used its budget. A provider answer longer than {@link MAX_SYMBOL_ENTRIES} is a locally truncated
	 * list: it can still show an ambiguity, but a unique match in it is never trusted (`unavailable`).
	 */
	async #lookup(symbol: CodeSymbol, scope: SymbolScope, generation: number): Promise<SymbolOutcome> {
		const startedAt = this.#now();
		const stats: Gathering = { queries: 0, total: 0, entries: [] };
		const inScope = (entries: readonly SymbolEntry[]) => entries.filter(entry => scope.roots.some(root => isInside(root, entry.path)));
		const done = (outcome: SymbolOutcome, verdict: string, matching = 0, via = ""): SymbolOutcome => {
			this.#log.debug(`code symbol ${JSON.stringify(symbol.name)}: ${stats.queries} quer${stats.queries === 1 ? "y" : "ies"}, ${stats.total} provider entries, ${inScope(stats.entries).length} in scope, ${matching} matching locations -> ${verdict}${via === "" ? "" : ` (${via})`} in ${this.#now() - startedAt} ms`);
			return outcome;
		};
		const gathered = await this.#gather(symbol, scope, generation, startedAt, stats);
		if ("failed" in gathered) return done(gathered.failed.outcome, gathered.failed.verdict);
		const { match } = gathered;
		if (!this.#ready && stats.total === 0) { this.#park(symbol, scope); return done(pending, "parked (not ready)", match.locations); }
		if (stats.total === 0) return done(none, "none", match.locations);
		// An entry whose name or container was too long to match could be a rival (or the match) that is not seen.
		const unmatchable = inScope(stats.entries).some(candidate => candidate.kind === UNMATCHABLE_KIND);
		if (match.state === "ambiguous") return done({ status: "ambiguous", definitions: match.symbols }, "ambiguous", match.locations, gathered.via);
		if (unmatchable) return done(unavailable, "unavailable: unmatchable entry", match.locations);
		if (match.state !== "unique") return done(none, "none", match.locations);
		if (gathered.truncated) return done(unavailable, "unavailable: truncated", match.locations);
		return done({ status: "found", target: symbolTarget(match.entry, scope.cwd) }, "found", match.locations, gathered.via === "" ? match.via ?? "" : gathered.via);
	}

	/**
	 * Every definition of a qualified selection, for the symbol search (Ctrl+N): the same provider questions and the same matching as a
	 * link, but all the matching locations are returned instead of one verdict, and nothing is cached. `none`, `unavailable` and `pending`
	 * leave the caller to fall back to the provider's own search.
	 */
	async find(symbol: CodeSymbol, scope: SymbolScope): Promise<SymbolFind> {
		if (scope.roots.length === 0) return { state: "none" };
		const generation = this.#generation;
		const startedAt = this.#now();
		const stats: Gathering = { queries: 0, total: 0, entries: [] };
		const gathered = await this.#gather(symbol, scope, generation, startedAt, stats);
		const state = "failed" in gathered ? "failed" : generation !== this.#generation ? "invalidated" : stats.total === 0 ? "no entries" : `${gathered.locations.length} matching`;
		this.#log.debug(`code symbol search ${JSON.stringify(symbol.name)}: ${stats.queries} quer${stats.queries === 1 ? "y" : "ies"}, ${stats.total} provider entries -> ${"failed" in gathered ? gathered.failed.verdict : state} in ${this.#now() - startedAt} ms`);
		if ("failed" in gathered) return { state: gathered.failed.outcome.status === "pending" ? "pending" : "unavailable" };
		if (generation !== this.#generation) return { state: "unavailable" };
		if (stats.total === 0) return { state: this.#ready ? "none" : "pending" };
		if (gathered.locations.length === 0) return { state: "none" };
		return { state: "matches", entries: [...gathered.locations].sort(byPosition).slice(0, MAX_SEARCH_RESULTS), via: gathered.via };
	}

	/** One provider question for `text`; the answer, or why there is none (a full line and a slow provider are not verdicts: the token waits for the queue to drain and is asked again). */
	async #ask(text: string, last: string, generation: number, stats: Gathering): Promise<{ readonly answer: { readonly entries: readonly SymbolEntry[]; readonly total: number } } | { readonly failed: Failure }> {
		stats.queries++;
		const answer = await this.#query(text, last, generation);
		if ("failed" in answer) return { failed: this.#failure(answer.failed) };
		if (generation !== this.#generation) return { failed: { outcome: unavailable, verdict: "unavailable: invalidated" } };
		stats.total += answer.total;
		return { answer };
	}

	/** The verdict for a provider call that did not answer. */
	#failure(failed: "invalidated" | "queue-full" | "error" | "no-answer" | "timeout"): Failure {
		const parked = failed === "queue-full" || failed === "timeout";
		if (parked) this.#queueRetryDue = true;
		return { outcome: parked ? pending : unavailable, verdict: parked ? `parked (${failed === "timeout" ? "timeout" : "queue"})` : `unavailable: ${failed}` };
	}

	/** The provider's questions of one lookup and what they say (see {@link #lookup}). */
	async #gather(symbol: CodeSymbol, scope: SymbolScope, generation: number, startedAt: number, stats: Gathering): Promise<Gathered> {
		const inScope = (entries: readonly SymbolEntry[]) => entries.filter(entry => scope.roots.some(root => isInside(root, entry.path)));
		const first = await this.#ask(symbol.last, symbol.last, generation, stats);
		if ("failed" in first) return first;
		if (first.answer.total > 0) this.#markReady();
		stats.entries = first.answer.entries.slice(0, MAX_SYMBOL_ENTRIES);
		let truncated = first.answer.entries.length > MAX_SYMBOL_ENTRIES;
		let locations = candidateEntries(symbol, inScope(stats.entries));
		let match = decideMatch(locations, scope.cwd);
		// A provider may understand a qualified query that the bare name's ranked list does not reach.
		if (match.state === "none" && symbol.segments.length > 1) {
			if (this.#now() - startedAt >= LOOKUP_BUDGET_MS) return { failed: { outcome: unavailable, verdict: "unavailable: lookup budget" } };
			const second = await this.#ask(symbol.name, symbol.last, generation, stats);
			if ("failed" in second) return second;
			stats.entries = [...stats.entries, ...second.answer.entries.slice(0, MAX_SYMBOL_ENTRIES)];
			truncated ||= second.answer.entries.length > MAX_SYMBOL_ENTRIES;
			locations = candidateEntries(symbol, inScope(stats.entries));
			match = decideMatch(locations, scope.cwd);
		}
		let via = "";
		// The member may be inherited: the provider names its base class as the container.
		if (match.state === "none" && symbol.segments.length > 1 && stats.total > 0 && this.#source.hierarchy !== undefined) {
			const inherited = await this.#inherited(symbol, scope, inScope(stats.entries), generation, startedAt, stats);
			if ("failed" in inherited) return inherited;
			if (inherited.locations.length > 0) {
				locations = [...inherited.locations];
				match = decideMatch(locations, scope.cwd);
				via = "inherited";
			}
		}
		return { locations, match, via, truncated };
	}

	/**
	 * A member the qualifier's type does not declare itself: the type is looked up (a type-like entry, unique inside the scope),
	 * its supertypes are asked of the provider's type hierarchy level by level, and the nearest level that declares the member
	 * decides ({@link inheritedLocations}). A type that is not unique, has no position or no hierarchy gives nothing: there is no
	 * name-only guess. Bounded in depth ({@link MAX_HIERARCHY_DEPTH}), in provider calls ({@link MAX_HIERARCHY_CALLS}) and by
	 * the lookup budget; every call has the slots and timeouts of a symbol query.
	 */
	async #inherited(symbol: CodeSymbol, scope: SymbolScope, members: readonly SymbolEntry[], generation: number, startedAt: number, stats: Gathering): Promise<{ readonly locations: readonly SymbolEntry[] } | { readonly failed: Failure }> {
		const hierarchy = this.#source.hierarchy;
		if (hierarchy === undefined) return { locations: [] };
		const budget = (): { readonly failed: Failure } | null => this.#now() - startedAt >= LOOKUP_BUDGET_MS ? { failed: { outcome: unavailable, verdict: "unavailable: lookup budget" } } : null;
		const over = budget();
		if (over !== null) return over;
		const segments = symbol.segments.slice(0, -1);
		const typeSymbol: CodeSymbol = { segments, name: segments.join("."), last: segments[segments.length - 1]!, attribute: false, call: false };
		const typed = await this.#ask(typeSymbol.last, typeSymbol.last, generation, stats);
		if ("failed" in typed) return typed;
		const types = typed.answer.entries.slice(0, MAX_SYMBOL_ENTRIES).filter(entry => entry.kind in TYPE_KINDS && entry.kind !== SymbolKind.Enum && scope.roots.some(root => isInside(root, entry.path)));
		const origin = decideMatch(candidateEntries(typeSymbol, types), scope.cwd);
		if (origin.state !== "unique" || origin.entry.line === 0) return { locations: [] };
		const levels: HierarchyNode[][] = [];
		const seen = new Set<string>();
		const mark = (node: HierarchyNode): boolean => {
			const key = `${node.path.toLowerCase()}\0${node.line}\0${node.name}`;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		};
		const asked = async <T>(work: () => Promise<T | null>): Promise<{ readonly value: T } | { readonly failed: Failure }> => {
			stats.queries++;
			const result = await this.#bounded(generation, work);
			return "failed" in result ? { failed: this.#failure(result.failed) } : result;
		};
		const prepared = await asked(() => hierarchy.prepare(origin.entry));
		if ("failed" in prepared) return prepared;
		let frontier = prepared.value.slice(0, 1);
		for (const node of frontier) mark(node);
		let calls = 0;
		while (frontier.length > 0 && levels.length < MAX_HIERARCHY_DEPTH) {
			const next: HierarchyNode[] = [];
			for (const node of frontier) {
				const out = calls >= MAX_HIERARCHY_CALLS ? { failed: { outcome: unavailable, verdict: "unavailable: hierarchy too large" } } : budget();
				if (out !== null) return out;
				calls++;
				const supertypes = await asked(() => hierarchy.supertypes(node));
				if ("failed" in supertypes) return supertypes;
				for (const item of supertypes.value) if (mark(item)) next.push(item);
			}
			if (next.length > 0) levels.push(next);
			frontier = next;
		}
		const named = candidateEntries({ segments: [symbol.last], name: symbol.last, last: symbol.last, attribute: false, call: false }, members, false);
		return { locations: inheritedLocations(named, levels) };
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
			this.#log.debug("code symbols: provider queue drained, asking parked tokens again");
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
			this.#log.debug(`code symbols: provider ready after ${Math.round((this.#now() - this.#notReadySince) / 1000)} s, re-running ${parked} parked`);
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

	/** One provider query (see {@link #bounded}). */
	async #query(text: string, last: string, generation: number): Promise<QueryResult> {
		const result = await this.#bounded(generation, () => this.#source.query(text, last));
		if ("failed" in result) return result;
		return { entries: result.value.slice(0, MAX_SYMBOL_ENTRIES + 1), total: result.value.total ?? result.value.length };
	}

	/**
	 * One provider call, a symbol query or a type-hierarchy question. A slot is held until the provider's own call settles, not until the
	 * timeout: a hung provider keeps its slot instead of letting invocations pile up. Waiting for a slot has the same logical
	 * deadline as a query and a finite line, so no request state outlives a hung provider, and a call whose
	 * generation was invalidated while it waited is dropped instead of dispatched. `null` from the provider is no answer.
	 */
	async #bounded<T>(generation: number, work: () => Promise<T | null>): Promise<{ readonly value: T } | { readonly failed: "invalidated" | "queue-full" | "error" | "no-answer" | "timeout" }> {
		if (generation !== this.#generation) return { failed: "invalidated" };
		if (!await this.#acquire()) return { failed: "queue-full" };
		if (generation !== this.#generation) { this.#release(); return { failed: "invalidated" }; }
		const settled = Promise.resolve()
			.then(work)
			.then((value): { readonly value: T } | { readonly failed: "no-answer" } => value === null ? { failed: "no-answer" } : { value }, (): { readonly failed: "error" } => ({ failed: "error" }))
			.finally(() => this.#release());
		let timer: NodeJS.Timeout | undefined;
		const timeout = new Promise<{ readonly failed: "timeout" }>(resolve => { timer = setTimeout(() => resolve({ failed: "timeout" }), this.#queryTimeoutMs); });
		try { return await Promise.race([settled, timeout]); }
		finally { clearTimeout(timer); }
	}
}

export interface SymbolLinksHost {
	/** The session's working directory; empty when the host has none. */
	readonly cwd: string;
	/** The folders a symbol's file may be in. */
	roots(): readonly string[];
	/** The `ompDesk.linkCodeSymbols` setting, read for each request. */
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
		const fileGeneration = resolver.fileGeneration;
		const results: SymbolLinkResult[] = request.tokens.map(token => ({ token, status: "unavailable" }));
		// Whether a result needed a symbol lookup: only those depend on the contents of files, not just on which files exist.
		const symbolBased = request.tokens.map(() => false);
		const tasks = request.tokens.map(async (token, index) => {
			const scope = { cwd: host.cwd, roots };
			// A bare file name is looked up as a file first; a span that is also a symbol (`Twin.run`) is looked up as one only when no file has that name. A file lookup that could not answer stays unanswered.
			const file = parseBareFileName(token);
			let outcome: SymbolOutcome = file === null || host.cwd === "" ? none : await resolver.resolveFileName(file, scope);
			// Files appeared or vanished since the batch began (the file lookup answered for an older state): no symbol lookup is started on top of it.
			if (outcome.status === "none" && resolver.fileGeneration !== fileGeneration) outcome = { status: "unavailable" };
			else if (outcome.status === "none") {
				const symbol = parseCodeSymbol(token);
				symbolBased[index] = symbol !== null;
				outcome = symbol === null || host.cwd === "" ? none : await resolver.resolve(symbol, scope);
			}
			results[index] = outcome.status === "found" ? { token, status: "found", target: outcome.target } : outcome.status === "ambiguous" ? { token, status: "ambiguous", definitions: outcome.definitions, ...(outcome.files === true ? { files: true as const } : {}) } : { token, status: outcome.status };
		});
		let timer: NodeJS.Timeout | undefined;
		const deadline = new Promise<void>(resolve => { timer = setTimeout(resolve, deadlineMs); });
		try { await Promise.race([Promise.all(tasks), deadline]); }
		finally { clearTimeout(timer); }
		// A setting turned off or a folder removed while the provider worked revokes what it found, and a change to any file
		// since the batch began makes every symbol answer it buffered stale. A file answer is not: a file lookup that was running
		// when files changed has proven each file it reports to still exist, and a file's content does not change which files exist.
		if (!host.enabled()) return reply(request.tokens.map(token => ({ token, status: "none" })), true);
		if (host.roots().join("\n") !== roots.join("\n")) return reply(request.tokens.map(token => ({ token, status: "unavailable" })));
		const symbolsStale = resolver.generation !== generation;
		reply(results.map((result, index) => symbolsStale && symbolBased[index] ? { token: result.token, status: "unavailable" } : { ...result }));
	} finally {
		resolver.leaveBatch();
	}
}
