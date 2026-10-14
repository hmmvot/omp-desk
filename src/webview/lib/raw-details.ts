/**
 * A tool result's `details` for the reader who asked to see them (the `⋯` menu's Raw view and Copy details): the
 * view cuts long strings and long arrays and says so, the copy cuts only the enormous strings, and neither carries an image
 * payload. `details` can hold large strings and paths, so it is shown on request only.
 */

/** Raw view: a string longer than this is cut. */
export const RAW_STRING_CHARS = 300;
/** Raw view: an array longer than this shows its first items and a count of the rest. */
export const RAW_ARRAY_ITEMS = 12;
/** Copy details: a string longer than this is cut. */
export const COPY_STRING_CHARS = 20_000;
/** A value nested deeper than this is replaced by its marker (a cyclic or absurd structure cannot run away). */
const MAX_DEPTH = 24;

const grouped = (count: number): string => count.toLocaleString("en-US");

/** An image block's payload (`{ type: "image", data, mimeType }`) or a data URL: never shown or copied. */
function isImagePayload(owner: Record<string, unknown>, key: string, value: unknown): boolean {
	return typeof value === "string" && (key === "data" && owner.type === "image" || /^data:image\//.test(value));
}

function cut(value: unknown, stringLimit: number, arrayLimit: number, depth: number): unknown {
	if (typeof value === "string") return value.length > stringLimit ? `${value.slice(0, stringLimit)}… [+${grouped(value.length - stringLimit)} characters]` : value;
	if (value === null || typeof value !== "object") return value;
	if (depth >= MAX_DEPTH) return "[nested too deeply]";
	if (Array.isArray(value)) {
		const kept = value.slice(0, arrayLimit).map(item => cut(item, stringLimit, arrayLimit, depth + 1));
		return value.length > arrayLimit ? [...kept, `… [+${grouped(value.length - arrayLimit)} more items]`] : kept;
	}
	const owner = value as Record<string, unknown>;
	const result: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(owner)) {
		result[key] = isImagePayload(owner, key, item) ? `[image data, ${grouped((item as string).length)} characters, not shown]` : cut(item, stringLimit, arrayLimit, depth + 1);
	}
	return result;
}

/** What the Raw view's details tree shows: strings over {@link RAW_STRING_CHARS} and arrays over {@link RAW_ARRAY_ITEMS} cut and marked. */
export function rawDetailsView(details: unknown): unknown {
	return cut(details, RAW_STRING_CHARS, RAW_ARRAY_ITEMS, 0);
}

/** What Copy details puts on the clipboard: the whole object as indented JSON, strings over {@link COPY_STRING_CHARS} cut and marked, no image payload. */
export function rawDetailsCopy(details: unknown): string {
	return JSON.stringify(cut(details, COPY_STRING_CHARS, Number.POSITIVE_INFINITY, 0), null, 2) ?? "";
}
