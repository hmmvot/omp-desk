/** Reading the text of a mermaid source without mermaid: shared by the chat page, the diagram tab and the host (a tab's title). */

/**
 * The diagram type's first keyword, lower-cased, after any front matter, `%%{init …}%%` directive (possibly over several
 * lines) and `%%` comment lines; `null` when there is none.
 */
export function mermaidKeyword(source: string): string | null {
	// Front matter ends at a line that is only `---`; a `---` inside a value does not end it (mermaid reads it the same way).
	const body = source.replace(/^\s*---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, "").replace(/^(?:\s*%%\{[\s\S]*?\}%%|\s*%%[^\n]*)+/, "");
	return /^\s*([A-Za-z][\w-]*)/.exec(body)?.[1]?.toLowerCase() ?? null;
}

/** `flowchart`, `sequence`, `class` … from the diagram's first keyword, for a label; `diagram` when there is none. */
export function mermaidKind(source: string): string {
	const keyword = mermaidKeyword(source);
	if (keyword === null) return "diagram";
	if (keyword === "graph") return "flowchart";
	// The keyword is model text: a tab title takes at most this many characters of it.
	return (keyword.replace(/-beta$/, "").replace(/diagram(-v2)?$/, "").replace(/-v2$/, "") || "diagram").slice(0, 32);
}
