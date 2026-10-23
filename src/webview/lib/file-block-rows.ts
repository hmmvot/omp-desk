/**
 * What the transcript needs of a sent message that carries attached files (docs/designs/2026-10-16-chat-document-attachments.md,
 * Proposed Design 6): the message split into its prose and its file blocks, the figures a closed row shows, and the text the
 * message's own Copy puts on the clipboard.
 */
import { splitFileBlocks, type SplitMessage } from "../../shared/file-blocks.ts";
import { messageText } from "../../shared/format.ts";

/** Messages kept split. A render, the Copy site and a remount after scrolling all ask for the same text; a block-bearing text parses once. */
const CACHE_ENTRIES = 32;
const cache = new Map<string, SplitMessage>();

/** {@link splitFileBlocks}, remembered for the newest texts. A text that does not parse comes back as prose with no blocks. */
export function splitUserText(text: string): SplitMessage {
	const known = cache.get(text);
	if (known !== undefined) {
		// Most recently used last, so the entry dropped below is the one asked for longest ago.
		cache.delete(text);
		cache.set(text, known);
		return known;
	}
	const split = splitFileBlocks(text);
	cache.set(text, split);
	if (cache.size > CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
	return split;
}

/** Lines of a file's text: a final newline ends the last line instead of starting another; an empty file has none. */
export function lineCount(text: string): number {
	if (text === "") return 0;
	let count = 1;
	for (let at = text.indexOf("\n"); at !== -1 && at < text.length - 1; at = text.indexOf("\n", at + 1)) count++;
	return count;
}

/**
 * The text of a user message as it was sent, less the file blocks: its prose with the `[File #N: name]` markers, which is what the
 * message's Copy copies (a row has its own Copy for the file). A message that does not parse is copied whole, as before.
 */
export function sentTextOf(content: unknown): string {
	if (typeof content === "string") return splitUserText(content).prose;
	if (!Array.isArray(content)) return messageText(content);
	return messageText(content.map(block => {
		const record = typeof block === "object" && block !== null ? block as Record<string, unknown> : null;
		return record !== null && record.type === "text" && typeof record.text === "string" ? { ...record, text: splitUserText(record.text).prose } : block;
	}));
}
