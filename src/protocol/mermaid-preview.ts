/**
 * The messages of the diagram tab (`ompDesk.mermaidPreview`): a mermaid source the chat page may not draw inline, drawn in
 * an editor tab of its own.
 *
 * Three messages carry it. `omp:open-mermaid` (chat page to host, defined with the other guest messages in `messages.ts`)
 * asks for the tab; the tab's own document then announces itself with {@link MermaidPreviewReadyMessage} and is answered
 * with {@link MermaidPreviewSourceMessage}. The source never travels in the document's HTML.
 */

/**
 * Longest source (UTF-16 code units) the host will open in a tab; the chat page shows no button above it. A render is one
 * uninterruptible task that only closing the tab ends; it took 0.8 to 7.4 s for a 20,000-character source (ADR-0069), and the cost
 * of a longer one was not measured, so the limit is a bound on that unknown, not a promise of a time.
 */
export const MAX_MERMAID_OPEN_CHARS = 50_000;

/** The meta tag the diagram tab's document carries; its value, `tab`, is the scope the renderer in that document draws under (every other document is `chat`). */
export const MERMAID_SCOPE_META = "omp-mermaid-scope";

/** The tab's document listens: send it the source (again after a reload). */
export interface MermaidPreviewReadyMessage {
	type: "omp:mermaid-preview-ready";
}

/** Host to tab: the diagram to draw. */
export interface MermaidPreviewSourceMessage {
	type: "omp:mermaid-preview-source";
	source: string;
}

/** Whether `value` is a source the host may open: text, not empty, within {@link MAX_MERMAID_OPEN_CHARS}. */
export function isOpenableMermaidSource(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= MAX_MERMAID_OPEN_CHARS;
}

/** What the tab's document may say to the host; anything else is dropped. */
export function parseMermaidPreviewMessage(value: unknown): MermaidPreviewReadyMessage | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	return Object.keys(record).length === 1 && record.type === "omp:mermaid-preview-ready" ? { type: "omp:mermaid-preview-ready" } : null;
}

/** What the tab's document accepts from the host, or `null`. */
export function parseMermaidPreviewSource(value: unknown): MermaidPreviewSourceMessage | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (Object.keys(record).length !== 2 || record.type !== "omp:mermaid-preview-source" || !isOpenableMermaidSource(record.source)) return null;
	return { type: "omp:mermaid-preview-source", source: record.source };
}
