/**
 * The line diff and the hunk text of a quote from a diff editor.
 *
 * Runner: `node --test src/shared/line-diff.test.ts`
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { changeAt, diffLines, hunkAtLine, hunkOf, MAX_DIFF_LINES, MAX_EDIT_DISTANCE, splitLines } from "./line-diff.ts";
import type { LineChange } from "./line-diff.ts";

const lines = (text: string): string[] => splitLines(text);

/** The modified lines rebuilt from the original and the blocks: proves the blocks are a valid edit script. */
function apply(original: readonly string[], modified: readonly string[], changes: readonly LineChange[]): string[] {
	const out: string[] = [];
	let at = 0;
	for (const change of changes) {
		out.push(...original.slice(at, change.oldStart), ...modified.slice(change.newStart, change.newStart + change.newCount));
		at = change.oldStart + change.oldCount;
	}
	out.push(...original.slice(at));
	return out;
}

/** The length of the longest common subsequence, by dynamic programming: the reference for the minimal edit distance. */
function lcs(a: readonly string[], b: readonly string[]): number {
	const row = new Array<number>(b.length + 1).fill(0);
	for (let i = 1; i <= a.length; i++) {
		let diagonal = 0;
		for (let j = 1; j <= b.length; j++) {
			const above = row[j] as number;
			row[j] = a[i - 1] === b[j - 1] ? diagonal + 1 : Math.max(above, row[j - 1] as number);
			diagonal = above;
		}
	}
	return row[b.length] as number;
}

describe("the blocks of changed lines", () => {
	it("has none for equal texts and one block for a replaced line", () => {
		assert.deepEqual(diffLines(lines("a\nb\nc"), lines("a\nb\nc")), []);
		assert.deepEqual(diffLines(lines("a\nb\nc"), lines("a\nB\nc")), [{ oldStart: 1, oldCount: 1, newStart: 1, newCount: 1 }]);
	});

	it("is one block for a run of changed lines, deletions and insertions together", () => {
		assert.deepEqual(diffLines(lines("a\nb\nc\nd\ne"), lines("a\nX\nY\nZ\ne")), [{ oldStart: 1, oldCount: 3, newStart: 1, newCount: 3 }]);
		assert.deepEqual(diffLines(lines("a\nb\nc\nd"), lines("a\nd")), [{ oldStart: 1, oldCount: 2, newStart: 1, newCount: 0 }]);
		assert.deepEqual(diffLines(lines("a\nd"), lines("a\nb\nc\nd")), [{ oldStart: 1, oldCount: 0, newStart: 1, newCount: 2 }]);
	});

	it("separates blocks that unchanged lines divide", () => {
		assert.deepEqual(diffLines(lines("a\nb\nc\nd\ne"), lines("A\nb\nc\nd\nE")), [
			{ oldStart: 0, oldCount: 1, newStart: 0, newCount: 1 },
			{ oldStart: 4, oldCount: 1, newStart: 4, newCount: 1 },
		]);
	});

	it("is an edit script of the least length, over every pair of small random texts", () => {
		let seed = 7;
		const random = (n: number): number => {
			seed = (seed * 1103515245 + 12345) & 0x7fffffff;
			return seed % n;
		};
		const alphabet = ["a", "b", "c", "d", ""];
		for (let round = 0; round < 3000; round++) {
			const original = Array.from({ length: random(9) }, () => alphabet[random(alphabet.length)] as string);
			const modified = Array.from({ length: random(9) }, () => alphabet[random(alphabet.length)] as string);
			const changes = diffLines(original, modified);
			assert.ok(changes !== null);
			assert.deepEqual(apply(original, modified, changes), modified, `${JSON.stringify(original)} to ${JSON.stringify(modified)}`);
			const edits = changes.reduce((sum, change) => sum + change.oldCount + change.newCount, 0);
			assert.equal(edits, original.length + modified.length - 2 * lcs(original, modified), "minimal");
			for (let i = 1; i < changes.length; i++) {
				const before = changes[i - 1] as LineChange;
				const block = changes[i] as LineChange;
				assert.ok(block.oldStart > before.oldStart + before.oldCount && block.newStart > before.newStart + before.newCount, "never adjacent");
			}
		}
	});

	it("gives up beyond its bounds and answers a large, similar pair", () => {
		const many = Array.from({ length: MAX_DIFF_LINES + 1 }, (_, i) => `line ${i}`);
		assert.equal(diffLines(many, many.map(line => `${line}!`)), null, "too many lines");
		const far = Array.from({ length: MAX_EDIT_DISTANCE + 10 }, (_, i) => `x${i}`);
		assert.equal(diffLines(far, far.map(line => `y${line}`)), null, "too different");
		const big = Array.from({ length: 15_000 }, (_, i) => `line ${i}`);
		const edited = [...big];
		edited[7_000] = "changed";
		assert.deepEqual(diffLines(big, edited), [{ oldStart: 7_000, oldCount: 1, newStart: 7_000, newCount: 1 }]);
	});
});

describe("the hunk of a block", () => {
	const original = lines("one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten");
	const modified = lines("one\ntwo\nthree\nfour\nFIVE\nfive and a half\nsix\nseven\neight\nnine\nten");

	it("is the deleted lines after -, the inserted after + and up to three unchanged lines each side after a space", () => {
		const changes = diffLines(original, modified) as LineChange[];
		assert.equal(changes.length, 1);
		assert.deepEqual(hunkOf(original, modified, changes, 0), {
			text: " two\n three\n four\n-five\n+FIVE\n+five and a half\n six\n seven\n eight",
			original: { start: 2, end: 8 },
			modified: { start: 2, end: 9 },
		});
	});

	it("takes fewer context lines at the ends of the file and between near blocks, never a line of the next block", () => {
		const a = lines("a\nb\nc\nd\ne");
		const b = lines("A\nb\nc\nD\ne");
		const changes = diffLines(a, b) as LineChange[];
		assert.deepEqual(hunkOf(a, b, changes, 0), { text: "-a\n+A\n b\n c", original: { start: 1, end: 3 }, modified: { start: 1, end: 3 } });
		assert.deepEqual(hunkOf(a, b, changes, 1), { text: " b\n c\n-d\n+D\n e", original: { start: 2, end: 5 }, modified: { start: 2, end: 5 } });
	});

	it("names no line of a side that has none: a file deleted whole, a file created whole", () => {
		assert.deepEqual(hunkAtLine("x\ny", "", "original", 0), { text: "-x\n-y", original: { start: 1, end: 2 }, modified: null });
		assert.deepEqual(hunkAtLine("", "x\n", "modified", 0), { text: "+x", original: null, modified: { start: 1, end: 1 } });
	});
});

describe("the hunk under a line", () => {
	const before = "a\nb\nc\nd\ne\n";
	const after = "a\nB\nc\nd\ne\nf\n";
	it("is found from a changed line of either side and from no other", () => {
		const modifiedSide = hunkAtLine(before, after, "modified", 1);
		assert.ok(modifiedSide !== null);
		assert.equal(modifiedSide.text, " a\n-b\n+B\n c\n d\n e");
		assert.deepEqual(hunkAtLine(before, after, "original", 1), modifiedSide, "the same hunk from the original side");
		assert.equal(hunkAtLine(before, after, "modified", 2), null, "an unchanged line");
		assert.equal(hunkAtLine(before, after, "modified", 0), null, "a context line is no changed line");
		assert.equal(hunkAtLine(before, after, "original", 5), null, "a line past the end");
		assert.equal(hunkAtLine(before, after, "modified", 5)?.text, " c\n d\n e\n+f", "an inserted line, with its context");
		assert.equal(hunkAtLine(before, after, "modified", 6), null, "the empty line the editor shows after the final line break is no line");
	});

	it("does not see a pure deletion from the modified side, where no line is changed", () => {
		assert.equal(hunkAtLine("a\nb\nc", "a\nc", "modified", 1), null);
		assert.equal(hunkAtLine("a\nb\nc", "a\nc", "original", 1)?.text, " a\n-b\n c");
	});

	it("treats every line end alike and finds a changed block by changeAt", () => {
		assert.equal(hunkAtLine("a\r\nb\r\n", "a\nB\n", "modified", 1)?.text, " a\n-b\n+B");
		assert.equal(changeAt([{ oldStart: 2, oldCount: 0, newStart: 2, newCount: 2 }], "original", 2), -1);
		assert.equal(changeAt([{ oldStart: 2, oldCount: 0, newStart: 2, newCount: 2 }], "modified", 3), 0);
	});
});
