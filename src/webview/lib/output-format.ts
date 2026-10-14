/**
 * The formats a tool's output can be read as, and the one detection that finds them: JSON and newline-delimited JSON
 * (`json-tokens.ts`), then tables and stack traces (`output-rows.ts`). Detection runs on settled output only, under the same
 * 1 MiB bound, and is cached by text.
 */
import { detectOutputFormat as detectJson, MAX_JSON_BYTES, type OutputFormat as JsonFormat } from "./json-tokens.ts";
import { detectRows, type RowsFormat } from "./output-rows.ts";

export type OutputFormat = JsonFormat | RowsFormat;

const cache = new Map<string, OutputFormat | null>();
const CACHE_ENTRIES = 8;

/** What `text` is, if it is one of the formats; `null` for plain text. */
export function detectOutput(text: string): OutputFormat | null {
	if (text.length < 2 || text.length > MAX_JSON_BYTES) return null;
	if (cache.has(text)) return cache.get(text) ?? null;
	const found = detectJson(text) ?? detectRows(text);
	cache.set(text, found);
	while (cache.size > CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
	return found;
}
