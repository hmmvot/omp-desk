/** Inline code and link text with line-break points after path separators (see `../lib/break-points.ts`). */
import { Fragment, type ReactNode } from "react";
import { breakPieces } from "../lib/break-points";

/** `text` with a `<wbr>` between its pieces; the text itself is unchanged and a text with no break point is returned as it is. */
export function breakable(text: string): ReactNode {
	const pieces = breakPieces(text);
	if (pieces.length === 1) return text;
	return pieces.map((piece, index) => <Fragment key={index}>{index > 0 && <wbr />}{piece}</Fragment>);
}
