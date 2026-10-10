/**
 * The smallest stand-in for the `vscode` module that the launcher's tree items
 * need, so `src/views/session-tree.ts` can be exercised by `node --test` without
 * an editor process.
 *
 * It is not a VS Code emulation and deliberately implements nothing else: only
 * the values the launcher constructs (`TreeItem`, its collapsible states, theme
 * icons and markdown tooltips) and the change event the provider fires. The test
 * that loads it maps the `vscode` specifier onto this module; product code never
 * imports it, and the real editor always supplies the genuine API.
 */
/** The three collapse states the launcher builds a node from. */
export const TreeItemCollapsibleState = {
	None: 0,
	Collapsed: 1,
	Expanded: 2,
} as const;

export type TreeItemCollapsibleState = (typeof TreeItemCollapsibleState)[keyof typeof TreeItemCollapsibleState];

/** One entry's theme colour, as a tree item stores it. */
export class ThemeColor {
	readonly id: string;

	constructor(id: string) {
		this.id = id;
	}
}

/** One entry's theme icon; the colour is optional and only carried through. */
export class ThemeIcon {
	readonly id: string;
	readonly color: ThemeColor | undefined;

	constructor(id: string, color?: ThemeColor) {
		this.id = id;
		this.color = color;
	}
}

export class MarkdownString {
	value: string;
	supportThemeIcons = false;
	isTrusted?: boolean;

	constructor(value = "") {
		this.value = value;
	}
}

/** A resource identity: only what `Uri.from` and a decoration lookup read back. */
export class Uri {
	readonly scheme: string;
	readonly path: string;

	private constructor(scheme: string, path: string) {
		this.scheme = scheme;
		this.path = path;
	}

	static from(parts: { readonly scheme: string; readonly path: string }): Uri {
		return new Uri(parts.scheme, parts.path);
	}

	toString(): string {
		return `${this.scheme}:${this.path}`;
	}
}

/** The badge a decoration provider answers with. */
export class FileDecoration {
	readonly badge: string;
	readonly tooltip: string;
	readonly color: ThemeColor;

	constructor(badge: string, tooltip: string, color: ThemeColor) {
		this.badge = badge;
		this.tooltip = tooltip;
		this.color = color;
	}
}

export class TreeItem {
	id?: string;
	label?: string;
	description?: string;
	tooltip?: unknown;
	iconPath?: unknown;
	contextValue?: string;
	resourceUri?: Uri;
	command?: unknown;
	accessibilityInformation?: unknown;
	collapsibleState?: TreeItemCollapsibleState;

	constructor(label: string, collapsibleState?: TreeItemCollapsibleState) {
		this.label = label;
		this.collapsibleState = collapsibleState;
	}
}

export interface Disposable {
	dispose(): void;
}

/** The one event shape the provider needs: a listener registry plus `fire`. */
export class EventEmitter<T> {
	readonly #listeners = new Set<(value: T) => unknown>();

	readonly event = (listener: (value: T) => unknown): Disposable => {
		this.#listeners.add(listener);
		return { dispose: () => this.#listeners.delete(listener) };
	};

	fire(value: T): void {
		for (const listener of [...this.#listeners]) listener(value);
	}

	dispose(): void {
		this.#listeners.clear();
	}
}
