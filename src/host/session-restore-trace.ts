/**
 * Helpers of the activation restore pass: a bounded-concurrency runner and the per-row step timer.
 *
 * Neither takes part in any ownership decision. The runner only decides *when* a row's own
 * restore starts; the timer only records how long each step of it took, for the log.
 */

/** How many rows one restore pass works on at a time unless the caller says otherwise. */
export const RESTORE_CONCURRENCY = 4;

/**
 * Run `work` for every item with at most `limit` in flight, starting items in the order given.
 *
 * Results come back by input position, never by completion order, so the caller folds them
 * deterministically. `work` must settle with a value; a rejection is the caller's to catch per item,
 * so one item's failure cannot cancel the others.
 */
export async function mapBounded<T, R>(items: readonly T[], limit: number, work: (item: T, position: number) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const worker = async (): Promise<void> => {
		for (;;) {
			const position = next++;
			if (position >= items.length) return;
			results[position] = await work(items[position] as T, position);
		}
	};
	const width = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
	await Promise.all(Array.from({ length: width }, worker));
	return results;
}

/** Milliseconds of the sub-steps an integration measured inside one launcher call; diagnostic only, never a decision input. */
export type OmpHostStepTimings = Readonly<Record<string, number>>;

/**
 * Times the named pieces of one step as they run. Passed down into the code a step calls so its log line can say where
 * the step's time went; it never takes part in a decision, and a caller without one measures nothing.
 */
export interface StepSink {
	measure<T>(name: string, work: () => Promise<T>): Promise<T>;
}

/** Run `work` under `name` when a sink is given, and as plain `work` otherwise. */
export function timedStep<T>(steps: StepSink | undefined, name: string, work: () => Promise<T>): Promise<T> {
	return steps === undefined ? work() : steps.measure(name, work);
}

/** The named steps of one row's restore, in the order the log line reports them. */
const STEP_ORDER = ["admission", "reconcile", "attach", "launch", "persist"] as const;
type RestoreStep = (typeof STEP_ORDER)[number];

/**
 * Wall-clock durations of one row's restore steps.
 *
 * - `admission`: everything before the first ownership reconcile — identity ordering, the file and
 *   directory checks, the claim read and the claim acquisition;
 * - `reconcile`: the owner reconciler (the identity probes), summed over every call of the row;
 * - `attach` / `launch`: the launcher call, with the sub-steps the integration reports;
 * - `persist`: what remains after the last measured step — the row's own status writes.
 */
export class RestoreStepTimer {
	readonly #now: () => number;
	readonly #startedAt: number;
	readonly #steps = new Map<RestoreStep, number>();
	readonly #details = new Map<RestoreStep, OmpHostStepTimings>();
	readonly #sub = new Map<RestoreStep, Record<string, number>>();
	#mark: number;
	#measured = false;

	constructor(now: () => number = Date.now) {
		this.#now = now;
		this.#startedAt = now();
		this.#mark = this.#startedAt;
	}

	/** Time `work` as `step`; the time before the first measured step is `admission`. */
	async measure<T>(step: Exclude<RestoreStep, "admission" | "persist">, work: () => Promise<T>): Promise<T> {
		const begin = this.#now();
		if (!this.#measured) {
			this.#measured = true;
			this.#add("admission", begin - this.#mark);
		}
		try {
			return await work();
		} finally {
			const end = this.#now();
			this.#add(step, end - begin);
			this.#mark = end;
		}
	}

	/** Keep the sub-steps a launcher reported for the step they ran in. */
	detail(step: "attach" | "launch", timings: OmpHostStepTimings | undefined): void {
		if (timings !== undefined) this.#details.set(step, timings);
	}

	/**
	 * A sink that adds the time of each named piece of work to `step`'s sub-steps, summed over every call of the row.
	 * A piece that waited on a promise another caller started names itself as such (`… (shared)`); the sink only records.
	 */
	sink(step: "reconcile"): StepSink {
		return {
			measure: async (name, work) => {
				const begin = this.#now();
				try {
					return await work();
				} finally {
					const sub = this.#sub.get(step) ?? {};
					sub[name] = (sub[name] ?? 0) + Math.max(0, this.#now() - begin);
					this.#sub.set(step, sub);
				}
			},
		};
	}

	/** One compact line, without identifiers; `outcome` is the restore status word. */
	finish(outcome: string): string {
		const end = this.#now();
		this.#add(this.#measured ? "persist" : "admission", end - this.#mark);
		this.#mark = end;
		const parts: string[] = [];
		for (const step of STEP_ORDER) {
			const ms = this.#steps.get(step);
			if (ms === undefined) continue;
			const detail = { ...this.#details.get(step), ...this.#sub.get(step) };
			const entries = Object.entries(detail);
			const inner = entries.length === 0 ? "" : ` (${entries.map(([name, value]) => `${name} ${Math.round(value)}`).join(", ")})`;
			parts.push(`${step} ${Math.round(ms)}${inner}`);
		}
		return `${outcome} in ${Math.round(end - this.#startedAt)} ms · ${parts.join(" · ")}`;
	}

	#add(step: RestoreStep, ms: number): void {
		this.#steps.set(step, (this.#steps.get(step) ?? 0) + Math.max(0, ms));
	}
}

/**
 * Orders the rows of one pass that name the same session identity.
 *
 * The pass's duplicate-identity rule is first come, first served: the first row to reach the check
 * owns the identity and a later row is refused. Sequentially that meant cohort order. Rows now run
 * together, so rows that share an identity pass the check one after another in cohort order; rows
 * with distinct identities never wait for each other.
 */
export class IdentityTurns {
	readonly #last = new Map<string, Promise<void>>();

	/** The turn of the next row (in cohort order) that names `key`; `null` key means no identity is known yet and nobody waits. */
	next(key: string | null): IdentityTurn {
		if (key === null) return { wait: async () => {}, release: () => {} };
		const before = this.#last.get(key);
		const done = Promise.withResolvers<void>();
		this.#last.set(key, done.promise);
		let released = false;
		return {
			wait: async () => {
				if (before !== undefined) await before;
			},
			release: () => {
				if (released) return;
				released = true;
				done.resolve();
			},
		};
	}
}

/** One row's place in an {@link IdentityTurns} chain. */
export interface IdentityTurn {
	/** Resolves once every earlier row of the same identity has passed its check or ended. */
	wait(): Promise<void>;
	/** Idempotent: the check is done (taken or refused), or the row ended without reaching it. */
	release(): void;
}
