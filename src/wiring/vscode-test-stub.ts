/**
 * The `vscode` module as `src/wiring/window-routing.ts` and the launcher tree it imports see it under
 * `node --test`: the tree's own stand-in (`src/views/vscode-test-stub.ts`) plus the few places the routing
 * reads: the workspace, the window's focus, the editor groups, the command runner and the quick pick.
 *
 * Every member is plain data a test sets before it calls the module and reads back afterwards. It is not a VS
 * Code emulation; product code never imports it.
 */
import { URI, Utils } from "vscode-uri";
import { EventEmitter, Uri as TreeUri } from "../views/vscode-test-stub.ts";

export * from "../views/vscode-test-stub.ts";

/** Resource identities: the tree's `Uri.from`, and `parse`/`file` with the real `vscode-uri` behaviour. */
export const Uri = { from: TreeUri.from, parse: URI.parse, file: URI.file, joinPath: Utils.joinPath };

export const ViewColumn = { Active: -1, One: 1, Two: 2, Beside: -2 } as const;

export const QuickPickItemKind = { Separator: -1, Default: 0 } as const;

export const StatusBarAlignment = { Left: 1, Right: 2 } as const;

/** One status bar item as a module sets it; `visible` follows `show()` / `hide()`. */
export interface StubStatusBarItem {
	id: string;
	alignment: number;
	priority: number | undefined;
	name: string | undefined;
	text: string;
	tooltip: string | undefined;
	command: string | undefined;
	backgroundColor: { readonly id: string } | undefined;
	visible: boolean;
	disposed: boolean;
	show(): void;
	hide(): void;
	dispose(): void;
}

export class TabInputText {
	readonly uri: URI;
	constructor(uri: URI) {
		this.uri = uri;
	}
}
export class TabInputTextDiff {}
export class TabInputCustom {}
export class TabInputNotebook {}
export class TabInputWebview {
	readonly viewType: string;
	constructor(viewType: string) {
		this.viewType = viewType;
	}
}

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

const configurationChanges = new EventEmitter<{ affectsConfiguration(section: string): boolean }>();

export const workspace: {
	workspaceFile: URI | undefined;
	workspaceFolders: Array<{ uri: URI }> | undefined;
	name: string | undefined;
	settings: Record<string, unknown>;
	getConfiguration(section: string): { get<T>(key: string, fallback: T): T };
	onDidChangeConfiguration: typeof configurationChanges.event;
	/** Fires a configuration change that affects the given full setting keys (and the sections that contain them). */
	fireConfigurationChange(...keys: string[]): void;
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
	onDidChangeConfiguration: configurationChanges.event,
	fireConfigurationChange(...keys) {
		configurationChanges.fire({
			affectsConfiguration: section => keys.some(key => key === section || key.startsWith(`${section}.`) || section.startsWith(`${key}.`)),
		});
	},
};

/** `vscode.ColorThemeKind`. */
export const ColorThemeKind = { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 } as const;

const colorThemeChanges = new EventEmitter<{ readonly kind: number }>();
const extensionChanges = new EventEmitter<void>();

/** The installed extensions as a module reads them: `all` is set by a test, `fireChange` is `onDidChange`. */
export const extensions: {
	all: Array<{ extensionPath: string; packageJSON: unknown }>;
	onDidChange: typeof extensionChanges.event;
	fireChange(): void;
} = {
	all: [],
	onDidChange: extensionChanges.event,
	fireChange: () => extensionChanges.fire(),
};

const focusChanges = new EventEmitter<{ readonly focused: boolean }>();

export const window: {
	activeColorTheme: { kind: number };
	onDidChangeActiveColorTheme: typeof colorThemeChanges.event;
	/** Switches the active theme's kind and fires `onDidChangeActiveColorTheme`. */
	setColorThemeKind(kind: number): void;
	state: { focused: boolean };
	onDidChangeWindowState: typeof focusChanges.event;
	fireFocus(focused: boolean): void;
	tabGroups: { all: StubTabGroup[]; activeTabGroup: StubTabGroup; close(tabs: unknown): Promise<boolean> };
	visibleTextEditors: unknown[];
	picks: unknown[];
	showQuickPick: (items: unknown, options?: unknown) => Promise<unknown>;
	/** What a notification asked through `showWarningMessage` / `showInformationMessage` said, in order. */
	notices: string[];
	showWarningMessage: (message: string, ...rest: unknown[]) => Promise<undefined>;
	showInformationMessage: (message: string, ...rest: unknown[]) => Promise<undefined>;
	/** The webview panel serializers a module registered, by view type. */
	serializers: Map<string, { deserializeWebviewPanel(panel: unknown, state: unknown): Thenable<void> }>;
	/** The status bar items a module created, in order. */
	statusBarItems: StubStatusBarItem[];
	createStatusBarItem(id: string, alignment: number, priority?: number): StubStatusBarItem;
	registerWebviewPanelSerializer(viewType: string, serializer: { deserializeWebviewPanel(panel: unknown, state: unknown): Thenable<void> }): { dispose(): void };
} = {
	activeColorTheme: { kind: ColorThemeKind.Dark },
	onDidChangeActiveColorTheme: colorThemeChanges.event,
	setColorThemeKind(kind) {
		window.activeColorTheme = { kind };
		colorThemeChanges.fire({ kind });
	},
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
	notices: [],
	showWarningMessage: async message => { window.notices.push(message); return undefined; },
	showInformationMessage: async message => { window.notices.push(message); return undefined; },
	registerWebviewPanelSerializer(viewType, serializer) {
		window.serializers.set(viewType, serializer);
		return { dispose: () => { window.serializers.delete(viewType); } };
	},
	serializers: new Map(),
	statusBarItems: [],
	createStatusBarItem(id, alignment, priority) {
		const item: StubStatusBarItem = {
			id, alignment, priority, name: undefined, text: "", tooltip: undefined, command: undefined, backgroundColor: undefined, visible: false, disposed: false,
			show: () => { item.visible = true; },
			hide: () => { item.visible = false; },
			dispose: () => { item.visible = false; item.disposed = true; },
		};
		window.statusBarItems.push(item);
		return item;
	},
};

export const commands: {
	calls: unknown[][];
	handler: ((...args: unknown[]) => unknown) | null;
	executeCommand(...args: unknown[]): Promise<unknown>;
	/** The commands a module registered, by id. */
	registered: Map<string, (...args: unknown[]) => unknown>;
	registerCommand(id: string, handler: (...args: unknown[]) => unknown): { dispose(): void };
} = {
	calls: [],
	handler: null,
	async executeCommand(...args) {
		commands.calls.push(args);
		return commands.handler?.(...args);
	},
	registered: new Map(),
	registerCommand(id, handler) {
		commands.registered.set(id, handler);
		return { dispose: () => { commands.registered.delete(id); } };
	},
};
