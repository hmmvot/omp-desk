/**
 * `text` as one inline Markdown code span: its delimiter is longer than any backtick run inside, and a backtick at either edge is
 * padded with a space. Shared by the host (the line reference `Alt+Q` writes with no selection) and the page (the location line of a
 * quote), so one rule writes both.
 */
export function codeSpan(text: string): string {
	let longest = 0;
	for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
	const delimiter = "`".repeat(longest + 1);
	const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
	return `${delimiter}${pad}${text}${pad}${delimiter}`;
}
