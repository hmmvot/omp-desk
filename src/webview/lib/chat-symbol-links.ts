import type { GuestHostMessage, GuestWebviewMessage } from "../messages.ts";
import { MAX_SYMBOL_TOKENS_PER_REQUEST } from "../code-symbols.ts";
import type { SymbolLinkStatus } from "../code-symbols.ts";

/** A symbol the host found one definition of; `target` opens through the ordinary file-link request. */
export interface SymbolLink {
	/** A file link target (`path:line:column`) when the symbol has one definition; with `definitions` the symbol's own text, which opens the workspace symbol search. */
	readonly target: string;
	/** Several different definitions: how many. */
	readonly definitions?: number;
}
/** `SymbolLink` once found, `null` when the host answered there is none, `undefined` while nothing fresh is known. */
export type SymbolLookup = SymbolLink | null | undefined;

const FOUND_TTL_MS = 30_000;
const NONE_TTL_MS = 10_000;
/** A token the host could not answer even after its retry is not asked about again for this long. */
const UNANSWERED_TTL_MS = 60_000;
/** Tokens not yet settled (queued, in flight or waiting for a retry) the page admits at once. */
const MAX_QUEUED_TOKENS = 64;
/** Request ids are document-wide, like the terminal-link client's, so an answer meant for an earlier client of the same page never settles a new one's request. */
let nextSymbolRequestId = 0;
const MAX_CACHED = 1024;
const MAX_PARKED = 256;
/** A parked token waits this long for the host's retry signal before a re-render may ask again. */
const PARKED_MS = 60_000;
/** Requests wait this long to collect the tokens of one render burst into one message. */
const BATCH_MS = 40;
const MAX_REQUESTS_IN_FLIGHT = 2;
const REQUEST_TIMEOUT_MS = 20_000;
/** A token the host could not answer is asked again this many times, after RETRY_MS and then four times that. */
const MAX_RETRIES = 2;
/** A language server that has not answered yet gets another question this much later. */
const RETRY_MS = 5_000;
/** After the host says the setting is off the page stops asking for this long. */
const DISABLED_MS = 30_000;

export interface ChatSymbolLinksOptions {
	readonly now?: () => number;
	readonly batchMs?: number;
	readonly retryMs?: number;
	readonly requestTimeoutMs?: number;
}

interface Waiter { readonly token: string; readonly settle: (status: SymbolLinkStatus, target?: string, definitions?: number) => void }

/**
 * One Chat document's code-symbol links: unique inline-code tokens are batched into `omp:terminal-link-symbols`
 * requests (a few in flight at most), answers are cached for a short time, and a token the host could not answer
 * yet (`unavailable`) is asked once more a few seconds later. Nothing here blocks rendering: a token is plain code
 * until its answer arrives. Opening a found symbol is the existing file-link request, so the host re-checks it.
 */
export class ChatSymbolLinks {
	readonly #post: (message: GuestWebviewMessage) => boolean;
	readonly #unsubscribe: () => void;
	readonly #now: () => number;
	readonly #batchMs: number;
	readonly #retryMs: number;
	readonly #requestTimeoutMs: number;
	readonly #entries = new Map<string, { value: SymbolLink | null; expires: number; unanswered?: boolean }>();
	readonly #pending = new Map<string, Promise<SymbolLink | null>>();
	readonly #queue: Waiter[] = [];
	readonly #inFlight = new Map<number, { waiters: Waiter[]; timer: NodeJS.Timeout }>();
	/** Retries waiting for their turn; disposing the client wakes them so no caller waits for a retry that will never run. */
	readonly #retries = new Map<NodeJS.Timeout, () => void>();
	#flushTimer: NodeJS.Timeout | undefined;
	#disabledUntil = 0;
	#overflowed = false;
	#notifyTimer: NodeJS.Timeout | undefined;
	/** Tokens the host parked (not a verdict), with the time after which they may be asked again on their own. */
	readonly #parked = new Map<string, number>();
	readonly #listeners = new Set<() => void>();
	#disposed = false;

	constructor(transport: { post(message: GuestWebviewMessage): boolean; subscribe(listener: (message: GuestHostMessage) => void): () => void }, options: ChatSymbolLinksOptions = {}) {
		this.#post = message => transport.post(message);
		this.#now = options.now ?? Date.now;
		this.#batchMs = options.batchMs ?? BATCH_MS;
		this.#retryMs = options.retryMs ?? RETRY_MS;
		this.#requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
		this.#unsubscribe = transport.subscribe(message => {
			if (message.type === "omp:terminal-link-symbol-resolution") this.#receive(message);
			else if (message.type === "omp:terminal-link-symbols-retry") this.#retry();
		});
	}

	/** The fresh answer for `token`, or `undefined` while it has not been asked or the answer expired. */
	peek(token: string): SymbolLookup {
		const entry = this.#entries.get(token);
		if (entry === undefined) return undefined;
		if (entry.expires <= this.#now()) { this.#entries.delete(token); return undefined; }
		return entry.value;
	}

	/** Whether the host said the feature is off, so callers can skip asking altogether. */
	get disabled(): boolean { return this.#now() < this.#disabledUntil; }

	resolve(token: string): Promise<SymbolLink | null> {
		const known = this.peek(token);
		if (known !== undefined) return Promise.resolve(known);
		if (this.disabled || this.#disposed) return Promise.resolve(null);
		const parkedUntil = this.#parked.get(token);
		if (parkedUntil !== undefined && parkedUntil > this.#now()) return Promise.resolve(null);
		let pending = this.#pending.get(token);
		if (pending === undefined) {
			// Every unsettled token (queued, in flight or waiting for its retry) counts: a burst beyond the budget
			// stays plain code, uncached; the span asks again when the budget has room (a notification) or it next renders.
			if (this.#pending.size >= MAX_QUEUED_TOKENS) { this.#overflowed = true; return Promise.resolve(null); }
			pending = this.#ask(token, MAX_RETRIES).then(({ link, answered, parked }) => {
				this.#pending.delete(token);
				if (this.#overflowed && this.#pending.size <= MAX_QUEUED_TOKENS / 2) { this.#overflowed = false; this.#notifyLater(); }
				if (parked === true) {
					// Not a verdict: nothing is cached, and the token is not asked again until the host's retry signal (or a minute).
					if (this.#parked.size >= MAX_PARKED) this.#parked.clear();
					this.#parked.set(token, this.#now() + PARKED_MS);
					return null;
				}
				if (this.#entries.size >= MAX_CACHED) this.#entries.clear();
				if (!this.#disposed) this.#entries.set(token, { value: link, expires: this.#now() + (link !== null ? FOUND_TTL_MS : answered ? NONE_TTL_MS : UNANSWERED_TTL_MS), ...(link === null && !answered ? { unanswered: true } : {}) });
				return link;
			});
			this.#pending.set(token, pending);
		}
		return pending;
	}

	/** The host's answer for `token`; `answered` is false when it could not answer even after the one retry. */
	async #ask(token: string, retriesLeft: number): Promise<{ link: SymbolLink | null; answered: boolean; parked?: true }> {
		const { promise, resolve } = Promise.withResolvers<{ status: SymbolLinkStatus; target?: string; definitions?: number }>();
		this.#queue.push({ token, settle: (status, target, definitions) => resolve({ status, ...(target === undefined ? {} : { target }), ...(definitions === undefined ? {} : { definitions }) }) });
		this.#scheduleFlush();
		const answer = await promise;
		if (answer.status === "found" && answer.target !== undefined) return { link: { target: answer.target }, answered: true };
		// Several definitions: the link is the token itself (the host re-parses it) and opens the symbol search, not a file.
		if (answer.status === "ambiguous" && answer.definitions !== undefined) return { link: { target: token, definitions: answer.definitions }, answered: true };
		if (answer.status === "pending") return { link: null, answered: false, parked: true };
		if (answer.status !== "unavailable") return { link: null, answered: true };
		if (retriesLeft <= 0 || this.#disposed || this.disabled) return { link: null, answered: false };
		const { promise: waited, resolve: done } = Promise.withResolvers<void>();
		// The first retry comes after `retryMs`, the last four times later: a language server still loading gets time.
		const timer = setTimeout(() => { this.#retries.delete(timer); done(); }, retriesLeft === MAX_RETRIES ? this.#retryMs : this.#retryMs * 4);
		this.#retries.set(timer, done);
		await waited;
		return this.#disposed || this.disabled ? { link: null, answered: false } : this.#ask(token, retriesLeft - 1);
	}

	#scheduleFlush(): void {
		if (this.#flushTimer !== undefined || this.#disposed) return;
		this.#flushTimer = setTimeout(() => { this.#flushTimer = undefined; this.#flush(); }, this.#batchMs);
	}

	#flush(): void {
		while (this.#queue.length > 0 && this.#inFlight.size < MAX_REQUESTS_IN_FLIGHT && !this.#disposed) {
			const waiters = this.#queue.splice(0, MAX_SYMBOL_TOKENS_PER_REQUEST);
			const requestId = nextSymbolRequestId++;
			const timer = setTimeout(() => this.#finish(requestId, []), this.#requestTimeoutMs);
			this.#inFlight.set(requestId, { waiters, timer });
			if (!this.#post({ type: "omp:terminal-link-symbols", requestId, tokens: waiters.map(waiter => waiter.token) })) this.#finish(requestId, []);
		}
	}

	#receive(message: Extract<GuestHostMessage, { type: "omp:terminal-link-symbol-resolution" }>): void {
		// An answer nobody is waiting for (another client's, a late one, a made-up id) changes no state at all.
		if (!this.#inFlight.has(message.requestId)) return;
		if (message.disabled === true) this.#disabledUntil = this.#now() + DISABLED_MS;
		this.#finish(message.requestId, message.results);
		if (message.disabled === true) this.#stopWaiting();
	}

	/** The host says parked tokens may be asked again: forget the parking and the cooldown of unanswered tokens, and let every mounted span ask. */
	#retry(): void {
		if (this.#disposed) return;
		this.#parked.clear();
		for (const [token, entry] of this.#entries) if (entry.unanswered === true) this.#entries.delete(token);
		this.#notify();
	}

	/** The host said the feature is off: queued tokens settle as plain code and retries waiting for their turn are cancelled. */
	#stopWaiting(): void {
		for (const waiter of this.#queue.splice(0)) waiter.settle("none");
		clearTimeout(this.#flushTimer);
		this.#flushTimer = undefined;
		for (const [timer, done] of this.#retries) { clearTimeout(timer); done(); }
		this.#retries.clear();
	}

	/** Settle every waiter of one request from `results`; a token the answer does not carry is `unavailable`. */
	#finish(requestId: number, results: readonly { token: string; status: SymbolLinkStatus; target?: string; definitions?: number }[]): void {
		const request = this.#inFlight.get(requestId);
		if (request === undefined) return;
		this.#inFlight.delete(requestId);
		clearTimeout(request.timer);
		for (const waiter of request.waiters) {
			const result = results.find(candidate => candidate.token === waiter.token);
			if (result === undefined) waiter.settle("unavailable");
			else waiter.settle(result.status, result.target, result.definitions);
		}
		if (this.#queue.length > 0) this.#scheduleFlush();
	}

	dispose(): void {
		this.#disposed = true;
		this.#unsubscribe();
		clearTimeout(this.#flushTimer);
		clearTimeout(this.#notifyTimer);
		this.#listeners.clear();
		for (const [timer, done] of this.#retries) { clearTimeout(timer); done(); }
		this.#retries.clear();
		for (const [requestId] of [...this.#inFlight]) this.#finish(requestId, []);
		for (const waiter of this.#queue.splice(0)) waiter.settle("none");
	}

	/** Called when tokens that were left unresolved (parked by the host, refused by the budget, unanswered) may be asked again. Returns the unsubscribe. */
	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => { this.#listeners.delete(listener); };
	}

	#notify(): void {
		if (this.#disposed) return;
		for (const listener of [...this.#listeners]) listener();
	}

	/** One coalesced notification a batch window from now. */
	#notifyLater(): void {
		if (this.#notifyTimer !== undefined || this.#disposed) return;
		this.#notifyTimer = setTimeout(() => { this.#notifyTimer = undefined; this.#notify(); }, this.#batchMs);
	}
}
