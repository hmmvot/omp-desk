/** An existing file stays a link for this long; the host re-stats on activation anyway. */
const VALID_TTL_MS = 30_000;
/** A miss is retried soon so a file the agent has just written becomes clickable. */
const INVALID_TTL_MS = 5_000;
const MAX_CACHED_TARGETS = 2048;

/**
 * Host validations keyed by the exact link text. One cache serves one pane or one chat
 * document, and its cwd is host-owned and fixed for that lifetime, so text alone identifies the file.
 *
 * xterm re-queries `provideLinks` whenever the hovered row repaints, which a live TUI does
 * continuously. A host round trip per query tears the hovered link down and rebuilds it
 * after the reply: the cursor flips between pointer and I-beam and a click lands in the gap.
 * Answering from the cache lets the replacement link appear in the same task as the old
 * one is removed. The Chat renders the same way: a message that remounts shows its links at
 * once instead of flashing plain text.
 */
export class ValidationCache {
	readonly #entries = new Map<string, { valid: boolean; expires: number }>();
	readonly #pending = new Map<string, Promise<boolean>>();
	readonly #validate: (target: string) => Promise<boolean>;
	readonly #now: () => number;
	constructor(validate: (target: string) => Promise<boolean>, now: () => number) { this.#validate = validate; this.#now = now; }
	/** The fresh result, or `undefined` when the host must be asked. */
	peek(target: string): boolean | undefined {
		const entry = this.#entries.get(target);
		if (entry === undefined) return undefined;
		if (entry.expires <= this.#now()) { this.#entries.delete(target); return undefined; }
		return entry.valid;
	}
	/** One in-flight host request per target, however many rows or re-queries want it. */
	resolve(target: string): Promise<boolean> {
		const known = this.peek(target);
		if (known !== undefined) return Promise.resolve(known);
		let pending = this.#pending.get(target);
		if (pending === undefined) {
			pending = this.#validate(target).catch(() => false).then(valid => {
				this.#pending.delete(target);
				if (this.#entries.size >= MAX_CACHED_TARGETS) this.#entries.clear();
				this.#entries.set(target, { valid, expires: this.#now() + (valid ? VALID_TTL_MS : INVALID_TTL_MS) });
				return valid;
			});
			this.#pending.set(target, pending);
		}
		return pending;
	}
}
