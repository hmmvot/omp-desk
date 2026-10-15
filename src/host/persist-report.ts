/**
 * What the user is told when the window could not save its state, and what is only logged.
 *
 * Contention between windows is expected (three windows start together and write the one profile catalog): a write that
 * lost to it is saved again by itself, so it is a `warn` line with its cause and no notification. Any other failure
 * (an unreadable or damaged catalog, a write error) is a fault the user can act on: it is logged every time and shown once
 * per window for each distinct text, never as a flood. Nothing here imports `vscode`.
 */
import type { Logger } from "../shared/logger.ts";

/** A source of save failures: the session index, the folder list. */
export interface PersistFailureSource {
	/** Why the last save failed, or `null`. */
	readonly persistError: string | null;
	/** Whether that failure is only contention for the catalog lock, which a later write resolves by itself. */
	readonly persistBusy?: boolean;
}

export class PersistFailureReporter {
	readonly #log: Pick<Logger, "warn">;
	readonly #notify: (message: string) => void;
	readonly #shown = new Set<string>();

	constructor(log: Pick<Logger, "warn">, notify: (message: string) => void) {
		this.#log = log;
		this.#notify = notify;
	}

	/** Report the source's current failure, if it has one. `prefix` introduces it in the notification. */
	report(source: PersistFailureSource, prefix = ""): void {
		const error = source.persistError;
		if (error === null) return;
		if (source.persistBusy === true) {
			this.#log.warn(`${error} (contention between windows; saved again automatically)`);
			return;
		}
		this.#log.warn(error);
		if (this.#shown.has(error)) return;
		this.#shown.add(error);
		this.#notify(`${prefix}${error}`);
	}
}
