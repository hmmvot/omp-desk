/**
 * What one editor's bridge becomes when this window observes its close.
 *
 * A close is the one event that must *retire* a bridge rather than keep it: the
 * editor no longer exists, so its tab reservation has to be released (or the next
 * explicit Open of that row would lose against a winner that is gone) and its
 * endpoint, exact port and document secret have to be forgotten (or a closed
 * editor's credential would outlive the editor and keep its port bound).
 *
 * The opposite case is deliberately not here: an extension-host restart disposes no
 * editor, so nothing in this module runs then, and the records a surviving page
 * still needs are left exactly as they are.
 *
 * Only the *winner* of a tab may be retired. A losing candidate that VS Code
 * disposes must not free the tab for the editor that is actually serving it.
 */
import type { BridgeEditorEndpoint } from "./bridge-endpoint.ts";
import type { EditorCoordinator } from "./editor-coordinator.ts";

export interface ClosedEditorBridgeInput {
	/**
	 * The conversation this editor was reserved under, or `null` when the caller only
	 * knows the editor — a migrated editor, or a parked reader, whose reservation must
	 * be found by its immutable id.
	 */
	readonly tabId: string | null;
	readonly editorId: string;
	readonly endpoint: BridgeEditorEndpoint | Promise<BridgeEditorEndpoint | null> | null;
	readonly editors: EditorCoordinator;
}

export interface ClosedEditorBridgeResult {
	/** `true` when this call was the one that retired the editor's bridge. */
	readonly retired: boolean;
}

/**
 * Retire one closed editor's bridge.
 *
 * The reservation is released synchronously, even if the endpoint has not
 * finished binding yet. A late bind is forgotten after it settles; no new
 * editor can inherit that port or credential meanwhile.
 */
export async function retireClosedEditorBridge(input: ClosedEditorBridgeInput): Promise<ClosedEditorBridgeResult> {
	// Validation is by the editor's own identity, because the editor is what closed:
	// a conversation key becomes stale the moment a settled switch moves the editor,
	// and a parked reader never had the conversation it is shown under.
	const winner = input.editors.winnerForEditor(input.editorId);
	if (winner === null) return { retired: false };
	if (input.tabId !== null && winner.tabId !== input.tabId) return { retired: false };
	input.editors.releaseEditor(input.editorId);
	const endpoint = input.endpoint instanceof Promise ? await input.endpoint : input.endpoint;
	if (endpoint !== null) await endpoint.forget();
	return { retired: true };
}
