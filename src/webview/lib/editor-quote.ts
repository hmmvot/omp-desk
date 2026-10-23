/**
 * The Markdown of a quote taken from a text editor (`ompDesk.quoteEditorSelection`, `Alt+Q` in an editor;
 * docs/designs/2026-10-15-quote-chat-selection.md, decision 9). The host sends the selected text and the location it wrote for
 * the target session; the page writes the quote the way it writes any quote, so one composer path places them all.
 *
 * - The first line is the location as inline code (`src/app.ts:42-50`, or `src/app.ts:3-4 @ HEAD (3f2a9c1)` for a Git version),
 *   never an `@` mention: OMP expands a mention of an idle prompt into the whole file. It is not one because it does not start
 *   with `@` and the one `@` in it has a space on both sides (`quote-location.ts` writes only that form). A document with no
 *   path has no location line.
 * - A Markdown or plain-text document is quoted as its own lines. A code file is a fenced block whose info string is the file's
 *   language and whose fence is longer than any backtick run that could close it early.
 */
import type { GuestEditorQuote } from "../../protocol/messages.ts";
import { codeSpan } from "../../shared/code-span.ts";
import { fenceFor } from "./code-fence.ts";
import { languageForPath, languageId } from "./code-languages.ts";
import type { QuoteRequest } from "./draft/draft.ts";

/** VS Code language ids of documents that are prose: they are quoted as plain quote lines, with no fence. */
const PROSE_LANGUAGE_IDS: ReadonlySet<string> = new Set(["markdown", "plaintext"]);

/** Whether the quoted text is prose (a Markdown or plain-text document) rather than code. */
export function isProse(quote: Pick<GuestEditorQuote, "fileName" | "languageId">): boolean {
	return PROSE_LANGUAGE_IDS.has(quote.languageId) || languageForPath(quote.fileName) === "markdown";
}

/** The fence's info string: the file's language, else the editor's own language id when it is one of ours, else none. */
export function infoString(quote: Pick<GuestEditorQuote, "fileName" | "languageId">): string {
	return languageForPath(quote.fileName) ?? languageId(quote.languageId) ?? "";
}

/** The Markdown of one editor quote, before the `> ` prefixes. */
export function editorQuoteMarkdown(quote: GuestEditorQuote): string {
	const lines: string[] = [];
	if (quote.location !== null) lines.push(codeSpan(quote.location));
	const body = quote.text.split("\n");
	if (isProse(quote)) {
		// A paragraph line right under the location would continue its line: one empty line keeps them two blocks.
		if (quote.location !== null) lines.push("");
		lines.push(...body);
	} else {
		const fence = fenceFor(body);
		lines.push(`${fence}${infoString(quote)}`, ...body, fence);
	}
	return lines.join("\n");
}

/** The request that quotes `quotes` into the draft: one Markdown per selection, sized by the selected text as the host measured it. */
export function editorQuoteRequest(quotes: readonly GuestEditorQuote[]): QuoteRequest {
	return { kind: "editor", sources: quotes.map(editorQuoteMarkdown), size: quotes.reduce((sum, quote) => sum + quote.text.length, 0) };
}
