/**
 * What plain tool output can be read as beyond lines: tables (`ls -l`, PowerShell `Format-Table`), stack traces (frames dimmed,
 * their paths linked) and error, warning and pass lines (a light tint). Every detector is a heuristic: a result it changes the
 * layout of carries a badge and a Text switch (`OutputFormat`), and the original text is never lost.
 *
 * No expression here has a nested quantifier, and each line is read once.
 */

export type LineTone = "err" | "warn" | "pass";

const ERROR_LINE = /^\s*(?:[✖✘×]|not ok\b|FAIL\b|fatal:|Traceback \()|\bnpm ERR!|(?:^|[\s:])(?:error|ERROR)\b[ \w]*:|\b[A-Za-z_.]*(?:Error|Exception):(?:\s|$)|: error TS\d+/;
const WARNING_LINE = /^\s*(?:⚠|warning\b|WARN\b)|\bwarning:|\bwarning [A-Z]{2,}\d+/;
const PASS_LINE = /^\s*(?:[✔✓]|ok\b|PASS\b)/;

/** The tint of one line of output: an error, a warning or a pass, by the words and marks tools use. Colour is never the only carrier: the words stay. */
export function lineTone(line: string): LineTone | null {
	if (line.length > 400) return null;
	if (ERROR_LINE.test(line)) return "err";
	if (WARNING_LINE.test(line)) return "warn";
	return PASS_LINE.test(line) ? "pass" : null;
}

/** A line of a stack trace: where the frame is, cut so that the path can be linked. */
export interface Frame {
	/** The location as written (`C:\src\a.ts:12:5`), which a link wraps. */
	readonly location: string;
	/** The file, the line and (when given) the column of it. */
	readonly path: string;
	readonly line: number;
	readonly column?: number;
}

const JS_FRAME = /^\s+at (?:.* \()?(.+?):(\d+)(?::(\d+))?\)?\s*$/;
const PYTHON_FRAME = /^\s+File "(.+)", line (\d+)(?:, in .*)?$/;
const DOTNET_FRAME = /^\s+at .* in (.+?):line (\d+)\s*$/;

/** The frame a line is, if it is one of a stack trace's. */
export function parseFrame(line: string): Frame | null {
	if (line.length > 600) return null;
	const python = PYTHON_FRAME.exec(line);
	if (python !== null) return { location: python[1]!, path: python[1]!, line: Number(python[2]) };
	const dotnet = DOTNET_FRAME.exec(line);
	if (dotnet !== null) return { location: `${dotnet[1]}:line ${dotnet[2]}`, path: dotnet[1]!, line: Number(dotnet[2]) };
	const js = JS_FRAME.exec(line);
	if (js === null || /^(?:node:|<anonymous>|native)/.test(js[1]!)) return null;
	return { location: `${js[1]}:${js[2]}${js[3] === undefined ? "" : `:${js[3]}`}`, path: js[1]!, line: Number(js[2]), ...(js[3] === undefined ? {} : { column: Number(js[3]) }) };
}

/** A table the output holds: its columns' widths in characters and which of them hold numbers. */
export interface TableShape {
	readonly widths: readonly number[];
	readonly right: readonly boolean[];
}

/** One line of output as the formatted view draws it. */
export interface OutputRow {
	readonly text: string;
	/** A row of a table: its cells, and the table it belongs to (an index of `RowsFormat.tables`). */
	readonly cells?: readonly string[];
	readonly table?: number;
	/** The column titles of a table. */
	readonly head?: boolean;
	/** A line of a stack trace: its frame, or (a line of source under a frame) `dim` only. */
	readonly frame?: Frame;
	readonly dim?: boolean;
}

export interface RowsFormat {
	readonly kind: "rows";
	readonly rows: readonly OutputRow[];
	readonly tables: readonly TableShape[];
	readonly badge: string;
	/** The text as it came. */
	readonly copy: string;
}

/** A listing with at most this many rows is a table; a longer one stays text. */
export const MAX_TABLE_ROWS = 5_000;
const LS_ROW = /^([-dlcbps][-rwxsStT]{9}[.+@]?)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d+(?:, *\d+)?)\s+([A-Z][a-z]{2}\s+\d{1,2}\s+(?:\d{2}:\d{2}|\d{4}))\s+(.+)$/;
const RULE_LINE = /^-+(?:\s+-+)+\s*$/;

/** The start of every run of dashes in a Format-Table rule line, and where it ends. */
function ruleColumns(rule: string): number[] {
	const starts: number[] = [];
	for (let at = 0; at < rule.length; at++) if (rule.charCodeAt(at) === 45 && (at === 0 || rule.charCodeAt(at - 1) !== 45)) starts.push(at);
	return starts;
}

const NUMBER_CELL = /^-?[\d,.]+$/;

function tableOfRows(rows: readonly (readonly string[])[], numeric: readonly boolean[] | null, titled: boolean): TableShape {
	const widths = rows[0]!.map((_, column) => rows.reduce((width, row) => Math.max(width, (row[column] ?? "").length), 0));
	const right = numeric ?? widths.map((_, column) => rows.slice(titled ? 1 : 0).every(row => (row[column] ?? "") === "" || NUMBER_CELL.test(row[column]!)));
	return { widths, right };
}

/**
 * Tables and stack traces in `text`, line by line, or `null` when it holds neither (a table needs two rows and a trace two frames).
 * Every line of the text is a row of the result, in order.
 */
export function detectRows(text: string): RowsFormat | null {
	const lines = text.replace(/\s+$/, "").split("\n").map(line => line.replace(/\r$/, ""));
	if (lines.length < 2) return null;
	const rows: OutputRow[] = lines.map(line => ({ text: line }));
	const tables: TableShape[] = [];
	let tableRows = 0, frames = 0;
	// `ls -l`: runs of two or more listing lines.
	for (let start = 0; start < lines.length;) {
		if (!LS_ROW.test(lines[start]!)) { start++; continue; }
		const run: string[][] = [];
		let end = start;
		for (let match = LS_ROW.exec(lines[end]!); match !== null; match = end < lines.length ? LS_ROW.exec(lines[end]!) : null) { run.push(match.slice(1)); end++; }
		if (run.length >= 2 && run.length <= MAX_TABLE_ROWS) {
			tables.push(tableOfRows(run, [false, true, false, false, true, false, false], false));
			run.forEach((cells, index) => { rows[start + index] = { text: lines[start + index]!, cells, table: tables.length - 1 }; });
			tableRows = Math.max(tableRows, run.length);
		}
		start = end;
	}
	// `Format-Table`: a title line over a rule of dashes, and the rows under them until a blank line.
	for (let at = 1; at < lines.length; at++) {
		const rule = lines[at]!;
		if (!RULE_LINE.test(rule) || rows[at - 1]!.table !== undefined || lines[at - 1]!.trim() === "") continue;
		const starts = ruleColumns(rule);
		const title = lines[at - 1]!;
		if (starts.some(column => title.charAt(column) === "" || title.charAt(column) === " ")) continue;
		const slice = (line: string): string[] => starts.map((column, index) => line.slice(column, index + 1 < starts.length ? starts[index + 1] : undefined).trim());
		const run: string[][] = [slice(title)];
		let end = at + 1;
		while (end < lines.length && lines[end]!.trim() !== "" && run.length <= MAX_TABLE_ROWS) { run.push(slice(lines[end]!)); end++; }
		if (run.length < 2 || run.length > MAX_TABLE_ROWS) continue;
		tables.push(tableOfRows(run, null, true));
		const table = tables.length - 1;
		rows[at - 1] = { text: title, cells: run[0], table, head: true };
		rows[at] = { text: rule, table, head: true, cells: slice(rule) };
		for (let index = 1; index < run.length; index++) rows[at + index] = { text: lines[at + index]!, cells: run[index], table };
		tableRows = Math.max(tableRows, run.length);
		at = end;
	}
	// Stack traces: frames, and the source lines Python prints under its own.
	const traceRows: number[] = [];
	for (let at = 0; at < lines.length; at++) {
		const frame = parseFrame(lines[at]!);
		if (frame === null || rows[at]!.table !== undefined) continue;
		traceRows.push(at);
		rows[at] = { text: lines[at]!, frame };
		frames++;
		if (PYTHON_FRAME.test(lines[at]!)) while (at + 1 < lines.length && /^ {4,}\S/.test(lines[at + 1]!) && parseFrame(lines[at + 1]!) === null) { at++; rows[at] = { text: lines[at]!, dim: true }; }
	}
	if (frames < 2) {
		for (const at of traceRows) rows[at] = { text: lines[at]! };
		frames = 0;
		for (let at = 0; at < rows.length; at++) if (rows[at]!.dim === true) rows[at] = { text: lines[at]! };
	}
	if (tables.length === 0 && frames === 0) return null;
	const badges = [tables.length > 0 ? `Table · ${tableRows.toLocaleString("en-US")} rows` : "", frames > 0 ? `Stack trace · ${frames.toLocaleString("en-US")} frames` : ""].filter(Boolean);
	return { kind: "rows", rows, tables, badge: badges.join(" · "), copy: text };
}
