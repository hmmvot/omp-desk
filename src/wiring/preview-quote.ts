/**
 * "OMP Desk: Quote Selection to Session" in VS Code's Markdown preview (docs/designs/2026-10-15-quote-chat-selection.md, decision 12):
 * the pure rules. The selected RENDERED text is quoted, and the location line names the document with its path alone, written by
 * the quote's own path rule (relative inside the target session's folder, else absolute), with no line numbers: a rendered
 * selection has no source lines.
 *
 * No `vscode` import: everything here is exercised by plain `node --test`.
 *
 * Runner: `node --test src/wiring/preview-quote.test.ts`
 */
import { MAX_QUOTE_SIDE_LOCATION_LENGTH } from "../protocol/messages.ts";
import { quoteSizeRefusal } from "../shared/quote-limit.ts";
import { mentionPath } from "../host/file-mentions.ts";
import { UNSAFE_PATH } from "../host/bracketed-paste.ts";
import type { EditorQuotes, Refusal } from "./editor-context.ts";

/** The `viewType` of the Markdown preview's webview tab as the tab API reports it (`TabInputWebview.viewType`), measured on VS Code 1.142.0. */
export const MARKDOWN_PREVIEW_TAB_VIEW_TYPE = "mainThreadWebview-markdown.preview";

/** The `viewType` of the Markdown preview opened as an editor (Open With… Markdown Preview, or an `editorAssociations` entry): a custom editor tab, which names its file. */
export const MARKDOWN_PREVIEW_CUSTOM_VIEW_TYPE = "vscode.markdown.preview.editor";

/** The document a preview shows: its file, or `null` when it could not be told apart (then only its name is known). */
export interface PreviewDocument {
	readonly fsPath: string | null;
	/** The file name the preview's tab label ends with. */
	readonly name: string;
}

/**
 * Which of `candidates` (paths of open and workspace Markdown files) a preview tab with this `label` shows. The label is the
 * localised preview title (`[Preview] chat.md`, and `Preview chat.md` for a locked preview, measured on VS Code 1.142.0), so only its ending is relied on: the candidate's file name, after a space.
 * Exactly one distinct path matches → that file; none or several → `null`, and the caller names the document by {@link fallbackName}.
 */
export function resolvePreviewFile(label: string, candidates: readonly string[]): string | null {
	const matching = new Set<string>();
	for (const path of candidates) {
		const name = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
		if (name.length > 0 && (label === name || label.endsWith(` ${name}`))) matching.add(path);
	}
	return matching.size === 1 ? ([...matching][0] as string) : null;
}

/** The file name a label names when no file is found: its last whitespace-separated word, which is the name for every name without a space. */
export function fallbackName(label: string): string {
	const trimmed = label.trim();
	return trimmed.slice(trimmed.lastIndexOf(" ") + 1);
}

/** The quote of one preview selection for the target session's `cwd`: the rendered text under the document's path, or its name alone. */
export function composePreviewQuote(document: PreviewDocument, text: string, cwd: string): EditorQuotes | Refusal {
	const body = text.replace(/\r\n?/g, "\n").replace(/^\n+|\n+$/g, "");
	if (body.trim().length === 0) return { ok: false, reason: "Select some text in the preview first." };
	if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(body)) return { ok: false, reason: "The selection holds a control character that a message cannot carry." };
	const tooLong = quoteSizeRefusal(body.length);
	if (tooLong !== null) return { ok: false, reason: tooLong };
	let location = document.name;
	if (document.fsPath !== null) {
		location = mentionPath(document.fsPath, cwd);
		if (location.length > MAX_QUOTE_SIDE_LOCATION_LENGTH) return { ok: false, reason: `The path of “${document.fsPath}” is too long to quote.` };
	}
	if (location.length === 0 || UNSAFE_PATH.test(location)) return { ok: false, reason: `“${document.fsPath ?? document.name}” has a character a message cannot carry.` };
	return { ok: true, quotes: [{ location, fileName: document.name, languageId: "markdown", text: body }], summary: location };
}
