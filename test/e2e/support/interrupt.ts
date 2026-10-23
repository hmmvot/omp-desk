/**
 * Runs a synchronous clean-up when the process is interrupted, so a run that is stopped (Ctrl+C, a closed console, a
 * terminate signal) or exits early still ends what it started.
 */
import { constants as osConstants } from "node:os";

const INTERRUPT_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const;

/**
 * Runs `stop` synchronously, once, when this process is interrupted or exits without having called the returned function.
 * A normal teardown calls it after it ended everything itself. A kill that cannot be handled (TerminateProcess) is left to
 * the watchdog's reap file and to the next run's guard.
 * Playwright installs its own signal handlers, which then carry on with the graceful teardown; when ours is the only
 * handler of a signal, the process ends after the stop, as it would without one.
 */
export function stopOnInterrupt(stop: () => void): () => void {
	let done = false;
	const run = (): void => {
		if (done) return;
		done = true;
		stop();
	};
	const handlers = INTERRUPT_SIGNALS.map(signal => [signal, (): void => {
		run();
		if (process.listenerCount(signal) <= 1) process.exit(128 + (osConstants.signals[signal] ?? 0));
	}] as const);
	process.on("exit", run);
	for (const [signal, handler] of handlers) process.on(signal, handler);
	return () => {
		done = true;
		process.off("exit", run);
		for (const [signal, handler] of handlers) process.off(signal, handler);
	};
}
