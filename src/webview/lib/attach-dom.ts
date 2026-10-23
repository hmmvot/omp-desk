/**
 * What the composer reads from the `DataTransfer` of a paste or a drag and from the host's answer to a drop: the DOM side of attaching,
 * which stays with the composer's events (docs/designs/2026-10-23-composer-draft-module.md, section 4). What is done with the files is the
 * Draft's `attach`.
 */
import { attachGuardRefusal } from "./draft/draft.ts";

/** Files in a paste or drop payload, in clipboard order: images and documents alike, told apart later by their first bytes. */
export function filesFrom(data: DataTransfer | null): File[] {
	if (data === null) return [];
	const files: File[] = [];
	for (let index = 0; index < data.items.length; index++) {
		const item = data.items[index];
		if (item === undefined || item.kind !== "file") continue;
		const file = item.getAsFile();
		if (file !== null) files.push(file);
	}
	return files;
}

/** Drag type VS Code's Explorer and editor tabs write: every dragged item as a `file:` URI line. */
const CODE_URI_LIST = "application/vnd.code.uri-list";

/**
 * What a drag carries that the composer can attach: `files` (an OS drag: the page reads the bytes), `uris` (a drag from
 * VS Code's Explorer or an editor tab: only addresses, the host reads them), or `null` (text, a link: left to the browser).
 * Only the type names are readable while a drag is over the page, never its data.
 */
export function dragCarries(data: DataTransfer): "files" | "uris" | null {
	if (Array.from(data.items).some(item => item.kind === "file")) return "files";
	const types = Array.from(data.types);
	return types.includes(CODE_URI_LIST) || types.includes("ResourceURLs") ? "uris" : null;
}

/** What a drop named: its `file:` URIs, or the sentence that refuses the whole drop (then `uris` is empty). */
export interface DroppedUris {
	readonly uris: string[];
	readonly refusal: string | null;
}

/**
 * The `file:` URIs a drop names, in drag order; other schemes and comments are not attachments. It reads one past `limit`
 * so a drop over it is refused whole instead of silently losing everything after the `limit`th URI.
 */
export function droppedFileUris(data: DataTransfer | null, limit: number): DroppedUris {
	if (data === null) return { uris: [], refusal: null };
	const raw = data.getData(CODE_URI_LIST) || data.getData("text/uri-list");
	const uris: string[] = [];
	for (const line of raw.split(/\r?\n/)) {
		const uri = line.trim();
		if (/^file:/i.test(uri)) uris.push(uri);
		if (uris.length > limit) return { uris: [], refusal: attachGuardRefusal(uris.length, 0, limit) };
	}
	return { uris, refusal: null };
}

/** An image the host read for a drop, as a `File` the ordinary attach path takes. */
export function fileFromAttached(attached: { readonly name: string; readonly mimeType: string; readonly data: string }): File {
	const binary = atob(attached.data);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
	return new File([bytes as BlobPart], attached.name, { type: attached.mimeType });
}
