/**
 * Reads the text a place on the page shows, and puts a range on each character of the magic keywords found in it.
 *
 * The matcher (`shared/magic-keywords.ts`) works on a string; the page shows DOM. A scan walks the DOM once and returns the string
 * together with where each text node starts in it, so a keyword's characters map back to text nodes (a keyword may be split over
 * several: an IME or an inline element can do that). The scan only reads: it never changes the DOM it is given.
 *
 * What is not prose is not text to the scan: a chip of the composer (a command, a skill, an attachment) and the code, controls and icons
 * of a sent message stand as one space, so a keyword beside them still has its boundary and a keyword in them is never found.
 */
import type { MagicKeywordMatch } from "../../shared/magic-keywords.ts";
import { isChip } from "./draft-dom.ts";
import type { PlacedKeyword } from "./magic-keyword-paint.ts";

/** A text node and where its data starts in the scanned text. */
export interface TextSegment {
	readonly node: Text;
	readonly start: number;
	readonly end: number;
}

/** A place's text for the matcher, and the text nodes it came from. The text also holds separators that are in no node. */
export interface ScannedText {
	readonly text: string;
	readonly segments: readonly TextSegment[];
}

class TextBuilder {
	text = "";
	readonly segments: TextSegment[] = [];

	node(node: Text): void {
		const start = this.text.length;
		this.text += node.data;
		this.segments.push({ node, start, end: this.text.length });
	}

	/** A line break unless the text already ends in one: boundaries are all the matcher needs of a break. */
	separate(): void {
		if (this.text.length > 0 && !this.text.endsWith("\n")) this.text += "\n";
	}

	/** Something that is not prose: one space. */
	blank(): void {
		this.text += " ";
	}

	done(): ScannedText {
		return { text: this.text, segments: this.segments };
	}
}

const COMPOSER_BLOCKS = new Set(["DIV", "P"]);

/** The composer's draft as its DOM shows it: its lines, every chip as one space. Reads what an IME leaves behind as well as what the surface renders. */
export function scanComposer(root: HTMLElement): ScannedText {
	const builder = new TextBuilder();
	const walk = (parent: Node): void => {
		for (const child of parent.childNodes) {
			if (child.nodeType === Node.TEXT_NODE) builder.node(child as Text);
			else if (isChip(child)) builder.blank();
			else if (child.nodeName === "BR") builder.separate();
			else if (child.nodeType === Node.ELEMENT_NODE) {
				const block = COMPOSER_BLOCKS.has(child.nodeName);
				if (block) builder.separate();
				walk(child);
				if (block) builder.separate();
			}
		}
	};
	walk(root);
	return builder.done();
}

/** The Markdown a sent message renders: its content elements. */
const BUBBLE_SCOPE = ".omp-md";
/** Not prose, and never read: code (a match inside it is not a keyword), controls, icons, hidden and screen-reader text. */
const BUBBLE_SKIPPED = "button, input, textarea, select, script, style, pre, code, svg, .omp-sr-only, .codicon, [aria-hidden=true]";
const BUBBLE_BLOCKS = new Set(["P", "LI", "UL", "OL", "H1", "H2", "H3", "H4", "H5", "H6", "PRE", "BLOCKQUOTE", "TABLE", "TR", "TD", "TH", "DIV", "SECTION", "DETAILS", "HR", "BR"]);

/** The prose of a sent message's Markdown as the reader sees it: blocks and breaks are line breaks, code and controls one space. An inline element does not end a word. */
export function scanBubble(root: Element): ScannedText {
	const builder = new TextBuilder();
	const walk = (parent: Node): void => {
		for (const child of parent.childNodes) {
			if (child.nodeType === Node.TEXT_NODE) {
				builder.node(child as Text);
				continue;
			}
			if (!(child instanceof Element)) continue;
			const block = BUBBLE_BLOCKS.has(child.tagName);
			if (child.matches(BUBBLE_SKIPPED)) {
				if (block) builder.separate();
				else builder.blank();
				continue;
			}
			if (block) builder.separate();
			walk(child);
			if (block) builder.separate();
		}
	};
	for (const scope of root.querySelectorAll(BUBBLE_SCOPE)) {
		const outer = scope.parentElement?.closest(BUBBLE_SCOPE);
		if (outer !== null && outer !== undefined && root.contains(outer)) continue;
		builder.separate();
		walk(scope);
	}
	return builder.done();
}

/** The segment holding offset `at`, or `undefined` when no text node does (the offset is a separator). */
function segmentAt(segments: readonly TextSegment[], at: number): TextSegment | undefined {
	let low = 0;
	let high = segments.length - 1;
	while (low <= high) {
		const middle = (low + high) >> 1;
		const segment = segments[middle]!;
		if (at < segment.start) high = middle - 1;
		else if (at >= segment.end) low = middle + 1;
		else return segment;
	}
	return undefined;
}

/** A range on each character of each match; a match with a character in no text node (never the case for a word the matcher found) is dropped. */
export function placeKeywords(scanned: ScannedText, matches: readonly MagicKeywordMatch[]): PlacedKeyword[] {
	const placed: PlacedKeyword[] = [];
	for (const match of matches) {
		const chars: Range[] = [];
		for (let at = match.from; at < match.to; at++) {
			const segment = segmentAt(scanned.segments, at);
			if (segment === undefined) break;
			const range = segment.node.ownerDocument.createRange();
			range.setStart(segment.node, at - segment.start);
			range.setEnd(segment.node, at - segment.start + 1);
			chars.push(range);
		}
		if (chars.length === match.to - match.from) placed.push({ id: match.id, chars });
	}
	return placed;
}

/** Whether `[from, to)` lies in one text node. OMP paints a message one Markdown text run at a time, so a word that runs across elements is not one. */
export function withinOneNode(scanned: ScannedText, from: number, to: number): boolean {
	const segment = segmentAt(scanned.segments, from);
	return segment !== undefined && to <= segment.end;
}
