/**
 * The shared parts of an open tool card: what the card's state means for a block of rows (`ToolViewContext`), the
 * bounded preview of rows with its exact markers (`OutputRows`), the output bar, the footer line and Copy.
 */
import type { ReactNode } from "react";
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { FooterPart } from "../../chat/tool-notices";
import type { OutputFormat } from "../lib/json-tokens";
import type { FoldState, ToolViewState } from "../lib/tool-view-state";

/** What a block of rows needs to know of the card around it. */
export interface ToolViewContextValue {
	/** The call is still running: rows are the tail of what has arrived. */
	readonly live: boolean;
	/** Switch the card to showing everything; absent where there is no card (a static render). */
	readonly showAll?: () => void;
	/** Open the full output of artifact `id` in an editor tab; absent where the page cannot ask. */
	readonly openArtifact?: (id: string) => void;
	/** What the card remembers of its view (folds, format), and how to change it; absent where there is no card. */
	readonly view?: ToolViewState;
	readonly update?: (patch: Partial<ToolViewState>) => void;
	/** The text the card detected a format in (JSON, newline-delimited JSON), once it settled, and what it found. */
	readonly structured?: { readonly text: string; readonly format: OutputFormat };
}

export const ToolViewContext = createContext<ToolViewContextValue>({ live: false });
export const useToolViewContext = (): ToolViewContextValue => useContext(ToolViewContext);

/** An open card shows this many rows before "Show all". */
export const PREVIEW_ROWS = 12;
/** A hidden remainder of this many rows or fewer is shown instead of a marker: the marker would cost about as much as the rows. */
export const SLACK_ROWS = 3;

/** The folds of the card's trees and a way to change them; a block outside a card keeps its own. */
export function useFolds(): readonly [ReadonlyMap<string, FoldState>, (next: ReadonlyMap<string, FoldState>) => void] {
	const { view, update } = useToolViewContext();
	const [local, setLocal] = useState<ReadonlyMap<string, FoldState>>(() => new Map());
	const set = useCallback((next: ReadonlyMap<string, FoldState>) => { if (update !== undefined) update({ folds: next }); else setLocal(next); }, [update]);
	return [view?.folds ?? local, set];
}

const grouped = (count: number): string => count.toLocaleString("en-US");

/** `Show all 783 lines`; the button that switches the card to its full view. */
export function ShowAll({ count, unit }: { count: number; unit: string }): ReactNode {
	const { showAll } = useToolViewContext();
	if (showAll === undefined) return null;
	return <button type="button" className="omp-output-more" onClick={showAll}>Show all {grouped(count)} {unit}</button>;
}

/** A row window the card shows in full: the head 200 rows and the last 20, each step 200 more (replaced by the windowed list). */
function PagedRows<T>({ all, render }: { all: readonly T[]; render: (rows: readonly T[], offset: number) => ReactNode }): ReactNode {
	const [limit, setLimit] = useState(200);
	const end = Math.min(all.length, limit), tail = end < all.length ? Math.max(end, all.length - 20) : all.length;
	const hidden = tail - end;
	return <>{render(all.slice(0, end), 0)}{hidden > 0 && <div className="omp-output-disclosure">
		<button type="button" onClick={() => setLimit(current => current + 200)}>Show {Math.min(200, hidden)} more lines</button>
		<button type="button" onClick={() => setLimit(all.length)}>Show all {all.length} lines</button>
		<span className="omp-empty-note">{hidden} lines hidden</span>
	</div>}{tail < all.length && render(all.slice(tail), tail)}</>;
}

export interface OutputRowsProps<T> {
	readonly all: readonly T[];
	/** The rows `rows`, which start at `offset` of `all`. */
	readonly render: (rows: readonly T[], offset: number) => ReactNode;
	/** The card shows everything. */
	readonly expanded: boolean;
	readonly limit?: number;
	/** Show the last rows, marker above (a command's output); else the first, marker below. */
	readonly tail?: boolean;
	readonly unit?: string;
	readonly units?: string;
	/** The marker's words for what a head preview hides; the rows it hides are `all.slice(limit)`. */
	readonly hidden?: (rows: readonly T[]) => string;
}

/**
 * Rows, bounded: at most `limit` when the card is not full, with the marker that says what is not shown and the
 * button that shows it. A remainder of three rows or fewer is shown instead. A tail preview puts the marker first.
 */
export function OutputRows<T>({ all, render, expanded, limit = PREVIEW_ROWS, tail = false, unit = "line", units = `${unit}s`, hidden }: OutputRowsProps<T>): ReactNode {
	const { live } = useToolViewContext();
	if (expanded) return <PagedRows all={all} render={render} />;
	const count = all.length;
	if (count <= limit + SLACK_ROWS) return <>{render(all, 0)}</>;
	const rest = count - limit;
	const word = rest === 1 ? unit : units;
	if (tail) {
		return <>
			<div className="omp-output-marker omp-output-marker--top"><span>… ({grouped(rest)} earlier {word}, showing {limit} of {grouped(count)}){live ? " · live" : ""}</span><ShowAll count={count} unit={units} /></div>
			{render(all.slice(-limit), count - limit)}
		</>;
	}
	return <>
		{render(all.slice(0, limit), 0)}
		<div className="omp-output-marker omp-output-marker--bottom"><span>… {hidden === undefined ? `${grouped(rest)} more ${word}` : hidden(all.slice(limit))}</span><ShowAll count={count} unit={units} /></div>
	</>;
}

/** Copy: puts exactly `text` on the clipboard and says what it copied, to the eye and to a screen reader. */
export function ToolCopyButton({ text, label, what }: { text: string | (() => string); label: string; what: string }): ReactNode {
	const [status, setStatus] = useState<string | null>(null);
	useEffect(() => {
		if (status === null) return;
		const timer = setTimeout(() => setStatus(null), 1_600);
		return () => clearTimeout(timer);
	}, [status]);
	return (
		<button type="button" className="omp-iconbtn" aria-label={label} title={status ?? label} onClick={async event => {
			event.stopPropagation();
			const value = typeof text === "function" ? text() : text;
			try {
				await navigator.clipboard.writeText(value);
				const lines = value === "" ? 0 : value.split("\n").length;
				setStatus(`Copied ${what} (${grouped(lines)} ${lines === 1 ? "line" : "lines"}, ${grouped(value.length)} characters)`);
			} catch { setStatus(`Copy failed. Select the text to copy ${what} manually.`); }
		}}>
			<span className={`codicon codicon-${status === null ? "copy" : status.startsWith("Copy failed") ? "warning" : "check"}`} aria-hidden="true" />
			{status !== null && <span className="omp-sr-only" role="status">{status}</span>}
		</button>
	);
}

/** The line that says what the output bar's chips and the head gist do not: one quiet row of notices. */
export function ToolFooter({ parts }: { parts: readonly FooterPart[] }): ReactNode {
	const { openArtifact } = useToolViewContext();
	if (parts.length === 0) return null;
	return <div className="omp-tool-footer">{parts.map((part, index) => <span key={index} className={part.tone === "warn" ? "omp-tool-footer-warn" : undefined}>
		{index > 0 && " · "}
		{part.tone === "warn" && <span className="codicon codicon-warning" aria-hidden="true" />}
		{part.text}
		{part.artifact !== undefined && <>{" "}{openArtifact === undefined
			? <code>artifact://{part.artifact}</code>
			: <button type="button" className="omp-artifact-link" title="Open the full output in an editor tab" onClick={() => openArtifact(part.artifact!)}>artifact://{part.artifact}</button>}</>}
	</span>)}</div>;
}
