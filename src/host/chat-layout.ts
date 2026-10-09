/**
 * Where a session editor opens when chat has its own editor column (`omp.chatColumn`).
 *
 * Session editors share one editor group on the left, and that group is locked. VS Code never puts a new editor into
 * a locked group unless it is targeted by its exact column, so files opened from the Explorer, Quick Open, chat links
 * and every other OMP Desk tab (Stats, Models, TODO/Agents details) land in a group to the right and leave the chat
 * visible. Only session editors target the chat group by column.
 *
 * The group is found from the tabs VS Code reports, so it follows the user when they drag it elsewhere; it is created
 * and moved to the far left only when no group holds a session editor yet.
 */

/** The slice of an editor group this module reads. */
export interface LayoutGroup {
	readonly viewColumn: number;
	readonly tabs: readonly { readonly input: unknown }[];
}

/** Where to create a session editor, and what to do with its group once the editor is in it. */
export type ChatPlacement =
	/** Join the existing chat group at this column; lock it so files keep opening beside it. */
	| { readonly column: number; readonly arrange: "lock" }
	/** No chat group: open in a new group (or the empty editor area), then move it to the far left and lock it. */
	| { readonly column: number; readonly arrange: "move-left-and-lock" };

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
 * Placement of a new session editor. Without a chat group, the leftmost empty group takes it: that is usually the
 * chat group whose last session editor was closed, which VS Code keeps while it is locked, or the empty area of a
 * window without editors. `beside` is VS Code's `ViewColumn.Beside`, a new group next to the active one, used only
 * when every group shows files.
 */
export function chatPlacement(groups: readonly LayoutGroup[], activeColumn: number, isChat: (input: unknown) => boolean, beside: number): ChatPlacement {
	const existing = chatGroupColumn(groups, activeColumn, isChat);
	if (existing !== null) return { column: existing, arrange: "lock" };
	const empty = groups.filter(group => group.tabs.length === 0).map(group => group.viewColumn);
	return { column: empty.length > 0 ? Math.min(...empty) : beside, arrange: "move-left-and-lock" };
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

/** The VS Code calls that arrange the chat group. */
export interface ChatLayoutApi {
	executeCommand(command: string): PromiseLike<unknown>;
}

/** The session editor whose group is arranged, as VS Code reports it. */
export interface ChatLayoutPanel {
	readonly active: boolean;
	readonly viewColumn: number | undefined;
	onDidChangeViewState(listener: () => void): { dispose(): void };
}

/** How long a new editor may take to be reported active before its group is left as it is. */
const ACTIVE_TIMEOUT_MS = 5000;

/**
 * Move the chat group to the far left when asked, then lock it.
 *
 * A panel learns its column and that it is active only from a later view-state event, so this first waits for that.
 * Both commands act on the active group: moving takes `column - 1` steps, which is a no-op at the left edge of a grid
 * row, and locking happens only while the session editor is still the active one, so a group the user switched to
 * meanwhile is never locked.
 */
export async function arrangeChatGroup(api: ChatLayoutApi, placement: ChatPlacement, panel: ChatLayoutPanel, timeoutMs = ACTIVE_TIMEOUT_MS): Promise<void> {
	if (!await untilActive(panel, timeoutMs)) return;
	if (placement.arrange === "move-left-and-lock") {
		const steps = (panel.viewColumn ?? 1) - 1;
		for (let step = 0; step < steps; step++) await api.executeCommand("workbench.action.moveActiveEditorGroupLeft");
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
