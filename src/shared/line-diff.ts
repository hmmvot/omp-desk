/**
 * A line diff for the quote of a hunk (docs/designs/2026-10-15-quote-chat-selection.md, decision 11): the lines of two versions of a
 * document, the blocks of changed lines between them, and the unified-diff text of one block with its context.
 *
 * VS Code gives an extension no API for the hunks its diff editor draws, so the blocks are computed here (Myers' O(ND) algorithm on
 * the lines left after the common head and tail). They are the minimal edit script, which VS Code's own diff (an advanced algorithm
 * that also moves blocks and, by default, ignores whitespace at the ends of lines) may group differently; the quote says what these
 * lines are, not what the editor drew. A pair too different or too large for the bounds below has no hunks: the caller falls back.
 *
 * Pure, no `vscode` import.
 */

/** Lines of one side that the diff accepts after the common head and tail are cut off; a larger pair has no hunks. */
export const MAX_DIFF_LINES = 20_000;
/** Edit distance (inserted plus deleted lines) the search goes to; a more different pair has no hunks. */
export const MAX_EDIT_DISTANCE = 1_000;
/** Unchanged lines shown before and after a changed block, when there are that many. */
export const HUNK_CONTEXT_LINES = 3;

/** A block of consecutive changed lines: `oldCount` lines of the original replaced by `newCount` lines of the modified text. Zero-based; either count may be 0. */
export interface LineChange {
	readonly oldStart: number;
	readonly oldCount: number;
	readonly newStart: number;
	readonly newCount: number;
}

/** The lines of a text, for either line end. The empty line after a final line break is not a line of the file, and an empty text has no lines. */
export function splitLines(text: string): string[] {
	const lines = text.split(/\r\n|\n|\r/);
	if (lines[lines.length - 1] === "") lines.pop();
	return lines;
}

/** Which lines of `a` are deleted and which of `b` are inserted, by Myers' algorithm; `null` beyond `MAX_EDIT_DISTANCE`. */
function editScript(a: readonly string[], b: readonly string[], from: number, aEnd: number, bEnd: number): { deleted: Uint8Array; inserted: Uint8Array } | null {
	const n = aEnd - from;
	const m = bEnd - from;
	const deleted = new Uint8Array(a.length);
	const inserted = new Uint8Array(b.length);
	if (n === 0 && m === 0) return { deleted, inserted };
	const max = Math.min(n + m, MAX_EDIT_DISTANCE);
	const offset = max + 1;
	const v = new Int32Array(2 * max + 3);
	const trace: Int32Array[] = [];
	for (let d = 0; d <= max; d++) {
		trace.push(v.slice());
		for (let k = -d; k <= d; k += 2) {
			let x = k === -d || (k !== d && (v[offset + k - 1] as number) < (v[offset + k + 1] as number)) ? (v[offset + k + 1] as number) : (v[offset + k - 1] as number) + 1;
			let y = x - k;
			while (x < n && y < m && a[from + x] === b[from + y]) {
				x++;
				y++;
			}
			v[offset + k] = x;
			if (x >= n && y >= m) {
				// Walk the snapshots back from (n, m): every step that is not a diagonal is one deleted or inserted line.
				let px = n;
				let py = m;
				for (let step = d; step > 0; step--) {
					const before = trace[step] as Int32Array;
					const here = px - py;
					const prevK = here === -step || (here !== step && (before[offset + here - 1] as number) < (before[offset + here + 1] as number)) ? here + 1 : here - 1;
					const prevX = before[offset + prevK] as number;
					const prevY = prevX - prevK;
					while (px > prevX && py > prevY) {
						px--;
						py--;
					}
					if (px === prevX) inserted[from + prevY] = 1;
					else deleted[from + prevX] = 1;
					px = prevX;
					py = prevY;
				}
				return { deleted, inserted };
			}
		}
	}
	return null;
}

/**
 * The blocks of changed lines between two versions, in order, or `null` when the pair is beyond the bounds. Two blocks are never
 * adjacent: one run of changed lines is one block, deletions and insertions together.
 */
export function diffLines(original: readonly string[], modified: readonly string[]): LineChange[] | null {
	let head = 0;
	while (head < original.length && head < modified.length && original[head] === modified[head]) head++;
	let tail = 0;
	while (tail < original.length - head && tail < modified.length - head && original[original.length - 1 - tail] === modified[modified.length - 1 - tail]) tail++;
	const aEnd = original.length - tail;
	const bEnd = modified.length - tail;
	if (aEnd - head > MAX_DIFF_LINES || bEnd - head > MAX_DIFF_LINES) return null;
	const script = editScript(original, modified, head, aEnd, bEnd);
	if (script === null) return null;
	const { deleted, inserted } = script;
	const changes: LineChange[] = [];
	let i = head;
	let j = head;
	while (i < aEnd || j < bEnd) {
		if (i < aEnd && j < bEnd && deleted[i] === 0 && inserted[j] === 0) {
			i++;
			j++;
			continue;
		}
		const oldStart = i;
		const newStart = j;
		while (i < aEnd && deleted[i] === 1) i++;
		while (j < bEnd && inserted[j] === 1) j++;
		changes.push({ oldStart, oldCount: i - oldStart, newStart, newCount: j - newStart });
	}
	return changes;
}

/** Which side of a diff a line number is on. */
export type DiffSide = "original" | "modified";

/** The index of the block that has changed line `line` (zero-based) on `side`, `-1` when that line is unchanged or the blocks only delete or only insert around it. */
export function changeAt(changes: readonly LineChange[], side: DiffSide, line: number): number {
	return changes.findIndex(change => {
		const start = side === "original" ? change.oldStart : change.newStart;
		const count = side === "original" ? change.oldCount : change.newCount;
		return line >= start && line < start + count;
	});
}

/** A block as a unified diff, with the lines it covers on each side (one-based, inclusive; `null` when that side has none of its lines in it). */
export interface Hunk {
	readonly text: string;
	readonly original: { readonly start: number; readonly end: number } | null;
	readonly modified: { readonly start: number; readonly end: number } | null;
}

/**
 * The hunk of `changes[index]`: its unchanged lines before (up to `context`, never lines of the neighbouring block), the deleted
 * lines each after `-`, the inserted lines each after `+`, then the unchanged lines after. The lines of a context row start with a
 * space, as in `diff -u`. There is no `@@` header: the location line names the lines of both sides.
 */
export function hunkOf(original: readonly string[], modified: readonly string[], changes: readonly LineChange[], index: number, context = HUNK_CONTEXT_LINES): Hunk {
	const change = changes[index] as LineChange;
	const previous = changes[index - 1];
	const next = changes[index + 1];
	const before = Math.min(context, change.newStart - (previous === undefined ? 0 : previous.newStart + previous.newCount));
	const after = Math.min(context, (next === undefined ? modified.length : next.newStart) - (change.newStart + change.newCount));
	const rows: string[] = [];
	for (let i = change.newStart - before; i < change.newStart; i++) rows.push(` ${modified[i]}`);
	for (let i = change.oldStart; i < change.oldStart + change.oldCount; i++) rows.push(`-${original[i]}`);
	for (let i = change.newStart; i < change.newStart + change.newCount; i++) rows.push(`+${modified[i]}`);
	const end = change.newStart + change.newCount;
	for (let i = end; i < end + after; i++) rows.push(` ${modified[i]}`);
	const oldCount = before + change.oldCount + after;
	const newCount = before + change.newCount + after;
	return {
		text: rows.join("\n"),
		original: oldCount === 0 ? null : { start: change.oldStart - before + 1, end: change.oldStart - before + oldCount },
		modified: newCount === 0 ? null : { start: change.newStart - before + 1, end: change.newStart - before + newCount },
	};
}

/**
 * The hunk that has line `line` (zero-based) of `side` among its changed lines, `null` when that line is unchanged, a block only
 * deletes (or only inserts) at that place, or the pair is beyond the bounds of {@link diffLines}.
 */
export function hunkAtLine(originalText: string, modifiedText: string, side: DiffSide, line: number): Hunk | null {
	const original = splitLines(originalText);
	const modified = splitLines(modifiedText);
	const changes = diffLines(original, modified);
	if (changes === null) return null;
	const index = changeAt(changes, side, line);
	return index < 0 ? null : hunkOf(original, modified, changes, index);
}
