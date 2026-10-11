/**
 * Where a collapsed caret sits among a textarea's VISUAL rows, soft wraps included.
 *
 * A textarea exposes no row geometry, so the text is laid out once in a hidden
 * mirror that copies every style affecting line breaks, and the rows are read
 * back as the rects of single characters: the character after the caret is on
 * the caret's row, the first character on the first row, and a sentinel after
 * the last character on the last row (which is also the empty row behind a
 * trailing newline). Rects are compared with half a line of tolerance so a
 * fallback-font glyph that sits a pixel off cannot read as another row.
 */

/** Zero-width, so it never changes where the text wraps; gives the last row (even an empty one) a character to measure. */
const SENTINEL = "\u200b";

const MIRRORED_STYLES = [
	"boxSizing",
	"fontFamily",
	"fontSize",
	"fontStyle",
	"fontWeight",
	"fontStretch",
	"fontVariant",
	"fontKerning",
	"fontFeatureSettings",
	"letterSpacing",
	"wordSpacing",
	"lineHeight",
	"textTransform",
	"textIndent",
	"textAlign",
	"tabSize",
	"whiteSpace",
	"overflowWrap",
	"wordBreak",
	"lineBreak",
	"hyphens",
	"direction",
	"paddingTop",
	"paddingRight",
	"paddingBottom",
	"paddingLeft",
] as const;

export interface CaretRowEdges {
	/** The caret is on the first visual row. */
	readonly first: boolean;
	/** The caret is on the last visual row. */
	readonly last: boolean;
}

/** Row edges for the caret at `at` in `element`'s current value. Only the geometry is read; the textarea is untouched. */
export function caretRowEdges(element: HTMLTextAreaElement, at: number): CaretRowEdges {
	const value = element.value;
	// A hard line break on a side already rules that edge out: skip the layout in the common multi-line case.
	const maybeFirst = !value.slice(0, at).includes("\n");
	const maybeLast = !value.slice(at).includes("\n");
	if (!maybeFirst && !maybeLast) return { first: false, last: false };

	const doc = element.ownerDocument;
	const style = doc.defaultView!.getComputedStyle(element);
	const mirror = doc.createElement("div");
	for (const name of MIRRORED_STYLES) mirror.style[name] = style[name];
	mirror.style.position = "absolute";
	mirror.style.visibility = "hidden";
	mirror.style.pointerEvents = "none";
	mirror.style.top = "0";
	mirror.style.left = "0";
	mirror.style.height = "auto";
	mirror.style.border = "0";
	mirror.style.margin = "0";
	mirror.style.overflow = "hidden";
	// `clientWidth` is the text area's width without borders and without a vertical scrollbar, padding included.
	mirror.style.boxSizing = "border-box";
	mirror.style.width = `${element.clientWidth}px`;
	// The textarea's own wrapping, whatever `wrap` says; `pre-wrap` is what a default textarea computes.
	if (!style.whiteSpace.startsWith("pre")) mirror.style.whiteSpace = "pre-wrap";
	const text = doc.createTextNode(value + SENTINEL);
	mirror.appendChild(text);
	doc.body.appendChild(mirror);
	try {
		const top = (offset: number): number => {
			const range = doc.createRange();
			range.setStart(text, offset);
			range.setEnd(text, offset + 1);
			const rect = range.getClientRects()[0] ?? range.getBoundingClientRect();
			return rect.top;
		};
		const fontSize = Number.parseFloat(style.fontSize);
		const lineHeight = Number.parseFloat(style.lineHeight);
		const tolerance = (Number.isFinite(lineHeight) ? lineHeight : (Number.isFinite(fontSize) ? fontSize : 16) * 1.2) / 2;
		const caretTop = top(at);
		return {
			first: maybeFirst && Math.abs(caretTop - top(0)) < tolerance,
			last: maybeLast && Math.abs(caretTop - top(value.length)) < tolerance,
		};
	} finally {
		mirror.remove();
	}
}
