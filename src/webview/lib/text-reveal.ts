/**
 * Copyright (c) 2025-present Mohamed Boudra
 * Licensed under Apache-2.0; full license: licenses/paseo/LICENSE.
 * Adapted from Paseo packages/app/src/agent-stream/text-reveal.ts,
 * revision 5285b7e502714f2d08a220c328aedca3b9637b94.
 * Modified for OMP Desk / React DOM / VS Code theming, 2026-10-04:
 * cached suffix segmentation, uncertain trailing clusters and replacement flush.
 */
export const TEXT_REVEAL_HORIZON_MS = 150;
export const TEXT_REVEAL_FRAME_INTERVAL_MS = 1000 / 60;
const MAX_ELAPSED_MS = 250;

export function computeRevealStep(backlog: number, elapsedMs: number): number {
	if (backlog <= 0 || elapsedMs <= 0) return 0;
	const elapsed = Math.min(elapsedMs, MAX_ELAPSED_MS);
	return elapsed >= TEXT_REVEAL_HORIZON_MS ? backlog : Math.min(backlog, Math.max(1, Math.ceil(backlog * elapsed / TEXT_REVEAL_HORIZON_MS)));
}

export function nextTextRevealFrame(previous: number | null, timestamp: number): { elapsed: number; at: number } | null {
	const elapsed = previous === null ? TEXT_REVEAL_FRAME_INTERVAL_MS : timestamp - previous;
	return elapsed < TEXT_REVEAL_FRAME_INTERVAL_MS ? null : { elapsed, at: timestamp - elapsed % TEXT_REVEAL_FRAME_INTERVAL_MS };
}

const segmenter = typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;

/** A mounted slot's presentation state, never the canonical message store. */
export class TextReveal {
	#target: string;
	#visible: string;
	#released: number;
	#boundaries: number[] = [0];
	#stableLimit = 0;
	#indexed = false;
	readonly #segmenter: Intl.Segmenter | null;

	constructor(text: string, segmentation: Intl.Segmenter | null = segmenter) {
		this.#target = text;
		this.#visible = text; // Hydration/remount always paints everything already present.
		this.#released = text.length;
		this.#segmenter = segmentation;
	}

	get visible(): string { return this.#visible; }
	get pending(): boolean { return this.#released < this.#target.length; }

	retarget(text: string, pace: boolean): boolean {
		if (text === this.#target) return !pace ? this.flush() : false;
		const previous = this.#target;
		this.#target = text;
		if (!pace || this.#segmenter === null || !text.startsWith(previous)) {
			this.#boundaries = [0];
			this.#indexed = false;
			return this.flush();
		}
		// The final previous cluster may gain a mark, joiner or regional indicator.
		// All earlier boundaries remain valid; only that suffix is segmented again.
		if (!this.#indexed && previous.length > 0) {
			const tail = this.#segmenter.segment(previous).containing(previous.length - 1)?.index ?? 0;
			this.#boundaries = tail === 0 ? [0, previous.length] : [0, tail, previous.length];
		}
		const suffix = this.#boundaries.at(-2) ?? 0;
		while (this.#boundaries.length > 1 && this.#boundaries.at(-1)! > suffix) this.#boundaries.pop();
		this.#segmentSuffix(suffix);
		return false;
	}

	advance(elapsed: number): boolean {
		this.#released += computeRevealStep(this.#target.length - this.#released, elapsed);
		const maximum = Math.min(this.#released, this.#stableLimit);
		let low = 0, high = this.#boundaries.length;
		while (low < high) {
			const middle = (low + high) >>> 1;
			if (this.#boundaries[middle]! <= maximum) low = middle + 1;
			else high = middle;
		}
		const index = this.#boundaries[Math.max(0, low - 1)]!;
		// Never retract a hydrated prefix when its last cluster grows on arrival.
		if (index <= this.#visible.length) return false;
		this.#visible = this.#target.slice(0, index);
		return true;
	}

	flush(): boolean {
		this.#released = this.#target.length;
		if (this.#visible === this.#target) return false;
		this.#visible = this.#target;
		return true;
	}

	#segmentSuffix(start: number): void {
		if (this.#segmenter === null) { this.#stableLimit = this.#target.length; return; }
		this.#indexed = true;
		for (const part of this.#segmenter.segment(this.#target.slice(start))) {
			const end = start + part.index + part.segment.length;
			if (end > this.#boundaries.at(-1)!) this.#boundaries.push(end);
		}
		// Any trailing grapheme can extend in the next arrival (including a letter
		// followed by a combining mark). Hold it, not just visibly dangling ZWJs.
		this.#stableLimit = this.#boundaries.at(-2) ?? 0;
	}
}
