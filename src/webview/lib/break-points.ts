/**
 * Where a long path, URL or identifier may break across lines: after a `/` or `\`, and after a `.`, `_` or `-` only inside a
 * segment that is itself too long to read as one piece. The page inserts a `<wbr>` between the pieces: it adds no
 * character, so copying, selecting and every lookup keep the text exactly as written.
 */

/** A segment (the run between separators and spaces) longer than this may also break after `.`, `_` and `-`. */
export const LONG_SEGMENT = 20;

const isSlash = (character: string): boolean => character === "/" || character === "\\";
const isSoft = (character: string): boolean => character === "." || character === "_" || character === "-";

/** `text` cut into pieces whose concatenation is `text`; a `<wbr>` goes between neighbouring pieces. */
export function breakPieces(text: string): string[] {
	const cuts: number[] = [];
	let segmentStart = 0;
	const closeSegment = (end: number): void => {
		if (end - segmentStart > LONG_SEGMENT) {
			for (let index = segmentStart; index < end - 1; index++) {
				// Never between two separators: `..`, `__`, `-.`.
				if (isSoft(text[index]!) && !isSoft(text[index + 1]!)) cuts.push(index + 1);
			}
		}
	};
	for (let index = 0; index < text.length; index++) {
		const character = text[index]!;
		if (isSlash(character)) {
			closeSegment(index);
			segmentStart = index + 1;
			// Not between the two slashes of `https://` or `\\server`, and not at the very end.
			if (index + 1 < text.length && !isSlash(text[index + 1]!)) cuts.push(index + 1);
		} else if (/\s/.test(character)) {
			closeSegment(index);
			segmentStart = index + 1;
		}
	}
	closeSegment(text.length);
	cuts.sort((a, b) => a - b);
	const pieces: string[] = [];
	let start = 0;
	for (const cut of cuts) {
		if (cut <= start) continue;
		pieces.push(text.slice(start, cut));
		start = cut;
	}
	pieces.push(text.slice(start));
	return pieces;
}
