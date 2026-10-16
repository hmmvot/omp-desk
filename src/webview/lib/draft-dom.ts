/**
 * The DOM side of the composer's editing surface (docs/designs/2026-10-15-composer-contenteditable-surface.md,
 * sections 1 and 6): how a draft string is rendered as one element per line, and how model offsets and DOM points
 * map to each other. Every function takes the root element, so the surface and the tests share one mapping.
 *
 * A rendered line is `div.omp-line` holding text nodes and image chips (`span.omp-chip`, a non-editable inline
 * element whose text is the literal marker). An empty line is a lone `<br>`; a line that ends in a chip carries a
 * trailing `<br>` so the caret has a position after it. That `<br>` is a rendering filler and never part of the model.
 */
import type { FencedBlock } from "./code-fence.ts";
import type { ReferenceKind, ReferenceSpan } from "./image-references.ts";
import type { QuoteLineFlags } from "./quote-lines.ts";

export const LINE_CLASS = "omp-line";
export const CODE_LINE_CLASS = "omp-line--code";
export const FENCE_LINE_CLASS = "omp-line--fence";
export const QUOTE_LINE_CLASS = "omp-line--quote";
export const QUOTE_CODE_LINE_CLASS = "omp-line--quote-code";
export const CHIP_CLASS = "omp-chip";
/** The modifier of a file's chip: the same atomic element with a file icon (`data-kind="file"`). */
export const FILE_CHIP_CLASS = "omp-chip--file";

/** A marker inside one line, with line-relative offsets. */
export interface ChipSpec {
	readonly start: number;
	readonly end: number;
	readonly kind: ReferenceKind;
	readonly number: number;
}

/** What one rendered line must show. */
export interface LineSpec {
	readonly text: string;
	/** The line belongs to a fenced block (fence lines included). */
	readonly code: boolean;
	/** The line is the opening or the closing fence. */
	readonly fence: boolean;
	/** The line is a quote line (it starts with `>`, outside every fenced block). */
	readonly quote: boolean;
	/** The line is inside a fenced block nested in a quote: the code font, no band of its own. */
	readonly quoteCode: boolean;
	readonly chips: readonly ChipSpec[];
}

/** Splits `text` into the lines the surface renders, with their block and quote status and the markers each holds; `quotes` has one entry per line. */
export function lineSpecs(text: string, blocks: readonly FencedBlock[], spans: readonly ReferenceSpan[], quotes: readonly QuoteLineFlags[]): LineSpec[] {
	const specs: LineSpec[] = [];
	let lineStart = 0;
	let block = 0;
	let span = 0;
	for (;;) {
		const newline = text.indexOf("\n", lineStart);
		const lineEnd = newline < 0 ? text.length : newline;
		while (block < blocks.length && blocks[block]!.end < lineStart) block++;
		const current = block < blocks.length ? blocks[block]! : null;
		const code = current !== null && lineStart >= current.start && lineStart <= current.end;
		while (span < spans.length && spans[span]!.end <= lineStart) span++;
		const chips: ChipSpec[] = [];
		for (let index = span; index < spans.length && spans[index]!.start < lineEnd; index++) {
			const marker = spans[index]!;
			chips.push({ start: marker.start - lineStart, end: marker.end - lineStart, kind: marker.kind, number: marker.number });
		}
		const flags = quotes[specs.length];
		specs.push({ text: text.slice(lineStart, lineEnd), code, fence: code && (lineStart === current!.start || lineStart === current!.closeStart), quote: flags?.quote === true, quoteCode: flags?.code === true, chips });
		if (newline < 0) return specs;
		lineStart = newline + 1;
	}
}

function lineKey(spec: LineSpec): string {
	return `${spec.code ? 1 : 0}${spec.fence ? 1 : 0}${spec.quote ? 1 : 0}${spec.quoteCode ? 1 : 0}|${spec.chips.map(chip => `${chip.kind[0]}${chip.start}-${chip.end}-${chip.number}`).join(",")}|${spec.text}`;
}

/** Whether `node` is a marker chip, of an image or of a file. */
export function isChip(node: Node | null): node is HTMLElement {
	return node !== null && node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).classList.contains(CHIP_CLASS);
}

function endsInChip(spec: LineSpec): boolean {
	const last = spec.chips[spec.chips.length - 1];
	return last !== undefined && last.end === spec.text.length;
}

/** Builds the element of one line. */
export function buildLine(doc: Document, spec: LineSpec): HTMLElement {
	const line = doc.createElement("div");
	line.className = `${LINE_CLASS}${spec.code ? ` ${CODE_LINE_CLASS}` : ""}${spec.fence ? ` ${FENCE_LINE_CLASS}` : ""}${spec.quote ? ` ${QUOTE_LINE_CLASS}` : ""}${spec.quoteCode ? ` ${QUOTE_CODE_LINE_CLASS}` : ""}`;
	let at = 0;
	for (const chip of spec.chips) {
		if (chip.start > at) line.append(doc.createTextNode(spec.text.slice(at, chip.start)));
		const element = doc.createElement("span");
		if (chip.kind === "file") {
			element.className = `${CHIP_CLASS} ${FILE_CHIP_CLASS}`;
			element.dataset.kind = "file";
			element.setAttribute("role", "group");
			const label = spec.text.slice(chip.start, chip.end);
			element.setAttribute("aria-label", `File #${chip.number}, ${label.slice(label.indexOf(": ") + 2, -1)}`);
		} else {
			element.className = CHIP_CLASS;
			element.setAttribute("role", "img");
			element.setAttribute("aria-label", `Image #${chip.number}`);
		}
		element.contentEditable = "false";
		element.textContent = spec.text.slice(chip.start, chip.end);
		line.append(element);
		at = chip.end;
	}
	if (at < spec.text.length) line.append(doc.createTextNode(spec.text.slice(at)));
	if (spec.text.length === 0 || endsInChip(spec)) line.append(doc.createElement("br"));
	return line;
}

/** Length of an inline node in model characters: text and chips count, fillers do not. */
function inlineLength(node: Node): number {
	if (node.nodeType === Node.TEXT_NODE) return (node as Text).length;
	if (node.nodeName === "BR") return 0;
	return node.textContent?.length ?? 0;
}

/** The model text of one rendered line. */
export function lineTextOf(line: Node): string {
	let text = "";
	for (const child of line.childNodes) {
		if (child.nodeType === Node.TEXT_NODE) text += (child as Text).data;
		else if (child.nodeName !== "BR") text += child.textContent ?? "";
	}
	return text;
}

function lengthOfLine(line: Node): number {
	let length = 0;
	for (const child of line.childNodes) length += inlineLength(child);
	return length;
}

/**
 * Reads the draft back out of the DOM, tolerating what a browser or an IME leaves behind: a block element is a line,
 * consecutive inline nodes at the root form one line, a `<br>` that is not the last child of its parent is a line break,
 * and a trailing `<br>` is a filler.
 */
export function readText(root: HTMLElement): string {
	const lines: string[] = [];
	let loose: string | null = null;
	const flushLoose = (): void => {
		if (loose !== null) lines.push(loose);
		loose = null;
	};
	for (const child of root.childNodes) {
		if (child.nodeType === Node.ELEMENT_NODE && !isChip(child) && child.nodeName !== "BR" && isBlock(child as HTMLElement)) {
			flushLoose();
			lines.push(...readBlock(child as HTMLElement));
		} else if (child.nodeName === "BR") {
			if (child !== root.lastChild) {
				lines.push(loose ?? "");
				loose = null;
			}
		} else {
			loose = (loose ?? "") + (child.textContent ?? "");
		}
	}
	flushLoose();
	return lines.length === 0 ? "" : lines.join("\n");
}

function isBlock(element: HTMLElement): boolean {
	return element.nodeName === "DIV" || element.nodeName === "P";
}

function readBlock(block: HTMLElement): string[] {
	const lines: string[] = [];
	let current = "";
	for (const child of block.childNodes) {
		if (child.nodeName === "BR") {
			if (child !== block.lastChild) {
				lines.push(current);
				current = "";
			}
		} else {
			current += child.textContent ?? "";
		}
	}
	lines.push(current);
	return lines;
}

function lineElements(root: HTMLElement): Element[] {
	return Array.from(root.children);
}

/** Offset of the first character of line `index` (the end of the text for an index past the last line). */
function startOfLine(lines: readonly Element[], index: number): number {
	let offset = 0;
	const count = Math.min(index, lines.length);
	for (let at = 0; at < count; at++) offset += lengthOfLine(lines[at]!) + 1;
	return index >= lines.length ? Math.max(0, offset - 1) : offset;
}

/** Total length of the rendered draft. */
export function textLength(root: HTMLElement): number {
	const lines = lineElements(root);
	return startOfLine(lines, lines.length);
}

function columnWithin(line: Element, node: Node, nodeOffset: number): number {
	if (node === line) {
		let column = 0;
		for (let index = 0; index < Math.min(nodeOffset, line.childNodes.length); index++) column += inlineLength(line.childNodes[index]!);
		return column;
	}
	let child: Node = node;
	while (child.parentNode !== line) child = child.parentNode!;
	let column = 0;
	for (const sibling of line.childNodes) {
		if (sibling === child) break;
		column += inlineLength(sibling);
	}
	if (child.nodeType === Node.TEXT_NODE) return column + Math.min(nodeOffset, (child as Text).length);
	if (isChip(child)) {
		if (node === child) return nodeOffset > 0 ? column + inlineLength(child) : column;
		return column + Math.min(nodeOffset, inlineLength(child));
	}
	return column;
}

/** The model offset of a DOM point inside `root`. A point inside a chip maps to its marker offset (the caller snaps it to the edge). */
export function offsetOf(root: HTMLElement, node: Node, nodeOffset: number): number {
	const lines = lineElements(root);
	if (node === root) return startOfLine(lines, nodeOffset);
	let line: Node | null = node;
	while (line !== null && line.parentNode !== root) line = line.parentNode;
	if (line === null) return 0;
	return startOfLine(lines, lines.indexOf(line as Element)) + columnWithin(line as Element, node, nodeOffset);
}

/** A DOM point. */
export interface DomPoint {
	readonly node: Node;
	readonly offset: number;
}

function locateIn(line: Element, column: number): DomPoint {
	const children = Array.from(line.childNodes);
	let accumulated = 0;
	for (let index = 0; index < children.length; index++) {
		const child = children[index]!;
		if (child.nodeType === Node.TEXT_NODE) {
			const length = (child as Text).length;
			if (column <= accumulated + length) return { node: child, offset: column - accumulated };
			accumulated += length;
		} else if (isChip(child)) {
			const length = inlineLength(child);
			if (column === accumulated) return { node: line, offset: index };
			if (column < accumulated + length) return { node: line, offset: index + 1 };
			if (column === accumulated + length && !(children[index + 1]?.nodeType === Node.TEXT_NODE)) return { node: line, offset: index + 1 };
			accumulated += length;
		}
	}
	const filler = children.findIndex(child => child.nodeName === "BR");
	return { node: line, offset: filler < 0 ? children.length : filler };
}

/** The DOM point for a model offset; an offset past the end is clamped to the end. Never the root itself. */
export function locate(root: HTMLElement, offset: number): DomPoint {
	const lines = lineElements(root);
	let remaining = Math.max(0, offset);
	for (let index = 0; index < lines.length; index++) {
		const length = lengthOfLine(lines[index]!);
		if (remaining <= length || index === lines.length - 1) return locateIn(lines[index]!, Math.min(remaining, length));
		remaining -= length + 1;
	}
	return { node: root, offset: 0 };
}

/** The line index (0-based) holding a DOM point, or `-1` when it is outside every line. */
export function lineIndexOf(root: HTMLElement, node: Node): number {
	let line: Node | null = node;
	while (line !== null && line.parentNode !== root) line = line.parentNode;
	return line === null ? -1 : lineElements(root).indexOf(line as Element);
}

/** A DOM range over the model range `[start, end)`. */
export function rangeAt(root: HTMLElement, start: number, end: number): Range {
	const range = root.ownerDocument.createRange();
	const from = locate(root, start);
	const to = start === end ? from : locate(root, end);
	range.setStart(from.node, from.offset);
	range.setEnd(to.node, to.offset);
	return range;
}

/** Where a collapsed caret sits among the visual rows, soft wraps included. */
export interface CaretRowEdges {
	/** The caret is on the first visual row. */
	readonly first: boolean;
	/** The caret is on the last visual row. */
	readonly last: boolean;
}

function rowTop(root: HTMLElement, text: string, offset: number): number | null {
	const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
	const newline = text.indexOf("\n", offset);
	const lineEnd = newline < 0 ? text.length : newline;
	let range: Range;
	if (offset < lineEnd) range = rangeAt(root, offset, offset + 1);
	else if (offset > lineStart) range = rangeAt(root, offset - 1, offset);
	else {
		const line = lineElements(root)[lineIndexOf(root, locate(root, offset).node)];
		return line === undefined ? null : line.getBoundingClientRect().top;
	}
	const rects = Array.from(range.getClientRects()).filter(rect => rect.height > 0);
	const rect = offset < lineEnd ? rects[0] : rects[rects.length - 1];
	return rect === undefined ? null : rect.top;
}

/**
 * The caret's row edges, for the history arrow keys: the caret is on the first row when the character after it shares a
 * row with the first character of the draft, on the last when it shares a row with the end of the draft (an empty line
 * measures by its own element). Rows are compared with half a line of tolerance, so a glyph a pixel off cannot read as
 * another row. An offset at a soft wrap belongs to the row of the character after it.
 */
export function caretRowEdges(root: HTMLElement, text: string, offset: number, lineHeight: number): CaretRowEdges {
	const maybeFirst = !text.slice(0, offset).includes("\n");
	const maybeLast = !text.slice(offset).includes("\n");
	if (!maybeFirst && !maybeLast) return { first: false, last: false };
	const caret = rowTop(root, text, offset);
	if (caret === null) return { first: maybeFirst, last: maybeLast };
	const same = (other: number | null): boolean => other === null || Math.abs(other - caret) < lineHeight / 2;
	return {
		first: maybeFirst && same(rowTop(root, text, 0)),
		last: maybeLast && same(rowTop(root, text, text.length)),
	};
}

/** Draws a draft into the root one line element per line, touching as little of the DOM as the change allows. */
export class LineRenderer {
	readonly #root: HTMLElement;
	#keys: string[] = [];
	#specs: LineSpec[] = [];

	constructor(root: HTMLElement) {
		this.#root = root;
	}

	/** Lines the renderer believes are in the DOM, as model texts. */
	get lines(): readonly string[] {
		return this.#specs.map(spec => spec.text);
	}

	/**
	 * Makes the DOM show `specs`. Only the lines between the first and the last that differ are touched; a change that only alters
	 * one line's text updates its text node in place; a line whose class or chips change is replaced; the indexes in `replace`
	 * (of the lines now in the DOM) are rebuilt even if they look unchanged, `true` meaning all of them.
	 */
	render(specs: readonly LineSpec[], replace: ReadonlySet<number> | true = new Set()): void {
		const root = this.#root;
		const doc = root.ownerDocument;
		const keys = specs.map(lineKey);
		const old = this.#keys;
		if (replace === true || old.length !== root.children.length || old.length === 0) {
			root.replaceChildren(...specs.map(spec => buildLine(doc, spec)));
			this.#keys = keys;
			this.#specs = [...specs];
			return;
		}
		const limit = Math.min(old.length, keys.length);
		let prefix = 0;
		while (prefix < limit && old[prefix] === keys[prefix] && !replace.has(prefix)) prefix++;
		let suffix = 0;
		while (suffix < limit - prefix && old[old.length - 1 - suffix] === keys[keys.length - 1 - suffix] && !replace.has(old.length - 1 - suffix)) suffix++;
		const oldEnd = old.length - suffix;
		const newEnd = keys.length - suffix;
		if (oldEnd !== prefix || newEnd !== prefix) {
			const before = this.#specs[prefix];
			const after = specs[prefix]!;
			const inPlace = oldEnd - prefix === 1 && newEnd - prefix === 1 && before !== undefined && !replace.has(prefix)
				&& before.chips.length === 0 && after.chips.length === 0 && before.code === after.code && before.fence === after.fence && before.quote === after.quote && before.quoteCode === after.quoteCode;
			if (inPlace) {
				const line = root.children[prefix]!;
				const first = line.firstChild;
				if (after.text.length === 0) line.replaceChildren(doc.createElement("br"));
				else if (first !== null && first.nodeType === Node.TEXT_NODE && first === line.lastChild) (first as Text).data = after.text;
				else line.replaceChildren(doc.createTextNode(after.text));
			} else {
				const reference = root.children[oldEnd] ?? null;
				for (const element of Array.from(root.children).slice(prefix, oldEnd)) element.remove();
				for (let index = prefix; index < newEnd; index++) root.insertBefore(buildLine(doc, specs[index]!), reference);
			}
		}
		this.#keys = keys;
		this.#specs = [...specs];
	}
}
