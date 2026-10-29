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
 * blocks; the late timer then reports every mark that overlapped the stall. Work that runs thousands of times a second (a read
 * of the broker socket, a reply's coalesced update) cannot be marked one by one: {@link EventLoopLagMonitor.meter} adds its
 * duration to a total per name, and the late timer reports those totals for the stretch it was late, so a stall made of many
 * short callbacks names the path and says how much of the stall it covers. A stall with no overlapping mark and no metered work
 * is itself an answer: it was not Desk code that carries a mark (another extension, VS Code, or the machine being starved of CPU,
 * which the reported process CPU time tells apart). Nothing here imports `vscode`.
 */
import { performance } from "node:perf_hooks";
import type { Logger } from "../shared/logger";

export interface LoopLagOptions {
	/** Receives one line per detected stall: `warn` from {@link LOOP_LAG_WARN_MS}, `debug` below it. */
	readonly log: Logger;
	/** A stall at least this long is reported. Default 500. */
	readonly thresholdMs?: number;
	/** How often the timer is expected to fire. Default 100. */
	readonly tickMs?: number;
	/** Monotonic milliseconds. Default `performance.now`. */
	readonly now?: () => number;
	/** CPU milliseconds (user + system) this process has used. Default `process.cpuUsage`. */
	readonly cpuMs?: () => number;
	/**
	 * Cumulative CPU split and page faults, in milliseconds and counts. Default: `process.cpuUsage` and
	 * `process.resourceUsage`, used only when `cpuMs` is not replaced. A stall whose process CPU roughly equals its length
	 * is a thread of this process spinning; mostly system time points at the OS (file system, page faults) and not at
	 * JavaScript; many page faults with little CPU is the process waiting for memory the OS took away from it.
	 */
	readonly split?: () => CpuSplit;
}

/** Cumulative CPU time of this process by mode, and the page faults it has taken (soft and hard). */
export interface CpuSplit {
	readonly userMs: number;
	readonly systemMs: number;
	readonly pageFaults: number;
}

/**
 * The event loop's own utilization (`performance.eventLoopUtilization`) is not used: in the extension host (an Electron utility
 * process) it read 0 in every stall, also in one where a 1.7 s synchronous catalog read was logged next to `event loop busy 0 ms`,
 * while plain Node and Electron-as-Node count it. Windows reports the page-fault count in either of the two fields, so both are added.
 */
function processSplit(): CpuSplit {
	const usage = process.cpuUsage();
	const resources = process.resourceUsage();
	return { userMs: usage.user / 1000, systemMs: usage.system / 1000, pageFaults: resources.minorPageFault + resources.majorPageFault };
}

/** One marked operation: running while `end` is `null`. */
interface Mark {
	readonly name: string;
	readonly start: number;
	end: number | null;
	/** How long the operation ran before it first yielded to the event loop, once it has. */
	syncMs: number | null;
}

/** What one metered name has used since the previous sample. */
interface Metered {
	count: number;
	totalMs: number;
	maxMs: number;
}

/** A gap this long is the machine sleeping, not the thread being busy. */
const SUSPEND_MS = 10 * 60_000;
/** Finished marks are kept this long, to name an operation that ended inside a stall. */
const KEEP_FINISHED_MS = 30_000;
const KEEP_FINISHED_MAX = 64;
/** A stall this long is a `warn`; a shorter one only matters when diagnosing, so it is a `debug`. */
export const LOOP_LAG_WARN_MS = 1000;
/** How many operations one report names. */
const NAMED_MAX = 6;

export class EventLoopLagMonitor {
	readonly #log: Logger;
	readonly #thresholdMs: number;
	readonly #tickMs: number;
	readonly #now: () => number;
	readonly #cpuMs: () => number;
	readonly #split: (() => CpuSplit) | null;
	#lastSplit: CpuSplit | null;
	readonly #active = new Set<Mark>();
	readonly #finished: Mark[] = [];
	readonly #metered = new Map<string, Metered>();
	#lastTick: number;
	#lastCpu: number;

	constructor(options: LoopLagOptions) {
		this.#log = options.log;
		this.#thresholdMs = options.thresholdMs ?? 500;
		this.#tickMs = options.tickMs ?? 100;
		this.#now = options.now ?? (() => performance.now());
		this.#cpuMs = options.cpuMs ?? (() => {
			const usage = process.cpuUsage();
			return (usage.user + usage.system) / 1000;
		});
		this.#split = options.split ?? (options.cpuMs === undefined ? processSplit : null);
		this.#lastSplit = this.#split?.() ?? null;
		this.#lastTick = this.#now();
		this.#lastCpu = this.#cpuMs();
	}

	/** Start watching; the returned function stops it. The timer never keeps the process alive. */
	start(): () => void {
		this.#lastTick = this.#now();
		this.#lastCpu = this.#cpuMs();
		this.#lastSplit = this.#split?.() ?? null;
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

	/**
	 * Add `ms` of work to the total of `name` for the stretch before the next sample. For a path too frequent to mark: the
	 * caller measures its own duration (the work is inclusive of anything it calls, so two names can overlap).
	 */
	meter(name: string, ms: number): void {
		const entry = this.#metered.get(name);
		if (entry === undefined) {
			this.#metered.set(name, { count: 1, totalMs: ms, maxMs: ms });
			return;
		}
		entry.count += 1;
		entry.totalMs += ms;
		if (ms > entry.maxMs) entry.maxMs = ms;
	}

	/** The timer's body: report when it fired later than a busy-free thread would have. Exposed for tests. */
	sample(): void {
		const at = this.#now();
		const cpu = this.#cpuMs();
		const from = this.#lastTick;
		const cpuUsed = cpu - this.#lastCpu;
		this.#lastTick = at;
		this.#lastCpu = cpu;
		const split = this.#split?.() ?? null;
		const before = this.#lastSplit;
		this.#lastSplit = split;
		const lag = at - from - this.#tickMs;
		const metered = [...this.#metered];
		this.#metered.clear();
		if (lag < this.#thresholdMs || lag > SUSPEND_MS) return;
		const modes = split === null || before === null
			? ""
			: `; user ${Math.round(split.userMs - before.userMs)} ms, system ${Math.round(split.systemMs - before.systemMs)} ms, page faults ${Math.round(split.pageFaults - before.pageFaults)}`;
		const text = `event loop blocked for ${Math.round(lag)} ms (the host's timers ran that late; process CPU ${Math.round(cpuUsed)} ms in ${Math.round(at - from)} ms${modes}): ${this.#describe(from, at, metered)}`;
		if (lag >= LOOP_LAG_WARN_MS) this.#log.warn(text);
		else this.#log.debug(text);
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
			const text = `${mark.name} held the event loop for ${Math.round(mark.syncMs)} ms before its first await`;
			if (mark.syncMs >= LOOP_LAG_WARN_MS) this.#log.warn(text);
			else this.#log.debug(text);
		}
	}

	#describe(from: number, at: number, metered: ReadonlyArray<readonly [string, Metered]>): string {
		const cutoff = at - KEEP_FINISHED_MS;
		while (this.#finished.length > 0 && (this.#finished[0]?.end ?? 0) < cutoff) this.#finished.shift();
		const overlapping = [...this.#finished.filter(mark => (mark.end ?? 0) >= from), ...this.#active];
		const work = metered.length === 0
			? ""
			: `metered Desk work in that time: ${metered.map(([name, entry]) => `${name} ${entry.count} times, ${Math.round(entry.totalMs)} ms in all, longest ${Math.round(entry.maxMs)} ms`).join("; ")}`;
		if (overlapping.length === 0) {
			if (work.length > 0) return `no marked Desk operation was running; ${work}; what they do not cover ran outside Desk's metered work`;
			return "no marked Desk operation was running, so the time went to code outside Desk or to the machine";
		}
		const named = overlapping.slice(-NAMED_MAX).map(mark => {
			const running = mark.end === null ? `running ${Math.round(at - mark.start)} ms` : `ended after ${Math.round(mark.end - mark.start)} ms`;
			const sync = mark.syncMs === null ? "" : `, ${Math.round(mark.syncMs)} ms before its first await`;
			return `${mark.name} (${running}${sync})`;
		});
		const more = overlapping.length > NAMED_MAX ? ` and ${overlapping.length - NAMED_MAX} more` : "";
		return `marked Desk operations in that time: ${named.join("; ")}${more}${work.length === 0 ? "" : `; ${work}`}`;
	}
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
	return typeof value === "object" && value !== null && "then" in value && typeof value.then === "function";
}

let shared: EventLoopLagMonitor | null = null;

/**
 * Start the host-wide monitor, reporting to `log`. Operations marked with {@link trackOperation} before it starts run
 * unmarked. Returns the function that stops it.
 */
export function startLoopLagMonitor(log: Logger): () => void {
	shared = new EventLoopLagMonitor({ log });
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

/** Add already measured `ms` of work to `name`'s total in the host-wide monitor (see {@link EventLoopLagMonitor.meter}); with none started it does nothing. */
export function meterMs(name: string, ms: number): void {
	shared?.meter(name, ms);
}

/** Run synchronous `work` and meter its duration under `name`; with no monitor started it is just `work()`. */
export function meterWork<T>(name: string, work: () => T): T {
	if (shared === null) return work();
	const started = performance.now();
	try {
		return work();
	} finally {
		shared.meter(name, performance.now() - started);
	}
}
