/**
 * The cells of one table line (a header, a separator or a row): the renderer draws from `text`, and quoting needs `source`, the
 * cell as it was written, to carry a cell over to a narrower table (docs/designs/2026-10-15-quote-chat-selection.md, the
 * 2026-10-17 amendment).
 */

export interface TableCell {
	/** The cell as written between its pipes, trimmed: escapes (`\|`) are still in it. */
	readonly source: string;
	/** What the renderer draws from: `source` without the backslash of every escape, trimmed. */
	readonly text: string;
}

/** Split a table line on unescaped pipes, dropping the optional edge pipes. A backslash escapes the character after it. */
export function splitTableCells(line: string): TableCell[] {
	const cells: { source: string; text: string }[] = [];
	let source = "";
	let text = "";
	for (let i = 0; i < line.length; i++) {
		const ch = line[i] as string;
		if (ch === "\\" && i + 1 < line.length) {
			source += ch + (line[i + 1] as string);
			text += line[i + 1] as string;
			i++;
			continue;
		}
		if (ch === "|") {
			cells.push({ source, text });
			source = "";
			text = "";
			continue;
		}
		source += ch;
		text += ch;
	}
	cells.push({ source, text });
	if (cells.length > 1 && (cells[0] as { text: string }).text.trim() === "") cells.shift();
	if (cells.length > 1 && (cells[cells.length - 1] as { text: string }).text.trim() === "") cells.pop();
	return cells.map(cell => ({ source: cell.source.trim(), text: cell.text.trim() }));
}

/** `text` written as the content of one cell: the backslash and the pipe are escaped, so `splitTableCells` reads it back. */
export function escapeTableCell(text: string): string {
	return text.replace(/[\\|]/g, "\\$&");
}
