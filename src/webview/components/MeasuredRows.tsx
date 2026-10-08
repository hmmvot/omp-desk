import type { ReactNode, RefObject } from "react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { TranscriptHeightIndex, visibleRowRanges, type MeasuredRow } from "../lib/transcript-virtualizer";
import type { SourceAnchor } from "../lib/transcript-scroll";

export interface RowViewport { top: number; height: number; width: number }
export function MeasuredRows({ rows, context, viewport, following, anchor, paged, renderRow, onLayout, onInteraction, elementRef, forcedSources, forcedRows }: {
	rows: readonly MeasuredRow[]; context: string; viewport: RowViewport; following: boolean;
	anchor?: SourceAnchor | null; paged?: boolean; renderRow(index: number): ReactNode;
	onLayout(): void; onInteraction?(held: boolean): void; elementRef?: RefObject<HTMLDivElement | null>;
	/** Call-id exceptions carried across a density remount, until native interaction releases. */
	forcedSources?: ReadonlyMap<string, boolean>;
	/** Disclosure controls retained while a virtualized member has native focus/selection. */
	forcedRows?: ReadonlySet<string>;
}): ReactNode {
	const root = useRef<HTMLDivElement>(null), index = useRef(new TranscriptHeightIndex());
	const [version, measureChanged] = useState(0), [metrics, setMetrics] = useState("");
	const [held, setHeld] = useState<ReadonlySet<string>>(new Set());
	const callbacks = useRef({ onLayout, onInteraction }); callbacks.current = { onLayout, onInteraction };
	const layout = useMemo(() => index.current.update(rows, `${context}:${metrics}`), [rows, context, metrics, version]);
	const sourceRows = useMemo(() => {
		const sources = new Map<string, number>();
		for (let position = 0; position < rows.length; position++) for (const source of rows[position]!.sources) if (!sources.has(source)) sources.set(source, position);
		return sources;
	}, [rows]);
	const heldRows = useMemo(() => rows.flatMap((row, position) => held.has(row.id) || forcedRows?.has(row.id) || row.sources.some(source => source.startsWith("call:") && forcedSources?.has(source.slice(5))) ? [position] : []), [rows, held, forcedSources, forcedRows]);
	const anchoredRow = anchor?.sources.map(source => sourceRows.get(source)).find(position => position !== undefined);
	const top = following ? Math.max(0, layout.total - viewport.height) : anchoredRow !== undefined && anchor ? layout.offsets[anchoredRow]! - anchor.offset : viewport.top;
	// A long row's old reading offset can exceed its invalidated estimate. Keep
	// that source mounted so its real height can repair the index before restoring.
	const ranges = paged ? [{ start: 0, end: rows.length }] : visibleRowRanges(layout, top, viewport.height || 600, anchoredRow === undefined ? heldRows : [...heldRows, anchoredRow]);
	const mounted = ranges.flatMap(range => rows.slice(range.start, range.end).map(row => row.id)).join("\n");

	useLayoutEffect(() => {
		if (elementRef) elementRef.current = root.current;
		return () => { if (elementRef) elementRef.current = null; };
	}, [elementRef]);
	useEffect(() => {
		const update = (): void => {
			const element = root.current, selection = document.getSelection(), next = new Set<string>();
			if (!element) return;
			for (const child of element.children) {
				if (!(child instanceof HTMLElement) || !child.dataset.windowRow) continue;
				if (child.contains(document.activeElement) || selection && !selection.isCollapsed && selection.containsNode(child, true)) next.add(child.dataset.windowRow);
			}
			setHeld(previous => previous.size === next.size && [...next].every(id => previous.has(id)) ? previous : next);
		};
		document.addEventListener("selectionchange", update); document.addEventListener("focusin", update); document.addEventListener("focusout", update);
		return () => { document.removeEventListener("selectionchange", update); document.removeEventListener("focusin", update); document.removeEventListener("focusout", update); };
	}, []);
	useEffect(() => { callbacks.current.onInteraction?.(held.size > 0); }, [held]);
	useLayoutEffect(() => {
		const element = root.current;
		if (!element) return;
		let frame: number | null = null;
		const pending = new Map<string, number>();
		const readMetrics = (): void => {
			const style = getComputedStyle(element);
			const next = [Math.round(element.clientWidth / 16), style.fontFamily, style.fontSize, style.lineHeight, style.letterSpacing, document.body.className, document.body.dataset.vscodeThemeId, document.body.dataset.vscodeThemeName].join(":");
			setMetrics(previous => previous === next ? previous : next);
		};
		const observer = new ResizeObserver(entries => {
			for (const entry of entries) {
				const child = entry.target as HTMLElement;
				if (child.dataset.windowRow) pending.set(child.dataset.windowRow, child.getBoundingClientRect().height);
			}
			readMetrics();
			if (frame === null) frame = requestAnimationFrame(() => {
				frame = null; let changed = false;
				for (const [id, height] of pending) changed = index.current.measure(id, height) || changed;
				pending.clear(); if (changed) measureChanged(value => value + 1);
			});
		});
		observer.observe(element);
		for (const child of element.children) if (child instanceof HTMLElement && child.dataset.windowRow) observer.observe(child);
		const theme = new MutationObserver(readMetrics);
		for (let ancestor: HTMLElement | null = element; ancestor; ancestor = ancestor.parentElement) theme.observe(ancestor, { attributes: true, attributeFilter: ["class", "style", "data-vscode-theme-id", "data-vscode-theme-name"] });
		document.fonts.addEventListener("loadingdone", readMetrics); readMetrics();
		return () => { if (frame !== null) cancelAnimationFrame(frame); observer.disconnect(); theme.disconnect(); document.fonts.removeEventListener("loadingdone", readMetrics); };
	}, [mounted, context]);
	useLayoutEffect(() => {
		// Revisions and font/theme metrics invalidate cached heights even when the DOM
		// dimensions do not change, in which case ResizeObserver will not notify again.
		let changed = false;
		for (const child of root.current?.children ?? []) {
			if (child instanceof HTMLElement && child.dataset.windowRow) changed = index.current.measure(child.dataset.windowRow, child.getBoundingClientRect().height) || changed;
		}
		if (changed) measureChanged(value => value + 1);
		else callbacks.current.onLayout();
	}, [layout, mounted, paged]);

	const content: ReactNode[] = []; let cursor = 0;
	for (const range of ranges) {
		if (range.start > cursor) content.push(<div key={`gap:${cursor}:${range.start}`} className="omp-window-spacer" aria-hidden="true" style={{ height: layout.offsets[range.start]! - layout.offsets[cursor]! }} />);
		for (let position = range.start; position < range.end; position++) {
			const row = rows[position]!;
			content.push(<div key={row.id} className="omp-measured-row" data-window-row={row.id} data-anchor-key={row.id}>{renderRow(position)}</div>);
		}
		cursor = range.end;
	}
	if (cursor < rows.length) content.push(<div key={`gap:${cursor}:end`} className="omp-window-spacer" aria-hidden="true" style={{ height: layout.total - layout.offsets[cursor]! }} />);
	return <div ref={root} className="omp-measured-rows" data-admitted-rows={rows.length}>{content}</div>;
}
