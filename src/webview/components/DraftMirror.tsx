/**
 * The layer behind the composer's textarea: it paints what the textarea cannot draw for itself, with
 * transparent text, so it only has to take the textarea's exact line breaks. It shows a chip behind each
 * `[Image #N, WxH]` marker and a band behind each fenced code block
 * (docs/designs/2026-10-15-composer-code-blocks.md).
 *
 * With blocks, the draft is stacked as block-level pieces and the line break between two pieces is the
 * box boundary itself; every piece ends in a zero-width space so an empty last line keeps its height.
 */
import type { ReactNode, RefObject } from "react";
import { draftPieces, type FencedBlock } from "../lib/code-fence";
import { draftSegments, type ImageReferenceSpan } from "../lib/image-references";

function paintSegments(text: string, spans: readonly ImageReferenceSpan[]): ReactNode[] {
	return draftSegments(text, spans).map((segment, index) => segment.marker
		? <mark key={index} className="omp-image-ref-mark" data-image-number={segment.number}>{segment.text}</mark>
		: segment.text);
}

export function DraftMirror({ text, spans, blocks, mirrorRef }: {
	text: string;
	spans: readonly ImageReferenceSpan[];
	blocks: readonly FencedBlock[];
	mirrorRef: RefObject<HTMLDivElement | null>;
}): ReactNode {
	return (
		<div className="omp-textarea-mirror" ref={mirrorRef} aria-hidden="true">
			<div className="omp-textarea-mirror-text">
				{blocks.length === 0
					? <>{paintSegments(text, spans)}{"\u200b"}</>
					: draftPieces(text, blocks).map((piece, index) => (
						<div key={index} className={piece.block ? "omp-mirror-block" : undefined}>
							{paintSegments(
								text.slice(piece.start, piece.end),
								// A marker never contains a line break, so each lies wholly inside one piece.
								spans.filter(span => span.start >= piece.start && span.end <= piece.end).map(span => ({ ...span, start: span.start - piece.start, end: span.end - piece.start })),
							)}
							{"\u200b"}
						</div>
					))}
			</div>
		</div>
	);
}
