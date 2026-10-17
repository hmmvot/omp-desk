/**
 * The DOM half of Find in the conversation: the text a mounted row shows, the occurrences of the query in it, and their paint.
 *
 * Occurrences are painted with the CSS Custom Highlight API (`::highlight(omp-find)` and `::highlight(omp-find-current)`), so
 * the transcript's DOM is never changed to mark a match: React's rows, the windowing and the reader's selection stay as they are.
 * Where the API is missing nothing is painted, and the current row is outlined instead (`data-find-current`).
 */

/** What Find reads of a row: its content elements, not its buttons, labels or status text. */
const SCOPE = ".omp-md, .omp-tool-name, .omp-tool-digest, .omp-tool-aux--intent, .omp-tool-body";
/** Never read: controls, hidden and screen-reader text, icons, the output bars, and rows nested inside this one (a child agent's transcript). */
const SKIPPED = "button, input, textarea, select, script, style, .omp-sr-only, .codicon, [aria-hidden=true], .omp-output-bar, .omp-tool-toolbar, [data-find-id]";
const BLOCKS = new Set(["P", "LI", "UL", "OL", "H1", "H2", "H3", "H4", "H5", "H6", "PRE", "BLOCKQUOTE", "TABLE", "TR", "TD", "TH", "DIV", "SECTION", "DETAILS", "HR"]);

export const FIND_HIGHLIGHT = "omp-find";
export const FIND_CURRENT_HIGHLIGHT = "omp-find-current";

/** The text of one row and where each of its text nodes starts in it. */
export interface RowText {
	readonly text: string;
	readonly nodes: readonly { readonly node: Text; readonly start: number }[];
}

/** The row's searched text. Blocks, line breaks and separate content elements are separated by a newline, as the model's text is. */
export function rowText(row: Element): RowText {
	let text = "";
	const nodes: { node: Text; start: number }[] = [];
	const separate = (): void => { if (text.length > 0 && !text.endsWith("\n")) text += "\n"; };
	for (const scope of row.querySelectorAll(SCOPE)) {
		const outer = scope.parentElement?.closest(SCOPE);
		if (outer !== null && outer !== undefined && row.contains(outer)) continue;
		if (scope.matches(SKIPPED)) continue;
		separate();
		const walker = document.createTreeWalker(scope, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
			acceptNode: node => node instanceof Element && node.matches(SKIPPED) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
		});
		for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
			if (node instanceof Text) {
				nodes.push({ node, start: text.length });
				text += node.data;
			} else if (node instanceof Element && (node.tagName === "BR" || BLOCKS.has(node.tagName))) separate();
		}
	}
	return { text, nodes };
}

/** The ranges of every occurrence of `pattern` in `row`, in order. */
export function rangesIn(row: RowText, pattern: RegExp): Range[] {
	const ranges: Range[] = [];
	const nodeAt = (offset: number): number => {
		let low = 0, high = row.nodes.length - 1;
		while (low < high) {
			const middle = (low + high + 1) >> 1;
			if (row.nodes[middle]!.start <= offset) low = middle; else high = middle - 1;
		}
		return low;
	};
	pattern.lastIndex = 0;
	for (let match = pattern.exec(row.text); match !== null; match = pattern.exec(row.text)) {
		if (row.nodes.length === 0) break;
		const first = row.nodes[nodeAt(match.index)]!, last = row.nodes[nodeAt(match.index + match[0].length - 1)]!;
		const range = document.createRange();
		range.setStart(first.node, match.index - first.start);
		range.setEnd(last.node, match.index + match[0].length - last.start);
		ranges.push(range);
	}
	return ranges;
}

/** Whether this page can paint occurrences without touching the DOM. */
export function canHighlight(): boolean {
	return typeof Highlight === "function" && typeof CSS !== "undefined" && "highlights" in CSS;
}

/** Paint `all` (and `current` over them); with no ranges both highlights are removed. */
export function paintFind(all: readonly Range[], current: Range | null): void {
	if (!canHighlight()) return;
	if (all.length === 0) CSS.highlights.delete(FIND_HIGHLIGHT); else CSS.highlights.set(FIND_HIGHLIGHT, new Highlight(...all));
	if (current === null) { CSS.highlights.delete(FIND_CURRENT_HIGHLIGHT); return; }
	const mark = new Highlight(current);
	mark.priority = 1;
	CSS.highlights.set(FIND_CURRENT_HIGHLIGHT, mark);
}
