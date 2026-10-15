/**
 * Where `activate()` spends its time, for the one Info line it logs at the end.
 *
 * The extension host's thread is shared with every other extension, so a slow activation is either Desk's own work, a wait for something
 * Desk awaited, or the host being busy with someone else's activation. Each phase therefore records both its wall time and the CPU time
 * the whole host process used during it: a phase whose wall time is far above its CPU time waited; one whose CPU time matches its wall time
 * was computing (Desk's or anyone's, the host cannot say whose).
 */

/** One phase: what ran, the wall time it took and the host process's CPU time (user + system) over the same span. */
export interface ActivationPhase {
	readonly name: string;
	readonly wallMs: number;
	readonly cpuMs: number;
}

/** The clock and CPU readings a timer uses; injectable so a test states the numbers. */
export interface ActivationClock {
	/** Milliseconds, monotonic. */
	now(): number;
	/** Process CPU time (user + system) in milliseconds. */
	cpu(): number;
}

export const systemActivationClock: ActivationClock = {
	now: () => performance.now(),
	cpu: () => {
		const usage = process.cpuUsage();
		return (usage.user + usage.system) / 1000;
	},
};

export class ActivationTimer {
	readonly #clock: ActivationClock;
	readonly #phases: ActivationPhase[] = [];
	readonly #started: { readonly wall: number; readonly cpu: number };
	#mark: { wall: number; cpu: number };

	constructor(clock: ActivationClock = systemActivationClock) {
		this.#clock = clock;
		this.#started = { wall: clock.now(), cpu: clock.cpu() };
		this.#mark = { ...this.#started };
	}

	/** End the phase that began at the previous mark (or at the start) and name it. */
	mark(name: string): void {
		const wall = this.#clock.now();
		const cpu = this.#clock.cpu();
		this.#phases.push({ name, wallMs: wall - this.#mark.wall, cpuMs: cpu - this.#mark.cpu });
		this.#mark = { wall, cpu };
	}

	/** The phases so far, in order. */
	phases(): readonly ActivationPhase[] {
		return this.#phases;
	}

	/**
	 * One line: the lead-in the caller measured before this timer started (module evaluation, the host's age), each phase as
	 * `name wall ms (cpu N)`, and the total. Milliseconds are rounded; a phase under 1 ms still reads `0`.
	 */
	summary(leadIn: ReadonlyArray<readonly [name: string, wallMs: number, cpuMs?: number]> = []): string {
		const total = this.#mark.wall - this.#started.wall;
		const totalCpu = this.#mark.cpu - this.#started.cpu;
		const parts = [
			...leadIn.map(([name, ms, cpu]) => `${name} ${Math.round(ms)}${cpu === undefined ? "" : ` (cpu ${Math.round(cpu)})`}`),
			...this.#phases.map(phase => `${phase.name} ${Math.round(phase.wallMs)} (cpu ${Math.round(phase.cpuMs)})`),
		];
		return [...parts, `activate() total ${Math.round(total)} (cpu ${Math.round(totalCpu)})`].join(" · ");
	}
}
