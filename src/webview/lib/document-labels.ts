/**
 * The words and the icon of an attachment tile in the strip under the composer's field (`components/AttachmentStrip.tsx`): what a
 * document looks like, never what its text is. Pure.
 */
import type { DraftDocument } from "./draft/draft.ts";

/** The codicon a document's tile shows, chosen by the file's extension. */
export function documentIcon(name: string): "markdown" | "file-code" | "file" {
	const extension = documentExtension(name).toLowerCase();
	if (extension === "md" || extension === "markdown" || extension === "mdx") return "markdown";
	return CODE_EXTENSIONS.has(extension) ? "file-code" : "file";
}

const CODE_EXTENSIONS = new Set([
	"c", "cc", "cpp", "cs", "css", "go", "h", "hpp", "html", "java", "js", "json", "jsx", "kt", "lua", "mjs", "cjs", "php", "ps1", "py", "rb", "rs", "scss", "sh", "sql", "swift", "toml", "ts", "tsx", "vue", "xml", "yaml", "yml",
]);

/** The extension of a file name without its dot, or an empty string (`Makefile`, `.env`). */
export function documentExtension(name: string): string {
	const dot = name.lastIndexOf(".");
	return dot <= 0 || dot === name.length - 1 ? "" : name.slice(dot + 1);
}

/** The words a tile's tooltip shows for a document (no file text is shown anywhere in the strip). */
export function documentTooltip(document: DraftDocument): string {
	if (document.source.kind === "linked") return "read from disk when sent";
	return document.source.label ?? "no path: the text is held in the draft";
}
