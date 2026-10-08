/**
 * Keeps every change to the emulator in the order the bytes arrived.
 *
 * xterm.js parses what `write` is given later, in slices, and a hidden or busy document
 * (a minimized window throttles its timers to about one slice a second) can hold a large
 * backlog of bytes it has accepted but not parsed. `reset()` and `resize()` act at once, so
 * run while that backlog exists they happen *before* the older bytes are parsed: the old screen
 * is parsed onto the fresh one and the restored snapshot lands after it (two copies of the
 * screen), or bytes OMP drew for one grid are parsed at another and its relative cursor moves
 * land on the wrong rows.
 *
 * This surface holds a reset or a resize until every byte written before it has been parsed,
 * and holds every byte written after it until the change has been applied. With nothing
 * pending it is a pass-through, so a quiet terminal costs nothing.
 */

/** The emulator operations this surface orders. */
export interface OrderedTarget {
	/** Accept bytes; `done` runs once they have been parsed. */
	write(bytes: Uint8Array, done: () => void): void;
	reset(): void;
	resize(cols: number, rows: number): void;
}

type Pending =
	| { readonly kind: "write"; readonly bytes: Uint8Array }
	| { readonly kind: "change"; readonly apply: () => void };

export class OrderedTerminalSurface {
	readonly #target: OrderedTarget;
	readonly #queue: Pending[] = [];
	#parsing = 0;
	#disposed = false;

	constructor(target: OrderedTarget) {
		this.#target = target;
	}

	/** Bytes accepted but not yet parsed, plus changes still waiting for them. */
	get pending(): number {
		return this.#parsing + this.#queue.length;
	}

	write(bytes: Uint8Array): void {
		this.#submit({ kind: "write", bytes });
	}

	/** A new screen starts after everything written so far has been parsed. */
	reset(): void {
		this.#submit({ kind: "change", apply: () => this.#target.reset() });
	}

	/** Grid change taking effect between the bytes written before and after it. */
	resize(cols: number, rows: number): void {
		this.#submit({ kind: "change", apply: () => this.#target.resize(cols, rows) });
	}

	dispose(): void {
		this.#disposed = true;
		this.#queue.length = 0;
	}

	#submit(item: Pending): void {
		if (this.#disposed) return;
		this.#queue.push(item);
		this.#drain();
	}

	#drain(): void {
		while (!this.#disposed) {
			const next = this.#queue[0];
			if (next === undefined) return;
			if (next.kind === "change") {
				// Older bytes are still being parsed: the change runs when the last one finishes.
				if (this.#parsing > 0) return;
				this.#queue.shift();
				next.apply();
				continue;
			}
			this.#queue.shift();
			this.#parsing += 1;
			this.#target.write(next.bytes, () => {
				this.#parsing -= 1;
				this.#drain();
			});
		}
	}
}
