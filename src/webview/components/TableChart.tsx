/**
 * The chart under a table of numbers in an assistant reply (`lib/table-chart.ts` decides which tables get one and where every mark lies).
 *
 * The chart is React-generated inline SVG, never markup from a string: every cell text reaches the page as an escaped text node. It
 * is coloured by CSS variables (`chart-styles.ts`), so a theme change repaints it with no JavaScript. The SVG is `aria-hidden`: the
 * wrapper is one image with the chart's description, and the page's Find (which skips hidden subtrees) never reads chart text.
 */
import { useContext, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { layoutChart, planTableChart, type BarLayout, type ChartSpec, type LayoutLegend, type LineLayout } from "../lib/table-chart.ts";
import { AssistantReplyContext } from "./FileLinks.tsx";

/** How long the last table of a reply must stay unchanged before it is charted: its rows may still be streaming in. */
export const CHART_SETTLE_MS = 600;

// The reader's opt-out, shared by every chart of the page for the page's life (the TUI's `tui.autoGraph: off`, without a host setting).
let chartsHidden = false;
const hiddenListeners = new Set<() => void>();

/** Whether the reader hid the charts of this page. */
export const getChartsHidden = (): boolean => chartsHidden;

/** Hides (or shows again) every chart of the page. */
export function setChartsHidden(hidden: boolean): void {
	if (hidden === chartsHidden) return;
	chartsHidden = hidden;
	for (const listener of [...hiddenListeners]) listener();
}

const subscribeChartsHidden = (listener: () => void): (() => void) => {
	hiddenListeners.add(listener);
	return () => {
		hiddenListeners.delete(listener);
	};
};

const SERIES_CLASSES = ["c1", "c2", "c3", "c4", "c5", "c6"] as const;
const seriesClass = (series: number): string => `omp-chart-${SERIES_CLASSES[series % SERIES_CLASSES.length]}`;

function Legend({ items }: { items: readonly LayoutLegend[] }) {
	return (
		<>
			{items.map(item => (
				<g key={item.series}>
					<rect className={`omp-chart-swatch ${seriesClass(item.series)}`} x={item.x} y={item.y - 5} width={10} height={10} rx={2} />
					<text className="omp-chart-legend" x={item.x + 15} y={item.y} dy="0.35em">{item.name}</text>
				</g>
			))}
		</>
	);
}

function Bars({ layout }: { layout: BarLayout }) {
	const { plot } = layout;
	return (
		<>
			{layout.ticks.map(tick => (
				<g key={tick.pos}>
					<line className="omp-chart-grid" x1={tick.pos} x2={tick.pos} y1={plot.top} y2={plot.bottom} />
					<text className="omp-chart-tick" x={tick.pos} y={plot.bottom + 15} textAnchor="middle">{tick.label}</text>
				</g>
			))}
			<line className="omp-chart-zero" x1={layout.zero} x2={layout.zero} y1={plot.top} y2={plot.bottom} />
			<Legend items={layout.legend} />
			{layout.rows.map((row, at) => (
				<g key={at}>
					<title>{row.title}</title>
					<text className="omp-chart-label" x={row.label.x} y={row.label.y} dy="0.35em" textAnchor={row.label.anchor}>{row.label.text}</text>
					{row.bars.map(bar => (
						<g key={bar.series}>
							<rect className={`omp-chart-bar ${seriesClass(bar.series)}`} x={bar.x} y={bar.y} width={bar.width} height={bar.height} rx={2} />
							{bar.value && <text className="omp-chart-value" x={bar.value.x} y={bar.value.y} dy="0.35em" textAnchor={bar.value.anchor}>{bar.value.text}</text>}
						</g>
					))}
				</g>
			))}
		</>
	);
}

function Lines({ layout }: { layout: LineLayout }) {
	const { plot } = layout;
	return (
		<>
			{layout.ticks.map(tick => (
				<g key={tick.pos}>
					<line className="omp-chart-grid" x1={plot.left} x2={plot.right} y1={tick.pos} y2={tick.pos} />
					<text className="omp-chart-tick" x={plot.left - 6} y={tick.pos} dy="0.35em" textAnchor="end">{tick.label}</text>
				</g>
			))}
			{layout.xLabels.map((label, at) => (
				<text key={at} className="omp-chart-tick" x={label.x} y={label.y} textAnchor={label.anchor}>
					<title>{label.full}</title>
					{label.text}
				</text>
			))}
			<Legend items={layout.legend} />
			{layout.lines.map(line => (
				<g key={line.series} className={seriesClass(line.series)}>
					{line.segments.map((segment, at) => (
						<polyline key={at} className="omp-chart-line" points={segment.map(point => `${point.x},${point.y}`).join(" ")} />
					))}
					{line.dots.map((dot, at) => (
						<circle key={at} className="omp-chart-dot" cx={dot.x} cy={dot.y} r={3}>
							<title>{dot.title}</title>
						</circle>
					))}
				</g>
			))}
		</>
	);
}

function ChartDrawing({ spec }: { spec: ChartSpec }) {
	const layout = useMemo(() => layoutChart(spec), [spec]);
	return (
		<svg className="omp-chart-svg" viewBox={`0 0 ${layout.width} ${layout.height}`} width="100%" aria-hidden="true" focusable="false">
			{layout.kind === "line" ? <Lines layout={layout} /> : <Bars layout={layout} />}
		</svg>
	);
}

/** One identity per table content, so a streamed tail table is told apart from the one that settled. */
const tableKey = (header: readonly string[], rows: readonly (readonly string[])[]): string => `${header.join("\u0001")}\u0003${rows.map(row => row.join("\u0001")).join("\u0002")}`;

/** Tail tables already seen unchanged for {@link CHART_SETTLE_MS}: a row that scrolled out of the list and came back charts at once instead of waiting again. */
const settledTables = new Set<string>();
const SETTLED_ENTRIES = 64;

function rememberSettled(key: string): void {
	settledTables.delete(key);
	settledTables.add(key);
	if (settledTables.size > SETTLED_ENTRIES) settledTables.delete(settledTables.keys().next().value as string);
}

/**
 * The chart of one table of an assistant reply, rendered right after it. A table followed by other content is charted at once; the last
 * block of a reply may still be growing, so its chart waits until its text has not changed for {@link CHART_SETTLE_MS}.
 */
export function TableChart({ header, rows, followedByContent }: { header: readonly string[]; rows: readonly (readonly string[])[]; followedByContent: boolean }) {
	const eligible = useContext(AssistantReplyContext);
	const hidden = useSyncExternalStore(subscribeChartsHidden, getChartsHidden, getChartsHidden);
	const key = useMemo(() => (eligible ? tableKey(header, rows) : ""), [eligible, header, rows]);
	const [settledKey, setSettledKey] = useState<string | null>(null);
	useEffect(() => {
		if (!eligible || followedByContent) return;
		const timer = setTimeout(() => {
			rememberSettled(key);
			setSettledKey(key);
		}, CHART_SETTLE_MS);
		return () => clearTimeout(timer);
	}, [eligible, followedByContent, key]);
	const ready = eligible && (followedByContent || settledKey === key || settledTables.has(key));
	const spec = useMemo(() => (ready ? planTableChart(header, rows) : null), [ready, key]);
	if (spec === null) return null;
	if (hidden) {
		return (
			<div className="omp-chart omp-chart-collapsed">
				<button type="button" className="omp-chart-toggle" aria-pressed="true" onClick={() => setChartsHidden(false)}>Show chart</button>
			</div>
		);
	}
	return (
		<div className="omp-chart">
			<div className="omp-chart-head">
				<span className="omp-chart-title">{spec.title}</span>
				<button type="button" className="omp-chart-toggle" aria-pressed="false" onClick={() => setChartsHidden(true)}>Hide chart</button>
			</div>
			<figure className="omp-chart-figure" role="img" aria-label={spec.alt}>
				<ChartDrawing spec={spec} />
			</figure>
		</div>
	);
}
