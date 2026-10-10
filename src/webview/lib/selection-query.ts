/**
 * The text a Chat page offers VS Code's symbol search (Ctrl+N), and how the host turns it into a query.
 *
 * VS Code seeds that picker from the editor selection, but a webview's selection is invisible to it, so the page
 * reports its own selection to the host and the host opens `workbench.action.quickOpen` with `#` and that text.
 */

/** Longest query offered; a longer selection is cut, never refused. */
export const MAX_SYMBOL_QUERY_LENGTH = 200;

/** The first non-empty line of a selection, trimmed and capped; `""` when there is nothing to search for. */
export function normalizeSymbolQuery(raw: string): string {
	for (const line of raw.split(/\r\n|\r|\n/)) {
		const text = line.trim();
		if (text.length > 0) return text.length > MAX_SYMBOL_QUERY_LENGTH ? text.slice(0, MAX_SYMBOL_QUERY_LENGTH).trimEnd() : text;
	}
	return "";
}

/** The `workbench.action.quickOpen` argument for a selection (`#Name`), or `null` to open the empty symbol search. */
export function symbolSearchValue(selection: string | null | undefined): string | null {
	const query = normalizeSymbolQuery(selection ?? "");
	return query.length === 0 ? null : `#${query}`;
}

/** The slice of a document {@link selectedText} reads. */
export interface SelectionDocument {
	readonly activeElement: { readonly tagName?: string; readonly value?: string; readonly selectionStart?: number | null; readonly selectionEnd?: number | null } | null;
	getSelection(): { toString(): string } | null;
}

/** What is selected in the page now: the focused text field's selection, else the document's own selection. */
export function selectedText(doc: SelectionDocument): string {
	const field = doc.activeElement;
	if (field !== null && (field.tagName === "TEXTAREA" || field.tagName === "INPUT") && typeof field.value === "string") {
		const start = field.selectionStart ?? 0;
		const end = field.selectionEnd ?? 0;
		if (end > start) return normalizeSymbolQuery(field.value.slice(start, end));
	}
	return normalizeSymbolQuery(doc.getSelection()?.toString() ?? "");
}
