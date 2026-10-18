/**
 * The hunk of a diff editor that `ompDesk.quoteEditorSelection` quotes when nothing is selected and the caret is on a changed line
 * (docs/designs/2026-10-15-quote-chat-selection.md, decision 11). VS Code has no API for the hunks of a diff, so this finds the two
 * documents of the diff the active editor is a side of (the tab's input), reads their text, and the hunk is computed from the two
 * texts (`src/shared/line-diff.ts`); the location of each side is the quote's own (`quote-source.ts`).
 */
import * as vscode from "vscode";
import { hunkAtLine } from "../shared/line-diff.ts";
import type { HunkQuoteSource } from "./editor-context.ts";
import { quoteSourceOf } from "./quote-source.ts";

interface DiffUris {
	readonly original: vscode.Uri;
	readonly modified: vscode.Uri;
}

/** The two documents of a diff tab input: a diff editor's own, or one of the diffs of a multi-file diff editor (`textDiffs`, not in the typings of this VS Code API). */
function diffsOf(input: unknown): readonly DiffUris[] {
	if (input instanceof vscode.TabInputTextDiff) return [input];
	const nested = (input as { readonly textDiffs?: unknown } | null | undefined)?.textDiffs;
	return Array.isArray(nested) ? nested.filter((item): item is vscode.TabInputTextDiff => item instanceof vscode.TabInputTextDiff) : [];
}

/**
 * The diff the editor is a side of: the visible tab of the editor's own group (its `viewColumn`; the active group when VS Code gives
 * none, as for an editor embedded in a multi-file diff). Another group's diff is not looked at: a plain editor of the same file beside
 * it is not a side of that diff.
 */
function diffOf(editor: vscode.TextEditor): DiffUris | null {
	const { tabGroups } = vscode.window;
	const group = (editor.viewColumn === undefined ? undefined : tabGroups.all.find(candidate => candidate.viewColumn === editor.viewColumn)) ?? tabGroups.activeTabGroup;
	const key = editor.document.uri.toString();
	return diffsOf(group.activeTab?.input).find(diff => diff.original.toString() === key || diff.modified.toString() === key) ?? null;
}

/**
 * The hunk of `editor`'s diff that has the caret's line among its changed lines, or `null` when the editor is no side of a diff, the
 * caret is on no changed line of its side (this includes a block that only deletes, seen from the modified side, which has no line
 * there), or the pair is too large or too different for the diff (`line-diff.ts`). Each side's location is that document's own.
 */
export async function quoteHunkOf(editor: vscode.TextEditor): Promise<HunkQuoteSource | null> {
	const diff = diffOf(editor);
	if (diff === null) return null;
	const isModified = diff.modified.toString() === editor.document.uri.toString();
	let other: vscode.TextDocument;
	try {
		other = await vscode.workspace.openTextDocument(isModified ? diff.original : diff.modified);
	} catch {
		return null;
	}
	const [originalDocument, modifiedDocument] = isModified ? [other, editor.document] : [editor.document, other];
	const hunk = hunkAtLine(originalDocument.getText(), modifiedDocument.getText(), isModified ? "modified" : "original", editor.selection.active.line);
	if (hunk === null) return null;
	const [original, modified] = await Promise.all([quoteSourceOf(originalDocument, []), quoteSourceOf(modifiedDocument, [])]);
	return {
		modified: { fsPath: modified.fsPath, version: modified.version, lines: hunk.modified },
		original: { fsPath: original.fsPath, version: original.version, lines: hunk.original },
		text: hunk.text,
	};
}
