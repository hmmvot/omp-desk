/**
 * What the transcript renderer knows about its own output, kept for quoting (docs/designs/2026-10-15-quote-chat-selection.md,
 * Section 3).
 *
 * The renderer turns Markdown into React nodes and keeps no source information in the DOM. For a quotable message it also
 * records, for every *leaf* block it creates (a paragraph, a heading, a rule, a code block, a table row), the source lines the
 * leaf came from and how much of each line the parse stripped before the leaf's own text, and stamps the leaf's element with
 * `data-md-leaf`. The records live in a page-local registry keyed by the message's `div.omp-md`; the DOM carries only the number.
 */

/** Where a line handed to a nested parse came from. */
export interface LineOrigin {
	/** The line's index in the text the renderer was given. */
	readonly line: number;
	/** Characters of that source line before the nested line's text: quote prefixes, list markers and indentation. */
	readonly start: number;
	/** How many quote levels the parse stripped from the line. */
	readonly quote: number;
}

/** One source line of a leaf: its origin and the text the leaf draws from it (a code line as written). */
export interface LeafLine extends LineOrigin {
	readonly text: string;
}

/** The rows a table is made of, shared by every row leaf of it. */
export interface LeafTable {
	readonly header: LeafLine;
	readonly separator: LeafLine;
}

export interface Leaf {
	readonly id: number;
	/** `text`: paragraph, heading and item text. `code`: a fenced block. `rule`: a horizontal rule. `row`: a table row. */
	readonly kind: "text" | "code" | "rule" | "row";
	/** `text`, `rule`, `row`: the leaf's lines. `code`: the body lines, without the fences. */
	readonly lines: readonly LeafLine[];
	/** The first and the last source line the leaf covers (a code block: its fences included). */
	readonly first: number;
	readonly last: number;
	/** `code`: the opening fence line, the first token of its info string and whether a closing fence was read. */
	readonly open?: LeafLine;
	readonly language?: string;
	readonly closed?: boolean;
	/** `row`: the table the row belongs to, and whether this row is its header. */
	readonly table?: LeafTable;
	readonly header?: boolean;
	/** Whether the leaf's inline text was parsed with emphasis (`false` for text the user typed): the shown text of a line is `inlinePieces(text, emphasis)`. */
	readonly emphasis: boolean;
}

/** Numbers the leaves of one parse from `base` on, so reused blocks keep their numbers while a streaming tail is parsed again. */
export class LeafCollector {
	readonly leaves: Leaf[] = [];
	readonly base: number;
	readonly emphasis: boolean;

	constructor(base: number, emphasis: boolean) {
		this.base = base;
		this.emphasis = emphasis;
	}

	/** The number the next leaf gets. */
	get count(): number {
		return this.base + this.leaves.length;
	}

	add(leaf: Omit<Leaf, "id" | "emphasis">): number {
		const id = this.count;
		this.leaves.push({ ...leaf, id, emphasis: this.emphasis });
		return id;
	}

	/** Drops every leaf numbered `count` or more. */
	truncate(count: number): void {
		this.leaves.length = Math.max(0, count - this.base);
	}
}

export interface RegisteredMarkdown {
	/** The text the instance rendered: for a paced reply the revealed prefix, so the records match the DOM by construction. */
	readonly text: string;
	/** The leaves by number. */
	readonly leaves: readonly Leaf[];
}

const registry = new WeakMap<Element, RegisteredMarkdown>();

export function registerMarkdown(root: Element, value: RegisteredMarkdown): void {
	registry.set(root, value);
}

export function unregisterMarkdown(root: Element): void {
	registry.delete(root);
}

export function registeredMarkdown(root: Element): RegisteredMarkdown | undefined {
	return registry.get(root);
}
