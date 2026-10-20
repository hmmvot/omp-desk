/**
 * The selection of VS Code's Markdown preview, and the document the preview shows (docs/designs/2026-10-15-quote-chat-selection.md,
 * decision 12). The preview is a webview of the Markdown extension: its CSP lets its scripts reach nothing of ours and its
 * messages are the Markdown extension's own, so the selection is taken the way a user would take it, with VS Code's Copy command
 * while the preview has the focus (`editor.action.clipboardCopyAction`, which copies from the focused webview; measured on VS Code
 * 1.142.0). The clipboard is a shared resource, so its text is put back.
 */
import * as vscode from "vscode";
import { MARKDOWN_PREVIEW_TAB_VIEW_TYPE, fallbackName, resolvePreviewFile } from "./preview-quote";
import type { PreviewDocument } from "./preview-quote";

/** How long a Copy from the preview may take to reach the clipboard: also how long an empty selection is waited for. */
const COPY_WAIT_MS = 600;
const COPY_POLL_MS = 25;

/** The label of the active tab when it is a Markdown preview (also a locked one and one opened to the side), else `null`. */
export function activePreviewLabel(): string | null {
	const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
	return tab !== undefined && tab.input instanceof vscode.TabInputWebview && tab.input.viewType === MARKDOWN_PREVIEW_TAB_VIEW_TYPE ? tab.label : null;
}

/** The selected rendered text of the preview that has the focus (`""`: nothing is selected), leaving the clipboard's text as it was. */
export async function copyPreviewSelection(): Promise<string> {
	const clipboard = vscode.env.clipboard;
	const before = await clipboard.readText();
	// A marker no copy can equal: if it is still there after the wait, the preview copied nothing.
	const marker = `omp-desk-preview-quote-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	try {
		await clipboard.writeText(marker);
		await vscode.commands.executeCommand("editor.action.clipboardCopyAction");
		const deadline = Date.now() + COPY_WAIT_MS;
		for (;;) {
			const now = await clipboard.readText();
			if (now !== marker) return now;
			if (Date.now() >= deadline) return "";
			await new Promise<void>(resolve => setTimeout(resolve, COPY_POLL_MS));
		}
	} finally {
		await clipboard.writeText(before);
	}
}

/**
 * The document a preview tab shows: the one file among the open Markdown documents whose name ends the label, else among the
 * workspace's Markdown files (a locked preview of a document that is closed). Several different files with that name, or none: the
 * name alone.
 */
export async function previewDocumentOf(label: string): Promise<PreviewDocument> {
	const open = vscode.workspace.textDocuments.filter(document => document.uri.scheme === "file" && document.languageId === "markdown").map(document => document.uri.fsPath);
	let fsPath = resolvePreviewFile(label, open);
	if (fsPath === null && !open.some(path => resolvePreviewFile(label, [path]) !== null)) {
		const found = await vscode.workspace.findFiles("**/*.{md,markdown,mdx}", "**/{node_modules,.git}/**", 5000);
		fsPath = resolvePreviewFile(label, found.map(uri => uri.fsPath));
	}
	return { fsPath, name: fsPath === null ? fallbackName(label) : (fsPath.split(/[\\/]/).pop() ?? fallbackName(label)) };
}
