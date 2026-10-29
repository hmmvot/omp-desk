/**
 * Tells a blocked event loop from a slow peer, for the restore timing line.
 *
 * A round trip to a broker that "takes" 500 ms is either 500 ms of the broker's own scheduling or 500 ms in which this
 * thread could not run the callback that was waiting (the host's loop was busy). A repeating timer separates them: when
 * the loop is blocked the timer fires late by about as long as the block, and when it is the peer that is slow the timer
 * fires on time. The gauge is diagnostic only: it never takes part in a decision, and it costs one unref'd timer that
 * wakes the loop every {@link LOOP_LAG_INTERVAL_MS} for as long as the measured call runs.
 */

/** How often the gauge's timer is due; a late firing is measured against it. */
export const LOOP_LAG_INTERVAL_MS = 10;

/** One running gauge. */
export interface LoopLagGauge {
	/** Stop the timer and return the longest a firing ran late, in milliseconds (0 when none was late). */
	stop(): number;
}

/** Start measuring how late the event loop runs a 10 ms timer. `now` is a test seam (monotonic milliseconds). */
export function startLoopLagGauge(now: () => number = () => performance.now()): LoopLagGauge {
	let last = now();
	let worst = 0;
	const timer = setInterval(() => {
		const at = now();
		const late = at - last - LOOP_LAG_INTERVAL_MS;
		if (late > worst) worst = late;
		last = at;
	}, LOOP_LAG_INTERVAL_MS);
	timer.unref();
	return {
		stop() {
			clearInterval(timer);
			// The stretch since the last firing is part of the measurement too: a block that is still running when the
			// measured call ends has not fired yet.
			const late = now() - last - LOOP_LAG_INTERVAL_MS;
			return Math.max(0, Math.round(late > worst ? late : worst));
		},
	};
}
