import type { ReactNode } from "react";
import { memo, useMemo, useSyncExternalStore } from "react";
import { styledRuns } from "../lib/code-highlight";
import { codeThemeSnapshot, subscribeCodeTheme } from "../lib/code-theme-store";
import type { CodeThemeStyler } from "../lib/code-theme-style";
import { defaultDepth, displayRow, foldAll, foldable, toggleFold, visibleRows, type JsonDisplayRow, type JsonSource } from "../lib/json-rows";
import { lexJsonLine, MAX_ROW_CHARS } from "../lib/json-tokens";
import { CodeRuns } from "./CodeRuns";
import { OutputRows, useFolds, useRowFilter } from "./tool-view";

interface RowProps {
	readonly row: JsonDisplayRow;
	readonly styler: CodeThemeStyler | null;
	readonly onToggle: (scope: string, row: number) => void;
}

/** One row of JSON: its fold button in the gutter, the text coloured by the theme's JSON scopes, a folded container's summary and a cut row's note. */
const JsonRow = memo(function JsonRow({ row, styler, onToggle }: RowProps): ReactNode {
	const runs = useMemo(() => styler === null || row.plain ? null : styledRuns(lexJsonLine(row.text), styler), [row.text, row.plain, styler]);
	const { fold } = row;
	return <span className="omp-json-row" data-json-row={row.key}>
		<span className="omp-json-gutter" data-n={row.gutter}>
			{fold !== undefined && <button type="button" className="omp-json-twisty" aria-expanded={!fold.folded} aria-label={`${fold.folded ? "Expand" : "Collapse"} ${fold.noun}`} onClick={() => onToggle(fold.scope, fold.row)}>
				<span className={`codicon codicon-chevron-${fold.folded ? "right" : "down"}`} aria-hidden="true" />
			</button>}
		</span>
		{runs === null ? row.text : <CodeRuns runs={runs} />}
		{row.omitted > 0 && <span className="omp-json-ghost"> … +{row.omitted.toLocaleString("en-US")} characters</span>}
		{fold?.folded === true && fold.label !== "" && <><button type="button" className="omp-json-ghost omp-json-ghost--fold" onClick={() => onToggle(fold.scope, fold.row)}>{` ${fold.label} `}</button>{fold.tail}</>}
		{"\n"}
	</span>;
});

/**
 * A JSON document or newline-delimited JSON as rows: folded to its first levels, each container one button away,
 * a preview of the first rows of what shows (`expanded` false) or all of it.
 */
export function JsonRows({ source, scope, expanded }: { source: JsonSource; scope: string; expanded: boolean }): ReactNode {
	const [folds, setFolds] = useFolds();
	const fallback = defaultDepth(source);
	const filter = useRowFilter(expanded);
	const all = useMemo(() => visibleRows(source, folds, scope, fallback, filter), [source, folds, scope, fallback, filter]);
	const widthCh = useMemo(() => 12 + (source.kind === "ndjson" ? MAX_ROW_CHARS : Math.min(MAX_ROW_CHARS, source.tree.rows.reduce((width, row) => Math.max(width, row.length), 0))), [source]);
	const { styler } = useSyncExternalStore(subscribeCodeTheme, codeThemeSnapshot, codeThemeSnapshot);
	const onToggle = useMemo(() => (at: string, row: number): void => setFolds(toggleFold(folds, at, row)), [folds, setFolds]);
	const unit = source.kind === "ndjson" && all.length === source.records.length ? "record" : "line";
	// The marker counts the rows hidden; the button names the records, however many rows an unfolded one has.
	const named = source.kind === "ndjson" ? { count: source.records.length, unit: source.records.length === 1 ? "record" : "records" } : undefined;
	return <div className="omp-native-preview omp-json" data-json-kind={source.kind}>
		{all.length === 0 && filter !== "" ? <div className="omp-empty-note">No line contains “{filter}”</div> : <OutputRows all={all} expanded={expanded} unit={unit} named={named} fixed widthCh={widthCh} render={ids => <pre className="omp-pre omp-pre--rows">{ids.map(id => <JsonRow key={id} row={displayRow(source, id, folds, scope, fallback, filter)} styler={styler} onToggle={onToggle} />)}</pre>} />}
	</div>;
}

/** Expand all and Collapse all for the folds of a source, as two icon buttons of the output bar. */
export function FoldAllButtons({ source, scope }: { source: JsonSource; scope: string }): ReactNode {
	const [folds, setFolds] = useFolds();
	if (!foldable(source)) return null;
	return <span className="omp-fold-all">
		<button type="button" className="omp-iconbtn" aria-label="Expand all" title="Expand all" onClick={() => setFolds(foldAll(folds, scope, source, true))}><span className="codicon codicon-expand-all" aria-hidden="true" /></button>
		<button type="button" className="omp-iconbtn" aria-label="Collapse all" title="Collapse all" onClick={() => setFolds(foldAll(folds, scope, source, false))}><span className="codicon codicon-collapse-all" aria-hidden="true" /></button>
	</span>;
}
