import { readFile, stat } from "node:fs/promises";
import * as vscode from "vscode";
import type { CodeTheme } from "../chat/code-theme.ts";
import { resolveCodeThemes } from "../host/code-theme.ts";
import type { CodeThemeContribution, CodeThemeInput, CodeThemeKind } from "../host/code-theme.ts";
import { isRecord } from "../shared/guards.ts";
import type { Logger } from "../shared/logger.ts";

/** What the extension supplies: the reaction to changed themes and a diagnostic log; the file ports are for tests. */
export interface CodeThemeDeps {
	/** The resolved themes differ from the ones `current()` returned before: push them to the pages. */
	changed(): void;
	log: Logger;
	/** The file's text, or `null` when unreadable; defaults to the file system. */
	readFile?(path: string): Promise<string | null>;
	/** The file's size, or `null` when missing or not a regular file; defaults to the file system. */
	fileSize?(path: string): Promise<number | null>;
}

export interface CodeThemeHandle extends vscode.Disposable {
	/** The candidate themes (the page picks the active one by id); empty until the first resolution lands or when none resolves. */
	current(): readonly CodeTheme[];
}

/** The settings whose change can change which themes are candidates or how they are customised. */
const WATCHED_SETTINGS = [
	"workbench.colorTheme",
	"workbench.preferredDarkColorTheme",
	"workbench.preferredLightColorTheme",
	"workbench.preferredHighContrastColorTheme",
	"workbench.preferredHighContrastLightColorTheme",
	"editor.tokenColorCustomizations",
];
const DEBOUNCE_MS = 100;

async function readTextFile(path: string): Promise<string | null> {
	try {
		return await readFile(path, "utf8");
	} catch {
		return null;
	}
}

async function regularFileSize(path: string): Promise<number | null> {
	try {
		const info = await stat(path);
		return info.isFile() ? info.size : null;
	} catch {
		return null;
	}
}

function themeKind(kind: vscode.ColorThemeKind): CodeThemeKind | null {
	switch (kind) {
		case vscode.ColorThemeKind.Light:
			return "light";
		case vscode.ColorThemeKind.Dark:
			return "dark";
		case vscode.ColorThemeKind.HighContrast:
			return "hc-dark";
		case vscode.ColorThemeKind.HighContrastLight:
			return "hc-light";
		default:
			return null;
	}
}

/** Every theme the installed extensions contribute; entries of an unexpected shape are skipped. */
function contributedThemes(): CodeThemeContribution[] {
	const themes: CodeThemeContribution[] = [];
	for (const extension of vscode.extensions.all) {
		const contributes: unknown = isRecord(extension.packageJSON) ? extension.packageJSON.contributes : undefined;
		const list: unknown = isRecord(contributes) ? contributes.themes : undefined;
		if (!Array.isArray(list) || typeof extension.extensionPath !== "string") continue;
		for (const item of list) {
			if (!isRecord(item) || typeof item.path !== "string") continue;
			themes.push({
				extensionPath: extension.extensionPath,
				path: item.path,
				...(typeof item.id === "string" ? { id: item.id } : {}),
				...(typeof item.label === "string" ? { label: item.label } : {}),
				...(typeof item.uiTheme === "string" ? { uiTheme: item.uiTheme } : {}),
			});
		}
	}
	return themes;
}

function readInput(files: Pick<CodeThemeInput, "readFile" | "fileSize">): CodeThemeInput | null {
	const kind = themeKind(vscode.window.activeColorTheme.kind);
	if (kind === null) return null;
	const text = (section: string, key: string): string | undefined => {
		const value = vscode.workspace.getConfiguration(section).get<unknown>(key);
		return typeof value === "string" ? value : undefined;
	};
	return {
		kind,
		settings: {
			colorTheme: text("workbench", "colorTheme"),
			preferredDark: text("workbench", "preferredDarkColorTheme"),
			preferredLight: text("workbench", "preferredLightColorTheme"),
			preferredHighContrast: text("workbench", "preferredHighContrastColorTheme"),
			preferredHighContrastLight: text("workbench", "preferredHighContrastLightColorTheme"),
		},
		customizations: vscode.workspace.getConfiguration("editor").get<unknown>("tokenColorCustomizations"),
		themes: contributedThemes(),
		...files,
	};
}

/**
 * Keeps the candidate colour themes of Chat's fenced code (`src/host/code-theme.ts` resolves them) current:
 * resolved once at registration, and again, debounced, when the active theme, the settings that name or
 * customise themes, or the installed extensions change. A resolution that a newer change supersedes is dropped,
 * and `deps.changed()` runs only when the result differs from the one before. Each applied resolution logs one
 * line. Never throws; a failure logs and gives no themes.
 */
export function registerCodeTheme(context: vscode.ExtensionContext, deps: CodeThemeDeps): CodeThemeHandle {
	const files = { readFile: deps.readFile ?? readTextFile, fileSize: deps.fileSize ?? regularFileSize };
	let themes: readonly CodeTheme[] = [];
	let serialised = JSON.stringify(themes);
	let generation = 0;
	let timer: NodeJS.Timeout | undefined;
	let disposed = false;

	const resolveNow = async (): Promise<void> => {
		const mine = ++generation;
		let resolved: readonly CodeTheme[] = [];
		let summary: string;
		let failed = false;
		try {
			const input = readInput(files);
			if (input === null) {
				summary = "no themes: the active theme's kind is unknown";
			} else {
				resolved = await resolveCodeThemes(input);
				const named = Object.values(input.settings).filter((value): value is string => typeof value === "string" && value !== "");
				summary = resolved.length === 0
					? `no themes for ${input.kind} (settings name ${named.map(name => JSON.stringify(name)).join(", ") || "nothing"}; none of them is an installed, readable ${input.kind} theme)`
					: `themes ${resolved.map(theme => `${JSON.stringify(theme.id)} (${theme.rules.length} rules)`).join(", ")}`;
			}
		} catch (error) {
			resolved = [];
			failed = true;
			summary = `no themes: resolution failed: ${error instanceof Error ? error.message : String(error)}`;
		}
		if (disposed || mine !== generation) return;
		if (failed) deps.log.warn(`code theme: ${summary}`);
		else deps.log.info(`code theme: ${summary}`);
		const next = JSON.stringify(resolved);
		if (next === serialised) return;
		themes = resolved;
		serialised = next;
		try {
			deps.changed();
		} catch (error) {
			deps.log.warn(`code theme: change notification failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	};
	const schedule = (): void => {
		// Whatever is resolving now is already out of date.
		generation++;
		clearTimeout(timer);
		timer = setTimeout(() => {
			timer = undefined;
			void resolveNow();
		}, DEBOUNCE_MS);
	};

	const subscriptions = [
		vscode.workspace.onDidChangeConfiguration(event => {
			if (WATCHED_SETTINGS.some(setting => event.affectsConfiguration(setting))) schedule();
		}),
		vscode.window.onDidChangeActiveColorTheme(schedule),
		vscode.extensions.onDidChange(schedule),
	];
	const handle: CodeThemeHandle = {
		current: () => themes,
		dispose() {
			disposed = true;
			generation++;
			clearTimeout(timer);
			for (const subscription of subscriptions) subscription.dispose();
		},
	};
	context.subscriptions.push(handle);
	void resolveNow();
	return handle;
}
