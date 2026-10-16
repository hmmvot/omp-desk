/**
 * Reading a text selection of the Chat as quotable Markdown (docs/designs/2026-10-15-quote-chat-selection.md, Sections 3 and 8): the
 * DOM half. It walks the rendered messages the Range crosses, measures which part of each leaf block the Range covers, and hands
 * the leaves to `quote-capture.ts`. Everything the Range crosses that is not a quotable message (tool rows, output, notices,
 * buttons) contributes nothing, and the page never reads `innerText`.
 */
import { joinSurfaces, quoteSurface, type LeafPick, type QuotedMarkdown } from "./quote-capture.ts";
import { registeredMarkdown } from "./markdown-leaves.ts";
import { requestQuote } from "./quote-sink.ts";
import type { Leaf } from "./markdown-leaves.ts";

export const NOTHING_SELECTED = "Select text in the conversation first";
export const NOTHING_QUOTABLE = "That selection has no message text to quote";

export type SelectionQuote =
	| { readonly kind: "quote"; readonly source: string; readonly plain: boolean }
	| { readonly kind: "none"; readonly message: string };

const EDITABLE = "input, textarea, select, [contenteditable]:not([contenteditable='false'])";

function elementOf(node: Node): Element | null {
	return node instanceof Element ? node : node.parentElement;
}

/** The range of the selection that may be quoted: non-collapsed, with both ends in `region` and nothing editable touched; `null` otherwise. */
export function quotableRange(selection: Selection | null, region: Element): Range | null {
	if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) return null;
	const range = selection.getRangeAt(0);
	if (range.collapsed || !region.contains(range.startContainer) || !region.contains(range.endContainer)) return null;
	if (elementOf(range.startContainer)?.closest(EDITABLE) || elementOf(range.endContainer)?.closest(EDITABLE)) return null;
	for (const field of region.querySelectorAll(EDITABLE)) if (range.intersectsNode(field)) return null;
	return range;
}

/** Whether `range` has text of `node` strictly inside it (an edge that only touches the node does not count). */
function crosses(range: Range, node: Node): boolean {
	const whole = document.createRange();
	whole.selectNode(node);
	return range.compareBoundaryPoints(Range.START_TO_END, whole) > 0 && range.compareBoundaryPoints(Range.END_TO_START, whole) < 0;
}

/** The part `[from, to)` of the text of `host` that `range` covers. */
function coveredText(range: Range, host: Element): { from: number; to: number; text: string } {
	const inner = document.createRange();
	inner.selectNodeContents(host);
	const text = host.textContent ?? "";
	let from = 0;
	let to = text.length;
	if (range.compareBoundaryPoints(Range.START_TO_START, inner) > 0) {
		const before = document.createRange();
		before.setStart(inner.startContainer, inner.startOffset);
		before.setEnd(range.startContainer, range.startOffset);
		from = before.toString().length;
	}
	if (range.compareBoundaryPoints(Range.END_TO_END, inner) < 0) {
		const upTo = document.createRange();
		upTo.setStart(inner.startContainer, inner.startOffset);
		upTo.setEnd(range.endContainer, range.endOffset);
		to = upTo.toString().length;
	}
	return { from, to, text };
}

/** A leaf the page has no record of: its shown text is all there is, so it degrades to that text. */
function unknownLeaf(id: number): Leaf {
	return { id, kind: "text", lines: [], first: Number.NEGATIVE_INFINITY, last: Number.NEGATIVE_INFINITY, emphasis: true };
}

function picksOf(range: Range, root: Element, leaves: readonly Leaf[]): LeafPick[] {
	const picks: LeafPick[] = [];
	for (const element of root.querySelectorAll("[data-md-leaf]")) {
		if (!crosses(range, element)) continue;
		const id = Number(element.getAttribute("data-md-leaf"));
		const leaf = leaves[id] ?? unknownLeaf(id);
		if (leaf.kind === "rule" || leaf.kind === "row") {
			picks.push({ leaf, text: "", from: 0, to: 0 });
			continue;
		}
		// A drawn mermaid diagram has no code element and contributes nothing.
		const host = leaf.kind === "code" ? element.querySelector("code") : element;
		if (host === null) continue;
		const covered = coveredText(range, host);
		if (covered.to > covered.from) picks.push({ leaf, ...covered });
	}
	return picks;
}

/** The Markdown of the selection: every quotable message the Range crosses contributes the covered part of its source. */
export function captureSelection(selection: Selection | null, region: Element): SelectionQuote {
	const range = quotableRange(selection, region);
	if (range === null || range.toString().trim().length === 0) return { kind: "none", message: NOTHING_SELECTED };
	const surfaces: QuotedMarkdown[] = [];
	for (const root of region.querySelectorAll(".omp-md")) {
		const registered = registeredMarkdown(root);
		if (registered === undefined || !crosses(range, root)) continue;
		const picks = picksOf(range, root, registered.leaves);
		if (picks.length > 0) surfaces.push(quoteSurface(registered.text.split(/\r?\n/), picks));
	}
	const joined = joinSurfaces(surfaces);
	return joined.markdown.trim().length === 0 ? { kind: "none", message: NOTHING_QUOTABLE } : { kind: "quote", source: joined.markdown, plain: joined.plain };
}

/**
 * The one page function every trigger of "quote the selection" calls (the host's `quote-selection` action, which `Alt+Q`
 * and the context menu item both post): reads the selection of the transcript region and hands the composer a quote, or the words that say why
 * there is none. `false` when no composer is mounted.
 */
export function quoteSelectionIntoDraft(): boolean {
	const region = document.querySelector(".omp-transcript");
	const captured: SelectionQuote = region === null ? { kind: "none", message: NOTHING_SELECTED } : captureSelection(window.getSelection(), region);
	return requestQuote(captured.kind === "quote" ? { kind: "selection", source: captured.source, plain: captured.plain } : { kind: "nothing", message: captured.message });
}
