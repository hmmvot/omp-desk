/**
 * The file window of Ctrl+Shift+M (`ompDesk.moveFileToNewWindow`) as the extension drives it: a toggle that moves the
 * editors of the group next to the chat into one auxiliary VS Code window, kept on top, and back. Files opened from
 * Chat links go into that window while it lasts.
 *
 * The policy (which group is the file window, which column a group is in) is `host/file-window.ts` and
 * `host/chat-layout.ts`; this module sequences VS Code's own commands around it. It keeps one thing, the remembered
 * file window, and reads and writes nothing of the extension's other state: the log, the notice and the test for a
 * session editor arrive through {@link FileWindowDeps}.
 */

import * as vscode from "vscode";
import { EDITOR_GROUP_FOCUS_COMMANDS, chatGroupColumn, filesGroupColumn } from "../host/chat-layout.ts";
import { appearedGroup, FILE_WINDOW_SIZE, FileWindowTracker } from "../host/file-window.ts";
import type { Logger } from "../shared/logger.ts";

/** VS Code's editor-group target that opens an editor in a new auxiliary window (`AUX_WINDOW_GROUP`). */
const AUX_WINDOW_GROUP = -3;

/** What the file window needs of the extension. */
export interface FileWindowDeps {
	readonly log: Logger;
	/** A notice the user sees; it carries the extension's own prefix. */
	info(message: string): void;
	/** The tab input is a session editor of this extension (a chat or terminal tab). */
	isSessionTabInput(input: unknown): boolean;
}

/** The file window of this extension host. */
export interface FileWindow {
	/** The view column files from the chat open in: the file window's group while that window is open, else VS Code's choice. */
	column(): number | undefined;
	/** `ompDesk.moveFileToNewWindow`: a toggle that moves the files group into a window of its own, or back. */
	toggle(): Promise<void>;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function createFileWindow(rawDeps: FileWindowDeps): FileWindow {
	// Every notice the user sees is also written to the log with the same text: the user's log level is Info, and a toast alone leaves no trace of why a move did not happen.
	const deps: FileWindowDeps = {
		log: rawDeps.log,
		info: (message: string) => { rawDeps.log.info(`notice: ${message}`); rawDeps.info(message); },
		isSessionTabInput: input => rawDeps.isSessionTabInput(input),
	};
	const fileWindow = new FileWindowTracker<vscode.TabGroup>();

	/** The view column files from the chat open in: the file window's group while that window is open, else VS Code's choice. */
	function fileWindowColumn(): number | undefined {
		return fileWindow.column(vscode.window.tabGroups.all) ?? undefined;
	}

	/** VS Code's own always-on-top command, for the window that is focused: the file window VS Code has just opened. */
	async function keepFileWindowOnTop(): Promise<void> {
		try {
			await vscode.commands.executeCommand("workbench.action.enableWindowAlwaysOnTop");
		} catch (error) {
			deps.log.warn(`file window: it could not be kept on top: ${messageOf(error)}`);
		}
	}

	/**
	 * Ctrl+Shift+M from anywhere, a toggle. Without a file window it moves every editor of the group next to the chat into
	 * a new one, kept on top of other windows; files opened from Chat links go into that window until it is closed. With a
	 * file window it brings all of its tabs back to the group next to the chat and closes the window.
	 */
	async function moveFileToNewWindow(): Promise<void> {
		const groups = vscode.window.tabGroups;
		const window = fileWindow.current(groups.all);
		if (window !== null) {
			await returnFilesFromWindow(window);
			return;
		}
		const column = filesGroupColumn(groups.all, groups.activeTabGroup.viewColumn, deps.isSessionTabInput);
		const source = groups.all.find(group => group.viewColumn === column);
		if (source === undefined) {
			deps.info("No file is open next to the chat.");
			return;
		}
		// The larger window needs every tab to be reopened by its file; any other tab moves the whole group as VS Code does.
		if (source.tabs.every(tab => tab.input instanceof vscode.TabInputText && tab.input.uri.scheme !== "untitled") &&
			await openGroupInSizedFileWindow(source)) return;
		await moveGroupToNewWindow(source);
	}

	/** Focus an editor group, because VS Code's group commands act on the active group. `false` past the eighth group, which has no focus command. */
	async function focusEditorGroup(group: vscode.TabGroup): Promise<boolean> {
		if (group.viewColumn === vscode.window.tabGroups.activeTabGroup.viewColumn) return true;
		const focusGroup = EDITOR_GROUP_FOCUS_COMMANDS[group.viewColumn - 1];
		if (focusGroup === undefined) return false;
		await vscode.commands.executeCommand(focusGroup);
		return true;
	}

	/**
	 * Move the whole group with VS Code's own Move Editor Group into New Window: every tab, its order and its state, in
	 * a window of VS Code's default size (the command takes no bounds).
	 */
	async function moveGroupToNewWindow(source: vscode.TabGroup): Promise<void> {
		if (!await focusEditorGroup(source)) {
			deps.info("The file group is beyond the eighth editor group; focus it and use View: Move Editor Group into New Window.");
			return;
		}
		const before = [...vscode.window.tabGroups.all];
		await vscode.commands.executeCommand("workbench.action.moveEditorGroupToNewWindow");
		fileWindow.adopt(appearedGroup(before, vscode.window.tabGroups.all));
		await keepFileWindowOnTop();
	}

	/**
	 * Reopen one tab's editor in `column` by its input, with its selection when it is a text file. `false` for an editor
	 * that cannot be reopened that way (unsaved files, webviews, terminals), which then stays where it was.
	 */
	async function reopenTabInColumn(tab: vscode.Tab, column: number): Promise<boolean> {
		const input = tab.input;
		const options = { viewColumn: column, preview: false };
		try {
			if (input instanceof vscode.TabInputText) {
				if (input.uri.scheme === "untitled") return false;
				const selection = vscode.window.visibleTextEditors.find(editor =>
					editor.viewColumn === tab.group.viewColumn && editor.document.uri.toString() === input.uri.toString())?.selection;
				await vscode.commands.executeCommand("vscode.open", input.uri, { ...options, selection });
			} else if (input instanceof vscode.TabInputTextDiff) {
				await vscode.commands.executeCommand("vscode.diff", input.original, input.modified, undefined, options);
			} else if (input instanceof vscode.TabInputCustom) {
				await vscode.commands.executeCommand("vscode.openWith", input.uri, input.viewType, options);
			} else if (input instanceof vscode.TabInputNotebook) {
				await vscode.commands.executeCommand("vscode.openWith", input.uri, input.notebookType, options);
			} else {
				return false;
			}
			return true;
		} catch (error) {
			deps.log.warn(`file window: a tab could not be reopened there: ${messageOf(error)}`);
			return false;
		}
	}

	/** Whether two tabs show the same editor, for finding where a reopened tab landed. */
	function sameTabEditor(a: vscode.Tab, b: vscode.Tab): boolean {
		return a.label === b.label && a.input?.constructor === b.input?.constructor;
	}

	/**
	 * The main-window group a just-reopened `tab` landed in, excluding the file window and chat groups. VS Code reports the
	 * new tab to the extension host a moment after the open command resolves, so this looks a few times.
	 */
	async function groupHoldingReopened(tab: vscode.Tab, window: vscode.TabGroup): Promise<vscode.TabGroup | null> {
		for (let attempt = 0; attempt < 20; attempt++) {
			const found = vscode.window.tabGroups.all.find(group => group !== window && !group.tabs.some(other => deps.isSessionTabInput(other.input)) &&
				group.tabs.some(other => sameTabEditor(other, tab)));
			if (found !== undefined) return found;
			const { promise, resolve } = Promise.withResolvers<void>();
			setTimeout(resolve, 50);
			await promise;
		}
		return null;
	}

	/**
	 * Bring every tab of the file window back into the group next to the chat, in order, then close the originals; VS Code
	 * closes the emptied window. That group is the existing files group, else a new one to the right of the chat group:
	 * the first tab is opened into the chat group by its exact column, which activates the main window's group whichever
	 * window the key was pressed in, and moved into a new group on its right. A tab that cannot be reopened stays in the
	 * window, which is then still remembered, and the user is told.
	 */
	async function returnFilesFromWindow(window: vscode.TabGroup): Promise<void> {
		const groups = vscode.window.tabGroups;
		const candidates = groups.all.filter(group => group !== window);
		const tabs = [...window.tabs];
		const active = window.activeTab;
		const filesColumn = filesGroupColumn(candidates, groups.activeTabGroup.viewColumn, deps.isSessionTabInput);
		let target = candidates.find(group => group.viewColumn === filesColumn) ?? null;
		deps.log.debug(`file window: return of ${tabs.length} tab(s) from column ${window.viewColumn}; active column ${groups.activeTabGroup.viewColumn}, files group ${target === null ? "missing" : `at column ${target.viewColumn}`}`);
		const moved: vscode.Tab[] = [];
		const kept: vscode.Tab[] = [];
		for (const tab of tabs) {
			if (target === null) {
				// The files group does not exist yet: open the first reopenable tab next to the chat group, then follow it.
				const chatColumn = chatGroupColumn(candidates, groups.activeTabGroup.viewColumn, deps.isSessionTabInput);
				const chat = candidates.find(group => group.viewColumn === chatColumn);
				// `ViewColumn.Beside` is relative to the focused window's active group, which is the file window's own when the key
				// was pressed there. An exact column is not: the first tab is opened into the chat group (VS Code accepts that for a
				// group that holds editors), which makes it the active group of the main window, and is then moved into a new group
				// on its right, so the chat group ends up with no file in it.
				if (!await reopenTabInColumn(tab, chat?.viewColumn ?? candidates[0]?.viewColumn ?? vscode.ViewColumn.One)) {
					kept.push(tab);
					continue;
				}
				if (chat !== undefined) {
					for (let attempt = 0; attempt < 40 && !chat.tabs.some(other => sameTabEditor(other, tab)); attempt++) {
						const { promise, resolve } = Promise.withResolvers<void>();
						setTimeout(resolve, 50);
						await promise;
					}
					await vscode.commands.executeCommand("workbench.action.moveEditorToRightGroup");
				}
				target = await groupHoldingReopened(tab, window);
				if (target === null) {
					deps.log.warn("file window: the reopened file was not found in the main window; the tabs stay in the file window");
					deps.info("The files could not be moved back to the main window.");
					return;
				}
				moved.push(tab);
				continue;
			}
			(await reopenTabInColumn(tab, target.viewColumn) ? moved : kept).push(tab);
		}
		if (target !== null && active !== undefined && moved.includes(active) && active !== moved[moved.length - 1]) {
			await reopenTabInColumn(active, target.viewColumn);
		}
		if (moved.length > 0) await vscode.window.tabGroups.close(moved);
		if (kept.length === 0) {
			fileWindow.adopt(null);
			return;
		}
		deps.info(`${kept.length} editor${kept.length === 1 ? "" : "s"} could not be moved back to the main window (unsaved files and custom views stay in the file window).`);
	}

	/**
	 * Open the group's text files in a new window of `FILE_WINDOW_SIZE`. VS Code offers no command to size the window its
	 * own Move Editor Group into New Window opens, but opening an editor into `AUX_WINDOW_GROUP` takes the window's bounds,
	 * so the first file is opened this way and the rest follow into that window's group. `false` when VS Code refused the
	 * first file, so the caller can move the group instead.
	 */
	async function openGroupInSizedFileWindow(source: vscode.TabGroup): Promise<boolean> {
		const tabs = [...source.tabs];
		const first = tabs[0];
		if (first === undefined || !(first.input instanceof vscode.TabInputText)) return false;
		const uri = first.input.uri;
		const selection = vscode.window.visibleTextEditors.find(editor =>
			editor.viewColumn === source.viewColumn && editor.document.uri.toString() === uri.toString())?.selection;
		const range = selection === undefined ? undefined : {
			startLineNumber: selection.start.line + 1, startColumn: selection.start.character + 1,
			endLineNumber: selection.end.line + 1, endColumn: selection.end.character + 1,
		};
		const before = [...vscode.window.tabGroups.all];
		try {
			// The workbench's own open command; the public `vscode.open` drops the `auxiliary` option.
			await vscode.commands.executeCommand("_workbench.open", uri, [AUX_WINDOW_GROUP, { pinned: true, selection: range, auxiliary: { bounds: FILE_WINDOW_SIZE } }]);
		} catch (error) {
			deps.log.warn(`file window: ${uri.fsPath} could not be opened there: ${messageOf(error)}`);
			return false;
		}
		const created = appearedGroup(before, vscode.window.tabGroups.all);
		if (created === null) {
			deps.log.warn("file window: opening the file created no window; the files stay where they were");
			return true;
		}
		fileWindow.adopt(created);
		await keepFileWindowOnTop();
		// The first tab is already there, in order; the others follow it, then the tab that was active is shown again.
		const moved: vscode.Tab[] = [first];
		for (const tab of tabs.slice(1)) {
			if (await reopenTabInColumn(tab, created.viewColumn)) moved.push(tab);
		}
		const active = source.activeTab;
		if (active !== undefined && active !== moved[moved.length - 1]) await reopenTabInColumn(active, created.viewColumn);
		await vscode.window.tabGroups.close(moved);
		return true;
	}

	return { column: fileWindowColumn, toggle: moveFileToNewWindow };
}
