/**
 * Added and removed line counts of an edit call, shared by the collapsed tool head (`toolPresentation`)
 * and the expanded Edit view, so both faces say the same numbers from the same inputs.
 */
import { isRecord } from "../shared/guards.ts";

export interface DiffStats { added: number; removed: number }

/** Counts of `+` and `-` content lines in unified diffs; the `+++`/`---` file headers are not content. */
export function diffStats(diffs: Iterable<unknown>): DiffStats {
	let added = 0;
	let removed = 0;
	for (const diff of diffs) {
		if (typeof diff !== "string") continue;
		for (const line of diff.split("\n")) {
			if (line.startsWith("+") && !line.startsWith("+++")) added++;
			else if (line.startsWith("-") && !line.startsWith("---")) removed++;
		}
	}
	return { added, removed };
}

const records = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.filter(isRecord) : [];
const record = (value: unknown): Record<string, unknown> => isRecord(value) ? value : {};

/**
 * The diffs an edit call is currently showing: its per-file results, else the files being streamed, else the one
 * diff of a single-file call (a settled call's own `diff`; a running one's preview or argument diff).
 *
 * @returns `null` while there is nothing to count, so a running call with no diff yet shows no `+0 −0`.
 */
export function editDiffStats(call: { args: Record<string, unknown>; details: Record<string, unknown>; stream: Record<string, unknown>; settled: boolean }): DiffStats | null {
	const { args, details, stream, settled } = call;
	const perFile = records(details.perFileResults);
	const streamed = settled ? [] : records(stream.files).length > 0 ? records(stream.files) : records(stream.perFileDiffPreview);
	const files = perFile.length > 0 ? perFile : streamed;
	const diffs = files.length > 0 ? files.map(file => file.diff) : [settled ? details.diff : details.diff ?? record(stream.editDiffPreview).diff ?? args.previewDiff ?? args.diff];
	const stats = diffStats(diffs);
	return stats.added + stats.removed > 0 ? stats : null;
}
