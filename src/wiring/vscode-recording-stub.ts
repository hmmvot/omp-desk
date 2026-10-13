/**
 * A `vscode` module that lets the real extension bundle activate under `node --test` and records what it
 * contributes at runtime: the registered commands, the tree and webview views, and the context keys.
 *
 * It is not a VS Code emulation. Every window, dialog and prompt is a plain no-op that answers "dismissed"
 * (`undefined`), configuration reads return the caller's default, and any member this file does not name is a
 * permissive stand-in that can be called, awaited and subscribed to without effect. What it keeps faithful is
 * what the contribution contract depends on: `registerCommand` refuses a second registration of an id exactly
 * as the editor does, and a handler is returned to the test untouched so it can be invoked the way a menu or
 * the palette invokes it.
 *
 * The bundle under test reads this module through `require("vscode")`; the test serves it from a stand-in
 * package folder and passes it in through {@link createRecordingVscode}.
 */
import { URI, Utils } from "vscode-uri";

export type CommandHandler = (...args: unknown[]) => unknown;

export interface Disposable {
	dispose(): void;
}

export interface Recording {
	/** Command id → handler, from `registerCommand` and `registerTextEditorCommand`. */
	readonly commands: Map<string, CommandHandler>;
	/** Ids a second registration was refused for. */
	readonly duplicateCommands: string[];
	/** Tree view ids from `createTreeView` and `registerTreeDataProvider`. */
	readonly treeViews: string[];
	/** Webview view ids from `registerWebviewViewProvider`. */
	readonly webviewViews: string[];
	/** `setContext` keys in the order they were set, with their latest value. */
	readonly contextKeys: Map<string, unknown>;
	/** Every `executeCommand` the extension issued, `setContext` included. */
	readonly executed: unknown[][];
	/** Calls of the dialog and message functions, by function name, for what a handler asked the user. */
	readonly prompts: { readonly kind: string; readonly args: unknown[] }[];
	/** Resolves once `setContext` has been issued for `key` with `value` (at once when it already was). */
	contextSet(key: string, value: unknown): Promise<void>;
}

const noop = (): void => {};

/** A value that can be read, called, constructed, awaited and subscribed to, and does nothing. */
interface Permissive {
	(...args: unknown[]): Permissive;
	readonly [key: string]: Permissive;
}

function permissive(label: string): Permissive {
	// The proxy answers every member the type promises; the target only has to be callable and constructible.
	return new Proxy(function () {}, {
		get(_target, key) {
			if (key === "then") return undefined;
			if (key === "dispose") return noop;
			if (key === Symbol.toPrimitive) return () => label;
			if (typeof key === "symbol") return undefined;
			return permissive(`${label}.${key}`);
		},
		apply: () => permissive(`${label}()`),
		construct: () => permissive(`new ${label}`),
	}) as unknown as Permissive;
}

/** An object whose named members are real and whose other members are {@link permissive}. */
function withFallback<T extends object>(label: string, named: T): T {
	return new Proxy(named, {
		get(target, key, receiver) {
			if (Reflect.has(target, key)) return Reflect.get(target, key, receiver);
			if (typeof key === "symbol" || key === "then") return undefined;
			return permissive(`${label}.${key}`);
		},
	});
}

class EventEmitter<T> {
	readonly #listeners = new Set<(value: T) => unknown>();
	readonly event = (listener: (value: T) => unknown): Disposable => {
		this.#listeners.add(listener);
		return { dispose: () => { this.#listeners.delete(listener); } };
	};
	fire(value: T): void {
		for (const listener of [...this.#listeners]) listener(value);
	}
	dispose(): void {
		this.#listeners.clear();
	}
}

class TreeItem {
	label?: unknown;
	collapsibleState?: number;
	[key: string]: unknown;
	constructor(label?: unknown, collapsibleState?: number) {
		this.label = label;
		this.collapsibleState = collapsibleState;
	}
}
class ThemeIcon {
	readonly id: string;
	readonly color: unknown;
	constructor(id: string, color?: unknown) {
		this.id = id;
		this.color = color;
	}
}
class ThemeColor {
	readonly id: string;
	constructor(id: string) {
		this.id = id;
	}
}
class MarkdownString {
	value: string;
	constructor(value = "") {
		this.value = value;
	}
	appendMarkdown(value: string): this { this.value += value; return this; }
	appendText(value: string): this { this.value += value; return this; }
}
class FileDecoration {
	badge: string | undefined;
	tooltip: string | undefined;
	color: unknown;
	constructor(badge?: string, tooltip?: string, color?: unknown) {
		this.badge = badge;
		this.tooltip = tooltip;
		this.color = color;
	}
}
class Position {
	readonly line: number;
	readonly character: number;
	constructor(line: number, character: number) {
		this.line = line;
		this.character = character;
	}
}
class Range {
	readonly start: Position;
	readonly end: Position;
	constructor(startLine: number, startCharacter: number, endLine: number, endCharacter: number) {
		this.start = new Position(startLine, startCharacter);
		this.end = new Position(endLine, endCharacter);
	}
}
/** `vscode.Uri`: the static factories of `vscode-uri`, and `instanceof` true for the URIs they build. */
class Uri {
	static readonly file = URI.file;
	static readonly parse = URI.parse;
	static readonly from = URI.from;
	static readonly joinPath = Utils.joinPath;
	static [Symbol.hasInstance](value: unknown): boolean {
		return URI.isUri(value);
	}
}

class TabInput {}
class TabInputWebview extends TabInput {}
class TabInputText extends TabInput {}
class TabInputTextDiff extends TabInput {}
class TabInputCustom extends TabInput {}
class TabInputNotebook extends TabInput {}

/** Build the module and its recording. */
export function createRecordingVscode(configuration: Readonly<Record<string, unknown>> = {}): { readonly vscode: object; readonly recording: Recording } {
	const commands = new Map<string, CommandHandler>();
	const contextWaiters: { readonly key: string; readonly value: unknown; readonly resolve: () => void }[] = [];
	const recording: Recording = {
		commands, duplicateCommands: [], treeViews: [], webviewViews: [], contextKeys: new Map(), executed: [], prompts: [],
		contextSet(key, value) {
			if (recording.contextKeys.get(key) === value) return Promise.resolve();
			const { promise, resolve } = Promise.withResolvers<void>();
			contextWaiters.push({ key, value, resolve });
			return promise;
		},
	};
	const register = (id: string, handler: CommandHandler): Disposable => {
		if (commands.has(id)) {
			recording.duplicateCommands.push(id);
			throw new Error(`command '${id}' already exists`);
		}
		commands.set(id, handler);
		return { dispose: () => { commands.delete(id); } };
	};
	const prompt = (kind: string) => async (...args: unknown[]): Promise<undefined> => {
		recording.prompts.push({ kind, args });
		return undefined;
	};
	const treeView = (id: string) => {
		recording.treeViews.push(id);
		return withFallback(`treeView(${id})`, {
			visible: false,
			selection: [] as unknown[],
			message: undefined as string | undefined,
			description: undefined as string | undefined,
			title: undefined as string | undefined,
			badge: undefined as unknown,
			dispose: noop,
		});
	};

	const commandsApi = {
		registerCommand: register,
		registerTextEditorCommand: register,
		async executeCommand(id: string, ...args: unknown[]): Promise<undefined> {
			recording.executed.push([id, ...args]);
			if (id === "setContext") {
				const key = String(args[0]);
				recording.contextKeys.set(key, args[1]);
				for (const waiter of contextWaiters.filter(candidate => candidate.key === key && candidate.value === args[1])) waiter.resolve();
			}
			return undefined;
		},
		getCommands: async (): Promise<string[]> => [...commands.keys()],
	};

	const output = () => ({ name: "OMP Desk", appendLine: noop, append: noop, replace: noop, clear: noop, show: noop, hide: noop, dispose: noop });
	const windowState = { focused: false, active: false };
	const tabGroups = withFallback("window.tabGroups", { all: [] as unknown[], activeTabGroup: { tabs: [] as unknown[], viewColumn: 1, activeTab: undefined as unknown } });
	const windowApi = withFallback("window", {
		state: windowState,
		tabGroups,
		terminals: [] as unknown[],
		visibleTextEditors: [] as unknown[],
		activeTextEditor: undefined as unknown,
		createOutputChannel: output,
		createTreeView: treeView,
		createStatusBarItem: () => withFallback("statusBarItem", { name: "", text: "", tooltip: undefined as unknown, command: undefined as unknown, backgroundColor: undefined as unknown, show: noop, hide: noop, dispose: noop }),
		registerTreeDataProvider: (id: string) => { recording.treeViews.push(id); return { dispose: noop }; },
		registerWebviewViewProvider: (id: string) => { recording.webviewViews.push(id); return { dispose: noop }; },
		showInformationMessage: prompt("showInformationMessage"),
		showWarningMessage: prompt("showWarningMessage"),
		showErrorMessage: prompt("showErrorMessage"),
		showQuickPick: prompt("showQuickPick"),
		showInputBox: prompt("showInputBox"),
		showOpenDialog: prompt("showOpenDialog"),
		showSaveDialog: prompt("showSaveDialog"),
		showTextDocument: prompt("showTextDocument"),
		setStatusBarMessage: () => ({ dispose: noop }),
		withProgress: async (_options: unknown, task: (progress: { report(value: unknown): void }, token: unknown) => unknown) =>
			task({ report: noop }, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: noop }) }),
	});
	const workspaceApi = withFallback("workspace", {
		workspaceFolders: undefined as unknown,
		workspaceFile: undefined as unknown,
		name: undefined as string | undefined,
		textDocuments: [] as unknown[],
		isTrusted: true,
		getConfiguration: (section?: string) => withFallback("configuration", {
			get: (key: string, fallback?: unknown) => configuration[section === undefined ? key : `${section}.${key}`] ?? fallback,
			has: () => false,
			inspect: () => undefined,
			update: async () => undefined,
		}),
		getWorkspaceFolder: () => undefined,
		findFiles: async () => [] as unknown[],
	});
	const envApi = withFallback("env", {
		clipboard: { writeText: async () => undefined, readText: async () => "" },
		uriScheme: "vscode",
		appName: "Visual Studio Code",
		remoteName: undefined as string | undefined,
		asExternalUri: async (uri: unknown) => uri,
		openExternal: async () => true,
	});

	const vscode = {
		version: "1.110.0",
		commands: commandsApi,
		window: windowApi,
		workspace: workspaceApi,
		env: envApi,
		extensions: withFallback("extensions", { getExtension: () => undefined, all: [] as unknown[] }),
		debug: withFallback("debug", { activeDebugSession: undefined as unknown, breakpoints: [] as unknown[] }),
		languages: permissive("languages"),
		EventEmitter,
		TreeItem,
		ThemeIcon,
		ThemeColor,
		MarkdownString,
		FileDecoration,
		Position,
		Range,
		TabInputWebview,
		TabInputText,
		TabInputTextDiff,
		TabInputCustom,
		TabInputNotebook,
		Disposable: class { static from(...items: Disposable[]): Disposable { return { dispose: () => { for (const item of items) item.dispose(); } }; } },
		Uri,
		ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
		ExtensionMode: { Production: 1, Development: 2, Test: 3 },
		FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
		ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 },
		QuickPickItemKind: { Separator: -1, Default: 0 },
		StatusBarAlignment: { Left: 1, Right: 2 },
		TreeItemCheckboxState: { Unchecked: 0, Checked: 1 },
		TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
		ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3 },
	};
	return { vscode, recording };
}
