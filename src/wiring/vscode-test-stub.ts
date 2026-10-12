/**
 * The `vscode` module as `src/wiring/window-routing.ts` and the launcher tree it imports see it under
 * `node --test`: the tree's own stand-in (`src/views/vscode-test-stub.ts`) plus the few places the routing
 * reads: the workspace, the window's focus, the editor groups, the command runner and the quick pick.
 *
 * Every member is plain data a test sets before it calls the module and reads back afterwards. It is not a VS
 * Code emulation; product code never imports it.
 */
import { URI } from "vscode-uri";
import { EventEmitter, Uri as TreeUri } from "../views/vscode-test-stub.ts";

export * from "../views/vscode-test-stub.ts";

/** Resource identities: the tree's `Uri.from`, and `parse`/`file` with the real `vscode-uri` behaviour. */
export const Uri = { from: TreeUri.from, parse: URI.parse, file: URI.file };

export const ViewColumn = { One: 1, Two: 2, Beside: -2 } as const;

export class TabInputText {
	readonly uri: URI;
	constructor(uri: URI) {
		this.uri = uri;
	}
}
export class TabInputTextDiff {}
export class TabInputCustom {}
export class TabInputNotebook {}

/** One editor group as the routing reads it. */
export interface StubTabGroup {
	viewColumn: number;
	tabs: StubTab[];
	activeTab: StubTab | undefined;
}
export interface StubTab {
	label: string;
	input: unknown;
	group: StubTabGroup;
}

export const workspace: {
	workspaceFile: URI | undefined;
	workspaceFolders: Array<{ uri: URI }> | undefined;
	name: string | undefined;
	settings: Record<string, unknown>;
	getConfiguration(section: string): { get<T>(key: string, fallback: T): T };
} = {
	workspaceFile: undefined,
	workspaceFolders: undefined,
	name: undefined,
	settings: {},
	getConfiguration: section => ({
		get: <T>(key: string, fallback: T): T => {
			const name = `${section}.${key}`;
			return name in workspace.settings ? (workspace.settings[name] as T) : fallback;
		},
	}),
};

const focusChanges = new EventEmitter<{ readonly focused: boolean }>();

export const window: {
	state: { focused: boolean };
	onDidChangeWindowState: typeof focusChanges.event;
	fireFocus(focused: boolean): void;
	tabGroups: { all: StubTabGroup[]; activeTabGroup: StubTabGroup; close(tabs: unknown): Promise<boolean> };
	visibleTextEditors: unknown[];
	picks: unknown[];
	showQuickPick: (items: unknown, options?: unknown) => Promise<unknown>;
} = {
	state: { focused: true },
	onDidChangeWindowState: focusChanges.event,
	fireFocus(focused) {
		window.state.focused = focused;
		focusChanges.fire({ focused });
	},
	tabGroups: { all: [], activeTabGroup: { viewColumn: 1, tabs: [], activeTab: undefined }, close: async () => true },
	visibleTextEditors: [],
	picks: [],
	showQuickPick: async items => { window.picks.push(items); return undefined; },
};

export const commands: {
	calls: unknown[][];
	handler: ((...args: unknown[]) => unknown) | null;
	executeCommand(...args: unknown[]): Promise<unknown>;
} = {
	calls: [],
	handler: null,
	async executeCommand(...args) {
		commands.calls.push(args);
		return commands.handler?.(...args);
	},
};
