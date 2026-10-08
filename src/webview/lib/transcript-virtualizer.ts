/** Loaded presentation rows and their measured geometry; never owns scrolling or semantic admission. */
export interface MeasuredRow {
	id: string;
	sources: readonly string[];
	revision: readonly unknown[];
	estimate: number;
	/** Append-only growth (a streaming reply): the previous measured height stays the estimate across revisions, so a live row never snaps back to a text-length guess. */
	growing?: boolean;
}
export interface RowRange { start: number; end: number }
export interface HeightLayout { offsets: Float64Array; total: number }
interface Measurement { context: string; revision: readonly unknown[]; height: number | null }

export class TranscriptHeightIndex {
	#measurements = new Map<string, Measurement>();
	update(rows: readonly MeasuredRow[], context: string): HeightLayout {
		const offsets = new Float64Array(rows.length + 1), present = new Set<string>();
		for (let index = 0; index < rows.length; index++) {
			const row = rows[index]!; present.add(row.id);
			let measurement = this.#measurements.get(row.id);
			if (measurement && measurement.context === context && row.growing && measurement.height !== null) { measurement.revision = row.revision; }
			else if (!measurement || measurement.context !== context || measurement.revision.length !== row.revision.length || measurement.revision.some((value, slot) => value !== row.revision[slot])) {
				measurement = { context, revision: row.revision, height: null }; this.#measurements.set(row.id, measurement);
			}
			offsets[index + 1] = offsets[index]! + Math.max(1, measurement.height ?? row.estimate);
		}
		for (const id of this.#measurements.keys()) if (!present.has(id)) this.#measurements.delete(id);
		return { offsets, total: offsets[rows.length]! };
	}
	measure(id: string, height: number): boolean {
		const measurement = this.#measurements.get(id);
		if (!measurement || !Number.isFinite(height) || height <= 0 || measurement.height !== null && Math.abs(measurement.height - height) < 0.5) return false;
		measurement.height = height; return true;
	}
}

/** First row whose bottom exceeds a position, in logarithmic time. */
export function rowAt(offsets: Float64Array, position: number): number {
	let low = 0, high = offsets.length - 1;
	while (low < high) { const middle = (low + high) >>> 1; if (offsets[middle + 1]! <= position) low = middle + 1; else high = middle; }
	return Math.min(low, Math.max(0, offsets.length - 2));
}

/** One viewport of overscan on either side, plus isolated interaction exceptions, not a growing span. */
export function visibleRowRanges(layout: HeightLayout, top: number, height: number, held: readonly number[] = []): readonly RowRange[] {
	const count = layout.offsets.length - 1;
	if (!count) return [];
	const viewport = Math.max(1, height), start = rowAt(layout.offsets, Math.max(0, top - viewport));
	const end = Math.min(count, rowAt(layout.offsets, Math.min(layout.total, top + viewport * 2)) + 1);
	const ranges: RowRange[] = [{ start, end }, ...held.filter(index => index >= 0 && index < count).map(index => ({ start: index, end: index + 1 }))];
	ranges.sort((left, right) => left.start - right.start);
	const merged: RowRange[] = [];
	for (const range of ranges) { const prior = merged.at(-1); if (prior && range.start <= prior.end) prior.end = Math.max(prior.end, range.end); else merged.push({ ...range }); }
	return merged;
}
