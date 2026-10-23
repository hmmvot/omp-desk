/**
 * One Remove quote button per quote run of the composer draft (docs/designs/2026-10-15-quote-chat-selection.md, Section 4).
 *
 * The buttons live in a sibling overlay of the field and only *read* the field's line rectangles, so the field's markup and an
 * IME composition are never touched. Each sits in the band's own gutter beside the first visible line of its run, so it never
 * covers text or the scrollbar. A mouse press keeps the field's focus and selection (`preventDefault`, as the suggestion list does).
 */
import type { ReactNode, RefObject } from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { DraftSurface } from "../lib/draft-surface";
import { quoteTitle } from "../lib/draft/draft";
import type { QuoteRun } from "../lib/draft/draft";

/** The button's box: one text line high. */
const BUTTON_SIZE = 20;

interface Mark {
	readonly run: QuoteRun;
	readonly top: number;
}

function sameMarks(a: readonly Mark[], b: readonly Mark[]): boolean {
	return a.length === b.length && a.every((mark, index) => mark.run.start === b[index]!.run.start && mark.top === b[index]!.top);
}

export function QuoteRemoveButtons({ surfaceRef, text, runs, disabled, onRemove }: {
	surfaceRef: RefObject<DraftSurface | null>;
	text: string;
	runs: readonly QuoteRun[];
	disabled: boolean;
	/** Removes the run that starts at this offset. */
	onRemove: (start: number) => void;
}): ReactNode {
	const overlayRef = useRef<HTMLDivElement | null>(null);
	const [marks, setMarks] = useState<readonly Mark[]>([]);

	const measure = useCallback((): void => {
		const surface = surfaceRef.current;
		const overlay = overlayRef.current;
		const next: Mark[] = [];
		if (surface !== null && overlay !== null) {
			const field = surface.element.getBoundingClientRect();
			const base = overlay.getBoundingClientRect();
			for (const run of runs) {
				for (let line = run.firstLine; line <= run.lastLine; line++) {
					const rect = surface.lineRect(line);
					if (rect === null) break;
					if (rect.top >= field.top - 0.5 && rect.top + BUTTON_SIZE <= field.bottom + 0.5) {
						next.push({ run, top: rect.top - base.top });
						break;
					}
				}
			}
		}
		setMarks(previous => (sameMarks(previous, next) ? previous : next));
	}, [runs, surfaceRef]);

	// Re-read after each edit, on the field's scroll and on a resize of the field.
	useLayoutEffect(measure, [measure, text]);
	useEffect(() => {
		const element = surfaceRef.current?.element;
		if (element === undefined) return;
		element.addEventListener("scroll", measure, { passive: true });
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => {
			element.removeEventListener("scroll", measure);
			observer.disconnect();
		};
	}, [measure, surfaceRef]);

	return (
		<div className="omp-quote-overlay" ref={overlayRef}>
			{marks.map(mark => {
				const title = quoteTitle(text, mark.run);
				return (
					<button
						key={mark.run.start}
						type="button"
						className="omp-quote-remove"
						style={{ top: mark.top }}
						aria-label={`Remove quote: «${title}»`}
						title="Remove this quote"
						disabled={disabled}
						// A press must not move the focus or collapse the selection: the field keeps both.
						onMouseDown={event => event.preventDefault()}
						onClick={() => onRemove(mark.run.start)}
					>
						<span className="codicon codicon-close" aria-hidden="true" />
					</button>
				);
			})}
		</div>
	);
}
