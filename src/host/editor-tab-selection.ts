/**
 * Make VS Code show one editor tab it restored but never showed.
 *
 * The only way to select a tab this window holds no `WebviewPanel` for is a command: focus its group,
 * then `workbench.action.openEditorAtIndex`. That command is fire-and-forget in VS Code 1.142: its
 * handler calls `editorService.openEditor(...)` without awaiting or returning it, and does nothing at all
 * when the focused group has no active editor pane yet. A resolved command therefore proves nothing, and
 * `Tab.isActive` follows later through `onDidChangeTabs`. The selection is judged by that, after a bounded
 * wait, and the command is issued again if the first one was swallowed.
 */

/** How long one `openEditorAtIndex` may take to show its tab before it is issued again. */
export const TAB_SELECT_WAIT_MS = 2_000;

/** How many times the command is issued before the tab is reported as not shown. */
export const TAB_SELECT_ATTEMPTS = 2;

/** The tab facts the selection reads. */
export interface SelectableTab {
	readonly isActive: boolean;
	readonly group: { readonly viewColumn: number; readonly tabs: readonly unknown[] };
}

/** What the selection needs from VS Code. */
export interface TabSelectionApi {
	/** VS Code's tab for the editor right now, or `null`. */
	tabOf(slot: string): SelectableTab | null;
	/** The view column of the focused editor group. */
	activeColumn(): number;
	/** Run a command and wait for it to resolve. */
	executeCommand(command: string, ...args: unknown[]): PromiseLike<unknown>;
	/** Resolve at the next tab or tab-group change, or after `ms`, whichever is first. The listener must be registered synchronously. */
	nextTabChange(ms: number): Promise<void>;
	/** Milliseconds, for the deadline. */
	now(): number;
	/** Where the reason for a refusal goes: it is otherwise invisible. */
	info(message: string): void;
}

/**
 * Focus the editor group of `column`: by its own command (`direct`, indexed by column - 1), or, past
 * the last group that has one, by stepping from the focused group (view columns follow the grid order
 * `focusNextGroup` walks).
 */
async function focusGroup(api: TabSelectionApi, column: number, direct: readonly string[]): Promise<void> {
	const command = direct[column - 1];
	if (command !== undefined) {
		await api.executeCommand(command);
		return;
	}
	const steps = column - api.activeColumn();
	const step = steps > 0 ? "workbench.action.focusNextGroup" : "workbench.action.focusPreviousGroup";
	for (let taken = 0; taken < Math.abs(steps); taken++) await api.executeCommand(step);
}

/** Wait until the editor's tab is the active one of its group, or `ms` pass. */
async function waitUntilActive(api: TabSelectionApi, slot: string, ms: number): Promise<boolean> {
	const deadline = api.now() + ms;
	for (;;) {
		const tab = api.tabOf(slot);
		if (tab === null) return false;
		if (tab.isActive) return true;
		const remaining = deadline - api.now();
		if (remaining <= 0) return false;
		await api.nextTabChange(remaining);
	}
}

/**
 * Select the tab of one editor slot through its group and position.
 *
 * `true` when the tab is the active one of its group, which is what makes VS Code hand a restored
 * webview to its serializer. `false` is logged with its reason: the tab is gone, or it stayed inactive for
 * `attempts` commands of `waitMs` each.
 */
export async function selectEditorTab(
	api: TabSelectionApi,
	slot: string,
	groupFocusCommands: readonly string[],
	options: { readonly waitMs?: number; readonly attempts?: number } = {},
): Promise<boolean> {
	const waitMs = options.waitMs ?? TAB_SELECT_WAIT_MS;
	const attempts = options.attempts ?? TAB_SELECT_ATTEMPTS;
	const name = `editor ${slot.slice(0, 8)}`;
	const first = api.tabOf(slot);
	if (first === null) {
		api.info(`${name}: not selected, VS Code has no tab for it`);
		return false;
	}
	const column = first.group.viewColumn;
	if (first.isActive && column === api.activeColumn()) return true;
	if (column !== api.activeColumn()) await focusGroup(api, column, groupFocusCommands);
	const closed = `${name}: not selected, its tab closed while it was being selected`;
	for (let attempt = 1; attempt <= attempts; attempt++) {
		const tab = api.tabOf(slot);
		if (tab === null) {
			api.info(closed);
			return false;
		}
		if (attempt > 1) api.info(`${name}: its tab in group ${column} was not active ${waitMs} ms after openEditorAtIndex; issuing it again`);
		await api.executeCommand("workbench.action.openEditorAtIndex", tab.group.tabs.indexOf(tab));
		if (await waitUntilActive(api, slot, waitMs)) return true;
	}
	api.info(api.tabOf(slot) === null ? closed : `${name}: not selected, its tab in group ${column} was not active ${waitMs} ms after each of ${attempts} openEditorAtIndex commands`);
	return false;
}
