/**
 * Where a session editor opens when chat has its own editor column (`ompDesk.chatColumn`), and on which side of the
 * window that column is (`ompDesk.chatTabGroup`).
 *
 * Session editors share one editor group at the left or the right edge of the editor area, and that group is locked.
 * VS Code never puts a new editor into a locked group unless it is targeted by its exact column, so files opened from
 * the Explorer, Quick Open, chat links and every other OMP Desk tab (Stats, Models, TODO/Agents details) land in
 * another group and leave the chat visible. Only session editors target the chat group by column.
 *
 * The group is found from the tabs VS Code reports, so it follows the user when they drag it elsewhere; it is created
 * and moved to the chosen edge only when no group holds a session editor yet. A group that exists keeps its place
 * whatever the setting says now.
 */

/** The edge of the editor area the chat group is moved to when it is created. */
export type ChatSide = "left" | "right";

/** `ompDesk.chatTabGroup` as a side: anything but `right` is the default, `left`. */
export function chatSideOf(value: unknown): ChatSide {
	return value === "right" ? "right" : "left";
}

/** The slice of an editor group this module reads. */
export interface LayoutGroup {
	readonly viewColumn: number;
	readonly tabs: readonly { readonly input: unknown }[];
}

/** Where to create a session editor, and what to do with its group once the editor is in it. */
export type ChatPlacement =
	/** Join the existing chat group at this column; lock it so files keep opening beside it. */
	| { readonly column: number; readonly arrange: "lock" }
	/** No chat group: open in a new group (or the empty editor area), then move it to the chosen edge and lock it. */
	| { readonly column: number; readonly arrange: "move-to-side-and-lock"; readonly side: ChatSide };

/** The column of the group that holds session editors: the active group if it holds one, else the leftmost. */
export function chatGroupColumn(groups: readonly LayoutGroup[], activeColumn: number, isChat: (input: unknown) => boolean): number | null {
	let leftmost: number | null = null;
	for (const group of groups) {
		if (!group.tabs.some(tab => isChat(tab.input))) continue;
		if (group.viewColumn === activeColumn) return activeColumn;
		if (leftmost === null || group.viewColumn < leftmost) leftmost = group.viewColumn;
	}
	return leftmost;
}

/**
 * Placement of a new session editor. Without a chat group, the empty group nearest the chosen edge takes it: that is
 * usually the chat group whose last session editor was closed, which VS Code keeps while it is locked, or the empty
 * area of a window without editors. `newGroup` is the column to use when every group shows files: one past the last
 * group (VS Code creates the missing columns), or VS Code's `ViewColumn.Beside` when that cannot be told, which is a
 * new group next to the active one unless a group is already there, and then the editor joins it.
 */
export function chatPlacement(groups: readonly LayoutGroup[], activeColumn: number, isChat: (input: unknown) => boolean, newGroup: number, side: ChatSide): ChatPlacement {
	const existing = chatGroupColumn(groups, activeColumn, isChat);
	if (existing !== null) return { column: existing, arrange: "lock" };
	const empty = groups.filter(group => group.tabs.length === 0).map(group => group.viewColumn);
	const column = empty.length === 0 ? newGroup : side === "right" ? Math.max(...empty) : Math.min(...empty);
	return { column, arrange: "move-to-side-and-lock", side };
}

/**
 * The side of the chat group a files group is opened on when none exists. Next to other groups it is the side they
 * are on (left of a chat group that is the rightmost of several, else right of it); a chat group that stands alone
 * leaves the files the side away from the edge it was put at. `groups` are the main window's groups and `chatColumn`
 * the chat group's column among them.
 */
export function filesSideOf(groups: readonly LayoutGroup[], chatColumn: number | null, chatSide: ChatSide): ChatSide {
	const others = groups.filter(group => group.viewColumn !== chatColumn);
	if (chatColumn === null || others.length === 0) return chatSide === "right" ? "left" : "right";
	return others.every(group => group.viewColumn < chatColumn) ? "left" : "right";
}

/**
 * The column of the group whose active editor is "the file next to the chat": the active group when it holds no
 * session editor, else the leftmost group without one. `null` when every group with tabs holds a session editor.
 */
export function filesGroupColumn(groups: readonly LayoutGroup[], activeColumn: number, isChat: (input: unknown) => boolean): number | null {
	const files = groups.filter(group => group.tabs.length > 0 && !group.tabs.some(tab => isChat(tab.input)));
	if (files.some(group => group.viewColumn === activeColumn)) return activeColumn;
	return files.reduce<number | null>((leftmost, group) => leftmost === null || group.viewColumn < leftmost ? group.viewColumn : leftmost, null);
}

/**
 * The empty groups left beside an existing chat group: VS Code does not put an editor into an empty locked group, so a
 * session editor opened while the old chat group sat empty lands in a new group, and once it is moved to the far left
 * the emptied locked group remains next to it. `[]` while no group holds a session editor, since then an empty group is
 * the one a session editor is about to use.
 */
export function strayEmptyGroups<G extends LayoutGroup>(groups: readonly G[], isChat: (input: unknown) => boolean): G[] {
	if (!groups.some(group => group.tabs.some(tab => isChat(tab.input)))) return [];
	return groups.filter(group => group.tabs.length === 0);
}

/** Focuses the editor group of one `ViewColumn` (1-based). VS Code offers no command past the eighth. */
export const EDITOR_GROUP_FOCUS_COMMANDS = [
	"workbench.action.focusFirstEditorGroup",
	"workbench.action.focusSecondEditorGroup",
	"workbench.action.focusThirdEditorGroup",
	"workbench.action.focusFourthEditorGroup",
	"workbench.action.focusFifthEditorGroup",
	"workbench.action.focusSixthEditorGroup",
	"workbench.action.focusSeventhEditorGroup",
	"workbench.action.focusEighthEditorGroup",
];

/** The VS Code calls that arrange the chat group. */
export interface ChatLayoutApi {
	executeCommand(command: string): PromiseLike<unknown>;
}

/** The session editor whose group is arranged, as VS Code reports it. */
export interface ChatLayoutPanel {
	readonly active: boolean;
	readonly viewColumn: number | undefined;
	/** How many editor groups the window has now; the right edge is the last column. */
	readonly groupCount: number;
	onDidChangeViewState(listener: () => void): { dispose(): void };
}

/** How long a new editor may take to be reported active before its group is left as it is. */
const ACTIVE_TIMEOUT_MS = 5000;

/**
 * Move the chat group to the chosen edge when asked, then lock it.
 *
 * A panel learns its column and that it is active only from a later view-state event, so this first waits for that.
 * Both commands act on the active group: moving left takes `column - 1` steps and moving right `groupCount - column`,
 * each a no-op once the group is at the edge of its grid row (a count that includes a group of another window only adds
 * such no-op steps), and locking happens only while the session editor is still the active one, so a group the user
 * switched to meanwhile is never locked.
 */
export async function arrangeChatGroup(api: ChatLayoutApi, placement: ChatPlacement, panel: ChatLayoutPanel, timeoutMs = ACTIVE_TIMEOUT_MS): Promise<void> {
	if (!await untilActive(panel, timeoutMs)) return;
	if (placement.arrange === "move-to-side-and-lock") {
		const column = panel.viewColumn ?? 1;
		const steps = placement.side === "right" ? panel.groupCount - column : column - 1;
		const command = placement.side === "right" ? "workbench.action.moveActiveEditorGroupRight" : "workbench.action.moveActiveEditorGroupLeft";
		for (let step = 0; step < steps; step++) await api.executeCommand(command);
	}
	if (panel.active) await api.executeCommand("workbench.action.lockEditorGroup");
}

/** Resolves `true` once the panel is the active editor with a known column, `false` on timeout. */
export function untilActive(panel: ChatLayoutPanel, timeoutMs: number): Promise<boolean> {
	const ready = (): boolean => panel.active && panel.viewColumn !== undefined;
	if (ready()) return Promise.resolve(true);
	return new Promise(resolve => {
		const timer = setTimeout(() => { subscription.dispose(); resolve(false); }, timeoutMs);
		const subscription = panel.onDidChangeViewState(() => {
			if (!ready()) return;
			clearTimeout(timer);
			subscription.dispose();
			resolve(true);
		});
	});
}
