import type { ReactNode } from "react";
import { useMemo } from "react";
import { lineTone, type OutputRow, type RowsFormat } from "../lib/output-rows";
import { FileLinkText } from "./FileLinks";
import { OutputRows, useRowFilter } from "./tool-view";

/** One line of a table, a stack trace or plain output: a table row is a grid of its cells, a frame is dim with its path linked. */
function RowLine({ row, format }: { row: OutputRow; format: RowsFormat }): ReactNode {
	if (row.cells !== undefined && row.table !== undefined) {
		const table = format.tables[row.table]!;
		return <span className={`omp-row omp-grid-row${row.head === true ? " omp-grid-row--head" : ""}`} style={{ gridTemplateColumns: table.widths.map(width => `${Math.max(1, width)}ch`).join(" ") }}>
			{row.cells.map((cell, index) => <span key={index} className={table.right[index] === true ? "omp-cell--right" : undefined}>{cell}</span>)}
		</span>;
	}
	if (row.frame !== undefined) {
		const { frame } = row;
		return <span className="omp-row omp-row--frame"><FileLinkText text={row.text} link={{ text: frame.location, target: `${frame.path}:${frame.line}${frame.column === undefined ? "" : `:${frame.column}`}`, proof: frame.path }} /></span>;
	}
	const tone = row.dim === true ? null : lineTone(row.text);
	return <span className={`omp-row${row.dim === true ? " omp-row--frame" : tone === null ? "" : ` omp-tone--${tone}`}`}>{row.text}</span>;
}

/** Tables and stack traces as rows: every line of the output is a row, so the preview, the full view and the filter work as on any text. */
export function RowsView({ format, expanded, tail = false }: { format: RowsFormat; expanded: boolean; tail?: boolean }): ReactNode {
	const filter = useRowFilter(expanded);
	const rows = useMemo(() => filter === "" ? format.rows : format.rows.filter(row => row.text.toLowerCase().includes(filter)), [format, filter]);
	const widthCh = useMemo(() => rows.reduce((width, row) => Math.max(width, row.text.length), 0) + 2, [rows]);
	if (rows.length === 0) return <div className="omp-empty-note">No line contains “{filter}”</div>;
	return <div className="omp-native-preview omp-rows" data-rows-kind={format.tables.length > 0 ? "table" : "trace"}>
		<OutputRows all={rows} expanded={expanded} tail={tail} fixed widthCh={widthCh} render={part => <pre className="omp-pre">{part.map((row, index) => <RowLine key={index} row={row} format={format} />)}</pre>} />
	</div>;
}
