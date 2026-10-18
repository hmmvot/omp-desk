/**
 * The fork source of a draft that was opened to be a fork (`docs/designs/2026-10-18-fork-branch-clear-session-actions.md`).
 *
 * A fork is a new Desk session whose process starts with `omp --fork <source session file>`. The launch of a fileless draft
 * reads the source here, by tab id, and passes it on; nothing else about the draft differs from a new session. The registry
 * is memory only. A fork process that fails before the row has a file leaves a fileless draft, and the next launch of that
 * draft forks again, so the source is kept until a launch finds the row materialized (or native) and drops it; once the row
 * has a file, or is gone, the entry is never read again.
 */
export class PendingForks {
	readonly #sources = new Map<string, string>();

	/** Remember that the draft `tabId` is a fork of `sourceFile`. */
	register(tabId: string, sourceFile: string): void {
		this.#sources.set(tabId, sourceFile);
	}

	/** The source the next launch of `tabId` forks, or `null` for an ordinary draft. */
	peek(tabId: string): string | null {
		return this.#sources.get(tabId) ?? null;
	}

	/** The fork ended: the row has a file, runs natively, or was abandoned. */
	forget(tabId: string): void {
		this.#sources.delete(tabId);
	}

	get size(): number {
		return this.#sources.size;
	}
}
