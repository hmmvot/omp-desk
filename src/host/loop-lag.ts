/**
 * Notices that the extension host's event loop was blocked, and names the Desk operations that were running.
 *
 * Every extension shares one thread in the host, so one slow synchronous step anywhere freezes every command, tree and
 * webview of every extension: a title-bar click that does nothing for seconds is the usual symptom, and the culprit
 * is rarely the code the click ran. A timer that should fire every {@link LoopLagOptions.tickMs} fires late by exactly
 * the time the thread was busy, which costs nothing to watch and is always on.
 *
 * What was running is answered from operation marks. {@link EventLoopLagMonitor.run} wraps an entry point (a command, a
 * catalog refresh) and records how long its *synchronous* part took before its first `await`, which is the part that
 * blocks; the late timer then reports every mark that overlapped the stall. A stall with no overlapping mark is itself an
 * answer: it was not Desk code that carries a mark (another extension, VS Code, or the machine being starved of CPU, which the
 * reported process CPU time tells apart). Nothing here imports `vscode`.
 */
import { performance } from "node:perf_hooks";

export interface LoopLagOptions {
	/** Receives one line per detected stall. */
	readonly report: (line: string) => void;
	/** A stall at least this long is reported. Default 500. */
	readonly thresholdMs?: number;
	/** How often the timer is expected to fire. Default 100. */
	readonly tickMs?: number;
	/** Monotonic milliseconds. Default `performance.now`. */
	readonly now?: () => number;
	/** CPU milliseconds (user + system) this process has used. Default `process.cpuUsage`. */
	readonly cpuMs?: () => number;
}

/** One marked operation: running while `end` is `null`. */
interface Mark {
	readonly name: string;
	readonly start: number;
	end: number | null;
	/** How long the operation ran before it first yielded to the event loop, once it has. */
	syncMs: number | null;
}

/** A gap this long is the machine sleeping, not the thread being busy. */
const SUSPEND_MS = 10 * 60_000;
/** Finished marks are kept this long, to name an operation that ended inside a stall. */
const KEEP_FINISHED_MS = 30_000;
const KEEP_FINISHED_MAX = 64;
/** How many operations one report names. */
const NAMED_MAX = 6;

export class EventLoopLagMonitor {
	readonly #report: (line: string) => void;
	readonly #thresholdMs: number;
	readonly #tickMs: number;
	readonly #now: () => number;
	readonly #cpuMs: () => number;
	readonly #active = new Set<Mark>();
	readonly #finished: Mark[] = [];
	#lastTick: number;
	#lastCpu: number;

	constructor(options: LoopLagOptions) {
		this.#report = options.report;
		this.#thresholdMs = options.thresholdMs ?? 500;
		this.#tickMs = options.tickMs ?? 100;
		this.#now = options.now ?? (() => performance.now());
		this.#cpuMs = options.cpuMs ?? (() => {
			const usage = process.cpuUsage();
			return (usage.user + usage.system) / 1000;
		});
		this.#lastTick = this.#now();
		this.#lastCpu = this.#cpuMs();
	}

	/** Start watching; the returned function stops it. The timer never keeps the process alive. */
	start(): () => void {
		this.#lastTick = this.#now();
		this.#lastCpu = this.#cpuMs();
		const timer = setInterval(() => this.sample(), this.#tickMs);
		timer.unref?.();
		return () => clearInterval(timer);
	}

	/** Mark an operation as running until the returned function is called (idempotent). */
	begin(name: string): () => void {
		return this.#open(name).end;
	}

	/**
	 * Run `work` as the named operation. A promise it returns keeps the mark open until it settles. How long `work`
	 * itself ran before returning is the time it held the thread, and is reported at once when that alone reaches the
	 * threshold: that is the one case the late timer cannot see until afterwards.
	 */
	run<T>(name: string, work: () => T): T {
		const { mark, end } = this.#open(name);
		let result: T;
		try {
			result = work();
		} catch (error) {
			this.#settleSync(mark);
			end();
			throw error;
		}
		this.#settleSync(mark);
		if (isPromiseLike(result)) {
			return result.then(
				value => {
					end();
					return value;
				},
				(error: unknown) => {
					end();
					throw error;
				},
			) as T;
		}
		end();
		return result;
	}

	/** The timer's body: report when it fired later than a busy-free thread would have. Exposed for tests. */
	sample(): void {
		const at = this.#now();
		const cpu = this.#cpuMs();
		const from = this.#lastTick;
		const cpuUsed = cpu - this.#lastCpu;
		this.#lastTick = at;
		this.#lastCpu = cpu;
		const lag = at - from - this.#tickMs;
		if (lag < this.#thresholdMs || lag > SUSPEND_MS) return;
		this.#report(
			`event loop blocked for ${Math.round(lag)} ms (the host's timers ran that late; process CPU ${Math.round(cpuUsed)} ms in ${Math.round(at - from)} ms): ${this.#describe(from, at)}`,
		);
	}

	#open(name: string): { readonly mark: Mark; readonly end: () => void } {
		const mark: Mark = { name, start: this.#now(), end: null, syncMs: null };
		this.#active.add(mark);
		const end = (): void => {
			if (mark.end !== null) return;
			mark.end = this.#now();
			this.#active.delete(mark);
			this.#finished.push(mark);
			if (this.#finished.length > KEEP_FINISHED_MAX) this.#finished.splice(0, this.#finished.length - KEEP_FINISHED_MAX);
		};
		return { mark, end };
	}

	#settleSync(mark: Mark): void {
		mark.syncMs = this.#now() - mark.start;
		if (mark.syncMs >= this.#thresholdMs) {
			this.#report(`${mark.name} held the event loop for ${Math.round(mark.syncMs)} ms before its first await`);
		}
	}

	#describe(from: number, at: number): string {
		const cutoff = at - KEEP_FINISHED_MS;
		while (this.#finished.length > 0 && (this.#finished[0]?.end ?? 0) < cutoff) this.#finished.shift();
		const overlapping = [...this.#finished.filter(mark => (mark.end ?? 0) >= from), ...this.#active];
		if (overlapping.length === 0) {
			return "no marked Desk operation was running, so the time went to code outside Desk or to the machine";
		}
		const named = overlapping.slice(-NAMED_MAX).map(mark => {
			const running = mark.end === null ? `running ${Math.round(at - mark.start)} ms` : `ended after ${Math.round(mark.end - mark.start)} ms`;
			const sync = mark.syncMs === null ? "" : `, ${Math.round(mark.syncMs)} ms before its first await`;
			return `${mark.name} (${running}${sync})`;
		});
		const more = overlapping.length > NAMED_MAX ? ` and ${overlapping.length - NAMED_MAX} more` : "";
		return `marked Desk operations in that time: ${named.join("; ")}${more}`;
	}
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
	return typeof value === "object" && value !== null && "then" in value && typeof value.then === "function";
}

let shared: EventLoopLagMonitor | null = null;

/**
 * Start the host-wide monitor, reporting to `report`. Operations marked with {@link trackOperation} before it starts run
 * unmarked. Returns the function that stops it.
 */
export function startLoopLagMonitor(report: (line: string) => void): () => void {
	shared = new EventLoopLagMonitor({ report });
	const stop = shared.start();
	return () => {
		stop();
		shared = null;
	};
}

/** Run `work` as a named operation of the host-wide monitor; with none started it is just `work()`. */
export function trackOperation<T>(name: string, work: () => T): T {
	return shared === null ? work() : shared.run(name, work);
}
