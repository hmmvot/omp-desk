import type { Logger } from "../shared/logger.ts";

/**
 * Makes a lookup that keeps failing visible without the Debug log level. The per-lookup lines are debug; a name whose
 * lookups end without an answer {@link GIVE_UP_ATTEMPTS} times in a row (the first ask and the page's two retries) is reported once,
 * at info, with the reasons, and then not again for {@link GIVE_UP_WINDOW_MS}. A name that gets an answer starts counting from zero.
 * A miss that only means "not yet" is not a try: the provider still loading, files changing under the lookup, or no room in the
 * provider's line (a full queue). The host asks those again with its retry signal without using the
 * page's budget (docs/designs/2026-10-10-code-symbol-links.md, "Readiness and parking"), and counting them reported a name as given
 * up while it was only waiting for a language server or its turn.
 */

/** Consecutive lookups without an answer that make a name "given up": the page asks once and retries twice. */
export const GIVE_UP_ATTEMPTS = 3;
/** The least time between two reports of one name. */
export const GIVE_UP_WINDOW_MS = 5 * 60_000;
const MAX_NAMES = 512;

interface Entry {
	since: number;
	attempts: number;
	reasons: Map<string, number>;
	reported: boolean;
}

/** The reasons of a miss that is a wait, not a failure: the lookup logs them itself and they never count towards a give-up. */
const WAITING_REASONS: Record<string, true> = {
	"provider not ready": true,
	"queue full": true,
	"invalidated": true,
	"invalidated while the batch ran": true,
	"files changed while the batch ran": true,
	"workspace folders changed": true,
};

/** The short reason of a lookup verdict (`unavailable: invalidated` and `parked (invalidated)` are `invalidated`; `parked (queue)` is `queue full`). */
export function giveUpReason(verdict: string): string {
	if (verdict.startsWith("unavailable: ")) return verdict.slice("unavailable: ".length);
	switch (verdict) {
		case "parked (not ready)": return "provider not ready";
		case "parked (invalidated)": return "invalidated";
		case "parked (queue)": return "queue full";
		case "parked (timeout)": return "timeout";
		default: return verdict;
	}
}

export class GiveUpReporter {
	readonly #log: Logger;
	readonly #now: () => number;
	readonly #entries = new Map<string, Entry>();

	constructor(log: Logger, now: () => number) {
		this.#log = log;
		this.#now = now;
	}

	/** A lookup of `name` (`kind` says which: `code symbol`, `file name`) ended without an answer, for `reason`. */
	missed(kind: string, name: string, reason: string): void {
		if (WAITING_REASONS[reason] === true) return;
		const key = `${kind}\0${name}`;
		const now = this.#now();
		let entry = this.#entries.get(key);
		if (entry === undefined || now - entry.since > GIVE_UP_WINDOW_MS) {
			if (this.#entries.size >= MAX_NAMES) this.#entries.delete(this.#entries.keys().next().value!);
			entry = { since: now, attempts: 0, reasons: new Map(), reported: false };
			this.#entries.set(key, entry);
		}
		entry.attempts++;
		entry.reasons.set(reason, (entry.reasons.get(reason) ?? 0) + 1);
		if (entry.attempts < GIVE_UP_ATTEMPTS || entry.reported) return;
		entry.reported = true;
		const reasons = [...entry.reasons].map(([text, count]) => `${text} x${count}`).join(", ");
		this.#log.info(`link lookup gave up: ${kind} ${JSON.stringify(name)} had no answer in ${entry.attempts} tries over ${Math.round((now - entry.since) / 1000)} s (${reasons}); it stays plain text`);
	}

	/** A lookup of `name` was answered (found, none or several): its failures so far are not consecutive any more. */
	answered(kind: string, name: string): void {
		const entry = this.#entries.get(`${kind}\0${name}`);
		if (entry === undefined) return;
		entry.attempts = 0;
		entry.reasons.clear();
	}
}
