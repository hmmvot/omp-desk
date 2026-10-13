/**
 * Run one asynchronous job at a time, and fold every request that arrives while it runs into one follow-up.
 *
 * A request is a promise for a run that *starts after the request*: a caller that asked to see the newest state is never
 * handed a run that began before it asked. Requests that arrive while a run is in flight therefore wait for the follow-up,
 * and however many of them there are, the follow-up runs once. An idle runner starts the job at once.
 *
 * The job's own failure rejects exactly the requests that run served; the next run starts regardless.
 */
export class CoalescedRun<A> {
	readonly #run: (request: A) => Promise<void>;
	readonly #merge: (pending: A, next: A) => A;
	#running = false;
	#pending: { request: A; readonly deferred: PromiseWithResolvers<void> } | null = null;

	/**
	 * @param run The job; receives the merged request of every caller it serves.
	 * @param merge Combine the request already waiting for the follow-up with a later one.
	 */
	constructor(run: (request: A) => Promise<void>, merge: (pending: A, next: A) => A) {
		this.#run = run;
		this.#merge = merge;
	}

	/** A promise for a run that starts no earlier than this call. */
	request(request: A): Promise<void> {
		if (!this.#running) return this.#start(request);
		if (this.#pending === null) this.#pending = { request, deferred: Promise.withResolvers<void>() };
		else this.#pending.request = this.#merge(this.#pending.request, request);
		return this.#pending.deferred.promise;
	}

	async #start(request: A): Promise<void> {
		this.#running = true;
		try {
			await this.#run(request);
		} finally {
			this.#running = false;
			const next = this.#pending;
			this.#pending = null;
			if (next !== null) {
				// The follow-up reports to its own callers; it must not fail this one.
				this.#start(next.request).then(next.deferred.resolve, next.deferred.reject);
			}
		}
	}
}
